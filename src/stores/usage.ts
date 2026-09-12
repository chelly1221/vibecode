// Subscription usage ("남은 사용량") per AI account: the rate-limit windows the CLIs report,
// kept as the latest value plus a time series for the usage graph. Live values arrive as
// `rate_limits` session events (dispatched by the sessions store); history comes from the DB.

import { create } from "zustand";
import { ipc, type Provider, type RateLimitWindow, type UsageSample } from "@/lib/ipc";

export interface UsagePoint {
  /** Unix epoch seconds. */
  t: number;
  /** Used percentage 0..100. */
  used: number;
}

export interface WindowUsage {
  window: RateLimitWindow;
  /** Unix epoch seconds of the report. */
  observedAt: number;
  points: UsagePoint[];
}

export interface AccountUsage {
  provider: Provider;
  accountId: string | null;
  /** Keyed by window id ("five_hour", "primary", ...), in report order. */
  windows: Record<string, WindowUsage>;
  /** History from the DB was merged in (for the selected range). */
  historyHours: number | null;
}

/** Max points kept per window in memory (oldest dropped). */
export const MAX_POINTS = 4000;
/** A repeated identical value within this many seconds does not add a point. */
const DEDUPE_SECS = 30;

export function usageKey(provider: Provider, accountId: string | null | undefined): string {
  return `${provider}:${accountId ?? ""}`;
}

export function emptyAccount(provider: Provider, accountId: string | null): AccountUsage {
  return { provider, accountId, windows: {}, historyHours: null };
}

/** Insert a point keeping the series sorted by time; identical repeats close together are skipped. */
export function pushPoint(points: UsagePoint[], p: UsagePoint): UsagePoint[] {
  const last = points[points.length - 1];
  if (last && last.t <= p.t) {
    if (Math.abs(last.used - p.used) < 0.05 && p.t - last.t < DEDUPE_SECS) return points;
    const next = points.concat(p);
    return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
  }
  // Out-of-order (history merged after live points): insert at the right place, drop exact dupes.
  let i = points.length;
  while (i > 0 && points[i - 1].t > p.t) i--;
  const prev = points[i - 1];
  if (prev && prev.t === p.t && Math.abs(prev.used - p.used) < 0.05) return points;
  const next = points.slice();
  next.splice(i, 0, p);
  return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
}

/** Pure merge of one report into an account (new object). */
export function mergeReport(acc: AccountUsage, windows: RateLimitWindow[], observedAt: number): AccountUsage {
  const next: Record<string, WindowUsage> = { ...acc.windows };
  for (const w of windows) {
    const cur = next[w.id];
    const points = pushPoint(cur?.points ?? [], { t: observedAt, used: w.used_percent });
    if (cur && cur.observedAt > observedAt) {
      // Older sample (history): keep the newer live value, just extend the series.
      next[w.id] = { ...cur, points };
    } else {
      next[w.id] = { window: w, observedAt, points };
    }
  }
  return { ...acc, windows: next };
}

export function mergeSamples(acc: AccountUsage, samples: UsageSample[]): AccountUsage {
  let out = acc;
  for (const s of samples) out = mergeReport(out, [s.window], s.observed_at);
  return out;
}

/** Windows never shown anywhere: Claude's weekly window recomputed with the "extra usage" budget
 *  duplicates the plain weekly window for everyone who has not enabled paid extra usage. */
export const HIDDEN_WINDOW_IDS: ReadonlySet<string> = new Set(["seven_day_overage_included"]);

/** Windows of an account in a stable display order (short window first), hidden ones dropped. */
export function orderedWindows(acc: AccountUsage): WindowUsage[] {
  const rank = (w: WindowUsage) => w.window.window_minutes ?? (w.window.id === "five_hour" || w.window.id === "primary" ? 300 : 10_080);
  return Object.values(acc.windows)
    .filter((w) => !HIDDEN_WINDOW_IDS.has(w.window.id))
    .sort((a, b) => rank(a) - rank(b) || a.window.id.localeCompare(b.window.id));
}

/** The short (5-hour) window of an account, i.e. the first in display order. */
export function shortWindow(acc: AccountUsage): WindowUsage | null {
  return orderedWindows(acc)[0] ?? null;
}

interface UsageStore {
  accounts: Record<string, AccountUsage>;
  /** Merge a live report (from a `rate_limits` session event). */
  ingest: (provider: Provider, accountId: string | null, windows: RateLimitWindow[], observedAt: number) => void;
  /** Load the newest stored values of every account (app start / panel open). */
  loadLatest: () => Promise<void>;
  /** Load the stored series of one account for the last `hours` hours. */
  loadHistory: (provider: Provider, accountId: string | null, hours: number) => Promise<void>;
  /** Ask the CLI for fresh values (Codex). */
  refresh: (provider: Provider, accountId: string | null) => Promise<RateLimitWindow[]>;
}

export const useUsageStore = create<UsageStore>((set, get) => ({
  accounts: {},

  ingest: (provider, accountId, windows, observedAt) => {
    if (windows.length === 0) return;
    const key = usageKey(provider, accountId);
    set((s) => {
      const cur = s.accounts[key] ?? emptyAccount(provider, accountId);
      return { accounts: { ...s.accounts, [key]: mergeReport(cur, windows, observedAt) } };
    });
  },

  loadLatest: async () => {
    const samples = await ipc.usage.latest();
    set((s) => {
      const accounts = { ...s.accounts };
      for (const sample of samples) {
        const key = usageKey(sample.provider, sample.account_id);
        const cur = accounts[key] ?? emptyAccount(sample.provider, sample.account_id ?? null);
        accounts[key] = mergeReport(cur, [sample.window], sample.observed_at);
      }
      return { accounts };
    });
  },

  loadHistory: async (provider, accountId, hours) => {
    const samples = await ipc.usage.history(provider, accountId, hours);
    const key = usageKey(provider, accountId);
    set((s) => {
      const cur = s.accounts[key] ?? emptyAccount(provider, accountId);
      return { accounts: { ...s.accounts, [key]: { ...mergeSamples(cur, samples), historyHours: hours } } };
    });
  },

  refresh: async (provider, accountId) => {
    const windows = await ipc.usage.refresh(provider, accountId);
    get().ingest(provider, accountId, windows, Math.floor(Date.now() / 1000));
    return windows;
  },
}));
