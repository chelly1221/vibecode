// Structured questions from the agent (Claude AskUserQuestion / Codex requestUserInput):
// one block per question with single/multi-select options and an optional free-text answer.

import { useMemo, useState } from "react";
import { CheckIcon, CircleHelpIcon, SendIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AgentQuestion, QuestionAnswer } from "@/lib/ipc";
import { cn } from "@/lib/utils";

export interface QuestionCardProps {
  requestId: string;
  questions: AgentQuestion[];
  answered?: boolean;
  answers?: QuestionAnswer[];
  compact?: boolean;
  disabled?: boolean;
  onSubmit?: (answers: QuestionAnswer[]) => void | Promise<void>;
  className?: string;
}

interface Draft {
  selected: string[];
  free: string;
}

function initialDrafts(questions: AgentQuestion[]): Record<string, Draft> {
  const d: Record<string, Draft> = {};
  for (const q of questions) d[q.id] = { selected: [], free: "" };
  return d;
}

export function draftToAnswers(questions: AgentQuestion[], drafts: Record<string, Draft>): QuestionAnswer[] {
  return questions.map((q) => {
    const d = drafts[q.id] ?? { selected: [], free: "" };
    const answers = [...d.selected];
    if (d.free.trim()) answers.push(d.free.trim());
    return { question_id: q.id, answers };
  });
}

export function QuestionCard({ questions, answered, answers, compact, disabled, onSubmit, className }: QuestionCardProps) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => initialDrafts(questions));
  const [busy, setBusy] = useState(false);
  const pending = !answered;

  const complete = useMemo(
    () => questions.every((q) => (drafts[q.id]?.selected.length ?? 0) > 0 || (drafts[q.id]?.free.trim().length ?? 0) > 0),
    [questions, drafts],
  );

  const answerFor = (q: AgentQuestion) => answers?.find((a) => a.question_id === q.id)?.answers ?? [];

  const toggle = (q: AgentQuestion, label: string) =>
    setDrafts((d) => {
      const cur = d[q.id] ?? { selected: [], free: "" };
      const has = cur.selected.includes(label);
      const selected = q.multi_select ? (has ? cur.selected.filter((x) => x !== label) : [...cur.selected, label]) : has ? [] : [label];
      return { ...d, [q.id]: { ...cur, selected } };
    });

  const submit = async () => {
    if (!onSubmit || !complete || busy || disabled) return;
    setBusy(true);
    try {
      await onSubmit(draftToAnswers(questions, drafts));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn("rounded-lg border bg-card text-sm", pending ? "border-primary/50 bg-primary/5" : "border-border", className)}>
      <div className="flex items-center gap-2 px-3 py-2">
        <CircleHelpIcon className={cn("size-4 shrink-0", pending ? "text-primary" : "text-muted-foreground")} />
        <span className="font-medium">AI가 확인하고 싶은 내용</span>
        <span className="text-xs text-muted-foreground">{questions.length}개</span>
        {answered && (
          <Badge variant="secondary" className="ml-auto shrink-0">
            답변 완료
          </Badge>
        )}
      </div>
      <div className={cn("space-y-3 border-t px-3 py-2", compact && "max-h-72 overflow-y-auto")}>
        {questions.map((q) => {
          const d = drafts[q.id] ?? { selected: [], free: "" };
          const given = answerFor(q);
          return (
            <div key={q.id} className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                {q.header && (
                  <Badge variant="outline" className="shrink-0">
                    {q.header}
                  </Badge>
                )}
                <span className="whitespace-pre-wrap">{q.question}</span>
              </div>
              {answered ? (
                <div className="text-xs text-muted-foreground">답변: {given.length ? given.join(", ") : "(없음)"}</div>
              ) : (
                <div className="space-y-1" role={q.multi_select ? "group" : "radiogroup"}>
                  {q.options.map((o) => {
                    const on = d.selected.includes(o.label);
                    return (
                      <button
                        key={o.label}
                        type="button"
                        role={q.multi_select ? "checkbox" : "radio"}
                        aria-checked={on}
                        disabled={disabled || busy}
                        onClick={() => toggle(q, o.label)}
                        className={cn(
                          "flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors hover:bg-accent/50",
                          on && "border-primary bg-primary/5",
                        )}
                      >
                        {q.multi_select ? (
                          <span aria-hidden className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border", on && "border-primary bg-primary text-primary-foreground")}>{on && <CheckIcon className="size-3" />}</span>
                        ) : (
                          <span className={cn("mt-1 flex size-3.5 shrink-0 items-center justify-center rounded-full border", on && "border-primary")}>
                            {on && <span className="size-2 rounded-full bg-primary" />}
                          </span>
                        )}
                        <span className="min-w-0">
                          <span className="block text-sm">{o.label}</span>
                          {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
                        </span>
                        {on && <CheckIcon className="ml-auto size-3.5 shrink-0 text-primary" />}
                      </button>
                    );
                  })}
                  {(q.allow_free_text || q.options.length === 0) && (
                    <Input
                      value={d.free}
                      disabled={disabled || busy}
                      onChange={(e) => setDrafts((all) => ({ ...all, [q.id]: { ...d, free: e.target.value } }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && complete) {
                          e.preventDefault();
                          void submit();
                        }
                      }}
                      placeholder={q.options.length ? "직접 입력 (선택)" : "답변을 입력하세요"}
                      className="h-8 text-xs"
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {pending && onSubmit && (
        <div className="flex items-center justify-end gap-2 border-t px-3 py-2">
          {!complete && <span className="mr-auto text-xs text-muted-foreground">모든 질문에 답해 주세요</span>}
          <Button size="sm" disabled={!complete || disabled || busy} onClick={() => void submit()}>
            <SendIcon data-icon="inline-start" />
            답변 보내기
          </Button>
        </div>
      )}
    </div>
  );
}
