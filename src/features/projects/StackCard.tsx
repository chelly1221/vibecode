import { Check, Minus, Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { StackInfo, ToolStatus } from "@/lib/ipc";

interface StackCardProps {
  stack: StackInfo;
  selected: boolean;
  tools: ToolStatus[] | null;
  projectName: string;
  onSelect: () => void;
}

export function StackCard({ stack, selected, tools, projectName, onSelect }: StackCardProps) {
  const cmd = stack.scaffold_cmd?.replace(/\{name\}/g, projectName || "my-app");
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex h-full flex-col gap-2 rounded-xl border bg-card p-3 text-left text-sm transition-colors hover:bg-muted/50",
        selected && "border-primary ring-2 ring-primary/30",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-semibold">{stack.name}</span>
            {stack.recommended && (
              <Badge className="h-4 gap-0.5 px-1 text-[10px]">
                <Sparkles className="size-2.5" /> 추천
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{stack.summary}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {stack.languages.map((l) => (
          <Badge key={l} variant="outline" className="h-4 px-1 text-[10px]">
            {l}
          </Badge>
        ))}
      </div>
      {(stack.pros.length > 0 || stack.cons.length > 0) && (
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <ul className="space-y-0.5">
            {stack.pros.map((p) => (
              <li key={p} className="flex gap-1 text-emerald-700 dark:text-emerald-300">
                <Check className="mt-0.5 size-3 shrink-0" /> <span>{p}</span>
              </li>
            ))}
          </ul>
          <ul className="space-y-0.5">
            {stack.cons.map((c) => (
              <li key={c} className="flex gap-1 text-amber-700 dark:text-amber-300">
                <Minus className="mt-0.5 size-3 shrink-0" /> <span>{c}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {stack.prerequisites.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-[11px]">
          <span className="text-muted-foreground">필요 도구:</span>
          {stack.prerequisites.map((name) => {
            const found = tools?.find((t) => t.name === name)?.found;
            return (
              <span
                key={name}
                className={cn(
                  "inline-flex items-center gap-0.5 rounded px-1 font-mono",
                  tools === null && "bg-muted text-muted-foreground",
                  found === true && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                  found === false && "bg-red-500/10 text-red-700 dark:text-red-300",
                )}
                title={found === false ? "설치되지 않음" : found ? "설치됨" : "확인 중"}
              >
                {found === true ? <Check className="size-3" /> : found === false ? <X className="size-3" /> : null}
                {name}
              </span>
            );
          })}
        </div>
      )}
      {cmd && (
        <code className="mt-auto block truncate rounded bg-muted px-1.5 py-1 font-mono text-[11px] text-muted-foreground" title={cmd}>
          {cmd}
        </code>
      )}
    </button>
  );
}
