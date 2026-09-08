import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, LogIn, RefreshCw, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ipc, type AuthStatus, type Provider } from "@/lib/ipc";
import { LoginPanel } from "./LoginPanel";
import { PROVIDER_OPTIONS } from "@/features/settings/options";

type State = { status: AuthStatus | null; error: string | null; loading: boolean };

export function useAuthStatuses() {
  const [state, setState] = useState<Record<Provider, State>>({
    claude: { status: null, error: null, loading: false },
    codex: { status: null, error: null, loading: false },
  });

  const refresh = useCallback(async (provider?: Provider) => {
    const targets: Provider[] = provider ? [provider] : ["claude", "codex"];
    setState((s) => {
      const n = { ...s };
      for (const p of targets) n[p] = { ...n[p], loading: true };
      return n;
    });
    await Promise.all(
      targets.map(async (p) => {
        try {
          const status = await ipc.tools.authStatus(p);
          setState((s) => ({ ...s, [p]: { status, error: null, loading: false } }));
        } catch (e) {
          setState((s) => ({ ...s, [p]: { status: null, error: String(e), loading: false } }));
        }
      }),
    );
  }, []);

  return { state, refresh };
}

interface Props {
  autoLoad?: boolean;
}

/** Login status cards for Claude and Codex; "로그인" runs the GUI login flow inline (no terminal). */
export function AuthCards({ autoLoad = true }: Props) {
  const { state, refresh } = useAuthStatuses();
  const [active, setActive] = useState<Provider | null>(null);
  useEffect(() => {
    if (autoLoad) refresh().catch(() => {});
  }, [autoLoad, refresh]);

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {PROVIDER_OPTIONS.map((p) => {
        const s = state[p.value];
        const loggedIn = s.status?.logged_in === true;
        return (
          <Card key={p.value} size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {p.label}
                {p.value === "claude" ? <Badge>필수</Badge> : <Badge variant="outline">선택</Badge>}
              </CardTitle>
              <CardDescription>{p.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                {s.loading ? (
                  <RefreshCw className="size-4 animate-spin text-muted-foreground" />
                ) : loggedIn ? (
                  <CheckCircle2 className="size-4 text-emerald-600" />
                ) : (
                  <XCircle className="size-4 text-muted-foreground" />
                )}
                <span>
                  {s.loading
                    ? "확인 중..."
                    : loggedIn
                      ? `로그인됨${s.status?.account ? ` · ${s.status.account}` : ""}${s.status?.method ? ` (${s.status.method})` : ""}`
                      : s.error
                        ? "확인 실패"
                        : "로그인 필요"}
                </span>
              </div>
              {s.error && !s.loading && (
                <p className="break-all text-xs text-muted-foreground" title={s.error}>
                  {s.error.length > 160 ? `${s.error.slice(0, 160)}…` : s.error}
                </p>
              )}
              {s.status?.detail && !s.error && <p className="text-xs text-muted-foreground">{s.status.detail}</p>}
              {active === p.value ? (
                <LoginPanel
                  provider={p.value}
                  onFinished={(ok) => {
                    refresh(p.value).catch(() => {});
                    if (ok) setTimeout(() => setActive((a) => (a === p.value ? null : a)), 1500);
                  }}
                  onClose={() => setActive(null)}
                />
              ) : (
                <div className="flex gap-2">
                  <Button size="sm" variant={loggedIn ? "outline" : "default"} onClick={() => setActive(p.value)} disabled={active !== null}>
                    <LogIn className="size-3.5" /> {loggedIn ? "다시 로그인" : "로그인"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => refresh(p.value)} disabled={s.loading}>
                    <RefreshCw className="size-3.5" /> 다시 확인
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
