//! Child-process lifetime management. On Windows every spawned child is put in
//! a Job Object with KILL_ON_JOB_CLOSE so nothing survives the app.

use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use crate::error::Result;

/// Spawn with kill-on-drop and (Windows) job-object tracking.
pub fn spawn_tracked(cmd: &mut Command) -> Result<Child> {
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd.spawn()?;
    #[cfg(windows)]
    windows_job::assign(&child);
    Ok(child)
}

/// Spawn `cmd` with piped stdout/stderr and hand every output line to `on_line(line, is_stderr)` as
/// it arrives. Resolves with the exit status once the process has ended and its pipes are drained;
/// grandchildren that keep the pipes open only delay the return by a short grace period.
pub async fn stream_lines(cmd: &mut Command, mut on_line: impl FnMut(String, bool)) -> Result<ExitStatus> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = spawn_tracked(cmd)?;
    let (tx, mut rx) = mpsc::unbounded_channel::<(String, bool)>();
    if let Some(out) = child.stdout.take() {
        tokio::spawn(forward_lines(out, tx.clone(), false));
    }
    if let Some(err) = child.stderr.take() {
        tokio::spawn(forward_lines(err, tx.clone(), true));
    }
    drop(tx);
    let mut wait = std::pin::pin!(child.wait());
    let status = loop {
        tokio::select! {
            line = rx.recv() => match line {
                Some((l, e)) => on_line(l, e),
                None => break wait.await?,
            },
            st = &mut wait => break st?,
        }
    };
    while let Ok(Some((l, e))) = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
        on_line(l, e);
    }
    Ok(status)
}

async fn forward_lines<R: AsyncRead + Unpin>(reader: R, tx: mpsc::UnboundedSender<(String, bool)>, is_err: bool) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(l)) = lines.next_line().await {
        // Progress spinners rewrite the same line with `\r`; keep only its final state.
        let last = l.rsplit('\r').find(|seg| !seg.trim().is_empty()).unwrap_or("").to_string();
        if last.is_empty() {
            continue;
        }
        if tx.send((last, is_err)).is_err() {
            break;
        }
    }
}

#[cfg(windows)]
mod windows_job {
    use std::sync::OnceLock;
    use tokio::process::Child;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    struct Job(HANDLE);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    fn job() -> Option<HANDLE> {
        JOB.get_or_init(|| unsafe {
            let h = CreateJobObjectW(None, None).ok()?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok.is_err() {
                tracing::warn!("SetInformationJobObject failed; child processes will not be job-tracked");
                return None;
            }
            Some(Job(h))
        })
        .as_ref()
        .map(|j| j.0)
    }

    pub fn assign(child: &Child) {
        if let (Some(job), Some(raw)) = (job(), child.raw_handle()) {
            unsafe {
                if let Err(e) = AssignProcessToJobObject(job, HANDLE(raw as _)) {
                    tracing::debug!("AssignProcessToJobObject failed: {e}");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn streams_stdout_and_stderr_lines_with_exit_code() {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("powershell.exe");
            c.args(["-NoProfile", "-NonInteractive", "-Command", "Write-Output 'one'; [Console]::Error.WriteLine('two'); Write-Output \"a`rb`rthree\"; exit 3"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "echo one; echo two >&2; printf 'a\\rb\\rthree\\n'; exit 3"]);
            c
        };
        let mut lines = Vec::new();
        let status = stream_lines(&mut cmd, |l, e| lines.push((l, e))).await.unwrap();
        assert_eq!(status.code(), Some(3));
        assert!(lines.contains(&("one".to_string(), false)), "{lines:?}");
        assert!(lines.contains(&("two".to_string(), true)), "{lines:?}");
        assert!(lines.contains(&("three".to_string(), false)), "{lines:?}");
        assert!(!lines.iter().any(|(l, _)| l == "a" || l == "b"), "{lines:?}");
    }
}
