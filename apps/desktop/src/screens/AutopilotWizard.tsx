import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import type { AgentInfo, Autopilot, AutopilotFrequency, AutopilotInput, Niche, SocialAccount, Style, VideoLanguage, Voice } from '@tayang/shared';
import { AgentLogo } from '@/components/AgentLogo';
import { Button } from '@/components/Button';
import { LanguageCombobox, languageLabel } from '@/components/LanguageCombobox';
import { StepBar } from '@/components/StepBar';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { AGENT_NAMES } from '@/lib/agents';
import { track } from '@/lib/analytics';
import {
  dayModeOf,
  dayName,
  frequencyLabel,
  LENGTHS,
  MAX_TIMES,
  nextFreeTime,
  parseAutopilotDraft,
  planSlots,
  slotTime,
  validTimes,
  WEEK,
  WEEKDAYS,
  WEEKENDS,
  type DayMode,
} from '@/lib/autopilot';
import { notifyAutopilotChanged } from '@/lib/autopilotHooks';
import { platformName, socialAccounts } from '@/lib/cloud';
import { detectAgents, listAutopilots, listNiches, listStyles, listVoices, saveAutopilot } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { PreviewImage, posterOf } from '@/screens/Style';
import { useApp, type Route } from '@/state/app';

const STEP_KEYS = ['niche', 'style', 'voice', 'schedule', 'agent', 'summary'] as const;
type StepKey = (typeof STEP_KEYS)[number];
const SECTIONS = ['niche', 'style', 'voice', 'schedule', 'agent'] as const;
const DEFAULT_TIMES = ['12:00'];
type NicheTab = 'catalog' | 'custom';
const COUNTS = Array.from({ length: MAX_TIMES }, (_, i) => i + 1);
const REVIEW_CHOICES = [true, false];
/** Most target accounts one post may have (the API's limit). */
const MAX_ACCOUNTS = 10;
const DAY_MODES: DayMode[] = ['everyday', 'weekdays', 'weekends', 'custom'];
const MODE_NAMES = { everyday: 'modeEveryday', weekdays: 'modeWeekdays', weekends: 'modeWeekends', custom: 'modeCustom' } as const;

interface Form {
  name: string;
  /** The catalog niche picked, or null for one the user writes. */
  nicheId: string | null;
  niche: string;
  language: VideoLanguage;
  styleId: string;
  voiceId: string | null;
  agentId: AgentInfo['id'] | '';
  mode: DayMode;
  /** One per video a day. */
  times: string[];
  /** The days of the custom choice. */
  days: number[];
  lengthSec: number;
  review: boolean;
  socialAccountIds: string[];
}

const fromAutopilot = (a: Autopilot): Form => {
  const f = a.frequency;
  const days = f.kind === 'daily' ? WEEK : f.days;
  return {
    name: a.name,
    nicheId: a.nicheId,
    niche: a.niche,
    language: a.language,
    styleId: a.styleId,
    voiceId: a.voiceId,
    agentId: a.agentId,
    mode: dayModeOf(days),
    times: f.kind === 'weekly' ? [f.time] : f.times,
    days: f.kind === 'daily' ? WEEKDAYS : f.days,
    lengthSec: a.lengthSec,
    review: a.review,
    socialAccountIds: a.socialAccountIds,
  };
};

const frequencyOf = (f: Form): AutopilotFrequency => {
  const times = [...f.times].sort();
  if (f.mode === 'everyday') return { kind: 'daily', times };
  const days = f.mode === 'weekdays' ? WEEKDAYS : f.mode === 'weekends' ? WEEKENDS : f.days;
  return { kind: 'days', days: [...days].sort((a, b) => a - b), times };
};

/**
 * Keyboard for a radio group: the arrow keys move the choice, and the focus with it (ARIA radio pattern).
 * Each option sets `tabIndex` with `tabStop`, so the group is one Tab stop.
 */
