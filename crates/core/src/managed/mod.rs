//! App-owned WSL distribution ("Vibecoder"): detect/install WSL, download a
//! verified Ubuntu Base rootfs, import it, and provision the tools inside
//! (git, ripgrep, python, node, Claude Code, Codex). Everything runs from the
//! Windows side through `wsl.exe`; the distro is independent of the user's
//! other distributions and has systemd disabled (no binfmt interference).

use std::path::{Path, PathBuf};
use std::process::Stdio;

use futures::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc::UnboundedSender;

use crate::backend::process::spawn_tracked;
use crate::backend::wsl::list_distros;
use crate::error::{CoreError, Result};
use crate::types::{ProvisionEvent, WslState, WslStatus};

pub const DISTRO: &str = "Vibecoder";
pub const DEFAULT_USER: &str = "vibe";
const UBUNTU_BASE_DIR: &str = "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/";
const CODEX_MUSL_URL: &str = "https://github.com/openai/codex/releases/latest/download/codex-x86_64-unknown-linux-musl.tar.gz";
const MARKER: &str = "provisioned.json";

/// `%LOCALAPPDATA%\Vibecoder` (never the roaming profile: the VHDX lives here).
pub fn base_dir() -> PathBuf {
    dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join("Vibecoder")
}

fn wsl_exe() -> Option<PathBuf> {
    if let Ok(p) = which::which("wsl.exe") {
        return Some(p);
    }
    let sys = PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())).join("System32").join("wsl.exe");
    sys.exists().then_some(sys)
}

/// wsl.exe prints UTF-16LE for its own messages; passthrough of Linux output is UTF-8.
pub fn decode_wsl(bytes: &[u8]) -> String {
    // UTF-8 text never contains NUL bytes; wsl.exe's own UTF-16LE messages always do.
    if bytes.len() >= 2 && bytes.iter().take(64).any(|b| *b == 0) {
        let u16s: Vec<u16> = bytes.chunks(2).map(|c| u16::from_le_bytes([c[0], *c.get(1).unwrap_or(&0)])).collect();
        String::from_utf16_lossy(&u16s).replace('\0', "")
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// First `x.y.z[.w]` in localized `wsl --version` output.
pub fn parse_wsl_version(text: &str) -> Option<String> {
    let re = regex::Regex::new(r"\d+\.\d+\.\d+(?:\.\d+)?").ok()?;
    re.find(text).map(|m| m.as_str().to_string())
}

async fn run_wsl(args: &[&str], timeout_secs: u64) -> Result<(Option<i32>, String)> {
    let exe = wsl_exe().ok_or_else(|| CoreError::msg("wsl.exe not found"))?;
    let mut cmd = Command::new(exe);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = spawn_tracked(&mut cmd)?;
    let out = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), child.wait_with_output())
        .await
        .map_err(|_| CoreError::msg(format!("wsl {} timed out", args.join(" "))))??;
    let mut text = decode_wsl(&out.stdout);
    let err = decode_wsl(&out.stderr);
    if !err.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&err);
    }
    Ok((out.status.code(), text))
}

/// Detect WSL and the managed distribution.
pub async fn wsl_status() -> WslStatus {
    let mut status = WslStatus {
        state: WslState::NotFound,
        version: None,
        distros: vec![],
        managed_distro: DISTRO.to_string(),
        managed_present: false,
        managed_ready: false,
        detail: None,
        windows_build: 0,
        virtualization_enabled: None,
        hypervisor_present: false,
        cpu_vendor: None,
    };
    let prereqs = host_prereqs().await;
    status.windows_build = prereqs.build;
    status.virtualization_enabled = prereqs.virtualization_enabled;
    status.hypervisor_present = prereqs.hypervisor_present;
    status.cpu_vendor = prereqs.cpu_vendor;
    if let Some(fake) = fake_state() {
        return apply_fake_state(status, &fake);
    }
    if wsl_exe().is_none() {
        status.detail = Some("wsl.exe를 찾을 수 없습니다. Windows 10 2004 이상 또는 Windows 11이 필요합니다.".into());
        return status;
    }
    match run_wsl(&["--version"], 20).await {
        Ok((Some(0), text)) => {
            status.state = WslState::Installed;
            status.version = parse_wsl_version(&text);
        }
        _ => match run_wsl(&["--status"], 20).await {
            Ok((Some(0), _)) => status.state = WslState::Installed,
            Ok((_, text)) => {
                status.state = WslState::NotInstalled;
                status.detail = Some(text.trim().to_string());
            }
            Err(e) => {
                status.state = WslState::NotInstalled;
                status.detail = Some(e.to_string());
            }
        },
    }
    if status.state != WslState::Installed {
        return status;
    }
    status.distros = list_distros().await;
    status.managed_present = status.distros.iter().any(|d| d.eq_ignore_ascii_case(DISTRO));
    if status.managed_present && base_dir().join(MARKER).exists() {
        // Cheap health check: the default user must see claude + git.
        if let Ok((Some(0), _)) = run_wsl(&["-d", DISTRO, "--", "bash", "-lc", "command -v claude >/dev/null && command -v git >/dev/null"], 60).await {
            status.managed_ready = true;
        }
    }
    status
}

