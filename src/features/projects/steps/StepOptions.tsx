import { useEffect, useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ipc, type GitHubUser, type ModelInfo, type Provider } from "@/lib/ipc";
import type { Effort } from "@/lib/bindings/Effort";
import type { PermissionPreset } from "@/lib/bindings/PermissionPreset";
import { useAppStore } from "@/stores/app";
import { useWizardStore } from "@/stores/wizard";
import { EFFORT_OPTIONS, PERMISSION_OPTIONS, PROVIDER_LABEL } from "../labels";

const DEFAULT_MODEL = "__default__";

function SwitchRow({ id, label, description, checked, onChange, disabled }: { id: string; label: string; description?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
      <div className="grid gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

export function StepOptions() {
  const form = useWizardStore((s) => s.form);
  const setField = useWizardStore((s) => s.setField);
  const settings = useAppStore((s) => s.settings);
  const [ghUser, setGhUser] = useState<GitHubUser | null | undefined>(undefined);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  useEffect(() => {
    ipc.github
      .whoami()
      .then(setGhUser)
      .catch(() => setGhUser(null));
  }, []);

  const provider: Provider = form.provider ?? settings?.default_provider ?? "claude";
  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);
    ipc.tools
      .listModels(provider)
      .then((m) => !cancelled && setModels(m))
      .catch(() => !cancelled && setModels([]))
      .finally(() => !cancelled && setModelsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const selectedModel = models.find((m) => m.id === form.model);
  const efforts = selectedModel && selectedModel.efforts.length > 0 ? EFFORT_OPTIONS.filter((e) => selectedModel.efforts.includes(e.value)) : EFFORT_OPTIONS;

  return (
    <div className="grid gap-4">
      <section className="grid gap-2">
        <h3 className="text-sm font-medium">저장소</h3>
        <SwitchRow id="opt-git" label="git 초기화" description="main 브랜치로 저장소를 만들고 첫 커밋을 남깁니다." checked={form.gitInit} onChange={(v) => setField("gitInit", v)} />
        <SwitchRow
          id="opt-gh"
          label="GitHub 저장소 생성"
          description={
            ghUser === undefined
              ? "GitHub 계정 확인 중…"
              : ghUser
                ? `${ghUser.login} 계정에 저장소를 만들고 origin으로 연결합니다.`
                : "GitHub 토큰이 없습니다. 설정 → 계정에서 등록하면 사용할 수 있습니다."
          }
          checked={form.gitInit && form.createGithub}
          disabled={!form.gitInit || !ghUser}
          onChange={(v) => setField("createGithub", v)}
        />
        {form.gitInit && form.createGithub && (
          <div className="ml-4 flex items-center justify-between rounded-lg border p-3">
            <div className="flex items-center gap-2 text-sm">
              <Lock className="size-4" /> <Label htmlFor="opt-private">비공개 저장소</Label>
            </div>
            <Switch id="opt-private" checked={form.githubPrivate} onCheckedChange={(v) => setField("githubPrivate", v)} />
          </div>
        )}
      </section>

      <section className="grid gap-2">
        <h3 className="text-sm font-medium">도구</h3>
        <SwitchRow
          id="opt-install"
          label="필요한 도구 자동 설치"
          description="스택에 필요한데 없는 도구를 만들기 전에 설치합니다 (Windows용 툴체인은 winget, WSL 쪽은 apt·설치 스크립트). 진행 상황은 생성 화면에 표시됩니다."
          checked={form.installTools}
          onChange={(v) => setField("installTools", v)}
        />
      </section>

      <section className="grid gap-2">
        <h3 className="text-sm font-medium">에이전트</h3>
        <SwitchRow id="opt-docs" label="CLAUDE.md / AGENTS.md 생성" description="스택, 빌드 명령, 설명을 담은 지침 파일을 만들어 두 에이전트가 함께 씁니다." checked={form.generateDocs} onChange={(v) => setField("generateDocs", v)} />
        <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>기본 에이전트</Label>
            <Select
              value={provider}
              onValueChange={(v) => {
                setField("provider", v as Provider);
                setField("model", null);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["claude", "codex"] as Provider[]).map((p) => (
                  <SelectItem key={p} value={p}>
                    {PROVIDER_LABEL[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>모델</Label>
            <Select value={form.model ?? DEFAULT_MODEL} onValueChange={(v) => setField("model", v === DEFAULT_MODEL ? null : v)} disabled={modelsLoading}>
              <SelectTrigger className="w-full">
                {modelsLoading ? <Loader2 className="size-4 animate-spin" /> : <SelectValue />}
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_MODEL}>기본값</SelectItem>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Effort</Label>
            <Select value={form.effort ?? "high"} onValueChange={(v) => setField("effort", v as Effort)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {efforts.map((e) => (
                  <SelectItem key={e.value} value={e.value}>
                    {e.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>권한</Label>
            <Select value={form.permission ?? "auto_edit"} onValueChange={(v) => setField("permission", v as PermissionPreset)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERMISSION_OPTIONS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    <span>{p.label}</span>
                    <span className="ml-1 text-xs text-muted-foreground">{p.description}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </section>
    </div>
  );
}
