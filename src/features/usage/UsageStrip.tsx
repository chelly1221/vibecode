// Always-visible vertical bars on the left edge of the window: remaining subscription usage per
// rate-limit window (5h / 7d) of the account in use. Fills from the bottom like a battery, colored
// by how much is left; clicking opens the detailed panel with the time-series graph.
import { useEffect, useMemo, useState } from "react";
import { GaugeIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ipc, type AccountProfile, type Provider } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app";
import { orderedWindows, useUsageStore, usageKey, type AccountUsage } from "@/stores/usage";
import { PROVIDER_LABEL } from "@/features/chat/labels";
import { remainingPercent, reportAge, resetCountdown, usageLevel } from "./format";

const LEVEL_FILL: Record<ReturnType<typeof usageLevel>, string> = {
  ok: "bg-gradient-to-t from-emerald-600 to-emerald-400",
  warn: "bg-gradient-to-t from-amber-600 to-amber-400",
  critical: "bg-gradient-to-t from-red-700 to-red-500",
};

/** Short bar caption: "5시간" → "5h", "1주일" → "7d", otherwise the label itself. */
export function shortWindowLabel(label: string, minutes: number | null): string {
  if (minutes === 300 || label === "5시간") return "5h";
  if (minutes === 10_080 || label === "1주일") return "7d";
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;
  return label.slice(0, 3);
}

function Bar({ caption, used, resetsAt, nowSecs, title }: { caption: string; used: number | null; resetsAt: number | null; nowSecs: number; title: string }) {
  const remaining = used === null ? null : remainingPercent(used);
  const level = used === null ? "ok" : usageLevel(used);
  const countdown = resetCountdown(resetsAt, nowSecs);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining ?? undefined}>
          <span className={cn("text-[10px] font-semibold tabular-nums leading-none", remaining === null ? "text-muted-foreground/50" : "text-foreground")}>
            {remaining === null ? "—" : `${Math.round(remaining)}`}
          </span>
          <div className="relative min-h-10 w-4 flex-1 overflow-hidden rounded-full border border-border/60 bg-muted/60">
            <div className={cn("absolute inset-x-0 bottom-0 rounded-full transition-[height] duration-700 ease-out", LEVEL_FILL[level])} style={{ height: `${remaining ?? 0}%` }} />
            {remaining !== null && remaining < 100 && <div className="absolute inset-x-0 bottom-0 h-px bg-white/10" style={{ bottom: `${remaining}%` }} />}
          </div>
          <span className="text-[10px] leading-none text-muted-foreground">{caption}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" className="flex-col items-start gap-0.5">
        <span className="font-medium">{title}</span>
        <span>{remaining === null ? "아직 보고된 사용량이 없어요" : `남은 사용량 ${Math.round(remaining)}%`}</span>
        {countdown && <span className="opacity-80">{countdown}</span>}
      </TooltipContent>
    </Tooltip>
  );
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

  // The account in use first; other accounts with data after it.
  const groups = useMemo(() => {
    const out: Array<{ key: string; acc: AccountUsage; name: string; focus: boolean }> = [];
    const nameOf = (acc: AccountUsage) => profiles.find((p) => p.id === acc.accountId)?.name ?? PROVIDER_LABEL[acc.provider];
    if (focus) {
      const key = usageKey(focus.provider, focus.accountId);
      const acc = accounts[key] ?? { provider: focus.provider, accountId: focus.accountId, windows: {}, historyHours: null };
      out.push({ key, acc, name: nameOf(acc), focus: true });
    }
    for (const [key, acc] of Object.entries(accounts)) {
      if (out.some((g) => g.key === key) || Object.keys(acc.windows).length === 0) continue;
      out.push({ key, acc, name: nameOf(acc), focus: false });
    }
    return out.slice(0, 3);
  }, [accounts, focus, profiles]);

  return (
    <aside aria-label="남은 사용량 막대" className="flex h-full w-14 shrink-0 flex-col items-stretch border-r bg-sidebar text-sidebar-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-pressed={panelOpen}
            aria-label="사용량 자세히 보기"
            onClick={() => setPanelOpen(!panelOpen)}
            className={cn("flex h-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground", panelOpen && "text-primary")}
          >
            <GaugeIcon className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">남은 사용량 · 눌러서 추이 그래프 보기 (Ctrl+5)</TooltipContent>
      </Tooltip>
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-1 pt-1 pb-2">
        {groups.length === 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex flex-1 items-end justify-center gap-1.5">
                <Bar caption="5h" used={null} resetsAt={null} nowSecs={nowSecs} title="5시간 창" />
                <Bar caption="7d" used={null} resetsAt={null} nowSecs={nowSecs} title="1주일 창" />
              </div>
            </TooltipTrigger>
            <TooltipContent side="right">AI가 작업하면 남은 사용량이 채워집니다</TooltipContent>
          </Tooltip>
        )}
        {groups.map((g) => {
          const windows = orderedWindows(g.acc);
          const latest = windows.reduce((m, w) => Math.max(m, w.observedAt), 0);
          const fallback = windows.length === 0 ? [{ caption: "5h", title: "5시간 창" }, { caption: "7d", title: "1주일 창" }] : null;
          return (
            <button
              key={g.key}
              type="button"
              onClick={() => setPanelOpen(true)}
              title={`${PROVIDER_LABEL[g.acc.provider]} · ${g.name}${latest ? ` · ${reportAge(latest, nowSecs)} 갱신` : ""}`}
              className={cn("flex min-h-0 flex-1 flex-col items-stretch rounded-lg px-0.5 pt-1 pb-1.5 transition-colors hover:bg-sidebar-accent/60", g.focus && groups.length > 1 && "ring-1 ring-inset ring-primary/25")}
            >
              <div className="flex min-h-0 flex-1 items-stretch justify-center gap-1.5">
                {fallback
                  ? fallback.map((f) => <Bar key={f.caption} caption={f.caption} used={null} resetsAt={null} nowSecs={nowSecs} title={`${g.name} · ${f.title}`} />)
                  : windows.map((w) => (
                      <Bar
                        key={w.window.id}
                        caption={shortWindowLabel(w.window.label, w.window.window_minutes ?? null)}
                        used={w.window.used_percent}
                        resetsAt={w.window.resets_at ?? null}
                        nowSecs={nowSecs}
                        title={`${g.name} · ${w.window.label} 창`}
                      />
                    ))}
              </div>
              <span className={cn("mt-1 truncate text-center text-[9px] leading-none", g.acc.provider === "claude" ? "text-orange-300/80" : "text-emerald-300/80")}>{PROVIDER_LABEL[g.acc.provider]}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
