// Top bar of a session: provider, title, model / effort / permission controls, usage and actions.

import { useMemo } from "react";
import { Loader2Icon, PowerIcon, SquareIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useModels } from "@/hooks/useModels";
import type { Effort } from "@/lib/bindings/Effort";
import type { PermissionPreset } from "@/lib/bindings/PermissionPreset";
import { useSessionsStore, type SessionState } from "@/stores/sessions";
import { cn } from "@/lib/utils";
import {
  DEFAULT_OPTION,
  EFFORTS,
  EFFORT_LABEL,
  PERMISSION_HINT,
  PERMISSION_LABEL,
  PERMISSION_PRESETS,
  PROVIDER_LABEL,
  formatCost,
  formatTokens,
} from "./labels";

export function ProviderBadge({ provider, className }: { provider: "claude" | "codex"; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        provider === "claude"
          ? "border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-300"
          : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        className,
      )}
    >
      {PROVIDER_LABEL[provider]}
    </Badge>
  );
}

export function SessionHeader({ session }: { session: SessionState }) {
  const updateConfig = useSessionsStore((s) => s.updateConfig);
  const interrupt = useSessionsStore((s) => s.interrupt);
  const closeSession = useSessionsStore((s) => s.closeSession);
  const { models, loading } = useModels(session.record.provider);
  const id = session.record.id;

  const modelOptions = useMemo(() => {
    const list = models.slice();
    if (session.model && !list.some((m) => m.id === session.model)) {
      list.push({ provider: session.record.provider, id: session.model, label: session.model, efforts: [], is_default: false });
    }
    return list;
  }, [models, session.model, session.record.provider]);

  const selectedModel = modelOptions.find((m) => m.id === session.model) ?? models.find((m) => m.is_default);
  const efforts = selectedModel && selectedModel.efforts.length ? EFFORTS.filter((e) => selectedModel.efforts.includes(e)) : EFFORTS;

  const run = (p: Promise<unknown>, label: string) =>
    p.catch((e) => toast.error(`${label} 실패`, { description: String(e) }));

  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-background px-3 py-2 text-sm">
      <ProviderBadge provider={session.record.provider} />
      <span
        className={cn("size-2 rounded-full", session.live ? (session.running ? "animate-pulse bg-emerald-500" : "bg-emerald-500") : "bg-muted-foreground/40")}
        title={session.live ? (session.running ? "작업 중" : "연결됨") : "연결 안 됨"}
      />
      <span className="min-w-0 max-w-[28ch] truncate font-medium" title={session.record.title}>
        {session.record.title}
      </span>
      {session.starting && <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />}

      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <Select
          value={session.model ?? DEFAULT_OPTION}
          onValueChange={(v) => run(updateConfig(id, { model: v === DEFAULT_OPTION ? null : v }), "모델 변경")}
        >
          <SelectTrigger size="sm" className="max-w-56" title="모델">
            <SelectValue placeholder={loading ? "불러오는 중…" : "모델"} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_OPTION}>기본값</SelectItem>
            {modelOptions.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label}
                {m.is_default && <span className="ml-1 text-muted-foreground">(기본)</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={session.effort ?? DEFAULT_OPTION}
          onValueChange={(v) => run(updateConfig(id, { effort: v === DEFAULT_OPTION ? null : (v as Effort) }), "Effort 변경")}
        >
          <SelectTrigger size="sm" title="Effort">
            <SelectValue placeholder="Effort" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_OPTION}>Effort 기본값</SelectItem>
            {efforts.map((e) => (
              <SelectItem key={e} value={e}>
                {EFFORT_LABEL[e]} <span className="text-muted-foreground">({e})</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <Select value={session.permission} onValueChange={(v) => run(updateConfig(id, { permission: v as PermissionPreset }), "권한 변경")}>
                <SelectTrigger size="sm" className={cn(session.permission === "full_auto" && "border-destructive/60 text-destructive")} title="권한">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERMISSION_PRESETS.map((p) => (
                    <SelectItem key={p} value={p} className={cn(p === "full_auto" && "text-destructive")}>
                      {PERMISSION_LABEL[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </TooltipTrigger>
          <TooltipContent>{PERMISSION_HINT[session.permission]}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="hidden rounded-md bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground lg:inline">
              {formatCost(session.cost)} · ↑{formatTokens(session.usage.input_tokens)} ↓{formatTokens(session.usage.output_tokens)}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            비용 {formatCost(session.cost)} · 입력 {session.usage.input_tokens.toLocaleString()} · 출력 {session.usage.output_tokens.toLocaleString()} · 캐시 읽기{" "}
            {session.usage.cache_read_tokens.toLocaleString()}
          </TooltipContent>
        </Tooltip>

        {session.running && (
          <Button size="sm" variant="destructive" onClick={() => run(interrupt(id), "중단")}>
            <SquareIcon data-icon="inline-start" />
            중단
          </Button>
        )}
        {session.live && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="ghost" onClick={() => run(closeSession(id), "세션 종료")} aria-label="세션 프로세스 종료">
                <PowerIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>에이전트 프로세스 종료 (대화는 유지됨)</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
