import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/Button';
import { ResizeHandle } from '@/components/ResizeHandle';
import { Sidebar, type SidebarKey } from '@/components/Sidebar';
import { StatusBar } from '@/components/StatusBar';
import { setUiLanguage } from '@/i18n';
import { systemLanguage } from '@/lib/language';
import { getSettings, getSystemInfo, syncStyles, updateSettings } from '@/lib/ipc';
import { getVersion } from '@tauri-apps/api/app';
import { identifyAccount, startAiObservability, startAnalytics } from '@/lib/analytics';
import { runBillingReminder } from '@/lib/billingReminder';
import { onTick, startScheduler } from '@/lib/scheduler';
import { recheckDoneBuildJobs, settleLateRenders } from '@/lib/buildJobs';
import { backfillProjectStatus } from '@/lib/projectStatus';
import { startAutopilot } from '@/state/autopilot';
import { AUTOPILOT_ENABLED } from '@/lib/features';
import { ComingSoon } from '@/screens/ComingSoon';
import { startUpdateChecks } from '@/state/updater';
import { useWindowDrag } from '@/lib/windowDrag';
import { Agents } from '@/screens/Agents';
import { Autopilot } from '@/screens/Autopilot';
import { AutopilotWizard } from '@/screens/AutopilotWizard';
import { Calendar } from '@/screens/Calendar';
import { ChatRoute, useSoloChat } from '@/screens/ChatRoute';
import { Plans } from '@/screens/Plans';
import { Settings } from '@/screens/Settings';
import { Style } from '@/screens/Style';
import { Videos } from '@/screens/Videos';
import { Social } from '@/screens/Social';
import { Connect } from '@/screens/onboarding/Connect';
import { Requirements } from '@/screens/onboarding/Requirements';
import { AccountStep } from '@/screens/onboarding/AccountStep';
import { Welcome } from '@/screens/onboarding/Welcome';
import { useApp, type Route } from '@/state/app';
import { useAuth } from '@/state/auth';
import { SIDEBAR, useFittedLayout, useLayout, useSidebarShortcut, useWindowWidthSync } from '@/state/layout';
import { refreshJobs } from '@/state/jobs';

const ONBOARDING = new Set<Route['name']>(['welcome', 'connect', 'requirements', 'onboarding-account']);

const SIDEBAR_KEY: Partial<Record<Route['name'], SidebarKey>> = {
  'chat-new': 'chat',
  chat: 'chat',
  videos: 'videos',
  social: 'social',
  style: 'style',
  autopilot: 'autopilot',
  'autopilot-wizard': 'autopilot',
  agents: 'agents',
  calendar: 'calendar',
  settings: 'settings',
};

function Onboarding({ name }: { name: Route['name'] }) {
  if (name === 'connect') return <Connect />;
  if (name === 'requirements') return <Requirements />;
  if (name === 'onboarding-account') return <AccountStep />;
  return <Welcome />;
}

