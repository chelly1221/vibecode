// App updates through GitHub Releases (tauri-plugin-updater).
import { useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

function describeError(e: unknown): string {
  const msg = String(e);
  if (/404|not found|Could not fetch a valid release/i.test(msg)) return "아직 배포된 릴리스가 없습니다.";
  return msg;
}

export function UpdateSection() {
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number | null } | null>(null);

  const doCheck = async () => {
    setChecking(true);
    setStatus(null);
    try {
      const u = await check();
      if (u) {
        setUpdate(u);
        setStatus(`새 버전 ${u.version} 이 있습니다.`);
      } else {
        setUpdate(null);
        setStatus("최신 버전입니다.");
      }
    } catch (e) {
      setUpdate(null);
      setStatus(describeError(e));
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    if (!update) return;
    setProgress({ done: 0, total: null });
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") setProgress({ done: 0, total: ev.data.contentLength ?? null });
        else if (ev.event === "Progress") setProgress((p) => ({ done: (p?.done ?? 0) + ev.data.chunkLength, total: p?.total ?? null }));
        else if (ev.event === "Finished") setProgress((p) => ({ done: p?.total ?? p?.done ?? 0, total: p?.total ?? null }));
      });
      toast.success("설치가 끝났습니다. 다시 시작합니다.");
      await relaunch();
    } catch (e) {
      toast.error(`업데이트 실패: ${String(e)}`);
      setProgress(null);
    }
  };

  const pct = progress?.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">업데이트</h3>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={doCheck} disabled={checking || !!progress}>
          {checking ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} 업데이트 확인
        </Button>
        {update && !progress && (
          <Button size="sm" onClick={install}>
            <Download className="size-4" /> 다운로드 및 설치 ({update.version})
          </Button>
        )}
        {status && <span className="text-xs text-muted-foreground">{status}</span>}
      </div>
      {update?.body && !progress && <pre className="max-h-32 overflow-auto rounded-md border bg-muted p-2 text-xs whitespace-pre-wrap">{update.body}</pre>}
      {progress && (
        <div className="space-y-1">
          <Progress value={pct ?? 0} />
          <div className="text-[11px] text-muted-foreground">{pct !== null ? `${pct}%` : "다운로드 중…"}</div>
        </div>
      )}
    </section>
  );
}
