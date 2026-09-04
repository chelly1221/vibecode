// Scrollable transcript with stick-to-bottom behaviour.

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PermissionDecision } from "@/lib/bindings/PermissionDecision";
import type { QuestionAnswer } from "@/lib/ipc";
import type { SessionState } from "@/stores/sessions";
import { cn } from "@/lib/utils";
import { itemSpacing, MessageItem } from "./MessageItem";

const BOTTOM_THRESHOLD = 48;

export function MessageList({
  session,
  onPermission,
  onAnswer,
}: {
  session: SessionState;
  onPermission: (requestId: string, decision: PermissionDecision, message?: string) => void;
  onAnswer?: (requestId: string, answers: QuestionAnswer[]) => void | Promise<void>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const { items, running, statusMessage, subagents } = session;
  const lastItem = items[items.length - 1];

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    setUnseen(false);
  }, []);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
    setAtBottom(near);
    if (near) setUnseen(false);
  }, []);

  useEffect(() => {
    if (atBottom) {
      const el = ref.current;
      if (el) el.scrollTop = el.scrollHeight;
    } else {
      setUnseen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, statusMessage, subagents]);

  // New session selected: jump to bottom.
  useEffect(() => {
    scrollToBottom();
    setAtBottom(true);
  }, [session.record.id, scrollToBottom]);

  const showWorking = running && !(lastItem && lastItem.type === "assistant" && lastItem.streaming);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} onScroll={onScroll} className="h-full overflow-y-auto px-4 py-3">
        <div className="mx-auto w-full max-w-3xl">
          {items.length === 0 && !running && (
            <div className="py-10 text-center text-sm text-muted-foreground">메시지를 입력해 작업을 시작하세요.</div>
          )}
          {items.map((item, i) => (
            <div key={item.id} className={itemSpacing(item)}>
              <MessageItem item={item} isLast={i === items.length - 1} running={running} onPermission={onPermission} onAnswer={onAnswer} subagents={subagents} />
            </div>
          ))}
          {showWorking && (
            <div className="my-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" />
              {statusMessage ?? "작업 중…"}
            </div>
          )}
          {!showWorking && statusMessage && running && <div className="my-1 text-xs text-muted-foreground">{statusMessage}</div>}
        </div>
      </div>
      {!atBottom && (
        <Button
          size="sm"
          variant="secondary"
          onClick={scrollToBottom}
          className={cn("absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md", unseen && "ring-2 ring-primary/40")}
        >
          <ArrowDownIcon data-icon="inline-start" />
          {unseen ? "새 메시지" : "맨 아래로"}
        </Button>
      )}
    </div>
  );
}
