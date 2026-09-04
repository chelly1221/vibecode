//! Stack catalog loaded from `resources/stacks.toml` (embedded at compile time).

use std::sync::OnceLock;

use serde::Deserialize;

use crate::error::{CoreError, Result};
use crate::types::{ProjectType, StackInfo, TargetOs};

pub const STACKS_TOML: &str = include_str!("../../resources/stacks.toml");

#[derive(Deserialize)]
struct Catalog {
    stack: Vec<StackInfo>,
}

fn parse(toml_text: &str) -> Result<Vec<StackInfo>> {
    let cat: Catalog = toml::from_str(toml_text).map_err(|e| CoreError::msg(format!("stacks.toml parse error: {e}")))?;
    Ok(cat.stack)
}

fn all() -> Result<&'static Vec<StackInfo>> {
    static CACHE: OnceLock<std::result::Result<Vec<StackInfo>, String>> = OnceLock::new();
    match CACHE.get_or_init(|| parse(STACKS_TOML).map_err(|e| e.to_string())) {
        Ok(v) => Ok(v),
        Err(e) => Err(CoreError::msg(e.clone())),
    }
}

pub fn load() -> Result<Vec<StackInfo>> {
    Ok(all()?.clone())
}

/// Stacks matching (target, type), recommended ones first, then by name.
/// Falls back to type-only matches when nothing matches both.
pub fn recommend(target: TargetOs, project_type: ProjectType) -> Result<Vec<StackInfo>> {
    let stacks = all()?;
    let mut hits: Vec<StackInfo> =
        stacks.iter().filter(|s| s.targets.contains(&target) && s.types.contains(&project_type)).cloned().collect();
    if hits.is_empty() {
        hits = stacks.iter().filter(|s| s.types.contains(&project_type)).cloned().collect();
    }
    hits.sort_by(|a, b| b.recommended.cmp(&a.recommended).then_with(|| a.name.cmp(&b.name)));
    Ok(hits)
}

pub fn get(id: &str) -> Result<Option<StackInfo>> {
    Ok(all()?.iter().find(|s| s.id == id).cloned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn catalog_parses_and_is_sane() {
        let stacks = load().expect("parse");
        assert!(stacks.len() >= 20, "expected ~20 stacks, got {}", stacks.len());
        let mut ids = HashSet::new();
        for s in &stacks {
            assert!(ids.insert(s.id.clone()), "duplicate id {}", s.id);
            assert!(!s.targets.is_empty(), "{} has no targets", s.id);
            assert!(!s.types.is_empty(), "{} has no types", s.id);
            assert!(!s.summary.is_empty() && !s.name.is_empty(), "{} missing text", s.id);
            assert!(s.agent_notes.as_deref().map(|n| !n.trim().is_empty()).unwrap_or(false), "{} missing agent_notes", s.id);
            if let Some(cmd) = &s.scaffold_cmd {
                assert!(cmd.contains("{name}"), "{} scaffold_cmd lacks {{name}}", s.id);
                for op in ["&&", "||", " | ", ">", "<"] {
                    assert!(!cmd.contains(op), "{} scaffold_cmd uses shell operator {op}", s.id);
                }
            }
        }
    }

    #[test]
    fn windows_desktop_recommends_tauri_first() {
        let r = recommend(TargetOs::Windows, ProjectType::DesktopApp).unwrap();
        assert!(!r.is_empty());
        assert_eq!(r[0].id, "tauri-react");
        assert!(r[0].recommended);
    }

    #[test]
    fn every_type_has_a_recommendation_for_some_target() {
        use ProjectType::*;
        for t in [DesktopApp, WebApp, MobileApp, Cli, ApiServer, Library, Game, Script] {
            let r = recommend(TargetOs::Windows, t).unwrap();
            assert!(!r.is_empty(), "no stacks for {t:?}");
        }
    }

    #[test]
    fn get_by_id() {
        assert_eq!(get("fastapi").unwrap().unwrap().languages, vec!["Python"]);
        assert!(get("nope").unwrap().is_none());
    }
}
