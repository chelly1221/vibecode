// Transcript of one subagent (text, thinking, tools, status) — used inside the Agent tool card
// and in the subagents drawer. Nested subagents render recursively through ToolCard.

import { BotIcon, Loader2Icon } from "lucide-react";
import { Markdown } from "@/lib/markdown";
import type { SubagentState } from "@/stores/sessions";
import { cn } from "@/lib/utils";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCard } from "./ToolCard";

export function SubagentPanel({
  sub,
  subagents,
  className,
  compact,
}: {
  sub: SubagentState;
  subagents: Record<string, SubagentState>;
  className?: string;
  /** Smaller type and tighter spacing (inside tool cards). */
  compact?: boolean;
}) {
  const last = sub.items[sub.items.length - 1];
  return (
    <div className={cn("space-y-2", compact ? "text-[0.8rem]" : "text-sm", className)}>
      {sub.items.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" /> 시작하는 중…
        </div>
      )}
      {sub.items.map((it, i) => {
        const isLast = i === sub.items.length - 1;
        switch (it.type) {
          case "text":
            return it.role === "user" ? (
              <div key={it.id} className="rounded-md bg-primary/5 px-2.5 py-1.5 text-xs whitespace-pre-wrap text-muted-foreground">
                {it.text}
              </div>
            ) : (
              <div key={it.id}>
                <Markdown text={it.text} />
                {it.streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-foreground/60 align-text-bottom" />}
              </div>
            );
          case "thinking":
            return <ThinkingBlock key={it.id} text={it.text} active={isLast && sub.running} />;
          case "tool":
            return <ToolCard key={it.id} item={it} subagents={subagents} />;
          case "status":
            return (
              <div key={it.id} className="text-xs text-muted-foreground">
                {it.text}
              </div>
            );
          default:
            return null;
        }
      })}
      {sub.running && last && last.type !== "text" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" /> {sub.lastActivity || "작업 중…"}
        </div>
      )}
    </div>
  );
}

/** Small status line used in list views. */
export function SubagentStatus({ sub }: { sub: SubagentState }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {sub.running ? <Loader2Icon className="size-3 animate-spin" /> : <BotIcon className="size-3" />}
      {sub.running ? "작동 중" : "완료"}
      {sub.items.length > 0 && <span>· {sub.items.length}개 항목</span>}
    </span>
  );
}
