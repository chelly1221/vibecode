// UI preview ("디자인 모드"): runs the project's dev server, shows it in a Tauri child webview that
// is positioned over this pane, and lets the user pick elements / forward console errors to the agent.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertCircle, Loader2, Settings2, ExternalLink, MousePointerClick, Play, RefreshCw, Square, TerminalSquare, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ipc, type StackInfo } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app";
import { DEVICE_SIZES, usePreviewStore, type DevicePreset } from "@/stores/preview";

let stacksCache: Promise<StackInfo[]> | null = null;
const loadStacks = () => (stacksCache ??= ipc.projects.stacksList().catch((e) => { stacksCache = null; throw e; }));

const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper], [data-slot="sheet-content"]';

export function PreviewPane() {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const projects = useAppStore((s) => s.projects);
  const setPreviewOpen = useAppStore((s) => s.setPreviewOpen);
  const insertIntoComposer = useAppStore((s) => s.insertIntoComposer);
  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  const pv = usePreviewStore();
  const hostRef = useRef<HTMLDivElement>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [hiddenByOverlay, setHiddenByOverlay] = useState(false);
  const autoOpened = useRef<string | null>(null);

  // Reset project-specific commands/URLs before loading this project's server state.
  useEffect(() => {
    pv.setProject(project?.id ?? null);
    autoOpened.current = null;
    if (!project) return;
    let cancelled = false;
    void (async () => {
      try {
        await pv.syncStatus(project.id);
        if (cancelled || !project.stack_id) return;
        const stacks = await loadStacks();
        if (cancelled) return;
        const command = stacks.find((s) => s.id === project.stack_id)?.dev_command;
        if (command && !usePreviewStore.getState().command) pv.setCommand(command);
      } catch (e) { if (!cancelled) toast.error("미리보기 설정을 불러오지 못했어요", { description: String(e) }); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  useEffect(() => {
    pv.ensureListener();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Bounds of the webview inside the window (CSS px), honouring the device preset. */
  const computeBounds = useCallback(() => {
    const host = hostRef.current;
    if (!host) return null;
    const r = host.getBoundingClientRect();
    const size = DEVICE_SIZES[pv.device];
    let width = r.width;
    let height = r.height;
    let x = r.left;
    let y = r.top;
    if (size.width && size.height) {
      const scale = Math.min(1, r.width / size.width, r.height / size.height);
      width = Math.floor(size.width * scale);
      height = Math.floor(size.height * scale);
      x = r.left + Math.floor((r.width - width) / 2);
      y = r.top + Math.floor((r.height - height) / 2);
    }
    return { x: Math.round(x), y: Math.round(y), width: Math.max(50, Math.round(width)), height: Math.max(50, Math.round(height)) };
  }, [pv.device]);

  // Keep the child webview aligned with this pane.
  useEffect(() => {
    if (!pv.webviewOpen) return;
    let raf = 0;
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const b = computeBounds();
        if (b) ipc.preview.setBounds(b).catch(() => {});
      });
    };
    sync();
    const ro = new ResizeObserver(sync);
    if (hostRef.current) ro.observe(hostRef.current);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
      cancelAnimationFrame(raf);
    };
  }, [pv.webviewOpen, pv.device, computeBounds]);

  // Hide the native child webview while any dialog/popover is open (it would paint over them).
  useEffect(() => {
    if (!pv.webviewOpen) return;
    let previous: boolean | null = null;
    const check = () => {
      const covered = !!document.querySelector(OVERLAY_SELECTOR);
      if (covered === previous) return;
      previous = covered;
      setHiddenByOverlay(covered);
      ipc.preview.setVisible(!covered).catch(() => {});
    };
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true });
    check();
    return () => mo.disconnect();
  }, [pv.webviewOpen]);

  // Auto-open once the dev server prints its URL.
  useEffect(() => {
    if (pv.projectId === activeProjectId && pv.url && pv.running && autoOpened.current !== pv.url) {
      autoOpened.current = pv.url;
      const b = computeBounds();
      if (b) pv.openUrl(pv.url, b).catch((e) => { autoOpened.current = null; toast.error(`미리보기 열기 실패: ${String(e)}`); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pv.url, pv.running, pv.projectId, activeProjectId]);

  // Close the native webview when the pane unmounts.
  useEffect(() => () => void pv.closeWebview(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const openManual = async () => {
    const url = (pv.manualUrl || pv.url || "").trim();
    if (!url) return toast.error("URL을 입력하세요");
    const b = computeBounds();
    if (!b) return;
    try {
      await pv.openUrl(url.startsWith("http") ? url : `http://${url}`, b);
    } catch (e) {
      toast.error(`미리보기 열기 실패: ${String(e)}`);
    }
  };

  const start = async () => {
    if (!project) return toast.error("프로젝트를 먼저 선택하세요");
    autoOpened.current = null;
    try {
      await pv.start(project.id);
    } catch (e) {
      toast.error(`미리보기를 시작하지 못했어요: ${String(e)}`);
    }
  };

  const errors = useMemo(() => pv.console.filter((c) => c.level === "error"), [pv.console]);
  const forwardConsole = () => {
    const tail = pv.console.slice(-10).map((c) => `[${c.level}] ${c.message}`).join("\n");
    insertIntoComposer(`[미리보기 콘솔 오류]\n${tail}\n\n위 오류를 고쳐줘.`);
    toast.success("입력창에 콘솔 오류를 넣었습니다");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5 text-xs">
        <span className="mr-1 font-semibold">미리보기</span>
        {pv.running ? (
          <Button size="sm" variant="outline" onClick={() => pv.stop().catch((e) => toast.error(String(e)))}><Square className="size-3.5" /> 멈추기</Button>
        ) : (
          <Button size="sm" onClick={start} disabled={!project || pv.starting || !pv.command}>
            {pv.starting ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} {pv.starting ? "준비 중…" : "미리보기 시작"}
          </Button>
        )}
        <Popover>
          <PopoverTrigger asChild><Button variant="ghost" size="sm"><Settings2 className="size-3.5" /> 실행 설정</Button></PopoverTrigger>
          <PopoverContent className="w-80 space-y-3">
            <p className="text-sm font-medium">미리보기 실행 설정</p>
            <p className="text-xs text-muted-foreground">보통 자동으로 설정됩니다. 모르는 경우 AI에게 “미리보기를 실행하려면 어떻게 해야 해?”라고 물어보세요.</p>
            <label className="grid gap-1.5 text-xs">시작 명령<Input aria-label="미리보기 시작 명령" value={pv.command} onChange={(e) => pv.setCommand(e.target.value)} placeholder="예: npm run dev" disabled={pv.running || pv.starting} /></label>
            <label className="grid gap-1.5 text-xs">직접 열 주소<Input aria-label="미리보기 주소" value={pv.manualUrl || pv.url || ""} onChange={(e) => pv.setManualUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void openManual()} placeholder="http://localhost:5173" /></label>
            <Button size="sm" variant="outline" onClick={openManual}>이 주소 열기</Button>
          </PopoverContent>
        </Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-sm" variant="ghost" onClick={() => ipc.preview.reload().catch(() => {})} aria-label="새로고침" disabled={!pv.webviewOpen}>
              <RefreshCw className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>새로고침</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-sm" variant="ghost" onClick={() => pv.url && openUrl(pv.url).catch(() => {})} aria-label="브라우저에서 열기" disabled={!pv.url}>
              <ExternalLink className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>브라우저에서 열기</TooltipContent>
        </Tooltip>
        <Select value={pv.device} onValueChange={(v) => pv.setDevice(v as DevicePreset)}>
          <SelectTrigger size="sm" className="h-7 w-28 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(DEVICE_SIZES) as DevicePreset[]).map((k) => (
              <SelectItem key={k} value={k}>
                {DEVICE_SIZES[k].label}
                {DEVICE_SIZES[k].width ? ` ${DEVICE_SIZES[k].width}×${DEVICE_SIZES[k].height}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant={pv.picking ? "default" : "outline"} onClick={() => pv.togglePicking().catch(() => {})} disabled={!pv.webviewOpen}>
              <MousePointerClick className="size-3.5" /> 화면 선택
            </Button>
          </TooltipTrigger>
          <TooltipContent>미리보기에서 요소를 클릭하면 그 정보가 입력창에 들어갑니다 (Esc로 취소)</TooltipContent>
        </Tooltip>
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost" className={cn(errors.length && "text-destructive")}>
              <AlertCircle className="size-3.5" /> 문제 확인
              {pv.console.length > 0 && (
                <Badge variant={errors.length ? "destructive" : "secondary"} className="ml-1 px-1.5 py-0 text-[10px]">
                  {pv.console.length}
                </Badge>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[28rem] p-2">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-medium">미리보기에서 발견한 문제</span>
              <div className="flex gap-1">
                <Button size="sm" variant="outline" onClick={forwardConsole} disabled={!pv.console.length}>
                  AI에게 수정 요청
                </Button>
                <Button size="sm" variant="ghost" onClick={pv.clearConsole}>
                  지우기
                </Button>
              </div>
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">
              {pv.console.length ? pv.console.slice(-50).map((c) => `[${c.level}] ${c.message}`).join("\n") : "기록된 오류가 없습니다."}
            </pre>
          </PopoverContent>
        </Popover>
        <Button size="icon-sm" variant="ghost" onClick={() => setShowLogs((v) => !v)} aria-label="실행 기록">
          <TerminalSquare className="size-4" />
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={() => { setPreviewOpen(false); }} aria-label="미리보기 닫기">
          <X className="size-4" />
        </Button>
      </div>

      {/* The native child webview is positioned over this host element. */}
      <div ref={hostRef} className="relative min-h-0 flex-1 bg-muted/30">
        {!pv.webviewOpen && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
            <MonitorPlayPlaceholder />
            <p className="text-xs">만든 화면에서 바꾸고 싶은 부분을 선택해 AI에게 수정을 요청할 수 있어요.</p>
          </div>
        )}
        {pv.webviewOpen && hiddenByOverlay && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">대화상자가 열려 있는 동안 미리보기를 숨깁니다</div>
        )}
        {pv.picking && <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-primary/90 py-0.5 text-center text-[11px] text-primary-foreground">요소를 클릭하세요 · Esc 취소</div>}
      </div>

      {(showLogs || (!pv.running && pv.logs.length > 0 && !pv.webviewOpen)) && (
        <pre className="max-h-40 shrink-0 overflow-auto border-t bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
          {pv.logs.length ? pv.logs.slice(-200).join("\n") : "로그 없음"}
        </pre>
      )}
    </div>
  );
}

function MonitorPlayPlaceholder() {
  return <><Play className="mb-2 size-8 text-primary" /><p className="text-base font-medium text-foreground">만든 결과를 여기서 확인하세요</p><p>위의 ‘미리보기 시작’을 누르면 화면이 열립니다.</p><p className="text-xs">웹 화면이 있는 프로젝트에서 사용할 수 있어요. 버튼이 비활성화되어 있다면 실행 설정을 확인해 주세요.</p></>;
}
