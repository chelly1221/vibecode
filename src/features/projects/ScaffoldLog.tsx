import { useEffect, useRef } from "react";
import { Check, CircleDashed, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ScaffoldState } from "@/stores/wizard";

/** Progress checklist plus streaming command output for project creation. */
export function ScaffoldLog({ scaffold }: { scaffold: ScaffoldState }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = endRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [scaffold.logs.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <ol className="space-y-1 text-sm">
        {scaffold.steps.map((st, i) => {
          const running = !st.done && scaffold.status === "running";
          const failed = !st.done && scaffold.status === "failed";
          return (
            <li key={`${i}-${st.name}`} className="flex items-center gap-2">
              {st.done ? (
                <Check className="size-4 text-emerald-600" />
              ) : running ? (
                <Loader2 className="size-4 animate-spin text-primary" />
              ) : failed ? (
                <XCircle className="size-4 text-destructive" />
              ) : (
                <CircleDashed className="size-4 text-muted-foreground" />
              )}
              <span className={cn(!st.done && !running && "text-muted-foreground")}>{({ "검증": "프로젝트 설정 확인", "스캐폴딩": "기본 파일 만들기", "에이전트 문서 생성": "AI 작업 안내 준비", "git 초기화": "변경 기록 준비", "등록": "프로젝트 등록" } as Record<string, string>)[st.name] ?? st.name}</span>
            </li>
          );
        })}
        {scaffold.steps.length === 0 && scaffold.status === "running" && (
          <li className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> 준비 중…
          </li>
        )}
      </ol>
      <details className="rounded-lg border p-3" open={scaffold.status === "failed"}><summary className="cursor-pointer text-xs text-muted-foreground">실행 기록 자세히 보기</summary>
      <div ref={endRef} className="mt-2 max-h-52 min-h-0 overflow-auto rounded-md border bg-zinc-950 p-2 font-mono text-[11px] leading-5 text-zinc-200">
        {scaffold.logs.length === 0 ? (
          <span className="text-zinc-500">출력이 여기에 표시됩니다.</span>
        ) : (
          scaffold.logs.map((l, i) => (
            <div key={i} className={cn("whitespace-pre-wrap break-all", l.isErr && "text-amber-300")}>
              {l.line}
            </div>
          ))
        )}
      </div>
      </details>
    </div>
  );
}