export default function App() {
  const route = useApp((s) => s.route);
  const settings = useApp((s) => s.settings);
  const { t } = useTranslation();
  useWindowDrag();

  const [loadError, setLoadError] = useState(false);

  // First launch decides where to start: onboarded users go straight to a new chat.
  const load = useCallback(() => {
    setLoadError(false);
    getSettings()
      .then(async (st) => {
        // First run has no saved language: follow the system's. The language is set before the settings
        // so the first paint is already in it, and the store has it even if saving it fails.
        const lang = st.uiLanguage ?? (await systemLanguage());
        setUiLanguage(lang);
        useApp.getState().setSettings(st.uiLanguage ? st : { ...st, uiLanguage: lang });
        if (!st.uiLanguage) {
          void Promise.resolve()
            .then(() => updateSettings({ uiLanguage: lang }))
            // The user may have picked a language on Welcome meanwhile: that choice stands.
            .then((next) => next && useApp.getState().settings?.uiLanguage === lang && useApp.getState().setSettings(next))
            .catch(() => {});
        }
        // Built-in styles in the background, like the install ping: never blocks, failures are ignored.
        void Promise.resolve()
          .then(syncStyles)
          .catch(() => {});
        if (st.onboarded) {
          useApp.getState().navigate({ name: 'chat-new' });
          void refreshJobs().catch(() => {});
          // Once per install: old build jobs marked done without a video go back to needs-you.
          void recheckDoneBuildJobs(st.buildJobsChecked);
          // Once per install: projects made before their status moved on its own catch up.
          void backfillProjectStatus(st.projectStatusChecked);
        }
      })
      .catch(() => setLoadError(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Establish the account boundary at launch, rather than waiting for an account-only screen.
  useEffect(() => {
    void useAuth.getState().init();
  }, []);

  // One listener ends traces for every ACP prompt, including background workers while the window is hidden.
  useEffect(() => {
    startAiObservability();
  }, []);

  // Product analytics follow the "share anonymous stats" setting (see lib/analytics).
  const share = settings?.shareInstallStats;
  const installId = settings?.installId ?? '';
  const uiLanguage = settings?.uiLanguage ?? null;
  useEffect(() => {
    if (share === undefined) return;
    let alive = true;
    void Promise.all([
      Promise.resolve().then(() => getVersion()).catch(() => undefined),
      Promise.resolve().then(() => getSystemInfo()).then((s) => s.os).catch(() => undefined),
    ]).then(([appVersion, os]) => {
      if (!alive) return;
      startAnalytics({ share, installId, appVersion, os, uiLanguage });
      // Auth may resolve before analytics starts; identify it here so exceptions and events inherit it.
      const status = useAuth.getState().status;
      if (status?.signedIn && status.account) identifyAccount(status.account.id, status.account.plan);
    });
    return () => {
      alive = false;
    };
  }, [share, installId, uiLanguage]);

  // Release builds look for a new version shortly after launch and every few hours.
  useEffect(() => startUpdateChecks(), []);

  // Once set up, the scheduler listens for the Rust tick (reminders and the autopilot engine). The engine
  // registers first, so the scheduler's first pass already runs it.
  const onboarded = settings?.onboarded ?? false;
  useEffect(() => {
    if (!onboarded) return;
    let off: (() => void) | undefined;
    let gone = false;
    // Autopilot is coming soon: its engine stays off (see lib/features).
    const stopEngine = AUTOPILOT_ENABLED ? startAutopilot() : () => {};
    // Startup and every tick: build jobs whose video arrived late become done.
    const stopLate = onTick(() => settleLateRenders());
    // "Your plan ends in 3 days", once per period.
    const stopPlanReminder = onTick((now) => runBillingReminder(now));
    startScheduler()
      .then((un) => (gone ? un() : (off = un)))
      .catch(() => {});
    return () => {
      gone = true;
      off?.();
      stopEngine();
      stopLate();
      stopPlanReminder();
    };
  }, [onboarded]);

  if (!settings) {
    return (
      <div data-tauri-drag-region className="flex h-full flex-col items-center justify-center gap-4 bg-background">
        {loadError && (
          <>
            <p className="m-0 text-sm text-text-2">{t('app.settingsFailed')}</p>
            <Button variant="secondary" onClick={load}>
              {t('common.tryAgain')}
            </Button>
          </>
        )}
      </div>
    );
  }

  if (route.name === 'plans') {
    return (
      <div className="h-full overflow-y-auto bg-background">
        <Plans from={route.from} plan={route.plan} />
      </div>
    );
  }
  if (ONBOARDING.has(route.name)) {
    return (
      <div className="h-full overflow-y-auto bg-background">
        <Onboarding name={route.name} />
      </div>
    );
  }
  return <Shell route={route} />;
}

/** Below the snap point a drag collapses the sidebar to its rail; above it, it opens at that width. */
function resizeSidebar(width: number, max: number, live?: boolean) {
  const layout = useLayout.getState();
  if (width < SIDEBAR.snap) return layout.setCollapsed(true, live);
  layout.setCollapsed(false, true);
  layout.setSidebar(Math.min(width, max), live);
}

/** The app around a screen: the resizable sidebar and the main column. */
function Shell({ route }: { route: Route }) {
  const { t } = useTranslation();
  // Only the project chat has the preview panel; the sidebar's room depends on it.
  const solo = useSoloChat(route.name === 'chat' ? route.chatId : null);
  const fitted = useFittedLayout(route.name === 'chat' && !solo);
  useWindowWidthSync();
  useSidebarShortcut();

  return (
    // The window never scrolls as a page: each panel scrolls on its own.
    <div className="flex h-full flex-col overflow-hidden bg-background">
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div id="app-sidebar" className="relative h-full shrink-0" style={{ width: fitted.sidebar }}>
        <Sidebar active={SIDEBAR_KEY[route.name] ?? 'chat'} collapsed={fitted.collapsed} />
        <ResizeHandle
          label={t('layout.resizeSidebar')}
          side="right"
          aria-controls="app-sidebar"
          value={fitted.sidebar}
          min={SIDEBAR.min}
          ariaMin={SIDEBAR.rail}
          max={fitted.sidebarMax}
          onResize={(w, live) => resizeSidebar(w, fitted.sidebarMax, live)}
          onReset={() => useLayout.getState().resetSidebar()}
          onToggle={() => useLayout.getState().toggleCollapsed()}
        />
      </div>
      <main className="relative min-w-0 flex-1">
        {route.name === 'chat-new' || route.name === 'chat' ? (
          <ChatRoute />
        ) : route.name === 'videos' ? (
          <Videos />
        ) : route.name === 'social' ? (
          <Social />
        ) : route.name === 'style' ? (
          <Style />
        ) : route.name === 'autopilot' || route.name === 'autopilot-wizard' ? (
          !AUTOPILOT_ENABLED ? (
            <ComingSoon feature="autopilot" />
          ) : route.name === 'autopilot' ? (
            <Autopilot key={route.id ?? 'list'} id={route.id} />
          ) : (
            <AutopilotWizard key={route.id ?? 'new'} id={route.id} draft={route.draft} />
          )
        ) : route.name === 'agents' ? (
          <Agents />
        ) : route.name === 'calendar' ? (
          <Calendar />
        ) : (
          <Settings />
        )}
      </main>
      </div>
      <StatusBar />
    </div>
  );
}
