import { useEffect } from "react";
import { FolderPlus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useWizardStore } from "@/stores/wizard";
import { StackCard } from "../StackCard";
import { projectTypeLabel, targetOsLabel } from "../labels";

export function StepStack() {
  const form = useWizardStore((s) => s.form);
  const stacks = useWizardStore((s) => s.stacks);
  const stacksLoading = useWizardStore((s) => s.stacksLoading);
  const tools = useWizardStore((s) => s.tools);
  const loadStacks = useWizardStore((s) => s.loadStacks);
  const loadTools = useWizardStore((s) => s.loadTools);
  const setField = useWizardStore((s) => s.setField);

  useEffect(() => {
    loadStacks().catch((e) => toast.error(`스택 목록을 불러오지 못했습니다: ${e}`));
    void loadTools();
  }, [loadStacks, loadTools, form.targetOs, form.projectType]);

  const choose = (id: string | null) => {
    setField("stackId", id);
    setField("stackChosen", true);
  };
  const emptySelected = form.stackChosen && form.stackId === null;

  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{targetOsLabel(form.targetOs)}</span> ·{" "}
        <span className="font-medium text-foreground">{projectTypeLabel(form.projectType)}</span>에 맞는 스택입니다. 필요 도구가 없으면 온보딩/설정에서 설치하세요.
      </p>
      {stacksLoading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 스택을 불러오는 중…
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {stacks.map((st) => (
            <StackCard
              key={st.id}
              stack={st}
              tools={tools}
              projectName={form.name}
              selected={form.stackChosen && form.stackId === st.id}
              onSelect={() => choose(st.id)}
            />
          ))}
          <button
            type="button"
            onClick={() => choose(null)}
            aria-pressed={emptySelected}
            className={cn(
              "flex h-full min-h-28 flex-col items-start justify-center gap-2 rounded-xl border border-dashed bg-card p-3 text-left text-sm hover:bg-muted/50",
              emptySelected && "border-primary ring-2 ring-primary/30",
            )}
          >
            <FolderPlus className="size-5 text-muted-foreground" />
            <span className="font-semibold">스택 없이 빈 프로젝트</span>
            <span className="text-xs text-muted-foreground">폴더와 git, 에이전트 지침 파일만 만들고 구조는 에이전트에게 맡깁니다.</span>
          </button>
        </div>
      )}
      {!stacksLoading && stacks.length === 0 && (
        <p className="text-xs text-muted-foreground">이 조합에 등록된 스택이 없습니다. 빈 프로젝트로 시작하세요.</p>
      )}
    </div>
  );
}
