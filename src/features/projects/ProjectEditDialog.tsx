import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ipc, type ProjectRecord } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";
import { validateProjectName } from "./validation";

export function ProjectEditDialog({ project, onClose }: { project: ProjectRecord; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameError = validateProjectName(name.trim());

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || nameError) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await ipc.projects.rename(project.id, name.trim());
      useAppStore.setState((s) => ({ projects: s.projects.map((p) => p.id === updated.id ? updated : p) }));
      toast.success("프로젝트 이름을 저장했습니다.");
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-md" showCloseButton={!busy} onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => { if (busy) e.preventDefault(); }}>
      <DialogHeader>
        <DialogTitle>프로젝트 수정</DialogTitle>
        <DialogDescription>앱에 표시할 이름을 수정합니다. 폴더 위치와 기존 대화는 그대로 유지됩니다.</DialogDescription>
      </DialogHeader>
      <form onSubmit={save} className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="edit-project-name">프로젝트 이름</Label>
          <Input id="edit-project-name" autoFocus value={name} disabled={busy} onChange={(e) => { setName(e.target.value); setError(null); }} aria-invalid={!!nameError} aria-describedby={nameError ? "edit-project-name-error" : undefined} />
          {nameError && <p id="edit-project-name-error" className="text-xs text-destructive">{nameError}</p>}
        </div>
        <div className="grid gap-1.5">
          <span className="text-xs text-muted-foreground">연결된 폴더</span>
          <p className="max-h-24 overflow-y-auto rounded-lg border bg-muted/40 px-3 py-2 text-xs break-all text-muted-foreground">{project.path}</p>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">저장하지 못했습니다: {error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>취소</Button>
          <Button type="submit" disabled={busy || !!nameError || name.trim() === project.name}>{busy && <Loader2 className="animate-spin" />}{busy ? "저장 중…" : "저장"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
