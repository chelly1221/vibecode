// Pure helpers for the file explorer (relative paths use forward slashes).

export function joinRel(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function basename(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? rel : rel.slice(i + 1);
}

export function parentOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

export function extOf(name: string): string {
  const base = basename(name);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

export type ViewerLang = "javascript" | "typescript" | "jsx" | "tsx" | "rust" | "python" | "json" | "markdown" | "plain";

/** Map a file name to one of the CodeMirror languages bundled with the app. */
export function langFromPath(path: string): ViewerLang {
  const base = basename(path).toLowerCase();
  const ext = extOf(base);
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "jsx";
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "rs":
      return "rust";
    case "py":
    case "pyi":
      return "python";
    case "json":
    case "jsonc":
    case "json5":
      return "json";
    case "md":
    case "mdx":
    case "markdown":
      return "markdown";
    default:
      if (base === "tsconfig.json" || base === "package.json") return "json";
      return "plain";
  }
}

/** Case-insensitive "contains" filter on the file name; empty query matches everything. */
export function matchesFilter(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || name.toLowerCase().includes(q);
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
