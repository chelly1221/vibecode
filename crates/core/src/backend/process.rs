//! Child-process lifetime management. On Windows every spawned child is put in
//! a Job Object with KILL_ON_JOB_CLOSE so nothing survives the app.

use tokio::process::{Child, Command};

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
