// Small transparent gauge floating over the left edge of the session area: remaining usage of the
// 5-hour window of the account in use. Fills from the bottom like a battery, colored by how much
// is left; clicking opens the detailed panel (7-day window + time-series graph).
import { useEffect, useMemo, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ipc, type AccountProfile, type Provider } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app";
import { shortWindow, useUsageStore, usageKey, type AccountUsage } from "@/stores/usage";
import { PROVIDER_LABEL } from "@/features/chat/labels";
import { remainingPercent, reportAge, resetCountdown, usageLevel } from "./format";

const LEVEL_FILL: Record<ReturnType<typeof usageLevel>, string> = {
  ok: "bg-gradient-to-t from-emerald-600/80 to-emerald-400/80",
  warn: "bg-gradient-to-t from-amber-600/80 to-amber-400/80",
  critical: "bg-gradient-to-t from-red-700/80 to-red-500/80",
};

/** Short bar caption: "5시간" → "5h", "1주일" → "7d", otherwise the label itself. */
export function shortWindowLabel(label: string, minutes: number | null): string {
  if (minutes === 300 || label === "5시간") return "5h";
  if (minutes === 10_080 || label === "1주일") return "7d";
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;
  return label.slice(0, 3);
}

function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/** Account the user is working with right now: the active session's, else the active project's default provider's. */
function useFocusAccount(): { provider: Provider; accountId: string | null } | null {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const project = useAppStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null);
  const sessionProvider = useAppStore((s) => {
    if (!s.activeSessionId) return null;
    for (const list of Object.values(s.sessionsByProject)) {
      const hit = list.find((r) => r.id === s.activeSessionId);
      if (hit) return hit.provider;
    }
    return null;
  });
  const defaultProvider = useAppStore((s) => s.settings?.default_provider ?? "claude");
  const [focus, setFocus] = useState<{ provider: Provider; accountId: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const provider: Provider = sessionProvider ?? project?.default_provider ?? defaultProvider;
    const load = activeSessionId && sessionProvider ? ipc.accounts.session(activeSessionId) : activeProjectId ? ipc.accounts.project(activeProjectId) : null;
    if (!load) {
      setFocus(null);
      return;
    }
    load.then((a) => { if (!cancelled) setFocus({ provider, accountId: a[provider] ?? null }); }).catch(() => { if (!cancelled) setFocus({ provider, accountId: null }); });
    return () => { cancelled = true; };
  }, [activeSessionId, sessionProvider, activeProjectId, project?.default_provider, defaultProvider]);
  return focus;
}

export function UsageStrip() {
  const accounts = useUsageStore((s) => s.accounts);
  const loadLatest = useUsageStore((s) => s.loadLatest);
  const panelOpen = useAppStore((s) => s.usagePanelOpen);
  const setPanelOpen = useAppStore((s) => s.setUsagePanelOpen);
  const [profiles, setProfiles] = useState<AccountProfile[]>([]);
  const focus = useFocusAccount();
  const nowSecs = useNow();

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadLatest().catch(() => {}), ipc.accounts.list().catch(() => [] as AccountProfile[])]).then(([, p]) => { if (!cancelled) setProfiles(p); });
    return () => { cancelled = true; };
  }, [loadLatest]);

  // The account in use; without one, the first account that has reported anything.
  const shown = useMemo(() => {
    let acc: AccountUsage | null = null;
    if (focus) acc = accounts[usageKey(focus.provider, focus.accountId)] ?? { provider: focus.provider, accountId: focus.accountId, windows: {}, historyHours: null };
    else acc = Object.values(accounts).find((a) => Object.keys(a.windows).length > 0) ?? null;
    if (!acc) return null;
    const name = profiles.find((p) => p.id === acc!.accountId)?.name ?? PROVIDER_LABEL[acc.provider];
    return { acc, name, window: shortWindow(acc) };
  }, [accounts, focus, profiles]);

  const w = shown?.window ?? null;
  const used = w?.window.used_percent ?? null;
  const remaining = used === null ? null : remainingPercent(used);
  const level = used === null ? "ok" : usageLevel(used);
  const countdown = resetCountdown(w?.window.resets_at ?? null, nowSecs);
  const caption = w ? shortWindowLabel(w.window.label, w.window.window_minutes ?? null) : "5h";
  const title = shown ? `${PROVIDER_LABEL[shown.acc.provider]} · ${shown.name} · ${w ? `${w.window.label} 창` : "5시간 창"}` : "남은 사용량";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-pressed={panelOpen}
          aria-label={`${title} 남은 사용량 · 자세히 보기`}
          onClick={() => setPanelOpen(!panelOpen)}
          className={cn(
            "pointer-events-auto absolute left-2 top-1/2 z-10 flex h-40 w-7 -translate-y-1/2 flex-col items-center gap-1 rounded-full py-1 opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100",
            panelOpen && "opacity-90",
          )}
        >
          <span className={cn("text-[10px] font-semibold tabular-nums leading-none", remaining === null ? "text-muted-foreground/60" : "text-foreground/90")}>
            {remaining === null ? "—" : `${Math.round(remaining)}`}
          </span>
          <div
            className="relative min-h-0 w-3 flex-1 overflow-hidden rounded-full border border-foreground/15 bg-foreground/10"
            role="progressbar"
            aria-label={title}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={remaining ?? undefined}
          >
            <div className={cn("absolute inset-x-0 bottom-0 rounded-full transition-[height] duration-700 ease-out", LEVEL_FILL[level])} style={{ height: `${remaining ?? 0}%` }} />
          </div>
          <span className="text-[9px] leading-none text-muted-foreground">{caption}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="flex-col items-start gap-0.5">
        <span className="font-medium">{title}</span>
        <span>{remaining === null ? "AI가 작업하면 남은 사용량이 채워집니다" : `남은 사용량 ${Math.round(remaining)}%`}</span>
        {countdown && <span className="opacity-80">{countdown}</span>}
        {w && <span className="opacity-80">{reportAge(w.observedAt, nowSecs)} 갱신 · 눌러서 1주일 창과 추이 그래프 보기 (Ctrl+5)</span>}
        {!w && <span className="opacity-80">눌러서 자세히 보기 (Ctrl+5)</span>}
      </TooltipContent>
    </Tooltip>
  );
}
