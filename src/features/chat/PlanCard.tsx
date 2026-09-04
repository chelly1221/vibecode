import { CheckCircle2Icon, CircleIcon, ListTodoIcon, Loader2Icon } from "lucide-react";
import type { PlanStep } from "@/lib/bindings/PlanStep";
import { cn } from "@/lib/utils";

function StepIcon({ status }: { status: string }) {
  const s = status.toLowerCase();
  if (s === "completed" || s === "done") return <CheckCircle2Icon className="size-4 text-emerald-600 dark:text-emerald-400" />;
  if (s === "in_progress" || s === "inprogress" || s === "running") return <Loader2Icon className="size-4 animate-spin text-primary" />;
  return <CircleIcon className="size-4 text-muted-foreground/60" />;
}

export function PlanCard({ steps, className }: { steps: PlanStep[]; className?: string }) {
  const done = steps.filter((s) => ["completed", "done"].includes(s.status.toLowerCase())).length;
  return (
    <div className={cn("rounded-lg border bg-card p-3 text-sm", className)}>
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <ListTodoIcon className="size-3.5" />
        계획
        <span className="ml-auto">
          {done}/{steps.length}
        </span>
      </div>
      <ol className="space-y-1">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0">
              <StepIcon status={s.status} />
            </span>
            <span className={cn(["completed", "done"].includes(s.status.toLowerCase()) && "text-muted-foreground line-through")}>{s.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
