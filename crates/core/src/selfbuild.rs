//! "새 빌드 적용": rebuild this app from its source checkout and restart on the new exe, without
//! leaving the app (the source is edited by an agent; the user applies the result with one click).
//!
//! Installed app (the usual case): the build runs in the repo *while the app keeps running*
//! (`target\release\Vibecoder.exe` is a different file from the running one). Once it succeeds a
//! detached PowerShell "swap" script gets the running pid, the built exe and the running exe path;
//! the app exits; the script waits for the pid to end, copies the new exe over the old one and
//! starts it. Nothing is lost when the build fails: the running app is untouched.
//!
//! Running straight from `target\release` (the build output itself): the linker could not overwrite
//! a running exe, so the script does everything after the app exits — build, then start.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::mpsc::UnboundedSender;

use crate::backend::process;
use crate::context::AppContext;
use crate::error::{CoreError, Result};
use crate::types::{ExportEvent, SelfBuildInfo};

/// Frontend + Rust release build, no installer (`beforeBuildCommand` runs `npm run build`). Uses the
/// project's own @tauri-apps/cli through npx: no `--` separator, which Windows PowerShell 5.1 would
/// strip before npm sees it, and no bundling step whose updater signing fails without a key.
pub const BUILD_COMMAND: &str = "npx tauri build --no-bundle";
const DEFAULT_REPO: &str = r"C:\code\vibecode";

/// A checkout of this app: `src-tauri/tauri.conf.json` naming the Vibecoder product.
pub fn is_app_repo(dir: &Path) -> bool {
    std::fs::read_to_string(dir.join("src-tauri").join("tauri.conf.json")).map(|c| c.contains("\"productName\"") && c.contains("Vibecoder")).unwrap_or(false)
}

/// Source checkout: the configured path, else a registered project that is this app, else the dev-machine default.
pub fn detect_repo(ctx: &AppContext, configured: Option<&str>) -> Option<PathBuf> {
    if let Some(c) = configured.map(str::trim).filter(|c| !c.is_empty()) {
        let p = PathBuf::from(c);
        if is_app_repo(&p) {
            return Some(p);
        }
    }
    for p in ctx.db.list_projects().unwrap_or_default() {
        let dir = PathBuf::from(&p.path);
        if is_app_repo(&dir) {
            return Some(dir);
        }
    }
    let d = PathBuf::from(DEFAULT_REPO);
    if is_app_repo(&d) { Some(d) } else { None }
}

/// Name of the release binary (`mainBinaryName`, else `productName`, else "Vibecoder").
pub fn binary_name(repo: &Path) -> String {
    let conf = std::fs::read_to_string(repo.join("src-tauri").join("tauri.conf.json")).unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&conf).unwrap_or(serde_json::Value::Null);
    v.get("mainBinaryName").or_else(|| v.get("productName")).and_then(|s| s.as_str()).map(String::from).unwrap_or_else(|| "Vibecoder".into())
}

pub fn build_output(repo: &Path) -> PathBuf {
    repo.join("target").join("release").join(format!("{}.exe", binary_name(repo)))
}

fn same_file(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase();
    norm(a) == norm(b)
}

pub async fn info(ctx: &AppContext) -> SelfBuildInfo {
    let configured = ctx.settings().await.dev_repo_path;
    let repo = detect_repo(ctx, configured.as_deref());
    let current_exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let build_output = repo.as_deref().map(build_output);
    let in_place = match (&repo, &build_output) {
        (Some(r), Some(out)) => {
            let cur = PathBuf::from(&current_exe);
            same_file(&cur, out) || cur.starts_with(r.join("target"))
        }
        _ => false,
    };
    SelfBuildInfo {
        repo: repo.map(|p| p.to_string_lossy().into_owned()),
        current_exe,
        build_output: build_output.map(|p| p.to_string_lossy().into_owned()),
        in_place,
        build_command: BUILD_COMMAND.into(),
    }
}

