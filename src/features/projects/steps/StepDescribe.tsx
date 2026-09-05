// Quick mode, first screen: describe the program in plain language; the agent decides the rest.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, FolderOpen, Loader2, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAppStore } from "@/stores/app";
import { useWizardStore } from "@/stores/wizard";
import { registerExistingProject } from "../registerExisting";
import { pathWarnings } from "../validation";

const EXAMPLES = [
  "부서 비품을 등록하고 누가 언제 빌려갔는지 기록하는 웹앱",
  "폴더 안의 엑셀 파일 여러 개를 하나로 합쳐 주는 자동화 프로그램",
  "회의실 예약 현황을 한눈에 보여주고 예약할 수 있는 웹 페이지",
];

interface Props {
  onAdvanced: () => void;
}

export function StepDescribe({ onAdvanced }: Props) {
  const form = useWizardStore((s) => s.form);
  const setField = useWizardStore((s) => s.setField);
  const planLoading = useWizardStore((s) => s.planLoading);
  const planError = useWizardStore((s) => s.planError);
  const setWizardOpen = useAppStore((s) => s.setWizardOpen);
  const warnings = form.parentDir ? pathWarnings(form.parentDir) : [];

  const pickParent = async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false, title: "프로젝트를 만들 폴더 선택", defaultPath: form.parentDir || undefined });
      if (picked) setField("parentDir", picked);
    } catch (e) {
      toast.error(`폴더 선택 실패: ${e}`);
    }
  };

  const registerExisting = async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false, title: "등록할 프로젝트 폴더 선택" });
      if (!picked) return;
      await registerExistingProject(picked);
      setWizardOpen(false);
    } catch (e) {
      toast.error(`프로젝트를 등록하지 못했습니다: ${e}`);
    }
  };

  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <Label htmlFor="wz-describe" className="text-base">
          무엇을 만들까요?
        </Label>
        <Textarea
          id="wz-describe"
          autoFocus
          value={form.description}
          onChange={(e) => setField("description", e.target.value)}
          placeholder="만들고 싶은 프로그램을 평소 말하듯 적어 주세요. 누가 쓰는지, 무엇을 하는지, 어디서 쓰는지(웹/PC/휴대폰)가 있으면 더 좋습니다."
          className="min-h-32 text-sm"
          disabled={planLoading}
        />
        <div className="flex flex-wrap gap-1.5">
          <span className="text-xs text-muted-foreground">예시:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              disabled={planLoading}
              onClick={() => setField("description", ex)}
              className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {ex}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="wz-parent-quick">만들 위치</Label>
        <div className="flex gap-2">
          <Input id="wz-parent-quick" value={form.parentDir} onChange={(e) => setField("parentDir", e.target.value)} placeholder="C:\\code" className="font-mono" disabled={planLoading} />
          <Button type="button" variant="outline" onClick={pickParent} disabled={planLoading}>
            <FolderOpen /> 선택
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">이 폴더 안에 프로젝트 폴더가 새로 만들어집니다. 이름과 폴더명은 AI가 정합니다.</p>
        {warnings.map((w) => (
          <Alert key={w.kind} variant="destructive">
            <AlertTriangle />
            <AlertDescription>{w.message}</AlertDescription>
          </Alert>
        ))}
      </div>

      {planLoading && (
        <div className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin text-primary" />
          AI가 설치된 도구를 확인하고 구성을 정하는 중입니다. 보통 10~30초 걸립니다.
        </div>
      )}

      {planError && !planLoading && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>AI가 구성을 정하지 못했습니다</AlertTitle>
          <AlertDescription className="grid gap-2">
            <span className="break-all whitespace-pre-wrap text-xs">{planError}</span>
            <span className="text-xs">로그인이 안 되어 있거나 응답이 늦을 수 있습니다. 다시 시도하거나 아래에서 직접 단계별로 설정할 수 있습니다.</span>
            <div>
              <Button size="sm" variant="outline" onClick={onAdvanced}>
                <Settings2 className="size-3.5" /> 직접 설정하기
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
        <span>이미 만들어진 폴더가 있나요?</span>
        <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={registerExisting} disabled={planLoading}>
          기존 폴더 등록
        </button>
        <span className="ml-auto" />
        <button type="button" className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline" onClick={onAdvanced} disabled={planLoading}>
          <Settings2 className="size-3" /> 직접 단계별로 설정 (고급)
        </button>
      </div>
    </div>
  );
}
