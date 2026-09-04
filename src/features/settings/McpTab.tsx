// Settings → MCP: servers shared by Claude and Codex (stored in AppSettings.mcp_servers).
import { useState } from "react";
import { Pencil, Plus, Server, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { AppSettings, McpServerConfig, Provider } from "@/lib/ipc";
import { ConfirmDialog } from "@/features/projects/ConfirmDialog";
import { formatEnv, joinArgs, newServer, parseEnv, splitArgs, validateServer } from "./mcp";

interface Props {
  draft: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
}

export function McpTab({ draft, patch }: Props) {
  const servers = draft.mcp_servers ?? [];
  const [editing, setEditing] = useState<McpServerConfig | null>(null);
  const [pendingDelete, setPendingDelete] = useState<McpServerConfig | null>(null);

  const upsert = (s: McpServerConfig) => {
    const exists = servers.some((o) => o.id === s.id);
    patch({ mcp_servers: exists ? servers.map((o) => (o.id === s.id ? s : o)) : [...servers, s] });
  };
  const remove = (id: string) => patch({ mcp_servers: servers.filter((o) => o.id !== id) });

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Server className="size-4" /> MCP 서버
          </h3>
          <p className="text-xs text-muted-foreground">
            Claude와 Codex가 함께 쓰는 도구 서버입니다. 저장 후 새로 시작하는 세션부터 적용됩니다.
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing(newServer())}>
          <Plus className="size-4" /> 추가
        </Button>
      </div>

      {servers.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">등록된 MCP 서버가 없습니다.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {servers.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <Switch checked={s.enabled} onCheckedChange={(v) => upsert({ ...s, enabled: v })} aria-label="사용" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-medium">{s.name}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {s.transport}
                  </Badge>
                  {(s.providers.length === 0 ? (["claude", "codex"] as Provider[]) : s.providers).map((p) => (
                    <Badge key={p} variant="secondary" className="text-[10px]">
                      {p === "claude" ? "Claude" : "Codex"}
                    </Badge>
                  ))}
                </div>
                <div className="truncate font-mono text-xs text-muted-foreground" title={s.transport === "stdio" ? `${s.command ?? ""} ${joinArgs(s.args)}` : (s.url ?? "")}>
                  {s.transport === "stdio" ? `${s.command ?? ""} ${joinArgs(s.args)}` : s.url}
                </div>
              </div>
              <Button size="icon-sm" variant="ghost" aria-label="편집" onClick={() => setEditing({ ...s })}>
                <Pencil />
              </Button>
              <Button size="icon-sm" variant="ghost" className="text-destructive" aria-label="삭제" onClick={() => setPendingDelete(s)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <McpEditDialog
          value={editing}
          others={servers}
          onClose={() => setEditing(null)}
          onSave={(s) => {
            upsert(s);
            setEditing(null);
          }}
        />
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title="MCP 서버를 삭제할까요?"
        description={`"${pendingDelete?.name ?? ""}" 서버 설정이 목록에서 제거됩니다.`}
        confirmLabel="삭제"
        destructive
        onConfirm={() => {
          if (pendingDelete) remove(pendingDelete.id);
        }}
      />
    </div>
  );
}

function McpEditDialog({ value, others, onClose, onSave }: { value: McpServerConfig; others: McpServerConfig[]; onClose: () => void; onSave: (s: McpServerConfig) => void }) {
  const [s, setS] = useState<McpServerConfig>(value);
  const [argsText, setArgsText] = useState(joinArgs(value.args));
  const [envText, setEnvText] = useState(formatEnv(value.env));
  const set = (p: Partial<McpServerConfig>) => setS((c) => ({ ...c, ...p }));
  const toggleProvider = (p: Provider, on: boolean) => {
    const cur = new Set(s.providers);
    if (on) cur.add(p);
    else cur.delete(p);
    set({ providers: Array.from(cur) });
  };

  const submit = () => {
    const merged: McpServerConfig = {
      ...s,
      name: s.name.trim(),
      command: s.transport === "stdio" ? (s.command?.trim() || null) : null,
      args: s.transport === "stdio" ? splitArgs(argsText) : [],
      env: parseEnv(envText),
      url: s.transport === "http" ? (s.url?.trim() || null) : null,
    };
    const err = validateServer(merged, others);
    if (err) {
      toast.error(err);
      return;
    }
    onSave(merged);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{others.some((o) => o.id === s.id) ? "MCP 서버 편집" : "MCP 서버 추가"}</DialogTitle>
          <DialogDescription>도구 이름은 mcp__{s.name || "이름"}__… 형태로 에이전트에 노출됩니다.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>이름</Label>
              <Input value={s.name} onChange={(e) => set({ name: e.target.value })} placeholder="예: filesystem" />
            </div>
            <div className="grid gap-1.5">
              <Label>전송 방식</Label>
              <Select value={s.transport} onValueChange={(v) => set({ transport: v as McpServerConfig["transport"] })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">stdio (명령 실행)</SelectItem>
                  <SelectItem value="http">http (원격 URL)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {s.transport === "stdio" ? (
            <>
              <div className="grid gap-1.5">
                <Label>실행 명령</Label>
                <Input value={s.command ?? ""} onChange={(e) => set({ command: e.target.value })} placeholder="예: npx" className="font-mono" />
              </div>
              <div className="grid gap-1.5">
                <Label>인자 (공백 구분, 따옴표 지원)</Label>
                <Input value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder='예: -y @modelcontextprotocol/server-filesystem "C:\\code"' className="font-mono" />
              </div>
            </>
          ) : (
            <div className="grid gap-1.5">
              <Label>URL</Label>
              <Input value={s.url ?? ""} onChange={(e) => set({ url: e.target.value })} placeholder="https://example.com/mcp" className="font-mono" />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label>환경 변수 (한 줄에 KEY=VALUE)</Label>
            <Textarea value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder="API_KEY=..." className="min-h-16 font-mono text-xs" />
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <Label>대상 에이전트</Label>
            {(["claude", "codex"] as Provider[]).map((p) => (
              <label key={p} className="flex items-center gap-1.5 text-sm">
                <Checkbox checked={s.providers.length === 0 || s.providers.includes(p)} onCheckedChange={(v) => toggleProvider(p, v === true)} />
                {p === "claude" ? "Claude" : "Codex"}
              </label>
            ))}
            <span className="text-xs text-muted-foreground">(아무것도 고르지 않으면 둘 다)</span>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={s.enabled} onCheckedChange={(v) => set({ enabled: v })} /> 사용
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button onClick={submit}>저장</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
