//! GitHub repository operations. Tokens are supplied by the selected named account.

use reqwest::StatusCode;
use serde::Deserialize;

use crate::error::{CoreError, Result};
use crate::types::{GitHubRepo, GitHubUser};

const API: &str = "https://api.github.com";

pub struct GitHubClient {
    pub token: String,
}

#[derive(Deserialize)]
struct UserResp {
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct RepoResp {
    full_name: String,
    html_url: String,
    ssh_url: String,
    clone_url: String,
    private: bool,
}

#[derive(Deserialize)]
struct ErrResp {
    message: Option<String>,
    errors: Option<Vec<serde_json::Value>>,
}

impl GitHubClient {
    fn client(&self) -> Result<reqwest::Client> {
        use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};
        let mut h = HeaderMap::new();
        h.insert(ACCEPT, HeaderValue::from_static("application/vnd.github+json"));
        h.insert("X-GitHub-Api-Version", HeaderValue::from_static("2022-11-28"));
        h.insert(USER_AGENT, HeaderValue::from_static("vibecode"));
        let auth = HeaderValue::from_str(&format!("Bearer {}", self.token.trim()))
            .map_err(|_| CoreError::msg("GitHub 토큰에 사용할 수 없는 문자가 있습니다"))?;
        h.insert(AUTHORIZATION, auth);
        Ok(reqwest::Client::builder().default_headers(h).timeout(std::time::Duration::from_secs(30)).build()?)
    }

    async fn check(resp: reqwest::Response, what: &str) -> Result<reqwest::Response> {
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        let body = resp.text().await.unwrap_or_default();
        let parsed: Option<ErrResp> = serde_json::from_str(&body).ok();
        let detail = parsed
            .as_ref()
            .map(|e| {
                let mut s = e.message.clone().unwrap_or_default();
                if let Some(errs) = &e.errors {
                    for err in errs {
                        if let Some(m) = err.get("message").and_then(|m| m.as_str()) {
                            s.push_str(&format!(" ({m})"));
                        }
                    }
                }
                s
            })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| body.chars().take(200).collect());
        let msg = match status {
            StatusCode::UNAUTHORIZED => format!("GitHub 인증 실패: 토큰이 잘못되었거나 만료되었습니다. {detail}"),
            StatusCode::FORBIDDEN => format!("GitHub 권한 부족: 토큰에 repo 권한이 있는지 확인하세요. {detail}"),
            StatusCode::UNPROCESSABLE_ENTITY => format!("GitHub 요청 거부({what}): 같은 이름의 저장소가 이미 있을 수 있습니다. {detail}"),
            StatusCode::NOT_FOUND => format!("GitHub 리소스를 찾을 수 없습니다({what}). {detail}"),
            _ => format!("GitHub API 오류 {status} ({what}): {detail}"),
        };
        Err(CoreError::msg(msg))
    }

    pub async fn whoami(&self) -> Result<GitHubUser> {
        let resp = self.client()?.get(format!("{API}/user")).send().await?;
        let u: UserResp = Self::check(resp, "user").await?.json().await?;
        Ok(GitHubUser { login: u.login, name: u.name, avatar_url: u.avatar_url })
    }

    pub async fn create_repo(&self, name: &str, private: bool, description: &str) -> Result<GitHubRepo> {
        let body = serde_json::json!({
            "name": name,
            "private": private,
            "description": description,
            "auto_init": false,
        });
        let resp = self.client()?.post(format!("{API}/user/repos")).json(&body).send().await?;
        let r: RepoResp = Self::check(resp, "create repo").await?.json().await?;
        Ok(GitHubRepo { full_name: r.full_name, html_url: r.html_url, ssh_url: r.ssh_url, clone_url: r.clone_url, private: r.private })
    }
}
