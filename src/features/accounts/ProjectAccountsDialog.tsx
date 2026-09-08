import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ipc, type ProjectAccounts, type ProjectRecord } from "@/lib/ipc";
import { AccountChoices } from "./AccountChoices";
export function ProjectAccountsDialog({ project, onClose, onSaved }: { project: ProjectRecord; onClose: () => void; onSaved?: () => void }) {
  const [draft, setDraft] = useState<ProjectAccounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false; setDraft(null); setError(null);
    ipc.accounts.project(project.id).then((v) => { if (!cancelled) setDraft(v); }).catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [project.id, attempt]);
  const save = async () => {
    if (!draft || busy) return; setBusy(true);
    try { await ipc.accounts.setProject(project.id, draft); toast.success("프로젝트 계정을 저장했습니다. 새 대화부터 적용됩니다."); onSaved?.(); onClose(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{project.name} · 사용할 계정</DialogTitle><DialogDescription>다른 프로젝트에는 영향을 주지 않습니다. 기존 대화는 시작할 때 연결한 계정을 유지합니다.</DialogDescription></DialogHeader>
    {error && <div role="alert" className="text-sm text-destructive">{error}{!draft && <Button variant="link" onClick={() => setAttempt((v) => v + 1)}>다시 불러오기</Button>}</div>}
    {draft ? <AccountChoices value={draft} onChange={setDraft} disabled={busy} /> : !error && <p>계정을 불러오는 중…</p>}
    <DialogFooter><Button variant="ghost" disabled={busy} onClick={onClose}>취소</Button><Button disabled={!draft || busy} onClick={() => void save()}>{busy ? "저장 중…" : "계정 선택 저장"}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
