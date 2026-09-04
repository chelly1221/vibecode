// Main chat area: session header, transcript, pending permission banner, composer.

import { useCallback, useEffect, useMemo } from "react";
import { FolderOpenIcon, Loader2Icon, MessageSquarePlusIcon, PlayIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { PermissionDecision } from "@/lib/bindings/PermissionDecision";
import { useAppStore } from "@/stores/app";
import { useSessionsStore } from "@/stores/sessions";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";
import { MessageList } from "./MessageList";
import { NewSessionDialog } from "./NewSessionDialog";
import { PermissionCard } from "./PermissionCard";
import { SessionHeader } from "./SessionHeader";

export function ChatView() {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const loadSessions = useAppStore((s) => s.loadSessions);
  const setNewSessionOpen = useAppStore((s) => s.setNewSessionOpen);

  const session = useSessionsStore((s) => (activeSessionId ? s.sessions[activeSessionId] : undefined));
  const loadHistory = useSessionsStore((s) => s.loadHistory);
  const resume = useSessionsStore((s) => s.resume);
  const send = useSessionsStore((s) => s.send);
  const interrupt = useSessionsStore((s) => s.interrupt);
  const permissionReply = useSessionsStore((s) => s.permissionReply);

  const record = useMemo(() => {
    if (!activeSessionId) return null;
    for (const list of Object.values(sessionsByProject)) {
      const hit = list.find((r) => r.id === activeSessionId);
      if (hit) return hit;
    }
    return null;
  }, [activeSessionId, sessionsByProject]);

  // Make sure the selected session's record and history are available.
  useEffect(() => {
    if (!activeSessionId || !activeProjectId) return;
    if (session?.live || session?.historyLoaded) return;
    if (!record) {
      if (!sessionsByProject[activeProjectId]) loadSessions(activeProjectId).catch((e) => toast.error("세션 목록을 불러올 수 없습니다", { description: String(e) }));
      return;
    }
    loadHistory(record).catch((e) => toast.error("대화 기록을 불러올 수 없습니다", { description: String(e) }));
  }, [activeSessionId, activeProjectId, record, session?.live, session?.historyLoaded, sessionsByProject, loadSessions, loadHistory]);

  const onPermission = useCallback(
    (requestId: string, decision: PermissionDecision, message?: string) => {
      if (!activeSessionId) return;
      permissionReply(activeSessionId, { request_id: requestId, decision, message: message ?? null }).catch((e) =>
        toast.error("권한 응답 실패", { description: String(e) }),
      );
    },
    [activeSessionId, permissionReply],
  );

  const onSend = useCallback(
    async (text: string) => {
      if (!activeSessionId) return;
      try {
        await send(activeSessionId, text);
      } catch (e) {
        toast.error("메시지를 보낼 수 없습니다", { description: String(e) });
        throw e;
      }
    },
    [activeSessionId, send],
  );

  const onInterrupt = useCallback(() => {
    if (!activeSessionId) return;
    interrupt(activeSessionId).catch((e) => toast.error("중단 실패", { description: String(e) }));
  }, [activeSessionId, interrupt]);

  const onResume = useCallback(() => {
    if (!activeSessionId) return;
    resume(activeSessionId).catch((e) => toast.error("세션을 이어갈 수 없습니다", { description: String(e) }));
  }, [activeSessionId, resume]);

  if (!activeProjectId) {
    return (
      <EmptyState
        icon={<FolderOpenIcon />}
        title="프로젝트를 선택하거나 새로 만드세요"
        description="왼쪽 목록에서 프로젝트를 고르면 세션을 시작할 수 있습니다."
      />
    );
  }

  if (!activeSessionId) {
    return (
      <>
        <EmptyState
          icon={<MessageSquarePlusIcon />}
          title="세션이 선택되지 않았습니다"
          description="새 세션을 시작해 Claude 또는 Codex에게 작업을 지시하세요."
          action={
            <Button onClick={() => setNewSessionOpen(true)}>
              <MessageSquarePlusIcon data-icon="inline-start" />
              새 세션
            </Button>
          }
        />
        <NewSessionDialog />
      </>
    );
  }

  if (!session) {
    return (
      <>
        <EmptyState icon={<Loader2Icon className="animate-spin" />} title="세션을 불러오는 중…" />
        <NewSessionDialog />
      </>
    );
  }

  const pending = session.pendingPermissions[0];

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <SessionHeader session={session} />
      <MessageList session={session} onPermission={onPermission} />
      {pending && (
        <div className="border-t bg-amber-500/5 px-4 py-2">
          <div className="mx-auto w-full max-w-3xl">
            <PermissionCard
              requestId={pending.request_id}
              kind={pending.kind}
              title={pending.title}
              detail={pending.detail}
              compact
              onReply={(d, m) => onPermission(pending.request_id, d, m)}
            />
            {session.pendingPermissions.length > 1 && (
              <div className="mt-1 text-xs text-muted-foreground">대기 중인 요청 {session.pendingPermissions.length}개</div>
            )}
          </div>
        </div>
      )}
      {!session.live && !session.starting && session.historyLoaded && (
        <div className="flex items-center justify-center gap-3 border-t bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
          이 세션은 현재 연결되어 있지 않습니다.
          <Button size="sm" variant="outline" onClick={onResume}>
            <PlayIcon data-icon="inline-start" />
            이어서 진행
          </Button>
        </div>
      )}
      <Composer running={session.running} starting={session.starting} live={session.live} onSend={onSend} onInterrupt={onInterrupt} />
      <NewSessionDialog />
    </div>
  );
}
