import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import {
  ExternalLink,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  Plus,
  Settings,
  SquareTerminal,
  Trash2,
  FolderTree,
  MonitorPlay,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ipc, type ProjectRecord } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";
import { ConfirmDialog } from "./ConfirmDialog";
import { SessionList } from "./SessionList";
import { formatRelative } from "./format";

function IconButton({ label, onClick, children, pressed }: { label: string; onClick: () => void; children: React.ReactNode; pressed?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onClick}
          aria-label={label}
          aria-pressed={pressed}
          className={cn(pressed && "bg-sidebar-accent text-sidebar-accent-foreground")}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ProjectItem({ project, selected, onSelect, onRemove }: { project: ProjectRecord; selected: boolean; onSelect: () => void; onRemove: () => void }) {
  return (
    <li className="group/project relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onSelect}
            className={cn(
              "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-sidebar-accent",
              selected && "bg-sidebar-accent text-sidebar-accent-foreground",
            )}
          >
            <span className="flex items-center gap-1.5 pr-6">
              <span className="truncate font-medium">{project.name}</span>
              {project.stack_id && (
                <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                  {project.stack_id}
                </Badge>
              )}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">{formatRelative(project.last_opened_at)}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-xs font-mono text-xs break-all">
          {project.path}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon-xs"
            variant="ghost"
            className="absolute top-1.5 right-1 opacity-0 group-hover/project:opacity-100 data-[state=open]:opacity-100"
            aria-label="프로젝트 메뉴"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => openPath(project.path).catch((e) => toast.error(`열기 실패: ${e}`))}>
            <FolderOpen /> 탐색기에서 열기
          </DropdownMenuItem>
          {project.github_url && (
            <DropdownMenuItem onClick={() => openUrl(project.github_url!).catch((e) => toast.error(`열기 실패: ${e}`))}>
              <ExternalLink /> GitHub 열기
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onRemove}>
            <Trash2 /> 목록에서 제거
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** Left sidebar: projects, their sessions, and panel toggles. */
export function ProjectSidebar() {
  const projects = useAppStore((s) => s.projects);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const selectProject = useAppStore((s) => s.selectProject);
  const loadProjects = useAppStore((s) => s.loadProjects);
  const setWizardOpen = useAppStore((s) => s.setWizardOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const gitPanelOpen = useAppStore((s) => s.gitPanelOpen);
  const setGitPanelOpen = useAppStore((s) => s.setGitPanelOpen);
  const terminalOpen = useAppStore((s) => s.terminalOpen);
  const filesPanelOpen = useAppStore((s) => s.filesPanelOpen);
  const previewOpen = useAppStore((s) => s.previewOpen);
  const setPreviewOpen = useAppStore((s) => s.setPreviewOpen);
  const setFilesPanelOpen = useAppStore((s) => s.setFilesPanelOpen);
  const setTerminalOpen = useAppStore((s) => s.setTerminalOpen);
  const [pendingRemove, setPendingRemove] = useState<ProjectRecord | null>(null);

  const openExisting = async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false, title: "프로젝트 폴더 선택" });
      if (!picked) return;
      const project = await ipc.projects.open(picked);
      await loadProjects();
      selectProject(project.id);
      toast.success(`"${project.name}" 프로젝트를 열었습니다.`);
    } catch (e) {
      toast.error(`프로젝트를 열지 못했습니다: ${e}`);
    }
  };

  const remove = async () => {
    if (!pendingRemove) return;
    try {
      await ipc.projects.remove(pendingRemove.id);
      await loadProjects();
      toast.success("목록에서 제거했습니다. 폴더는 삭제되지 않습니다.");
    } catch (e) {
      toast.error(`제거 실패: ${e}`);
    }
  };

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-sm font-semibold tracking-tight">프로젝트</span>
        <div className="flex items-center gap-0.5">
          <IconButton label="새 프로젝트" onClick={() => setWizardOpen(true)}>
            <Plus />
          </IconButton>
          <IconButton label="폴더 열기" onClick={openExisting}>
            <FolderOpen />
          </IconButton>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2">
        {projects.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            <p>프로젝트가 없습니다.</p>
            <div className="mt-3 flex flex-col gap-1.5">
              <Button size="sm" onClick={() => setWizardOpen(true)}>
                <Plus /> 새 프로젝트
              </Button>
              <Button size="sm" variant="outline" onClick={openExisting}>
                <FolderOpen /> 기존 폴더 열기
              </Button>
            </div>
          </div>
        ) : (
          <ul className="space-y-0.5 pb-2">
            {projects.map((p) => (
              <div key={p.id}>
                <ProjectItem
                  project={p}
                  selected={p.id === activeProjectId}
                  onSelect={() => selectProject(p.id)}
                  onRemove={() => setPendingRemove(p)}
                />
                {p.id === activeProjectId && <SessionList projectId={p.id} />}
              </div>
            ))}
          </ul>
        )}
      </ScrollArea>

      <div className="flex items-center justify-between border-t px-2 py-1.5">
        <div className="flex items-center gap-0.5">
          <IconButton label="git 패널" pressed={gitPanelOpen} onClick={() => setGitPanelOpen(!gitPanelOpen)}>
            <GitBranch />
          </IconButton>
          <IconButton label="터미널" pressed={terminalOpen} onClick={() => setTerminalOpen(!terminalOpen)}>
            <SquareTerminal />
          </IconButton>
          <IconButton label="파일" pressed={filesPanelOpen} onClick={() => setFilesPanelOpen(!filesPanelOpen)}>
            <FolderTree />
          </IconButton>
          <IconButton label="UI 미리보기" pressed={previewOpen} onClick={() => setPreviewOpen(!previewOpen)}>
            <MonitorPlay />
          </IconButton>
        </div>
        <IconButton label="설정" onClick={() => setSettingsOpen(true)}>
          <Settings />
        </IconButton>
      </div>

      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(o) => !o && setPendingRemove(null)}
        title="프로젝트를 목록에서 제거할까요?"
        description={`"${pendingRemove?.name ?? ""}"의 세션 기록이 삭제됩니다. 디스크의 폴더는 그대로 남습니다.`}
        confirmLabel="제거"
        destructive
        onConfirm={remove}
      />
    </aside>
  );
}
