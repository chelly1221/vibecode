import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ipc, type AppSettings, type ModelInfo, type Provider } from "@/lib/ipc";
import { EFFORT_OPTIONS, PERMISSION_OPTIONS, PROVIDER_OPTIONS } from "@/features/settings/options";

const NONE = "__default__";

interface Props {
  draft: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}

/** Default provider / model / effort / permission / projects root. */
export function DefaultsForm({ draft, onChange }: Props) {
  const [advanced, setAdvanced] = useState(false);
  const [models, setModels] = useState<Record<Provider, ModelInfo[] | null>>({ claude: null, codex: null });
  const [modelError, setModelError] = useState<string | null>(null);
  const provider = draft.default_provider;
  const modelKey = provider === "claude" ? "default_model_claude" : "default_model_codex";
  const currentModel = draft[modelKey] ?? null;

  useEffect(() => {
    if (!advanced) return;
    let cancelled = false;
    setModelError(null);
    ipc.tools
      .listModels(provider)
      .then((list) => {
        if (!cancelled) setModels((m) => ({ ...m, [provider]: list }));
      })
      .catch((e) => {
        if (!cancelled) {
          setModels((m) => ({ ...m, [provider]: [] }));
          setModelError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [provider, advanced]);

  const pickRoot = async () => {
    try {
      const dir = await open({ directory: true, multiple: false, title: "프로젝트 기본 폴더 선택" });
      if (typeof dir === "string") onChange({ projects_root: dir });
    } catch (e) { toast.error("폴더를 선택하지 못했어요", { description: String(e) }); }
  };

  const list = models[provider] ?? [];
  const knownModel = currentModel && list.some((m) => m.id === currentModel);

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="space-y-2">
        <Label>함께 작업할 AI</Label>
        <Select value={provider} onValueChange={(v) => onChange({ default_provider: v as Provider })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label} <span className="text-muted-foreground">· {o.description}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-xl border bg-muted/30 p-3 text-sm">
        <div className="font-medium">현재 작업 방식: {PERMISSION_OPTIONS.find((o) => o.value === draft.default_permission)?.label}</div>
        <p className="mt-1 text-xs text-muted-foreground">{PERMISSION_OPTIONS.find((o) => o.value === draft.default_permission)?.description} · 아래 세부 설정에서 바꿀 수 있어요.</p>
      </div>
      <div className="space-y-2 md:col-span-2">
        <Label>프로젝트를 저장할 폴더</Label>
        <div className="flex gap-2">
          <Input
            placeholder="예: C:\code"
            value={draft.projects_root ?? ""}
            onChange={(e) => onChange({ projects_root: e.target.value.trim() || null })}
          />
          <Button type="button" variant="outline" onClick={pickRoot}>
            <FolderOpen className="size-4" /> 폴더 선택
          </Button>
        </div>
      </div>

      <div className="space-y-2 md:col-span-2">
        <Label>동작</Label>
        <div className="grid gap-2 rounded-lg border p-3 md:grid-cols-3">
          {(
            [
              ["checkpoints_enabled", "AI 작업 전 복원 지점 저장", "AI가 작업하기 전 상태를 저장해 되돌릴 수 있습니다."],
              ["notifications_enabled", "작업 완료·승인 필요 시 알림", "다른 창을 보고 있을 때 Windows 알림을 띄웁니다."],
              ["auto_update_check", "시작할 때 업데이트 확인", "새 버전이 있으면 알려만 줍니다. 설치는 설정 > 정보에서."],
            ] as const
          ).map(([key, label, desc]) => (
            <label key={key} className="flex items-start gap-2 text-sm">
              <Switch checked={draft[key]} onCheckedChange={(v) => onChange({ [key]: v } as Partial<AppSettings>)} className="mt-0.5" />
              <span>
                <span className="block">{label}</span>
                <span className="block text-xs text-muted-foreground">{desc}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <details className="rounded-xl border p-4 md:col-span-2" onToggle={(e) => setAdvanced(e.currentTarget.open)}>
        <summary className="cursor-pointer text-sm font-medium">AI 세부 설정과 변경 기록 작성자</summary>
        <p className="mt-2 text-xs text-muted-foreground">처음에는 기본값으로 시작해도 됩니다. 모델, 생각하는 깊이, 작업 확인 방식을 조정할 수 있어요.</p>
        <div className="mt-4 grid gap-5 md:grid-cols-2">
      <div className="space-y-2">
        <Label>기본 모델 ({provider === "claude" ? "Claude" : "Codex"})</Label>
        <Select
          value={currentModel && (knownModel || list.length === 0) ? currentModel : currentModel ? currentModel : NONE}
          onValueChange={(v) => onChange({ [modelKey]: v === NONE ? null : v } as Partial<AppSettings>)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="자동 선택" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>AI가 권장하는 모델 사용</SelectItem>
            {list.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label}
                {m.is_default ? <span className="text-muted-foreground"> · 기본</span> : null}
              </SelectItem>
            ))}
            {currentModel && !knownModel && (
              <SelectItem value={currentModel}>
                {currentModel} <span className="text-muted-foreground">· 직접 입력</span>
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        <Input
          aria-label="모델 이름 직접 입력"
          placeholder="다른 모델 이름 직접 입력 (선택)"
          value={currentModel ?? ""}
          onChange={(e) => onChange({ [modelKey]: e.target.value.trim() || null } as Partial<AppSettings>)}
        />
        {modelError && (
          <p className="text-xs text-muted-foreground">
            모델 목록을 가져오지 못했습니다. 직접 입력할 수 있습니다.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label>생각하는 깊이</Label>
        <Select value={draft.default_effort} onValueChange={(v) => onChange({ default_effort: v as AppSettings["default_effort"] })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EFFORT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label} <span className="text-muted-foreground">· {o.description}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>작업 확인 방식</Label>
        <Select
          value={draft.default_permission}
          onValueChange={(v) => onChange({ default_permission: v as AppSettings["default_permission"] })}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERMISSION_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                <span className={o.danger ? "text-destructive" : ""}>{o.label}</span>{" "}
                <span className="text-muted-foreground">· {o.description}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label>변경 기록에 표시할 이름</Label>
          <Input
            placeholder="예: 3chan"
            value={draft.git_user_name ?? ""}
            onChange={(e) => onChange({ git_user_name: e.target.value || null })}
          />
        </div>
        <div className="space-y-1.5">
          <Label>변경 기록에 표시할 이메일</Label>
          <Input
            placeholder="예: you@example.com"
            value={draft.git_user_email ?? ""}
            onChange={(e) => onChange({ git_user_email: e.target.value || null })}
          />
          <p className="text-xs text-muted-foreground">저장한 버전의 작성자 정보로 사용합니다.</p>
        </div>
      </div>
        </div>
      </details>


    </div>
  );
}
