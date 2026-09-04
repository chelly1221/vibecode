import { useWizardStore } from "@/stores/wizard";
import { PROJECT_TYPE_OPTIONS } from "../labels";
import { OptionGrid } from "./OptionGrid";

export function StepType() {
  const projectType = useWizardStore((s) => s.form.projectType);
  const setField = useWizardStore((s) => s.setField);
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">만들려는 프로그램의 종류를 선택하세요.</p>
      <OptionGrid
        options={PROJECT_TYPE_OPTIONS}
        value={projectType}
        onChange={(v) => {
          setField("projectType", v);
          setField("stackChosen", false);
          setField("stackId", null);
        }}
      />
    </div>
  );
}
