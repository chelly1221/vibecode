// Shared option lists / labels for settings-like UIs (onboarding, settings dialog).
import type { Effort } from "@/lib/bindings/Effort";
import type { PermissionPreset } from "@/lib/bindings/PermissionPreset";
import type { Provider } from "@/lib/bindings/Provider";

export const PROVIDER_OPTIONS: { value: Provider; label: string; description: string }[] = [
  { value: "claude", label: "Claude", description: "Claude 계정으로 연결" },
  { value: "codex", label: "Codex", description: "ChatGPT 계정으로 연결" },
];

export const EFFORT_OPTIONS: { value: Effort; label: string; description: string }[] = [
  { value: "minimal", label: "최소", description: "간단한 요청을 빠르게 처리" },
  { value: "low", label: "낮음", description: "속도 우선, 단순한 작업에 적합" },
  { value: "medium", label: "중간", description: "일상적인 수정" },
  { value: "high", label: "높음", description: "기본값. 균형 잡힌 품질" },
  { value: "xhigh", label: "매우 높음", description: "복잡한 기능과 문제 해결" },
  { value: "max", label: "최대", description: "복잡한 작업을 더 오래 검토" },
];

export const PERMISSION_OPTIONS: { value: PermissionPreset; label: string; description: string; danger?: boolean }[] = [
  { value: "read_only", label: "계획만 세우기", description: "내용을 살펴보고 계획을 제안, 파일 수정은 하지 않음" },
  { value: "ask_everything", label: "매번 확인", description: "모든 수정·명령을 승인 받음" },
  { value: "auto_edit", label: "파일 수정 자동 승인", description: "파일 편집은 자동, 명령 실행은 확인" },
  { value: "full_auto", label: "AI에게 맡기기", description: "파일 수정과 프로그램 실행을 확인 없이 진행", danger: true },
];

export function providerLabel(p: Provider): string {
  return PROVIDER_OPTIONS.find((o) => o.value === p)?.label ?? p;
}
