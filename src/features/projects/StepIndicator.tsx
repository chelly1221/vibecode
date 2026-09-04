import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { WIZARD_STEPS, type WizardStep } from "@/stores/wizard";

interface StepIndicatorProps {
  current: WizardStep;
  onSelect?: (step: WizardStep) => void;
  /** Steps below this index can be clicked (already completed). */
  maxReachable: number;
}

export function StepIndicator({ current, onSelect, maxReachable }: StepIndicatorProps) {
  return (
    <ol className="flex items-center gap-1 text-xs">
      {WIZARD_STEPS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        const clickable = !!onSelect && i < maxReachable && i !== current;
        return (
          <li key={label} className="flex items-center gap-1">
            <button
              type="button"
              disabled={!clickable}
              onClick={() => clickable && onSelect?.(i as WizardStep)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-1.5 py-1",
                clickable && "hover:bg-muted",
                active ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border text-[10px] font-semibold",
                  active && "border-primary bg-primary text-primary-foreground",
                  done && "border-primary/40 bg-primary/10 text-primary",
                )}
              >
                {done ? <Check className="size-3" /> : i + 1}
              </span>
              <span className={cn("hidden sm:inline", active && "font-medium")}>{label}</span>
            </button>
            {i < WIZARD_STEPS.length - 1 && <span className="h-px w-3 bg-border" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}