#[derive(Debug, Default, Clone)]
pub struct HostPrereqs {
    pub build: i64,
    pub virtualization_enabled: Option<bool>,
    pub hypervisor_present: bool,
    pub cpu_vendor: Option<String>,
}

/// Windows build + CPU virtualization state (no elevation needed). A running hypervisor
/// (Hyper-V / Virtual Machine Platform) hides the firmware flag, so it counts as enabled.
pub async fn host_prereqs() -> HostPrereqs {
    let script = "$cs=Get-CimInstance Win32_ComputerSystem; $p=Get-CimInstance Win32_Processor | Select-Object -First 1; [pscustomobject]@{build=[Environment]::OSVersion.Version.Build; hv=[bool]$cs.HypervisorPresent; vfw=$p.VirtualizationFirmwareEnabled; vendor=$p.Manufacturer} | ConvertTo-Json -Compress";
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let Ok(child) = spawn_tracked(&mut cmd) else { return HostPrereqs::default() };
    let Ok(Ok(out)) = tokio::time::timeout(std::time::Duration::from_secs(25), child.wait_with_output()).await else {
        return HostPrereqs::default();
    };
    parse_prereqs(&String::from_utf8_lossy(&out.stdout))
}

pub fn parse_prereqs(json: &str) -> HostPrereqs {
    let v: serde_json::Value = match serde_json::from_str(json.trim()) {
        Ok(v) => v,
        Err(_) => return HostPrereqs::default(),
    };
    let hv = v["hv"].as_bool().unwrap_or(false);
    let vfw = v["vfw"].as_bool();
    HostPrereqs {
        build: v["build"].as_i64().unwrap_or(0),
        virtualization_enabled: if hv { Some(true) } else { vfw },
        hypervisor_present: hv,
        cpu_vendor: v["vendor"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
    }
}

/// Debug builds only: `VIBECODER_FAKE_WSL_STATE=not_found|not_installed|not_installed_novt` previews the UI.
fn fake_state() -> Option<String> {
    if cfg!(debug_assertions) { std::env::var("VIBECODER_FAKE_WSL_STATE").ok().filter(|v| !v.is_empty()) } else { None }
}

fn apply_fake_state(mut status: WslStatus, fake: &str) -> WslStatus {
    match fake {
        "not_found" => status.state = WslState::NotFound,
        "not_installed_novt" => {
            status.state = WslState::NotInstalled;
            status.virtualization_enabled = Some(false);
            status.hypervisor_present = false;
            status.detail = Some("(미리보기) WSL이 설치되어 있지 않습니다".into());
        }
        _ => {
            status.state = WslState::NotInstalled;
            status.detail = Some("(미리보기) WSL이 설치되어 있지 않습니다".into());
        }
    }
    status
}

/// PowerShell script run elevated: enable the Windows features WSL2 needs, then `wsl --install`.
pub fn install_wsl_script() -> &'static str {
    r#"$ErrorActionPreference = 'Continue'
Write-Output '[1/3] Windows 기능 활성화: Virtual Machine Platform'
Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -All -NoRestart | Out-Null
Write-Output '[2/3] Windows 기능 활성화: Windows Subsystem for Linux'
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -All -NoRestart | Out-Null
Write-Output '[3/3] wsl --install --no-distribution'
& wsl.exe --install --no-distribution
$code = $LASTEXITCODE
Write-Output "완료 (wsl exit code: $code). 이 창은 잠시 후 닫힙니다. 재부팅 후 Vibecoder를 다시 실행하세요."
Start-Sleep -Seconds 4
exit $code
"#
}

