import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { useAppStore } from "@/stores/app";
import { registerExistingProject } from "../registerExisting";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useWizardStore } from "@/stores/wizard";
import { joinPath, pathWarnings, toDirName, validateDirName, validateProjectName } from "../validation";

export function StepBasics() {
  const form = useWizardStore((s) => s.form);
  const setField = useWizardStore((s) => s.setField);
  const nameError = form.name ? validateProjectName(form.name) : null;
  const dirError = form.dirName || form.name ? validateDirName(form.dirName) : null;
  const fullPath = form.parentDir ? joinPath(form.parentDir, form.dirName || "…") : "";
  const warnings = form.parentDir ? pathWarnings(form.parentDir) : [];
  const onNameChange = (v: string) => {
    setField("name", v);
    if (!form.dirNameEdited) setField("dirName", toDirName(v));
  };

  const pickParent = async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false, title: "상위 폴더 선택", defaultPath: form.parentDir || undefined });
      if (picked) setField("parentDir", picked);
    } catch (e) {
      toast.error(`폴더 선택 실패: ${e}`);
    }
  };

  const setWizardOpen = useAppStore((s) => s.setWizardOpen);
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
    <div className="grid gap-4">
      <div className="grid gap-2 md:grid-cols-2">
        <div className="rounded-lg border border-primary bg-primary/5 p-3 text-sm">
          <div className="font-medium">새로 만들기</div>
          <p className="text-xs text-muted-foreground">이름과 위치를 정하고 스택을 골라 스캐폴딩합니다. 아래를 채우고 다음으로 진행하세요.</p>
        </div>
        <button type="button" onClick={registerExisting} className="rounded-lg border p-3 text-left text-sm transition-colors hover:bg-accent/40">
          <div className="font-medium">기존 폴더 등록</div>
          <p className="text-xs text-muted-foreground">이 앱으로 만들지 않은 프로젝트 폴더를 그대로 등록합니다. 스택을 자동 감지하고 필요하면 CLAUDE.md/AGENTS.md를 만들어 줍니다.</p>
        </button>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="wz-name">프로젝트 이름</Label>
        <Input
          id="wz-name"
          autoFocus
          value={form.name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="예: 재고 관리 앱 또는 my-app"
          aria-invalid={!!nameError}
        />
        {nameError && <p className="text-xs text-destructive">{nameError}</p>}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="wz-dir">폴더 · 패키지 이름 (영문)</Label>
        <Input
          id="wz-dir"
          value={form.dirName}
          onChange={(e) => {
            setField("dirName", e.target.value);
            setField("dirNameEdited", true);
          }}
          placeholder="예: inventory-app"
          aria-invalid={!!dirError}
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          npm · cargo · flutter 같은 도구는 영문 식별자를 요구하므로 실제 폴더와 패키지 이름은 이 값을 씁니다. 한글 이름은 앱 안에서 표시용으로만 쓰입니다.
        </p>
        {dirError && <p className="text-xs text-destructive">{dirError}</p>}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="wz-parent">상위 폴더</Label>
        <div className="flex gap-2">
          <Input
            id="wz-parent"
            value={form.parentDir}
            onChange={(e) => setField("parentDir", e.target.value)}
            placeholder="C:\\code"
            className="font-mono"
          />
          <Button type="button" variant="outline" onClick={pickParent}>
            <FolderOpen /> 선택
          </Button>
        </div>
        {fullPath && (
          <p className="text-xs text-muted-foreground">
            생성 위치: <code className="rounded bg-muted px-1 font-mono">{fullPath}</code>
          </p>
        )}
      </div>
      {warnings.map((w) => (
        <Alert key={w.kind} variant="destructive">
          <AlertTriangle />
          <AlertDescription>{w.message}</AlertDescription>
        </Alert>
      ))}
      <div className="grid gap-1.5">
        <Label htmlFor="wz-desc">한 줄 설명 (선택)</Label>
        <Input
          id="wz-desc"
          value={form.description}
          onChange={(e) => setField("description", e.target.value)}
          placeholder="예: 사진을 정리해 주는 Windows 유틸리티"
        />
        <p className="text-xs text-muted-foreground">CLAUDE.md / AGENTS.md에 프로젝트 목적으로 기록됩니다.</p>
      </div>
    </div>
  );
}
