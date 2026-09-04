import { CheckCircle2, Download, RefreshCw, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { BackendKind } from "@/lib/bindings/BackendKind";
import type { ToolStatus } from "@/lib/bindings/ToolStatus";
import { openTerminalWith } from "@/stores/terminal";
import { installCommand } from "@/features/terminal/commands";
import { sortTools } from "./recommend";

interface Props {
  tools: ToolStatus[] | null;
  loading: boolean;
  backend: BackendKind;
  onRefresh: () => void;
  compact?: boolean;
}

/** Detected CLI tools with install actions. Shared by onboarding and settings. */
export function ToolsTable({ tools, loading, backend, onRefresh, compact }: Props) {
  return (
    <div className="rounded-lg border">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">도구 감지 결과</span>
        <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} /> 다시 검사
        </Button>
      </div>
      {tools === null ? (
        <div className="p-4 text-sm text-muted-foreground">{loading ? "검사 중..." : "아직 검사하지 않았습니다"}</div>
      ) : tools.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">감지된 도구 정보가 없습니다</div>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {sortTools(tools).map((t) => (
              <tr key={t.name} className="border-b last:border-b-0">
                <td className="w-8 px-3 py-1.5">
                  {t.found ? <CheckCircle2 className="size-4 text-emerald-600" /> : <XCircle className="size-4 text-muted-foreground" />}
                </td>
                <td className="px-2 py-1.5 font-mono text-xs">{t.name}</td>
                <td className="px-2 py-1.5 text-xs text-muted-foreground">{t.version ?? (t.found ? "버전 미확인" : "없음")}</td>
                {!compact && (
                  <td className="max-w-[16rem] truncate px-2 py-1.5 font-mono text-[11px] text-muted-foreground" title={t.path ?? ""}>
                    {t.path ?? ""}
                  </td>
                )}
                <td className="px-2 py-1.5 text-right">
                  {!t.found && t.install_hint ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      title={t.install_hint}
                      onClick={() => openTerminalWith(installCommand(t.install_hint!, backend, `${t.name} 설치`), null)}
                    >
                      <Download className="size-3.5" /> 터미널에서 설치
                    </Button>
                  ) : !t.found ? (
                    <Badge variant="outline">선택</Badge>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
