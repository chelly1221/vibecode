// Korean labels and small formatters shared by the chat components.

import type { Provider } from "@/lib/ipc";
import type { Effort } from "@/lib/bindings/Effort";
import type { PermissionDecision } from "@/lib/bindings/PermissionDecision";
import type { PermissionKind } from "@/lib/bindings/PermissionKind";
import type { PermissionPreset } from "@/lib/bindings/PermissionPreset";

export const EFFORTS: Effort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export const EFFORT_LABEL: Record<Effort, string> = {
  minimal: "최소",
  low: "낮음",
  medium: "보통",
  high: "높음",
  xhigh: "매우 높음",
  max: "최대",
};

export const PERMISSION_PRESETS: PermissionPreset[] = ["read_only", "ask_everything", "auto_edit", "full_auto"];

export const PERMISSION_LABEL: Record<PermissionPreset, string> = {
  read_only: "읽기 전용",
  ask_everything: "매번 확인",
  auto_edit: "파일 수정 자동",
  full_auto: "전부 자동",
};

export const PERMISSION_HINT: Record<PermissionPreset, string> = {
  read_only: "계획만 세우고 파일을 바꾸지 않습니다.",
  ask_everything: "파일 수정과 명령 실행마다 승인을 요청합니다.",
  auto_edit: "파일 수정은 자동, 명령 실행은 승인을 요청합니다.",
  full_auto: "위험: 모든 작업을 확인 없이 실행합니다.",
};

export const PROVIDER_LABEL: Record<Provider, string> = { claude: "Claude", codex: "Codex" };

export const DECISION_LABEL: Record<PermissionDecision, string> = {
  allow: "허용됨",
  allow_session: "세션 동안 허용",
  deny: "거부됨",
};

export const PERMISSION_KIND_LABEL: Record<PermissionKind, string> = {
  command: "명령 실행",
  file_edit: "파일 수정",
  tool: "도구 사용",
  other: "권한 요청",
};

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}분 ${s}초`;
}

/** Sentinel used by Selects where "use the default" means `null`. */
export const DEFAULT_OPTION = "__default__";
