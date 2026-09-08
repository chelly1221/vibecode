import { useState } from "react";
import { Check, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ipc, type Provider } from "@/lib/ipc";
import { useGitStore } from "@/stores/git";

/** Commit message editor with AI generation and stage-all option. */
export function CommitBox({ provider }: { provider: Provider }) {
  const projectId = useGitStore((s) => s.projectId);
  const status = useGitStore((s) => s.status);
  const busy = useGitStore((s) => s.busy);
  const commit = useGitStore((s) => s.commit);
  const [message, setMessage] = useState("");
  const [stageAll, setStageAll] = useState(true);
  const [generating, setGenerating] = useState(false);

  const stagedCount = status?.files.filter((f) => f.staged).length ?? 0;
  const pendingCount = status?.files.filter((f) => f.unstaged || f.untracked).length ?? 0;
  const canCommit = message.trim().length > 0 && (stagedCount > 0 || (stageAll && pendingCount > 0)) && busy === null && !generating;

  const generate = async () => {
    if (!projectId || generating || busy) return;
    setGenerating(true);
    try {
      const msg = await ipc.git.generateCommitMessage(projectId, provider);
      setMessage(msg.trim());
    } catch (e) {
      toast.error(`메시지 생성 실패: ${e}`);
    } finally {
      setGenerating(false);
    }
  };

  const doCommit = async () => {
    if (!canCommit) return;
    try {
      const out = await commit(message.trim(), stageAll);
      toast.success("새 버전을 저장했습니다.", { description: out.trim().split("\n")[0] });
      setMessage("");
    } catch (e) {
      toast.error(`버전을 저장하지 못했어요: ${e}`);
    }
  };

  return (
    <div className="grid gap-3 border-t p-3">
      <p className="text-xs text-muted-foreground">지금까지의 변경을 이 컴퓨터에 버전으로 저장합니다. 온라인 업로드는 별도입니다.</p>
      <Textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        aria-label="저장할 변경 내용 설명"
        disabled={generating || busy === "commit"}
        placeholder="무엇을 바꿨나요? 예: 예약 화면 추가"
        rows={3}
        className="min-h-16 resize-none text-sm"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && canCommit) void doCommit();
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox checked={stageAll} onCheckedChange={(v) => setStageAll(v === true)} id="stage-all" />
          <Label htmlFor="stage-all" className="text-xs font-normal">
            모든 변경 포함
          </Label>
        </label>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" onClick={generate} disabled={generating || busy !== null || !projectId || (stagedCount === 0 && pendingCount === 0)} title="변경 내용을 AI가 요약합니다">
            {generating ? <Loader2 className="animate-spin" /> : <Sparkles />} AI로 작성
          </Button>
          <Button size="sm" onClick={doCommit} disabled={!canCommit} title="Ctrl+Enter">
            {busy === "commit" ? <Loader2 className="animate-spin" /> : <Check />} 버전 저장
            {stagedCount > 0 && !stageAll && <span className="ml-0.5 rounded bg-primary-foreground/20 px-1 text-[10px]">{stagedCount}</span>}
          </Button>
        </div>
      </div>
    </div>
  );
}