/// Elevated (UAC) install of WSL: enables the required Windows features itself, then runs
/// `wsl --install --no-distribution`. Returns the exit code; a reboot is required afterwards.
/// BIOS-level virtualization cannot be changed here — see `WslStatus::virtualization_enabled`.
pub async fn install_wsl() -> Result<i32> {
    let script_path = std::env::temp_dir().join("vibecoder-install-wsl.ps1");
    // UTF-8 with BOM so PowerShell 5.1 reads the Korean strings correctly.
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(install_wsl_script().as_bytes());
    tokio::fs::write(&script_path, bytes).await?;
    let launcher = format!(
        "$p = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','{}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode",
        script_path.to_string_lossy().replace('\'', "''")
    );
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &launcher]);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = spawn_tracked(&mut cmd)?;
    let out = child.wait_with_output().await?;
    let code = out.status.code().unwrap_or(-1);
    if code != 0 {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("canceled") || err.contains("취소") {
            return Err(CoreError::msg("관리자 권한 요청이 취소되었습니다"));
        }
    }
    Ok(code)
}

/// Reboot into the advanced startup menu (문제 해결 → 고급 옵션 → UEFI 펌웨어 설정) so the user can
/// enable CPU virtualization in the BIOS. Called only after an explicit confirmation in the UI.
pub async fn reboot_to_firmware() -> Result<()> {
    let mut cmd = Command::new("shutdown.exe");
    cmd.args(["/r", "/o", "/t", "5", "/c", "Vibecoder: UEFI 설정에서 CPU 가상화를 켜기 위해 고급 시작 옵션으로 재부팅합니다"]);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    spawn_tracked(&mut cmd)?.wait().await?;
    Ok(())
}

/// `shutdown /r /t 5` (called only from an explicit user confirmation).
pub async fn reboot() -> Result<()> {
    let mut cmd = Command::new("shutdown.exe");
    cmd.args(["/r", "/t", "5", "/c", "Vibecoder: WSL 설치를 마치기 위해 재부팅합니다"]);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    spawn_tracked(&mut cmd)?.wait().await?;
    Ok(())
}

/// Unregister the managed distro and delete its files.
pub async fn remove() -> Result<()> {
    let (code, text) = run_wsl(&["--unregister", DISTRO], 120).await?;
    if code != Some(0) && !text.contains("WSL_E_DISTRO_NOT_FOUND") {
        return Err(CoreError::msg(format!("wsl --unregister 실패: {}", text.trim())));
    }
    let _ = std::fs::remove_file(base_dir().join(MARKER));
    let _ = std::fs::remove_dir_all(base_dir().join("distro"));
    Ok(())
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

fn send(events: &UnboundedSender<ProvisionEvent>, ev: ProvisionEvent) {
    let _ = events.send(ev);
}
fn log(events: &UnboundedSender<ProvisionEvent>, line: impl Into<String>) {
    send(events, ProvisionEvent::Log { line: line.into(), is_err: false });
}
fn step(events: &UnboundedSender<ProvisionEvent>, name: &str) {
    send(events, ProvisionEvent::Step { name: name.into() });
}

/// Pick the newest `ubuntu-base-24.04.N-base-amd64.tar.gz` from a SHA256SUMS file.
pub fn pick_rootfs(sha256sums: &str) -> Option<(String, String)> {
    let re = regex::Regex::new(r"^([0-9a-f]{64})\s+\*?(ubuntu-base-24\.04(?:\.(\d+))?-base-amd64\.tar\.gz)\s*$").ok()?;
    let mut best: Option<(u32, String, String)> = None;
    for line in sha256sums.lines() {
        if let Some(c) = re.captures(line.trim()) {
            let patch: u32 = c.get(3).map(|m| m.as_str().parse().unwrap_or(0)).unwrap_or(0);
            if best.as_ref().map(|b| patch > b.0).unwrap_or(true) {
                best = Some((patch, c[1].to_string(), c[2].to_string()));
            }
        }
    }
    best.map(|(_, sha, name)| (sha, name))
}

async fn sha256_file(path: &Path) -> Result<String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<String> {
        use std::io::Read;
        let mut f = std::fs::File::open(&path)?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>())
    })
    .await
    .map_err(|e| CoreError::msg(e.to_string()))?
}

