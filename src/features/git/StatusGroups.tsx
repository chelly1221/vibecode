import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { GitFileStatus } from "@/lib/bindings/GitFileStatus";
import { useGitStore, type SelectedFile } from "@/stores/git";

const CODE_LABEL: Record<string, string> = { M: "수정", A: "추가", D: "삭제", R: "이름", C: "복사", U: "충돌", "?": "신규", T: "타입" };

function codeFor(file: GitFileStatus, staged: boolean): string {
  if (file.untracked) return "?";
  const c = staged ? file.code[0] : file.code[1];
  return (c ?? " ").trim() || (staged ? "M" : "M");
}

function splitPath(path: string): { dir: string; base: string } {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? { dir: path.slice(0, idx + 1), base: path.slice(idx + 1) } : { dir: "", base: path };
}

interface GroupProps {
  title: string;
  files: GitFileStatus[];
  staged: boolean;
  actionLabel: string;
  onAll: () => void;
  onOne: (path: string) => void;
}

function Group({ title, files, staged, actionLabel, onAll, onOne }: GroupProps) {
  const selected = useGitStore((s) => s.selected);
  const selectFile = useGitStore((s) => s.selectFile);
  const busy = useGitStore((s) => s.busy);
  if (files.length === 0) return null;
  const isSelected = (f: GitFileStatus) => selected !== null && selected.path === f.path && selected.staged === staged;
  return (
    <section>
      <header className="sticky top-0 z-10 flex items-center justify-between bg-background/95 px-2 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase backdrop-blur">
        <span>
          {title} <span className="ml-1 rounded bg-muted px-1 text-[10px]">{files.length}</span>
        </span>
        <Button size="xs" variant="ghost" onClick={onAll} disabled={busy !== null}>
          {staged ? <Minus /> : <Plus />} 전체 {actionLabel}
        </Button>
      </header>
      <ul>
        {files.map((f) => {
          const { dir, base } = splitPath(f.path);
          const code = codeFor(f, staged);
          const sel: SelectedFile = { path: f.path, staged };
          return (
            <li key={`${staged}-${f.path}`} className="group/file relative">
              <button
                type="button"
                onClick={() => void selectFile(sel)}
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-muted/60",
                  isSelected(f) && "bg-muted",
                )}
                title={f.path}
              >
                <span
                  className={cn(
                    "w-7 shrink-0 rounded text-center font-mono text-[10px] font-semibold",
                    code === "A" || code === "?" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "",
                    code === "D" ? "bg-red-500/15 text-red-700 dark:text-red-300" : "",
                    code === "M" || code === "R" || code === "T" || code === "C" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "",
                    code === "U" ? "bg-purple-500/15 text-purple-700 dark:text-purple-300" : "",
                  )}
                  title={CODE_LABEL[code] ?? code}
                >
                  {code}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted-foreground">{dir}</span>
                  <span>{base}</span>
                </span>
              </button>
              <Button
                size="icon-xs"
                variant="ghost"
                className="absolute top-0.5 right-1 opacity-0 group-hover/file:opacity-100"
                aria-label={staged ? "스테이지 해제" : "스테이지"}
                disabled={busy !== null}
                onClick={(e) => {
                  e.stopPropagation();
                  onOne(f.path);
                }}
              >
                {staged ? <Minus /> : <Plus />}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Staged / changed / untracked file lists with stage & unstage controls. */
export function StatusGroups() {
  const status = useGitStore((s) => s.status);
  const stage = useGitStore((s) => s.stage);
  const unstage = useGitStore((s) => s.unstage);
  if (!status) return null;
  const staged = status.files.filter((f) => f.staged);
  const changed = status.files.filter((f) => f.unstaged && !f.untracked);
  const untracked = status.files.filter((f) => f.untracked);
  const run = (p: Promise<unknown>) => p.catch(() => undefined);

  if (status.files.length === 0) {
    return <p className="px-3 py-6 text-center text-xs text-muted-foreground">변경 사항이 없습니다. 작업 트리가 깨끗합니다.</p>;
  }
  return (
    <div className="pb-2">
      <Group title="스테이지됨" files={staged} staged actionLabel="해제" onAll={() => run(unstage(staged.map((f) => f.path)))} onOne={(p) => run(unstage([p]))} />
      <Group title="변경됨" files={changed} staged={false} actionLabel="스테이지" onAll={() => run(stage(changed.map((f) => f.path)))} onOne={(p) => run(stage([p]))} />
      <Group title="추적 안 됨" files={untracked} staged={false} actionLabel="스테이지" onAll={() => run(stage(untracked.map((f) => f.path)))} onOne={(p) => run(stage([p]))} />
    </div>
  );
}
