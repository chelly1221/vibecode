import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Rocket, Settings2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAppStore } from "@/stores/app";
import { useWizardStore } from "@/stores/wizard";
import { ConfirmDialog } from "./ConfirmDialog";
import { buildFirstPrompt, startFirstSession } from "./firstSession";
import { StepIndicator } from "./StepIndicator";
import { PlanSummary } from "./steps/PlanSummary";
import { StepBasics } from "./steps/StepBasics";
import { StepCreate } from "./steps/StepCreate";
import { StepDescribe } from "./steps/StepDescribe";
import { StepOptions } from "./steps/StepOptions";
import { StepStack } from "./steps/StepStack";
import { StepTarget } from "./steps/StepTarget";
import { StepType } from "./steps/StepType";

/**
 * Project creation dialog. Opens in quick mode (describe in one line → the agent picks the
 * configuration → summary → create → first session starts automatically); "고급" switches to the
 * six-step wizard with the same form. Open state lives in the app store.
 */
export function ProjectWizard() {
  const open = useAppStore((s) => s.wizardOpen);
  const setWizardOpen = useAppStore((s) => s.setWizardOpen);
  const settings = useAppStore((s) => s.settings);
  const loadProjects = useAppStore((s) => s.loadProjects);
  const selectProject = useAppStore((s) => s.selectProject);
  const setNewSessionOpen = useAppStore((s) => s.setNewSessionOpen);

  const step = useWizardStore((s) => s.step);
  const mode = useWizardStore((s) => s.mode);
  const quickView = useWizardStore((s) => s.quickView);
  const planLoading = useWizardStore((s) => s.planLoading);
  const autoStart = useWizardStore((s) => s.autoStart);
  const scaffold = useWizardStore((s) => s.scaffold);
  const reset = useWizardStore((s) => s.reset);
  const setMode = useWizardStore((s) => s.setMode);
  const setQuickView = useWizardStore((s) => s.setQuickView);
  const runPlan = useWizardStore((s) => s.runPlan);
  const next = useWizardStore((s) => s.next);
  const prev = useWizardStore((s) => s.prev);
  const goTo = useWizardStore((s) => s.goTo);
  const stepError = useWizardStore((s) => s.stepError);
  const runCreate = useWizardStore((s) => s.runCreate);
  // Subscribe to the form so the footer re-validates as the user types.
  const form = useWizardStore((s) => s.form);
  const error = stepError();
  const [confirmClose, setConfirmClose] = useState(false);
  const [maxReached, setMaxReached] = useState(0);

  // Reset only when the dialog transitions to open (not when settings change mid-flight).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const pending = useWizardStore.getState();
      if (pending.scaffold.status !== "running" && !pending.planLoading && pending.autoStart !== "starting") {
        reset(settings);
        setMaxReached(0);
      }
    }
    wasOpen.current = open;
  }, [open, reset, settings]);

  useEffect(() => {
    setMaxReached((m) => Math.max(m, step));
  }, [step]);

  const close = () => setWizardOpen(false);

  // Once creation finishes, refresh the project list and select the new project. In quick mode the
  // first session starts right away with the user's description as the first instruction.
  const created = scaffold.status === "done" ? scaffold.project : null;
  const createdId = created?.id;
  useEffect(() => {
    if (!created || !createdId) return;
    let cancelled = false;
    (async () => {
      try {
        await loadProjects();
      } catch (e) {
        console.error("reload projects", e);
      }
      if (cancelled) return;
      selectProject(createdId);
      const st = useWizardStore.getState();
      if (st.mode !== "quick" || st.autoStart !== "idle") return;
      st.setAutoStart("starting");
      try {
        await startFirstSession(created, buildFirstPrompt(st.form.description));
        if (cancelled) return;
        useWizardStore.getState().setAutoStart("done");
        setWizardOpen(false);
      } catch (e) {
        if (cancelled) return;
        useWizardStore.getState().setAutoStart("failed", String(e));
        toast.error("첫 대화를 자동으로 시작하지 못했습니다", { description: String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createdId]);

  const requestClose = (nextOpen: boolean) => {
    if (nextOpen) return;
    if (scaffold.status === "running" || planLoading || autoStart === "starting") {
      setConfirmClose(true);
      return;
    }
    close();
  };

  const startSession = () => {
    close();
    setNewSessionOpen(true);
  };

  const toAdvanced = () => {
    setMode("advanced");
    // Everything the plan filled in is valid, so let the user jump between steps freely.
    setMaxReached(useWizardStore.getState().plan ? 5 : 0);
  };

  const plan = () => {
    void runPlan(form.provider ?? "claude");
  };

  const running = scaffold.status === "running" || autoStart === "starting";
  const quick = mode === "quick" && step < 5;
  const canPlan = form.description.trim().length >= 4 && form.parentDir.trim().length > 0 && !!form.accounts[form.provider ?? "claude"];

  return (
    <>
      <Dialog open={open} onOpenChange={requestClose}>
        <DialogContent className="flex h-[85vh] max-h-[85vh] flex-col gap-3 sm:max-w-4xl" showCloseButton={!running && !planLoading}>
          <DialogHeader className="gap-2">
            <DialogTitle>새 프로젝트</DialogTitle>
            {quick ? (
              <DialogDescription>
                {quickView === "describe" ? "무엇을 만들지 한 줄로 적으면 AI가 만드는 방법을 제안합니다. 확인한 뒤 만들기를 시작할 수 있어요." : "구성을 확인하고 만들기를 누르세요. 없는 도구는 만들면서 자동으로 설치되고, 끝나면 첫 대화가 바로 시작됩니다."}
              </DialogDescription>
            ) : (
              <>
                <DialogDescription className="sr-only">프로젝트 생성 마법사</DialogDescription>
                <StepIndicator current={step} maxReachable={running || step === 5 ? 0 : maxReached} onSelect={goTo} />
              </>
            )}
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-1">
            {quick && quickView === "describe" && <StepDescribe onAdvanced={toAdvanced} />}
            {quick && quickView === "summary" && <PlanSummary />}
            {!quick && step === 0 && <StepBasics />}
            {!quick && step === 1 && <StepTarget />}
            {!quick && step === 2 && <StepType />}
            {!quick && step === 3 && <StepStack />}
            {!quick && step === 4 && <StepOptions />}
            {step === 5 && <StepCreate onStartSession={startSession} onClose={close} />}
          </div>

          {quick && quickView === "describe" && (
            <div className="flex items-center justify-between border-t pt-3">
              <div className="text-xs text-muted-foreground">{!form.accounts[form.provider ?? "claude"] ? "사용할 AI 계정을 선택하세요." : !form.parentDir.trim() ? "프로젝트를 만들 폴더를 선택하세요." : ""}</div>
              <Button onClick={plan} disabled={!canPlan || planLoading}>
                {planLoading ? <Loader2 className="animate-spin" /> : <Sparkles />} 만드는 방법 제안받기
              </Button>
            </div>
          )}

          {quick && quickView === "summary" && (
            <div className="flex items-center justify-between border-t pt-3">
              <Button variant="ghost" onClick={() => setQuickView("describe")}>
                <ChevronLeft /> 다시 설명하기
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={toAdvanced}>
                  <Settings2 /> 바꾸기 (고급)
                </Button>
                <Button onClick={() => void runCreate()}>
                  <Rocket /> 이대로 만들기
                </Button>
              </div>
            </div>
          )}

          {!quick && step < 5 && (
            <div className="flex items-center justify-between border-t pt-3">
              <div className="text-xs text-muted-foreground">{error ?? (step === 4 ? `"${form.name}" 프로젝트를 만들 준비가 되었습니다.` : "")}</div>
              <div className="flex gap-2">
                {step === 0 && (
                  <Button variant="ghost" onClick={() => setMode("quick")}>
                    <Sparkles /> AI에게 맡기기
                  </Button>
                )}
                <Button variant="outline" onClick={prev} disabled={step === 0}>
                  <ChevronLeft /> 이전
                </Button>
                {step < 4 ? (
                  <Button onClick={next} disabled={!!error}>
                    다음 <ChevronRight />
                  </Button>
                ) : (
                  <Button onClick={() => void runCreate()} disabled={!!error}>
                    <Rocket /> 생성 시작
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title={scaffold.status === "running" ? "생성이 진행 중입니다" : "작업이 진행 중입니다"}
        description={scaffold.status === "running" ? "지금 닫으면 진행 로그를 볼 수 없습니다. 백그라운드 작업은 계속 실행됩니다. 닫을까요?" : "AI 응답이나 첫 대화 시작을 기다리는 중입니다. 지금 닫을까요?"}
        confirmLabel="닫기"
        onConfirm={() => {
          useWizardStore.getState().setAutoStart("done");
          close();
        }}
      />
    </>
  );
}