async fn download(events: &UnboundedSender<ProvisionEvent>, url: &str, dest: &Path) -> Result<()> {
    let client = reqwest::Client::builder().user_agent("vibecoder").build()?;
    let resp = client.get(url).send().await?.error_for_status()?;
    let total = resp.content_length().map(|v| v as i64);
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&tmp).await?;
    let mut stream = resp.bytes_stream();
    let mut done: i64 = 0;
    let mut last_emit = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        done += chunk.len() as i64;
        if last_emit.elapsed() >= std::time::Duration::from_millis(200) {
            send(events, ProvisionEvent::Progress { bytes: done, total });
            last_emit = std::time::Instant::now();
        }
    }
    file.flush().await?;
    drop(file);
    send(events, ProvisionEvent::Progress { bytes: done, total });
    tokio::fs::rename(&tmp, dest).await?;
    Ok(())
}

/// Bash script executed as root inside the fresh distro.
pub fn provision_script() -> String {
    format!(
        r##"#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export LANG=C.UTF-8
echo "[1/6] apt 패키지 설치"
apt-get update -y -q
apt-get install -y -q --no-install-recommends \
  sudo ca-certificates curl wget gnupg git ripgrep python3 python3-venv python3-pip unzip zip xz-utils \
  less nano openssh-client iproute2 procps build-essential pkg-config libssl-dev locales
echo "LANG=C.UTF-8" > /etc/default/locale
echo "[2/6] 사용자 {user} 생성"
id {user} >/dev/null 2>&1 || useradd -m -s /bin/bash -G sudo {user}
echo '{user} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/{user}
chmod 440 /etc/sudoers.d/{user}
cat > /etc/wsl.conf <<'WSLCONF'
[boot]
systemd=false
[user]
default={user}
[interop]
enabled=true
appendWindowsPath=false
[network]
generateResolvConf=true
WSLCONF
git config --system init.defaultBranch main
# Browser shims: CLI login flows call xdg-open / wslview / $BROWSER → Windows default browser via interop.
cat > /usr/local/bin/wsl-open <<'SH'
#!/bin/sh
exec /mnt/c/Windows/System32/rundll32.exe url.dll,FileProtocolHandler "$1"
SH
chmod +x /usr/local/bin/wsl-open
ln -sf /usr/local/bin/wsl-open /usr/local/bin/xdg-open
ln -sf /usr/local/bin/wsl-open /usr/local/bin/wslview
echo 'export BROWSER=/usr/local/bin/wsl-open' > /etc/profile.d/vibecoder.sh
echo "[3/6] Node.js LTS 설치 (NodeSource)"
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - >/dev/null
apt-get install -y -q nodejs
node --version && npm --version
echo "[4/6] Claude Code 설치"
su - {user} -c 'curl -fsSL https://claude.ai/install.sh | bash' || echo "claude 설치 스크립트 실패 (나중에 다시 시도할 수 있습니다)"
echo "[5/6] Codex 설치"
su - {user} -c 'mkdir -p ~/.local/bin && curl -fsSL {codex_url} | tar -xz -C /tmp && install -m755 /tmp/codex-x86_64-unknown-linux-musl ~/.local/bin/codex && rm -f /tmp/codex-x86_64-unknown-linux-musl' || echo "codex 설치 실패 (나중에 다시 시도할 수 있습니다)"
echo "[6/6] 확인"
su - {user} -c 'export PATH=$HOME/.local/bin:$PATH; echo "claude: $(claude --version 2>/dev/null || echo 없음)"; echo "codex: $(codex --version 2>/dev/null || echo 없음)"; echo "git: $(git --version)"; echo "node: $(node --version)"'
echo "PROVISION_OK"
"##,
        user = DEFAULT_USER,
        codex_url = CODEX_MUSL_URL
    )
}

