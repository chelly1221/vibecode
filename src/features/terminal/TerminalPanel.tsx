import { ChevronDown, Plus, TerminalSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app";
import { activeProjectDir, openTerminalWith, useTerminalStore } from "@/stores/terminal";
import { loginCommand, shellCommand } from "./commands";
import { XTermView } from "./XTermView";

/** Bottom terminal panel with tabs. Mounted while `useAppStore.terminalOpen`. */
export function TerminalPanel() {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const setActive = useTerminalStore((s) => s.setActive);
  const removeTab = useTerminalStore((s) => s.removeTab);
  const setTerminalOpen = useAppStore((s) => s.setTerminalOpen);

  const newShell = () => openTerminalWith(shellCommand(), activeProjectDir());

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-1">
        <TerminalSquare className="ml-1 size-4 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActive(t.id)}
              className={`group flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs ${
                t.id === activeTabId ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"
              }`}
              title={t.program ? `${t.program} ${t.args.join(" ")}` : "셸"}
            >
              <span className={t.exitCode !== undefined ? "line-through opacity-60" : ""}>{t.title}</span>
              <span
                role="button"
                aria-label="탭 닫기"
                className="rounded p-0.5 opacity-60 hover:bg-background hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  removeTab(t.id);
                }}
              >
                <X className="size-3" />
              </span>
            </button>
          ))}
          {tabs.length === 0 && <span className="px-2 text-xs text-muted-foreground">열린 터미널이 없습니다</span>}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={newShell} aria-label="새 터미널">
              <Plus className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>새 터미널 (프로젝트 폴더)</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => openTerminalWith(loginCommand("claude"))}>
          Claude 로그인
        </Button>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => openTerminalWith(loginCommand("codex"))}>
          Codex 로그인
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={() => setTerminalOpen(false)} aria-label="패널 숨기기">
              <ChevronDown className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>패널 숨기기 (터미널은 계속 실행됨)</TooltipContent>
        </Tooltip>
      </div>
      <div className="relative min-h-0 flex-1 p-1">
        {tabs.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Button variant="outline" size="sm" onClick={newShell}>
              <Plus className="size-4" /> 새 터미널
            </Button>
          </div>
        ) : (
          tabs.map((t) => <XTermView key={t.id} tab={t} active={t.id === activeTabId} />)
        )}
      </div>
    </div>
  );
}