/// Run the release build in `repo`, streaming its output. Resolves with the built exe path once
/// the file exists and is newer than the build start.
pub async fn build(ctx: Arc<AppContext>, repo: &Path, events: UnboundedSender<ExportEvent>) -> Result<String> {
    let res = build_inner(ctx, repo, &events).await;
    let _ = match &res {
        Ok(path) => events.send(ExportEvent::Done { path: path.clone(), size_bytes: std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0), files: 1 }),
        Err(e) => events.send(ExportEvent::Failed { message: e.to_string() }),
    };
    res
}

async fn build_inner(ctx: Arc<AppContext>, repo: &Path, events: &UnboundedSender<ExportEvent>) -> Result<String> {
    let send = |e: ExportEvent| { let _ = events.send(e); };
    if !is_app_repo(repo) {
        return Err(CoreError::msg(format!("이 폴더는 Vibecoder 소스가 아닙니다: {}", repo.display())));
    }
    let out = build_output(repo);
    let started = std::time::SystemTime::now();
    send(ExportEvent::Step { name: "빌드".into() });
    send(ExportEvent::Log { line: format!("$ {BUILD_COMMAND}  ({})", repo.display()), is_err: false });
    let backend = ctx.backend().await;
    let spec = backend.shell(BUILD_COMMAND, Some(repo));
    let mut cmd = backend.command(&spec);
    // Release builds are not incremental; CARGO_INCREMENTAL=0 also sidesteps the MSVC/LLVM symbol issue seen on this machine.
    cmd.env("CI", "1").env("NO_COLOR", "1").env("FORCE_COLOR", "0").env("CARGO_INCREMENTAL", "0");
    let status = process::stream_lines(&mut cmd, |line, is_err| send(ExportEvent::Log { line, is_err })).await?;
    if !status.success() {
        return Err(CoreError::msg(format!("빌드가 실패했습니다 (exit {:?}). 위 로그를 확인하세요.", status.code())));
    }
    let fresh = std::fs::metadata(&out).and_then(|m| m.modified()).map(|t| t >= started).unwrap_or(false);
    if !fresh {
        return Err(CoreError::msg(format!("빌드는 끝났지만 새 실행 파일이 보이지 않습니다: {}", out.display())));
    }
    Ok(out.to_string_lossy().into_owned())
}

/// Hand over to the detached swap script and return its log path. The caller exits the app afterwards.
/// `built` = the fresh exe (swap mode); None = build after exit (in-place mode).
pub fn spawn_swap(repo: &Path, current_exe: &Path, built: Option<&Path>) -> Result<PathBuf> {
    let dir = std::env::temp_dir().join("vibecoder-apply");
    std::fs::create_dir_all(&dir)?;
    let log = dir.join("apply.log");
    let script = dir.join("apply.ps1");
    let pid = std::process::id();
    let body = match built {
        Some(src) => swap_script(pid, src, current_exe, &log),
        None => rebuild_script(pid, repo, current_exe, &log),
    };
    std::fs::write(&script, body)?;
    let _ = std::fs::write(&log, format!("== {} apply started (pid {pid})\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S")));
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);
    // Visible console while a build runs after exit; hidden for the quick copy-and-start.
    cmd.args(["-WindowStyle", if built.is_some() { "Hidden" } else { "Normal" }]);
    cmd.arg("-File").arg(&script);
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | if built.is_some() { CREATE_NO_WINDOW } else { CREATE_NEW_CONSOLE });
    }
    // Plain spawn on purpose: not in the app's job object, so it outlives the app.
    cmd.spawn().map_err(|e| CoreError::msg(format!("적용 스크립트를 시작하지 못했습니다: {e}")))?;
    Ok(log)
}

fn ps_quote(p: &Path) -> String {
    format!("'{}'", p.to_string_lossy().replace('\'', "''"))
}

