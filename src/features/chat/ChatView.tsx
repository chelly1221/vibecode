// Main chat area: session header, transcript, pending permission banner, composer.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2Icon, MessageSquarePlusIcon, PlayIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { PermissionDecision } from "@/lib/bindings/PermissionDecision";
import type { QuestionAnswer } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";
import { LONG_SESSION_QUESTIONS, questionCount, useSessionsStore } from "@/stores/sessions";
import { Welcome } from "@/features/projects/Welcome";
import { LongSessionBanner } from "./LongSessionBanner";
import { CheckpointDialogs } from "./CheckpointDialogs";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";
import { MessageList } from "./MessageList";
import { NewSessionDialog } from "./NewSessionDialog";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";
import { SubagentsDrawer } from "./SubagentsDrawer";
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
  const answerQuestion = useSessionsStore((s) => s.answerQuestion);
  const dismissLongWarning = useSessionsStore((s) => s.dismissLongWarning);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [subagentsOpen, setSubagentsOpen] = useState(false);

  const record = useMemo(() => {
    if (!activeSessionId) return null;
    for (const list of Object.values(sessionsByProject)) {
      const hit = list.find((r) => r.id === activeSessionId);
      if (hit) return hit;
    }
    return null;
  }, [activeSessionId, sessionsByProject]);

  // Keep loading failures visible with an explicit retry, and ignore failures after selection changes.
  useEffect(() => {
    setHistoryError(null);
    if (!activeSessionId || !activeProjectId || session?.live || session?.historyLoaded) return;
    let cancelled = false;
    const work = record ? loadHistory(record) : !sessionsByProject[activeProjectId]
      ? loadSessions(activeProjectId)
      : Promise.reject(new Error("대화 기록을 찾을 수 없습니다. 다른 대화를 선택하거나 새 대화를 시작해 주세요."));
    work.catch((e) => { if (!cancelled) setHistoryError(String(e)); });
    return () => { cancelled = true; };
  }, [activeSessionId, activeProjectId, record, session?.live, session?.historyLoaded, sessionsByProject, loadSessions, loadHistory, historyAttempt]);

  const onPermission = useCallback(
    (requestId: string, decision: PermissionDecision, message?: string) => {
      if (!activeSessionId) return;
      return permissionReply(activeSessionId, { request_id: requestId, decision, message: message ?? null }).catch((e) =>
        { toast.error("권한 응답 실패", { description: String(e) }); },
      );
    },
    [activeSessionId, permissionReply],
  );

  const onAnswer = useCallback(
    async (requestId: string, answers: QuestionAnswer[]) => {
      if (!activeSessionId) return;
      try {
        await answerQuestion(activeSessionId, requestId, answers);
      } catch (e) {
        toast.error("답변을 보내지 못했습니다", { description: String(e) });
      }
    },
    [activeSessionId, answerQuestion],
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

  if (!activeProjectId) return <Welcome />;

  if (!activeSessionId) {
    return (
      <>
        <EmptyState
          icon={<MessageSquarePlusIcon />}
          title="무엇을 바꾸고 싶으세요?"
          description="새 대화를 열고 원하는 기능이나 수정할 내용을 편하게 설명해 주세요."
          action={
            <Button onClick={() => setNewSessionOpen(true)}>
              <MessageSquarePlusIcon data-icon="inline-start" />
              새 대화
            </Button>
          }
        />
        <NewSessionDialog />
      </>
    );
  }

  if (historyError && !session?.live) return <>
    <EmptyState title="대화 기록을 불러오지 못했어요" description={historyError} action={<div className="flex gap-2"><Button onClick={() => setHistoryAttempt((v) => v + 1)}>다시 시도</Button><Button variant="outline" onClick={() => setNewSessionOpen(true)}>새 대화</Button></div>} />
    <NewSessionDialog />
  </>;

  if (!session || (!session.live && !session.historyLoaded)) {
    return (
      <>
        <EmptyState icon={<Loader2Icon className="animate-spin" />} title="대화 기록을 불러오는 중…" />
        <NewSessionDialog />
      </>
    );
  }

  const pending = session.pendingPermissions[0];
  const pendingQuestion = session.pendingQuestions[0];
  const questions = questionCount(session.items);
  const showLongWarning = questions >= LONG_SESSION_QUESTIONS && !session.longWarningDismissed;

  return (
    <div className="flex h-full min-h-0 flex-1">
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <SessionHeader session={session} subagentsOpen={subagentsOpen} onToggleSubagents={() => setSubagentsOpen((v) => !v)} />
      <MessageList session={session} onPermission={onPermission} onAnswer={onAnswer} />
      {pendingQuestion && !pending && (
        <div className="border-t bg-primary/5 px-4 py-2">
          <div className="mx-auto w-full max-w-3xl">
            <QuestionCard
              key={pendingQuestion.request_id}
              requestId={pendingQuestion.request_id}
              questions={pendingQuestion.questions}
              compact
              onSubmit={(answers) => onAnswer(pendingQuestion.request_id, answers)}
            />
            {session.pendingQuestions.length > 1 && (
              <div className="mt-1 text-xs text-muted-foreground">대기 중인 질문 {session.pendingQuestions.length}개</div>
            )}
          </div>
        </div>
      )}
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
          이전 대화입니다. 메시지를 보내면 이어서 작업할 수 있어요.
          <Button size="sm" variant="outline" onClick={onResume}>
            <PlayIcon data-icon="inline-start" />
            이어서 진행
          </Button>
        </div>
      )}
      {showLongWarning && (
        <LongSessionBanner count={questions} onNewSession={() => setNewSessionOpen(true)} onDismiss={() => dismissLongWarning(session.record.id)} />
      )}
      <Composer key={activeSessionId} draftKey={activeSessionId} running={session.running} starting={session.starting} live={session.live} onSend={onSend} onInterrupt={onInterrupt} />
      <NewSessionDialog />
      <CheckpointDialogs />
    </div>
    {subagentsOpen && <SubagentsDrawer subagents={session.subagents} onClose={() => setSubagentsOpen(false)} />}
    </div>
  );
}
