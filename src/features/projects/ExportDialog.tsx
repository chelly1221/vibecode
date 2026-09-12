// "프로그램 내보내기": run the stack's export recipe (build + collect artifacts) and write one
// portable file (zip / exe / apk) wherever the user chooses. Progress and the build log stream in.
import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { CheckCircle2, FolderOpen, Loader2, Package, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ipc, type ExportEvent, type ProjectRecord, type StackExport, type StackInfo } from "@/lib/ipc";
import { cn } from "@/lib/utils";

type Phase = "idle" | "running" | "done" | "failed";

const LOG_LIMIT = 400;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function ExportDialog({ project, onClose }: { project: ProjectRecord; onClose: () => void }) {
  const [stack, setStack] = useState<StackInfo | null | undefined>(undefined);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [step, setStep] = useState<string | null>(null);
  const [log, setLog] = useState<Array<{ line: string; err: boolean }>>([]);
  const [result, setResult] = useState<{ path: string; size: number; files: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([ipc.projects.stacksList(), ipc.projects.exportName(project.id)])
      .then(([stacks, name]) => {
        if (cancelled) return;
        setStack(stacks.find((s) => s.id === project.stack_id) ?? null);
        setSuggested(name);
      })
      .catch((e) => { if (!cancelled) { setStack(null); setError(String(e)); } });
    return () => { cancelled = true; };
  }, [project.id, project.stack_id]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const cfg: StackExport | null = stack?.export ?? null;
  const running = phase === "running";

  const run = async () => {
    if (!cfg || running) return;
    const parent = project.path.replace(/[\\/][^\\/]*$/, "");
    const dest = await save({
      title: "내보낼 위치 선택",
      defaultPath: `${parent}\\${suggested ?? `${project.name}.${cfg.extension}`}`,
      filters: [{ name: cfg.label, extensions: [cfg.extension] }],
    }).catch(() => null);
    if (!dest) return;
    setPhase("running");
    setStep(cfg.build_command ? "빌드 준비" : "결과물 수집");
    setLog([]);
    setResult(null);
    setError(null);
    try {
      await ipc.projects.export(project.id, dest, (e: ExportEvent) => {
        switch (e.type) {
          case "step":
            setStep(e.name);
            break;
          case "log":
            setLog((l) => {
              const next = l.concat({ line: e.line, err: e.is_err });
              return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next;
            });
            break;
          case "done":
            setResult({ path: e.path, size: e.size_bytes, files: e.files });
            break;
          case "failed":
            setError(e.message);
            break;
        }
      });
      setPhase("done");
      toast.success("내보내기가 끝났습니다");
    } catch (e) {
      setError((prev) => prev ?? String(e));
      setPhase("failed");
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !running) onClose(); }}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl" showCloseButton={!running} onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => { if (running) e.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Package className="size-5 text-primary" /> 프로그램 내보내기</DialogTitle>
          <DialogDescription>{project.name} · 완성된 프로그램을 다른 PC에서 바로 쓸 수 있는 파일로 만듭니다.</DialogDescription>
        </DialogHeader>

        {stack === undefined && !error && <p role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> 준비 중…</p>}

        {stack !== undefined && !cfg && (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            {stack ? <>
              <p><span className="font-medium text-foreground">{stack.name}</span> 스택은 아직 내보내기 방법이 정해져 있지 않아요.</p>
              <p className="mt-1 text-xs">웹 서버나 에디터로 빌드하는 종류는 대화창에서 AI에게 "배포용으로 빌드해 줘"라고 요청해 주세요.</p>
            </> : <p>이 프로젝트의 스택을 알 수 없어 내보내기를 준비할 수 없어요. 프로젝트 수정에서 스택을 확인해 주세요.</p>}
          </div>
        )}

        {cfg && (
          <div className="grid min-h-0 gap-3 overflow-y-auto">
            <div className="rounded-lg border p-3 text-sm">
              <div className="font-medium">{cfg.label}</div>
              {cfg.note && <p className="mt-1 text-xs text-muted-foreground">{cfg.note}</p>}
              {cfg.build_command && (
                <p className="mt-2 text-xs text-muted-foreground">
                  빌드 명령 <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{cfg.build_command}</code>
                </p>
              )}
            </div>

            {phase !== "idle" && (
              <div className="rounded-lg border">
                <div className="flex items-center gap-2 border-b px-3 py-2 text-sm">
                  {running ? <Loader2 className="size-4 animate-spin text-primary" /> : phase === "done" ? <CheckCircle2 className="size-4 text-emerald-500" /> : <XCircle className="size-4 text-destructive" />}
                  <span className="font-medium">{running ? `${step ?? "진행"} 중…` : phase === "done" ? "완료" : "실패"}</span>
                  {running && cfg.build_command && <span className="text-xs text-muted-foreground">빌드는 몇 분 걸릴 수 있어요.</span>}
                </div>
                {result && (
                  <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
                    <span className="min-w-0 flex-1 truncate font-mono" title={result.path}>{result.path}</span>
                    <span className="text-muted-foreground">{formatBytes(result.size)}{result.files > 1 ? ` · 파일 ${result.files}개` : ""}</span>
                    <Button size="xs" variant="outline" onClick={() => revealItemInDir(result.path).catch((e) => toast.error(`열기 실패: ${e}`))}>
                      <FolderOpen /> 폴더에서 보기
                    </Button>
                  </div>
                )}
                {error && <p role="alert" className="border-b px-3 py-2 text-xs text-destructive whitespace-pre-wrap">{error}</p>}
                {log.length > 0 && (
                  <pre ref={logRef} className="max-h-56 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-muted-foreground">
                    {log.map((l, i) => <span key={i} className={cn("block", l.err && "text-amber-300")}>{l.line}</span>)}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={running}>{phase === "done" ? "닫기" : "취소"}</Button>
          {cfg && (
            <Button onClick={() => void run()} disabled={running}>
              {running ? <Loader2 className="animate-spin" /> : <Package />} {phase === "idle" ? "저장 위치 고르고 내보내기" : "다시 내보내기"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