function radioKeys<T>(values: T[], current: T, pick: (v: T) => void) {
  return (e: ReactKeyboardEvent<HTMLElement>) => {
    const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
    if (!step || !values.length) return;
    e.preventDefault();
    const next = (Math.max(0, values.indexOf(current)) + step + values.length) % values.length;
    pick(values[next]!);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
}
const tabStop = <T,>(values: T[], current: T, v: T) => (v === current || (!values.includes(current) && v === values[0]) ? 0 : -1);

/** New (no `id`) or edit an autopilot, one step at a time, on its own screen. */
export function AutopilotWizard({ id, draft, now = new Date() }: { id?: string; draft?: Record<string, unknown>; now?: Date }) {
  const { t } = useTranslation();
  const settings = useApp((s) => s.settings);
  const languageLabelId = useId();
  const suggested = draft ? parseAutopilotDraft(draft) : null;
  const [form, setForm] = useState<Form>(() => ({
    name: suggested?.name ?? '',
    nicheId: suggested?.nicheId ?? null,
    niche: suggested?.niche ?? '',
    language: suggested?.language ?? settings?.language ?? 'id',
    styleId: suggested?.styleId ?? '',
    voiceId: suggested?.voiceId ?? null,
    agentId: '',
    mode: suggested?.mode ?? 'everyday',
    times: suggested?.times ?? DEFAULT_TIMES,
    days: WEEKDAYS,
    lengthSec: suggested?.lengthSec ?? 60,
    review: suggested?.review ?? true,
    socialAccountIds: suggested?.socialAccountIds ?? [],
  }));
  // The agent's suggestion opens on the Summary, where the user checks it and starts it.
  const [step, setStep] = useState(draft ? STEP_KEYS.indexOf('summary') : 0);
  const [niches, setNiches] = useState<Niche[]>([]);
  const [nicheLoad, setNicheLoad] = useState<'loading' | 'ready' | 'failed'>('loading');
  // The agent's own description, unlike a catalog id, belongs on the tab where the user can read it.
  const [nicheTab, setNicheTab] = useState<NicheTab>(suggested?.niche && !suggested.nicheId ? 'custom' : 'catalog');
  /** What the user wrote: going to the cards and back doesn't lose it. */
  const [customNiche, setCustomNiche] = useState(suggested?.niche && !suggested.nicheId ? suggested.niche : '');
  const [voices, setVoices] = useState<Voice[]>([]);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [accountsFailed, setAccountsFailed] = useState(false);
  const [styles, setStyles] = useState<Style[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [editing, setEditing] = useState<Autopilot | null>(null);
  const [loading, setLoading] = useState(!!id);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState<Route | null>(null);
  const touched = useRef(!!draft);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);
  const installed = agents.filter((a) => a.installed);

  const change = (patch: Partial<Form>) => {
    touched.current = true;
    setForm((f) => ({ ...f, ...patch }));
  };

  /** Loads the cards. The agent names a catalog niche by id: its prompt is what the autopilot keeps. */
  const loadNiches = () => {
    setNicheLoad('loading');
    listNiches()
      .then((list) => {
        setNiches(list);
        setNicheLoad('ready');
        if (suggested?.nicheId) {
          const picked = list.find((n) => n.id === suggested.nicheId);
          if (picked) setForm((f) => (f.nicheId === picked.id ? { ...f, niche: picked.prompt } : f));
        }
      })
      .catch(() => setNicheLoad('failed'));
  };

  // A niche the catalog no longer has (or the agent made up): what the autopilot kept is shown as the
  // user's own text, and with none, the step says one is missing rather than start without it.
  useEffect(() => {
    if (nicheLoad !== 'ready' || !form.nicheId || niches.some((n) => n.id === form.nicheId)) return;
    setCustomNiche(form.niche);
    setNicheTab('custom');
    setForm((f) => ({ ...f, nicheId: null }));
  }, [nicheLoad, niches, form.nicheId]);

  useEffect(() => {
    listStyles()
      .then(setStyles)
      .catch(() => setStyles([]));
    detectAgents()
      .then((list) => {
        setAgents(list);
        // A new autopilot starts on the default agent when it is installed (not a user change).
        const ok = list.filter((a) => a.installed);
        setForm((f) => (f.agentId ? f : { ...f, agentId: (ok.find((a) => a.id === settings?.defaultAgent) ?? ok[0])?.id ?? '' }));
      })
      .catch(() => setAgents([]));
    loadNiches();
    listVoices()
      .then((list) => {
        setVoices(list);
        if (suggested?.voiceId && !list.some((v) => v.id === suggested.voiceId)) setForm((f) => ({ ...f, voiceId: null }));
      })
      .catch(() => {
        setVoices([]);
        if (suggested?.voiceId) setForm((f) => ({ ...f, voiceId: null }));
      });
    socialAccounts()
      .then((list) => {
        const connected = list.filter((a) => a.status === 'connected');
        setAccounts(connected);
        // An account disconnected since: it can't be posted to, and the summary shows what is left.
        setForm((f) => ({ ...f, socialAccountIds: f.socialAccountIds.filter((x) => connected.some((a) => a.id === x)) }));
      })
      .catch(() => setAccountsFailed(true));
    if (!id) return;
    listAutopilots()
      .then((list) => {
        const a = list.find((x) => x.id === id);
        if (!a) throw new Error('gone');
        setEditing(a);
        setForm(fromAutopilot(a));
        if (!a.nicheId) {
          setNicheTab('custom');
          setCustomNiche(a.niche);
        }
      })
      .catch(() => setLoadError(t('autopilot.cantLoad')))
      .finally(() => setLoading(false));
  }, [id]);

  // Leaving with unsaved input asks first, wherever the navigation comes from (sidebar, Cancel, Esc).
  useEffect(() => {
    const store = useApp.getState();
    store.setLeaveGuard((next) => {
      if (!touched.current) return true;
      setLeaving(next);
      return false;
    });
    return () => {
      if (useApp.getState().leaveGuard) useApp.getState().setLeaveGuard(null);
    };
  }, []);

  const backTo: Route = id ? { name: 'autopilot', id } : { name: 'autopilot' };
  const cancel = () => useApp.getState().navigate(backTo);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !leaving && !e.defaultPrevented) cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [leaving]);

  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  const problems: Record<StepKey, string | null> = {
    niche: !form.niche.trim()
      ? nicheTab === 'catalog'
        ? t('autopilot.form.errors.pickNiche')
        : t('autopilot.form.errors.niche')
      : !form.name.trim()
        ? t('autopilot.form.errors.name')
        : null,
    style: styles.some((s) => s.id === form.styleId) ? null : t('autopilot.form.errors.style'),
    voice: null,
    schedule: !validTimes(form.times) ? t('autopilot.form.errors.times') : form.mode === 'custom' && !form.days.length ? t('autopilot.form.errors.days') : null,
    agent: installed.some((a) => a.id === form.agentId) ? null : t('autopilot.form.errors.agent'),
    summary: null,
  };
  const key = STEP_KEYS[step]!;
  const firstBad = STEP_KEYS.findIndex((k) => problems[k]);
  const problem = key === 'summary' ? (firstBad >= 0 ? problems[STEP_KEYS[firstBad]!] : null) : problems[key];

  const save = async () => {
    if (busy || firstBad >= 0 || !form.agentId) return;
    setBusy(true);
    setSaveError(null);
    const input: AutopilotInput = {
      id: editing?.id,
      name: form.name.trim(),
      niche: form.niche.trim(),
      nicheId: form.nicheId,
      language: form.language,
      styleId: form.styleId,
      voiceId: form.voiceId,
      agentId: form.agentId,
      frequency: frequencyOf(form),
      lengthSec: form.lengthSec,
      review: form.review,
      posting: form.socialAccountIds.length ? 'automatic' : 'manual',
      socialAccountIds: form.socialAccountIds,
    };
    try {
      const saved = await saveAutopilot(input);
      track('autopilot_saved', {
        is_new: !editing,
        agent: form.agentId,
        language: form.language,
        frequency_type: input.frequency.kind,
        videos_per_day: form.times.length,
        review_enabled: form.review,
        posting_mode: input.posting,
      });
      touched.current = false;
      useApp.getState().setLeaveGuard(null);
      notifyAutopilotChanged();
      useApp.getState().navigate({ name: 'autopilot', id: saved.id });
    } catch {
      setSaveError(t('autopilot.form.errors.cantSave'));
      setBusy(false);
    }
  };

  const stepNames = STEP_KEYS.map((k) => t(`autopilot.wizard.steps.${k}`));
  const style = styles.find((s) => s.id === form.styleId);
  const label = 'flex flex-col gap-1 text-xs text-text-2';
  const chip = (on: boolean) =>
    cn(
      'inline-flex h-8 cursor-pointer items-center rounded-md border px-3 text-[13px] motion-safe:transition-colors',
      on ? 'border-foreground bg-foreground text-ink' : 'border-hairline bg-card text-text-2 hover:text-foreground',
    );
  const first = planSlots({ frequency: frequencyOf(form) }, now, 14).slice(0, 3);
  const styleIds = styles.map((s) => s.id);
  const agentIds = installed.map((a) => a.id);
  const nicheIds = niches.map((n) => n.id);
  const pickNiche = (nicheId: string) => {
    const n = niches.find((x) => x.id === nicheId);
    // A name the card filled in follows the card; one the user typed stays.
    const named = niches.some((x) => x.title === form.name);
    if (n) change({ nicheId: n.id, niche: n.prompt, name: form.name.trim() && !named ? form.name : n.title });
  };
  const writeNiche = (niche: string) => {
    setCustomNiche(niche);
    change({ niche, nicheId: null });
  };
  /** Each tab has its own answer: leaving the cards never puts a catalog prompt in the user's box. */
  const pickNicheTab = (tab: NicheTab) => {
    if (tab === nicheTab) return;
    setNicheTab(tab);
    change({ nicheId: null, niche: tab === 'custom' ? customNiche : '' });
  };
  const voiceChoices: (string | null)[] = [null, ...voices.map((v) => v.id), ...(form.voiceId && !voices.some((v) => v.id === form.voiceId) ? [form.voiceId] : [])];
  const setCount = (n: number) => {
    const times = form.times.slice(0, n);
    while (times.length < n) times.push(nextFreeTime(times));
    change({ times });
  };
  const accountName = (a: SocialAccount) => `${platformName(a.platform)}${a.username ? ` · @${a.username}` : ''}`;
  const lengths = LENGTHS.includes(form.lengthSec) ? LENGTHS : [...LENGTHS, form.lengthSec].sort((a, b) => a - b);

  const body: Record<StepKey, () => ReactNode> = {
    niche: () => (
      <div className="flex flex-col gap-4">
        <Tabs value={nicheTab} onValueChange={(v) => pickNicheTab(v as NicheTab)} className="gap-4">
          <TabsList aria-label={t('autopilot.form.niche')} className="self-start">
            <TabsTrigger value="catalog">{t('autopilot.form.nicheCatalogTab')}</TabsTrigger>
            <TabsTrigger value="custom">{t('autopilot.form.nicheCustom')}</TabsTrigger>
          </TabsList>
          <TabsContent value="catalog">
            {nicheLoad === 'loading' && <p className="m-0 text-xs text-text-3">{t('autopilot.form.nicheLoading')}</p>}
            {nicheLoad === 'ready' && niches.length > 0 && (
              <div
                role="radiogroup"
                aria-label={t('autopilot.form.niche')}
                onKeyDown={radioKeys(nicheIds, form.nicheId ?? '', pickNiche)}
                className="grid grid-cols-1 gap-2 min-[700px]:grid-cols-2"
              >
                {niches.map((n) => {
                  const on = n.id === form.nicheId;
                  return (
                    <button
                      key={n.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      tabIndex={tabStop(nicheIds, form.nicheId ?? '', n.id)}
                      onClick={() => pickNiche(n.id)}
                      className={cn(
                        'relative flex cursor-pointer flex-col gap-1 rounded-xl border bg-card p-3 pr-9 text-left',
                        on ? 'border-primary' : 'border-border hover:border-hairline',
                      )}
                    >
                      <span className="text-[13px] font-medium text-foreground">{n.title}</span>
                      <span className="line-clamp-3 text-xs text-text-3">{n.prompt}</span>
                      {on && (
                        <span aria-hidden="true" className="absolute top-3 right-3 inline-flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <Check size={12} strokeWidth={2} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {(nicheLoad === 'failed' || (nicheLoad === 'ready' && !niches.length)) && (
              <div className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-4">
                <p className="m-0 text-xs text-text-2">{nicheLoad === 'failed' ? t('autopilot.form.nicheFailed') : t('autopilot.form.nicheEmpty')}</p>
                <div className="flex flex-wrap gap-2">
                  {nicheLoad === 'failed' && (
                    <Button variant="secondary" className="h-8 px-3 text-[13px]" onClick={loadNiches}>
                      {t('autopilot.form.nicheRetry')}
                    </Button>
                  )}
                  <Button variant="ghost" className="h-8 px-3 text-[13px]" onClick={() => pickNicheTab('custom')}>
                    {t('autopilot.form.nicheCustom')}
                  </Button>
                </div>
              </div>
            )}
          </TabsContent>
          <TabsContent value="custom" className="flex flex-col gap-4">
            <label className={label}>
              {t('autopilot.form.nicheCustomLabel')}
              <Textarea value={form.niche} rows={3} placeholder={t('autopilot.form.nichePlaceholder')} onChange={(e) => writeNiche(e.target.value)} />
            </label>
          </TabsContent>
        </Tabs>
        <label className={label}>
          {t('autopilot.form.name')}
          <Input value={form.name} placeholder={t('autopilot.form.namePlaceholder')} onChange={(e) => change({ name: e.target.value })} />
        </label>
        <div className={cn(label, 'max-w-[240px]')}>
          <span id={languageLabelId}>{t('autopilot.form.language')}</span>
          <LanguageCombobox labelledBy={languageLabelId} value={form.language} onChange={(language) => change({ language })} />
        </div>
      </div>
    ),
    style: () => (
      <div className="flex flex-col gap-3">
        {!styles.length && <p className="m-0 text-xs text-text-2">{t('autopilot.form.noStyles')}</p>}
        <div
          role="radiogroup"
          aria-label={t('autopilot.form.style')}
          onKeyDown={radioKeys(styleIds, form.styleId, (styleId) => change({ styleId }))}
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))' }}
        >
          {styles.map((s) => {
            const on = s.id === form.styleId;
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={tabStop(styleIds, form.styleId, s.id)}
                onClick={() => change({ styleId: s.id })}
                className={cn(
                  'relative flex cursor-pointer flex-col gap-2 rounded-xl border bg-card p-2 text-left',
                  on ? 'border-primary' : 'border-border hover:border-hairline',
                )}
              >
                <PreviewImage
                  key={s.id}
                  src={posterOf(s)}
                  className="aspect-[9/16] w-full rounded-md object-cover"
                  fallback={<span aria-hidden="true" className="block aspect-[9/16] w-full rounded-md bg-raised" />}
                />
                <span className="truncate text-xs text-foreground">{s.name}</span>
                {on && (
                  <span aria-hidden="true" className="absolute top-3 right-3 inline-flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Check size={12} strokeWidth={2} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => useApp.getState().navigate({ name: 'style' })}
          className="cursor-pointer self-start border-0 bg-transparent p-0 text-xs text-orange-light underline"
        >
          {t('autopilot.wizard.styleHint')}
        </button>
      </div>
    ),
    voice: () => (
      <div className="flex flex-col gap-3">
        <div role="radiogroup" aria-label={t('autopilot.form.voice')} onKeyDown={radioKeys(voiceChoices, form.voiceId, (voiceId) => change({ voiceId }))} className="flex flex-col gap-2">
          {voiceChoices.map((voiceId) => {
            const v = voices.find((x) => x.id === voiceId);
            const on = voiceId === form.voiceId;
            return (
              <div key={voiceId ?? 'default'} className={cn('flex items-center gap-3 rounded-xl border bg-card p-3', on ? 'border-primary' : 'border-border')}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={tabStop(voiceChoices, form.voiceId, voiceId)}
                  onClick={() => change({ voiceId })}
                  className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 border-0 bg-transparent p-0 text-left"
                >
                  <span className="text-[13px] text-foreground">{voiceId ? (v?.name ?? voiceId) : t('autopilot.form.voiceDefault')}</span>
                  <span className="text-xs text-text-3">{voiceId ? v?.description : t('autopilot.form.voiceDefaultHint')}</span>
                </button>
                {v?.previewUrl && <audio controls preload="none" src={v.previewUrl} aria-label={t('autopilot.form.voicePreview', { name: v.name })} className="h-8 w-44 shrink-0" />}
              </div>
            );
          })}
        </div>
        <p className="m-0 text-xs text-text-3">{t('autopilot.form.voiceCredits')}</p>
      </div>
    ),
    schedule: () => (
      <div className="flex flex-col gap-4">
        <div role="group" aria-label={t('autopilot.form.frequency')} className="flex flex-wrap gap-2">
          {DAY_MODES.map((m) => (
            <button key={m} type="button" aria-pressed={form.mode === m} className={chip(form.mode === m)} onClick={() => change({ mode: m })}>
              {t(`autopilot.form.${MODE_NAMES[m]}`)}
            </button>
          ))}
        </div>
        {form.mode === 'custom' && (
          <div role="group" aria-label={t('autopilot.form.days')} className="flex flex-wrap gap-2">
            {WEEK.map((d) => {
              const on = form.days.includes(d);
              return (
                <button key={d} type="button" aria-pressed={on} className={chip(on)} onClick={() => change({ days: on ? form.days.filter((x) => x !== d) : [...form.days, d] })}>
                  {dayName(d)}
                </button>
              );
            })}
          </div>
        )}
        <div role="radiogroup" aria-label={t('autopilot.form.perDay')} onKeyDown={radioKeys(COUNTS, form.times.length, setCount)} className="flex flex-col gap-2">
          <span className="text-xs text-text-2">{t('autopilot.form.perDay')}</span>
          <div className="flex flex-wrap gap-2">
            {COUNTS.map((n) => (
              <button key={n} type="button" role="radio" aria-checked={form.times.length === n} tabIndex={tabStop(COUNTS, form.times.length, n)} className={chip(form.times.length === n)} onClick={() => setCount(n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-xs text-text-2">{t('autopilot.form.times')}</span>
          <div className="flex flex-wrap items-center gap-2">
            {form.times.map((v, i) => (
              <Input
                key={i}
                type="time"
                aria-label={t('autopilot.form.timeN', { n: i + 1 })}
                value={v}
                className="h-9 w-[110px]"
                onChange={(e) => change({ times: form.times.map((x, j) => (j === i ? e.target.value : x)) })}
              />
            ))}
          </div>
        </div>
        <div
          role="radiogroup"
          aria-label={t('autopilot.form.length')}
          onKeyDown={radioKeys(lengths, form.lengthSec, (lengthSec) => change({ lengthSec }))}
          className="flex flex-col gap-2"
        >
          <span className="text-xs text-text-2">{t('autopilot.form.length')}</span>
          <div className="flex flex-wrap gap-2">
            {lengths.map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={form.lengthSec === n}
                tabIndex={tabStop(lengths, form.lengthSec, n)}
                className={chip(form.lengthSec === n)}
                onClick={() => change({ lengthSec: n })}
              >
                {t('chat.seconds', { n })}
              </button>
            ))}
          </div>
        </div>
        {!problems.schedule && first.length > 0 && (
          <p data-testid="first-videos" className="m-0 font-mono text-xs text-text-2">
            {t('autopilot.wizard.firstVideos', { list: first.map(slotTime).join(', ') })}
          </p>
        )}
      </div>
    ),
    agent: () => (
      <div className="flex flex-col gap-5">
        {!installed.length && <p className="m-0 text-xs text-text-2">{t('autopilot.form.noAgents')}</p>}
        <div
          role="radiogroup"
          aria-label={t('autopilot.form.agent')}
          onKeyDown={radioKeys(agentIds, form.agentId as AgentInfo['id'], (agentId) => change({ agentId }))}
          className="flex flex-wrap gap-2"
        >
          {installed.map((a) => {
            const on = a.id === form.agentId;
            return (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={tabStop(agentIds, form.agentId as AgentInfo['id'], a.id)}
                onClick={() => change({ agentId: a.id })}
                className={cn(
                  'inline-flex cursor-pointer items-center gap-2 rounded-xl border bg-card px-3 py-2 text-[13px] text-foreground',
                  on ? 'border-primary' : 'border-border hover:border-hairline',
                )}
              >
                <AgentLogo id={a.id} size={20} />
                {AGENT_NAMES[a.id]}
              </button>
            );
          })}
        </div>
        <p data-testid="autopilot-auto-mode" className="m-0 rounded-xl border border-border bg-card p-4 text-xs leading-normal text-text-2">
          {t('autopilot.wizard.autoMode')}
        </p>
        <div role="radiogroup" aria-label={t('autopilot.form.review')} onKeyDown={radioKeys(REVIEW_CHOICES, form.review, (review) => change({ review }))} className="flex flex-col gap-2">
          <span className="text-xs text-text-2">{t('autopilot.form.review')}</span>
          {REVIEW_CHOICES.map((review) => {
            const on = form.review === review;
            return (
              <button
                key={String(review)}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={tabStop(REVIEW_CHOICES, form.review, review)}
                onClick={() => change({ review })}
                className={cn('flex cursor-pointer flex-col gap-0.5 rounded-xl border bg-card p-3 text-left', on ? 'border-primary' : 'border-border hover:border-hairline')}
              >
                <span className="text-[13px] text-foreground">{review ? t('autopilot.wizard.reviewValueOn') : t('autopilot.wizard.reviewValueOff')}</span>
                <span className="text-xs text-text-3">{review ? t('autopilot.wizard.reviewOn') : t('autopilot.wizard.reviewOff')}</span>
              </button>
            );
          })}
        </div>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1 p-0 text-xs text-text-2">{t('autopilot.form.accounts')}</legend>
          {accounts.map((a) => (
            <label key={a.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.socialAccountIds.includes(a.id)}
                disabled={!form.socialAccountIds.includes(a.id) && form.socialAccountIds.length >= MAX_ACCOUNTS}
                onChange={(e) => change({ socialAccountIds: e.target.checked ? [...form.socialAccountIds, a.id] : form.socialAccountIds.filter((x) => x !== a.id) })}
                className="accent-[var(--color-primary)]"
              />
              {accountName(a)}
            </label>
          ))}
          {!accounts.length && <p className="m-0 text-xs text-text-3">{accountsFailed ? t('autopilot.form.accountsFailed') : t('autopilot.form.noAccounts')}</p>}
          <p className="m-0 text-xs text-text-3">{form.socialAccountIds.length ? t('autopilot.form.accountsHint') : t('autopilot.form.manualHint')}</p>
          <button type="button" onClick={() => useApp.getState().navigate({ name: 'social' })} className="cursor-pointer self-start border-0 bg-transparent p-0 text-xs text-orange-light underline">
            {t('autopilot.form.connectAccount')}
          </button>
        </fieldset>
      </div>
    ),
    summary: () => {
      const rows: [StepKey, string, string][] = [
        ['niche', t('autopilot.form.name'), form.name.trim()],
        ['niche', t('autopilot.form.niche'), niches.find((n) => n.id === form.nicheId)?.title ?? form.niche.trim()],
        ['niche', t('autopilot.form.language'), languageLabel(form.language)],
        ['style', t('autopilot.form.style'), style?.name ?? ''],
        ['voice', t('autopilot.form.voice'), form.voiceId ? (voices.find((v) => v.id === form.voiceId)?.name ?? form.voiceId) : t('autopilot.form.voiceDefault')],
        ['schedule', t('autopilot.form.frequency'), validTimes(form.times) ? frequencyLabel({ frequency: frequencyOf(form) }) : ''],
        ['schedule', t('autopilot.form.length'), t('chat.seconds', { n: form.lengthSec })],
        ['agent', t('autopilot.form.agent'), form.agentId ? AGENT_NAMES[form.agentId] : ''],
        ['agent', t('autopilot.wizard.autoModeLabel'), t('autopilot.wizard.autoModeValue')],
        ['agent', t('autopilot.form.review'), form.review ? t('autopilot.wizard.reviewValueOn') : t('autopilot.wizard.reviewValueOff')],
        [
          'agent',
          t('autopilot.form.accounts'),
          form.socialAccountIds.map((x) => { const a = accounts.find((c) => c.id === x); return a ? accountName(a) : x; }).join(', ') || t('autopilot.form.manual'),
        ],
      ];
      return (
        <div className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
          {SECTIONS.map((section) => (
            <div key={section} data-testid={`summary-${section}`} className="flex items-start gap-4 p-4">
              <dl className="m-0 grid flex-1 grid-cols-[120px_1fr] gap-x-4 gap-y-1 text-[13px]">
                {rows
                  .filter(([s]) => s === section)
                  .map(([, k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-text-3">{k}</dt>
                      <dd className="m-0 min-w-0 break-words text-foreground">{v}</dd>
                    </div>
                  ))}
              </dl>
              <Button
                variant="ghost"
                className="h-7 px-2 text-xs"
                aria-label={t('autopilot.wizard.editAria', { section: t(`autopilot.wizard.steps.${section}`) })}
                onClick={() => setStep(STEP_KEYS.indexOf(section))}
              >
                {t('autopilot.wizard.edit')}
              </Button>
            </div>
          ))}
        </div>
      );
    },
  };

  const last = step === STEP_KEYS.length - 1;
  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-8">
      <div data-tauri-drag-region className="flex flex-wrap items-center gap-4">
        <h1 className="m-0 mr-auto text-[28px] font-semibold tracking-[-0.01em]">
          {editing ? t('autopilot.wizard.titleEdit', { name: editing.name }) : t('autopilot.wizard.titleNew')}
        </h1>
        <Button variant="ghost" onClick={cancel}>
          {t('common.cancel')}
        </Button>
      </div>
      {loadError && (
        <p role="alert" className="m-0 text-xs text-orange-light">
          {loadError}
        </p>
      )}
      {!loading && !loadError && (
        <>
          <StepBar steps={stepNames} current={step} label={t('autopilot.wizard.stepsAria')} onPick={editing ? setStep : undefined} />
          <section aria-labelledby="wizard-heading" className="flex max-w-[720px] flex-col gap-5">
            <h2 id="wizard-heading" ref={heading} tabIndex={-1} className="m-0 text-xl font-medium outline-none">
              {t(`autopilot.wizard.headings.${key}`)}
            </h2>
            {body[key]()}
            {saveError && (
              <p role="alert" className="m-0 text-xs text-orange-light">
                {saveError}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              {step > 0 && (
                <Button variant="secondary" onClick={() => setStep((s) => s - 1)}>
                  {t('common.back')}
                </Button>
              )}
              {problem && (
                <span id="wizard-problem" className="text-xs text-orange-light">
                  {problem}
                </span>
              )}
              {last ? (
                <Button className="ml-auto" disabled={busy || !!problem} aria-describedby={problem ? 'wizard-problem' : undefined} onClick={() => void save()}>
                  {busy ? t('autopilot.wizard.saving') : editing ? t('autopilot.wizard.saveChanges') : t('autopilot.wizard.start')}
                </Button>
              ) : (
                <Button className="ml-auto" disabled={!!problem} aria-describedby={problem ? 'wizard-problem' : undefined} onClick={() => setStep((s) => s + 1)}>
                  {t('autopilot.wizard.next')}
                </Button>
              )}
            </div>
          </section>
        </>
      )}

      <Dialog open={leaving !== null} onOpenChange={(o) => !o && setLeaving(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{editing ? t('autopilot.wizard.discardEditTitle') : t('autopilot.wizard.discardTitle')}</DialogTitle>
            <DialogDescription>{t('autopilot.wizard.discardText')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setLeaving(null)}>
              {t('autopilot.wizard.keepEditing')}
            </Button>
            <Button
              onClick={() => {
                const next = leaving;
                setLeaving(null);
                touched.current = false;
                useApp.getState().setLeaveGuard(null);
                if (next) useApp.getState().navigate(next);
              }}
            >
              {t('autopilot.wizard.discard')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
