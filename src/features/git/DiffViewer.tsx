import { useMemo, useState } from "react";
import { Loader2, WrapText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useGitStore } from "@/stores/git";
import { diffStats, parseDiff, type DiffLineKind } from "./diff";

const LINE_CLASS: Record<DiffLineKind, string> = {
  add: "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
  del: "bg-red-500/10 text-red-800 dark:text-red-200",
  hunk: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  meta: "text-muted-foreground",
  ctx: "",
};

/** Colorized unified diff for the selected file. */
export function DiffViewer() {
  const selected = useGitStore((s) => s.selected);
  const diff = useGitStore((s) => s.diff);
  const loading = useGitStore((s) => s.diffLoading);
  const [wrap, setWrap] = useState(false);
  const lines = useMemo(() => parseDiff(diff), [diff]);
  const stats = useMemo(() => diffStats(lines), [lines]);

  if (!selected) {
    return <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">파일을 선택하면 변경 내용이 표시됩니다.</div>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b px-2 py-1 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono" title={selected.path}>
          {selected.path}
        </span>
        <span className="text-emerald-600">+{stats.added}</span>
        <span className="text-red-600">-{stats.removed}</span>
        <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{selected.staged ? "staged" : "working"}</span>
        <Button size="icon-xs" variant={wrap ? "secondary" : "ghost"} onClick={() => setWrap((w) => !w)} aria-label="줄 바꿈" aria-pressed={wrap}>
          <WrapText />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> 불러오는 중…
          </div>
        ) : lines.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground">표시할 변경 내용이 없습니다 (바이너리 파일이거나 내용 변화가 없음).</div>
        ) : (
          <pre className={cn("min-w-full font-mono text-[11px] leading-5", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>
            {lines.map((l, i) => (
              <div key={i} className={cn("px-2", LINE_CLASS[l.kind])}>
                {l.text || " "}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}
