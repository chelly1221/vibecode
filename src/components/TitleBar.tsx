// Custom window title bar (the native decorations are disabled in tauri.conf.json).
// Elements carrying `data-tauri-drag-region` move the window; double-click toggles maximize.
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { Logo } from "@/components/Logo";
import { cn } from "@/lib/utils";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type WinAction = (w: ReturnType<typeof getCurrentWindow>) => Promise<void>;

export function TitleBar({ subtitle }: { subtitle?: string | null }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!inTauri()) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const sync = () => win.isMaximized().then((m) => !disposed && setMaximized(m)).catch(() => {});
    sync();
    win
      .onResized(() => sync())
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const act = (fn: WinAction) => () => {
    if (!inTauri()) return;
    fn(getCurrentWindow()).catch((e) => console.error("window action failed", e));
  };

  const btn = "inline-flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

  return (
    <header
      data-tauri-drag-region
      className="flex h-9 shrink-0 select-none items-stretch border-b bg-sidebar text-sidebar-foreground"
    >
      <div data-tauri-drag-region className="flex items-center gap-2 pl-3 pr-4">
        <Logo className="size-4" />
        <span data-tauri-drag-region className="text-sm font-semibold tracking-tight">
          Vibecoder
        </span>
      </div>
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center justify-center">
        {subtitle && (
          <span data-tauri-drag-region className="truncate text-xs text-muted-foreground">
            {subtitle}
          </span>
        )}
      </div>
      <div className="flex items-stretch">
        <button type="button" aria-label="최소화" title="최소화" onClick={act((w) => w.minimize())} className={btn}>
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          aria-label={maximized ? "이전 크기로" : "최대화"}
          title={maximized ? "이전 크기로" : "최대화"}
          onClick={act((w) => w.toggleMaximize())}
          className={btn}
        >
          {maximized ? <Copy className="size-3.5" /> : <Square className="size-3.5" />}
        </button>
        <button
          type="button"
          aria-label="닫기"
          title="닫기"
          onClick={act((w) => w.close())}
          className={cn(btn, "hover:bg-red-600 hover:text-white")}
        >
          <X className="size-4" />
        </button>
      </div>
    </header>
  );
}
