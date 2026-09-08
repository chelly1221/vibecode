import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, CloudDownload, GitBranch, Loader2, RotateCw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ipc, type Provider } from "@/lib/ipc";
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
        프로젝트를 선택하면 변경 내역을 확인할 수 있어요.
      </div>
    );
  }

  if (status && !status.is_repo) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
        <GitBranch className="size-6" />
        <p>이 프로젝트는 아직 변경 기록을 사용하지 않아요.</p>
        <p>변경 기록을 시작하면 수정한 내용을 버전으로 저장하고 이전 상태를 확인할 수 있어요.</p>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() =>
              ipc.git
                .init(activeProjectId!)
                .then(() => {
                  toast.success("변경 기록을 시작했습니다");
                  return refresh();
                })
                .catch((e) => toast.error("변경 기록을 시작하지 못했어요", { description: String(e) }))
            }
          >
            <GitBranch /> 변경 기록 시작하기
          </Button>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            <RotateCw /> 다시 확인
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2"><h2 className="text-sm font-semibold">변경 내역</h2><Button size="icon-sm" variant="ghost" aria-label="변경 내역 닫기" onClick={() => useAppStore.getState().setGitPanelOpen(false)}><X /></Button></div>
      <header className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
        <BranchMenu key={activeProjectId} />
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
          <ActionButton label="온라인 변경 확인" name="fetch" icon={<CloudDownload />} onRun={fetch} />
          <ActionButton label="온라인 변경 가져오기" name="pull" icon={<ArrowDown />} onRun={pull} />
          <ActionButton label="온라인에 올리기" name="push" icon={<ArrowUp />} onRun={push} />
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

      {error && <div role="alert" className="border-b bg-destructive/10 p-3 text-xs text-destructive"><p>변경 기록 작업을 완료하지 못했어요. 설치 상태나 연결을 확인하고 다시 시도해 주세요.</p><details className="mt-2"><summary className="cursor-pointer">오류 자세히 보기</summary><pre className="mt-2 whitespace-pre-wrap break-all">{error}</pre></details></div>}

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
          <CommitBox key={activeProjectId} provider={provider} />
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
