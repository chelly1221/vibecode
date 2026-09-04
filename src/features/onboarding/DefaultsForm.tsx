import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ipc, type AppSettings, type ModelInfo, type Provider } from "@/lib/ipc";
import { EFFORT_OPTIONS, PERMISSION_OPTIONS, PROVIDER_OPTIONS, THEME_OPTIONS } from "@/features/settings/options";

const NONE = "__default__";

interface Props {
  draft: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  showTheme?: boolean;
}

/** Default provider / model / effort / permission / projects root / theme. */
export function DefaultsForm({ draft, onChange, showTheme = true }: Props) {
  const [models, setModels] = useState<Record<Provider, ModelInfo[] | null>>({ claude: null, codex: null });
  const [modelError, setModelError] = useState<string | null>(null);
  const provider = draft.default_provider;
  const modelKey = provider === "claude" ? "default_model_claude" : "default_model_codex";
  const currentModel = draft[modelKey] ?? null;

  useEffect(() => {
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
  }, [provider]);

  const pickRoot = async () => {
    const dir = await open({ directory: true, multiple: false, title: "프로젝트 기본 폴더 선택" });
    if (typeof dir === "string") onChange({ projects_root: dir });
  };

  const list = models[provider] ?? [];
  const knownModel = currentModel && list.some((m) => m.id === currentModel);

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="space-y-2">
        <Label>기본 에이전트</Label>
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

      <div className="space-y-2">
        <Label>기본 모델 ({provider === "claude" ? "Claude" : "Codex"})</Label>
        <Select
          value={currentModel && (knownModel || list.length === 0) ? currentModel : currentModel ? currentModel : NONE}
          onValueChange={(v) => onChange({ [modelKey]: v === NONE ? null : v } as Partial<AppSettings>)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="CLI 기본값" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>CLI 기본값 사용</SelectItem>
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
          placeholder="모델 ID 직접 입력 (예: claude-opus-5)"
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
        <Label>기본 Effort</Label>
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
        <Label>기본 권한 프리셋</Label>
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

      <div className="space-y-2 md:col-span-2">
        <Label>프로젝트 기본 폴더 (Windows 경로)</Label>
        <div className="flex gap-2">
          <Input
            placeholder="예: C:\\code"
            value={draft.projects_root ?? ""}
            onChange={(e) => onChange({ projects_root: e.target.value.trim() || null })}
          />
          <Button type="button" variant="outline" onClick={pickRoot}>
            <FolderOpen className="size-4" /> 폴더 선택
          </Button>
        </div>
      </div>

      {showTheme && (
        <div className="space-y-2">
          <Label>테마</Label>
          <Select value={draft.theme} onValueChange={(v) => onChange({ theme: v })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEME_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
