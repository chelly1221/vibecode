import { useCallback, useEffect, useState } from "react";
import { ExternalLink, FolderOpen, KeyRound, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ipc, type AppSettings, type GitHubUser, type ToolStatus } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";
import { AuthCards } from "@/features/onboarding/AuthCards";
import { DefaultsForm } from "@/features/onboarding/DefaultsForm";
import { ToolsTable } from "@/features/onboarding/ToolsTable";
import { McpTab } from "./McpTab";
import { SshKeySection } from "./SshKeySection";
import { UpdateSection } from "./UpdateSection";

/** App settings dialog (controlled by `useAppStore.settingsOpen`). */
export function SettingsDialog() {
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);

  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const patch = useCallback((p: Partial<AppSettings>) => setDraft((d) => (d ? { ...d, ...p } : d)), []);

  useEffect(() => {
    if (open && settings) setDraft(settings);
  }, [open, settings]);

  const dirty = !!draft && !!settings && JSON.stringify(draft) !== JSON.stringify(settings);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await saveSettings(draft);
      toast.success("설정을 저장했습니다");
    } catch (e) {
      toast.error(`저장 실패: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>설정</DialogTitle>
          <DialogDescription>기본값, 도구, 계정, MCP 서버를 관리합니다.</DialogDescription>
        </DialogHeader>
        {draft && (
          <Tabs defaultValue="general" className="min-h-0 flex-1">
            <TabsList>
              <TabsTrigger value="general">일반</TabsTrigger>
              <TabsTrigger value="tools">도구</TabsTrigger>
              <TabsTrigger value="accounts">계정</TabsTrigger>
              <TabsTrigger value="mcp">MCP</TabsTrigger>
              <TabsTrigger value="about">정보</TabsTrigger>
            </TabsList>
            <div className="min-h-0 flex-1 overflow-y-auto pt-4 pr-1">
              <TabsContent value="general">
                <DefaultsForm draft={draft} onChange={patch} />
              </TabsContent>
              <TabsContent value="tools">
                <ToolsTab draft={draft} patch={patch} />
              </TabsContent>
              <TabsContent value="accounts">
                <AccountsTab />
              </TabsContent>
              <TabsContent value="mcp">
                <McpTab draft={draft} patch={patch} />
              </TabsContent>
              <TabsContent value="about">
                <AboutTab />
              </TabsContent>
            </div>
          </Tabs>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            닫기
          </Button>
          <Button onClick={save} disabled={!dirty || saving}>
            <Save className="size-4" /> 저장
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ToolsTab({ draft, patch }: { draft: AppSettings; patch: (p: Partial<AppSettings>) => void }) {
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [loading, setLoading] = useState(false);

  const detect = useCallback(async () => {
    setLoading(true);
    try {
      setTools(await ipc.tools.detect());
    } catch (e) {
      toast.error(`도구 감지 실패: ${String(e)}`);
      setTools([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    detect().catch(() => {});
  }, [detect]);

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">Claude Code · Codex · git은 Windows에 설치된 것을 직접 실행합니다. 없는 도구는 "설치"를 누르면 앱이 바로 설치합니다(관리자 권한 창이 뜨면 허용).</p>
      <ToolsTable tools={tools} loading={loading} onRefresh={detect} compact />
      <Separator />
      <div className="grid gap-4 md:grid-cols-3">
        {(
          [
            ["claude_bin", "claude 실행 파일"],
            ["codex_bin", "codex 실행 파일"],
            ["git_bin", "git 실행 파일"],
          ] as const
        ).map(([key, label]) => (
          <div key={key} className="space-y-1.5">
            <Label>{label}</Label>
            <div className="flex gap-1.5">
              <Input
                placeholder="비우면 PATH에서 찾음"
                value={draft[key] ?? ""}
                onChange={(e) => patch({ [key]: e.target.value.trim() || null } as Partial<AppSettings>)}
              />
              <Button
                size="icon"
                variant="outline"
                aria-label={`${label} 찾아보기`}
                onClick={async () => {
                  const picked = await openFileDialog({ multiple: false, title: `${label} 선택`, filters: [{ name: "실행 파일", extensions: ["exe", "cmd", "bat"] }] }).catch(() => null);
                  if (typeof picked === "string") patch({ [key]: picked } as Partial<AppSettings>);
                }}
              >
                <FolderOpen className="size-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        비워 두면 PATH에서 찾습니다. 다른 위치에 설치했다면 전체 경로를 적으세요 (예: C:\\Users\\me\\.local\\bin\\claude.exe).
      </p>
    </div>
  );
}

function AccountsTab() {
  const [user, setUser] = useState<GitHubUser | null | undefined>(undefined);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const loadUser = useCallback(async () => {
    try {
      setUser(await ipc.github.whoami());
    } catch (e) {
      setUser(null);
      toast.error(`GitHub 확인 실패: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    loadUser().catch(() => {});
  }, [loadUser]);

  const connect = async () => {
    if (!token.trim()) return;
    setBusy(true);
    try {
      const u = await ipc.github.setToken(token.trim());
      setUser(u);
      setToken("");
      toast.success(`GitHub 연결됨: ${u.login}`);
    } catch (e) {
      toast.error(`토큰 확인 실패: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await ipc.github.clearToken();
      setUser(null);
      toast.success("GitHub 연결을 해제했습니다");
    } catch (e) {
      toast.error(`해제 실패: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-sm font-medium">에이전트 로그인</h3>
        <p className="text-xs text-muted-foreground">"로그인"을 누르면 브라우저가 열립니다. Claude는 브라우저에 표시된 인증 코드를 붙여넣고, Codex는 브라우저에서 승인만 하면 됩니다.</p>
        <AuthCards />
      </section>
      <Separator />
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="size-4" /> GitHub
        </h3>
        {user === undefined ? (
          <p className="text-sm text-muted-foreground">확인 중...</p>
        ) : user ? (
          <div className="flex items-center gap-3 rounded-lg border p-3">
            {user.avatar_url && <img src={user.avatar_url} alt="" className="size-9 rounded-full" />}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{user.name ?? user.login}</div>
              <div className="text-xs text-muted-foreground">@{user.login}</div>
            </div>
            <Button variant="ghost" size="sm" onClick={loadUser}>
              <RefreshCw className="size-3.5" />
            </Button>
            <Button variant="outline" size="sm" onClick={disconnect} disabled={busy}>
              연결 해제
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              저장소 자동 생성에 사용할 Personal Access Token (repo 권한)을 입력하세요. 토큰은 Windows 자격 증명 관리자에 저장됩니다.
            </p>
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder="ghp_… 또는 github_pat_…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && connect()}
              />
              <Button onClick={connect} disabled={busy || !token.trim()}>
                연결
              </Button>
            </div>
            <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => openUrl("https://github.com/settings/tokens/new?scopes=repo&description=vibecode")}>
              GitHub에서 토큰 만들기 <ExternalLink className="size-3" />
            </Button>
          </div>
        )}
      </section>
      <Separator />
      <SshKeySection />
    </div>
  );
}

function AboutTab() {
  const [version, setVersion] = useState<string>("");
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion("?"));
  }, []);
  const links = [
    ["소스 저장소", "https://github.com/chelly1221/vibecode"],
    ["Claude Code 문서", "https://code.claude.com/docs"],
    ["Codex 문서", "https://developers.openai.com/codex"],
    ["Tauri", "https://v2.tauri.app"],
  ];
  return (
    <div className="space-y-4 text-sm">
      <div>
        <div className="text-lg font-semibold">Vibecoder</div>
        <div className="text-muted-foreground">버전 {version || "..."} · Tauri v2 + Rust + React</div>
      </div>
      <p className="text-muted-foreground">
        Claude Code, OpenAI Codex, git을 한 화면에서 다루는 개인용 바이브코딩 도구입니다.
      </p>
      <UpdateSection />
      <ul className="space-y-1">
        {links.map(([label, url]) => (
          <li key={url}>
            <Button variant="link" className="h-auto p-0" onClick={() => openUrl(url)}>
              {label} <ExternalLink className="size-3" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
