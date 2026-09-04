//! Host (Windows) <-> WSL path translation.

use std::path::{Path, PathBuf};

/// `C:\code\x` -> `/mnt/c/code/x`; `\\wsl.localhost\Ubuntu\home\u` -> `/home/u`;
/// already-POSIX paths are returned unchanged.
pub fn windows_to_wsl(host: &Path) -> String {
    let s = host.to_string_lossy().replace('/', "\\");
    if let Some(rest) = s.strip_prefix("\\\\wsl.localhost\\").or_else(|| s.strip_prefix("\\\\wsl$\\")) {
        // strip distro segment
        let mut parts = rest.splitn(2, '\\');
        let _distro = parts.next();
        let tail = parts.next().unwrap_or("");
        return format!("/{}", tail.replace('\\', "/"));
    }
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let tail = s[2..].trim_start_matches('\\').replace('\\', "/");
        if tail.is_empty() {
            return format!("/mnt/{drive}");
        }
        return format!("/mnt/{drive}/{tail}");
    }
    // Probably already a POSIX path (or relative); normalise separators.
    host.to_string_lossy().replace('\\', "/")
}

/// `/mnt/c/code/x` -> `C:\code\x`; other absolute POSIX paths -> `\\wsl.localhost\<distro>\...`.
pub fn wsl_to_windows(backend: &str, distro: &str) -> PathBuf {
    let b = backend.as_bytes();
    if backend.starts_with("/mnt/") && b.len() >= 6 && b[5].is_ascii_alphabetic() && (b.len() == 6 || b[6] == b'/') {
        let drive = (b[5] as char).to_ascii_uppercase();
        let tail = if b.len() > 7 { &backend[7..] } else { "" };
        let tail = tail.replace('/', "\\");
        return PathBuf::from(if tail.is_empty() { format!("{drive}:\\") } else { format!("{drive}:\\{tail}") });
    }
    if backend.starts_with('/') {
        return PathBuf::from(format!("\\\\wsl.localhost\\{}{}", distro, backend.replace('/', "\\")));
    }
    PathBuf::from(backend)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn win_to_wsl_drive() {
        assert_eq!(windows_to_wsl(Path::new("C:\\code\\vibecode")), "/mnt/c/code/vibecode");
        assert_eq!(windows_to_wsl(Path::new("D:/x/y")), "/mnt/d/x/y");
        assert_eq!(windows_to_wsl(Path::new("C:\\")), "/mnt/c");
    }

    #[test]
    fn win_to_wsl_unc() {
        assert_eq!(windows_to_wsl(Path::new("\\\\wsl.localhost\\Ubuntu\\home\\me")), "/home/me");
        assert_eq!(windows_to_wsl(Path::new("\\\\wsl$\\Ubuntu\\home\\me\\p")), "/home/me/p");
    }

    #[test]
    fn posix_passthrough() {
        assert_eq!(windows_to_wsl(Path::new("/home/me")), "/home/me");
    }

    #[test]
    fn wsl_to_win() {
        assert_eq!(wsl_to_windows("/mnt/c/code/x", "Ubuntu"), PathBuf::from("C:\\code\\x"));
        assert_eq!(wsl_to_windows("/mnt/c", "Ubuntu"), PathBuf::from("C:\\"));
        assert_eq!(wsl_to_windows("/home/me", "Ubuntu"), PathBuf::from("\\\\wsl.localhost\\Ubuntu\\home\\me"));
    }
}
