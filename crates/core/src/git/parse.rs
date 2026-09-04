//! Parsers for git's machine-readable output.

use crate::types::{GitBranch, GitCommit, GitFileStatus, GitStatus};

/// Undo C-style quoting git applies to unusual paths (`"a\303\251.txt"`).
fn unquote(s: &str) -> String {
    if s.len() < 2 || !s.starts_with('"') || !s.ends_with('"') {
        return s.to_string();
    }
    let inner = &s[1..s.len() - 1];
    let mut bytes: Vec<u8> = Vec::with_capacity(inner.len());
    let mut chars = inner.bytes().peekable();
    while let Some(b) = chars.next() {
        if b != b'\\' {
            bytes.push(b);
            continue;
        }
        match chars.next() {
            Some(b'n') => bytes.push(b'\n'),
            Some(b't') => bytes.push(b'\t'),
            Some(b'\\') => bytes.push(b'\\'),
            Some(b'"') => bytes.push(b'"'),
            Some(d) if d.is_ascii_digit() => {
                let mut v = (d - b'0') as u32;
                for _ in 0..2 {
                    match chars.peek() {
                        Some(n) if n.is_ascii_digit() => {
                            v = v * 8 + (*n - b'0') as u32;
                            chars.next();
                        }
                        _ => break,
                    }
                }
                bytes.push(v as u8);
            }
            Some(other) => {
                bytes.push(b'\\');
                bytes.push(other);
            }
            None => bytes.push(b'\\'),
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Parse `git status --porcelain=v2 --branch` output.
pub fn porcelain_v2(text: &str) -> GitStatus {
    let mut st = GitStatus { is_repo: true, branch: None, upstream: None, ahead: 0, behind: 0, files: vec![] };
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# ") {
            if let Some(v) = rest.strip_prefix("branch.head ") {
                st.branch = Some(v.trim().to_string()).filter(|b| b != "(detached)");
            } else if let Some(v) = rest.strip_prefix("branch.upstream ") {
                st.upstream = Some(v.trim().to_string());
            } else if let Some(v) = rest.strip_prefix("branch.ab ") {
                for tok in v.split_whitespace() {
                    if let Some(a) = tok.strip_prefix('+') {
                        st.ahead = a.parse().unwrap_or(0);
                    } else if let Some(b) = tok.strip_prefix('-') {
                        st.behind = b.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        let mut parts = line.splitn(2, ' ');
        let kind = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");
        match kind {
            "1" => {
                // <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
                let fields: Vec<&str> = rest.splitn(8, ' ').collect();
                if fields.len() == 8 {
                    st.files.push(file_status(fields[0], unquote(fields[7]), false));
                }
            }
            "2" => {
                // <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
                let fields: Vec<&str> = rest.splitn(9, ' ').collect();
                if fields.len() == 9 {
                    let path = fields[8].split('\t').next().unwrap_or(fields[8]);
                    st.files.push(file_status(fields[0], unquote(path), false));
                }
            }
            "u" => {
                // <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
                let fields: Vec<&str> = rest.splitn(10, ' ').collect();
                if fields.len() == 10 {
                    let mut f = file_status(fields[0], unquote(fields[9]), false);
                    f.staged = false;
                    f.unstaged = true;
                    st.files.push(f);
                }
            }
            "?" => st.files.push(GitFileStatus { path: unquote(rest), code: "??".into(), staged: false, unstaged: false, untracked: true }),
            _ => {}
        }
    }
    st
}

fn file_status(xy: &str, path: String, untracked: bool) -> GitFileStatus {
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    let code = format!("{}{}", if x == '.' { ' ' } else { x }, if y == '.' { ' ' } else { y });
    GitFileStatus { path, code, staged: x != '.', unstaged: y != '.', untracked }
}

/// Parse `git branch -a --format=%(refname:short)%09%(HEAD)%09%(refname)`.
pub fn branches(text: &str) -> Vec<GitBranch> {
    text.lines()
        .filter_map(|l| {
            let mut f = l.split('\t');
            let short = f.next()?.trim();
            let head = f.next().unwrap_or("").trim();
            let full = f.next().unwrap_or("");
            if short.is_empty() || short.ends_with("/HEAD") {
                return None;
            }
            Some(GitBranch { name: short.to_string(), current: head == "*", remote: full.starts_with("refs/remotes/") })
        })
        .collect()
}

/// Parse `git log --pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s`.
pub fn log(text: &str) -> Vec<GitCommit> {
    text.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\u{1f}').collect();
            if f.len() < 5 {
                return None;
            }
            Some(GitCommit {
                hash: f[0].to_string(),
                short_hash: f[1].to_string(),
                author: f[2].to_string(),
                date: f[3].to_string(),
                subject: f[4..].join("\u{1f}"),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATUS: &str = "# branch.oid 1234\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 abc def src/lib.rs\n1 A. N... 000000 100644 100644 000 def new.txt\n1 MM N... 100644 100644 100644 a b both.rs\n2 R. N... 100644 100644 100644 a b R100 new/name.rs\told/name.rs\nu UU N... 100644 100644 100644 100644 a b c conflict.rs\n? untracked.md\n? \"sp\\303\\244ce.txt\"\n";

    #[test]
    fn parses_porcelain_v2() {
        let s = porcelain_v2(STATUS);
        assert!(s.is_repo);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (2, 1));
        assert_eq!(s.files.len(), 7);
        let lib = &s.files[0];
        assert_eq!((lib.path.as_str(), lib.code.as_str(), lib.staged, lib.unstaged), ("src/lib.rs", " M", false, true));
        let new = &s.files[1];
        assert_eq!((new.code.as_str(), new.staged, new.unstaged), ("A ", true, false));
        assert_eq!((s.files[2].staged, s.files[2].unstaged), (true, true));
        assert_eq!((s.files[3].path.as_str(), s.files[3].code.as_str()), ("new/name.rs", "R "));
        assert_eq!((s.files[4].path.as_str(), s.files[4].unstaged), ("conflict.rs", true));
        assert!(s.files[5].untracked);
        assert_eq!(s.files[6].path, "späce.txt");
    }

    #[test]
    fn detached_head_and_no_upstream() {
        let s = porcelain_v2("# branch.oid abc\n# branch.head (detached)\n");
        assert_eq!(s.branch, None);
        assert_eq!(s.upstream, None);
        assert!(s.files.is_empty());
    }

    #[test]
    fn parses_branches() {
        let b = branches("main\t*\trefs/heads/main\nfeature\t \trefs/heads/feature\norigin/main\t \trefs/remotes/origin/main\norigin/HEAD\t \trefs/remotes/origin/HEAD\n");
        assert_eq!(b.len(), 3);
        assert!(b[0].current && !b[0].remote);
        assert!(!b[1].current);
        assert!(b[2].remote && b[2].name == "origin/main");
    }

    #[test]
    fn parses_log() {
        let l = log("abcdef1234\u{1f}abcdef1\u{1f}3chan\u{1f}2026-09-04\u{1f}feat: hello\u{1f}world\n");
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].short_hash, "abcdef1");
        assert_eq!(l[0].author, "3chan");
        assert_eq!(l[0].subject, "feat: hello\u{1f}world");
    }

    #[test]
    fn unquotes() {
        assert_eq!(unquote("plain.txt"), "plain.txt");
        assert_eq!(unquote("\"a b\\t\\\"q\\\".txt\""), "a b\t\"q\".txt");
    }
}
