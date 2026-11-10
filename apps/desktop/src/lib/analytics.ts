import posthog, { type CaptureResult } from 'posthog-js';
import type { AgentId, AgentUpdate } from '@tayang/shared';
import { onAgentUpdate } from '@/lib/events';

/**
 * Product analytics through PostHog, only while the user shares anonymous stats (Settings › Account).
 * What it sends: which features are used (a video rendered, a post made), the app version and
 * system. Never chat text, prompts, file names or videos; no autocapture, no session replay, no
 * remote scripts. Without the Vite PostHog configuration (forks, tests) it is a no-op.
 */

// Never under Vitest: tests must not send anything, whatever env files exist.
const KEY = import.meta.env.VITEST ? '' : import.meta.env.VITE_POSTHOG_KEY?.trim() || '';
const HOST = import.meta.env.VITE_POSTHOG_HOST?.trim() || '';

let started = false;
let enabled = false;

type AiTurn = {
  agent: AgentId | undefined;
  traceId: string;
  generationId: string;
  startedAt: number;
  finishedTools: Set<string>;
};

const aiTurns = new Map<string, AiTurn>();
const aiAgents = new Map<string, AgentId>();
let aiListening = false;

const aiProvider = (agent: AgentId | undefined): string | undefined => {
  switch (agent) {
    case 'claude':
      return 'anthropic';
    case 'codex':
      return 'openai';
    case 'gemini':
      return 'google';
    default:
      return undefined;
  }
};

const aiId = () => crypto.randomUUID();

/** Remembers the externally launched agent that will service this ACP chat. */
export function registerAiAgent(chatId: string, agent: AgentId): void {
  aiAgents.set(chatId, agent);
}

/** Starts one AI Observability trace after Rust has accepted an ACP prompt. */
export function startAiGeneration(chatId: string): void {
  aiTurns.set(chatId, {
    agent: aiAgents.get(chatId),
    traceId: aiId(),
    generationId: aiId(),
    startedAt: Date.now(),
    finishedTools: new Set(),
  });
}

/** Records the one-shot OpenAI-compatible connection check without its prompt, output, URL, or key. */
export function captureAiApiCheck(model: string, startedAt: number, succeeded: boolean): void {
  if (!started || !enabled) return;
  posthog.capture('$ai_generation', {
    $ai_trace_id: aiId(),
    $ai_session_id: null,
    $ai_span_id: aiId(),
    $ai_span_name: 'api_connection_check',
    $ai_model: model,
    $ai_latency: (Date.now() - startedAt) / 1000,
    $ai_stream: false,
    ...(succeeded ? {} : { $ai_is_error: true }),
  });
}

function captureAiUpdate(chatId: string, update: AgentUpdate): void {
  const turn = aiTurns.get(chatId);
  if (!turn) return;
  const common = {
    $ai_trace_id: turn.traceId,
    $ai_session_id: chatId,
    ...(turn.agent ? { agent: turn.agent } : {}),
    ...(aiProvider(turn.agent) ? { $ai_provider: aiProvider(turn.agent) } : {}),
  };
  if (update.kind === 'tool') {
    if ((update.status !== 'done' && update.status !== 'failed') || turn.finishedTools.has(update.toolCallId)) return;
    turn.finishedTools.add(update.toolCallId);
    if (!started || !enabled) return;
    posthog.capture('$ai_span', {
      ...common,
      $ai_span_id: update.toolCallId,
      $ai_parent_id: turn.generationId,
      $ai_span_name: `agent_tool_${update.toolKind ?? 'unknown'}`,
      ...(update.status === 'failed' ? { $ai_is_error: true } : {}),
    });
    return;
  }
  if (update.kind !== 'done' && update.kind !== 'error') return;
  aiTurns.delete(chatId);
  if (!started || !enabled) return;
  posthog.capture('$ai_generation', {
    ...common,
    $ai_span_id: turn.generationId,
    $ai_span_name: 'agent_turn',
    $ai_latency: (Date.now() - turn.startedAt) / 1000,
    $ai_stream: true,
    ...(update.kind === 'done' ? { $ai_stop_reason: update.stopReason } : { $ai_is_error: true }),
  });
}

/** Listens once for ACP turn completion, covering foreground chats and background agent work. */
export function startAiObservability(): void {
  if (aiListening) return;
  aiListening = true;
  void onAgentUpdate(({ chatId, update }) => captureAiUpdate(chatId, update)).catch(() => {
    aiListening = false;
  });
}

/** `/Users/name/...`, `/home/name/...`, `C:\Users\name\...` → `~/...`: home paths say who the user is. */
const HOME = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^/\\\s"']+/g;
const scrub = (v: unknown): unknown =>
  typeof v === 'string' ? v.replace(HOME, '~') : Array.isArray(v) ? v.map(scrub) : v && typeof v === 'object' ? scrubObject(v as Record<string, unknown>) : v;
