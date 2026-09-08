import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ipc, type AccountKind, type AccountProfile, type AuthStatus, type GitHubUser } from "@/lib/ipc";
import { LoginPanel } from "@/features/onboarding/LoginPanel";
import { ConfirmDialog } from "@/features/projects/ConfirmDialog";

export const ACCOUNT_LABELS: Record<AccountKind, string> = { claude: "Claude Code", codex: "Codex", github: "GitHub" };
export const selectClass = "h-9 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-50";

export function AccountManager({ onChanged }: { onChanged?: () => void }) {
  const [profiles, setProfiles] = useState<AccountProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AccountKind>("claude");
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<AccountProfile | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setProfiles(await ipc.accounts.list()); setError(null); }
    catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const create = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const profile = await ipc.accounts.create(name.trim(), kind);
      setName(""); setActive(profile.id); await refresh(); onChanged?.();
      toast.success("계정을 등록했습니다. 아래에서 로그인해 주세요.");
    } catch (e) { toast.error("계정을 등록하지 못했습니다", { description: String(e) }); }
    finally { setBusy(false); }
  };
  const deleteProfile = async () => {
    if (!remove || busy) return;
    setBusy(true);
    try { await ipc.accounts.remove(remove.id); if (active === remove.id) setActive(null); await refresh(); onChanged?.(); }
    catch (e) { toast.error("계정을 삭제하지 못했습니다", { description: String(e) }); }
    finally { setBusy(false); }
  };
  return <div className="space-y-5" data-testid="account-manager">
    <div><h3 className="font-medium">프로젝트에서 사용할 계정</h3><p className="mt-1 text-sm text-muted-foreground">계정을 한 번 등록한 뒤 원하는 프로젝트에 연결하세요. AI는 설치된 Claude Code와 Codex의 로그인으로 사용합니다.</p></div>
    <form className="grid gap-3 rounded-xl border p-4 sm:grid-cols-[140px_1fr_auto]" onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <label className="grid gap-1.5 text-sm">서비스<select className={selectClass} value={kind} onChange={(e) => setKind(e.target.value as AccountKind)} disabled={busy}>{Object.entries(ACCOUNT_LABELS).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <div className="grid gap-1.5"><Label htmlFor="account-name">구분할 이름</Label><Input id="account-name" value={name} maxLength={50} onChange={(e) => setName(e.target.value)} placeholder="예: 민수 개인용, 디자인팀" disabled={busy} /></div>
      <Button type="submit" className="self-end" disabled={busy || !name.trim()}><Plus /> 계정 등록</Button>
    </form>
    {error && <div role="alert" className="text-sm text-destructive">{error}<Button variant="outline" size="sm" onClick={() => void refresh()}>다시 불러오기</Button></div>}
    {loading && <p className="text-sm text-muted-foreground">계정을 불러오는 중…</p>}
    {!loading && !error && profiles.length === 0 && <p className="rounded-xl border border-dashed p-5 text-center text-sm text-muted-foreground">등록된 계정이 없습니다. 사용할 계정을 위에서 추가하세요.</p>}
    {profiles.map((profile) => <section key={profile.id} className="rounded-xl border p-4" data-testid={`account-${profile.id}`}>
      <div className="flex items-center gap-2">
        <button type="button" className="min-w-0 flex-1 text-left" aria-expanded={active === profile.id} onClick={() => setActive(active === profile.id ? null : profile.id)}><span className="block truncate font-medium">{profile.name}</span><span className="text-xs text-muted-foreground">{ACCOUNT_LABELS[profile.kind]}</span></button>
        <Button variant="outline" size="sm" onClick={() => setActive(active === profile.id ? null : profile.id)}>{active === profile.id ? "접기" : "연결 확인"}</Button>
        <Button variant="ghost" size="icon" aria-label={`${profile.name} 삭제`} disabled={busy} onClick={() => setRemove(profile)}><Trash2 className="size-4" /></Button>
      </div>
      {active === profile.id && <AccountConnection key={profile.id} profile={profile} />}
    </section>)}
    <ConfirmDialog open={!!remove} onOpenChange={(open) => !open && setRemove(null)} title="계정을 삭제할까요?" description={`${remove?.name ?? ""}의 앱 로그인 저장소가 삭제됩니다. 프로젝트나 대화에서 사용 중인 계정은 삭제할 수 없습니다.`} confirmLabel="계정 삭제" onConfirm={deleteProfile} />
  </div>;
}

function AccountConnection({ profile }: { profile: AccountProfile }) {
  const [status, setStatus] = useState<AuthStatus | GitHubUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState(false);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(profile.kind === "github" ? await ipc.github.whoami(profile.id) : await ipc.tools.authStatus(profile.kind, profile.id));
      setError(null);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, [profile.id, profile.kind]);
  useEffect(() => { void refresh(); }, [refresh]);
  const connected = status && ("logged_in" in status ? status.logged_in : true);
  const identity = status && ("logged_in" in status ? status.account : status.login);
  const connect = async () => {
    if (saving || !token.trim()) return;
    setSaving(true);
    try { setStatus(await ipc.github.setToken(token.trim(), profile.id)); setToken(""); setError(null); toast.success("GitHub 계정을 연결했습니다"); }
    catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  };
  return <div className="mt-4 space-y-3 border-t pt-3">
    <div className="flex items-center gap-2 text-sm"><span className={connected ? "text-emerald-600" : "text-muted-foreground"}>{loading ? "확인 중…" : connected ? `연결됨${identity ? ` · ${identity}` : ""}` : "로그인이 필요합니다"}</span><Button size="icon-xs" variant="ghost" aria-label="연결 상태 새로고침" disabled={loading} onClick={() => void refresh()}><RefreshCw /></Button></div>
    {error && <p role="alert" className="break-all text-sm text-destructive">{error}</p>}
    {profile.kind === "github" ? <>
      <p className="text-xs text-muted-foreground">이 GitHub 계정의 저장소 접근 토큰을 입력하세요. Windows 자격 증명 관리자에 계정별로 보관합니다.</p>
      <div className="flex gap-2"><Input type="password" autoComplete="off" aria-label="GitHub 접근 토큰" value={token} onChange={(e) => setToken(e.target.value)} placeholder="GitHub 접근 토큰" /><Button disabled={!token.trim() || saving} onClick={() => void connect()}>연결</Button></div>
      <Button variant="link" className="h-auto p-0 text-xs" onClick={() => void openUrl("https://github.com/settings/tokens").catch((e) => setError(String(e)))}>GitHub에서 접근 토큰 관리</Button>
    </> : login ? <LoginPanel accountId={profile.id} provider={profile.kind} onClose={() => setLogin(false)} onFinished={(ok) => { void refresh(); if (ok) setLogin(false); }} /> : <Button disabled={loading} variant="outline" onClick={() => setLogin(true)}>{connected ? "이 계정 다시 로그인" : `${ACCOUNT_LABELS[profile.kind]} 로그인`}</Button>}
  </div>;
}
