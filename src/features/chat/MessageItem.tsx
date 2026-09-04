import { memo } from "react";
import type { PermissionDecision } from "@/lib/bindings/PermissionDecision";
import { Markdown } from "@/lib/markdown";
import type { ChatItem } from "@/stores/sessions";
import { cn } from "@/lib/utils";
import { PermissionCard } from "./PermissionCard";
import { PlanCard } from "./PlanCard";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCard } from "./ToolCard";
import { TurnDivider } from "./TurnDivider";

export interface MessageItemProps {
  item: ChatItem;
  /** True while the session is running and this is the last item (for live indicators). */
  isLast: boolean;
  running: boolean;
  onPermission: (requestId: string, decision: PermissionDecision, message?: string) => void;
}

export const MessageItem = memo(function MessageItem({ item, isLast, running, onPermission }: MessageItemProps) {
  switch (item.type) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary/10 px-3.5 py-2 text-sm whitespace-pre-wrap break-words">{item.text}</div>
        </div>
      );
    case "assistant":
      return (
        <div className="max-w-full">
          <Markdown text={item.text} />
          {item.streaming && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-foreground/60 align-text-bottom" />}
        </div>
      );
    case "thinking":
      return <ThinkingBlock text={item.text} active={isLast && running} />;
    case "tool":
      return <ToolCard item={item} />;
    case "permission":
      return (
        <PermissionCard
          requestId={item.request_id}
          kind={item.kind}
          title={item.title}
          detail={item.detail}
          decision={item.decision}
          onReply={(d, m) => onPermission(item.request_id, d, m)}
        />
      );
    case "plan":
      return <PlanCard steps={item.steps} />;
    case "system":
      return <TurnDivider item={item} />;
    default:
      return null;
  }
});

export function itemSpacing(item: ChatItem): string {
  return cn(item.type === "system" ? "my-0" : "my-2");
}
