import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ipc, type AccountKind, type AccountProfile, type ProjectAccounts } from "@/lib/ipc";
import { AccountManager, ACCOUNT_LABELS, selectClass } from "./AccountManager";

export function AccountChoices({ value, onChange, disabled = false }: { value: ProjectAccounts; onChange: (value: ProjectAccounts) => void; disabled?: boolean }) {
  const [profiles, setProfiles] = useState<AccountProfile[]>([]);
  const [manage, setManage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const refresh = useCallback(async () => { try { setProfiles(await ipc.accounts.list()); setError(null); } catch (e) { setError(String(e)); } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return <section className="space-y-3 rounded-xl border p-4" data-testid="project-account-choices">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">이 프로젝트에서 사용할 계정</h3><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setManage(true)}>계정 등록·관리</Button></div>
    <p className="text-xs text-muted-foreground">사용할 AI의 계정을 선택하세요. GitHub 계정은 저장소를 업로드하거나 내려받을 때 필요합니다.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}<Button type="button" size="sm" variant="link" onClick={() => void refresh()}>다시 불러오기</Button></p>}
    <div className="grid gap-3 sm:grid-cols-3">{(["claude", "codex", "github"] as AccountKind[]).map((kind) => <label key={kind} className="grid gap-1.5 text-sm">{ACCOUNT_LABELS[kind]}<select className={selectClass} data-testid={`account-select-${kind}`} value={value[kind] ?? ""} disabled={disabled} onChange={(e) => onChange({ ...value, [kind]: e.target.value || null })}>
      <option value="">계정을 선택하세요</option>
      {profiles.filter((p) => p.kind === kind).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      {value[kind] && !profiles.some((p) => p.id === value[kind]) && <option value={value[kind]!}>선택한 계정을 찾을 수 없습니다</option>}
    </select></label>)}</div>
    <details><summary className="cursor-pointer text-xs text-muted-foreground">Git 커밋 작성자 설정</summary><div className="mt-3 grid gap-3 sm:grid-cols-2"><div className="grid gap-1.5"><Label htmlFor={`${id}-name`}>이름</Label><Input id={`${id}-name`} value={value.git_user_name ?? ""} disabled={disabled} placeholder="커밋에 표시할 이름" onChange={(e) => onChange({ ...value, git_user_name: e.target.value || null })} /></div><div className="grid gap-1.5"><Label htmlFor={`${id}-email`}>이메일</Label><Input id={`${id}-email`} value={value.git_user_email ?? ""} disabled={disabled} placeholder="커밋에 표시할 이메일" onChange={(e) => onChange({ ...value, git_user_email: e.target.value || null })} /></div></div></details>
    <Dialog open={manage} onOpenChange={setManage}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>계정 등록·관리</DialogTitle><DialogDescription>계정을 연결한 후 이 창을 닫고 프로젝트에서 선택하세요.</DialogDescription></DialogHeader><AccountManager onChanged={() => void refresh()} /></DialogContent></Dialog>
  </section>;
}
