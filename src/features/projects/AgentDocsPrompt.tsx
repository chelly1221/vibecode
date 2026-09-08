// Show registration progress, then offer to create missing agent instruction files.
import { useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ipc } from "@/lib/ipc";
import { useRegisterStore } from "./registerExisting";

export function AgentDocsPrompt() {
  const progress = useRegisterStore((s) => s.progress);
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
    <Dialog open={!!progress || !!prompt} onOpenChange={(o) => !o && !progress && close()}>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={!progress}
        onEscapeKeyDown={(e) => { if (progress) e.preventDefault(); }}
        onInteractOutside={(e) => { if (progress) e.preventDefault(); }}
      >
        {progress ? <>
          <DialogHeader>
            <div className="mb-1 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <FolderOpen className="size-5" aria-hidden="true" />
            </div>
            <DialogTitle>{progress.path ? "프로젝트를 등록하고 있어요" : "기존 폴더를 열고 있어요"}</DialogTitle>
            <DialogDescription>{progress.path ? "준비가 끝나면 자동으로 다음 화면으로 이동해요." : "폴더 선택이 끝나면 자동으로 등록을 이어서 진행해요."}</DialogDescription>
          </DialogHeader>
          {progress.path && <p className="max-h-28 overflow-y-auto rounded-lg border bg-muted/40 px-3 py-2 text-xs leading-relaxed break-all text-muted-foreground">{progress.path}</p>}
          <div role="status" aria-atomic="true" className="flex items-center gap-2.5 py-1 text-sm">
            <Loader2 className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
            <span>{progress.message}</span>
          </div>
        </> : <>
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
        </>}
      </DialogContent>
    </Dialog>
  );
}
