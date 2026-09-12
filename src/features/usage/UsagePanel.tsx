// Right-hand panel: remaining subscription usage per AI account, live values with reset
// countdowns and a time-series chart. Values come from the CLIs (Claude reports while a session
// works; Codex reports on its own and can be asked on demand).
import { useEffect, useMemo, useState } from "react";
import { GaugeIcon, Loader2Icon, RefreshCwIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ipc, type AccountProfile, type Provider } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app";
import { orderedWindows, useUsageStore, usageKey, type AccountUsage } from "@/stores/usage";
import { PROVIDER_LABEL } from "@/features/chat/labels";
import { remainingPercent, reportAge, resetClock, resetCountdown, seriesColor, usageLevel } from "./format";
import { UsageChart } from "./UsageChart";

const RANGES: Array<{ hours: number; label: string }> = [
  { hours: 1, label: "1시간" },
  { hours: 6, label: "6시간" },
  { hours: 24, label: "24시간" },
  { hours: 168, label: "7일" },
];

function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

const LEVEL_BAR: Record<ReturnType<typeof usageLevel>, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  critical: "bg-destructive",
};

export function WindowTile({ label, used, resetsAt, color, nowSecs, compact }: { label: string; used: number; resetsAt: number | null; color?: string; nowSecs: number; compact?: boolean }) {
  const remaining = remainingPercent(used);
  const level = usageLevel(used);
  const countdown = resetCountdown(resetsAt, nowSecs);
  const clock = resetClock(resetsAt);
  return (
    <div className={cn("rounded-lg border bg-card", compact ? "px-2 py-1.5" : "p-3")}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {color && <span className="inline-block size-2 rounded-sm" style={{ background: color }} />}
        {label}
      </div>
      <div className={cn("mt-1 flex items-baseline gap-1", compact ? "text-base" : "text-2xl")}>
        <span className="font-semibold tabular-nums">{Math.round(remaining)}%</span>
        <span className="text-xs text-muted-foreground">남음</span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={remaining} aria-valuemin={0} aria-valuemax={100} aria-label={`${label} 남은 사용량`}>
        <div className={cn("h-full rounded-full transition-all", LEVEL_BAR[level])} style={{ width: `${remaining}%` }} />
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        {countdown ?? "초기화 시각 미확인"}
        {clock && <span className="opacity-70"> · {clock}</span>}
      </div>
    </div>
  );
}

function AccountCard({ acc, name, nowSecs, rangeHours }: { acc: AccountUsage; name: string; nowSecs: number; rangeHours: number }) {
  const windows = orderedWindows(acc);
  const latest = windows.reduce((m, w) => Math.max(m, w.observedAt), 0);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useUsageStore((s) => s.refresh);
  const doRefresh = async () => {
    setRefreshing(true);
    try {
      await refresh(acc.provider, acc.accountId);
    } catch (e) {
      toast.error("사용량을 가져오지 못했어요", { description: String(e) });
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <section className="space-y-2 rounded-xl border p-3" aria-label={`${name} 사용량`}>
      <div className="flex items-center gap-2">
        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", acc.provider === "claude" ? "bg-orange-500/15 text-orange-300" : "bg-emerald-500/15 text-emerald-300")}>{PROVIDER_LABEL[acc.provider]}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={name}>{name}</span>
        {latest > 0 && <span className="text-[11px] text-muted-foreground">{reportAge(latest, nowSecs)}</span>}
        {acc.provider === "codex" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-xs" variant="ghost" onClick={() => void doRefresh()} disabled={refreshing} aria-label="지금 확인">
                {refreshing ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Codex에 지금 사용량 물어보기</TooltipContent>
          </Tooltip>
        )}
      </div>
      {windows.length === 0 ? (
        <p className="text-xs text-muted-foreground">아직 보고된 사용량이 없어요.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            {windows.map((w, i) => (
              <WindowTile key={w.window.id} label={w.window.label} used={w.window.used_percent} resetsAt={w.window.resets_at ?? null} color={seriesColor(i)} nowSecs={nowSecs} />
            ))}
          </div>
          <UsageChart windows={windows} rangeHours={rangeHours} nowSecs={nowSecs} />
        </>
      )}
    </section>
  );
}

/** Panel body (also reused by the header popover). */
export function UsagePanel() {
  const accounts = useUsageStore((s) => s.accounts);
  const loadLatest = useUsageStore((s) => s.loadLatest);
  const loadHistory = useUsageStore((s) => s.loadHistory);
  const setOpen = useAppStore((s) => s.setUsagePanelOpen);
  const [profiles, setProfiles] = useState<AccountProfile[]>([]);
  const [rangeHours, setRangeHours] = useState(6);
  const [error, setError] = useState<string | null>(null);
  const nowSecs = useNow();

  useEffect(() => {
    let cancelled = false;
    Promise.all([ipc.accounts.list(), loadLatest()])
      .then(([p]) => { if (!cancelled) { setProfiles(p); setError(null); } })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [loadLatest]);

  // Accounts to show: every AI profile (so the user sees which have data), plus any usage without a profile.
  const list = useMemo(() => {
    const out: Array<{ key: string; acc: AccountUsage; name: string }> = [];
    for (const p of profiles) {
      if (p.kind !== "claude" && p.kind !== "codex") continue;
      const provider = p.kind as Provider;
      const key = usageKey(provider, p.id);
      out.push({ key, acc: accounts[key] ?? { provider, accountId: p.id, windows: {}, historyHours: null }, name: p.name });
    }
    for (const [key, acc] of Object.entries(accounts)) {
      if (!out.some((o) => o.key === key)) out.push({ key, acc, name: acc.accountId ? "삭제된 계정" : "계정 미지정" });
    }
    return out;
  }, [profiles, accounts]);

  // Load stored history for the visible accounts whenever the range grows.
  useEffect(() => {
    for (const { acc } of list) {
      if (acc.historyHours !== null && acc.historyHours >= rangeHours) continue;
      loadHistory(acc.provider, acc.accountId, rangeHours).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeHours, list.length]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold"><GaugeIcon className="size-4" /> 남은 사용량</h2>
        <Button size="icon-sm" variant="ghost" aria-label="사용량 닫기" onClick={() => setOpen(false)}><XIcon /></Button>
      </div>
      <div className="flex items-center gap-1 border-b px-3 py-1.5 text-xs">
        <span className="mr-1 text-muted-foreground">기간</span>
        {RANGES.map((r) => (
          <Button key={r.hours} size="xs" variant={rangeHours === r.hours ? "secondary" : "ghost"} aria-pressed={rangeHours === r.hours} onClick={() => setRangeHours(r.hours)}>
            {r.label}
          </Button>
        ))}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-3">
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          {list.length === 0 && !error && (
            <p className="text-xs text-muted-foreground">등록된 AI 계정이 없어요. 설정 &gt; 계정에서 계정을 연결하면 사용량이 여기에 표시됩니다.</p>
          )}
          {list.map(({ key, acc, name }) => (
            <AccountCard key={key} acc={acc} name={name} nowSecs={nowSecs} rangeHours={rangeHours} />
          ))}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Claude는 AI가 작업하는 동안 매 응답마다 사용량을 알려 주고, Codex는 스스로 알려 주거나 위 버튼으로 바로 확인할 수 있어요. 5시간 창과 1주일 창이 각각 따로 초기화됩니다.
          </p>
        </div>
      </ScrollArea>
    </div>
  );
}
