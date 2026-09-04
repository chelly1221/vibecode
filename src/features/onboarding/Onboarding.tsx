import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Rocket, TerminalSquare } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ipc, type AppSettings, type BackendConfig, type ToolStatus } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";
import { TerminalPanel } from "@/features/terminal/TerminalPanel";
import { EFFORT_OPTIONS, PERMISSION_OPTIONS, providerLabel } from "@/features/settings/options";
import { AuthCards } from "./AuthCards";
import { BackendPicker } from "./BackendPicker";
import { DefaultsForm } from "./DefaultsForm";
import { pickBestDistro, recommendEnv, toolFound, type Candidate, type EnvChoice } from "./recommend";
import { isManagedBackend, MANAGED_BACKEND, MANAGED_DISTRO, useManagedEnv } from "./useManagedEnv";
import { ToolsTable } from "./ToolsTable";

const STEPS = [
  { id: "backend", title: "실행 환경", desc: "에이전트와 git이 실행될 위치" },
  { id: "tools", title: "도구 확인", desc: "claude / codex / git 설치 상태" },
  { id: "auth", title: "로그인", desc: "Claude 필수, Codex 선택" },
  { id: "defaults", title: "기본값", desc: "모델 · effort · 권한 · 폴더" },
  { id: "done", title: "완료", desc: "설정 요약" },
] as const;

