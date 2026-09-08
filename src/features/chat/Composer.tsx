// Message input: Enter sends, Shift+Enter newline, IME-safe, OS drag & drop inserts paths.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useAppStore } from "@/stores/app";
import { isOverElement, PROJECT_DROP_ZONE } from "@/lib/dropZones";
import { Loader2Icon, SendHorizonalIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const drafts = new Map<string, string>();

export interface ComposerProps {
  draftKey: string;
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

export function Composer({ draftKey, disabled, running, starting, live, onSend, onInterrupt }: ComposerProps) {
  const [text, setText] = useState(() => drafts.get(draftKey) ?? "");
  const sendLock = useRef(false);
  useEffect(() => {
    if (text) drafts.set(draftKey, text);
    else drafts.delete(draftKey);
  }, [draftKey, text]);
  const composerInsert = useAppStore((s) => s.composerInsert);
  // Text handed over by the UI preview (element picker / console) is appended and focused.
  useEffect(() => {
    if (!composerInsert || useAppStore.getState().composerInsert !== composerInsert) return;
    useAppStore.setState({ composerInsert: null });
    setText((t) => (t.trim() ? `${t.trimEnd()}\n\n${composerInsert.text}` : composerInsert.text));
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
      }
    });
  }, [composerInsert]);
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
            // Folders dropped on the project sidebar are registered as projects, not inserted here.
            if (isOverElement(p.position, document.querySelector(PROJECT_DROP_ZONE))) return;
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
    if (!value || disabled || sendLock.current || starting) return;
    sendLock.current = true;
    setSending(true);
    try {
      await onSend(value);
      if (drafts.get(draftKey) === text) drafts.delete(draftKey);
      setText((current) => current === text ? "" : current);
    } catch {
      // ChatView reports the error; keep the draft for retry.
    } finally {
      sendLock.current = false;
      setSending(false);
      requestAnimationFrame(() => ref.current?.focus());
    }
  }, [text, draftKey, disabled, starting, onSend]);

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
    ? "AI와 연결하고 있어요…"
    : !live
      ? "원하는 작업을 적어 주세요. AI가 이어서 도와드릴게요"
      : running
        ? "작업 중… 메시지를 추가로 보낼 수 있습니다"
        : "예: 첫 화면을 더 밝게 바꾸고 예약 버튼을 추가해 줘";

  return (
    <div className={cn("border-t bg-background p-3", dragging && "bg-primary/5")}>
      <div className={cn("mx-auto flex w-full max-w-3xl items-end gap-2 rounded-xl border bg-card p-2 focus-within:border-ring", dragging && "border-dashed border-primary")}>
        <Textarea
          aria-label="AI에게 보낼 메시지"
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="field-sizing-fixed max-h-60 min-h-9 flex-1 resize-none border-0 bg-transparent px-1.5 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        {running && (
          <Button type="button" variant="outline" size="sm" onClick={onInterrupt} title="현재 작업 멈추기">
            <SquareIcon data-icon="inline-start" /> 멈추기
          </Button>
        )}
        <Button type="button" size="sm" onClick={() => void submit()} disabled={disabled || sending || starting || !text.trim()}>
          {sending || starting ? <Loader2Icon className="animate-spin" data-icon="inline-start" /> : <SendHorizonalIcon data-icon="inline-start" />}
          {running ? "추가 요청" : "보내기"}
        </Button>
      </div>
      <p className="mx-auto mt-2 max-w-3xl text-xs text-muted-foreground">Enter로 보내기 · Shift+Enter로 줄바꿈 · 파일을 끌어다 놓아 참고 자료 추가</p>
      {dragging && <div className="mx-auto mt-1 w-full max-w-3xl text-center text-xs text-primary">파일을 놓으면 경로가 입력됩니다</div>}
    </div>
  );
}
