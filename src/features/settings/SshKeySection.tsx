// GitHub SSH key on the active backend: show / generate / copy / register / test.
import { useCallback, useEffect, useState } from "react";
import { Copy, ExternalLink, KeyRound, Loader2, PlugZap, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { ipc, type SshKeyInfo } from "@/lib/ipc";

const notImpl = (e: unknown) => /not implemented/i.test(String(e));

export function SshKeySection({ compact = false }: { compact?: boolean }) {
  const [info, setInfo] = useState<SshKeyInfo | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await ipc.env.sshKeyInfo());
      setError(null);
    } catch (e) {
      setInfo(null);
      setError(notImpl(e) ? "SSH 키 기능은 아직 준비 중입니다." : String(e));
    }
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const generate = async () => {
    setBusy(true);
    try {
      setInfo(await ipc.env.sshGenerateKey());
      toast.success("SSH 키를 만들었습니다. GitHub에 공개키를 등록하세요.");
    } catch (e) {
      toast.error(notImpl(e) ? "SSH 키 생성은 아직 준비 중입니다." : `키 생성 실패: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!info?.public_key) return;
    try {
      await navigator.clipboard.writeText(info.public_key.trim());
      toast.success("공개키를 복사했습니다");
    } catch (e) {
      toast.error(`복사 실패: ${String(e)}`);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const user = await ipc.env.sshTestGithub();
      toast.success(`GitHub 연결 확인: ${user}`);
    } catch (e) {
      toast.error(notImpl(e) ? "연결 테스트는 아직 준비 중입니다." : `연결 실패: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="size-4" /> GitHub SSH 키
        <Button size="icon-xs" variant="ghost" aria-label="다시 확인" onClick={load}>
          <RefreshCw />
        </Button>
      </h3>
      {!compact && (
        <p className="text-xs text-muted-foreground">
          GitHub에 SSH로 푸시하려면 이 PC의 SSH 공개키(~/.ssh)를 GitHub 계정에 등록해야 합니다. 키가 없으면 여기서 만드세요.
        </p>
      )}
      {info === undefined && <p className="text-xs text-muted-foreground">확인 중…</p>}
      {error && <p className="text-xs text-muted-foreground">{error}</p>}
      {info && !info.present && (
        <Button size="sm" onClick={generate} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />} 키 생성 (ed25519)
        </Button>
      )}
      {info?.present && (
        <div className="space-y-2">
          <pre className="max-h-24 overflow-auto rounded-md border bg-muted p-2 font-mono text-[11px] break-all whitespace-pre-wrap">{info.public_key?.trim()}</pre>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={copy}>
              <Copy className="size-4" /> 복사
            </Button>
            <Button size="sm" variant="outline" onClick={() => openUrl("https://github.com/settings/ssh/new").catch(() => {})}>
              <ExternalLink className="size-4" /> GitHub에 등록
            </Button>
            <Button size="sm" variant="secondary" onClick={test} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />} 연결 테스트
            </Button>
          </div>
          {info.path && <p className="text-[11px] text-muted-foreground">{info.path}{info.github_known_host ? " · github.com 호스트 키 등록됨" : ""}</p>}
        </div>
      )}
    </section>
  );
}
