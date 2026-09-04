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
  const [stageAll, setStageAll] = useState(false);
  const [generating, setGenerating] = useState(false);

  const stagedCount = status?.files.filter((f) => f.staged).length ?? 0;
  const pendingCount = status?.files.filter((f) => f.unstaged || f.untracked).length ?? 0;
  const canCommit = message.trim().length > 0 && (stagedCount > 0 || (stageAll && pendingCount > 0)) && busy === null;

  const generate = async () => {
    if (!projectId) return;
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
    try {
      const out = await commit(message.trim(), stageAll);
      toast.success("커밋했습니다.", { description: out.trim().split("\n")[0] });
      setMessage("");
    } catch (e) {
      toast.error(`커밋 실패: ${e}`);
    }
  };

  return (
    <div className="grid gap-2 border-t p-2">
      <Textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="커밋 메시지"
        rows={3}
        className="min-h-16 resize-none font-mono text-xs"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && canCommit) void doCommit();
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox checked={stageAll} onCheckedChange={(v) => setStageAll(v === true)} id="stage-all" />
          <Label htmlFor="stage-all" className="text-xs font-normal">
            전체 스테이지 후 커밋
          </Label>
        </label>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" onClick={generate} disabled={generating || !projectId || (stagedCount === 0 && pendingCount === 0)} title="스테이지된 변경으로 커밋 메시지를 생성합니다">
            {generating ? <Loader2 className="animate-spin" /> : <Sparkles />} AI로 작성
          </Button>
          <Button size="sm" onClick={doCommit} disabled={!canCommit} title="Ctrl+Enter">
            {busy === "commit" ? <Loader2 className="animate-spin" /> : <Check />} 커밋
            {stagedCount > 0 && !stageAll && <span className="ml-0.5 rounded bg-primary-foreground/20 px-1 text-[10px]">{stagedCount}</span>}
          </Button>
        </div>
      </div>
    </div>
  );
}
