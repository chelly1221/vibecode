//! "내보내기": build the project's final program with the stack's recipe (`StackExport` in
//! stacks.toml) and package the artifacts into one portable file — a zip, or the single file
//! itself for stacks that already produce one (exe, apk). Progress streams as `ExportEvent`s.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::mpsc::UnboundedSender;

use super::catalog;
use crate::backend::process;
use crate::context::AppContext;
use crate::error::{CoreError, Result};
use crate::types::{ExportEvent, ExportFormat, StackExport};

struct Reporter(UnboundedSender<ExportEvent>);

impl Reporter {
    fn step(&self, name: &str) {
        let _ = self.0.send(ExportEvent::Step { name: name.into() });
    }
    fn log(&self, line: String, is_err: bool) {
        let _ = self.0.send(ExportEvent::Log { line, is_err });
    }
}

/// Destination file name suggested to the save dialog.
pub fn suggested_file_name(project_name: &str, dir_name: &str, cfg: &StackExport) -> String {
    let base = if dir_name.trim().is_empty() { project_name } else { dir_name };
    let base: String = base.chars().map(|c| if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c }).collect();
    let suffix = if cfg.format == ExportFormat::Zip { "-portable" } else { "" };
    format!("{base}{suffix}.{}", cfg.extension)
}

/// Build (when the recipe has a build command), collect the artifacts and write `dest`.
/// Resolves with the written path (the extension is appended when missing).
pub async fn run(ctx: Arc<AppContext>, project_id: &str, dest: &str, events: UnboundedSender<ExportEvent>) -> Result<String> {
    let rep = Reporter(events);
    match run_inner(ctx, project_id, dest, &rep).await {
        Ok(path) => Ok(path),
        Err(e) => {
            let _ = rep.0.send(ExportEvent::Failed { message: e.to_string() });
            Err(e)
        }
    }
}

async fn run_inner(ctx: Arc<AppContext>, project_id: &str, dest: &str, rep: &Reporter) -> Result<String> {
    let project = ctx.db.get_project(project_id)?;
    let stack = project.stack_id.as_deref().map(catalog::get).transpose()?.flatten();
    let cfg = stack.as_ref().and_then(|s| s.export.clone()).ok_or_else(|| CoreError::msg("이 프로젝트의 스택은 내보내기를 지원하지 않습니다"))?;
    let project_dir = PathBuf::from(&project.path);
    if !project_dir.is_dir() {
        return Err(CoreError::msg(format!("프로젝트 폴더를 찾을 수 없습니다: {}", project.path)));
    }
    let dest = normalise_dest(dest, &cfg.extension)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let dir_name = project_dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| project.name.clone());

    if let Some(cmd) = cfg.build_command.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        let cmd = cmd.replace("{name}", &dir_name);
        rep.step("빌드");
        rep.log(format!("$ {cmd}"), false);
        let backend = crate::accounts::project_backend(&ctx, project_id).await?;
        let spec = backend.shell(&cmd, Some(&project_dir));
        let mut command = backend.command(&spec);
        command.env("CI", "1").env("NO_COLOR", "1").env("FORCE_COLOR", "0").env("npm_config_yes", "true");
        let status = process::stream_lines(&mut command, |line, is_err| rep.log(line, is_err)).await?;
        if !status.success() {
            return Err(CoreError::msg(format!("빌드 명령이 실패했습니다 (exit {:?}). 위 로그를 확인하세요.", status.code())));
        }
    }

    rep.step("결과물 수집");
    let matches = collect_artifacts(&project_dir, &cfg.artifacts)?;
    if matches.is_empty() {
        return Err(CoreError::msg(format!("빌드 결과물을 찾지 못했습니다 (패턴: {})", cfg.artifacts.join(", "))));
    }
    for m in &matches {
        rep.log(format!("+ {}", m.strip_prefix(&project_dir).unwrap_or(m).display()), false);
    }

    rep.step("포장");
    let dest_for_task = dest.clone();
    let format = cfg.format;
    let (files, size) = tokio::task::spawn_blocking(move || match format {
        ExportFormat::Zip => write_zip(&dest_for_task, &matches),
        ExportFormat::File => copy_single(&dest_for_task, &matches),
    })
    .await
    .map_err(|e| CoreError::msg(e.to_string()))??;
    let path = dest.to_string_lossy().into_owned();
    let _ = rep.0.send(ExportEvent::Done { path: path.clone(), size_bytes: size as i64, files: files as i64 });
    Ok(path)
}

