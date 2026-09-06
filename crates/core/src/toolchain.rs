//! Windows toolchain used from WSL. When the agent works inside a WSL distro but the project must
//! produce a Windows program (Tauri/Rust, WPF/.NET, Electron with native Node, ...), the build tools
//! have to be the Windows ones. This module detects them on the host, produces the `winget` script
//! that installs the missing ones, and writes small shims (`~/.local/bin/cargo.exe`, `npm.cmd`, ...)
//! into the distro so `cargo.exe check` or `npm.cmd run tauri dev` work through WSL interop without
//! relying on `appendWindowsPath` (the managed distro disables it).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use futures::future::join_all;
use serde_json::Value;

use crate::backend::process::{self, spawn_tracked};
use crate::backend::{paths, sh_quote, CommandSpec, ExecBackend};
use crate::error::{CoreError, Result};
use crate::types::{BackendKind, StackInfo, TargetOs, WindowsToolStatus};

/// One Windows-side toolchain the catalog can require (`StackInfo::windows_toolchain`).
pub struct WinTool {
    pub name: &'static str,
    pub label: &'static str,
    pub winget_id: &'static str,
    /// Extra `winget install` arguments (Build Tools need the C++ workload).
    pub winget_extra: &'static [&'static str],
    /// Backend-side tool names (see `tools::KNOWN_TOOLS`) this toolchain replaces when building from WSL.
    pub covers: &'static [&'static str],
    /// Shim files written into the distro: (shim name, executable relative to the tool root, extra leading args).
    pub shims: &'static [(&'static str, &'static str, &'static [&'static str])],
}

pub const WIN_TOOLS: &[WinTool] = &[
    WinTool {
        name: "rust",
        label: "Rust (rustup · cargo)",
        winget_id: "Rustlang.Rustup",
        winget_extra: &[],
        covers: &["cargo", "rustup"],
        shims: &[("cargo.exe", "cargo.exe", &[]), ("rustup.exe", "rustup.exe", &[]), ("rustc.exe", "rustc.exe", &[])],
    },
    WinTool {
        name: "msvc",
        label: "Visual Studio Build Tools (C++ 링커, Rust MSVC 타깃에 필요)",
        winget_id: "Microsoft.VisualStudio.2022.BuildTools",
        winget_extra: &["--override", "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"],
        covers: &[],
        shims: &[],
    },
    WinTool {
        name: "node",
        label: "Node.js LTS (node · npm · npx)",
        winget_id: "OpenJS.NodeJS.LTS",
        winget_extra: &[],
        covers: &["node", "npm"],
        shims: &[
            ("node.exe", "node.exe", &[]),
            ("npm.cmd", "node.exe", &["node_modules/npm/bin/npm-cli.js"]),
            ("npx.cmd", "node.exe", &["node_modules/npm/bin/npx-cli.js"]),
        ],
    },
    WinTool {
        name: "dotnet",
        label: ".NET SDK 8",
        winget_id: "Microsoft.DotNet.SDK.8",
        winget_extra: &[],
        covers: &["dotnet"],
        shims: &[("dotnet.exe", "dotnet.exe", &[])],
    },
    WinTool {
        name: "go",
        label: "Go",
        winget_id: "GoLang.Go",
        winget_extra: &[],
        covers: &["go"],
        shims: &[("go.exe", "bin/go.exe", &[])],
    },
];

pub fn get(name: &str) -> Option<&'static WinTool> {
    WIN_TOOLS.iter().find(|t| t.name == name)
}

/// Whether a project needs the Windows toolchain: agent runs in WSL, the stack declares one, and the
/// output targets Windows.
pub fn applies(kind: BackendKind, target: Option<TargetOs>, stack: Option<&StackInfo>) -> bool {
    matches!(kind, BackendKind::Wsl)
        && matches!(target, Some(TargetOs::Windows) | Some(TargetOs::CrossDesktop))
        && stack.map(|s| !s.windows_toolchain.is_empty()).unwrap_or(false)
}

