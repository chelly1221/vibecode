// Message input: Enter sends, Shift+Enter newline, IME-safe, OS drag & drop inserts paths.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Loader2Icon, SendHorizonalIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export interface ComposerProps {
  disabled?: boolean;
  running: boolean;
  starting: boolean;
  live: boolean;
  onSend: (text: string) => void | Promise<void>;
  onInterrupt: () => void;
}

const MAX_HEIGHT = 240;

function quotePath(p: string): string {
  return /[\s"']/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function Composer({ disabled, running, starting, live, onSend, onInterrupt }: ComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState(false);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [text, resize]);

  const insertPaths = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    const chunk = paths.map(quotePath).join(" ");
    setText((t) => (t && !/\s$/.test(t) ? `${t} ${chunk} ` : `${t}${chunk} `));
    ref.current?.focus();
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") setDragging(true);
          else if (p.type === "leave") setDragging(false);
          else if (p.type === "drop") {
            setDragging(false);
            insertPaths(p.paths);
          }
        }),
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [insertPaths]);

  const submit = useCallback(async () => {
    const value = text.trim();
    if (!value || disabled || sending || starting) return;
    setSending(true);
    try {
      await onSend(value);
      setText("");
    } finally {
      setSending(false);
      requestAnimationFrame(() => ref.current?.focus());
    }
  }, [text, disabled, sending, starting, onSend]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        if (e.nativeEvent.isComposing || (e.nativeEvent as { keyCode?: number }).keyCode === 229) return;
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  const placeholder = starting
    ? "세션을 시작하는 중…"
    : !live
      ? "메시지를 보내면 세션을 이어서 진행합니다"
      : running
        ? "작업 중… 메시지를 추가로 보낼 수 있습니다"
        : "메시지를 입력하세요 (Enter 전송, Shift+Enter 줄바꿈)";

  return (
    <div className={cn("border-t bg-background p-3", dragging && "bg-primary/5")}>
      <div className={cn("mx-auto flex w-full max-w-3xl items-end gap-2 rounded-xl border bg-card p-2 focus-within:border-ring", dragging && "border-dashed border-primary")}>
        <Textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="field-sizing-fixed max-h-60 min-h-9 flex-1 resize-none border-0 bg-transparent px-1.5 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        {running ? (
          <Button type="button" variant="destructive" size="sm" onClick={onInterrupt} title="현재 작업 중단">
            <SquareIcon data-icon="inline-start" />
            중단
          </Button>
        ) : (
          <Button type="button" size="sm" onClick={() => void submit()} disabled={disabled || sending || starting || !text.trim()}>
            {sending || starting ? <Loader2Icon className="animate-spin" data-icon="inline-start" /> : <SendHorizonalIcon data-icon="inline-start" />}
            전송
          </Button>
        )}
      </div>
      {dragging && <div className="mx-auto mt-1 w-full max-w-3xl text-center text-xs text-primary">파일을 놓으면 경로가 입력됩니다</div>}
    </div>
  );
}
