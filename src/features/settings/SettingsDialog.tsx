import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, FolderOpen, Save } from "lucide-react";
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
import { ipc, type AppSettings, type ToolStatus } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";
import { AccountManager } from "@/features/accounts/AccountManager";
import { DefaultsForm } from "@/features/onboarding/DefaultsForm";
import { ToolsTable } from "@/features/onboarding/ToolsTable";
import { ConfirmDialog } from "@/features/projects/ConfirmDialog";
import { McpTab } from "./McpTab";
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

  const wasOpen = useRef(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  useEffect(() => {
    if (open && !wasOpen.current && settings) setDraft(settings);
    wasOpen.current = open;
  }, [open, settings]);

  const dirty = !!draft && !!settings && JSON.stringify(draft) !== JSON.stringify(settings);

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      await saveSettings(draft);
      setDraft(useAppStore.getState().settings);
      toast.success("설정을 저장했습니다");
    } catch (e) {
      toast.error(`저장 실패: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const requestClose = (next: boolean) => {
    if (saving) return;
    if (!next && dirty) setConfirmDiscard(true);
    else setOpen(next);
  };
  return (
    <>
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>설정</DialogTitle>
          <DialogDescription>AI 계정, 저장 위치와 작업 방식을 설정하세요.</DialogDescription>
        </DialogHeader>
        {draft && (
          <fieldset disabled={saving} className="flex min-h-0 flex-1 flex-col">
          <Tabs defaultValue="general" className="min-h-0 flex-1">
            <TabsList>
              <TabsTrigger value="general">일반</TabsTrigger>
              <TabsTrigger value="tools">도구</TabsTrigger>
              <TabsTrigger value="accounts">계정</TabsTrigger>
              <TabsTrigger value="mcp">외부 도구 연결</TabsTrigger>
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
                <AccountManager />
              </TabsContent>
              <TabsContent value="mcp">
                <McpTab draft={draft} patch={patch} />
              </TabsContent>
              <TabsContent value="about">
                <AboutTab />
              </TabsContent>
            </div>
          </Tabs>
          </fieldset>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={() => requestClose(false)}>
            닫기
          </Button>
          <Button onClick={save} disabled={!dirty || saving}>
            <Save className="size-4" /> {saving ? "저장 중…" : "변경 저장"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <ConfirmDialog open={confirmDiscard} onOpenChange={setConfirmDiscard} title="저장하지 않은 설정이 있어요" description="그대로 닫으면 방금 바꾼 설정은 적용되지 않습니다." confirmLabel="저장하지 않고 닫기" onConfirm={() => setOpen(false)} />
    </>
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
      <details className="rounded-xl border p-4"><summary className="cursor-pointer text-sm font-medium">프로그램 위치 직접 지정 (고급)</summary>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
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
                placeholder="자동으로 찾기"
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
        비워 두면 자동으로 찾습니다. 다른 위치에 설치했다면 전체 경로를 적으세요 (예: C:\\Users\\me\\.local\\bin\\claude.exe).
      </p>
      </details>
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
        <div className="text-muted-foreground">버전 {version || "..."} · Windows용</div>
      </div>
      <p className="text-muted-foreground">
        AI와 대화하며 프로그램을 만들고, 결과를 확인하고, 변경 기록을 관리하는 작업 공간입니다.
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
