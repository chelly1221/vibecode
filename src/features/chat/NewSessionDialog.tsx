// Dialog for starting a new agent session in the active project.

import { useEffect, useMemo, useState } from "react";
import { ChevronRightIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useModels } from "@/hooks/useModels";
import type { Provider, SessionConfig } from "@/lib/ipc";
import type { Effort } from "@/lib/bindings/Effort";
import type { PermissionPreset } from "@/lib/bindings/PermissionPreset";
import { useAppStore } from "@/stores/app";
import { useSessionsStore } from "@/stores/sessions";
import { cn } from "@/lib/utils";
import { DEFAULT_OPTION, EFFORTS, EFFORT_LABEL, PERMISSION_HINT, PERMISSION_LABEL, PERMISSION_PRESETS, PROVIDER_LABEL } from "./labels";

const PROVIDERS: Provider[] = ["claude", "codex"];

export function NewSessionDialog() {
  const open = useAppStore((s) => s.newSessionOpen);
  const setOpen = useAppStore((s) => s.setNewSessionOpen);
  const settings = useAppStore((s) => s.settings);
  const projectId = useAppStore((s) => s.activeProjectId);
  const project = useAppStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null);
  const selectSession = useAppStore((s) => s.selectSession);
  const startSession = useSessionsStore((s) => s.startSession);

  const [provider, setProvider] = useState<Provider>("claude");
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<Effort | null>(null);
  const [permission, setPermission] = useState<PermissionPreset>("auto_edit");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [budget, setBudget] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);

  const { models, loading } = useModels(open ? provider : null);

  // Reset to project/settings defaults each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const p = project?.default_provider ?? settings?.default_provider ?? "claude";
    setProvider(p);
    setPermission(project?.default_permission ?? settings?.default_permission ?? "auto_edit");
    setEffort(project?.default_effort ?? settings?.default_effort ?? null);
    setSystemPrompt("");
    setBudget("");
    setAdvanced(false);
  }, [open, project, settings]);

  // Model default depends on the provider.
  useEffect(() => {
    if (!open) return;
    const fromProject = project?.default_provider === provider ? project?.default_model ?? null : null;
    const fromSettings = provider === "claude" ? settings?.default_model_claude ?? null : settings?.default_model_codex ?? null;
    setModel(fromProject ?? fromSettings ?? null);
  }, [open, provider, project, settings]);

  const selectedModel = useMemo(() => models.find((m) => m.id === model) ?? models.find((m) => m.is_default), [models, model]);
  const efforts = selectedModel && selectedModel.efforts.length ? EFFORTS.filter((e) => selectedModel.efforts.includes(e)) : EFFORTS;

  const submit = async () => {
    if (!projectId) return;
    const budgetNum = budget.trim() ? Number(budget) : null;
    if (budgetNum !== null && (!Number.isFinite(budgetNum) || budgetNum <= 0)) {
      toast.error("예산은 0보다 큰 숫자여야 합니다");
      return;
    }
    const config: SessionConfig = {
      project_id: projectId,
      provider,
      model,
      effort,
      permission,
      max_budget_usd: budgetNum,
      append_system_prompt: systemPrompt.trim() || null,
      resume_ref: null,
      fork: false,
    };
    setBusy(true);
    try {
      const record = await startSession(config);
      selectSession(record.id);
      setOpen(false);
    } catch (e) {
      toast.error("세션을 시작할 수 없습니다", { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>새 세션</DialogTitle>
          <DialogDescription>{project ? `${project.name} 프로젝트에서 에이전트 세션을 시작합니다.` : "프로젝트를 먼저 선택하세요."}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>에이전트</Label>
            <div className="grid grid-cols-2 gap-2">
              {PROVIDERS.map((p) => (
                <Button
                  key={p}
                  type="button"
                  variant={provider === p ? "default" : "outline"}
                  onClick={() => setProvider(p)}
                  className="justify-center"
                >
                  {PROVIDER_LABEL[p]}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>모델</Label>
            <Select value={model ?? DEFAULT_OPTION} onValueChange={(v) => setModel(v === DEFAULT_OPTION ? null : v)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={loading ? "불러오는 중…" : "모델"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_OPTION}>기본값 (CLI 설정)</SelectItem>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                    {m.is_default && <span className="ml-1 text-muted-foreground">(기본)</span>}
                  </SelectItem>
                ))}
                {model && !models.some((m) => m.id === model) && <SelectItem value={model}>{model}</SelectItem>}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Effort</Label>
              <Select value={effort ?? DEFAULT_OPTION} onValueChange={(v) => setEffort(v === DEFAULT_OPTION ? null : (v as Effort))}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_OPTION}>기본값</SelectItem>
                  {efforts.map((e) => (
                    <SelectItem key={e} value={e}>
                      {EFFORT_LABEL[e]} <span className="text-muted-foreground">({e})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>권한</Label>
              <Select value={permission} onValueChange={(v) => setPermission(v as PermissionPreset)}>
                <SelectTrigger className={cn("w-full", permission === "full_auto" && "border-destructive/60 text-destructive")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERMISSION_PRESETS.map((p) => (
                    <SelectItem key={p} value={p} className={cn(p === "full_auto" && "text-destructive")}>
                      {PERMISSION_LABEL[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className={cn("text-xs text-muted-foreground", permission === "full_auto" && "text-destructive")}>{PERMISSION_HINT[permission]}</p>

          <Collapsible open={advanced} onOpenChange={setAdvanced}>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronRightIcon className={cn("size-3.5 transition-transform", advanced && "rotate-90")} />
              고급 설정
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="ns-system">추가 시스템 프롬프트</Label>
                <Textarea id="ns-system" value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="이 세션에만 적용할 지시사항" className="min-h-20" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ns-budget">예산 한도 (USD)</Label>
                <Input id="ns-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="예: 5" />
                <p className="text-xs text-muted-foreground">Claude 세션에만 적용됩니다.</p>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            취소
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !projectId}>
            {busy && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
            시작
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
