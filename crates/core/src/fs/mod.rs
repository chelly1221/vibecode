//! Read-only project file access for the explorer/viewer. Paths are host paths (the app runs on
//! Windows and the project lives on the Windows filesystem), so std::fs is used directly.

use std::path::{Component, Path, PathBuf};

use chrono::{DateTime, Utc};

use crate::error::{CoreError, Result};
use crate::types::{FsEntry, FsFile};

pub const MAX_FILE_BYTES: u64 = 1_000_000;
pub const IGNORED_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", ".venv", "venv", "__pycache__", ".next", ".svelte-kit", "out", "bin", "obj",
    ".dart_tool", ".gradle", ".idea",
];

/// Reject `..`, absolute paths and drive letters; returns the joined absolute path.
pub fn resolve(root: &Path, rel_path: &str) -> Result<PathBuf> {
    let rel = rel_path.trim().trim_start_matches(['/', '\\']);
    if rel.contains(':') {
        return Err(CoreError::msg("잘못된 경로입니다"));
    }
    let mut out = root.to_path_buf();
    for comp in Path::new(&rel.replace('\\', "/")).components() {
        match comp {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            _ => return Err(CoreError::msg("잘못된 경로입니다")),
        }
    }
    Ok(out)
}

/// Top-level entries of the project's root `.gitignore` (first path segment matching only).
fn root_ignore_patterns(root: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(root.join(".gitignore")) else { return vec![] };
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with('!'))
        .map(|l| l.trim_start_matches('/').trim_end_matches('/').to_string())
        .filter(|l| !l.is_empty() && !l.contains('/'))
        .collect()
}

fn glob_match(pattern: &str, name: &str) -> bool {
    if !pattern.contains('*') && !pattern.contains('?') {
        return pattern.eq_ignore_ascii_case(name);
    }
    let mut re = String::from("^");
    for ch in pattern.chars() {
        match ch {
            '*' => re.push_str(".*"),
            '?' => re.push('.'),
            c => re.push_str(&regex::escape(&c.to_string())),
        }
    }
    re.push('$');
    regex::RegexBuilder::new(&re).case_insensitive(true).build().map(|r| r.is_match(name)).unwrap_or(false)
}

pub fn is_ignored(name: &str, patterns: &[String]) -> bool {
    IGNORED_DIRS.iter().any(|d| d.eq_ignore_ascii_case(name)) || patterns.iter().any(|p| glob_match(p, name))
}

/// Entries of `root/rel_path` (dirs first, then files, case-insensitive). `rel_path` "" = root.
pub fn list_dir(root: &Path, rel_path: &str) -> Result<Vec<FsEntry>> {
    let dir = resolve(root, rel_path)?;
    if !dir.is_dir() {
        return Err(CoreError::NotFound(format!("폴더가 없습니다: {rel_path}")));
    }
    let patterns = root_ignore_patterns(root);
    let prefix = rel_path.trim().trim_matches(['/', '\\']).replace('\\', "/");
    let mut entries = Vec::new();
    for e in std::fs::read_dir(&dir)? {
        let e = e?;
        let name = e.file_name().to_string_lossy().into_owned();
        let meta = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        let modified = meta.modified().ok().map(DateTime::<Utc>::from);
        let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        entries.push(FsEntry {
            ignored: is_ignored(&name, &patterns),
            name,
            rel_path: rel,
            is_dir,
            size: if is_dir { 0 } else { meta.len() as i64 },
            modified,
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

fn looks_binary(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(8192)];
    if head.contains(&0) {
        return true;
    }
    match std::str::from_utf8(head) {
        Ok(_) => false,
        Err(e) => {
            // A truncated multibyte sequence at the end is fine; real garbage is not.
            let valid = e.valid_up_to();
            (head.len() - valid) as f64 / head.len().max(1) as f64 > 0.05
        }
    }
}

/// Read a text file (UTF-8 lossy), capped at MAX_FILE_BYTES; binary files return `binary: true` with empty content.
pub fn read_file(root: &Path, rel_path: &str) -> Result<FsFile> {
    use std::io::Read;
    let path = resolve(root, rel_path)?;
    let meta = std::fs::metadata(&path).map_err(|_| CoreError::NotFound(format!("파일이 없습니다: {rel_path}")))?;
    if !meta.is_file() {
        return Err(CoreError::msg("파일이 아닙니다"));
    }
    let size = meta.len();
    let mut f = std::fs::File::open(&path)?;
    let mut buf = Vec::with_capacity(size.min(MAX_FILE_BYTES + 1) as usize);
    f.by_ref().take(MAX_FILE_BYTES + 1).read_to_end(&mut buf)?;
    let truncated = buf.len() as u64 > MAX_FILE_BYTES;
    if truncated {
        buf.truncate(MAX_FILE_BYTES as usize);
    }
    let rel = rel_path.trim().trim_matches(['/', '\\']).replace('\\', "/");
    if looks_binary(&buf) {
        return Ok(FsFile { rel_path: rel, content: String::new(), size: size as i64, truncated: false, binary: true });
    }
    Ok(FsFile { rel_path: rel, content: String::from_utf8_lossy(&buf).into_owned(), size: size as i64, truncated, binary: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_rejects_escapes() {
        let root = Path::new("C:\\proj");
        assert!(resolve(root, "../x").is_err());
        assert!(resolve(root, "a/../../x").is_err());
        assert!(resolve(root, "C:\\Windows").is_err());
        assert!(resolve(root, "/etc").is_ok()); // leading slash is stripped, stays inside root
        assert_eq!(resolve(root, "src/main.rs").unwrap(), root.join("src").join("main.rs"));
    }

    #[test]
    fn lists_and_reads() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::create_dir_all(root.join("Coverage")).unwrap();
        std::fs::write(root.join(".gitignore"), "/coverage\n*.tmp\n# comment\n").unwrap();
        std::fs::write(root.join("b.txt"), "hello").unwrap();
        std::fs::write(root.join("A.tmp"), "x").unwrap();
        std::fs::write(root.join("src").join("main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(root.join("bin.dat"), [0u8, 159, 146, 150]).unwrap();

        let entries = list_dir(root, "").unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Coverage", "node_modules", "src", ".gitignore", "A.tmp", "b.txt", "bin.dat"]);
        assert!(entries.iter().find(|e| e.name == "node_modules").unwrap().ignored);
        assert!(entries.iter().find(|e| e.name == "Coverage").unwrap().ignored);
        assert!(entries.iter().find(|e| e.name == "A.tmp").unwrap().ignored);
        assert!(!entries.iter().find(|e| e.name == "src").unwrap().ignored);

        let sub = list_dir(root, "src").unwrap();
        assert_eq!(sub[0].rel_path, "src/main.rs");
        assert_eq!(sub[0].size, 13);

        let f = read_file(root, "src\\main.rs").unwrap();
        assert_eq!(f.content, "fn main() {}\n");
        assert_eq!(f.rel_path, "src/main.rs");
        assert!(!f.binary && !f.truncated);
        let b = read_file(root, "bin.dat").unwrap();
        assert!(b.binary && b.content.is_empty());
        assert!(read_file(root, "missing.txt").is_err());
        assert!(read_file(root, "src").is_err());
    }
}
