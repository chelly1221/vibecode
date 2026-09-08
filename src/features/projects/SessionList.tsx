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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ipc, type SessionRecord } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";
import { ConfirmDialog } from "./ConfirmDialog";
import { ProviderBadge } from "./ProviderBadge";
import { formatRelative } from "./format";
import { effortLabel, PROVIDER_LABEL } from "./labels";
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
    loadSessions(projectId).catch((e) => toast.error(`대화 목록을 불러오지 못했습니다: ${e}`));
  }, [projectId, loadSessions]);

  const visible = useMemo(() => filterSessions(sessions ?? [], query, showArchived), [sessions, query, showArchived]);
  const archivedCount = useMemo(() => (sessions ?? []).filter((s) => s.archived).length, [sessions]);

  const remove = async () => {
    if (!pendingDelete) return;
    try {
      await ipc.sessions.delete(pendingDelete.id);
      if (activeSessionId === pendingDelete.id) selectSession(null);
      await loadSessions(projectId);
      toast.success("대화을 삭제했습니다.");
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
      toast.success(archived ? "대화을 보관했습니다." : "보관을 해제했습니다.");
    } catch (e) {
      toast.error(`보관 처리 실패: ${e}`);
    }
  };

  const exportMd = async (s: SessionRecord) => {
    try {
      const path = await save({ defaultPath: exportFileName(s.title), filters: [{ name: "Markdown", extensions: ["md"] }], title: "대화 내보내기" });
      if (!path) return;
      await ipc.sessions.exportToFile(s.id, path);
      toast.success(`내보냈습니다: ${path}`);
    } catch (e) {
      toast.error(`내보내기 실패: ${e}`);
    }
  };

  return (
    <div className="my-0.5 ml-3 border-l border-primary/15 pl-1">
      <div className="flex h-7 items-center justify-between pr-1 pl-1.5">
        <span className="text-[11px] text-muted-foreground">대화{sessions && sessions.length > 0 && <span className="ml-1 tabular-nums opacity-70">{visible.length}</span>}</span>
        <Button size="xs" variant="ghost" onClick={() => setNewSessionOpen(true)} title="새 대화">
          <Plus /> 새 대화
        </Button>
      </div>
      {(sessions?.length ?? 0) > 3 && (
        <div className="relative mb-1 pr-1">
          <Search className="pointer-events-none absolute top-1/2 left-1.5 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="대화 검색" aria-label="대화 검색" className="h-6 pl-6 text-[11px]" />
        </div>
      )}
      {!sessions || sessions.length === 0 ? (
        <p className="px-1.5 pb-1.5 text-[11px] text-muted-foreground">{!sessions ? "대화를 불러오는 중…" : "아직 대화가 없습니다."}</p>
      ) : (
        <ul className="space-y-0.5 pb-1">
          {visible.map((s) => {
            const model = shortModel(s.model);
            const details = [model, s.effort ? effortLabel(s.effort) : null].filter(Boolean).join(" · ");
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
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-current={activeSessionId === s.id ? "page" : undefined}
                        onClick={() => selectSession(s.id)}
                        onDoubleClick={() => setRenaming({ id: s.id, title: s.title })}
                        className={cn(
                          "flex h-9 w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-7 pl-1.5 text-left text-xs transition-colors hover:bg-sidebar-accent",
                          activeSessionId === s.id && "bg-primary/10 text-sidebar-accent-foreground ring-1 ring-inset ring-primary/20",
                          s.archived && "opacity-60",
                        )}
                      >
                        <ProviderBadge provider={s.provider} className="size-3.5 rounded-sm text-[9px]" />
                        {s.archived && <Archive className="size-3 shrink-0 text-muted-foreground" aria-label="보관된 대화" />}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium leading-4">{s.title || "제목 없음"}</span>
                          <span className="flex items-center gap-1.5 text-[10px] leading-3 text-muted-foreground">
                            <span className="min-w-0 flex-1 truncate">{details || PROVIDER_LABEL[s.provider]}</span>
                            <span className="shrink-0">{formatRelative(s.last_used_at)}</span>
                          </span>
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={8} className="max-w-xs flex-col items-start gap-1">
                      <span className="font-medium break-all">{s.title || "제목 없음"}</span>
                      <span className="text-[11px] break-all opacity-75">{PROVIDER_LABEL[s.provider]}{details && ` · ${details}`}</span>
                      <span className="text-[11px] opacity-75">{s.archived && "보관됨 · "}{formatRelative(s.last_used_at)}</span>
                    </TooltipContent>
                  </Tooltip>
                )}
                {!isRenaming && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="absolute top-1.5 right-0.5 text-muted-foreground opacity-60 group-hover/session:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                        aria-label={`${s.title || "제목 없음"} 대화 메뉴`}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-max min-w-48 whitespace-nowrap">
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
          {visible.length === 0 && <li className="px-1 pb-1 text-xs text-muted-foreground">일치하는 대화가 없습니다.</li>}
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
        title="대화을 삭제할까요?"
        description={`"${pendingDelete?.title ?? ""}" 대화과 대화 기록이 삭제됩니다. 이 작업은 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        destructive
        onConfirm={remove}
      />
    </div>
  );
}
