import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AccountChoices } from "@/features/accounts/AccountChoices";
import { EFFORTS, EFFORT_LABEL, PERMISSION_HINT, PERMISSION_LABEL, PERMISSION_PRESETS, PROVIDER_LABEL } from "@/features/chat/labels";
import { AUTO_GIT_OPTIONS, autoGitLabel } from "@/features/settings/options";
import type { AutoGit } from "@/lib/bindings/AutoGit";
import { useModels } from "@/hooks/useModels";
import type { Effort } from "@/lib/bindings/Effort";
import type { PermissionPreset } from "@/lib/bindings/PermissionPreset";
import { ipc, type ProjectRecord, type ProjectRemoteStatus, type ProjectSettingsUpdate, type Provider } from "@/lib/ipc";
import { useAppStore } from "@/stores/app";
import { validateProjectName } from "./validation";

export function ProjectEditDialog({ project, onClose }: { project: ProjectRecord; onClose: () => void }) {
  const [draft, setDraft] = useState<ProjectSettingsUpdate | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remote, setRemote] = useState<ProjectRemoteStatus | null>(null);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteLoading, setRemoteLoading] = useState(true);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(false);
  const disabled = busy || initializing;

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    Promise.all([ipc.projects.get(project.id), ipc.accounts.project(project.id)]).then(([saved, accounts]) => {
      if (cancelled) return;
      const settings = useAppStore.getState().settings;
      const provider = saved.default_provider ?? settings?.default_provider ?? "claude";
      setDraft({
        name: saved.name, accounts, default_provider: provider,
        default_model: saved.default_model ?? (provider === "claude" ? settings?.default_model_claude : settings?.default_model_codex) ?? null,
        default_effort: saved.default_effort ?? settings?.default_effort ?? null,
        default_permission: saved.default_permission ?? settings?.default_permission ?? "full_auto",
        auto_git: saved.auto_git ?? null,
        update_remote: false, remote_url: null,
      });
    }).catch((e) => { if (!cancelled) setLoadError(String(e)); });
    return () => { cancelled = true; };
  }, [project.id, loadAttempt]);

  const loadRemote = useCallback(async () => {
    setRemoteLoading(true);
    setRemoteError(null);
    try {
      const status = await ipc.projects.remoteStatus(project.id);
      setRemote(status);
      setRemoteUrl(status.url ?? "");
    } catch (e) { setRemoteError(String(e)); }
    finally { setRemoteLoading(false); }
  }, [project.id]);
  useEffect(() => { void loadRemote(); }, [loadRemote]);

  const { models, loading: modelsLoading, error: modelsError, reload: reloadModels } = useModels(draft?.default_provider ?? null, draft?.accounts[draft.default_provider]);
  const selectedModel = models.find((m) => m.id === draft?.default_model) ?? (draft?.default_model ? undefined : models.find((m) => m.is_default));
  const modelValue = draft?.default_model ?? selectedModel?.id ?? "";
  const efforts = selectedModel?.efforts.length ? EFFORTS.filter((e) => selectedModel.efforts.includes(e)) : EFFORTS;
  const nameError = draft ? validateProjectName(draft.name.trim()) : null;
  const remoteChanged = !!remote && !remoteLoading && !remoteError && remoteUrl.trim() !== (remote.url ?? "").trim();
  const missingGithub = remoteChanged && !!remoteUrl.trim() && !draft?.accounts.github;
  const patch = (value: Partial<ProjectSettingsUpdate>) => { setDraft((d) => d ? { ...d, ...value } : d); setError(null); };

  const changeProvider = (provider: Provider) => {
    if (provider === draft?.default_provider) return;
    const settings = useAppStore.getState().settings;
    patch({ default_provider: provider, default_model: (provider === "claude" ? settings?.default_model_claude : settings?.default_model_codex) ?? null, default_effort: null });
  };
  const initializeGit = async () => {
    setInitializing(true);
    setRemoteError(null);
    try { await ipc.git.init(project.id); await loadRemote(); }
    catch (e) { setRemoteError(String(e)); }
    finally { setInitializing(false); }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft || disabled || nameError || missingGithub) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await ipc.projects.update(project.id, {
        ...draft, name: draft.name.trim(), default_model: modelValue || null,
        update_remote: remoteChanged, remote_url: remoteChanged ? remoteUrl.trim() || null : null,
      });
      useAppStore.setState((s) => ({ projects: s.projects.map((p) => p.id === updated.id ? updated : p) }));
      toast.success("프로젝트 설정을 저장했습니다.");
      onClose();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  return <Dialog open onOpenChange={(open) => { if (!open && !disabled) onClose(); }}>
    <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl" showCloseButton={!disabled} onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => { if (disabled) e.preventDefault(); }}>
      <DialogHeader className="shrink-0 px-6 pt-5 pb-4">
        <DialogTitle>프로젝트 수정</DialogTitle>
        <DialogDescription>AI 설정은 새 대화에 적용됩니다.</DialogDescription>
      </DialogHeader>
      <form onSubmit={save} className="flex min-h-0 flex-col">
        <div className="grid gap-4 overflow-y-auto px-6 pb-5">
          {!draft && (loadError ? <p role="alert" className="text-sm text-destructive">{loadError}<Button type="button" variant="link" onClick={() => setLoadAttempt((n) => n + 1)}>다시 불러오기</Button></p> : <p role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />설정 불러오는 중…</p>)}
          {draft && <>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-project-name">프로젝트 이름</Label>
              <Input id="edit-project-name" value={draft.name} disabled={disabled} onChange={(e) => patch({ name: e.target.value })} aria-invalid={!!nameError} aria-describedby={nameError ? "edit-project-name-error" : undefined} />
              {nameError && <p id="edit-project-name-error" className="text-xs text-destructive">{nameError}</p>}
              <p className="truncate text-xs text-muted-foreground" title={project.path}>{project.path}</p>
            </div>
            <section className="grid gap-3 rounded-xl border p-4">
              <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-2">
                <h3 className="mr-2 text-sm font-medium">사용할 AI</h3>
                {(["claude", "codex"] as Provider[]).map((p) => <Button key={p} type="button" size="sm" variant={draft.default_provider === p ? "default" : "outline"} aria-pressed={draft.default_provider === p} disabled={disabled} onClick={() => changeProvider(p)}>{PROVIDER_LABEL[p]}</Button>)}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="edit-project-model">모델</Label>
                  <Select value={modelValue} disabled={disabled || modelsLoading} onValueChange={(model) => {
                    if (!model) return;
                    const supported = models.find((m) => m.id === model)?.efforts;
                    patch({ default_model: model, ...(draft.default_effort && supported?.length && !supported.includes(draft.default_effort) ? { default_effort: null } : {}) });
                  }}>
                    <SelectTrigger id="edit-project-model" className="w-full"><SelectValue placeholder={modelsLoading ? "모델 불러오는 중…" : "모델 선택"}>{modelValue ? (selectedModel ? `${selectedModel.label}${selectedModel.is_default ? " (기본)" : ""}` : modelValue) : undefined}</SelectValue></SelectTrigger>
                    <SelectContent position="popper" side="bottom" align="start">
                      {models.map((m) => <SelectItem key={m.id} value={m.id}>{m.label}{m.is_default ? " (기본)" : ""}</SelectItem>)}
                      {modelValue && !models.some((m) => m.id === modelValue) && <SelectItem value={modelValue}>{modelValue}</SelectItem>}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="edit-project-effort">생각하는 깊이</Label>
                  <Select value={draft.default_effort ?? "auto"} disabled={disabled} onValueChange={(e) => { if (e) patch({ default_effort: e === "auto" ? null : e as Effort }); }}>
                    <SelectTrigger id="edit-project-effort" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent position="popper" side="bottom" align="start" avoidCollisions={false}>
                      <SelectItem value="auto">자동</SelectItem>
                      {efforts.map((e) => <SelectItem key={e} value={e}>{EFFORT_LABEL[e]}</SelectItem>)}
                      {draft.default_effort && !efforts.includes(draft.default_effort) && <SelectItem value={draft.default_effort}>{EFFORT_LABEL[draft.default_effort]} (현재 설정)</SelectItem>}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {modelsError && <p className="text-xs text-destructive">{modelsError}<Button type="button" size="sm" variant="link" disabled={disabled} onClick={reloadModels}>다시 불러오기</Button></p>}
              <div className="grid gap-1.5">
                <Label htmlFor="edit-project-permission">작업 권한</Label>
                <Select value={draft.default_permission} disabled={disabled} onValueChange={(p) => { if (p) patch({ default_permission: p as PermissionPreset }); }}>
                  <SelectTrigger id="edit-project-permission" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent position="popper" side="bottom" align="start">{PERMISSION_PRESETS.map((p) => <SelectItem key={p} value={p}>{PERMISSION_LABEL[p]}</SelectItem>)}</SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{PERMISSION_HINT[draft.default_permission]}</p>
              </div>
            </section>
            <AccountChoices value={draft.accounts} onChange={(accounts) => patch({ accounts })} disabled={disabled} showCommitAuthor />
            <section className="grid gap-2 rounded-xl border p-4">
              <Label htmlFor="edit-project-remote">GitHub 저장소 연결</Label>
              {remoteLoading ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />저장소 확인 중…</p> : remote?.is_repo && <>
                <Input id="edit-project-remote" value={remoteUrl} disabled={disabled || !!remoteError} placeholder="https://github.com/owner/repository" spellCheck={false} onChange={(e) => { setRemoteUrl(e.target.value); setError(null); }} />
                {remote.url && <p className="text-xs text-muted-foreground">주소를 비우고 저장하면 연결이 해제됩니다.</p>}
              </>}
              {!remoteLoading && remote && !remote.is_repo && <div className="flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">저장소 연결을 위해 변경 기록을 시작하세요.</p><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => void initializeGit()}>{initializing && <Loader2 className="animate-spin" />}변경 기록 시작</Button></div>}
              {remoteError && <p role="alert" className="text-xs text-destructive">{remoteError}<Button type="button" size="sm" variant="link" disabled={disabled} onClick={() => void loadRemote()}>다시 확인</Button></p>}
              {missingGithub && <p role="alert" className="text-xs text-destructive">저장소에 사용할 GitHub 계정을 선택하세요.</p>}
              <div className="mt-1 grid gap-1.5">
                <Label htmlFor="edit-project-auto-git">AI 작업이 끝나면 변경 기록 저장</Label>
                <Select value={draft.auto_git ?? "default"} disabled={disabled} onValueChange={(v) => { if (v) patch({ auto_git: v === "default" ? null : (v as AutoGit) }); }}>
                  <SelectTrigger id="edit-project-auto-git" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent position="popper" side="bottom" align="start">
                    <SelectItem value="default">기본 설정 따르기 ({autoGitLabel(useAppStore.getState().settings?.auto_git ?? "off")})</SelectItem>
                    {AUTO_GIT_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{AUTO_GIT_OPTIONS.find((o) => o.value === (draft.auto_git ?? useAppStore.getState().settings?.auto_git ?? "off"))?.description}{draft.auto_git === "commit_push" || (draft.auto_git === null && useAppStore.getState().settings?.auto_git === "commit_push") ? " · GitHub 계정과 저장소 연결이 필요합니다." : ""}</p>
              </div>
            </section>
          </>}
        </div>
        <div className="shrink-0 border-t px-6 py-4">
          {error && <p role="alert" className="mb-3 text-sm text-destructive">저장하지 못했습니다: {error}</p>}
          <DialogFooter className="m-0 border-0 bg-transparent p-0">
            <Button type="button" variant="ghost" disabled={disabled} onClick={onClose}>취소</Button>
            <Button type="submit" disabled={!draft || disabled || !!nameError || !!missingGithub}>{busy && <Loader2 className="animate-spin" />}{busy ? "저장 중…" : "저장"}</Button>
          </DialogFooter>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
