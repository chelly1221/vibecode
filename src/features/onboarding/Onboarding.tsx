import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Rocket } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ipc, type AppSettings, type ToolStatus } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";
import { EFFORT_OPTIONS, PERMISSION_OPTIONS, providerLabel } from "@/features/settings/options";
import { AuthCards } from "./AuthCards";
import { SshKeySection } from "@/features/settings/SshKeySection";
import { DefaultsForm } from "./DefaultsForm";
import { ToolsTable, toolFound } from "./ToolsTable";

const STEPS = [
  { id: "tools", title: "도구 확인", desc: "claude / codex / git 설치 상태" },
  { id: "auth", title: "로그인", desc: "Claude 필수, Codex 선택" },
  { id: "defaults", title: "기본값", desc: "모델 · effort · 권한 · 폴더" },
  { id: "done", title: "완료", desc: "설정 요약" },
] as const;

/** First-run wizard. Shown while `settings.onboarding_done === false`. Everything runs on Windows. */
export function Onboarding() {
  const settings = useAppStore((s) => s.settings)!;
  const saveSettings = useAppStore((s) => s.saveSettings);

  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<AppSettings>(settings);
  const patch = useCallback((p: Partial<AppSettings>) => setDraft((d) => ({ ...d, ...p })), []);

  // --- step 1: tools on this PC ---
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [toolsLoading, setToolsLoading] = useState(false);
  const detect = useCallback(async () => {
    setToolsLoading(true);
    try {
      setTools(await ipc.tools.detect());
    } catch (e) {
      toast.error(`도구 감지 실패: ${String(e)}`);
      setTools([]);
    } finally {
      setToolsLoading(false);
    }
  }, []);

  useEffect(() => {
    detect().catch(() => {});
  }, [detect]);

  const [saving, setSaving] = useState(false);
  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
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
                    Vibecoder는 Windows에 설치된 Claude Code · Codex · git을 직접 실행합니다. 없는 도구는 "설치"를 누르면 앱이 바로 설치합니다(관리자 권한 창이 뜨면 허용).
                  </p>
                  <ToolsTable tools={tools} loading={toolsLoading} onRefresh={detect} />
                  {claudeMissing && (
                    <Alert variant="destructive">
                      <AlertTitle>Claude Code가 없습니다</AlertTitle>
                      <AlertDescription>
                        "설치"를 눌러 설치하세요. 설치가 끝나면 다음 단계에서 로그인합니다.
                      </AlertDescription>
                    </Alert>
                  )}
                  {gitMissing && (
                    <Alert>
                      <AlertTitle>git이 없습니다</AlertTitle>
                      <AlertDescription>Git for Windows를 설치하세요. git 패널, 체크포인트, GitHub 연동에 필요합니다 (Claude Code 자체는 없어도 동작합니다).</AlertDescription>
                    </Alert>
                  )}
                </>
              )}

              {step === 1 && (
                <>
                  <p className="text-sm text-muted-foreground">
                    "로그인"을 누르면 브라우저가 열립니다. 로그인 후 화면에 표시되는 인증 코드를 붙여넣으면 끝납니다.
                  </p>
                  <AuthCards />
                  <div className="rounded-xl border p-4">
                    <SshKeySection />
                  </div>
                </>
              )}

              {step === 2 && <DefaultsForm draft={draft} onChange={patch} />}

              {step === 3 && (
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
              <Button onClick={next} disabled={saving}>
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

    </div>
  );
}