/// Backend-side prerequisites that are *not* replaced by the stack's Windows toolchain
/// (e.g. tauri-react needs Windows cargo, so Linux `cargo` is irrelevant).
pub fn uncovered_prerequisites<'a>(stack: &'a StackInfo) -> Vec<&'a str> {
    stack
        .prerequisites
        .iter()
        .map(String::as_str)
        .filter(|p| !stack.windows_toolchain.iter().filter_map(|n| get(n)).any(|t| t.covers.contains(p)))
        .collect()
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

/// Well-known install roots per tool (the app's own PATH is stale right after a winget install, so
/// PATH lookup alone is not enough).
fn candidate_roots(name: &str) -> Vec<PathBuf> {
    let mut v = Vec::new();
    match name {
        "rust" => {
            if let Some(h) = env_dir("USERPROFILE") {
                v.push(h.join(".cargo").join("bin"));
            }
            if let Some(h) = env_dir("CARGO_HOME") {
                v.push(h.join("bin"));
            }
        }
        "node" => {
            for var in ["ProgramFiles", "ProgramFiles(x86)"] {
                if let Some(p) = env_dir(var) {
                    v.push(p.join("nodejs"));
                }
            }
            if let Some(l) = env_dir("LOCALAPPDATA") {
                v.push(l.join("Programs").join("nodejs"));
            }
        }
        "dotnet" => {
            for var in ["ProgramFiles", "ProgramFiles(x86)"] {
                if let Some(p) = env_dir(var) {
                    v.push(p.join("dotnet"));
                }
            }
            if let Some(l) = env_dir("LOCALAPPDATA") {
                v.push(l.join("Microsoft").join("dotnet"));
            }
        }
        "go" => {
            for var in ["ProgramFiles", "ProgramFiles(x86)"] {
                if let Some(p) = env_dir(var) {
                    v.push(p.join("Go"));
                }
            }
        }
        _ => {}
    }
    v
}

/// Main executable used for the version probe, relative to the root.
fn main_exe(name: &str) -> &'static str {
    match name {
        "rust" => "cargo.exe",
        "node" => "node.exe",
        "dotnet" => "dotnet.exe",
        "go" => "bin/go.exe",
        _ => "",
    }
}

async fn run_capture(program: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = spawn_tracked(&mut cmd).ok()?;
    let out = tokio::time::timeout(timeout, child.wait_with_output()).await.ok()?.ok()?;
    let text = if out.stdout.is_empty() { out.stderr } else { out.stdout };
    Some(String::from_utf8_lossy(&text).trim().to_string())
}

/// Locate the tool root: PATH first (`which`), then the well-known roots.
fn find_root(name: &str) -> Option<PathBuf> {
    let exe = main_exe(name);
    if exe.is_empty() {
        return None;
    }
    let exe_name = Path::new(exe).file_name()?.to_string_lossy().to_string();
    if let Ok(p) = which::which(&exe_name) {
        // root = path minus the relative exe part
        let depth = Path::new(exe).components().count();
        let mut root = p.clone();
        for _ in 0..depth {
            root = root.parent()?.to_path_buf();
        }
        return Some(root);
    }
    candidate_roots(name).into_iter().find(|r| r.join(exe).is_file())
}

fn vswhere() -> Option<PathBuf> {
    let p = env_dir("ProgramFiles(x86)").or_else(|| env_dir("ProgramFiles"))?.join("Microsoft Visual Studio").join("Installer").join("vswhere.exe");
    p.is_file().then_some(p)
}