/// Wait for the app to exit, copy the built exe over the running one (retrying while Windows still
/// holds the old file), then start it. Starts the old exe anyway if the copy never succeeds.
pub fn swap_script(pid: u32, src: &Path, dst: &Path, log: &Path) -> String {
    format!(
        r#"$ErrorActionPreference = 'Continue'
$log = {log}
function Log($m) {{ Add-Content -LiteralPath $log -Value ("[{{0}}] {{1}}" -f (Get-Date -Format 'HH:mm:ss'), $m) }}
Log "waiting for pid {pid}"
try {{ Wait-Process -Id {pid} -Timeout 180 -ErrorAction SilentlyContinue }} catch {{}}
Start-Sleep -Milliseconds 800
$src = {src}
$dst = {dst}
$copied = $false
for ($i = 0; $i -lt 60; $i++) {{
  try {{ Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop; $copied = $true; break }}
  catch {{ Log ("copy retry " + $i + ": " + $_.Exception.Message); Start-Sleep -Seconds 1 }}
}}
Log ("copied=" + $copied)
Start-Process -FilePath $dst -WorkingDirectory (Split-Path -LiteralPath $dst -Parent)
Log "started"
"#,
        log = ps_quote(log),
        src = ps_quote(src),
        dst = ps_quote(dst),
    )
}

/// Running from the build output: wait for exit, build in a visible console, then start the exe.
pub fn rebuild_script(pid: u32, repo: &Path, exe: &Path, log: &Path) -> String {
    format!(
        r#"$ErrorActionPreference = 'Continue'
$log = {log}
function Log($m) {{ Add-Content -LiteralPath $log -Value ("[{{0}}] {{1}}" -f (Get-Date -Format 'HH:mm:ss'), $m) }}
Write-Host "Vibecoder를 종료한 뒤 다시 빌드합니다..."
try {{ Wait-Process -Id {pid} -Timeout 180 -ErrorAction SilentlyContinue }} catch {{}}
Start-Sleep -Milliseconds 800
Set-Location -LiteralPath {repo}
$env:CARGO_INCREMENTAL = '0'
Log "building"
& cmd.exe /d /c "{build}" 2>&1 | Tee-Object -FilePath $log -Append
if ($LASTEXITCODE -ne 0) {{ Write-Host "빌드 실패 (exit $LASTEXITCODE). 이 창을 닫으면 이전 버전으로 시작합니다."; Read-Host | Out-Null }}
Start-Process -FilePath {exe} -WorkingDirectory (Split-Path -LiteralPath {exe} -Parent)
Log "started"
"#,
        log = ps_quote(log),
        repo = ps_quote(repo),
        build = BUILD_COMMAND,
        exe = ps_quote(exe),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_quote_paths_and_reference_pid() {
        let s = swap_script(4242, Path::new(r"C:\code\vibecode\target\release\Vibecoder.exe"), Path::new(r"C:\Users\o'neil\AppData\Local\Vibecoder\Vibecoder.exe"), Path::new(r"C:\tmp\apply.log"));
        assert!(s.contains("Wait-Process -Id 4242"));
        assert!(s.contains(r"'C:\Users\o''neil\AppData\Local\Vibecoder\Vibecoder.exe'"));
        assert!(s.contains("Copy-Item -LiteralPath $src -Destination $dst -Force"));
        assert!(s.contains("Start-Process -FilePath $dst"));
        let r = rebuild_script(7, Path::new(r"C:\code\vibecode"), Path::new(r"C:\code\vibecode\target\release\Vibecoder.exe"), Path::new(r"C:\tmp\apply.log"));
        assert!(r.contains(BUILD_COMMAND));
        assert!(r.contains("Set-Location -LiteralPath 'C:\\code\\vibecode'"));
    }

    #[test]
    fn repo_detection_reads_tauri_conf() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!is_app_repo(tmp.path()));
        std::fs::create_dir_all(tmp.path().join("src-tauri")).unwrap();
        std::fs::write(tmp.path().join("src-tauri/tauri.conf.json"), r#"{ "productName": "Vibecoder", "mainBinaryName": "Vibecoder" }"#).unwrap();
        assert!(is_app_repo(tmp.path()));
        assert_eq!(binary_name(tmp.path()), "Vibecoder");
        assert!(build_output(tmp.path()).ends_with(Path::new("target").join("release").join("Vibecoder.exe")));
        assert!(same_file(Path::new(r"C:\A\b.exe"), Path::new("c:/a/B.EXE")));
    }
}
