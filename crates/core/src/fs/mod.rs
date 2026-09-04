//! Read-only project file access for the explorer/viewer. Paths are host paths (the app runs on
//! Windows and the project lives on the Windows filesystem), so std::fs is used directly.

use std::path::Path;

use crate::error::{CoreError, Result};
use crate::types::{FsEntry, FsFile};

pub const MAX_FILE_BYTES: u64 = 1_000_000;
pub const IGNORED_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", "build", ".venv", "venv", "__pycache__", ".next", ".svelte-kit", "out", "bin", "obj", ".dart_tool"];

/// Entries of `root/rel_path` (dirs first, then files, case-insensitive). `rel_path` "" = root.
pub fn list_dir(root: &Path, rel_path: &str) -> Result<Vec<FsEntry>> {
    let _ = (root, rel_path);
    Err(CoreError::NotImplemented("fs::list_dir"))
}

/// Read a text file (UTF-8 lossy), capped at MAX_FILE_BYTES; binary files return `binary: true` with empty content.
pub fn read_file(root: &Path, rel_path: &str) -> Result<FsFile> {
    let _ = (root, rel_path);
    Err(CoreError::NotImplemented("fs::read_file"))
}

/// Reject `..`, absolute paths and drive letters; returns the joined absolute path.
pub fn resolve(root: &Path, rel_path: &str) -> Result<std::path::PathBuf> {
    let _ = (root, rel_path);
    Err(CoreError::NotImplemented("fs::resolve"))
}
