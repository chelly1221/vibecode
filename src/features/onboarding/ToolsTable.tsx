import { CheckCircle2, Download, Loader2, RefreshCw, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ToolStatus } from "@/lib/bindings/ToolStatus";
import { runnableHint } from "@/features/projects/install";
import { useToolInstalls } from "./toolInstall";

/** Display order: agents first, then git, then language toolchains. */
const PRIMARY_TOOLS = ["claude", "codex", "git", "gh", "node", "npm", "cargo", "rustup", "msvc", "python", "uv", "dotnet", "go", "java", "flutter"];

export function sortTools(tools: ToolStatus[]): ToolStatus[] {
  const rank = (n: string) => {
    const i = PRIMARY_TOOLS.indexOf(n);
    return i === -1 ? 100 : i;
  };
  return [...tools].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

export function toolFound(tools: ToolStatus[] | null | undefined, name: string): boolean {
  return !!tools?.find((t) => t.name === name && t.found);
}

interface Props {
  tools: ToolStatus[] | null;
  loading: boolean;
  onRefresh: () => void;
  compact?: boolean;
}

/** Detected CLI tools with one-click installs (progress shown inline). Shared by onboarding and settings. */
export function ToolsTable({ tools, loading, onRefresh, compact }: Props) {
  const installs = useToolInstalls(() => onRefresh());
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
                  {(() => {
                    const st = installs.byName[t.name];
                    if (st?.running) {
                      return (
                        <span className="inline-flex max-w-[18rem] items-center gap-1.5 text-xs text-muted-foreground" title={st.lines.join("\n")}>
                          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
                          <span className="truncate">{st.lines[st.lines.length - 1] ?? "설치 중…"}</span>
                        </span>
                      );
                    }
                    if (!t.found && runnableHint(t.install_hint)) {
                      return (
                        <span className="inline-flex items-center gap-2">
                          {st?.ok === false && (
                            <span className="max-w-[14rem] truncate text-xs text-destructive" title={st.message ?? ""}>
                              {st.message}
                            </span>
                          )}
                          <Button variant="outline" size="sm" className="h-7 text-xs" title={t.install_hint ?? ""} onClick={() => void installs.install(t.name)}>
                            <Download className="size-3.5" /> {st?.ok === false ? "다시 설치" : "설치"}
                          </Button>
                        </span>
                      );
                    }
                    if (!t.found && t.install_hint) {
                      return (
                        <a className="text-xs text-primary underline-offset-2 hover:underline" href={t.install_hint.split(" ")[0]} target="_blank" rel="noreferrer">
                          설치 안내
                        </a>
                      );
                    }
                    if (!t.found) return <Badge variant="outline">선택</Badge>;
                    return null;
                  })()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
