// Right-side panel listing every subagent of the session ("작동창"): status, nesting, and a
// full-height transcript for the selected one.

import { useMemo, useState } from "react";
import { BotIcon, ChevronDownIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { runningSubagents, subagentDepth, type SubagentState } from "@/stores/sessions";
import { cn } from "@/lib/utils";
import { SubagentPanel, SubagentStatus } from "./SubagentPanel";

export function SubagentsDrawer({ subagents, onClose }: { subagents: Record<string, SubagentState>; onClose: () => void }) {
  const list = useMemo(() => {
    const all = Object.values(subagents).sort((a, b) => a.startedAt - b.startedAt);
    // Order: parents before their children (depth-first by insertion order).
    const byParent = new Map<string | null, SubagentState[]>();
    for (const s of all) {
      const k = s.parentSubagentId && subagents[s.parentSubagentId] ? s.parentSubagentId : null;
      byParent.set(k, [...(byParent.get(k) ?? []), s]);
    }
    const out: SubagentState[] = [];
    const seen = new Set<string>();
    const walk = (parent: string | null) => {
      for (const s of byParent.get(parent) ?? []) {
        if (seen.has(s.parentToolId)) continue;
        seen.add(s.parentToolId);
        out.push(s);
        walk(s.parentToolId);
      }
    };
    walk(null);
    for (const s of all) if (!seen.has(s.parentToolId)) out.push(s);
    return out;
  }, [subagents]);

  const [selected, setSelected] = useState<string | null>(null);
  const active = selected && subagents[selected] ? subagents[selected] : (list.find((s) => s.running) ?? list[list.length - 1] ?? null);
  const running = runningSubagents(subagents);

  return (
    <aside className="flex h-full w-[420px] shrink-0 flex-col border-l bg-background">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-sm">
        <BotIcon className="size-4" />
        <span className="font-medium">서브에이전트</span>
        <span className="text-xs text-muted-foreground">
          {list.length}개{running > 0 && ` · ${running}개 작동 중`}
        </span>
        <Button size="icon-sm" variant="ghost" className="ml-auto" onClick={onClose} aria-label="닫기">
          <XIcon />
        </Button>
      </div>
      <div className="max-h-[40%] shrink-0 overflow-y-auto border-b">
        {list.length === 0 && <div className="px-3 py-4 text-xs text-muted-foreground">아직 서브에이전트가 없습니다.</div>}
        {list.map((s) => {
          const depth = subagentDepth(subagents, s.parentToolId);
          const isActive = active?.parentToolId === s.parentToolId;
          return (
            <button
              key={s.parentToolId}
              type="button"
              onClick={() => setSelected(s.parentToolId)}
              className={cn("flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-accent/50", isActive && "bg-accent")}
              style={{ paddingLeft: `${12 + depth * 16}px` }}
            >
              {isActive ? <ChevronDownIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium" title={s.name}>
                  {s.name}
                </span>
                <SubagentStatus sub={s} />
                {s.lastActivity && <span className="block truncate text-[11px] text-muted-foreground/80">{s.lastActivity}</span>}
              </span>
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {active ? (
          <>
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate font-medium text-foreground">{active.name}</span>
              <SubagentStatus sub={active} />
            </div>
            <SubagentPanel sub={active} subagents={subagents} />
          </>
        ) : (
          <div className="text-xs text-muted-foreground">서브에이전트를 선택하면 작동 내용이 표시됩니다.</div>
        )}
      </div>
    </aside>
  );
}