/// Detect one Windows toolchain on the host.
pub async fn detect_one(tool: &WinTool) -> WindowsToolStatus {
    let mut st = WindowsToolStatus {
        name: tool.name.to_string(),
        label: tool.label.to_string(),
        found: false,
        path: None,
        version: None,
        winget_id: tool.winget_id.to_string(),
        shims: tool.shims.iter().map(|(n, _, _)| n.to_string()).collect(),
    };
    if !cfg!(windows) {
        return st;
    }
    if tool.name == "msvc" {
        let Some(vsw) = vswhere() else { return st };
        let args = ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-format", "json", "-utf8"];
        if let Some(out) = run_capture(&vsw, &args, Duration::from_secs(15)).await {
            if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&out) {
                if let Some(first) = items.first() {
                    st.found = true;
                    st.path = first.get("installationPath").and_then(Value::as_str).map(String::from);
                    st.version = first.get("installationVersion").and_then(Value::as_str).map(String::from);
                }
            }
        }
        return st;
    }
    let Some(root) = find_root(tool.name) else { return st };
    let exe = root.join(main_exe(tool.name));
    st.found = true;
    st.path = Some(exe.to_string_lossy().into_owned());
    let args: &[&str] = if tool.name == "go" { &["version"] } else { &["--version"] };
    st.version = run_capture(&exe, args, Duration::from_secs(10)).await.and_then(|t| t.lines().map(str::trim).find(|l| !l.is_empty()).map(String::from));
    st
}

/// Detect the given toolchains (all known ones when `names` is empty), concurrently.
pub async fn detect(names: &[String]) -> Vec<WindowsToolStatus> {
    let tools: Vec<&WinTool> = if names.is_empty() { WIN_TOOLS.iter().collect() } else { names.iter().filter_map(|n| get(n)).collect() };
    join_all(tools.into_iter().map(detect_one)).await
}

const WINGET_CHECK: &str = "if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Write-Host 'winget을 찾을 수 없습니다. Microsoft Store에서 \"앱 설치 관리자\"를 업데이트하세요.' -ForegroundColor Red; exit 9009 }\n";

/// `winget install …` line for one toolchain (what the user sees / can paste into a terminal).
pub fn winget_command(t: &WinTool) -> String {
    let mut s = format!("winget install -e --id {} --accept-source-agreements --accept-package-agreements --disable-interactivity", t.winget_id);
    for a in t.winget_extra {
        s.push(' ');
        s.push_str(&ps_quote(a));
    }
    s
}

/// PowerShell lines installing one toolchain (Build Tools fall back to adding the C++ workload).
fn install_lines(t: &WinTool) -> String {
    let mut s = winget_command(t);
    s.push('\n');
    if t.name == "msvc" {
        s.push_str("if ($LASTEXITCODE -ne 0) { Write-Host 'Build Tools가 이미 있으면 C++ 워크로드만 추가합니다.' ; & \"${env:ProgramFiles(x86)}\\Microsoft Visual Studio\\Installer\\setup.exe\" modify --productId Microsoft.VisualStudio.Product.BuildTools --channelId VisualStudio.17.Release --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --quiet --wait --norestart }\n");
    }
    s
}

/// PowerShell script (run on the host, elevated by winget itself when needed) installing `names`.
pub fn install_script(names: &[String]) -> String {
    let mut s = String::from("$ErrorActionPreference = 'Continue'\n");
    s.push_str(WINGET_CHECK);
    let tools: Vec<&WinTool> = names.iter().filter_map(|n| get(n)).collect();
    let total = tools.len();
    for (i, t) in tools.iter().enumerate() {
        s.push_str(&format!("Write-Host '[{}/{}] {} 설치 (winget {})' -ForegroundColor Cyan\n", i + 1, total, t.label, t.winget_id));
        s.push_str(&install_lines(t));
    }
    s.push_str("Write-Host ''\nWrite-Host '설치가 끝났습니다. 프로젝트를 만들 때 WSL 연결(shim)이 자동으로 갱신됩니다.' -ForegroundColor Green\n");
    s
}

/// Install one toolchain on the host with winget, streaming its output. Resolves with the exit code
/// (winget may pop a UAC prompt for machine-wide installers; cancelling it makes winget fail).
pub async fn install_one(tool: &WinTool, on_line: impl FnMut(String, bool)) -> Result<Option<i32>> {
    if !cfg!(windows) {
        return Err(CoreError::msg("Windows 툴체인 설치는 Windows 호스트에서만 가능합니다"));
    }
    // UTF-8 both ways so winget's and our Korean messages survive the pipe.
    let mut script = String::from("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8\n$ErrorActionPreference = 'Continue'\n");
    script.push_str(WINGET_CHECK);
    script.push_str(&install_lines(tool));
    script.push_str("exit $LASTEXITCODE\n");
    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script]);
    let status = process::stream_lines(&mut cmd, on_line).await?;
    Ok(status.code())
}

