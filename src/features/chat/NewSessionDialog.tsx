// Dialog for starting a new agent session in the active project.

import { useEffect, useMemo, useState } from "react";
import { ChevronRightIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useModels } from "@/hooks/useModels";
import { ipc, type ProjectAccounts, type Provider, type SessionConfig } from "@/lib/ipc";
import { AccountChoices } from "@/features/accounts/AccountChoices";
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
  const [permission, setPermission] = useState<PermissionPreset>("full_auto");
  const [firstMessage, setFirstMessage] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);

  const [accounts, setAccounts] = useState<ProjectAccounts | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false; setAccounts(null); setAccountError(null);
    if (open && projectId) ipc.accounts.project(projectId).then((a) => { if (!cancelled) setAccounts(a); }).catch((e) => { if (!cancelled) setAccountError(String(e)); });
    return () => { cancelled = true; };
  }, [open, projectId]);
  const { models, loading } = useModels(open ? provider : null, accounts?.[provider]);

  // Reset to project/settings defaults each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const p = project?.default_provider ?? settings?.default_provider ?? "claude";
    setProvider(p);
    setPermission(project?.default_permission ?? settings?.default_permission ?? "full_auto");
    setEffort(project?.default_effort ?? settings?.default_effort ?? null);
    setFirstMessage("");
    setSystemPrompt("");
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
    if (!projectId || busy || !accounts?.[provider]) return;
    const config: SessionConfig = {
      project_id: projectId,
      provider,
      model,
      effort,
      permission,
      append_system_prompt: systemPrompt.trim() || null,
      resume_ref: null,
      fork: false,
    };
    setBusy(true);
    try {
      await ipc.accounts.setProject(projectId, accounts);
      const record = await startSession(config);
      if (useAppStore.getState().activeProjectId !== projectId) return;
      selectSession(record.id);
      setOpen(false);
      if (firstMessage.trim()) {
        try { await useSessionsStore.getState().send(record.id, firstMessage.trim()); }
        catch (e) {
          useAppStore.getState().insertIntoComposer(firstMessage);
          toast.error("대화는 열었지만 요청을 보내지 못했어요. 입력창에서 다시 보내 주세요.", { description: String(e) });
        }
      }
    } catch (e) {
      toast.error("세션을 시작할 수 없습니다", { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>AI와 새 대화</DialogTitle>
          <DialogDescription>{project ? `${project.name} 프로젝트에서 원하는 작업을 말해 주세요.` : "프로젝트를 먼저 선택하세요."}</DialogDescription>
        </DialogHeader>

        {accountError && <p role="alert" className="text-sm text-destructive">{accountError}</p>}
        {accounts && <AccountChoices value={accounts} onChange={setAccounts} disabled={busy} />}
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>함께 작업할 AI</Label>
            <div className="grid grid-cols-2 gap-2">
              {PROVIDERS.map((p) => (
                <Button
                  key={p}
                  type="button"
                  variant={provider === p ? "default" : "outline"}
                  aria-pressed={provider === p}
                  disabled={busy}
                  onClick={() => setProvider(p)}
                  className="justify-center"
                >
                  {PROVIDER_LABEL[p]}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="ns-request">무엇을 도와드릴까요? <span className="font-normal text-muted-foreground">(선택)</span></Label>
            <Textarea id="ns-request" value={firstMessage} onChange={(e) => setFirstMessage(e.target.value)} disabled={busy} placeholder="예: 첫 화면에 예약 버튼을 추가해 줘" className="min-h-24" />
          </div>
          <p className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">작업 방식: {PERMISSION_LABEL[permission]} · {PERMISSION_HINT[permission]}</p>
          <Collapsible open={advanced} onOpenChange={setAdvanced}>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronRightIcon className={cn("size-3.5 transition-transform", advanced && "rotate-90")} />
              고급 설정
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 grid gap-3">
          <div className="grid gap-1.5">
            <Label>모델</Label>
            <Select value={model ?? DEFAULT_OPTION} onValueChange={(v) => setModel(v === DEFAULT_OPTION ? null : v)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={loading ? "불러오는 중…" : "모델"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_OPTION}>자동 선택 (권장)</SelectItem>
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
              <Label>생각하는 깊이</Label>
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


              <div className="grid gap-1.5">
                <Label htmlFor="ns-system">AI에게 항상 지킬 내용</Label>
                <Textarea id="ns-system" value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="이 대화에서 지킬 내용 (선택)" className="min-h-20" />
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            취소
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !projectId || !accounts?.[provider]}>
            {busy && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
            {busy ? "연결 중…" : firstMessage.trim() ? "요청 보내고 시작" : "대화 시작"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
