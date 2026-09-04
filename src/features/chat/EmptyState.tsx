import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full flex-1 flex-col items-center justify-center gap-3 p-8 text-center", className)}>
      {icon && <div className="text-muted-foreground [&_svg]:size-10 [&_svg]:stroke-[1.25]">{icon}</div>}
      <div className="space-y-1">
        <div className="text-base font-medium">{title}</div>
        {description && <div className="max-w-sm text-sm text-muted-foreground">{description}</div>}
      </div>
      {action}
    </div>
  );
}
