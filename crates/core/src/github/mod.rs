//! GitHub REST API (token from `secrets::get("github_token")`).

use crate::error::{CoreError, Result};
use crate::types::{GitHubRepo, GitHubUser};

pub const TOKEN_KEY: &str = "github_token";

pub struct GitHubClient {
    pub token: String,
}

impl GitHubClient {
    pub fn from_keyring() -> Result<Option<GitHubClient>> {
        Ok(crate::secrets::get(TOKEN_KEY)?.map(|token| GitHubClient { token }))
    }

    pub async fn whoami(&self) -> Result<GitHubUser> {
        Err(CoreError::NotImplemented("github::whoami"))
    }

    pub async fn create_repo(&self, name: &str, private: bool, description: &str) -> Result<GitHubRepo> {
        let _ = (name, private, description);
        Err(CoreError::NotImplemented("github::create_repo"))
    }
}
