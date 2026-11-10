import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarClock, ChevronLeft, Clapperboard, MessageSquare, Pause, Pencil, Play, Plus, Repeat, Square, Trash2, type LucideIcon } from 'lucide-react';
import type { Autopilot as AutopilotT, AutopilotSlot, Project, SlotStatus, Style } from '@tayang/shared';
import { Button } from '@/components/Button';
import { Oyen } from '@/components/Oyen';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { frequencyLabel, planSlots, slotTime } from '@/lib/autopilot';
import { track } from '@/lib/analytics';
import { startAutopilotChat } from '@/lib/autopilotChat';
import { canStopNow, notifyAutopilotChanged, onAutopilotChanged, stopNow, useCanStopNow } from '@/lib/autopilotHooks';
import { calendarState } from '@/lib/calendarState';
import { deleteAutopilot, listAutopilots, listProjects, listSlots, listStyles, setAutopilotStatus, updateSlot } from '@/lib/ipc';
import { openProjectChat } from '@/lib/openProject';
import { localized } from '@/lib/stored';
import { inTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { PreviewImage, posterOf } from '@/screens/Style';
import { useApp } from '@/state/app';

const EPOCH = '1970-01-01T00:00:00Z';
const DAY_MS = 86_400_000;

const SWATCHES = ['#0B1E3F', '#3B1F14', '#1F2A1A', '#2B1B3F', '#5C1C08', '#1F1F1F'];
const swatchFor = (id: string) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return SWATCHES[h % SWATCHES.length]!;
};

const SLOT_DOT: Record<SlotStatus, string> = {
  planned: 'border border-text-3',
  making: 'bg-primary motion-safe:animate-pulse',
  done: 'bg-foreground',
  failed: 'bg-orange-light',
  skipped: 'bg-hairline',
};

interface Data {
  autopilots: AutopilotT[];
  slots: AutopilotSlot[];
  styles: Style[];
  projects: Project[];
}

/** The autopilots, their slots (all, up to 8 days ahead), styles and projects; reloads on every autopilot change. */
function useAutopilotData(now: Date) {
  const { t } = useTranslation();
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => onAutopilotChanged(() => setTick((n) => n + 1)), []);
  const horizon = new Date(now.getTime() + 8 * DAY_MS).toISOString();
  useEffect(() => {
    let alive = true;
    Promise.all([listAutopilots(), listSlots(EPOCH, horizon), listStyles().catch(() => []), listProjects().catch(() => [])])
      .then(([autopilots, slots, styles, projects]) => {
        if (!alive) return;
        setData({ autopilots, slots, styles, projects });
        setLoadError(null);
      })
      .catch(() => alive && setLoadError(t('autopilot.cantLoad')));
    return () => {
      alive = false;
    };
  }, [tick]);
  return { data, loadError };
}

/** The clock, a minute at a time, unless a fixed `now` is given (tests). */
function useNow(fixed?: Date) {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    if (fixed) return;
    const id = setInterval(() => setClock(new Date()), 60_000);
    return () => clearInterval(id);
  }, [fixed]);
  return fixed ?? clock;
}

function StyleThumb({ style, id, className }: { style: Style | undefined; id: string; className: string }) {
  const swatch = <span aria-hidden="true" className={cn(className, 'block')} style={{ background: swatchFor(style?.id ?? id) }} />;
  return <PreviewImage key={style?.id ?? id} src={style ? posterOf(style) : null} className={cn(className, 'object-cover')} fallback={swatch} />;
}

function StatusChip({ paused, making }: { paused: boolean; making: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium',
        making ? 'bg-tint text-orange-light' : paused ? 'border border-hairline text-text-3' : 'bg-raised text-text-2',
      )}
    >
      <span
        aria-hidden="true"
        className={cn('size-1.5 rounded-full', making ? 'bg-primary motion-safe:animate-pulse' : paused ? 'border border-text-3' : 'bg-primary')}
      />
      {making ? t('autopilot.makingNow') : paused ? t('autopilot.paused') : t('autopilot.active')}
    </span>
  );
}

/** One fact about an autopilot: an icon and a short line. */
function Fact({ icon: Icon, title, children }: { icon: LucideIcon; title?: string; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-text-2">
      <Icon size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-text-3" />
      <span title={title}>{children}</span>
    </span>
  );
}

const ACTION = 'h-8 gap-1.5 rounded-md px-2.5 text-xs [&_svg]:size-3.5';

