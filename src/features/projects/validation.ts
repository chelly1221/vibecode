// Pure helpers for the project wizard: name validation and path composition.

const INVALID_NAME_CHARS = /[\\/:*?"<>|]/;
// Windows reserved device names cannot be used as file names.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Display name: any characters (Korean included) except path separators / reserved ones. */
export function validateProjectName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "프로젝트 이름을 입력하세요.";
  if (INVALID_NAME_CHARS.test(trimmed)) return '이름에 \\ / : * ? " < > | 문자를 쓸 수 없습니다.';
  if (trimmed !== name) return "이름 앞뒤 공백을 제거하세요.";
  if (trimmed.endsWith(".")) return "이름은 마침표로 끝날 수 없습니다.";
  if (RESERVED.test(trimmed)) return "Windows 예약어는 이름으로 쓸 수 없습니다.";
  if (trimmed.length > 100) return "이름이 너무 깁니다 (100자 이하).";
  return null;
}

const DIR_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** Folder/package identifier the scaffolding tools accept (npm, cargo, flutter, dotnet ...). */
export function validateDirName(dir: string): string | null {
  const t = dir.trim();
  if (!t) return "도구용 폴더 이름(영문)을 입력하세요. 예: inventory-app";
  if (!DIR_NAME.test(t)) return "폴더 이름은 영문 소문자, 숫자, '-', '_', '.'만 쓸 수 있고 영문/숫자로 시작해야 합니다.";
  if (t.endsWith(".")) return "폴더 이름은 마침표로 끝날 수 없습니다.";
  if (RESERVED.test(t)) return "Windows 예약어는 폴더 이름으로 쓸 수 없습니다.";
  if (t.length > 64) return "폴더 이름이 너무 깁니다 (64자 이하).";
  return null;
}

/** Suggest a folder name from the display name; empty when nothing ASCII remains (e.g. "재고관리"). */
export function toDirName(name: string): string {
  const out = name
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return out;
}

/** Join a parent directory and a name using the parent's separator style. */
export function joinPath(parent: string, name: string): string {
  const p = parent.trim();
  if (!p) return name;
  const sep = p.includes("\\") || /^[A-Za-z]:$/.test(p) ? "\\" : p.includes("/") ? "/" : "\\";
  const base = p.replace(/[\\/]+$/, "");
  // "C:" alone should become "C:\name", not "C:name"
  if (/^[A-Za-z]:$/.test(base)) return `${base}${sep}${name}`;
  return `${base}${sep}${name}`;
}

export interface PathWarning {
  kind: "space" | "non_ascii" | "long";
  message: string;
}

export function pathWarnings(fullPath: string): PathWarning[] {
  const warnings: PathWarning[] = [];
  if (/\s/.test(fullPath)) {
    warnings.push({ kind: "space", message: "경로에 공백이 있습니다. 일부 스캐폴딩 도구가 실패할 수 있습니다." });
  }
  if (/[^\x20-\x7E]/.test(fullPath)) {
    warnings.push({ kind: "non_ascii", message: "경로에 한글 등 비ASCII 문자가 있습니다. 일부 도구가 깨질 수 있습니다." });
  }
  if (fullPath.length > 200) {
    warnings.push({ kind: "long", message: "경로가 매우 깁니다. Windows 경로 길이 제한에 걸릴 수 있습니다." });
  }
  return warnings;
}
