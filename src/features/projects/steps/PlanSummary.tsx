// Quick mode, second screen: what the agent decided, and what creation will install automatically.
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Download, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ipc, type StackInfo } from "@/lib/ipc";
import { useWizardStore } from "@/stores/wizard";
import { plannedInstalls } from "../install";
import { projectTypeLabel, targetOsLabel } from "../labels";
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
  const [stack, setStack] = useState<StackInfo | null>(null);

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
  const installs = useMemo(() => (plan ? plannedInstalls(plan.missing_tools) : { auto: [], manual: [] }), [plan]);
  if (!plan) return null;

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

      {installs.auto.length === 0 && installs.manual.length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="size-4" /> 필요한 도구가 모두 준비되어 있습니다. 바로 만들 수 있습니다.
        </div>
      ) : (
        <div className="grid gap-2">
          {installs.auto.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm" data-testid="plan-auto-install">
              <Download className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="grid gap-0.5">
                <div>
                  만들 때 자동으로 설치합니다: <span className="font-medium">{installs.auto.join(", ")}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  설치 프로그램이 관리자 권한을 요청하면 허용하세요. 다운로드 용량에 따라 몇 분 걸릴 수 있고, 진행 상황은 프로그레스 바로 표시됩니다.
                </p>
              </div>
            </div>
          )}
          {installs.manual.length > 0 && (
            <p className="text-xs text-muted-foreground">
              직접 설치해야 하는 도구: <span className="font-medium">{installs.manual.join(", ")}</span> (프로젝트는 먼저 만들어지고, 설치 전에는 빌드가 실패합니다)
            </p>
          )}
        </div>
      )}
    </div>
  );
}
