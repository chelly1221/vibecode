// "새 빌드 적용": rebuild Vibecoder from its source checkout and restart on the new exe. The build
// runs while the app stays usable; a countdown then restarts the app (or, when the app runs from
// the build output itself, the app quits first and a console window builds and restarts it).
import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, FolderOpen, Hammer, Loader2, RotateCw, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app";
import { useSessionsStore } from "@/stores/sessions";
import { useSelfBuildStore } from "@/stores/selfBuild";

export function ApplyBuildDialog() {
  const open = useAppStore((s) => s.applyBuildOpen);
  const setOpen = useAppStore((s) => s.setApplyBuildOpen);
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const { info, phase, step, log, builtExe, error, countdown } = useSelfBuildStore();
  const loadInfo = useSelfBuildStore((s) => s.loadInfo);
  const build = useSelfBuildStore((s) => s.build);
  const apply = useSelfBuildStore((s) => s.apply);
  const cancelCountdown = useSelfBuildStore((s) => s.cancelCountdown);
  const reset = useSelfBuildStore((s) => s.reset);
  const runningSessions = useSessionsStore((s) => Object.values(s.sessions).filter((x) => x.running).length);
  const [loadError, setLoadError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadInfo().then(() => { if (!cancelled) setLoadError(null); }).catch((e) => { if (!cancelled) setLoadError(String(e)); });
    return () => { cancelled = true; };
  }, [open, loadInfo, settings?.dev_repo_path]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const pickRepo = async () => {
    try {
      const dir = await openDialog({ directory: true, multiple: false, title: "Vibecoder 소스 폴더 선택" });
      if (typeof dir !== "string" || !settings) return;
      await saveSettings({ ...settings, dev_repo_path: dir });
      const next = await loadInfo();
      if (!next.repo) toast.error("이 폴더에서 Vibecoder 소스(src-tauri/tauri.conf.json)를 찾지 못했어요.");
    } catch (e) {
      toast.error("폴더를 선택하지 못했어요", { description: String(e) });
    }
  };

  const busy = phase === "building" || phase === "applying";
  const start = () => {
    if (!info?.repo) return;
    if (info.in_place) void apply();
    else void build(info.repo);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && phase !== "applying") setOpen(false); }}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl" showCloseButton={phase !== "applying"}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Hammer className="size-5 text-primary" /> 새 빌드 적용</DialogTitle>
          <DialogDescription>소스 폴더에서 Vibecoder를 다시 빌드한 뒤, 지금 쓰는 실행 파일을 새 것으로 바꾸고 자동으로 다시 시작합니다.</DialogDescription>
        </DialogHeader>

        {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}

        <div className="grid gap-2 rounded-lg border p-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-muted-foreground">소스 폴더</span>
            <span className={cn("min-w-0 flex-1 truncate font-mono", !info?.repo && "text-destructive")} title={info?.repo ?? undefined}>{info?.repo ?? "찾지 못했어요 — 폴더를 선택해 주세요"}</span>
            <Button size="xs" variant="outline" onClick={() => void pickRepo()} disabled={busy}><FolderOpen /> 선택</Button>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-muted-foreground">실행 파일</span>
            <span className="min-w-0 flex-1 truncate font-mono" title={info?.current_exe}>{info?.current_exe ?? "…"}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-muted-foreground">빌드 명령</span>
            <span className="min-w-0 flex-1 truncate font-mono">{info?.build_command ?? "…"}</span>
          </div>
          <p className="text-muted-foreground">
            {info?.in_place
              ? "지금 실행 중인 파일이 빌드 결과물 그 자체라서, 먼저 앱을 종료한 뒤 콘솔 창에서 빌드하고 다시 시작합니다."
              : "빌드는 앱을 쓰는 동안 뒤에서 진행되고(몇 분), 끝나면 잠깐 종료했다가 새 버전으로 다시 열립니다. 빌드가 실패하면 아무것도 바뀌지 않아요."}
          </p>
          {runningSessions > 0 && <p className="text-amber-400">AI가 작업 중인 대화가 {runningSessions}개 있어요. 다시 시작하면 그 작업은 중단됩니다.</p>}
        </div>

        {phase !== "idle" && (
          <div className="flex min-h-0 flex-col rounded-lg border">
            <div className="flex items-center gap-2 border-b px-3 py-2 text-sm">
              {busy ? <Loader2 className="size-4 animate-spin text-primary" /> : phase === "built" ? <CheckCircle2 className="size-4 text-emerald-500" /> : <XCircle className="size-4 text-destructive" />}
              <span className="font-medium">
                {phase === "building" && `${step ?? "빌드"} 중…`}
                {phase === "built" && (countdown !== null ? `빌드 완료 · ${countdown}초 후 새 버전으로 다시 시작합니다` : "빌드 완료 · 적용을 기다리는 중")}
                {phase === "applying" && "새 버전으로 다시 시작하는 중…"}
                {phase === "failed" && "실패"}
              </span>
              {phase === "built" && countdown !== null && (
                <Button size="xs" variant="outline" className="ml-auto" onClick={cancelCountdown}>나중에</Button>
              )}
            </div>
            {builtExe && <p className="border-b px-3 py-1.5 font-mono text-[11px] text-muted-foreground truncate" title={builtExe}>{builtExe}</p>}
            {error && <p role="alert" className="border-b px-3 py-2 text-xs text-destructive whitespace-pre-wrap">{error}</p>}
            {log.length > 0 && (
              <pre ref={logRef} className="max-h-52 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-muted-foreground">
                {log.map((l, i) => <span key={i} className={cn("block", l.err && "text-amber-300")}>{l.line}</span>)}
              </pre>
            )}
          </div>
        )}

        <DialogFooter>
          {(phase === "failed" || (phase === "built" && countdown === null)) && (
            <Button variant="ghost" onClick={reset}><RotateCw /> 처음부터</Button>
          )}
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={phase === "applying"}>{phase === "building" ? "뒤에서 계속 빌드" : "닫기"}</Button>
          {phase === "built" ? (
            <Button onClick={() => void apply()}><Hammer /> 지금 적용하고 다시 시작</Button>
          ) : (
            <Button onClick={start} disabled={busy || !info?.repo}>
              {busy ? <Loader2 className="animate-spin" /> : <Hammer />} {info?.in_place ? "종료하고 빌드 후 다시 시작" : "빌드하고 적용"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
