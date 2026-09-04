// After registering an external project: offer to create the missing agent instruction files.
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ipc } from "@/lib/ipc";
import { useRegisterStore } from "./registerExisting";

export function AgentDocsPrompt() {
  const prompt = useRegisterStore((s) => s.prompt);
  const setPrompt = useRegisterStore((s) => s.setPrompt);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const close = () => {
    setPrompt(null);
    setDescription("");
  };

  const generate = async () => {
    if (!prompt) return;
    setBusy(true);
    try {
      const written = await ipc.projects.generateAgentDocs(prompt.project.id, description.trim() || undefined);
      toast.success(written.length ? `${written.join(", ")} 파일을 만들었습니다.` : "이미 파일이 있어 새로 만들지 않았습니다.");
      close();
    } catch (e) {
      toast.error(`생성 실패: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!prompt} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>에이전트 지침 파일을 만들까요?</DialogTitle>
          <DialogDescription>
            "{prompt?.project.name}"에 {prompt?.missing.join(", ")}이(가) 없습니다. 프로젝트 설명과 감지된 스택
            {prompt?.project.stack_id ? ` (${prompt.project.stack_id})` : ""}을 바탕으로 Claude Code와 Codex가 읽는 지침 파일을 생성합니다. 기존 파일은 건드리지
            않습니다.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="docs-desc">프로젝트 한 줄 설명 (선택)</Label>
          <Textarea id="docs-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="예: 사내 재고 관리 웹앱" className="min-h-16" />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy}>
            나중에
          </Button>
          <Button onClick={generate} disabled={busy}>
            {busy ? "생성 중…" : "생성"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
