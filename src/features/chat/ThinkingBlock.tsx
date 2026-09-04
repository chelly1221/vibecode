import { useState } from "react";
import { BrainIcon, ChevronRightIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export function ThinkingBlock({ text, active }: { text: string; active?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="text-xs">
      <CollapsibleTrigger className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">
        <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        <BrainIcon className={cn("size-3.5", active && "animate-pulse")} />
        {active ? "생각 중…" : "생각"}
        <span className="ml-1 text-muted-foreground/60">{text.length.toLocaleString()}자</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 max-h-72 overflow-auto rounded-lg border border-dashed bg-muted/30 p-2.5 whitespace-pre-wrap text-muted-foreground">{text}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
