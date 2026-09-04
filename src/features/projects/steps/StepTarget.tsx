import { useWizardStore } from "@/stores/wizard";
import { TARGET_OS_OPTIONS } from "../labels";
import { OptionGrid } from "./OptionGrid";

export function StepTarget() {
  const targetOs = useWizardStore((s) => s.form.targetOs);
  const setField = useWizardStore((s) => s.setField);
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">프로그램이 실행될 환경을 선택하세요. 추천 스택이 이에 맞춰 달라집니다.</p>
      <OptionGrid
        options={TARGET_OS_OPTIONS}
        value={targetOs}
        onChange={(v) => {
          setField("targetOs", v);
          setField("stackChosen", false);
          setField("stackId", null);
        }}
      />
    </div>
  );
}
