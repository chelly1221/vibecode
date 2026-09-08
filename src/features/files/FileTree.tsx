// Recursive directory tree fed by the files store (lazy per folder).
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFilesStore } from "@/stores/files";
import { iconFor } from "./icons";
import { joinRel, matchesFilter } from "./path";

interface Props {
  relPath: string;
  depth: number;
}

export function FileTree({ relPath, depth }: Props) {
  const dir = useFilesStore((s) => s.dirs[relPath]);
  const expanded = useFilesStore((s) => s.expanded);
  const filter = useFilesStore((s) => s.filter);
  const toggleDir = useFilesStore((s) => s.toggleDir);
  const openFile = useFilesStore((s) => s.openFile);
  const viewerPath = useFilesStore((s) => s.viewer?.relPath ?? null);

  if (!dir) return null;
  if (dir.loading && dir.entries.length === 0) {
    return (
      <div className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground" style={{ paddingLeft: 8 + depth * 12 }}>
        <Loader2 className="size-3 animate-spin" /> 불러오는 중…
      </div>
    );
  }
  if (dir.error) {
    return (
      <div className="px-2 py-1 text-xs text-destructive" style={{ paddingLeft: 8 + depth * 12 }} title={dir.error}>
        읽기 실패
      </div>
    );
  }

  const visible = dir.entries.filter((e) => e.is_dir || matchesFilter(e.name, filter));

  return (
    <ul>
      {visible.map((e) => {
        const path = joinRel(relPath, e.name);
        const isOpen = e.is_dir && !!expanded[path];
        const Icon = iconFor(e.name, e.is_dir, isOpen);
        const active = viewerPath === path;
        return (
          <li key={path}>
            <button
              type="button"
              onClick={() => (e.is_dir ? toggleDir(path) : openFile(path))}
              onDoubleClick={(ev) => {
                if (e.is_dir) {
                  ev.preventDefault();
                  toggleDir(path);
                }
              }}
              title={e.is_dir ? path : `${path}${e.size ? ` · ${e.size.toLocaleString()} B` : ""}`}
              className={cn(
                "flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-sidebar-accent",
                e.ignored && "opacity-50",
                active && "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
              style={{ paddingLeft: 4 + depth * 12 }}
            >
              {e.is_dir ? (
                isOpen ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
              ) : (
                <span className="inline-block size-3 shrink-0" />
              )}
              <Icon className={cn("size-3.5 shrink-0", e.is_dir ? "text-primary" : "text-muted-foreground")} />
              <span className="truncate">{e.name}</span>
            </button>
            {e.is_dir && isOpen && <FileTree relPath={path} depth={depth + 1} />}
          </li>
        );
      })}
      {visible.length === 0 && (
        <li className="px-2 py-1 text-xs text-muted-foreground" style={{ paddingLeft: 8 + depth * 12 }}>
          {filter ? "일치하는 항목이 없습니다" : "비어 있음"}
        </li>
      )}
    </ul>
  );
}
