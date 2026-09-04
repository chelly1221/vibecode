import { cn } from "@/lib/utils";
import type { OptionMeta } from "../labels";

interface OptionGridProps<T extends string> {
  options: OptionMeta<T>[];
  value: T | null;
  onChange: (v: T) => void;
}

/** Card grid used for the target-OS and project-type steps. */
export function OptionGrid<T extends string>({ options, value, onChange }: OptionGridProps<T>) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {options.map((o) => {
        const Icon = o.icon;
        const selected = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={selected}
            className={cn(
              "flex flex-col items-start gap-2 rounded-xl border bg-card p-3 text-left transition-colors hover:bg-muted/50",
              selected && "border-primary ring-2 ring-primary/30",
            )}
          >
            <Icon className={cn("size-5", selected ? "text-primary" : "text-muted-foreground")} />
            <span className="text-sm font-medium">{o.label}</span>
            <span className="text-xs text-muted-foreground">{o.description}</span>
          </button>
        );
      })}
    </div>
  );
}
