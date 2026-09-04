// Restore confirmation + diff preview dialogs for checkpoints (mounted once per ChatView).

import { Loader2Icon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DiffView } from "./DiffView";
import { useCheckpointUi } from "./checkpointStore";

export function CheckpointDialogs() {
  const restoreTarget = useCheckpointUi((s) => s.restoreTarget);
  const diffTarget = useCheckpointUi((s) => s.diffTarget);
  const diffText = useCheckpointUi((s) => s.diffText);
  const diffLoading = useCheckpointUi((s) => s.diffLoading);
  const restoring = useCheckpointUi((s) => s.restoring);
  const close = useCheckpointUi((s) => s.close);
  const confirmRestore = useCheckpointUi((s) => s.confirmRestore);

  return (
    <>
      <Dialog open={!!restoreTarget} onOpenChange={(o) => !o && !restoring && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>이 시점으로 되돌릴까요?</DialogTitle>
            <DialogDescription>
              "{restoreTarget?.label}" 체크포인트의 파일 상태로 프로젝트를 되돌립니다. 그 이후 바뀐 파일은 덮어쓰이거나 삭제됩니다. 되돌리기 전의 현재
              상태는 안전 체크포인트로 먼저 저장되므로 다시 복구할 수 있습니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={close} disabled={restoring}>
              취소
            </Button>
            <Button variant="destructive" onClick={() => void confirmRestore()} disabled={restoring}>
              {restoring ? <Loader2Icon className="animate-spin" data-icon="inline-start" /> : <Undo2Icon data-icon="inline-start" />}
              되돌리기
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!diffTarget} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-h-[85vh] sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>변경 내용 · {diffTarget?.label}</DialogTitle>
            <DialogDescription>체크포인트와 현재 작업 트리의 차이입니다.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 max-h-[65vh] overflow-auto">
            {diffLoading ? (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" /> 불러오는 중…
              </div>
            ) : diffText && diffText.trim() ? (
              <DiffView unified={diffText} />
            ) : (
              <div className="py-6 text-center text-sm text-muted-foreground">체크포인트 이후 바뀐 파일이 없습니다.</div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
