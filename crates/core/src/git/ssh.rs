//! SSH key helpers on the active backend (ed25519 key for GitHub pushes).
//! WSL backends run bash snippets; the native backend runs the same steps in PowerShell
//! using the Windows OpenSSH client.

use std::sync::Arc;

use crate::backend::{CommandSpec, ExecBackend};
use crate::error::{CoreError, Result};
use crate::types::{BackendKind, SshKeyInfo};

const INFO_BASH: &str = r#"for k in id_ed25519 id_rsa; do
  if [ -f "$HOME/.ssh/$k.pub" ]; then echo "KEYPATH=$HOME/.ssh/$k"; echo "PUBKEY=$(cat "$HOME/.ssh/$k.pub")"; break; fi
done
if [ -f "$HOME/.ssh/known_hosts" ] && grep -q "github.com" "$HOME/.ssh/known_hosts"; then echo KNOWN=1; else echo KNOWN=0; fi"#;

const GENERATE_BASH: &str = r#"set -e
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
if [ ! -f "$HOME/.ssh/id_ed25519" ] && [ ! -f "$HOME/.ssh/id_rsa" ]; then ssh-keygen -q -t ed25519 -N "" -C vibecoder -f "$HOME/.ssh/id_ed25519"; fi
if ! grep -q "github.com" "$HOME/.ssh/known_hosts" 2>/dev/null; then ssh-keyscan -t ed25519,rsa github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null || true; fi"#;

const INFO_PS: &str = r#"$ssh = Join-Path $env:USERPROFILE ".ssh"
foreach ($k in @("id_ed25519","id_rsa")) { $p = Join-Path $ssh "$k.pub"; if (Test-Path $p) { "KEYPATH=" + (Join-Path $ssh $k); "PUBKEY=" + ((Get-Content $p -Raw).Trim()); break } }
$kh = Join-Path $ssh "known_hosts"
if ((Test-Path $kh) -and (Select-String -Path $kh -Pattern "github.com" -Quiet)) { "KNOWN=1" } else { "KNOWN=0" }"#;

const GENERATE_PS: &str = r#"$ErrorActionPreference = 'Stop'
$ssh = Join-Path $env:USERPROFILE ".ssh"; New-Item -ItemType Directory -Force -Path $ssh | Out-Null
$key = Join-Path $ssh "id_ed25519"
if (-not (Test-Path $key) -and -not (Test-Path (Join-Path $ssh "id_rsa"))) { & ssh-keygen -q -t ed25519 -N '""' -C vibecoder -f $key }
$kh = Join-Path $ssh "known_hosts"
if (-not ((Test-Path $kh) -and (Select-String -Path $kh -Pattern "github.com" -Quiet))) { & ssh-keyscan -t ed25519,rsa github.com 2>$null | Out-File -Append -Encoding ascii $kh }"#;

fn parse_info(stdout: &str) -> SshKeyInfo {
    let mut info = SshKeyInfo { present: false, public_key: None, path: None, github_known_host: false };
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("KEYPATH=") {
            info.path = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("PUBKEY=") {
            let v = v.trim();
            if !v.is_empty() {
                info.public_key = Some(v.to_string());
                info.present = true;
            }
        } else if let Some(v) = line.strip_prefix("KNOWN=") {
            info.github_known_host = v.trim() == "1";
        }
    }
    info
}

/// Scripts are written to a temp file and executed by path: multi-line scripts with quotes and
/// `$` do not survive the nested `wsl.exe → bash -lc` quoting reliably.
async fn run_script(backend: &Arc<dyn ExecBackend>, bash: &str, ps: &str) -> Result<crate::backend::CommandOutput> {
    let (body, ext) = match backend.kind() {
        BackendKind::Wsl => (bash, "sh"),
        BackendKind::Native => (ps, "ps1"),
    };
    let path = std::env::temp_dir().join(format!("vibecoder-ssh-{}.{ext}", uuid::Uuid::new_v4()));
    let mut bytes: Vec<u8> = if ext == "ps1" { vec![0xEF, 0xBB, 0xBF] } else { vec![] };
    bytes.extend_from_slice(body.replace("\r\n", "\n").as_bytes());
    tokio::fs::write(&path, bytes).await?;
    let spec = match backend.kind() {
        BackendKind::Wsl => CommandSpec::new("bash").arg(backend.to_backend_path(&path)),
        BackendKind::Native => CommandSpec::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", &path.to_string_lossy()]),
    };
    let out = backend.run(&spec).await;
    let _ = tokio::fs::remove_file(&path).await;
    out
}

/// Look for ~/.ssh/id_ed25519.pub or id_rsa.pub on the backend and whether github.com is a known host.
pub async fn key_info(backend: Arc<dyn ExecBackend>) -> Result<SshKeyInfo> {
    let out = run_script(&backend, INFO_BASH, INFO_PS).await?;
    Ok(parse_info(&out.stdout))
}

/// Generate ~/.ssh/id_ed25519 (no passphrase, comment "vibecoder") if missing, add github.com to known_hosts, return the public key.
pub async fn generate_key(backend: Arc<dyn ExecBackend>) -> Result<SshKeyInfo> {
    let out = run_script(&backend, GENERATE_BASH, GENERATE_PS).await?;
    if !out.success() {
        return Err(CoreError::msg(format!("SSH 키 생성 실패: {}", if out.stderr.trim().is_empty() { out.stdout.trim() } else { out.stderr.trim() })));
    }
    let info = key_info(backend).await?;
    if !info.present {
        return Err(CoreError::msg("SSH 키를 생성했지만 공개키를 읽지 못했습니다"));
    }
    Ok(info)
}

/// `ssh -T git@github.com` → Ok(username) when the key is registered on GitHub.
pub async fn test_github(backend: Arc<dyn ExecBackend>) -> Result<String> {
    let spec = CommandSpec::new("ssh").args(["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15", "-T", "git@github.com"]);
    let out = backend.run(&spec).await?;
    let text = format!("{}\n{}", out.stdout, out.stderr);
    if let Some(user) = parse_github_user(&text) {
        return Ok(user);
    }
    let detail = text.trim();
    let hint = if detail.contains("Permission denied") {
        "GitHub에 이 키가 등록되어 있지 않습니다. 공개키를 GitHub → Settings → SSH keys에 추가하세요."
    } else if detail.contains("Could not resolve") || detail.contains("timed out") {
        "github.com에 연결할 수 없습니다 (네트워크/방화벽)."
    } else {
        "SSH 연결에 실패했습니다."
    };
    Err(CoreError::msg(format!("{hint}\n{detail}")))
}

pub fn parse_github_user(text: &str) -> Option<String> {
    let re = regex::Regex::new(r"Hi ([^!\s]+)! You've successfully authenticated").ok()?;
    re.captures(text).map(|c| c[1].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_info_output() {
        let i = parse_info("KEYPATH=/home/vibe/.ssh/id_ed25519\nPUBKEY=ssh-ed25519 AAAA vibecoder\nKNOWN=1\n");
        assert!(i.present && i.github_known_host);
        assert_eq!(i.path.as_deref(), Some("/home/vibe/.ssh/id_ed25519"));
        assert!(i.public_key.unwrap().starts_with("ssh-ed25519"));
        let none = parse_info("KNOWN=0\n");
        assert!(!none.present && !none.github_known_host);
    }

    #[test]
    fn parses_github_greeting() {
        assert_eq!(parse_github_user("Hi chelly1221! You've successfully authenticated, but GitHub does not provide shell access."), Some("chelly1221".into()));
        assert_eq!(parse_github_user("git@github.com: Permission denied (publickey)."), None);
    }
}