async fn stream_wsl_command(events: &UnboundedSender<ProvisionEvent>, args: &[&str]) -> Result<bool> {
    let exe = wsl_exe().ok_or_else(|| CoreError::msg("wsl.exe not found"))?;
    let mut cmd = Command::new(exe);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = spawn_tracked(&mut cmd)?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let ev1 = events.clone();
    let ev2 = events.clone();
    let saw_ok = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let saw_ok2 = saw_ok.clone();
    let t1 = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            if l.contains("PROVISION_OK") {
                saw_ok2.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            let _ = ev1.send(ProvisionEvent::Log { line: l, is_err: false });
        }
    });
    let t2 = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            let _ = ev2.send(ProvisionEvent::Log { line: l, is_err: true });
        }
    });
    let status = child.wait().await?;
    let _ = tokio::join!(t1, t2);
    if !status.success() {
        return Err(CoreError::msg(format!("명령이 실패했습니다 (exit {:?})", status.code())));
    }
    Ok(saw_ok.load(std::sync::atomic::Ordering::SeqCst))
}

/// Full provisioning flow. Idempotent: re-running re-installs tools in an existing distro.
pub async fn provision(events: UnboundedSender<ProvisionEvent>) -> Result<()> {
    let result = provision_inner(&events).await;
    match &result {
        Ok(()) => send(&events, ProvisionEvent::Done),
        Err(e) => send(&events, ProvisionEvent::Failed { message: e.to_string() }),
    }
    result
}

