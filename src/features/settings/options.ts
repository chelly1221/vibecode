// Shared option lists / labels for settings-like UIs (onboarding, settings dialog).
import type { Effort } from "@/lib/bindings/Effort";
import type { PermissionPreset } from "@/lib/bindings/PermissionPreset";
import type { Provider } from "@/lib/bindings/Provider";

export const PROVIDER_OPTIONS: { value: Provider; label: string; description: string }[] = [
  { value: "claude", label: "Claude", description: "Claude Code CLI (구독 로그인)" },
  { value: "codex", label: "Codex", description: "OpenAI Codex CLI (ChatGPT 로그인)" },
];

export const EFFORT_OPTIONS: { value: Effort; label: string; description: string }[] = [
  { value: "minimal", label: "최소", description: "Codex minimal / Claude low" },
  { value: "low", label: "낮음", description: "빠르고 저렴, 단순 작업" },
  { value: "medium", label: "중간", description: "일상적인 수정" },
  { value: "high", label: "높음", description: "기본값. 균형 잡힌 품질" },
  { value: "xhigh", label: "매우 높음", description: "복잡한 코딩·에이전트 작업" },
  { value: "max", label: "최대", description: "비용보다 정확도 우선 (Codex는 xhigh)" },
];

export const PERMISSION_OPTIONS: { value: PermissionPreset; label: string; description: string; danger?: boolean }[] = [
  { value: "read_only", label: "읽기 전용 (계획만)", description: "파일을 바꾸거나 명령을 실행하지 않음" },
  { value: "ask_everything", label: "매번 확인", description: "모든 수정·명령을 승인 받음" },
  { value: "auto_edit", label: "파일 수정 자동 승인", description: "파일 편집은 자동, 명령 실행은 확인" },
  { value: "full_auto", label: "전부 자동", description: "승인 없이 실행 (주의)", danger: true },
];

export const THEME_OPTIONS = [
  { value: "system", label: "시스템" },
  { value: "light", label: "라이트" },
  { value: "dark", label: "다크" },
];

export function providerLabel(p: Provider): string {
  return PROVIDER_OPTIONS.find((o) => o.value === p)?.label ?? p;
}
