// Read-only line diff: either old/new texts (Edit/Write tools) or a unified diff string.

import { useMemo, useState } from "react";
import { FileIcon } from "lucide-react";
import { collapseUnchanged, diffStats, lineDiff, parseUnifiedDiff, type DiffLine, type DiffRow } from "@/lib/diff";
import { cn } from "@/lib/utils";

export interface DiffViewProps {
  path?: string | null;
  oldText?: string | null;
  newText?: string | null;
  unified?: string | null;
  /** Lines of context kept around changes (default 3). */
  context?: number;
  className?: string;
}

function rowClass(type: DiffLine["type"]): string {
  switch (type) {
    case "add":
      return "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200";
    case "del":
      return "bg-red-500/10 text-red-800 dark:text-red-200";
    case "hunk":
      return "bg-sky-500/10 text-sky-700 dark:text-sky-300";
    default:
      return "text-foreground/80";
  }
}

const SIGN: Record<DiffLine["type"], string> = { add: "+", del: "-", context: " ", hunk: "" };

export function DiffView({ path, oldText, newText, unified, context = 3, className }: DiffViewProps) {
  const lines = useMemo<DiffLine[]>(() => {
    if (unified) return parseUnifiedDiff(unified);
    return lineDiff(oldText ?? "", newText ?? "");
  }, [unified, oldText, newText]);
  const stats = useMemo(() => diffStats(lines), [lines]);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const rows = useMemo<DiffRow[]>(() => {
    const collapsed = collapseUnchanged(lines, context);
    if (expanded.size === 0) return collapsed;
    const out: DiffRow[] = [];
    for (const r of collapsed) {
      if (r.type === "skip" && expanded.has(r.start)) out.push(...lines.slice(r.start, r.end));
      else out.push(r);
    }
    return out;
  }, [lines, context, expanded]);

  return (
    <div className={cn("overflow-hidden rounded-lg border bg-background text-xs", className)}>
      {(path || stats.added || stats.removed) && (
        <div className="flex items-center gap-2 border-b bg-muted/40 px-2.5 py-1.5 font-mono">
          <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate" title={path ?? undefined}>
            {path ?? "변경 내용"}
          </span>
          <span className="ml-auto shrink-0 text-emerald-600 dark:text-emerald-400">+{stats.added}</span>
          <span className="shrink-0 text-red-600 dark:text-red-400">-{stats.removed}</span>
        </div>
      )}
      <div className="max-h-96 overflow-auto">
        {lines.length === 0 ? (
          <div className="px-3 py-2 text-muted-foreground">변경 없음</div>
        ) : (
          <table className="w-full border-collapse font-mono">
            <tbody>
              {rows.map((r, i) =>
                r.type === "skip" ? (
                  <tr key={`skip-${r.start}`}>
                    <td colSpan={3} className="bg-muted/30 px-3 py-0.5 text-center text-muted-foreground">
                      <button
                        type="button"
                        className="hover:underline"
                        onClick={() => setExpanded((s) => new Set(s).add(r.start))}
                      >
                        … {r.count}줄 생략 (펼치기)
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={i} className={rowClass(r.type)}>
                    <td className="w-10 select-none border-r px-1.5 text-right text-muted-foreground/70">{r.oldNo ?? ""}</td>
                    <td className="w-10 select-none border-r px-1.5 text-right text-muted-foreground/70">{r.newNo ?? ""}</td>
                    <td className="whitespace-pre-wrap break-all px-2 py-px">
                      <span className="select-none text-muted-foreground/60">{SIGN[r.type]}</span>
                      {r.text}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
