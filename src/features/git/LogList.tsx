import { useGitStore } from "@/stores/git";
import { formatRelative } from "@/features/projects/format";

/** Recent commits of the current branch. */
export function LogList() {
  const log = useGitStore((s) => s.log);
  if (log.length === 0) {
    return <p className="px-3 py-6 text-center text-xs text-muted-foreground">커밋 기록이 없습니다.</p>;
  }
  return (
    <ul className="divide-y">
      {log.map((c) => {
        const rel = formatRelative(c.date);
        return (
          <li key={c.hash} className="px-2 py-1.5 text-xs" title={c.hash}>
            <div className="flex items-start gap-2">
              <code className="mt-px shrink-0 rounded bg-muted px-1 font-mono text-[10px]">{c.short_hash}</code>
              <span className="min-w-0 flex-1 truncate">{c.subject}</span>
            </div>
            <div className="mt-0.5 pl-12 text-[10px] text-muted-foreground">
              {c.author} · {rel || c.date}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
