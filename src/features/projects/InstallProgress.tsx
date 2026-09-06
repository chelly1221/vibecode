// Progress card for the automatic tool install that runs at the start of project creation:
// a bar over all missing tools, the one being installed now, and a terminal fallback for the
// ones that failed or were skipped (sudo password, manual download).
import { CheckCircle2, CircleDashed, Download, Loader2, MinusCircle, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ipc } from "@/lib/ipc";
import { hostPowershellCommand, installCommand } from "@/features/terminal/commands";
import { useAppStore } from "@/stores/app";
import { openTerminalWith } from "@/stores/terminal";
import type { ScaffoldState } from "@/stores/wizard";
import { installProgress, type InstallItem } from "./install";

function StatusIcon({ status }: { status: InstallItem["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 className="size-4 shrink-0 animate-spin text-primary" />;
    case "done":
      return <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />;
    case "failed":
      return <XCircle className="size-4 shrink-0 text-destructive" />;
    case "skipped":
      return <MinusCircle className="size-4 shrink-0 text-amber-500" />;
    default:
      return <CircleDashed className="size-4 shrink-0 text-muted-foreground" />;
  }
}

/** Open a terminal that runs the install by hand (Windows PowerShell for winget, backend shell for hints). */
async function openManualInstall(item: InstallItem, backend: "native" | "wsl"): Promise<void> {
  if (item.kind === "windows_toolchain") {
    const script = await ipc.toolchain.installScript([item.name]);
    openTerminalWith(hostPowershellCommand(script, `${item.label} 설치`), null);
    return;
  }
  if (!item.command) return;
  openTerminalWith(installCommand(item.command, backend, `${item.label} 설치`), null);
}

export function InstallProgress({ scaffold }: { scaffold: ScaffoldState }) {
  const backend = useAppStore((s) => s.settings?.backend.kind ?? "native");
  if (scaffold.installs.length === 0) return null;
  const p = installProgress(scaffold.installs, scaffold.installTotal);
  const installing = scaffold.status === "running" && p.current !== null;
  const canRetry = scaffold.status !== "running";
  const manual = (item: InstallItem) =>
    openManualInstall(item, backend).catch((e) => toast.error("설치 명령을 만들지 못했습니다", { description: String(e) }));

  return (
    <div className="rounded-lg border" data-testid="install-progress">
      <div className="grid gap-2 border-b px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Download className="size-4 text-primary" /> 필요한 도구 설치
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">
            {p.finished}/{p.total}
          </span>
        </div>
        <Progress value={p.percent} className="h-2" aria-label="도구 설치 진행률" />
        {installing && p.current && (
          <p className="text-xs text-muted-foreground">
            {p.current.label} 설치 중…{" "}
            {p.current.kind === "windows_toolchain" ? "관리자 권한을 요청하는 창이 뜨면 허용하세요. 다운로드 용량에 따라 몇 분 걸릴 수 있습니다." : "설치 스크립트를 실행하고 있습니다."}
          </p>
        )}
        {!installing && p.finished === p.total && p.failed.length === 0 && p.skipped.length === 0 && (
          <p className="text-xs text-emerald-700 dark:text-emerald-300">필요한 도구를 모두 설치했습니다.</p>
        )}
      </div>
      <ul className="divide-y text-sm">
        {scaffold.installs.map((it) => (
          <li key={`${it.kind}:${it.name}`} className="flex items-center gap-2 px-3 py-1.5">
            <StatusIcon status={it.status} />
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.message && (
              <span className="min-w-0 max-w-[50%] truncate text-xs text-muted-foreground" title={it.message}>
                {it.message}
              </span>
            )}
            {canRetry && (it.status === "failed" || it.status === "skipped") && (it.kind === "windows_toolchain" || it.command) && (
              <Button size="sm" variant="outline" className="h-7 text-xs" title={it.command ?? undefined} onClick={() => void manual(it)}>
                <Download className="size-3.5" /> 터미널에서 설치
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
