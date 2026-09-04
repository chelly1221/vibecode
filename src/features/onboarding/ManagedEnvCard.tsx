// "Vibecoder 전용 환경": the app-owned WSL distribution. Handles the three states
// (WSL missing → install + reboot, WSL present → provision, ready → marks) and streams provisioning progress.
import { useCallback, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Cpu, Download, Loader2, Package, RefreshCw, RotateCcw, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ipc, type ProvisionEvent, type ToolStatus, type WslStatus } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { toolFound } from "./recommend";

export const MANAGED_DISTRO = "Vibecoder";

interface Props {
  status: WslStatus | null;
  tools: ToolStatus[] | null;
  claudeLoggedIn: boolean | null;
  selected?: boolean;
  recommended?: boolean;
  /** Called after WSL install / provisioning / removal so the parent can refresh status + tools. */
  onChanged: () => void | Promise<void>;
  onSelect?: () => void;
  /** Compact layout for the settings dialog. */
  compact?: boolean;
  /** Show the remove button (settings only). */
  allowRemove?: boolean;
}

type ProvState = { phase: "idle" | "running" | "done" | "failed"; steps: string[]; bytes: number; total: number | null; log: string[]; error?: string };

function fmtBytes(n: number) {
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n > 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

const MIN_BUILD = 19041;

/** CPU virtualization is off in the firmware: the program cannot flip it, so guide the user. */
function VirtualizationGuide({ vendor }: { vendor: string | null }) {
  const intel = !vendor || /intel/i.test(vendor);
  const setting = intel ? "Intel Virtualization Technology (VT-x / Intel VT)" : "SVM Mode (AMD-V)";
  return (
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-start gap-2 text-amber-600">
        <Cpu className="mt-0.5 size-3.5 shrink-0" />
        <span>
          CPU 가상화가 BIOS/UEFI에서 꺼져 있습니다. 이 설정은 프로그램이 대신 켤 수 없어 직접 바꿔야 합니다.
          {vendor ? ` (CPU: ${vendor})` : ""}
        </span>
      </div>
      <ol className="list-decimal space-y-0.5 pl-5 text-muted-foreground">
        <li>아래 "펌웨어 설정으로 재부팅"을 누르면 고급 시작 옵션으로 재부팅됩니다.</li>
        <li>문제 해결 → 고급 옵션 → UEFI 펌웨어 설정 → 다시 시작.</li>
        <li>
          BIOS에서 <span className="font-medium text-foreground">{setting}</span>을 Enabled로 바꾸고 저장(F10)합니다. 보통 Advanced / CPU Configuration 메뉴에 있습니다.
        </li>
        <li>Windows로 돌아오면 Vibecoder를 다시 실행하세요. 나머지는 프로그램이 이어서 진행합니다.</li>
      </ol>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          if (window.confirm("고급 시작 옵션으로 재부팅할까요? 저장하지 않은 작업이 있으면 먼저 저장하세요.")) ipc.env.rebootToFirmware().catch((err) => toast.error(String(err)));
        }}
      >
        <RotateCcw className="size-4" /> 펌웨어 설정으로 재부팅
      </Button>
    </div>
  );
}

