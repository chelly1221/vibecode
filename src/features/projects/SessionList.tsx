import { useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, Download, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { save } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ipc, type SessionRecord } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";
import { ConfirmDialog } from "./ConfirmDialog";
import { ProviderBadge } from "./ProviderBadge";
import { formatRelative } from "./format";
import { effortLabel } from "./labels";
import { exportFileName, filterSessions } from "./sessionFilter";

function shortModel(model: string | null | undefined): string | null {
  if (!model) return null;
  return model.replace(/^claude-/, "").replace(/^gpt-/, "gpt-");
}

/** Sessions of the selected project, shown under it in the sidebar. */
export function SessionList({ projectId }: { projectId: string }) {
  const sessions = useAppStore((s) => s.sessionsByProject[projectId]);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const selectSession = useAppStore((s) => s.selectSession);
  const loadSessions = useAppStore((s) => s.loadSessions);
  const setNewSessionOpen = useAppStore((s) => s.setNewSessionOpen);
  const [pendingDelete, setPendingDelete] = useState<SessionRecord | null>(null);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);

  useEffect(() => {
    loadSessions(projectId).catch((e) => toast.error(`세션 목록을 불러오지 못했습니다: ${e}`));
  }, [projectId, loadSessions]);

  const visible = useMemo(() => filterSessions(sessions ?? [], query, showArchived), [sessions, query, showArchived]);
  const archivedCount = useMemo(() => (sessions ?? []).filter((s) => s.archived).length, [sessions]);

  const remove = async () => {
    if (!pendingDelete) return;
    try {
      await ipc.sessions.delete(pendingDelete.id);
      if (activeSessionId === pendingDelete.id) selectSession(null);
      await loadSessions(projectId);
      toast.success("세션을 삭제했습니다.");
    } catch (e) {
      toast.error(`삭제 실패: ${e}`);
    }
  };

  const commitRename = async () => {
    if (!renaming) return;
    const title = renaming.title.trim();
    setRenaming(null);
    if (!title) return;
    try {
      await ipc.sessions.rename(renaming.id, title);
      await loadSessions(projectId);
    } catch (e) {
      toast.error(`이름 변경 실패: ${e}`);
    }
  };

  const setArchived = async (s: SessionRecord, archived: boolean) => {
    try {
      await ipc.sessions.setArchived(s.id, archived);
      if (archived && activeSessionId === s.id) selectSession(null);
      await loadSessions(projectId);
      toast.success(archived ? "세션을 보관했습니다." : "보관을 해제했습니다.");
    } catch (e) {
      toast.error(`보관 처리 실패: ${e}`);
    }
  };

  const exportMd = async (s: SessionRecord) => {
    try {
      const path = await save({ defaultPath: exportFileName(s.title), filters: [{ name: "Markdown", extensions: ["md"] }], title: "세션 내보내기" });
      if (!path) return;
      await ipc.sessions.exportToFile(s.id, path);
      toast.success(`내보냈습니다: ${path}`);
    } catch (e) {
      toast.error(`내보내기 실패: ${e}`);
    }
  };

  return (
    <div className="mt-1 ml-3 border-l pl-2">
      <div className="flex items-center justify-between py-1 pr-1">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">세션</span>
        <Button size="xs" variant="ghost" onClick={() => setNewSessionOpen(true)} title="새 세션">
          <Plus /> 새 세션
        </Button>
      </div>
      {(sessions?.length ?? 0) > 3 && (
        <div className="relative mb-1 pr-1">
          <Search className="pointer-events-none absolute top-1/2 left-1.5 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="세션 검색" className="h-6 pl-6 text-[11px]" />
        </div>
      )}
      {!sessions || sessions.length === 0 ? (
        <p className="px-1 pb-2 text-xs text-muted-foreground">아직 세션이 없습니다.</p>
      ) : (
        <ul className="space-y-0.5 pb-1">
          {visible.map((s) => {
            const model = shortModel(s.model);
            const isRenaming = renaming?.id === s.id;
            return (
              <li key={s.id} className="group/session relative">
                {isRenaming ? (
                  <Input
                    autoFocus
                    value={renaming.title}
                    onChange={(e) => setRenaming({ id: s.id, title: e.target.value })}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    className="my-0.5 h-7 text-xs"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => selectSession(s.id)}
                    onDoubleClick={() => setRenaming({ id: s.id, title: s.title })}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left text-xs hover:bg-sidebar-accent",
                      activeSessionId === s.id && "bg-sidebar-accent text-sidebar-accent-foreground",
                      s.archived && "opacity-60",
                    )}
                  >
                    <ProviderBadge provider={s.provider} className="mt-0.5 size-4 text-[10px]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{s.title || "제목 없음"}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                        {s.archived && <span className="rounded bg-muted px-1">보관됨</span>}
                        {model && <span className="rounded bg-muted px-1 font-mono">{model}</span>}
                        {s.effort && <span className="rounded bg-muted px-1">{effortLabel(s.effort)}</span>}
                        <span>{formatRelative(s.last_used_at)}</span>
                      </span>
                    </span>
                  </button>
                )}
                {!isRenaming && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="absolute top-1 right-1 opacity-0 group-hover/session:opacity-100 data-[state=open]:opacity-100"
                        aria-label="세션 메뉴"
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setRenaming({ id: s.id, title: s.title })}>
                        <Pencil /> 이름 바꾸기
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setArchived(s, !s.archived)}>
                        {s.archived ? (
                          <>
                            <ArchiveRestore /> 보관 해제
                          </>
                        ) : (
                          <>
                            <Archive /> 보관
                          </>
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => exportMd(s)}>
                        <Download /> 내보내기 (Markdown)
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setPendingDelete(s)}>
                        <Trash2 /> 삭제
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </li>
            );
          })}
          {visible.length === 0 && <li className="px-1 pb-1 text-xs text-muted-foreground">일치하는 세션이 없습니다.</li>}
        </ul>
      )}
      {archivedCount > 0 && (
        <button type="button" onClick={() => setShowArchived((v) => !v)} className="mb-1 px-1 text-[11px] text-muted-foreground hover:underline">
          {showArchived ? "보관됨 숨기기" : `보관됨 보기 (${archivedCount})`}
        </button>
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title="세션을 삭제할까요?"
        description={`"${pendingDelete?.title ?? ""}" 세션과 대화 기록이 삭제됩니다. 이 작업은 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        destructive
        onConfirm={remove}
      />
    </div>
  );
}
