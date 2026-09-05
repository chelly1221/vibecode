// Windows toolchain rows (rust, msvc, node, dotnet ...) with a winget install action. Shown in the
// quick-mode summary when the project is built from WSL for Windows.
import { CheckCircle2, Download, RefreshCw, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ipc, type WindowsToolStatus } from "@/lib/ipc";
import { hostPowershellCommand } from "@/features/terminal/commands";
import { openTerminalWith } from "@/stores/terminal";
import { missingToolchains } from "./toolchain";

interface Props {
  statuses: WindowsToolStatus[];
  onRefresh: () => void;
  refreshing?: boolean;
}

export async function installToolchains(names: string[]): Promise<void> {
  if (names.length === 0) return;
  const script = await ipc.toolchain.installScript(names);
  openTerminalWith(hostPowershellCommand(script, "Windows 툴체인 설치"), null);
}

export function ToolchainStatus({ statuses, onRefresh, refreshing }: Props) {
  const missing = missingToolchains(statuses);
  const install = () =>
    installToolchains(missing.map((m) => m.name)).catch((e) => toast.error(`설치 명령을 만들지 못했습니다: ${String(e)}`));
  return (
    <div className="rounded-lg border">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div>
          <div className="text-sm font-medium">Windows 툴체인</div>
          <p className="text-xs text-muted-foreground">이 프로그램은 Windows용이라 WSL 안에서도 Windows 빌드 도구를 씁니다. 만들 때 WSL 연결(shim)은 자동으로 갱신됩니다.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} /> 다시 확인
        </Button>
      </div>
      <ul className="divide-y text-sm">
        {statuses.map((t) => (
          <li key={t.name} className="flex items-center gap-2 px-3 py-1.5">
            {t.found ? <CheckCircle2 className="size-4 shrink-0 text-emerald-600" /> : <XCircle className="size-4 shrink-0 text-destructive" />}
            <span className="min-w-0 flex-1 truncate">{t.label}</span>
            <span className="truncate text-xs text-muted-foreground" title={t.path ?? ""}>
              {t.found ? t.version ?? "설치됨" : "없음"}
            </span>
          </li>
        ))}
      </ul>
      {missing.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
          <p className="text-xs text-muted-foreground">
            Windows PowerShell 창이 열리고 winget으로 설치합니다. 관리자 권한 창이 뜨면 허용하세요. 끝나면 "다시 확인"을 누르세요.
          </p>
          <Button size="sm" onClick={install}>
            <Download className="size-3.5" /> Windows에 설치 ({missing.length}개)
          </Button>
        </div>
      )}
    </div>
  );
}