/// Exit codes after which the package is installed (0, or the Windows Installer "reboot required" code).
pub fn install_exit_ok(code: Option<i32>) -> bool {
    matches!(code, Some(0) | Some(3010))
}

fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Bash script that (re)writes `~/.local/bin` shims for the toolchains that were found.
pub fn shim_script(found: &[WindowsToolStatus]) -> String {
    let mut s = String::from("set -e\nmkdir -p \"$HOME/.local/bin\"\n");
    let mut names = Vec::new();
    for st in found.iter().filter(|s| s.found) {
        let Some(tool) = get(&st.name) else { continue };
        let Some(exe) = st.path.as_deref() else { continue };
        let exe_path = Path::new(exe);
        // tool root = exe path minus its relative part (bin/go.exe → two levels)
        let depth = Path::new(main_exe(tool.name)).components().count();
        let mut root = exe_path.to_path_buf();
        for _ in 0..depth {
            root = root.parent().map(Path::to_path_buf).unwrap_or(root);
        }
        let root_str = root.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
        for (shim, rel_exe, extra) in tool.shims {
            // The program itself is resolved by WSL interop from a Linux path; its *arguments* are passed
            // verbatim to the Windows process, so file arguments must stay Windows paths.
            let target = paths::windows_to_wsl(&root.join(rel_exe));
            let mut line = format!("exec {}", sh_quote(&target));
            for a in extra.iter() {
                line.push(' ');
                line.push_str(&sh_quote(&format!("{root_str}\\{}", a.replace('/', "\\"))));
            }
            line.push_str(" \"$@\"");
            s.push_str(&format!(
                "cat > \"$HOME/.local/bin/{shim}\" <<'VIBECODE_SHIM'\n#!/bin/sh\n# Vibecoder shim: Windows toolchain via WSL interop ({label})\n{line}\nVIBECODE_SHIM\nchmod +x \"$HOME/.local/bin/{shim}\"\n",
                label = tool.label,
            ));
            names.push(shim.to_string());
        }
    }
    s.push_str(&format!("echo 'VIBECODE_SHIMS_OK {}'\n", names.join(" ")));
    s
}

/// Write shims into the WSL distro for every found toolchain. Returns the shim names.
pub async fn write_shims(backend: Arc<dyn ExecBackend>, found: &[WindowsToolStatus]) -> Result<Vec<String>> {
    if backend.kind() != BackendKind::Wsl {
        return Err(CoreError::msg("shim은 WSL 실행 환경에서만 필요합니다"));
    }
    // Run from a file: passing the script as an argument through `wsl.exe -- bash -lc` re-parses it in
    // the shell, which expands `"$@"` and `$HOME` before the heredoc is written.
    let script_path = std::env::temp_dir().join(format!("vibecoder-shims-{}.sh", uuid::Uuid::new_v4()));
    tokio::fs::write(&script_path, shim_script(found).replace("\r\n", "\n")).await?;
    let spec = CommandSpec::new("bash").arg(backend.to_backend_path(&script_path));
    let run = backend.run(&spec).await;
    let _ = tokio::fs::remove_file(&script_path).await;
    let out = run?.into_result()?;
    let names = out
        .stdout
        .lines()
        .find_map(|l| l.trim().strip_prefix("VIBECODE_SHIMS_OK").map(|rest| rest.split_whitespace().map(String::from).collect::<Vec<_>>()))
        .unwrap_or_default();
    Ok(names)
}

/// Rewrite a backend shell command so its leading program uses the Windows shim
/// (`npm run dev` → `npm.cmd run dev`, `cargo test` → `cargo.exe test`). Other text is untouched.
pub fn rewrite_command(cmd: &str) -> String {
    let trimmed = cmd.trim_start();
    let lead = cmd.len() - trimmed.len();
    let (first, rest) = match trimmed.find(char::is_whitespace) {
        Some(i) => (&trimmed[..i], &trimmed[i..]),
        None => (trimmed, ""),
    };
    match shim_for(first) {
        Some(shim) => format!("{}{}{}", &cmd[..lead], shim, rest),
        None => cmd.to_string(),
    }
}