fn normalise_dest(dest: &str, extension: &str) -> Result<PathBuf> {
    let trimmed = dest.trim();
    if trimmed.is_empty() {
        return Err(CoreError::msg("저장할 위치를 선택하세요"));
    }
    let mut p = PathBuf::from(trimmed);
    let has_ext = p.extension().map(|e| e.to_string_lossy().eq_ignore_ascii_case(extension)).unwrap_or(false);
    if !has_ext {
        let name = format!("{}.{extension}", p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
        p.set_file_name(name);
    }
    Ok(p)
}

/// Existing files/directories matching the patterns (relative to `root`), de-duplicated, sorted.
pub fn collect_artifacts(root: &Path, patterns: &[String]) -> Result<Vec<PathBuf>> {
    let mut out: Vec<PathBuf> = Vec::new();
    for pat in patterns {
        let full = root.join(pat.replace('/', std::path::MAIN_SEPARATOR_STR));
        let pattern = full.to_string_lossy().into_owned();
        let paths = glob::glob_with(&pattern, glob::MatchOptions { case_sensitive: false, require_literal_separator: true, require_literal_leading_dot: false })
            .map_err(|e| CoreError::msg(format!("잘못된 패턴 {pat}: {e}")))?;
        for entry in paths.flatten() {
            if entry.exists() && !out.iter().any(|p| p == &entry) {
                out.push(entry);
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Package artifacts into `dest`. A single matched directory is flattened (its contents become the
/// zip root, so extracting gives the portable folder directly); otherwise every match keeps its name.
/// Returns (files written, bytes of the zip).
fn write_zip(dest: &Path, matches: &[PathBuf]) -> Result<(usize, u64)> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let file = std::fs::File::create(dest)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(true);
    let mut count = 0usize;
    let mut names: std::collections::HashSet<String> = std::collections::HashSet::new();
    let flatten = matches.len() == 1 && matches[0].is_dir();
    for m in matches {
        if m.is_dir() {
            let base = if flatten { String::new() } else { format!("{}/", file_name(m)) };
            let mut entries = Vec::new();
            walk(m, &mut entries)?;
            for path in entries {
                let rel = path.strip_prefix(m).map_err(|e| CoreError::msg(e.to_string()))?;
                let rel = rel.to_string_lossy().replace('\\', "/");
                let name = format!("{base}{rel}");
                if path.is_dir() {
                    zip.add_directory(format!("{name}/"), opts)?;
                } else {
                    zip.start_file(&name, opts)?;
                    let mut f = std::fs::File::open(&path)?;
                    std::io::copy(&mut f, &mut zip)?;
                    count += 1;
                }
            }
        } else {
            let mut name = file_name(m);
            if !names.insert(name.clone()) {
                // Same file name from two directories: prefix with the parent directory.
                let parent = m.parent().and_then(|p| p.file_name()).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
                name = format!("{parent}/{name}");
            }
            zip.start_file(&name, opts)?;
            let mut f = std::fs::File::open(m)?;
            std::io::copy(&mut f, &mut zip)?;
            count += 1;
        }
    }
    let mut file = zip.finish()?;
    file.flush()?;
    let size = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    Ok((count, size))
}

/// Copy the newest matched file to `dest`.
fn copy_single(dest: &Path, matches: &[PathBuf]) -> Result<(usize, u64)> {
    let files: Vec<&PathBuf> = matches.iter().filter(|p| p.is_file()).collect();
    let newest = files
        .iter()
        .max_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
        .ok_or_else(|| CoreError::msg("복사할 파일이 없습니다"))?;
    let size = std::fs::copy(newest, dest)?;
    Ok((1, size))
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "artifact".into())
}

/// Recursive listing (directories included, symlinks skipped), sorted for stable archives.
fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)?.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        let meta = std::fs::symlink_metadata(&p)?;
        if meta.file_type().is_symlink() {
            continue;
        }
        out.push(p.clone());
        if meta.is_dir() {
            walk(&p, out)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn cfg(format: ExportFormat, ext: &str) -> StackExport {
        StackExport { label: "x".into(), build_command: None, artifacts: vec![], format, extension: ext.into(), note: None }
    }

    #[test]
    fn file_names_and_destinations() {
        assert_eq!(suggested_file_name("내 앱", "my-app", &cfg(ExportFormat::Zip, "zip")), "my-app-portable.zip");
        assert_eq!(suggested_file_name("내:앱", "", &cfg(ExportFormat::File, "apk")), "내_앱.apk");
        assert_eq!(normalise_dest("C:/x/out", "zip").unwrap(), PathBuf::from("C:/x/out.zip"));
        assert_eq!(normalise_dest("C:/x/out.ZIP", "zip").unwrap(), PathBuf::from("C:/x/out.ZIP"));
        assert!(normalise_dest("  ", "zip").is_err());
    }

    #[test]
    fn collects_and_zips_artifacts() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("target/release")).unwrap();
        std::fs::write(root.join("target/release/app.exe"), b"exe").unwrap();
        std::fs::write(root.join("target/release/app.d"), b"dep").unwrap();
        std::fs::create_dir_all(root.join("dist/win-unpacked/resources")).unwrap();
        std::fs::write(root.join("dist/win-unpacked/app.exe"), b"electron").unwrap();
        std::fs::write(root.join("dist/win-unpacked/resources/app.asar"), b"asar").unwrap();

        let files = collect_artifacts(root, &["target/release/*.exe".into(), "target/release/*.exe".into()]).unwrap();
        assert_eq!(files.len(), 1);
        assert!(files[0].ends_with("app.exe"));
        assert!(collect_artifacts(root, &["nothing/*.exe".into()]).unwrap().is_empty());

        // Single directory → flattened to the zip root.
        let dirs = collect_artifacts(root, &["dist/win-unpacked".into()]).unwrap();
        let dest = root.join("out.zip");
        let (count, size) = write_zip(&dest, &dirs).unwrap();
        assert_eq!(count, 2);
        assert!(size > 0);
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&dest).unwrap()).unwrap();
        let mut names: Vec<String> = (0..archive.len()).map(|i| archive.by_index(i).unwrap().name().to_string()).collect();
        names.sort();
        assert_eq!(names, vec!["app.exe", "resources/", "resources/app.asar"]);
        let mut body = String::new();
        archive.by_name("resources/app.asar").unwrap().read_to_string(&mut body).unwrap();
        assert_eq!(body, "asar");

        // Files keep their names; a single-file export copies the newest match.
        let (count, _) = write_zip(&root.join("files.zip"), &files).unwrap();
        assert_eq!(count, 1);
        let (n, size) = copy_single(&root.join("copy.exe"), &files).unwrap();
        assert_eq!((n, size), (1, 3));
        assert_eq!(std::fs::read(root.join("copy.exe")).unwrap(), b"exe");
    }
}
