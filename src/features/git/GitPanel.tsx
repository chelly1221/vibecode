import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, CloudDownload, GitBranch, Loader2, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Provider } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";
import { useGitStore } from "@/stores/git";
import { BranchMenu } from "./BranchMenu";
import { CommitBox } from "./CommitBox";
import { DiffViewer } from "./DiffViewer";
import { LogList } from "./LogList";
import { StatusGroups } from "./StatusGroups";

const REFRESH_MS = 5000;

function ActionButton({ label, icon, name, onRun }: { label: string; icon: React.ReactNode; name: string; onRun: () => Promise<string> }) {
  const busy = useGitStore((s) => s.busy);
  const run = async () => {
    try {
      const out = await onRun();
      toast.success(`${label} 완료`, { description: out.trim().split("\n").slice(-2).join("\n") || undefined });
    } catch (e) {
      toast.error(`${label} 실패`, { description: String(e).slice(0, 300) });
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon-sm" variant="ghost" onClick={run} disabled={busy !== null} aria-label={label}>
          {busy === name ? <Loader2 className="animate-spin" /> : icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Right-hand git panel for the active project. */
export function GitPanel() {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const projects = useAppStore((s) => s.projects);
  const settings = useAppStore((s) => s.settings);
  const setProject = useGitStore((s) => s.setProject);
  const refresh = useGitStore((s) => s.refresh);
  const loadLog = useGitStore((s) => s.loadLog);
  const status = useGitStore((s) => s.status);
  const loading = useGitStore((s) => s.loading);
  const error = useGitStore((s) => s.error);
  const push = useGitStore((s) => s.push);
  const pull = useGitStore((s) => s.pull);
  const fetch = useGitStore((s) => s.fetch);
  const [tab, setTab] = useState("changes");

  const project = projects.find((p) => p.id === activeProjectId);
  const provider: Provider = project?.default_provider ?? settings?.default_provider ?? "claude";

  // Track the active project and poll while visible.
  useEffect(() => {
    setProject(activeProjectId);
    if (!activeProjectId) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [activeProjectId, setProject, refresh]);

  useEffect(() => {
    if (tab === "log" && activeProjectId) void loadLog();
  }, [tab, activeProjectId, loadLog, status?.branch]);

  if (!activeProjectId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
        <GitBranch className="size-6" />
        프로젝트를 선택하면 git 상태가 표시됩니다.
      </div>
    );
  }

  if (status && !status.is_repo) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
        <GitBranch className="size-6" />
        <p>이 폴더는 git 저장소가 아닙니다.</p>
        <p>
          터미널에서 <code className="rounded bg-muted px-1 font-mono">git init</code>을 실행하거나 에이전트에게 요청하세요.
        </p>
        <Button size="sm" variant="outline" onClick={() => void refresh()}>
          <RotateCw /> 다시 확인
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-1 border-b px-2 py-1.5">
        <BranchMenu />
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            {status.ahead > 0 && (
              <span className="rounded bg-muted px-1" title="푸시할 커밋">
                ↑{status.ahead}
              </span>
            )}
            {status.behind > 0 && (
              <span className="rounded bg-muted px-1" title="가져올 커밋">
                ↓{status.behind}
              </span>
            )}
          </span>
        )}
        <div className="ml-auto flex items-center">
          <ActionButton label="fetch" name="fetch" icon={<CloudDownload />} onRun={fetch} />
          <ActionButton label="pull" name="pull" icon={<ArrowDown />} onRun={pull} />
          <ActionButton label="push" name="push" icon={<ArrowUp />} onRun={push} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="ghost" onClick={() => void refresh()} aria-label="새로고침">
                <RotateCw className={loading ? "animate-spin" : ""} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>새로고침</TooltipContent>
          </Tooltip>
        </div>
      </header>

      {error && <div className="border-b bg-destructive/10 px-2 py-1 text-[11px] text-destructive">{error}</div>}

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList variant="line" className="mx-2 mt-1 w-auto justify-start">
          <TabsTrigger value="changes">
            변경
            {status && status.files.length > 0 && <span className="rounded bg-muted px-1 text-[10px]">{status.files.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="log">기록</TabsTrigger>
        </TabsList>
        <TabsContent value="changes" className="flex min-h-0 flex-1 flex-col">
          <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
            <ResizablePanel defaultSize={45} minSize={20}>
              <ScrollArea className="h-full">
                <StatusGroups />
              </ScrollArea>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={55} minSize={20}>
              <DiffViewer />
            </ResizablePanel>
          </ResizablePanelGroup>
          <CommitBox provider={provider} />
        </TabsContent>
        <TabsContent value="log" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <LogList />
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}
