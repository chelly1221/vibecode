import { CheckCircle2, Loader2, MessageSquarePlus, RotateCcw, XCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useWizardStore } from "@/stores/wizard";
import { ScaffoldLog } from "../ScaffoldLog";

interface StepCreateProps {
  onStartSession: () => void;
  onClose: () => void;
}

export function StepCreate({ onStartSession, onClose }: StepCreateProps) {
  const scaffold = useWizardStore((s) => s.scaffold);
  const autoStart = useWizardStore((s) => s.autoStart);
  const autoStartError = useWizardStore((s) => s.autoStartError);
  const runCreate = useWizardStore((s) => s.runCreate);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {scaffold.status === "done" && scaffold.project && (
        <Alert>
          <CheckCircle2 className="text-emerald-600" />
          <AlertTitle>프로젝트가 만들어졌습니다</AlertTitle>
          <AlertDescription>
            <code className="font-mono text-xs">{scaffold.project.path}</code>
          </AlertDescription>
        </Alert>
      )}
      {scaffold.status === "failed" && (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>생성에 실패했습니다</AlertTitle>
          <AlertDescription className="break-all whitespace-pre-wrap">{scaffold.error ?? "알 수 없는 오류"}</AlertDescription>
        </Alert>
      )}
      {autoStart === "starting" && (
        <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin text-primary" /> 첫 대화를 시작하고 설명을 AI에게 전달하는 중…
        </div>
      )}
      {autoStart === "failed" && (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>첫 대화를 자동으로 시작하지 못했습니다</AlertTitle>
          <AlertDescription className="break-all whitespace-pre-wrap text-xs">{autoStartError ?? ""}</AlertDescription>
        </Alert>
      )}
      <ScaffoldLog scaffold={scaffold} />
      {scaffold.status !== "running" && autoStart !== "starting" && (
        <div className="flex justify-end gap-2">
          {scaffold.status === "failed" && (
            <Button variant="outline" onClick={() => void runCreate()}>
              <RotateCcw /> 다시 시도
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            닫기
          </Button>
          {scaffold.status === "done" && (
            <Button onClick={onStartSession}>
              <MessageSquarePlus /> 첫 세션 시작
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