function scrubObject(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = scrub(v);
  return out;
}

/** The last guard before anything leaves: home paths out of every property (error messages too). */
export function beforeSend(e: CaptureResult | null): CaptureResult | null {
  if (!e) return e;
  return { ...e, properties: scrubObject(e.properties ?? {}) };
}

export interface AnalyticsContext {
  /** The user shares anonymous stats (Settings › Account). */
  share: boolean;
  /** The install's random id, also used by the daily install ping. */
  installId: string;
  appVersion?: string;
  os?: string;
  uiLanguage?: string | null;
}

/**
 * Starts PostHog once, opted in or out by `share`; later calls only switch it on or off and update
 * who this install is. Safe to call on every settings change.
 */
export function startAnalytics(ctx: AnalyticsContext): void {
  const missing = !KEY ? 'VITE_POSTHOG_KEY' : !HOST ? 'VITE_POSTHOG_HOST' : null;
  if (missing) {
    if (import.meta.env.DEV && !import.meta.env.VITEST) {
      console.error(
        `${missing} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missing} is configured`,
      );
    }
    return;
  }
  if (!started) {
    posthog.init(KEY, {
      api_host: HOST,
      logs: {
        serviceName: 'tayang-desktop-renderer',
        environment: import.meta.env.DEV ? 'development' : 'production',
        serviceVersion: ctx.appVersion ?? 'unknown',
      },
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_external_dependency_loading: true,
      // One global handler for uncaught errors and unhandled promise rejections; console output is not error telemetry.
      capture_exceptions: {
        capture_unhandled_errors: true,
        capture_unhandled_rejections: true,
        capture_console_errors: false,
      },
      persistence: 'localStorage',
      person_profiles: 'identified_only',
      opt_out_capturing_by_default: !ctx.share,
      before_send: beforeSend,
      ...(ctx.installId ? { bootstrap: { distinctID: ctx.installId } } : {}),
    });
    started = true;
  }
  posthog.register({
    build: import.meta.env.DEV ? 'dev' : 'release',
    ...(ctx.installId ? { install_id: ctx.installId } : {}),
    ...(ctx.appVersion ? { app_version: ctx.appVersion } : {}),
    ...(ctx.os ? { os_family: ctx.os } : {}),
    ...(ctx.uiLanguage ? { ui_language: ctx.uiLanguage } : {}),
  });
  // Opting in once is remembered; no $opt_in event on every launch.
  if (ctx.share && !posthog.has_opted_in_capturing()) posthog.opt_in_capturing({ captureEventName: null });
  if (!ctx.share && (enabled || !posthog.has_opted_out_capturing())) posthog.opt_out_capturing();
  enabled = ctx.share;
  // Once per launch, for daily active installs.
  if (enabled && !opened) {
    opened = true;
    posthog.capture('app opened');
    logAnalyticsInfo('desktop renderer started', {
      build: import.meta.env.DEV ? 'dev' : 'release',
      has_app_version: !!ctx.appVersion,
      has_os_family: !!ctx.os,
    });
  }
}

let opened = false;

/** Dedicated PostHog Logs output: only purpose-written records from this module are exported. */
function logAnalyticsInfo(message: string, attributes: Record<string, string | number | boolean>): void {
  if (!started || !enabled) return;
  posthog.logger.info(message, attributes);
}

/** One product event: a name in "noun verb" form and plain properties (never user text). */
export function track(event: string, properties?: Record<string, string | number | boolean | null | undefined>): void {
  if (!started || !enabled) return;
  posthog.capture(event, properties);
}

/** A Tayang account signed in: its id (never the email) and plan. */
export function identifyAccount(accountId: string, plan: string): void {
  if (!started || !enabled) return;
  // Already this account (a later launch): only the plan may have changed.
  if (posthog.get_distinct_id() === accountId) {
    posthog.setPersonProperties({ plan });
    logAnalyticsInfo('account analytics identity restored', { plan });
    return;
  }
  posthog.identify(accountId, { plan });
  logAnalyticsInfo('account analytics identity established', { plan });
}

/** Signed out: later events are this install's again, not the account's. */
export function forgetAccount(installId: string): void {
  if (!started) return;
  logAnalyticsInfo('account analytics identity reset', { has_install_identity: !!installId });
  posthog.reset();
  if (installId) {
    posthog.identify(installId);
    posthog.register({ install_id: installId });
  }
}

/** An error in a flow that matters (rendering, posting, a style study), with where it happened. */
export function trackError(error: unknown, where: string): void {
  if (!started || !enabled) return;
  posthog.captureException(error instanceof Error ? error : new Error(String(error)), { where });
}
