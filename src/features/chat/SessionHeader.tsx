import { ipc, type ProjectAccounts } from "@/lib/ipc";
// Top bar of a session: provider, title, model / effort / permission controls, usage and actions.

import { useEffect, useMemo, useState } from "react";
import { BotIcon, Loader2Icon, PowerIcon, SquareIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useModels } from "@/hooks/useModels";
import type { Effort } from "@/lib/bindings/Effort";
import type { PermissionPreset } from "@/lib/bindings/PermissionPreset";
import { runningSubagents, useSessionsStore, type SessionState } from "@/stores/sessions";
import { CheckpointsPopover } from "./CheckpointsPopover";
import { cn } from "@/lib/utils";
import {
  DEFAULT_OPTION,
  EFFORTS,
  EFFORT_LABEL,
  PERMISSION_HINT,
  PERMISSION_LABEL,
  PERMISSION_PRESETS,
  PROVIDER_LABEL,
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

export function SessionHeader({
  session,
  subagentsOpen,
  onToggleSubagents,
}: {
  session: SessionState;
  subagentsOpen?: boolean;
  onToggleSubagents?: () => void;
}) {
  const updateConfig = useSessionsStore((s) => s.updateConfig);
  const subagentCount = Object.keys(session.subagents).length;
  const subagentRunning = runningSubagents(session.subagents);
  const interrupt = useSessionsStore((s) => s.interrupt);
  const closeSession = useSessionsStore((s) => s.closeSession);
  const [accounts, setAccounts] = useState<ProjectAccounts | null>(null);
  const [accountName, setAccountName] = useState<string>("");
  useEffect(() => {
    let cancelled = false; setAccounts(null); setAccountName("");
    Promise.all([ipc.accounts.session(session.record.id), ipc.accounts.list()]).then(([a, profiles]) => {
      if (cancelled) return; setAccounts(a);
      setAccountName(profiles.find((p) => p.id === a[session.record.provider])?.name ?? "계정 선택 필요");
    }).catch(() => { if (!cancelled) setAccountName("계정 확인 실패"); });
    return () => { cancelled = true; };
  }, [session.record.id, session.record.provider]);
  const { models, loading } = useModels(session.record.provider, accounts?.[session.record.provider]);
  const id = session.record.id;
  const modelId = session.model ?? session.resolvedModel ?? models.find((m) => m.is_default)?.id;

  const modelOptions = useMemo(() => {
    const list = models.slice();
    if (modelId && !list.some((m) => m.id === modelId)) {
      list.push({ provider: session.record.provider, id: modelId, label: modelId, efforts: [], is_default: false });
    }
    return list;
  }, [models, modelId, session.record.provider]);

  const selectedModel = modelOptions.find((m) => m.id === modelId);
  const efforts = selectedModel && selectedModel.efforts.length ? EFFORTS.filter((e) => selectedModel.efforts.includes(e)) : EFFORTS;

  const run = (p: Promise<unknown>, label: string) =>
    p.catch((e) => toast.error(`${label} 실패`, { description: String(e) }));

  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-background px-3 py-2 text-sm">
      <ProviderBadge provider={session.record.provider} />
      <span className="max-w-40 truncate text-xs text-muted-foreground" title={`이 대화의 계정: ${accountName}`}>{accountName}</span>
      <span
        className={cn("size-2 rounded-full", session.live ? (session.running ? "animate-pulse bg-emerald-500" : "bg-emerald-500") : "bg-muted-foreground/40")}
        title={session.live ? (session.running ? "작업 중" : "연결됨") : "연결 안 됨"}
      />
      <span className="min-w-0 max-w-[28ch] truncate font-medium" title={session.record.title}>
        {session.record.title}
      </span>
      {session.starting && <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />}

      <span className="text-xs text-muted-foreground" role="status">{session.starting ? "연결 중" : session.pendingPermissions.length || session.pendingQuestions.length ? "답변을 기다리고 있어요" : session.running ? "AI가 작업하고 있어요" : "요청을 입력해 주세요"}</span>
      <div className="flex w-full flex-wrap items-center gap-1.5">
        <Select
          value={modelId ?? ""}
          onValueChange={(v) => run(updateConfig(id, { model: v }), "모델 변경")}
        >
          <SelectTrigger size="sm" className="max-w-56" title="모델" aria-label="모델">
            <SelectValue placeholder={loading ? "불러오는 중…" : "모델"} />
          </SelectTrigger>
          <SelectContent position="popper" side="bottom" align="start">
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
          onValueChange={(v) => run(updateConfig(id, { effort: v === DEFAULT_OPTION ? null : (v as Effort) }), "생각하는 깊이 변경")}
        >
          <SelectTrigger size="sm" title="생각하는 깊이" aria-label="생각하는 깊이">
            <SelectValue placeholder="생각하는 깊이" />
          </SelectTrigger>
          <SelectContent position="popper" side="bottom" align="start" avoidCollisions={false}>
            <SelectItem value={DEFAULT_OPTION}>생각하는 깊이: 기본값</SelectItem>
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
                <SelectTrigger size="sm" className={cn(session.permission === "full_auto" && "border-destructive/60 text-destructive")} title="권한" aria-label="권한">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" side="bottom" align="start">
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
            <span className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
              ↑{formatTokens(session.usage.input_tokens)} ↓{formatTokens(session.usage.output_tokens)}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            토큰 · 입력 {session.usage.input_tokens.toLocaleString()} · 출력 {session.usage.output_tokens.toLocaleString()} · 캐시 읽기{" "}
            {session.usage.cache_read_tokens.toLocaleString()}
          </TooltipContent>
        </Tooltip>

        {subagentCount > 0 && onToggleSubagents && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant={subagentsOpen ? "secondary" : "ghost"} onClick={onToggleSubagents} aria-pressed={subagentsOpen}>
                <BotIcon data-icon="inline-start" />
                {subagentRunning > 0 ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                <Badge variant={subagentRunning > 0 ? "default" : "secondary"} className="px-1.5 py-0 text-[10px]">
                  {subagentRunning > 0 ? `${subagentRunning}/${subagentCount}` : subagentCount}
                </Badge>
              </Button>
            </TooltipTrigger>
            <TooltipContent>서브에이전트 작동창 {subagentRunning > 0 ? `(${subagentRunning}개 작동 중)` : ""}</TooltipContent>
          </Tooltip>
        )}
        <CheckpointsPopover key={id} projectId={session.record.project_id} sessionId={session.record.id} />

        {session.running && (
          <Button size="sm" variant="destructive" onClick={() => run(interrupt(id), "중단")}>
            <SquareIcon data-icon="inline-start" />
            중단
          </Button>
        )}
        {session.live && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="ghost" onClick={() => run(closeSession(id), "세션 종료")} aria-label="AI 연결 종료">
                <PowerIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>AI 연결 종료 (대화 기록은 유지됩니다)</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