/// Shim name for a plain program name (`npm` → `npm.cmd`).
pub fn shim_for(program: &str) -> Option<&'static str> {
    Some(match program {
        "npm" => "npm.cmd",
        "npx" => "npx.cmd",
        "node" => "node.exe",
        "cargo" => "cargo.exe",
        "rustup" => "rustup.exe",
        "rustc" => "rustc.exe",
        "dotnet" => "dotnet.exe",
        "go" => "go.exe",
        _ => return None,
    })
}

/// Rewrite commands inside backticks in markdown notes (`npm run tauri dev` → `npm.cmd run tauri dev`).
pub fn rewrite_notes(notes: &str) -> String {
    let mut out = String::with_capacity(notes.len() + 32);
    let mut rest = notes;
    while let Some(start) = rest.find('`') {
        out.push_str(&rest[..=start]);
        let after = &rest[start + 1..];
        match after.find('`') {
            Some(end) => {
                out.push_str(&rewrite_command(&after[..end]));
                out.push('`');
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(after);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// AGENTS.md section explaining the WSL → Windows toolchain rule for this project.
pub fn agent_docs_section(statuses: &[WindowsToolStatus]) -> String {
    let mut a = String::from("## Windows 툴체인 (WSL에서 개발, 결과물은 Windows 프로그램)\n");
    a.push_str("- 에이전트는 WSL(리눅스) 안에서 작업하지만 이 프로젝트의 결과물은 Windows용이다. 패키지 설치·빌드·실행·테스트는 반드시 Windows 툴체인 명령(`.exe` / `.cmd`)으로 한다.\n");
    a.push_str("- 리눅스용 `cargo`, `npm`, `dotnet`을 쓰면 리눅스 바이너리가 나오거나 네이티브 모듈(esbuild 등)이 어긋난다. 위 \"빌드 · 실행 · 테스트\"의 명령은 이미 Windows 명령으로 바꿔 두었다.\n");
    let shims: Vec<String> = statuses.iter().filter(|s| s.found).flat_map(|s| s.shims.iter().map(|n| format!("`{n}`"))).collect();
    if !shims.is_empty() {
        a.push_str(&format!("- 사용 가능한 명령(`~/.local/bin`의 shim → Windows 실행 파일): {}\n", shims.join(", ")));
    }
    for s in statuses.iter().filter(|s| s.found) {
        if let Some(p) = &s.path {
            a.push_str(&format!("- {}: `{}`{}\n", s.label, p, s.version.as_deref().map(|v| format!(" ({v})")).unwrap_or_default()));
        }
    }
    let missing: Vec<&WindowsToolStatus> = statuses.iter().filter(|s| !s.found).collect();
    if !missing.is_empty() {
        a.push_str("- 아직 설치되지 않은 항목(사용자가 Windows PowerShell에서 설치해야 함; 설치 전에는 해당 빌드가 실패한다):\n");
        for m in missing {
            a.push_str(&format!("  - {}: `winget install -e --id {}`\n", m.label, m.winget_id));
        }
    }
    a.push_str("- 프로젝트 폴더는 Windows 드라이브(`/mnt/c/...`)에 있어야 Windows 실행 파일이 경로를 인식한다.\n");
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(name: &str, path: &str) -> WindowsToolStatus {
        let t = get(name).unwrap();
        WindowsToolStatus {
            name: name.into(),
            label: t.label.into(),
            found: true,
            path: Some(path.into()),
            version: Some("1.0".into()),
            winget_id: t.winget_id.into(),
            shims: t.shims.iter().map(|(n, _, _)| n.to_string()).collect(),
        }
    }

    #[test]
    fn rewrites_leading_program_only() {
        assert_eq!(rewrite_command("npm run dev"), "npm.cmd run dev");
        assert_eq!(rewrite_command("  cargo test"), "  cargo.exe test");
        assert_eq!(rewrite_command("dotnet"), "dotnet.exe");
        assert_eq!(rewrite_command("flutter run"), "flutter run");
        assert_eq!(rewrite_command("python -m npm"), "python -m npm");
    }

    #[test]
    fn rewrites_backticked_notes() {
        let notes = "- 개발 실행: `npm run tauri dev`\n- 검사: `cargo check` / `cargo test` (src-tauri)\n- `npx tsc --noEmit`";
        let out = rewrite_notes(notes);
        assert!(out.contains("`npm.cmd run tauri dev`"));
        assert!(out.contains("`cargo.exe check` / `cargo.exe test`"));
        assert!(out.contains("`npx.cmd tsc --noEmit`"));
        assert_eq!(rewrite_notes("no ticks"), "no ticks");
        assert_eq!(rewrite_notes("odd `tick"), "odd `tick");
    }

    #[test]
    fn shim_script_points_at_windows_paths() {
        let found = vec![status("rust", "C:\\Users\\me\\.cargo\\bin\\cargo.exe"), status("node", "C:\\Program Files\\nodejs\\node.exe")];
        let s = shim_script(&found);
        assert!(s.contains("$HOME/.local/bin/cargo.exe"));
        assert!(s.contains("exec /mnt/c/Users/me/.cargo/bin/cargo.exe \"$@\""));
        assert!(s.contains("exec '/mnt/c/Program Files/nodejs/node.exe' 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js' \"$@\""));
        assert!(s.contains("VIBECODE_SHIMS_OK cargo.exe rustup.exe rustc.exe node.exe npm.cmd npx.cmd"));
        // go's exe lives one level down (bin/go.exe): root must be computed from that
        let g = shim_script(&[status("go", "C:\\Program Files\\Go\\bin\\go.exe")]);
        assert!(g.contains("exec '/mnt/c/Program Files/Go/bin/go.exe' \"$@\""));
    }

    #[test]
    fn install_script_lists_tools() {
        let s = install_script(&["rust".into(), "msvc".into(), "nope".into()]);
        assert!(s.contains("winget install -e --id Rustlang.Rustup"));
        assert!(s.contains("Microsoft.VisualStudio.2022.BuildTools"));
        assert!(s.contains("Microsoft.VisualStudio.Workload.VCTools"));
        assert!(s.contains("[2/2]"));
        let one = winget_command(get("msvc").unwrap());
        assert!(one.starts_with("winget install -e --id Microsoft.VisualStudio.2022.BuildTools"));
        assert!(one.contains("'--override'"));
        assert!(install_exit_ok(Some(0)) && install_exit_ok(Some(3010)) && !install_exit_ok(Some(1)) && !install_exit_ok(None));
    }

    #[test]
    fn applies_only_for_wsl_windows_targets() {
        let tauri = crate::projects::catalog::get("tauri-react").unwrap().unwrap();
        assert!(applies(BackendKind::Wsl, Some(TargetOs::Windows), Some(&tauri)));
        assert!(applies(BackendKind::Wsl, Some(TargetOs::CrossDesktop), Some(&tauri)));
        assert!(!applies(BackendKind::Native, Some(TargetOs::Windows), Some(&tauri)));
        assert!(!applies(BackendKind::Wsl, Some(TargetOs::Web), Some(&tauri)));
        let next = crate::projects::catalog::get("nextjs").unwrap().unwrap();
        assert!(!applies(BackendKind::Wsl, Some(TargetOs::Windows), Some(&next)));
        // Linux cargo/rustup are replaced by the Windows toolchain; node/npm too
        assert!(uncovered_prerequisites(&tauri).is_empty());
        let wpf = crate::projects::catalog::get("dotnet-wpf").unwrap().unwrap();
        assert!(uncovered_prerequisites(&wpf).is_empty());
    }

    #[test]
    fn docs_section_mentions_shims_and_missing() {
        let mut msvc = status("msvc", "C:\\BuildTools");
        msvc.found = false;
        let s = agent_docs_section(&[status("rust", "C:\\Users\\me\\.cargo\\bin\\cargo.exe"), msvc]);
        assert!(s.contains("`cargo.exe`"));
        assert!(s.contains("winget install -e --id Microsoft.VisualStudio.2022.BuildTools"));
    }
}
