import { cn } from "@/lib/utils";
import type { Provider } from "@/lib/ipc";
import { PROVIDER_LABEL } from "./labels";

/** Compact colored letter badge identifying the agent provider. */
export function ProviderBadge({ provider, className }: { provider: Provider; className?: string }) {
  return (
    <span
      title={PROVIDER_LABEL[provider]}
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-white",
        provider === "claude" ? "bg-orange-500" : "bg-emerald-600",
        className,
      )}
    >
      {provider === "claude" ? "C" : "X"}
    </span>
  );
}
