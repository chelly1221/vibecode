import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TitleBar } from "@/components/TitleBar";
import { useAppStore } from "@/stores/app";
import { Onboarding } from "@/features/onboarding/Onboarding";
import { ProjectSidebar } from "@/features/projects/ProjectSidebar";
import { ProjectWizard } from "@/features/projects/ProjectWizard";
import { AgentDocsPrompt } from "@/features/projects/AgentDocsPrompt";
import { ChatView } from "@/features/chat/ChatView";
import { UsageStrip } from "@/features/usage/UsageStrip";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

const FilesPanel = lazy(() => import("@/features/files/FilesPanel").then((m) => ({ default: m.FilesPanel })));
const GitPanel = lazy(() => import("@/features/git/GitPanel").then((m) => ({ default: m.GitPanel })));
const TerminalPanel = lazy(() => import("@/features/terminal/TerminalPanel").then((m) => ({ default: m.TerminalPanel })));
const SettingsDialog = lazy(() => import("@/features/settings/SettingsDialog").then((m) => ({ default: m.SettingsDialog })));
const PreviewPane = lazy(() => import("@/features/preview/PreviewPane").then((m) => ({ default: m.PreviewPane })));
const UsagePanel = lazy(() => import("@/features/usage/UsagePanel").then((m) => ({ default: m.UsagePanel })));
const ApplyBuildDialog = lazy(() => import("@/features/settings/ApplyBuildDialog").then((m) => ({ default: m.ApplyBuildDialog })));

export default function App() {
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const settings = useAppStore((s) => s.settings);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const loadProjects = useAppStore((s) => s.loadProjects);
  const gitPanelOpen = useAppStore((s) => s.gitPanelOpen);
  const previewOpen = useAppStore((s) => s.previewOpen);
  const terminalOpen = useAppStore((s) => s.terminalOpen);
  const filesPanelOpen = useAppStore((s) => s.filesPanelOpen);
  const usagePanelOpen = useAppStore((s) => s.usagePanelOpen);
  const applyBuildOpen = useAppStore((s) => s.applyBuildOpen);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      await Promise.all([loadSettings(), loadProjects()]);
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  }, [loadSettings, loadProjects]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  // Panel shortcuts: Ctrl+1 git, Ctrl+2 terminal, Ctrl+3 files, Ctrl+4 preview, Ctrl+5 usage, Ctrl+, settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const st = useAppStore.getState();
      if (!st.settings?.onboarding_done) return;
      const map: Record<string, () => void> = {
        "1": () => st.setGitPanelOpen(!st.gitPanelOpen),
        "2": () => st.setTerminalOpen(!st.terminalOpen),
        "3": () => st.setFilesPanelOpen(!st.filesPanelOpen),
        "4": () => st.setPreviewOpen(!st.previewOpen),
        "5": () => st.setUsagePanelOpen(!st.usagePanelOpen),
        ",": () => st.setSettingsOpen(true),
      };
      const fn = map[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);


  const onboarding = settings && !settings.onboarding_done;

  // Silent update check once per launch (never blocks; failures are ignored).
  const updateChecked = useRef(false);
  useEffect(() => {
    if (!settings?.onboarding_done || !settings.auto_update_check || updateChecked.current) return;
    const t = window.setTimeout(() => {
      updateChecked.current = true;
      checkUpdate()
        .then((u) => {
          if (u) toast.info(`새 버전 v${u.version} 이 있습니다 — 설정 > 정보에서 설치`, { duration: 10000 });
        })
        .catch(() => {});
    }, 4000);
    return () => window.clearTimeout(t);
  }, [settings?.onboarding_done, settings?.auto_update_check]);

  return (
    <TooltipProvider>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
        <TitleBar showPanels={!loading && !loadError && !!settings && !onboarding} />
        {loading || loadError || !settings ? (
          <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center" aria-live="polite">
            {loading ? <Loader2 className="size-8 animate-spin text-primary" /> : <RefreshCw className="size-8 text-primary" />}
            <h1 className="text-xl font-semibold">{loading ? "작업 공간을 준비하고 있어요" : "작업 공간을 불러오지 못했어요"}</h1>
            {!loading && <>
              <p className="text-sm text-muted-foreground">잠시 후 다시 시도해 주세요. 문제가 계속되면 앱을 다시 열어 주세요.</p>
              <Button onClick={() => void load()}><RefreshCw /> 다시 시도</Button>
              <details className="max-w-xl text-left text-xs text-muted-foreground"><summary>오류 자세히 보기</summary><pre className="mt-2 whitespace-pre-wrap break-all">{loadError}</pre></details>
            </>}
          </main>
        ) : onboarding ? (
          <Onboarding />
        ) : (
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <ProjectSidebar />
            {filesPanelOpen && <Suspense fallback={<PanelLoading />}><FilesPanel /></Suspense>}
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1">
                <main className="relative flex min-w-0 flex-1 flex-col">
                  <UsageStrip />
                  {previewOpen ? (
                    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
                      <ResizablePanel defaultSize={45} minSize={25}>
                        <div className="flex h-full min-h-0 flex-col">
                          <ChatView />
                        </div>
                      </ResizablePanel>
                      <ResizableHandle withHandle />
                      <ResizablePanel defaultSize={55} minSize={25}>
                        <Suspense fallback={<PanelLoading />}><PreviewPane /></Suspense>
                      </ResizablePanel>
                    </ResizablePanelGroup>
                  ) : (
                    <ChatView />
                  )}
                </main>
                {gitPanelOpen && (
                  <aside className="w-[min(24rem,38vw)] shrink-0 border-l">
                    <Suspense fallback={<PanelLoading />}><GitPanel /></Suspense>
                  </aside>
                )}
                {usagePanelOpen && (
                  <aside className="w-[min(26rem,40vw)] shrink-0 border-l" aria-label="남은 사용량">
                    <Suspense fallback={<PanelLoading />}><UsagePanel /></Suspense>
                  </aside>
                )}
              </div>
              {terminalOpen && (
                <div className="h-64 shrink-0 border-t">
                  <Suspense fallback={<PanelLoading />}><TerminalPanel /></Suspense>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {!loading && !loadError && settings && !onboarding && (
        <>
          <ProjectWizard />
          {settingsOpen && <Suspense fallback={null}><SettingsDialog /></Suspense>}
          {applyBuildOpen && <Suspense fallback={null}><ApplyBuildDialog /></Suspense>}
          <AgentDocsPrompt />
        </>
      )}
      <Toaster />
    </TooltipProvider>
  );
}

function PanelLoading() {
  return <div role="status" className="flex min-h-0 flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> 화면을 준비하고 있어요</div>;
}
