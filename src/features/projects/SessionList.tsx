import { useEffect, useState } from "react";
import { MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ipc, type SessionRecord } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";
import { ConfirmDialog } from "./ConfirmDialog";
import { ProviderBadge } from "./ProviderBadge";
import { formatRelative } from "./format";
import { effortLabel } from "./labels";

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

  useEffect(() => {
    loadSessions(projectId).catch((e) => toast.error(`세션 목록을 불러오지 못했습니다: ${e}`));
  }, [projectId, loadSessions]);

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

  return (
    <div className="mt-1 ml-3 border-l pl-2">
      <div className="flex items-center justify-between py-1 pr-1">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">세션</span>
        <Button size="xs" variant="ghost" onClick={() => setNewSessionOpen(true)} title="새 세션">
          <Plus /> 새 세션
        </Button>
      </div>
      {!sessions || sessions.length === 0 ? (
        <p className="px-1 pb-2 text-xs text-muted-foreground">아직 세션이 없습니다.</p>
      ) : (
        <ul className="space-y-0.5 pb-1">
          {sessions.map((s) => {
            const model = shortModel(s.model);
            return (
              <li key={s.id} className="group/session relative">
                <button
                  type="button"
                  onClick={() => selectSession(s.id)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left text-xs hover:bg-sidebar-accent",
                    activeSessionId === s.id && "bg-sidebar-accent text-sidebar-accent-foreground",
                  )}
                >
                  <ProviderBadge provider={s.provider} className="mt-0.5 size-4 text-[10px]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{s.title || "제목 없음"}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                      {model && <span className="rounded bg-muted px-1 font-mono">{model}</span>}
                      {s.effort && <span className="rounded bg-muted px-1">{effortLabel(s.effort)}</span>}
                      <span>{formatRelative(s.last_used_at)}</span>
                    </span>
                  </span>
                </button>
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
                    <DropdownMenuItem variant="destructive" onClick={() => setPendingDelete(s)}>
                      <Trash2 /> 삭제
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            );
          })}
        </ul>
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