async fn provision_inner(events: &UnboundedSender<ProvisionEvent>) -> Result<()> {
    step(events, "WSL 확인");
    let status = wsl_status().await;
    if status.state != WslState::Installed {
        return Err(CoreError::msg("WSL이 설치되어 있지 않습니다. 먼저 WSL을 설치하고 재부팅하세요."));
    }
    log(events, format!("WSL {}", status.version.clone().unwrap_or_else(|| "(버전 미상)".into())));

    let base = base_dir();
    tokio::fs::create_dir_all(base.join("downloads")).await?;

    if !status.managed_present {
        step(events, "Ubuntu rootfs 다운로드");
        let client = reqwest::Client::builder().user_agent("vibecoder").build()?;
        let sums = client.get(format!("{UBUNTU_BASE_DIR}SHA256SUMS")).send().await?.error_for_status()?.text().await?;
        let (sha, name) = pick_rootfs(&sums).ok_or_else(|| CoreError::msg("SHA256SUMS에서 amd64 rootfs를 찾지 못했습니다"))?;
        let dest = base.join("downloads").join(&name);
        let mut need = true;
        if dest.exists() {
            if sha256_file(&dest).await? == sha {
                log(events, format!("캐시된 {name} 사용"));
                need = false;
            } else {
                let _ = tokio::fs::remove_file(&dest).await;
            }
        }
        if need {
            log(events, format!("{name} 내려받는 중"));
            download(events, &format!("{UBUNTU_BASE_DIR}{name}"), &dest).await?;
            let got = sha256_file(&dest).await?;
            if got != sha {
                let _ = tokio::fs::remove_file(&dest).await;
                return Err(CoreError::msg("다운로드한 rootfs의 SHA256이 일치하지 않습니다"));
            }
            log(events, "SHA256 검증 완료");
        }

        step(events, "배포판 임포트");
        let install_dir = base.join("distro");
        tokio::fs::create_dir_all(&install_dir).await?;
        let (code, text) = run_wsl(&["--import", DISTRO, &install_dir.to_string_lossy(), &dest.to_string_lossy(), "--version", "2"], 600).await?;
        if !text.trim().is_empty() {
            log(events, text.trim().to_string());
        }
        if code != Some(0) {
            return Err(CoreError::msg("wsl --import 실패"));
        }
    } else {
        log(events, format!("배포판 {DISTRO}이(가) 이미 있습니다. 도구만 다시 설치합니다."));
    }

    step(events, "기본 설정 및 도구 설치");
    let script_path = std::env::temp_dir().join("vibecoder-provision.sh");
    tokio::fs::write(&script_path, provision_script().replace("\r\n", "\n")).await?;
    let linux_script = crate::backend::paths::windows_to_wsl(&script_path);
    let ok = stream_wsl_command(events, &["-d", DISTRO, "-u", "root", "--", "bash", &linux_script]).await?;
    if !ok {
        return Err(CoreError::msg("프로비저닝 스크립트가 정상 종료 표식을 남기지 않았습니다"));
    }

    step(events, "재시작 및 확인");
    let _ = run_wsl(&["--terminate", DISTRO], 60).await;
    let (code, text) = run_wsl(&["-d", DISTRO, "--", "bash", "-lc", "echo user=$(whoami); command -v claude; command -v codex; command -v git; command -v node"], 120).await?;
    log(events, text.trim().to_string());
    if code != Some(0) {
        return Err(CoreError::msg("설치 확인에 실패했습니다"));
    }
    let marker = serde_json::json!({ "distro": DISTRO, "user": DEFAULT_USER, "provisioned_at": chrono::Utc::now().to_rfc3339() });
    tokio::fs::write(base.join(MARKER), serde_json::to_string_pretty(&marker)?).await?;
    log(events, "완료: Vibecoder 전용 환경이 준비되었습니다.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_newest_amd64_rootfs() {
        let sums = "aaa *ubuntu-base-24.04.3-base-amd64.tar.gz\n\
                    bbb *ubuntu-base-24.04.3-base-arm64.tar.gz\n\
                    c1e67ef7b17a6300e136118bd1dc04725009cb376c1aad10abcf8cd453628d58 *ubuntu-base-24.04.4-base-amd64.tar.gz\n";
        let sums = sums.replace("aaa", &"a".repeat(64)).replace("bbb", &"b".repeat(64));
        let (sha, name) = pick_rootfs(&sums).unwrap();
        assert_eq!(name, "ubuntu-base-24.04.4-base-amd64.tar.gz");
        assert!(sha.starts_with("c1e67ef7"));
        assert!(pick_rootfs("nothing here").is_none());
    }

    #[test]
    fn parses_localized_version_output() {
        assert_eq!(parse_wsl_version("WSL 버전: 2.6.3.0\n커널 버전: 6.6.87.2-1"), Some("2.6.3.0".into()));
        assert_eq!(parse_wsl_version("no version"), None);
    }

    #[test]
    fn decodes_utf16_and_utf8() {
        let s: Vec<u8> = "WSL 버전: 2.6.3.0".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert!(decode_wsl(&s).contains("2.6.3.0"));
        assert_eq!(decode_wsl("plain utf8".as_bytes()), "plain utf8");
    }

    #[test]
    fn parses_prereqs_json() {
        let p = parse_prereqs(r#"{"build":26100,"hv":true,"vfw":false,"vendor":"GenuineIntel"}"#);
        assert_eq!(p.build, 26100);
        assert_eq!(p.virtualization_enabled, Some(true));
        assert!(p.hypervisor_present);
        assert_eq!(p.cpu_vendor.as_deref(), Some("GenuineIntel"));
        let q = parse_prereqs(r#"{"build":19045,"hv":false,"vfw":false,"vendor":"AuthenticAMD"}"#);
        assert_eq!(q.virtualization_enabled, Some(false));
        assert_eq!(parse_prereqs("garbage").build, 0);
    }

    #[test]
    fn install_script_enables_features() {
        let s = install_wsl_script();
        assert!(s.contains("VirtualMachinePlatform"));
        assert!(s.contains("Microsoft-Windows-Subsystem-Linux"));
        assert!(s.contains("wsl.exe --install --no-distribution"));
    }

    #[test]
    fn script_mentions_user_and_marker() {
        let s = provision_script();
        assert!(s.contains("useradd -m -s /bin/bash -G sudo vibe"));
        assert!(s.contains("PROVISION_OK"));
        assert!(s.contains("systemd=false"));
        assert!(s.contains("/usr/local/bin/xdg-open"));
    }
}
