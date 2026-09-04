import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAppStore } from "@/stores/app";
import { useWizardStore } from "@/stores/wizard";
import { ConfirmDialog } from "./ConfirmDialog";
import { StepIndicator } from "./StepIndicator";
import { StepBasics } from "./steps/StepBasics";
import { StepCreate } from "./steps/StepCreate";
import { StepOptions } from "./steps/StepOptions";
import { StepStack } from "./steps/StepStack";
import { StepTarget } from "./steps/StepTarget";
import { StepType } from "./steps/StepType";

/** Multi-step project creation dialog. Open state lives in the app store. */
export function ProjectWizard() {
  const open = useAppStore((s) => s.wizardOpen);
  const setWizardOpen = useAppStore((s) => s.setWizardOpen);
  const settings = useAppStore((s) => s.settings);
  const loadProjects = useAppStore((s) => s.loadProjects);
  const selectProject = useAppStore((s) => s.selectProject);
  const setNewSessionOpen = useAppStore((s) => s.setNewSessionOpen);

  const step = useWizardStore((s) => s.step);
  const scaffold = useWizardStore((s) => s.scaffold);
  const reset = useWizardStore((s) => s.reset);
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
      reset(settings);
      setMaxReached(0);
    }
    wasOpen.current = open;
  }, [open, reset, settings]);

  useEffect(() => {
    setMaxReached((m) => Math.max(m, step));
  }, [step]);

  // Once creation finishes, refresh the project list and select the new project.
  const createdId = scaffold.status === "done" ? scaffold.project?.id : undefined;
  useEffect(() => {
    if (!createdId) return;
    loadProjects()
      .then(() => selectProject(createdId))
      .catch((e) => console.error("reload projects", e));
  }, [createdId, loadProjects, selectProject]);

  const close = () => setWizardOpen(false);
  const requestClose = (nextOpen: boolean) => {
    if (nextOpen) return;
    if (scaffold.status === "running") {
      setConfirmClose(true);
      return;
    }
    close();
  };

  const startSession = () => {
    close();
    setNewSessionOpen(true);
  };

  const running = scaffold.status === "running";

  return (
    <>
      <Dialog open={open} onOpenChange={requestClose}>
        <DialogContent className="flex h-[85vh] max-h-[85vh] flex-col gap-3 sm:max-w-4xl" showCloseButton={!running}>
          <DialogHeader className="gap-2">
            <DialogTitle>새 프로젝트</DialogTitle>
            <DialogDescription className="sr-only">프로젝트 생성 마법사</DialogDescription>
            <StepIndicator current={step} maxReachable={running || step === 5 ? 0 : maxReached} onSelect={goTo} />
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-1">
            {step === 0 && <StepBasics />}
            {step === 1 && <StepTarget />}
            {step === 2 && <StepType />}
            {step === 3 && <StepStack />}
            {step === 4 && <StepOptions />}
            {step === 5 && <StepCreate onStartSession={startSession} onClose={close} />}
          </div>

          {step < 5 && (
            <div className="flex items-center justify-between border-t pt-3">
              <div className="text-xs text-muted-foreground">{error ?? (step === 4 ? `"${form.name}" 프로젝트를 만들 준비가 되었습니다.` : "")}</div>
              <div className="flex gap-2">
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
        title="생성이 진행 중입니다"
        description="지금 닫으면 진행 로그를 볼 수 없습니다. 백그라운드 작업은 계속 실행됩니다. 닫을까요?"
        confirmLabel="닫기"
        onConfirm={close}
      />
    </>
  );
}
