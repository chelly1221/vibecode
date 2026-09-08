// Custom window title bar (native decorations are disabled). Besides the window controls it hosts the
// panel toggles (icon + label) so first-time users can see what can be opened. Elements carrying
// `data-tauri-drag-region` move the window; double-click toggles maximize.
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, FolderTree, GitBranch, Minus, MonitorPlay, Settings, Square, SquareTerminal, X } from "lucide-react";
import { Logo } from "@/components/Logo";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type WinAction = (w: ReturnType<typeof getCurrentWindow>) => Promise<void>;

function PanelButton({
  icon,
  label,
  hint,
  pressed,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-pressed={pressed}
          onClick={onClick}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
            pressed ? "bg-primary/15 text-foreground ring-1 ring-primary/40" : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {icon}
          <span>{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

export function TitleBar({ showPanels = true }: { showPanels?: boolean }) {
  const [maximized, setMaximized] = useState(false);
  const gitPanelOpen = useAppStore((s) => s.gitPanelOpen);
  const terminalOpen = useAppStore((s) => s.terminalOpen);
  const filesPanelOpen = useAppStore((s) => s.filesPanelOpen);
  const previewOpen = useAppStore((s) => s.previewOpen);
  const setGitPanelOpen = useAppStore((s) => s.setGitPanelOpen);
  const setTerminalOpen = useAppStore((s) => s.setTerminalOpen);
  const setFilesPanelOpen = useAppStore((s) => s.setFilesPanelOpen);
  const setPreviewOpen = useAppStore((s) => s.setPreviewOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

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
      className="relative flex h-9 shrink-0 select-none items-stretch border-b bg-sidebar text-sidebar-foreground"
    >
      {/* Panel toggles on the far left (icon + label) */}
      {showPanels ? (
        <div className="flex items-center gap-0.5 pl-2 pr-3">
          <PanelButton icon={<GitBranch className="size-3.5" />} label="git" hint="git 패널: 변경 사항 · 커밋 · 푸시 (Ctrl+1)" pressed={gitPanelOpen} onClick={() => setGitPanelOpen(!gitPanelOpen)} />
          <PanelButton icon={<SquareTerminal className="size-3.5" />} label="터미널" hint="내장 터미널 (Ctrl+2)" pressed={terminalOpen} onClick={() => setTerminalOpen(!terminalOpen)} />
          <PanelButton icon={<FolderTree className="size-3.5" />} label="파일" hint="프로젝트 파일 탐색기 (Ctrl+3)" pressed={filesPanelOpen} onClick={() => setFilesPanelOpen(!filesPanelOpen)} />
          <PanelButton icon={<MonitorPlay className="size-3.5" />} label="UI 미리보기" hint="dev 서버 화면을 실시간으로 보며 요소를 골라 지시 (Ctrl+4)" pressed={previewOpen} onClick={() => setPreviewOpen(!previewOpen)} />
          <PanelButton icon={<Settings className="size-3.5" />} label="설정" hint="기본값 · 도구 · 계정 · MCP (Ctrl+,)" onClick={() => setSettingsOpen(true)} />
        </div>
      ) : (
        <div data-tauri-drag-region className="w-3" />
      )}

      {/* Draggable middle; the logo + name are centred in the whole bar */}
      <div data-tauri-drag-region className="min-w-0 flex-1" />
      <div data-tauri-drag-region className="pointer-events-none absolute inset-x-0 top-0 flex h-9 items-center justify-center gap-2">
        <Logo className="size-4" />
        <span className="text-sm font-semibold tracking-tight">Vibecoder</span>
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
        <button type="button" aria-label="닫기" title="닫기" onClick={act((w) => w.close())} className={cn(btn, "hover:bg-red-600 hover:text-white")}>
          <X className="size-4" />
        </button>
      </div>
    </header>
  );
}
