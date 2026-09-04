// Inline / banner card for a permission request coming from the agent.

import { useState } from "react";
import { CheckIcon, ShieldAlertIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PermissionDecision } from "@/lib/bindings/PermissionDecision";
import type { PermissionKind } from "@/lib/bindings/PermissionKind";
import { cn } from "@/lib/utils";
import { DiffView } from "./DiffView";
import { DECISION_LABEL, PERMISSION_KIND_LABEL } from "./labels";
import { OutputBlock } from "./ToolCard";

export interface PermissionCardProps {
  requestId: string;
  kind: PermissionKind;
  title: string;
  detail: unknown;
  decision?: PermissionDecision;
  compact?: boolean;
  disabled?: boolean;
  onReply?: (decision: PermissionDecision, message?: string) => void;
  className?: string;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function DetailView({ kind, detail }: { kind: PermissionKind; detail: unknown }) {
  if (detail == null || detail === "") return null;
  if (typeof detail === "string") return <OutputBlock text={detail} />;
  const d = rec(detail);
  // Claude passes {tool_name, input}; Codex passes {command, cwd, reason} / {changes, grantRoot}.
  const input = rec(d.input);
  const src = Object.keys(input).length ? input : d;
  const command = [src.command, src.cmd].find((v) => typeof v === "string" || Array.isArray(v));
  if (kind === "command" || command !== undefined) {
    const text = Array.isArray(command) ? (command as unknown[]).map(String).join(" ") : String(command ?? "");
    const reason = typeof d.reason === "string" ? d.reason : typeof src.description === "string" ? src.description : null;
    return (
      <div className="space-y-1.5">
        {reason && <div className="text-xs text-muted-foreground">{reason}</div>}
        {text && (
          <pre className="overflow-x-auto rounded-lg bg-zinc-950 p-2.5 font-mono text-[0.75rem] text-zinc-100 whitespace-pre-wrap break-all dark:bg-zinc-900">
            <span className="select-none text-zinc-500">$ </span>
            {text}
          </pre>
        )}
        {typeof src.cwd === "string" && <div className="font-mono text-[11px] text-muted-foreground">cwd: {src.cwd}</div>}
      </div>
    );
  }
  const path = [src.file_path, src.path, src.filePath].find((v) => typeof v === "string") as string | undefined;
  if (typeof src.old_string === "string" || typeof src.new_string === "string") {
    return <DiffView path={path} oldText={String(src.old_string ?? "")} newText={String(src.new_string ?? "")} />;
  }
  if (typeof src.content === "string") return <DiffView path={path} oldText="" newText={src.content} />;
  if (Array.isArray(src.changes)) {
    return (
      <div className="space-y-2">
        {src.changes.map((ch, i) => {
          const c = rec(ch);
          const p = [c.path, c.file_path].find((v) => typeof v === "string") as string | undefined;
          if (typeof c.diff === "string") return <DiffView key={i} path={p} unified={c.diff} />;
          return <DiffView key={i} path={p} oldText={String(c.old ?? "")} newText={String(c.new ?? c.content ?? "")} />;
        })}
      </div>
    );
  }
  if (typeof src.diff === "string") return <DiffView path={path} unified={src.diff} />;
  return <OutputBlock text={JSON.stringify(detail, null, 2)} />;
}

export function PermissionCard({ kind, title, detail, decision, compact, disabled, onReply, className }: PermissionCardProps) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const pending = !decision;

  return (
    <div
      className={cn(
        "rounded-lg border bg-card text-sm",
        pending ? "border-amber-500/50 bg-amber-500/5" : "border-border",
        className,
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        {pending ? <ShieldAlertIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" /> : <ShieldCheckIcon className="size-4 shrink-0 text-muted-foreground" />}
        <Badge variant="outline" className="shrink-0">
          {PERMISSION_KIND_LABEL[kind]}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-medium" title={title}>
          {title}
        </span>
        {decision && (
          <Badge variant={decision === "deny" ? "destructive" : "secondary"} className="shrink-0">
            {DECISION_LABEL[decision]}
          </Badge>
        )}
      </div>
      {!compact && (
        <div className="border-t px-3 py-2">
          <DetailView kind={kind} detail={detail} />
        </div>
      )}
      {pending && onReply && (
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
          <Button size="sm" disabled={disabled} onClick={() => onReply("allow")}>
            <CheckIcon data-icon="inline-start" />
            허용
          </Button>
          <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onReply("allow_session")}>
            세션 동안 허용
          </Button>
          {denying ? (
            <form
              className="flex min-w-0 flex-1 items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                onReply("deny", reason.trim() || undefined);
              }}
            >
              <Input
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="거부 이유 (선택)"
                className="h-7 min-w-32 flex-1 text-xs"
                disabled={disabled}
              />
              <Button size="sm" variant="destructive" type="submit" disabled={disabled}>
                <XIcon data-icon="inline-start" />
                거부
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setDenying(false)}>
                취소
              </Button>
            </form>
          ) : (
            <Button size="sm" variant="destructive" disabled={disabled} onClick={() => setDenying(true)}>
              <XIcon data-icon="inline-start" />
              거부
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
