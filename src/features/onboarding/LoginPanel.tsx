// GUI login for one provider: starts the CLI login in a hidden PTY, shows the sign-in URL, takes the
// pasted authorization code, and reports the result. No terminal involved.
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ClipboardPaste, ExternalLink, Loader2, X, XCircle } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ipc, type Provider } from "@/lib/ipc";
import { codeLooksValid, initialLogin, loginHint, reduceLogin, type LoginState } from "./loginFlow";

interface Props {
  provider: Provider;
  accountId: string;
  /** Called when the CLI exited (logged in or not) so the caller can refresh the status. */
  onFinished: (loggedIn: boolean) => void;
  onClose: () => void;
}

export function LoginPanel({ provider, accountId, onFinished, onClose }: Props) {
  const [state, setState] = useState<LoginState>(initialLogin);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const finishedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    finishedRef.current = false;
    let id: string | null = null;
    (async () => {
      try {
        // StrictMode replays mount effects. Start only after its synchronous cleanup,
        // so one click cannot launch two competing native login processes.
        await Promise.resolve();
        if (cancelled) return;
        id = await ipc.tools.loginStart(provider, (e) => {
          if (cancelled) return;
          setState((s) => reduceLogin(s, e));
          if (e.type === "finished" && !finishedRef.current) {
            finishedRef.current = true;
            onFinished(e.logged_in);
          }
        }, accountId);
        if (cancelled) {
          await ipc.tools.loginCancel(id).catch(() => {});
          return;
        }
        setState((s) => ({ ...s, loginId: id }));
      } catch (e) {
        if (cancelled) return;
        toast.error("로그인을 시작하지 못했습니다", { description: String(e) });
        onClose();
      }
    })();
    return () => {
      cancelled = true;
      // Leaving the panel mid-flow aborts the CLI.
      if (id && !finishedRef.current) ipc.tools.loginCancel(id).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, accountId]);

  const submit = useCallback(async () => {
    const id = stateRef.current.loginId;
    if (!id || !codeLooksValid(code)) return;
    setSending(true);
    try {
      await ipc.tools.loginCode(id, code.trim());
      setCode("");
    } catch (e) {
      toast.error("코드를 전달하지 못했습니다", { description: String(e) });
    } finally {
      setSending(false);
    }
  }, [code]);

  const busy = state.phase === "starting" || state.phase === "browser" || state.phase === "code";
  const ok = state.phase === "finished" && state.result?.loggedIn;

  return (
    <div className="grid gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm" data-testid={`login-panel-${provider}`}>
      <div className="flex items-start gap-2">
        {busy ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" /> : ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />}
        <p className="min-w-0 flex-1">{loginHint(state) || "시작하는 중…"}</p>
        <Button size="icon-xs" variant="ghost" aria-label="닫기" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>
      {state.url && busy && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => openUrl(state.url!).catch((e) => toast.error(`브라우저를 열지 못했습니다: ${String(e)}`))}>
            <ExternalLink className="size-3.5" /> 브라우저에서 로그인 페이지 열기
          </Button>
          <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(state.url!).then(() => toast.success("URL을 복사했습니다")).catch(() => {})}>
            URL 복사
          </Button>
        </div>
      )}
      {state.phase === "code" && (
        <div className="flex gap-2">
          <Input
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            placeholder="브라우저에 표시된 인증 코드"
            className="font-mono"
            aria-label="인증 코드"
          />
          <Button size="sm" onClick={() => void submit()} disabled={!codeLooksValid(code) || sending}>
            <ClipboardPaste className="size-3.5" /> 확인
          </Button>
        </div>
      )}
      {state.lines.length > 0 && busy && (
        <p className="truncate font-mono text-[11px] text-muted-foreground" title={state.lines.join("\n")}>
          {state.lines[state.lines.length - 1]}
        </p>
      )}
      {state.phase === "finished" && !ok && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">CLI 출력 보기</summary>
          <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px]">{state.lines.join("\n") || "(출력 없음)"}</pre>
        </details>
      )}
    </div>
  );
}