/** One autopilot: what it makes, how often, its state and its actions. `onOpen` makes the summary a button. */
function AutopilotCard({
  a,
  data,
  now,
  onOpen,
  onError,
  onDeleted,
}: {
  a: AutopilotT;
  data: Data;
  now: Date;
  onOpen?: () => void;
  onError(message: string): void;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useApp((s) => s.navigate);
  const canStop = useCanStopNow();
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const paused = a.status === 'paused';
  const mine = data.slots.filter((s) => s.autopilotId === a.id);
  const making = mine.find((s) => s.status === 'making');
  const planned = mine
    .filter((s) => s.status === 'planned' && Date.parse(s.dueAt) > now.getTime())
    .map((s) => new Date(s.dueAt))
    .sort((x, y) => x.getTime() - y.getTime())[0];
  const next = paused ? undefined : (planned ?? planSlots(a, now, 8)[0]);
  const made = mine.filter((s) => s.status === 'done').length;
  const failed = mine.filter((s) => s.status === 'failed').length;
  const style = data.styles.find((s) => s.id === a.styleId);
  const act = (key: 'pause' | 'resume' | 'edit' | 'delete') => t('autopilot.actionAria', { action: t(`autopilot.${key}`), name: a.name });

  const job = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      notifyAutopilotChanged();
    } catch {
      onError(t('autopilot.cantUpdate'));
    }
  };

  const summary = (
    <>
      <StyleThumb style={style} id={a.id} className={cn('shrink-0 rounded-lg border border-hairline', onOpen ? 'h-[107px] w-[60px]' : 'h-[142px] w-20')} />
      <span className={cn('flex min-w-0 flex-1 flex-col gap-1.5 self-stretch', onOpen ? 'py-0.5' : 'py-1')}>
        <span className="flex items-center gap-3">
          <span className={cn('mr-auto truncate font-medium text-foreground', onOpen ? 'text-base' : 'text-xl tracking-[-0.01em]')}>{a.name}</span>
          <StatusChip paused={paused} making={!!making} />
        </span>
        <span className="line-clamp-2 max-w-[70ch] text-[13px] leading-[1.5] text-text-2">{a.niche}</span>
        <span className="mt-auto flex flex-wrap gap-x-4 gap-y-1 pt-1.5">
          <Fact icon={Repeat}>{frequencyLabel(a)}</Fact>
          {next ? (
            <Fact icon={CalendarClock} title={slotTime(next)}>
              {t('autopilot.nextVideo', { when: inTime(next, now) })}
            </Fact>
          ) : (
            !paused && <Fact icon={CalendarClock}>{t('autopilot.noNext')}</Fact>
          )}
          <Fact icon={Clapperboard}>{t('autopilot.counts', { made, failed })}</Fact>
        </span>
      </span>
    </>
  );

  return (
    <div
      data-testid="autopilot-card"
      className={cn('flex flex-col rounded-xl border bg-card transition-colors', making ? 'border-deep-orange' : 'border-border', onOpen && !making && 'hover:border-hairline')}
    >
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full cursor-pointer items-start gap-4 rounded-t-xl border-0 bg-transparent p-4 text-left focus-visible:outline-2 focus-visible:outline-primary"
        >
          {summary}
        </button>
      ) : (
        <div className="flex items-start gap-5 p-5">{summary}</div>
      )}
      <div className={cn('flex flex-wrap items-center gap-1 border-t border-border py-2', onOpen ? 'px-3' : 'px-4')}>
        {making && canStop && (
          <Button variant="secondary" className={cn(ACTION, 'mr-1')} onClick={() => void job(() => stopNow(making))}>
            <Square aria-hidden="true" strokeWidth={1.5} />
            {t('autopilot.stopNow')}
          </Button>
        )}
        <Button
          variant="ghost"
          className={ACTION}
          aria-label={act(paused ? 'resume' : 'pause')}
          onClick={() => void job(async () => {
            const status = paused ? 'active' : 'paused';
            await setAutopilotStatus(a.id, status);
            track('autopilot_status_changed', { status });
          })}
        >
          {paused ? <Play aria-hidden="true" strokeWidth={1.5} /> : <Pause aria-hidden="true" strokeWidth={1.5} />}
          {paused ? t('autopilot.resume') : t('autopilot.pause')}
        </Button>
        <Button variant="ghost" className={ACTION} aria-label={act('edit')} onClick={() => navigate({ name: 'autopilot-wizard', id: a.id })}>
          <Pencil aria-hidden="true" strokeWidth={1.5} />
          {t('autopilot.edit')}
        </Button>
        <Button variant="ghost" className={cn(ACTION, 'ml-auto hover:text-error')} aria-label={act('delete')} onClick={() => setDeleting(true)}>
          <Trash2 aria-hidden="true" strokeWidth={1.5} />
          {t('autopilot.delete')}
        </Button>
      </div>

      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('autopilot.deleteTitle', { name: a.name })}</DialogTitle>
            <DialogDescription>{t('autopilot.deleteText')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await job(async () => {
                  // A video being made for it would otherwise go on with nothing left to stop it.
                  if (making && canStopNow()) await stopNow(making);
                  await deleteAutopilot(a.id);
                  track('autopilot_deleted', { was_active: !paused, had_running_video: !!making });
                  onDeleted?.();
                });
                setBusy(false);
                setDeleting(false);
              }}
            >
              {t('autopilot.deleteConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SlotChip({ status }: { status: SlotStatus }) {
  const { t } = useTranslation();
  return (
    <span className={cn('inline-flex w-[104px] shrink-0 items-center gap-1.5 text-xs', status === 'making' ? 'text-orange-light' : 'text-text-2')}>
      <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', SLOT_DOT[status])} />
      {t(`autopilot.slotState.${status}`)}
    </span>
  );
}

const LIST = 'm-0 flex list-none flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card p-0';
const EMPTY = 'm-0 rounded-xl border border-dashed border-hairline px-4 py-8 text-center text-xs text-text-3';

function Detail({ a, data, now, onError }: { a: AutopilotT; data: Data; now: Date; onError(m: string): void }) {
  const { t } = useTranslation();
  const navigate = useApp((s) => s.navigate);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const mine = data.slots.filter((s) => s.autopilotId === a.id);
  const upcoming = mine
    .filter((s) => {
      const at = Date.parse(s.dueAt);
      return at >= startOfToday && at <= now.getTime() + 7 * DAY_MS;
    })
    .sort((x, y) => Date.parse(x.dueAt) - Date.parse(y.dueAt));
  const made = mine
    .filter((s) => s.projectId)
    .sort((x, y) => Date.parse(y.dueAt) - Date.parse(x.dueAt))
    .flatMap((s) => data.projects.filter((p) => p.id === s.projectId))
    .slice(0, 20);

  const tryAgain = async (slot: AutopilotSlot) => {
    try {
      await updateSlot(slot.id, { status: 'planned', error: null, projectId: null });
      notifyAutopilotChanged();
    } catch {
      onError(t('autopilot.cantUpdate'));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <AutopilotCard a={a} data={data} now={now} onError={onError} onDeleted={() => navigate({ name: 'autopilot' })} />

      <div className="grid grid-cols-1 items-start gap-6 min-[1100px]:grid-cols-2">
        <section aria-labelledby="ap-upcoming" className="flex min-w-0 flex-col gap-3">
          <h2 id="ap-upcoming" className="m-0 text-sm font-medium">
            {t('autopilot.upcoming')}
          </h2>
          {!upcoming.length && <p className={EMPTY}>{t('autopilot.noUpcoming')}</p>}
          {!!upcoming.length && (
            <ul className={LIST}>
              {upcoming.map((s) => {
                const at = new Date(s.dueAt);
                const project = s.projectId ? data.projects.find((p) => p.id === s.projectId) : undefined;
                return (
                  <li key={s.id} data-testid="upcoming-slot" className={cn('flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2', s.status === 'making' && 'bg-tint')}>
                    <span className={cn('w-[132px] shrink-0 text-[13px] tabular-nums', s.status === 'skipped' ? 'text-text-3' : 'text-foreground')}>{slotTime(at)}</span>
                    <SlotChip status={s.status} />
                    {project && <span className="min-w-0 truncate text-xs text-text-2">{project.title}</span>}
                    {!project && s.status === 'making' && (
                      // The agent is picking this slot's topic right now.
                      <span role="status" className="flex min-w-0 flex-1 items-center gap-2">
                        <span aria-hidden="true" className="h-2.5 w-24 shrink-0 animate-pulse rounded-full bg-raised motion-reduce:animate-none" />
                        <span className="truncate text-xs text-text-2">{t('autopilot.pickingTopic')}</span>
                      </span>
                    )}
                    {!project && s.status === 'planned' && <span className="min-w-0 truncate text-xs text-text-3">{t('autopilot.topicLater')}</span>}
                    {(s.status === 'failed' || s.status === 'done') && s.error && <span className="min-w-0 truncate text-xs text-orange-light">{localized(s.error)}</span>}
                    {s.status === 'failed' && at.getTime() > now.getTime() && (
                      <Button
                        variant="secondary"
                        className="ml-auto h-7 rounded-sm px-2 text-xs"
                        aria-label={t('autopilot.tryAgainAria', { time: slotTime(at) })}
                        onClick={() => void tryAgain(s)}
                      >
                        {t('autopilot.tryAgain')}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="ap-made" className="flex min-w-0 flex-col gap-3">
          <h2 id="ap-made" className="m-0 text-sm font-medium">
            {t('autopilot.madeBy')}
          </h2>
          {!made.length && <p className={EMPTY}>{t('autopilot.noneMade')}</p>}
          {!!made.length && (
            <ul className={LIST}>
              {made.map((p) => (
                <li key={p.id} data-testid="made-video" className="flex min-h-11 items-center gap-3 px-4 py-2">
                  <span className="mr-auto min-w-0 truncate text-[13px]">{p.title}</span>
                  <span className="shrink-0 text-xs text-text-2">{t(`calendar.states.${calendarState(p, now)}`)}</span>
                  <Button
                    variant="secondary"
                    className="h-7 rounded-sm px-2 text-xs"
                    aria-label={t('autopilot.openVideoAria', { title: p.title })}
                    onClick={() => void openProjectChat(p).catch(() => onError(t('autopilot.cantUpdate')))}
                  >
                    {t('autopilot.openVideo')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/** The Autopilot screen: every autopilot as a card, or one autopilot's detail when `id` is given. */
export function Autopilot({ id, now: fixedNow }: { id?: string; now?: Date } = {}) {
  const { t } = useTranslation();
  const navigate = useApp((s) => s.navigate);
  const now = useNow(fixedNow);
  const { data, loadError } = useAutopilotData(now);
  const [actionError, setActionError] = useState<string | null>(null);
  const current = id ? data?.autopilots.find((a) => a.id === id) : undefined;
  const empty = !!data && !data.autopilots.length && !id;
  const newOne = () => navigate({ name: 'autopilot-wizard' });
  const [startingChat, setStartingChat] = useState(false);
  const newInChat = async () => {
    const settings = useApp.getState().settings;
    if (!settings || startingChat) return;
    setStartingChat(true);
    setActionError(null);
    try {
      await startAutopilotChat(settings);
    } catch {
      setActionError(t('autopilot.chat.cantStart'));
      setStartingChat(false);
    }
  };
  const chatButton = (
    <Button variant="secondary" disabled={startingChat} onClick={() => void newInChat()}>
      <MessageSquare size={16} strokeWidth={1.5} aria-hidden="true" />
      {t('autopilot.chat.create')}
    </Button>
  );

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-8">
      <div data-tauri-drag-region className="flex flex-wrap items-center gap-4">
        <div className="mr-auto flex flex-col gap-1">
          <h1 className="m-0 text-[28px] font-semibold tracking-[-0.01em]">{t('autopilot.title')}</h1>
          <span className="text-sm text-text-2">{t('autopilot.subtitle')}</span>
        </div>
        {!empty && (
          <div className="flex flex-wrap gap-2">
            {chatButton}
            <Button onClick={newOne}>
              <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
              {t('autopilot.add')}
            </Button>
          </div>
        )}
      </div>

      {(loadError || actionError) && (
        <p role="alert" className="m-0 text-xs text-orange-light">
          {loadError ?? actionError}
        </p>
      )}

      {id && (
        <button
          type="button"
          onClick={() => navigate({ name: 'autopilot' })}
          className="inline-flex cursor-pointer items-center gap-1 self-start border-0 bg-transparent p-0 text-[13px] text-text-2 hover:text-foreground"
        >
          <ChevronLeft size={16} strokeWidth={1.5} aria-hidden="true" />
          {t('autopilot.allAutopilots')}
        </button>
      )}

      {data && id && !current && <p className="m-0 text-sm text-text-2">{t('autopilot.gone')}</p>}
      {data && current && <Detail a={current} data={data} now={now} onError={setActionError} />}

      {empty && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
          <Oyen mood="wink" size={64} />
          <p className="m-0 max-w-[420px] text-sm text-text-2">{t('autopilot.emptyLine')}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={newOne}>{t('autopilot.createFirst')}</Button>
            {chatButton}
          </div>
        </div>
      )}

      {data && !id && !empty && (
        <div className="grid grid-cols-1 gap-4 min-[1100px]:grid-cols-2">
          {data.autopilots.map((a) => (
            <AutopilotCard
              key={a.id}
              a={a}
              data={data}
              now={now}
              onOpen={() => navigate({ name: 'autopilot', id: a.id })}
              onError={setActionError}
            />
          ))}
        </div>
      )}

      <p className="m-0 mt-auto border-t border-border pt-3 text-xs leading-[1.6] text-text-3">
        {t('autopilot.plansLine')}{' '}
        <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-xs text-orange-light underline" onClick={() => navigate({ name: 'plans', from: 'autopilot' })}>
          {t('calendar.plans')}
        </button>
      </p>
    </div>
  );
}
