// File-type icons for the explorer (lucide, chosen by extension).
import {
  Braces,
  FileArchive,
  FileCode2,
  FileImage,
  FileJson,
  FileLock2,
  FileText,
  FileType2,
  Folder,
  FolderOpen,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import { extOf } from "./path";

export function iconFor(name: string, isDir: boolean, expanded = false): LucideIcon {
  if (isDir) return expanded ? FolderOpen : Folder;
  const lower = name.toLowerCase();
  if (lower.startsWith(".env") || lower.endsWith(".lock") || lower === "package-lock.json" || lower === "cargo.lock") return FileLock2;
  switch (extOf(lower)) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
    case "rs":
    case "py":
    case "go":
    case "java":
    case "kt":
    case "cs":
    case "cpp":
    case "c":
    case "h":
    case "swift":
    case "dart":
    case "sh":
    case "ps1":
      return FileCode2;
    case "json":
    case "jsonc":
      return FileJson;
    case "toml":
    case "yaml":
    case "yml":
    case "ini":
    case "cfg":
    case "conf":
      return Settings2;
    case "md":
    case "mdx":
    case "txt":
    case "log":
      return FileText;
    case "html":
    case "css":
    case "scss":
    case "svg":
    case "xml":
      return Braces;
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "ico":
    case "icns":
      return FileImage;
    case "zip":
    case "gz":
    case "tar":
    case "7z":
    case "rar":
      return FileArchive;
    case "ttf":
    case "otf":
    case "woff":
    case "woff2":
      return FileType2;
    default:
      return FileText;
  }
}
