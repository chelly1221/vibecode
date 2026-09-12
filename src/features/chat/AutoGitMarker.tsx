// One-line note in the transcript for the automatic commit/push that ran after a turn.
import { GitCommitHorizontalIcon, TriangleAlertIcon } from "lucide-react";
import type { ChatItem } from "@/stores/sessions";
import { cn } from "@/lib/utils";

type AutoGitItem = Extract<ChatItem, { type: "auto_git" }>;

export function AutoGitMarker({ item }: { item: AutoGitItem }) {
  return (
    <div className={cn("my-1 flex items-center justify-center gap-1.5 text-[11px]", item.ok ? "text-muted-foreground/80" : "text-destructive")} role="note">
      {item.ok ? <GitCommitHorizontalIcon className="size-3.5 shrink-0" /> : <TriangleAlertIcon className="size-3.5 shrink-0" />}
      <span className="min-w-0 truncate" title={item.message}>{item.message}</span>
      {item.commit && <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px]">{item.commit}</span>}
    </div>
  );
}
