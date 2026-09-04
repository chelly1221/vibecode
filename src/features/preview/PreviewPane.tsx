// UI preview ("디자인 모드"): runs the project's dev server, shows it in a Tauri child webview that
// is positioned over this pane, and lets the user pick elements / forward console errors to the agent.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertCircle, ExternalLink, MousePointerClick, Play, RefreshCw, Square, TerminalSquare, X } from "lucide-react";
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
const loadStacks = () => (stacksCache ??= ipc.projects.stacksList().catch(() => []));

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

  // Prefill the dev command from the project's stack.
  useEffect(() => {
    if (!project) return;
    pv.syncStatus(project.id);
    if (!pv.command && project.stack_id) {
      loadStacks().then((stacks) => {
        const st = stacks.find((s) => s.id === project.stack_id);
        if (st?.dev_command && !usePreviewStore.getState().command) pv.setCommand(st.dev_command);
      });
    }
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
    const check = () => {
      const covered = !!document.querySelector(OVERLAY_SELECTOR);
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
    if (pv.url && pv.running && autoOpened.current !== pv.url) {
      autoOpened.current = pv.url;
      const b = computeBounds();
      if (b) pv.openUrl(pv.url, b).catch((e) => toast.error(`미리보기 열기 실패: ${String(e)}`));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pv.url, pv.running]);

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
      toast.error(`dev 서버 시작 실패: ${String(e)}`);
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
        <Input
          value={pv.command}
          onChange={(e) => pv.setCommand(e.target.value)}
          placeholder="dev 서버 명령 (예: npm run dev)"
          className="h-7 w-48 text-xs"
          disabled={pv.running}
        />
        {pv.running ? (
          <Button size="sm" variant="outline" onClick={() => pv.stop().catch((e) => toast.error(String(e)))}>
            <Square className="size-3.5" /> 중지
          </Button>
        ) : (
          <Button size="sm" onClick={start} disabled={!project}>
            <Play className="size-3.5" /> 시작
          </Button>
        )}
        <Input
          value={pv.manualUrl || pv.url || ""}
          onChange={(e) => pv.setManualUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && openManual()}
          placeholder="http://localhost:5173"
          className="h-7 min-w-40 flex-1 font-mono text-xs"
        />
        <Button size="sm" variant="outline" onClick={openManual}>
          열기
        </Button>
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
              <MousePointerClick className="size-3.5" /> 요소 선택
            </Button>
          </TooltipTrigger>
          <TooltipContent>미리보기에서 요소를 클릭하면 그 정보가 입력창에 들어갑니다 (Esc로 취소)</TooltipContent>
        </Tooltip>
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost" className={cn(errors.length && "text-destructive")}>
              <AlertCircle className="size-3.5" /> 콘솔
              {pv.console.length > 0 && (
                <Badge variant={errors.length ? "destructive" : "secondary"} className="ml-1 px-1.5 py-0 text-[10px]">
                  {pv.console.length}
                </Badge>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[28rem] p-2">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-medium">미리보기 콘솔 (error / warn)</span>
              <div className="flex gap-1">
                <Button size="sm" variant="outline" onClick={forwardConsole} disabled={!pv.console.length}>
                  에이전트에게 전달
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
        <Button size="icon-sm" variant="ghost" onClick={() => setShowLogs((v) => !v)} aria-label="로그">
          <TerminalSquare className="size-4" />
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={() => { pv.closeWebview(); setPreviewOpen(false); }} aria-label="미리보기 닫기">
          <X className="size-4" />
        </Button>
      </div>

      {/* The native child webview is positioned over this host element. */}
      <div ref={hostRef} className="relative min-h-0 flex-1 bg-muted/30">
        {!pv.webviewOpen && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
            <p>dev 서버를 시작하면 여기에 실시간 화면이 표시됩니다.</p>
            <p className="text-xs">URL이 감지되면 자동으로 열리고, "요소 선택"으로 화면의 요소를 클릭해 에이전트에게 바로 지시할 수 있습니다.</p>
          </div>
        )}
        {pv.webviewOpen && hiddenByOverlay && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">대화상자가 열려 있는 동안 미리보기를 숨깁니다</div>
        )}
        {pv.picking && <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-primary/90 py-0.5 text-center text-[11px] text-primary-foreground">요소를 클릭하세요 · Esc 취소</div>}
      </div>

      {showLogs && (
        <pre className="max-h-40 shrink-0 overflow-auto border-t bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
          {pv.logs.length ? pv.logs.slice(-200).join("\n") : "로그 없음"}
        </pre>
      )}
    </div>
  );
}
