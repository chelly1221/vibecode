import { useEffect, useMemo, useState } from "react";
import { Bot, FolderPlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppStore } from "@/stores/app";
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
  const aiRecs = useWizardStore((s) => s.aiRecs);
  const aiLoading = useWizardStore((s) => s.aiLoading);
  const askAi = useWizardStore((s) => s.askAi);
  const provider = useAppStore((s) => s.settings?.default_provider ?? "claude");
  const [needDesc, setNeedDesc] = useState(false);

  const scoreById = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of aiRecs ?? []) m.set(r.stack_id, r.score);
    return m;
  }, [aiRecs]);
  const ordered = useMemo(() => {
    if (!aiRecs) return stacks;
    return [...stacks].sort((a, b) => (scoreById.get(b.id) ?? -1) - (scoreById.get(a.id) ?? -1));
  }, [stacks, aiRecs, scoreById]);
  const stackName = (id: string) => stacks.find((s) => s.id === id)?.name ?? id;

  const runAi = async () => {
    if (!form.description.trim()) {
      setNeedDesc(true);
      return;
    }
    setNeedDesc(false);
    try {
      await askAi(provider);
    } catch (e) {
      const msg = String(e);
      toast.error(/not implemented/i.test(msg) ? "AI 추천은 아직 준비 중입니다" : `AI 추천 실패: ${msg}`);
    }
  };

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
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-2">
        <Bot className="size-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">프로젝트 설명을 바탕으로 에이전트에게 스택을 추천받을 수 있습니다.</span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={runAi} disabled={aiLoading || stacksLoading}>
          {aiLoading ? <Loader2 className="size-3.5 animate-spin" /> : <Bot className="size-3.5" />} AI에게 물어보기
        </Button>
        {needDesc && (
          <div className="flex w-full items-center gap-2">
            <Input
              autoFocus
              value={form.description}
              placeholder="어떤 프로그램인지 한 줄로 설명하세요 (예: 사진을 정리해 주는 데스크톱 앱)"
              onChange={(e) => setField("description", e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runAi()}
              className="h-8 text-xs"
            />
            <Button size="sm" onClick={runAi} disabled={!form.description.trim() || aiLoading}>
              추천 받기
            </Button>
          </div>
        )}
      </div>
      {aiRecs && aiRecs.length > 0 && (
        <ol className="space-y-1 rounded-lg bg-muted/40 p-2 text-xs">
          {aiRecs.slice(0, 5).map((r, i) => (
            <li key={r.stack_id} className="flex items-start gap-2">
              <span className="w-4 shrink-0 text-right font-mono text-muted-foreground">{i + 1}.</span>
              <button type="button" className="font-medium hover:underline" onClick={() => choose(r.stack_id)} disabled={!stacks.some((s) => s.id === r.stack_id)}>
                {stackName(r.stack_id)}
              </button>
              <span className="shrink-0 font-mono text-muted-foreground">{r.score}점</span>
              <span className="min-w-0 flex-1 text-muted-foreground">{r.reason}</span>
            </li>
          ))}
        </ol>
      )}
      {aiRecs && aiRecs.length === 0 && <p className="text-xs text-muted-foreground">AI가 추천할 스택을 찾지 못했습니다.</p>}
      {stacksLoading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 스택을 불러오는 중…
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {ordered.map((st) => (
            <StackCard
              key={st.id}
              stack={st}
              tools={tools}
              projectName={form.name}
              selected={form.stackChosen && form.stackId === st.id}
              onSelect={() => choose(st.id)}
              aiScore={scoreById.get(st.id) ?? null}
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
