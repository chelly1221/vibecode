// Project file explorer panel (between the project sidebar and the chat).
import { useEffect } from "react";
import { FolderTree, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app";
import { useFilesStore } from "@/stores/files";
import { FileTree } from "./FileTree";
import { FileViewerDialog } from "./FileViewerDialog";

const REFRESH_MS = 5000;

export function FilesPanel() {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const project = useAppStore((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const setFilesPanelOpen = useAppStore((s) => s.setFilesPanelOpen);
  const setProject = useFilesStore((s) => s.setProject);
  const refreshAll = useFilesStore((s) => s.refreshAll);
  const filter = useFilesStore((s) => s.filter);
  const setFilter = useFilesStore((s) => s.setFilter);
  const rootLoaded = useFilesStore((s) => !!s.dirs[""]);
  const anyLoading = useFilesStore((s) => Object.values(s.dirs).some((d) => d.loading));

  // Follow the selected project; refresh on open and periodically while open.
  useEffect(() => {
    setProject(activeProjectId);
  }, [activeProjectId, setProject]);

  useEffect(() => {
    if (!activeProjectId) return;
    if (rootLoaded) refreshAll().catch(() => {});
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshAll().catch(() => {});
    }, REFRESH_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <FolderTree className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={project?.path ?? ""}>
          {project ? project.name : "파일"}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-xs" variant="ghost" aria-label="새로고침" onClick={() => refreshAll()} disabled={!activeProjectId}>
              <RefreshCw className={anyLoading ? "animate-spin" : ""} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>새로고침</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-xs" variant="ghost" aria-label="파일 패널 닫기" onClick={() => setFilesPanelOpen(false)}>
              <X />
            </Button>
          </TooltipTrigger>
          <TooltipContent>닫기</TooltipContent>
        </Tooltip>
      </div>
      <div className="px-2 py-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="파일 이름 필터"
            className="h-7 pl-7 text-xs"
            disabled={!activeProjectId}
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1 px-1 pb-2">
        {activeProjectId ? (
          <FileTree relPath="" depth={0} />
        ) : (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">프로젝트를 선택하면 파일이 표시됩니다.</p>
        )}
      </ScrollArea>
      <FileViewerDialog />
    </aside>
  );
}
