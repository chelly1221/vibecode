import { AlertTriangleIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { ChatItem } from "@/stores/sessions";
import { formatDuration, formatTokens } from "./labels";

type SystemItem = Extract<ChatItem, { type: "system" }>;

export function TurnDivider({ item }: { item: SystemItem }) {
  if (item.variant === "error") {
    return (
      <Alert variant="destructive" className="my-1">
        <AlertTriangleIcon />
        <AlertTitle>오류</AlertTitle>
        <AlertDescription className="break-words whitespace-pre-wrap">{item.text}</AlertDescription>
      </Alert>
    );
  }
  if (item.variant === "turn_end" && item.meta) {
    const m = item.meta;
    const parts = [formatDuration(m.duration_ms)];
    if (m.usage.input_tokens || m.usage.output_tokens) parts.push(`↑${formatTokens(m.usage.input_tokens)} ↓${formatTokens(m.usage.output_tokens)}`);
    if (m.stop_reason && m.stop_reason !== "end_turn") parts.push(m.stop_reason);
    return (
      <div className="my-2 flex items-center gap-3 text-[11px] text-muted-foreground/70">
        <div className="h-px flex-1 bg-border" />
        <span>{parts.join(" · ")}</span>
        <div className="h-px flex-1 bg-border" />
      </div>
    );
  }
  return <div className="my-1 text-center text-[11px] text-muted-foreground/70">{item.text}</div>;
}
