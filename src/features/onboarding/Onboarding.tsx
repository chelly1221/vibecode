import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Rocket } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ipc, type AppSettings, type ToolStatus } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";
import { EFFORT_OPTIONS, PERMISSION_OPTIONS, providerLabel } from "@/features/settings/options";
import { AccountManager } from "@/features/accounts/AccountManager";
import { DefaultsForm } from "./DefaultsForm";
import { ToolsTable, toolFound } from "./ToolsTable";

const STEPS = [
  { id: "tools", title: "AI 준비하기", desc: "함께 쓸 AI를 고르고 설치해요" },
  { id: "auth", title: "계정 연결", desc: "사용할 AI 하나만 연결하면 돼요" },
  { id: "defaults", title: "내 작업 공간", desc: "저장 위치와 작업 방식을 정해요" },
  { id: "done", title: "준비 완료", desc: "이제 아이디어를 만들어 보세요" },
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

  const providerMissing = tools !== null && !toolFound(tools, draft.default_provider);
  const gitMissing = tools !== null && !toolFound(tools, "git");

  const summary = useMemo(
    () => [
      ["함께 작업할 AI", providerLabel(draft.default_provider)],
      ["기본 모델", (draft.default_provider === "claude" ? draft.default_model_claude : draft.default_model_codex) ?? "자동 선택"],
      ["생각하는 깊이", EFFORT_OPTIONS.find((o) => o.value === draft.default_effort)?.label ?? draft.default_effort],
      ["권한", PERMISSION_OPTIONS.find((o) => o.value === draft.default_permission)?.label ?? draft.default_permission],
      ["프로젝트 폴더", draft.projects_root ?? "프로젝트를 만들 때 선택"],
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
                    사용할 AI를 하나 골라 주세요. 아직 설치하지 않았다면 아래 설치 버튼으로 준비할 수 있어요. 다른 AI는 나중에 추가할 수 있습니다.
                  </p>
                  <div className="grid grid-cols-2 gap-3">{(["claude", "codex"] as const).map((provider) => <Button key={provider} variant={draft.default_provider === provider ? "default" : "outline"} aria-pressed={draft.default_provider === provider} onClick={() => patch({ default_provider: provider })}>{provider === "claude" ? "Claude 계정 사용" : "ChatGPT 계정으로 Codex 사용"}</Button>)}</div>
                  <ToolsTable tools={tools?.filter((t) => t.name === draft.default_provider || t.name === "git") ?? null} loading={toolsLoading} onRefresh={detect} compact />
                  <p className="text-xs text-muted-foreground">프로그램 제작에 필요한 나머지 도구는 프로젝트를 만들 때 준비합니다.</p>
                  {providerMissing && (
                    <Alert variant="destructive">
                      <AlertTitle>{providerLabel(draft.default_provider)} 설치가 필요해요</AlertTitle>
                      <AlertDescription>
                        "설치"를 눌러 설치하세요. 설치가 끝나면 다음 단계에서 로그인합니다.
                      </AlertDescription>
                    </Alert>
                  )}
                  {gitMissing && (
                    <Alert>
                      <AlertTitle>변경 기록을 저장하려면 Git을 설치하세요</AlertTitle>
                      <AlertDescription>프로그램이 바뀐 내용을 저장하고 이전 상태로 되돌릴 때 사용하는 도구입니다. 위의 Git 설치 버튼으로 준비할 수 있어요.</AlertDescription>
                    </Alert>
                  )}
                </>
              )}

              {step === 1 && (
                <>
                  <p className="text-sm text-muted-foreground">
                    사용자별 계정을 등록하고 연결하세요. 각 프로젝트에서 사용할 계정은 따로 선택합니다.
                  </p>
                  <AccountManager />
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
            <Button variant="ghost" onClick={back} disabled={step === 0 || saving}>
              <ArrowLeft className="size-4" /> 이전
            </Button>
            {step < STEPS.length - 1 ? (
              <Button onClick={next} disabled={saving || (step === 0 && (toolsLoading || tools === null || providerMissing))}>
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
