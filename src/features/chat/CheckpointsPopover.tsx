// Header popover: list the session's checkpoints, save one manually, restore or preview any of them.

import { useCallback, useEffect, useState } from "react";
import { FileDiffIcon, HistoryIcon, Loader2Icon, SaveIcon, Undo2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ipc, type CheckpointRecord } from "@/lib/ipc";
import { useCheckpointUi } from "./checkpointStore";

function relative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

export function CheckpointsPopover({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<CheckpointRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const version = useCheckpointUi((s) => s.version);
  const openRestore = useCheckpointUi((s) => s.openRestore);
  const openDiff = useCheckpointUi((s) => s.openDiff);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setList(await ipc.checkpoints.list(projectId, sessionId));
    } catch (e) {
      setList([]);
      toast.error("체크포인트 목록을 가져오지 못했습니다", { description: String(e) });
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    if (open) refresh().catch(() => {});
  }, [open, version, refresh]);

  const saveNow = async () => {
    setSaving(true);
    try {
      const rec = await ipc.checkpoints.create(projectId, sessionId, "수동 저장");
      if (rec) toast.success(`체크포인트 저장: ${rec.label}`);
      else toast.info("마지막 체크포인트 이후 바뀐 파일이 없습니다");
      await refresh();
    } catch (e) {
      toast.error("체크포인트 저장 실패", { description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" title="체크포인트">
          <HistoryIcon data-icon="inline-start" />
          체크포인트
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2 text-sm">
          <HistoryIcon className="size-4" />
          <span className="font-medium">체크포인트</span>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => void saveNow()} disabled={saving}>
            {saving ? <Loader2Icon className="animate-spin" data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
            지금 저장
          </Button>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {loading && list === null ? (
            <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" /> 불러오는 중…
            </div>
          ) : !list || list.length === 0 ? (
            <div className="px-3 py-4 text-xs text-muted-foreground">아직 체크포인트가 없습니다. 에이전트 턴이 시작될 때 자동으로 저장됩니다.</div>
          ) : (
            list.map((c) => (
              <div key={c.id} className="flex items-center gap-2 border-b px-3 py-2 text-xs last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium" title={c.label}>
                    {c.label}
                  </div>
                  <div className="text-muted-foreground">
                    #{c.seq} · {relative(c.created_at)} · <span className="font-mono">{c.git_ref.slice(0, 7)}</span>
                  </div>
                </div>
                <Button size="icon-sm" variant="ghost" title="변경 내용" onClick={() => openDiff(c.id, c.label)}>
                  <FileDiffIcon />
                </Button>
                <Button size="icon-sm" variant="outline" title="이 시점으로 되돌리기" onClick={() => openRestore(c.id, c.label)}>
                  <Undo2Icon />
                </Button>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
