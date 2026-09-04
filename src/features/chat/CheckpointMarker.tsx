// Subtle transcript marker for a working-tree checkpoint with restore / diff actions.

import { HistoryIcon, FileDiffIcon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ChatItem } from "@/stores/sessions";
import { useCheckpointUi } from "./checkpointStore";

type CheckpointItem = Extract<ChatItem, { type: "checkpoint" }>;

export function CheckpointMarker({ item }: { item: CheckpointItem }) {
  const openRestore = useCheckpointUi((s) => s.openRestore);
  const openDiff = useCheckpointUi((s) => s.openDiff);
  return (
    <div className="my-1.5 flex items-center gap-2 text-[11px] text-muted-foreground/80">
      <div className="h-px flex-1 bg-border" />
      <HistoryIcon className="size-3" />
      <span>체크포인트 저장됨 · {item.label}</span>
      <Button size="xs" variant="ghost" className="h-5 px-1.5 text-[11px]" onClick={() => openDiff(item.checkpoint_id, item.label)} title="현재 상태와의 차이">
        <FileDiffIcon className="size-3" /> 변경 내용
      </Button>
      <Button size="xs" variant="outline" className="h-5 px-1.5 text-[11px]" onClick={() => openRestore(item.checkpoint_id, item.label)}>
        <Undo2Icon className="size-3" /> 이 시점으로 되돌리기
      </Button>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
