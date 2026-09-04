use std::sync::Arc;

use vibecode_core::AppContext;

pub struct AppState {
    pub ctx: Arc<AppContext>,
}

impl AppState {
    pub fn new(ctx: Arc<AppContext>) -> Self {
        AppState { ctx }
    }
}

/// Convert core errors to the string form the frontend receives.
pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
