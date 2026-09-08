import { ProjectAccountsDialog } from "@/features/accounts/ProjectAccountsDialog";
import { useEffect, useState } from "react";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import {
  ExternalLink,
  Folder,
  FolderOpen,
  House,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { isOverElement, PROJECT_DROP_ZONE } from "@/lib/dropZones";
import { registerDroppedPaths, pickAndRegisterExistingProject } from "./registerExisting";
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
import { ProjectEditDialog } from "./ProjectEditDialog";
import { formatRelative } from "./format";


function ProjectItem({ project, selected, onSelect, onRemove, onAccounts, onEdit }: { project: ProjectRecord; selected: boolean; onSelect: () => void; onRemove: () => void; onAccounts: () => void; onEdit: () => void }) {
  return (
    <div className="group/project relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-current={selected ? "page" : undefined}
            onClick={onSelect}
            className={cn(
              "flex h-8 w-full min-w-0 items-center gap-2 rounded-lg pr-8 pl-2 text-left text-[13px] transition-colors hover:bg-sidebar-accent",
              selected && "bg-primary/10 text-sidebar-accent-foreground ring-1 ring-inset ring-primary/20",
            )}
          >
            {selected ? <FolderOpen className="size-3.5 shrink-0 text-primary" aria-hidden="true" /> : <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
            <span className="min-w-0 truncate font-medium">{project.name}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8} className="max-w-xs flex-col items-start gap-1">
          <span className="font-medium break-all">{project.name}</span>
          <span className="font-mono text-[11px] break-all opacity-75">{project.path}</span>
          <span className="text-[11px] opacity-75">최근 열기 · {formatRelative(project.last_opened_at)}</span>
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon-xs"
            variant="ghost"
            className="absolute top-1 right-1 text-muted-foreground opacity-60 group-hover/project:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            aria-label={`${project.name} 프로젝트 메뉴`}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-max min-w-48 whitespace-nowrap">
          <DropdownMenuItem onClick={onEdit}><Pencil /> 프로젝트 수정</DropdownMenuItem>
          <DropdownMenuItem onClick={onAccounts}>사용할 계정 선택</DropdownMenuItem>
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
    </div>
  );
}

/** Compact project navigation and the selected project's sessions. */
export function ProjectSidebar() {
  const projects = useAppStore((s) => s.projects);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const selectProject = useAppStore((s) => s.selectProject);
  const loadProjects = useAppStore((s) => s.loadProjects);
  const setWizardOpen = useAppStore((s) => s.setWizardOpen);
  const [accountProject, setAccountProject] = useState<ProjectRecord | null>(null);
  const [pendingRemove, setPendingRemove] = useState<ProjectRecord | null>(null);
  const [editingProject, setEditingProject] = useState<ProjectRecord | null>(null);

  const openExisting = async () => {
    try {
      await pickAndRegisterExistingProject();
    } catch (e) {
      toast.error(`프로젝트를 등록하지 못했습니다: ${e}`);
    }
  };

  // Drag a folder from Explorer onto the sidebar to register it.
  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const p = event.payload;
          const zone = document.querySelector(PROJECT_DROP_ZONE);
          if (p.type === "enter" || p.type === "over") setDropping(isOverElement(p.position, zone));
          else if (p.type === "leave") setDropping(false);
          else if (p.type === "drop") {
            setDropping(false);
            if (isOverElement(p.position, zone)) void registerDroppedPaths(p.paths);
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
  }, []);

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
    <aside aria-label="프로젝트 탐색" data-drop-zone="projects" className={cn("flex h-full w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground", dropping && "ring-2 ring-inset ring-primary/60")}>
      <div className="grid grid-cols-2 gap-1.5 border-b p-2">
        <Button size="sm" className="h-8 px-2" onClick={() => setWizardOpen(true)}><Plus /> 새 프로젝트</Button>
        <Button size="sm" variant="outline" className="h-8 px-2" onClick={openExisting}><FolderOpen /> 기존 폴더</Button>
      </div>
      <div className="flex h-8 shrink-0 items-center justify-between pr-2 pl-3">
        <h2 className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">프로젝트 <span className="tabular-nums opacity-70">{projects.length}</span></h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-xs" variant="ghost" aria-label="시작 화면" aria-pressed={activeProjectId === null} className={cn("text-muted-foreground", activeProjectId === null && "text-primary")} onClick={() => selectProject(null)}><House /></Button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>시작 화면</TooltipContent>
        </Tooltip>
      </div>

      {/* Keep long names inside the viewport instead of widening Radix's table wrapper. */}
      <ScrollArea className="min-h-0 flex-1 px-2 [&_[data-slot=scroll-area-viewport]>div]:block!">
        {projects.length === 0 ? (
          <div className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
            <FolderOpen className="mx-auto mb-2 size-5 opacity-60" aria-hidden="true" />
            <p>등록된 프로젝트가 없어요.</p>
            <p className="mt-1 text-[11px] leading-relaxed">위에서 만들거나 폴더를 여기에 놓아 주세요.</p>
          </div>
        ) : (
          <ul aria-label="프로젝트 목록" className="space-y-0.5 pb-2">
            {projects.map((p) => (
              <li key={p.id} className="min-w-0">
                <ProjectItem
                  project={p}
                  selected={p.id === activeProjectId}
                  onSelect={() => selectProject(p.id)}
                  onRemove={() => setPendingRemove(p)}
                  onAccounts={() => setAccountProject(p)}
                  onEdit={() => setEditingProject(p)}
                />
                {p.id === activeProjectId && <SessionList projectId={p.id} />}
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>


      {accountProject && <ProjectAccountsDialog key={accountProject.id} project={accountProject} onClose={() => setAccountProject(null)} />}
      {editingProject && <ProjectEditDialog key={editingProject.id} project={editingProject} onClose={() => setEditingProject(null)} />}
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
