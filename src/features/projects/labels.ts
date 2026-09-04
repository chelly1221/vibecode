// Korean labels and icons for the enums used by the project wizard and sidebar.
import {
  AppWindow,
  FileCode2,
  Gamepad2,
  Globe,
  Laptop,
  Monitor,
  Package,
  Server,
  Smartphone,
  SquareTerminal,
  TabletSmartphone,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import type { ProjectType, Provider, TargetOs } from "@/lib/ipc";
import type { Effort } from "@/lib/bindings/Effort";
import type { PermissionPreset } from "@/lib/bindings/PermissionPreset";

export interface OptionMeta<T extends string> {
  value: T;
  label: string;
  description: string;
  icon: LucideIcon;
}

export const TARGET_OS_OPTIONS: OptionMeta<TargetOs>[] = [
  { value: "windows", label: "Windows", description: "Windows 데스크톱 전용", icon: Monitor },
  { value: "macos", label: "macOS", description: "macOS 전용 (빌드에 Mac 필요)", icon: Laptop },
  { value: "linux", label: "Linux", description: "Linux 데스크톱/서버", icon: Terminal },
  { value: "cross_desktop", label: "크로스플랫폼 데스크톱", description: "Windows · macOS · Linux 동시 지원", icon: AppWindow },
  { value: "web", label: "웹", description: "브라우저에서 실행", icon: Globe },
  { value: "android", label: "Android", description: "Android 모바일", icon: Smartphone },
  { value: "ios", label: "iOS", description: "iPhone / iPad (빌드에 Mac 필요)", icon: TabletSmartphone },
  { value: "server", label: "서버 / 클라우드", description: "백엔드, 배치, 컨테이너", icon: Server },
];

export const PROJECT_TYPE_OPTIONS: OptionMeta<ProjectType>[] = [
  { value: "desktop_app", label: "데스크톱 앱", description: "GUI 애플리케이션", icon: AppWindow },
  { value: "web_app", label: "웹앱", description: "웹 프론트엔드 / 풀스택", icon: Globe },
  { value: "mobile_app", label: "모바일 앱", description: "스마트폰 / 태블릿 앱", icon: Smartphone },
  { value: "cli", label: "CLI 도구", description: "명령줄 프로그램", icon: SquareTerminal },
  { value: "api_server", label: "API 서버", description: "REST / GraphQL 백엔드", icon: Server },
  { value: "library", label: "라이브러리", description: "패키지 / SDK", icon: Package },
  { value: "game", label: "게임", description: "2D / 3D 게임", icon: Gamepad2 },
  { value: "script", label: "스크립트 / 자동화", description: "도구, 배치 작업, 봇", icon: FileCode2 },
];

export const EFFORT_OPTIONS: { value: Effort; label: string }[] = [
  { value: "minimal", label: "최소" },
  { value: "low", label: "낮음" },
  { value: "medium", label: "보통" },
  { value: "high", label: "높음" },
  { value: "xhigh", label: "매우 높음" },
  { value: "max", label: "최대" },
];

export const PERMISSION_OPTIONS: { value: PermissionPreset; label: string; description: string }[] = [
  { value: "read_only", label: "읽기 전용", description: "계획만 세우고 파일을 바꾸지 않음" },
  { value: "ask_everything", label: "매번 확인", description: "파일 수정과 명령 실행을 모두 승인" },
  { value: "auto_edit", label: "파일 수정 자동", description: "파일 수정은 자동, 명령 실행은 승인" },
  { value: "full_auto", label: "전부 자동 (위험)", description: "확인 없이 모든 작업 실행" },
];

export const PROVIDER_LABEL: Record<Provider, string> = { claude: "Claude", codex: "Codex" };

export function targetOsLabel(v: TargetOs | null | undefined): string {
  return TARGET_OS_OPTIONS.find((o) => o.value === v)?.label ?? "-";
}
export function projectTypeLabel(v: ProjectType | null | undefined): string {
  return PROJECT_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? "-";
}
export function effortLabel(v: Effort | null | undefined): string {
  return EFFORT_OPTIONS.find((o) => o.value === v)?.label ?? "-";
}
export function permissionLabel(v: PermissionPreset | null | undefined): string {
  return PERMISSION_OPTIONS.find((o) => o.value === v)?.label ?? "-";
}
