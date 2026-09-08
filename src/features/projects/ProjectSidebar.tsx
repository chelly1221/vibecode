import { ProjectAccountsDialog } from "@/features/accounts/ProjectAccountsDialog";
import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import {
  ExternalLink,
  FolderOpen,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { isOverElement, PROJECT_DROP_ZONE } from "@/lib/dropZones";
import { registerDroppedPaths, registerExistingProject } from "./registerExisting";
import { AgentDocsPrompt } from "./AgentDocsPrompt";
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


function ProjectItem({ project, selected, onSelect, onRemove, onAccounts }: { project: ProjectRecord; selected: boolean; onSelect: () => void; onRemove: () => void; onAccounts: () => void }) {
  return (
    <li className="group/project relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-current={selected ? "page" : undefined}
            onClick={onSelect}
            className={cn(
              "flex w-full flex-col gap-1 rounded-xl px-3 py-3 text-left text-sm hover:bg-sidebar-accent",
              selected && "bg-primary/10 text-sidebar-accent-foreground ring-1 ring-inset ring-primary/20",
            )}
          >
            <span className="flex items-center gap-1.5 pr-6">
              <span className="truncate font-medium">{project.name}</span>

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
            className="absolute top-1.5 right-1 opacity-60 group-hover/project:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            aria-label="프로젝트 메뉴"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
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
  const [accountProject, setAccountProject] = useState<ProjectRecord | null>(null);
  const [pendingRemove, setPendingRemove] = useState<ProjectRecord | null>(null);

  const openExisting = async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false, title: "등록할 프로젝트 폴더 선택" });
      if (!picked) return;
      await registerExistingProject(picked);
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
    <aside data-drop-zone="projects" className={cn("flex h-full w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground", dropping && "ring-2 ring-inset ring-primary/60")}>
      <div className="space-y-3 border-b p-3">
        <button type="button" onClick={() => selectProject(null)} className="w-full rounded-lg px-2 py-2 text-left text-sm font-semibold hover:bg-sidebar-accent">내 작업 공간</button>
        <Button className="w-full justify-start" onClick={() => setWizardOpen(true)}><Plus /> 새로 만들기</Button>
        <Button variant="outline" className="w-full justify-start" onClick={openExisting}><FolderOpen /> 기존 폴더 열기</Button>
      </div>
      <div className="flex items-center justify-between px-4 py-3"><span className="text-xs font-medium text-muted-foreground">내 프로젝트</span><span className="text-xs text-muted-foreground">{projects.length}</span></div>

      <ScrollArea className="min-h-0 flex-1 px-2">
        {projects.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            <p>프로젝트가 없습니다.</p>
            <p className="text-xs text-muted-foreground">이 앱으로 만들지 않은 폴더도 등록할 수 있습니다. 폴더를 여기에 끌어다 놓아도 됩니다.</p>
            <div className="mt-3 flex flex-col gap-1.5">
              <Button size="sm" onClick={() => setWizardOpen(true)}>
                <Plus /> 새 프로젝트
              </Button>
              <Button size="sm" variant="outline" onClick={openExisting}>
                <FolderOpen /> 기존 폴더 등록
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
                  onAccounts={() => setAccountProject(p)}
                />
                {p.id === activeProjectId && <SessionList projectId={p.id} />}
              </div>
            ))}
          </ul>
        )}
      </ScrollArea>


      {accountProject && <ProjectAccountsDialog key={accountProject.id} project={accountProject} onClose={() => setAccountProject(null)} />}
      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(o) => !o && setPendingRemove(null)}
        title="프로젝트를 목록에서 제거할까요?"
        description={`"${pendingRemove?.name ?? ""}"의 세션 기록이 삭제됩니다. 디스크의 폴더는 그대로 남습니다.`}
        confirmLabel="제거"
        destructive
        onConfirm={remove}
      />
      <AgentDocsPrompt />
    </aside>
  );
}
