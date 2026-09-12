use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("{0}")]
    Message(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("not implemented: {0}")]
    NotImplemented(&'static str),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("process exited with {code:?}: {stderr}")]
    Process { code: Option<i32>, stderr: String },
    #[error("agent error: {0}")]
    Agent(String),
    #[error("keyring error: {0}")]
    Keyring(String),
}

impl CoreError {
    pub fn msg(s: impl Into<String>) -> Self {
        CoreError::Message(s.into())
    }
}

impl From<zip::result::ZipError> for CoreError {
    fn from(e: zip::result::ZipError) -> Self {
        CoreError::Message(format!("zip error: {e}"))
    }
}

impl From<anyhow::Error> for CoreError {
    fn from(e: anyhow::Error) -> Self {
        CoreError::Message(format!("{e:#}"))
    }
}

impl From<CoreError> for String {
    fn from(e: CoreError) -> Self {
        e.to_string()
    }
}

pub type Result<T> = std::result::Result<T, CoreError>;
