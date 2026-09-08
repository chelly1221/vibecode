// Custom window title bar (native decorations are disabled). Besides the window controls it hosts the
// panel toggles (icon + label) so first-time users can see what can be opened. Elements carrying
// `data-tauri-drag-region` move the window; double-click toggles maximize.
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, MoreHorizontal, FolderTree, GitBranch, Minus, MonitorPlay, Settings, Square, SquareTerminal, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors",
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
      className="relative flex h-12 shrink-0 select-none items-stretch border-b bg-sidebar text-sidebar-foreground"
    >
      {/* Panel toggles on the far left (icon + label) */}
      {showPanels ? (
        <div className="flex items-center gap-0.5 pl-2 pr-3">
          <PanelButton icon={<MonitorPlay className="size-4" />} label="미리보기" hint="만든 화면 확인하기 (Ctrl+4)" pressed={previewOpen} onClick={() => setPreviewOpen(!previewOpen)} />
          <PanelButton icon={<GitBranch className="size-4" />} label="변경 내역" hint="변경 확인하고 버전 저장하기 (Ctrl+1)" pressed={gitPanelOpen} onClick={() => setGitPanelOpen(!gitPanelOpen)} />
          <PanelButton icon={<Settings className="size-4" />} label="설정" hint="AI 계정 · 저장 위치 · 화면 설정 (Ctrl+,)" onClick={() => setSettingsOpen(true)} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild><button type="button" aria-label="추가 도구" className="flex h-8 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent"><MoreHorizontal className="size-4" /><span>더 보기</span></button></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => setFilesPanelOpen(!filesPanelOpen)}><FolderTree /> {filesPanelOpen ? "파일 목록 닫기" : "파일 목록 열기"} <span className="ml-auto text-xs text-muted-foreground">Ctrl+3</span></DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTerminalOpen(!terminalOpen)}><SquareTerminal /> {terminalOpen ? "개발자 터미널 닫기" : "개발자 터미널 열기"} <span className="ml-auto text-xs text-muted-foreground">Ctrl+2</span></DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : (
        <div data-tauri-drag-region className="w-3" />
      )}

      {/* Draggable middle; the logo + name are centred in the whole bar */}
      <div data-tauri-drag-region className="min-w-0 flex-1" />
      <div data-tauri-drag-region className="pointer-events-none flex shrink-0 items-center justify-center gap-2 px-4">
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
