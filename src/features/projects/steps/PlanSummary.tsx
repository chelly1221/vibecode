// Quick mode, second screen: what the agent decided, plus install status of what the stack needs.
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Download, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ipc, type StackInfo } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";
import { useWizardStore } from "@/stores/wizard";
import { installCommand } from "@/features/terminal/commands";
import { openTerminalWith } from "@/stores/terminal";
import { projectTypeLabel, targetOsLabel } from "../labels";
import { ToolchainStatus } from "../ToolchainStatus";
import { joinPath } from "../validation";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 rounded-lg border p-3">
      <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export function PlanSummary() {
  const plan = useWizardStore((s) => s.plan);
  const form = useWizardStore((s) => s.form);
  const refreshPlanTools = useWizardStore((s) => s.refreshPlanTools);
  const backend = useAppStore((s) => s.settings?.backend.kind ?? "native");
  const [stack, setStack] = useState<StackInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!plan?.stack_id) {
      setStack(null);
      return;
    }
    let cancelled = false;
    ipc.projects
      .stacksList()
      .then((all) => !cancelled && setStack(all.find((s) => s.id === plan.stack_id) ?? null))
      .catch(() => !cancelled && setStack(null));
    return () => {
      cancelled = true;
    };
  }, [plan?.stack_id]);

  const fullPath = useMemo(() => (plan ? joinPath(form.parentDir, plan.dir_name) : ""), [plan, form.parentDir]);
  if (!plan) return null;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshPlanTools();
    } finally {
      setRefreshing(false);
    }
  };
  const allReady = plan.missing_tools.length === 0 && plan.windows_toolchain.every((t) => t.found);

  return (
    <div className="grid gap-4">
      <div className="rounded-xl border bg-primary/5 p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Sparkles className="size-3.5 text-primary" /> AI가 정한 구성입니다. 마음에 들지 않으면 "바꾸기"로 직접 고칠 수 있습니다.
        </div>
        <h3 className="mt-2 text-xl font-semibold tracking-tight">{plan.name}</h3>
        <p className="mt-1 text-sm">{plan.summary}</p>
        {plan.reason && <p className="mt-2 text-xs text-muted-foreground">{plan.reason}</p>}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Fact label="만드는 방식">
          {stack ? (
            <div className="grid gap-1">
              <span className="font-medium">{stack.name}</span>
              <span className="text-xs text-muted-foreground">{stack.summary}</span>
              <div className="flex flex-wrap gap-1">
                {stack.languages.map((l) => (
                  <Badge key={l} variant="outline" className="h-4 px-1 text-[10px]">
                    {l}
                  </Badge>
                ))}
              </div>
            </div>
          ) : plan.stack_id ? (
            <span className="font-mono text-xs">{plan.stack_id}</span>
          ) : (
            <span>빈 프로젝트 (구조는 AI가 첫 대화에서 만듭니다)</span>
          )}
        </Fact>
        <div className="grid gap-2">
          <Fact label="어디서 쓰나요">
            {targetOsLabel(plan.target_os)} · {projectTypeLabel(plan.project_type)}
          </Fact>
          <Fact label="폴더">
            <code className="break-all font-mono text-xs">{fullPath}</code>
          </Fact>
        </div>
      </div>

      {allReady ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="size-4" /> 필요한 도구가 모두 준비되어 있습니다. 바로 만들 수 있습니다.
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          아래 도구가 없어도 프로젝트는 만들 수 있지만, 설치 전에는 빌드나 실행이 실패합니다. 설치 후 "다시 확인"을 누르세요.
        </p>
      )}

      {plan.missing_tools.length > 0 && (
        <div className="rounded-lg border">
          <div className="border-b px-3 py-2 text-sm font-medium">설치가 필요한 도구</div>
          <ul className="divide-y text-sm">
            {plan.missing_tools.map((t) => (
              <li key={t.name} className="flex items-center gap-2 px-3 py-1.5">
                <span className="min-w-0 flex-1 font-mono text-xs">{t.name}</span>
                {t.install_hint ? (
                  <Button size="sm" variant="outline" className="h-7 text-xs" title={t.install_hint} onClick={() => openTerminalWith(installCommand(t.install_hint!, backend, `${t.name} 설치`), null)}>
                    <Download className="size-3.5" /> 터미널에서 설치
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">수동 설치 필요</span>
                )}
              </li>
            ))}
          </ul>
          <div className="flex justify-end border-t px-3 py-1.5">
            <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing}>
              다시 확인
            </Button>
          </div>
        </div>
      )}

      {plan.windows_toolchain.length > 0 && <ToolchainStatus statuses={plan.windows_toolchain} onRefresh={refresh} refreshing={refreshing} />}
    </div>
  );
}