/** First-run wizard. Shown while `settings.onboarding_done === false`. */
export function Onboarding() {
  const settings = useAppStore((s) => s.settings)!;
  const saveSettings = useAppStore((s) => s.saveSettings);
  const terminalOpen = useAppStore((s) => s.terminalOpen);
  const setTerminalOpen = useAppStore((s) => s.setTerminalOpen);

  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<AppSettings>(settings);
  const patch = useCallback((p: Partial<AppSettings>) => setDraft((d) => ({ ...d, ...p })), []);

  // --- step 1: backend detection previews (every WSL distro + native, then Claude login) ---
  const [distros, setDistros] = useState<string[]>([]);
  const [nativeTools, setNativeTools] = useState<ToolStatus[] | null>(null);
  const [wslToolsByDistro, setWslToolsByDistro] = useState<Record<string, ToolStatus[] | null>>({});
  const [loginByKey, setLoginByKey] = useState<Record<string, boolean | null>>({});
  const [detecting, setDetecting] = useState(false);
  const [recommended, setRecommended] = useState<EnvChoice | null>(null);
  const [recommendedDistro, setRecommendedDistro] = useState<string | null>(null);
  const [userPicked, setUserPicked] = useState(false);
  const managedEnv = useManagedEnv(false);

  const keyOf = (b: BackendConfig) => (b.kind === "wsl" ? `wsl:${b.wsl_distro ?? ""}` : "native");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setDetecting(true);
      const [allDistros, managedStatus] = await Promise.all([ipc.tools.listWslDistros().catch(() => [] as string[]), managedEnv.refresh()]);
      if (cancelled) return;
      const list = allDistros.filter((d) => d !== MANAGED_DISTRO);
      setDistros(list);
      const nativeP = ipc.tools.detect({ kind: "native", wsl_distro: null }).catch(() => [] as ToolStatus[]);
      const wslPs = list.map((d) =>
        ipc.tools
          .detect({ kind: "wsl", wsl_distro: d })
          .then((t) => [d, t] as const)
          .catch(() => [d, null] as const),
      );
      const [n, ...ws] = await Promise.all([nativeP, ...wslPs]);
      if (cancelled) return;
      const byDistro: Record<string, ToolStatus[] | null> = {};
      for (const [d, t] of ws) byDistro[d] = t;
      setNativeTools(n);
      setWslToolsByDistro(byDistro);
      const bestDistro = pickBestDistro(byDistro, list);
      setRecommendedDistro(bestDistro);

      // Login check only where claude is installed.
      const nativeB: BackendConfig = { kind: "native", wsl_distro: null };
      const wslB: BackendConfig | null = bestDistro ? { kind: "wsl", wsl_distro: bestDistro } : null;
      const check = async (b: BackendConfig, tools: ToolStatus[] | null) =>
        toolFound(tools, "claude") ? ipc.tools.authStatus("claude", b).then((a) => a.logged_in).catch(() => null) : null;
      const [nLogin, wLogin] = await Promise.all([check(nativeB, n), wslB ? check(wslB, byDistro[bestDistro!] ?? null) : null]);
      if (cancelled) return;
      const logins: Record<string, boolean | null> = { native: nLogin };
      if (wslB) logins[keyOf(wslB)] = wLogin;
      setLoginByKey(logins);

      const nativeC: Candidate = { backend: nativeB, tools: n, claudeLoggedIn: nLogin };
      const wslC: Candidate | null = wslB ? { backend: wslB, tools: byDistro[bestDistro!] ?? null, claudeLoggedIn: wLogin } : null;
      let managedC: Candidate | null = null;
      if (managedStatus?.managed_ready) {
        const mt = await ipc.tools.detect(MANAGED_BACKEND).catch(() => [] as ToolStatus[]);
        const ml = toolFound(mt, "claude") ? await ipc.tools.authStatus("claude", MANAGED_BACKEND).then((a) => a.logged_in).catch(() => null) : null;
        managedC = { backend: MANAGED_BACKEND, tools: mt, claudeLoggedIn: ml };
      }
      if (cancelled) return;
      setRecommended(recommendEnv(nativeC, wslC, managedC));
      setDetecting(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply the recommendation once, unless the user already chose.
  useEffect(() => {
    if (recommended && !userPicked) {
      setDraft((d) => ({
        ...d,
        backend:
          recommended === "managed"
            ? MANAGED_BACKEND
            : { kind: recommended, wsl_distro: recommended === "wsl" ? (recommendedDistro ?? distros[0] ?? null) : null },
      }));
    }
  }, [recommended, recommendedDistro, userPicked, distros]);

  const managedSelected = isManagedBackend(draft.backend);

  // Distro shown on the WSL card: the chosen one, else the recommended/first one (so marks render before selection).
  const selectedDistro =
    draft.backend.kind === "wsl" && !managedSelected
      ? (draft.backend.wsl_distro ?? recommendedDistro ?? distros[0] ?? null)
      : (recommendedDistro ?? distros[0] ?? null);
  const wslTools = selectedDistro ? (wslToolsByDistro[selectedDistro] ?? null) : null;
  const nativeLoggedIn = loginByKey["native"] ?? null;
  const wslLoggedIn = selectedDistro ? (loginByKey[`wsl:${selectedDistro}`] ?? null) : null;

  const setBackend = (b: BackendConfig) => {
    setUserPicked(true);
    patch({ backend: b });
  };

  // --- step 2: tools on the chosen backend ---
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [toolsLoading, setToolsLoading] = useState(false);
  const detectChosen = useCallback(async () => {
    setToolsLoading(true);
    try {
      setTools(await ipc.tools.detect(draft.backend));
    } catch (e) {
      toast.error(`도구 감지 실패: ${String(e)}`);
      setTools([]);
    } finally {
      setToolsLoading(false);
    }
  }, [draft.backend]);

  useEffect(() => {
    if (step === 1) detectChosen().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const [saving, setSaving] = useState(false);

  const next = async () => {
    if (step === 0) {
      if (managedSelected && !managedEnv.status?.managed_ready) {
        toast.error("전용 환경 준비를 먼저 완료하세요 (환경 준비 버튼)");
        return;
      }
      // Persist backend choice so auth status / model listing use it from now on.
      setSaving(true);
      try {
        await saveSettings({ ...settings, backend: draft.backend });
      } catch (e) {
        toast.error(`설정 저장 실패: ${String(e)}`);
        setSaving(false);
        return;
      }
      setSaving(false);
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const finish = async () => {
    setSaving(true);
    try {
      await saveSettings({ ...draft, onboarding_done: true });
      toast.success("설정이 저장되었습니다. 시작합니다!");
    } catch (e) {
      toast.error(`설정 저장 실패: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const claudeMissing = tools !== null && !toolFound(tools, "claude");
  const gitMissing = tools !== null && !toolFound(tools, "git");

  const summary = useMemo(
    () => [
      ["실행 환경", managedSelected ? "Vibecoder 전용 환경" : draft.backend.kind === "wsl" ? `WSL (${draft.backend.wsl_distro ?? "기본 배포판"})` : "Windows 네이티브"],
      ["기본 에이전트", providerLabel(draft.default_provider)],
      ["기본 모델", (draft.default_provider === "claude" ? draft.default_model_claude : draft.default_model_codex) ?? "CLI 기본값"],
      ["Effort", EFFORT_OPTIONS.find((o) => o.value === draft.default_effort)?.label ?? draft.default_effort],
      ["권한", PERMISSION_OPTIONS.find((o) => o.value === draft.default_permission)?.label ?? draft.default_permission],
      ["프로젝트 폴더", draft.projects_root ?? "(미설정)"],
    ],
    [draft],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        {/* step list */}
        <aside className="w-64 shrink-0 border-r bg-sidebar p-5">
          <div className="mb-6 flex items-center gap-2">
            <Rocket className="size-5 text-primary" />
            <span className="text-lg font-semibold">Vibecoder 시작하기</span>
          </div>
          <ol className="space-y-1">
            {STEPS.map((s, i) => {
              const state = i < step ? "done" : i === step ? "current" : "todo";
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => i < step && setStep(i)}
                    disabled={i > step}
                    className={`flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left ${
                      state === "current" ? "bg-accent" : state === "done" ? "hover:bg-accent/50" : "opacity-60"
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs ${
                        state === "done"
                          ? "bg-primary text-primary-foreground"
                          : state === "current"
                            ? "border-2 border-primary text-primary"
                            : "border text-muted-foreground"
                      }`}
                    >
                      {state === "done" ? <Check className="size-3" /> : i + 1}
                    </span>
                    <span>
                      <span className="block text-sm font-medium">{s.title}</span>
                      <span className="block text-xs text-muted-foreground">{s.desc}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="mt-8">
            <Button variant="outline" size="sm" className="w-full" onClick={() => setTerminalOpen(!terminalOpen)}>
              <TerminalSquare className="size-4" /> {terminalOpen ? "터미널 숨기기" : "터미널 열기"}
            </Button>
          </div>
        </aside>

        {/* content */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto p-8">
            <div className="mx-auto max-w-3xl space-y-6">
              <header>
                <h1 className="text-2xl font-semibold">{STEPS[step].title}</h1>
                <p className="text-sm text-muted-foreground">{STEPS[step].desc}</p>
              </header>

              {step === 0 && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Vibecoder는 Windows 앱이지만, Claude Code · Codex · git은 Windows에 직접 설치된 것이나 WSL 안의 것을 쓸 수
                    있습니다. 감지 결과를 보고 선택하세요. 나중에 설정에서 바꿀 수 있습니다.
                  </p>
                  <BackendPicker
                    value={draft.backend}
                    onChange={setBackend}
                    distros={distros}
                    nativeTools={nativeTools}
                    wslTools={wslTools}
                    wslToolsByDistro={wslToolsByDistro}
                    nativeLoggedIn={nativeLoggedIn}
                    wslLoggedIn={wslLoggedIn}
                    recommended={recommended === "managed" ? null : recommended}
                    recommendedDistro={recommendedDistro}
                    loading={detecting}
                    managed={{
                      status: managedEnv.status,
                      tools: managedEnv.tools,
                      loggedIn: managedEnv.loggedIn,
                      recommended: recommended === "managed",
                      onChanged: async () => {
                        await managedEnv.refresh();
                      },
                    }}
                  />
                  {recommended === "managed" && !detecting && (
                    <Alert>
                      <AlertTitle>Vibecoder 전용 환경을 권장합니다</AlertTitle>
                      <AlertDescription>
                        {managedEnv.status?.managed_ready
                          ? "전용 환경이 준비되어 있습니다. 다음 단계에서 로그인 상태를 확인합니다."
                          : managedEnv.status?.state === "installed"
                            ? "PC에 사용할 Claude Code가 없습니다. '환경 준비'를 누르면 앱이 리눅스 환경과 도구를 자동으로 설치합니다."
                            : "먼저 WSL을 설치하고 재부팅한 뒤, 다시 실행해 '환경 준비'를 진행하세요."}
                      </AlertDescription>
                    </Alert>
                  )}
                  {recommended === "wsl" && !detecting && (
                    <Alert>
                      <AlertTitle>WSL{recommendedDistro ? ` (${recommendedDistro})` : ""}을 추천합니다</AlertTitle>
                      <AlertDescription>
                        {wslLoggedIn
                          ? "이 배포판의 Claude Code에 이미 로그인되어 있어 그대로 사용할 수 있습니다."
                          : "Claude Code가 이 배포판에 설치되어 있습니다. 다음 단계에서 로그인 상태를 확인합니다."}
                      </AlertDescription>
                    </Alert>
                  )}
                  {recommended === "native" && !detecting && nativeLoggedIn === false && (
                    <Alert>
                      <AlertTitle>Windows의 Claude Code는 로그인이 필요합니다</AlertTitle>
                      <AlertDescription>로그인 단계에서 터미널로 로그인하거나, 이미 로그인된 WSL 배포판이 있다면 WSL을 선택하세요.</AlertDescription>
                    </Alert>
                  )}
                </>
              )}

              {step === 1 && (
                <>
                  <ToolsTable tools={tools} loading={toolsLoading} backend={draft.backend.kind} onRefresh={detectChosen} />
                  {claudeMissing && (
                    <Alert variant="destructive">
                      <AlertTitle>Claude Code가 없습니다</AlertTitle>
                      <AlertDescription>
                        "터미널에서 설치"를 눌러 설치한 뒤 다시 검사하세요. 설치 후에는 다음 단계에서 로그인합니다.
                      </AlertDescription>
                    </Alert>
                  )}
                  {gitMissing && (
                    <Alert>
                      <AlertTitle>git이 없습니다</AlertTitle>
                      <AlertDescription>
                        {draft.backend.kind === "native"
                          ? "Git for Windows를 설치하세요. Claude의 Bash 도구와 git 패널 모두 필요합니다."
                          : "배포판에 git을 설치하세요 (예: sudo apt install git)."}
                      </AlertDescription>
                    </Alert>
                  )}
                </>
              )}

              {step === 2 && (
                <>
                  <p className="text-sm text-muted-foreground">
                    로그인은 각 CLI가 직접 처리합니다. "로그인"을 누르면 아래 터미널에서 진행되고, 끝나면 "다시 확인"을 누르세요.
                  </p>
                  <AuthCards onLogin={() => setTerminalOpen(true)} />
                </>
              )}

              {step === 3 && <DefaultsForm draft={draft} onChange={patch} />}

              {step === 4 && (
                <div className="rounded-xl border">
                  {summary.map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between border-b px-4 py-2.5 text-sm last:border-b-0">
                      <span className="text-muted-foreground">{k}</span>
                      <span className="font-medium">{v}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <footer className="flex shrink-0 items-center justify-between border-t px-8 py-4">
            <Button variant="ghost" onClick={back} disabled={step === 0}>
              <ArrowLeft className="size-4" /> 이전
            </Button>
            {step < STEPS.length - 1 ? (
              <Button onClick={next} disabled={saving || (step === 0 && detecting && !userPicked)}>
                다음 <ArrowRight className="size-4" />
              </Button>
            ) : (
              <Button onClick={finish} disabled={saving}>
                <Rocket className="size-4" /> 시작하기
              </Button>
            )}
          </footer>
        </main>
      </div>

      {terminalOpen && (
        <div className="h-72 shrink-0 border-t">
          <TerminalPanel />
        </div>
      )}
    </div>
  );
}