export function ManagedEnvCard({ status, tools, claudeLoggedIn, selected, recommended, onChanged, onSelect, compact, allowRemove }: Props) {
  const [prov, setProv] = useState<ProvState>({ phase: "idle", steps: [], bytes: 0, total: null, log: [] });
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState<"idle" | "done" | "failed">("idle");
  const [installMsg, setInstallMsg] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const provision = useCallback(async () => {
    setProv({ phase: "running", steps: [], bytes: 0, total: null, log: [] });
    setShowLog(true);
    try {
      await ipc.env.provision((e: ProvisionEvent) => {
        setProv((p) => {
          if (e.type === "step") return { ...p, steps: [...p.steps, e.name], bytes: 0, total: null };
          if (e.type === "progress") return { ...p, bytes: e.bytes, total: e.total ?? null };
          if (e.type === "log") return { ...p, log: [...p.log.slice(-400), (e.is_err ? "! " : "") + e.line] };
          if (e.type === "done") return { ...p, phase: "done" };
          if (e.type === "failed") return { ...p, phase: "failed", error: e.message };
          return p;
        });
        requestAnimationFrame(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }));
      });
      toast.success("Vibecoder 전용 환경이 준비되었습니다");
    } catch (e) {
      setProv((p) => ({ ...p, phase: "failed", error: String(e) }));
      toast.error(`환경 준비 실패: ${String(e)}`);
    } finally {
      await onChanged();
    }
  }, [onChanged]);

  const installWsl = useCallback(async () => {
    setInstalling(true);
    setInstallMsg(null);
    try {
      const code = await ipc.env.installWsl();
      if (code === 0) {
        setInstalled("done");
        setInstallMsg("WSL 설치가 끝났습니다. 재부팅한 뒤 Vibecoder를 다시 실행하면 환경 준비를 이어서 진행합니다.");
      } else {
        setInstalled("failed");
        setInstallMsg(`wsl --install 이 코드 ${code}로 끝났습니다. 관리자 PowerShell에서 직접 실행해 보세요: wsl --install --no-distribution`);
      }
    } catch (e) {
      setInstalled("failed");
      setInstallMsg(`설치를 시작하지 못했습니다: ${String(e)}`);
    } finally {
      setInstalling(false);
      await onChanged();
    }
  }, [onChanged]);

  const remove = useCallback(async () => {
    if (!window.confirm(`전용 환경(${MANAGED_DISTRO})을 삭제할까요? 그 안의 로그인 정보와 설치된 도구가 모두 지워집니다.`)) return;
    try {
      await ipc.env.removeManaged();
      toast.success("전용 환경을 삭제했습니다");
    } catch (e) {
      toast.error(`삭제 실패: ${String(e)}`);
    } finally {
      await onChanged();
    }
  }, [onChanged]);

  const state = status?.state ?? null;
  const buildTooOld = !!status && status.windows_build > 0 && status.windows_build < MIN_BUILD;
  const virtOff = !!status && status.virtualization_enabled === false && !status.hypervisor_present;
  const ready = !!status?.managed_ready;
  const present = !!status?.managed_present;
  const running = prov.phase === "running";
  const pct = prov.total ? Math.min(100, Math.round((prov.bytes / prov.total) * 100)) : null;

  const marks = ["claude", "codex", "git", "node"].map((n) => {
    const found = toolFound(tools, n);
    return (
      <span key={n} className="inline-flex items-center gap-1 text-muted-foreground">
        {tools === null ? <span className="size-3.5 animate-pulse rounded-full bg-muted" /> : found ? <CheckCircle2 className="size-3.5 text-emerald-600" /> : <XCircle className="size-3.5" />}
        <span className="font-mono">{n}</span>
        {n === "claude" && found && claudeLoggedIn !== null && (
          <Badge variant={claudeLoggedIn ? "default" : "outline"} className="ml-0.5 px-1.5 py-0 text-[10px]">
            {claudeLoggedIn ? "로그인됨" : "로그인 필요"}
          </Badge>
        )}
      </span>
    );
  });

  const body = (
    <>
      <div className="flex items-center gap-2">
        <Package className="size-5" />
        <span className="font-medium">Vibecoder 전용 환경</span>
        {recommended && <Badge className="ml-auto">권장</Badge>}
        {ready && !recommended && <Badge variant="outline" className="ml-auto">준비됨</Badge>}
      </div>
      {!compact && (
        <p className="text-sm text-muted-foreground">
          앱이 리눅스(WSL) 환경을 직접 만들어 관리합니다. PC에 설치된 도구와 무관하게 claude · codex · git · node를 갖춘 독립 환경에서 실행됩니다.
        </p>
      )}

      {status === null && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> WSL 상태 확인 중…
        </div>
      )}

      {state === "not_found" && (
        <div className="flex items-start gap-2 text-xs text-amber-600">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>이 Windows에서는 WSL을 찾을 수 없습니다. Windows 10 2004 이상 또는 Windows 11이 필요합니다.</span>
        </div>
      )}

      {state === "not_installed" && (
        <div className="space-y-2 text-xs">
          <div className="flex items-start gap-2 text-amber-600">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              WSL(Windows Subsystem for Linux)이 설치되어 있지 않습니다. "WSL 설치"를 누르면 프로그램이 관리자 권한으로 필요한 Windows 기능(가상 머신 플랫폼, WSL)을 켜고 WSL을 설치합니다. 끝나면 재부팅 1회가 필요합니다.
            </span>
          </div>
          {buildTooOld && (
            <div className="flex items-start gap-2 text-destructive">
              <XCircle className="mt-0.5 size-3.5 shrink-0" />
              <span>Windows 빌드 {status?.windows_build}는 WSL2를 지원하지 않습니다. Windows 10 2004(빌드 19041) 이상으로 업데이트한 뒤 다시 실행하세요.</span>
            </div>
          )}
          {virtOff && <VirtualizationGuide vendor={status?.cpu_vendor ?? null} />}
          {installed !== "done" && !buildTooOld && (
            <Button size="sm" onClick={(e) => { e.stopPropagation(); installWsl(); }} disabled={installing}>
              {installing ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} WSL 설치 (Windows 기능 자동 활성화 · 관리자 권한)
            </Button>
          )}
          {installMsg && (
            <div className={cn("rounded-md border p-2", installed === "failed" ? "border-destructive/40 text-destructive" : "text-muted-foreground")}>
              {installMsg}
              {installed === "done" && (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); if (window.confirm("지금 재부팅할까요? 저장하지 않은 작업이 있으면 먼저 저장하세요.")) ipc.env.reboot().catch((err) => toast.error(String(err))); }}>
                    <RotateCcw className="size-4" /> 지금 재부팅
                  </Button>
                  <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onChanged(); }}>
                    <RefreshCw className="size-4" /> 다시 확인
                  </Button>
                </div>
              )}
            </div>
          )}
          {status?.detail && installed === "idle" && <pre className="max-h-20 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px] text-muted-foreground">{status.detail}</pre>}
        </div>
      )}

      {state === "installed" && (
        <div className="space-y-2 text-xs">
          {virtOff && <VirtualizationGuide vendor={status?.cpu_vendor ?? null} />}
          <div className="flex items-center gap-2 text-muted-foreground">
            <CheckCircle2 className="size-3.5 text-emerald-600" /> WSL {status?.version ?? ""} 사용 가능
            {present && <span>· 배포판 {MANAGED_DISTRO} {ready ? "준비됨" : "있음 (도구 미설치)"}</span>}
            {!present && <span>· 배포판 없음</span>}
          </div>
          {ready && <div className="flex flex-wrap gap-2">{marks}</div>}
          {!running && (
            <div className="flex flex-wrap gap-2">
              {!ready && (
                <Button size="sm" onClick={(e) => { e.stopPropagation(); provision(); }}>
                  <Download className="size-4" /> {present ? "도구 다시 설치" : "환경 준비 (다운로드 약 30MB + 도구 설치)"}
                </Button>
              )}
              {ready && (
                <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); provision(); }}>
                  <RefreshCw className="size-4" /> 도구 업데이트
                </Button>
              )}
              {allowRemove && present && (
                <Button size="sm" variant="ghost" className="text-destructive" onClick={(e) => { e.stopPropagation(); remove(); }}>
                  <Trash2 className="size-4" /> 환경 삭제
                </Button>
              )}
            </div>
          )}
          {prov.phase !== "idle" && (
            <div className="space-y-1.5 rounded-md border p-2" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2">
                {running ? <Loader2 className="size-3.5 animate-spin" /> : prov.phase === "done" ? <CheckCircle2 className="size-3.5 text-emerald-600" /> : <XCircle className="size-3.5 text-destructive" />}
                <span className="font-medium">{prov.steps[prov.steps.length - 1] ?? "시작 중…"}</span>
                <span className="ml-auto text-muted-foreground">{prov.steps.length}단계</span>
              </div>
              {running && prov.total !== null && (
                <div className="space-y-1">
                  <Progress value={pct ?? 0} />
                  <div className="text-[11px] text-muted-foreground">{fmtBytes(prov.bytes)} / {fmtBytes(prov.total)} ({pct}%)</div>
                </div>
              )}
              {prov.phase === "failed" && <div className="text-destructive">{prov.error}</div>}
              <button type="button" className="text-[11px] text-muted-foreground underline" onClick={() => setShowLog((v) => !v)}>
                {showLog ? "로그 숨기기" : "로그 보기"}
              </button>
              {showLog && (
                <pre ref={logRef} className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px] text-muted-foreground">
                  {prov.log.join("\n") || "…"}
                </pre>
              )}
              {prov.phase === "failed" && (
                <Button size="sm" variant="outline" onClick={provision}>
                  <RefreshCw className="size-4" /> 다시 시도
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );

  if (compact) return <div className="flex flex-col gap-3 rounded-xl border p-4">{body}</div>;

  const selectable = state === "installed";
  // A div with role=button (not <button>) so the action buttons inside stay clickable.
  return (
    <div
      role="button"
      tabIndex={selectable ? 0 : -1}
      aria-disabled={!selectable}
      aria-pressed={selected}
      onClick={() => selectable && onSelect?.()}
      onKeyDown={(e) => {
        if (selectable && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          onSelect?.();
        }
      }}
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-4 text-left transition-colors",
        !selectable && "cursor-not-allowed opacity-70",
        selected ? "border-primary bg-primary/5 ring-2 ring-primary/30" : selectable && "cursor-pointer hover:bg-accent/40",
      )}
    >
      {body}
    </div>
  );
}
