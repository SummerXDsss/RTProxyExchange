//! Update checking against the project's GitHub releases / tags.
//!
//! Queries the GitHub REST API server-side (so the browser avoids CORS and
//! per-client rate limits), compares the latest tag with the running version,
//! and exposes the version history. Results are cached briefly to stay well
//! within GitHub's unauthenticated rate limit (60 req/h per IP).

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};

/// GitHub owner/repo this build reports updates for.
pub const GITHUB_OWNER: &str = "SummerXDsss";
pub const GITHUB_REPO: &str = "RTProxyExchange";

/// One release entry in the version history.
#[derive(Debug, Clone, Serialize)]
pub struct ReleaseInfo {
    /// Tag name, e.g. "v0.1.0".
    pub tag: String,
    /// Normalized semver string, e.g. "0.1.0" (tag minus leading 'v').
    pub version: String,
    /// Release display name (may equal the tag).
    pub name: Option<String>,
    /// Release notes / changelog body (markdown).
    pub body: Option<String>,
    /// ISO-8601 publish time.
    pub published_at: Option<String>,
    /// Whether GitHub marked this a prerelease.
    pub prerelease: bool,
    /// URL to the release page.
    pub html_url: Option<String>,
}

/// Result of an update check.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateStatus {
    /// The version this binary was built as.
    pub current_version: String,
    /// Latest stable version available, if any release exists.
    pub latest_version: Option<String>,
    /// True when `latest_version` is strictly newer than `current_version`.
    pub update_available: bool,
    /// Latest release details (for one-click "view release").
    pub latest_release: Option<ReleaseInfo>,
    /// Full version history (newest first).
    pub history: Vec<ReleaseInfo>,
    /// Set when the check could not reach GitHub (history may be empty).
    pub error: Option<String>,
}

/// Raw GitHub release shape (subset).
#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    html_url: Option<String>,
}

/// Raw GitHub tag shape (fallback when no releases exist).
#[derive(Debug, Deserialize)]
struct GhTag {
    name: String,
}

/// Normalize a tag like "v1.2.3" into a semver-parseable "1.2.3".
fn normalize(tag: &str) -> &str {
    tag.strip_prefix('v').unwrap_or(tag)
}

/// Compare two version strings via semver; falls back to string compare when
/// either side is not valid semver.
fn is_newer(candidate: &str, current: &str) -> bool {
    match (
        semver::Version::parse(normalize(candidate)),
        semver::Version::parse(normalize(current)),
    ) {
        (Ok(a), Ok(b)) => a > b,
        _ => normalize(candidate) > normalize(current),
    }
}

/// Checks for updates against GitHub.
#[derive(Clone)]
pub struct UpdateChecker {
    client: reqwest::Client,
    current_version: String,
    owner: String,
    repo: String,
}

impl UpdateChecker {
    /// Build a checker for the given running version.
    pub fn new(current_version: impl Into<String>) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(6))
            .user_agent(format!("{GITHUB_REPO}/{}", env!("CARGO_PKG_VERSION")))
            // GitHub's CDN is dual-stack; force IPv4 to avoid IPv6 stalls.
            .local_address(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED))
            .build()
            .map_err(|e| CoreError::Network(format!("client build: {e}")))?;
        Ok(Self {
            client,
            current_version: current_version.into(),
            owner: GITHUB_OWNER.to_string(),
            repo: GITHUB_REPO.to_string(),
        })
    }

    /// Perform the update check. Network failures are reported in
    /// `UpdateStatus::error` rather than returned as a hard error, so the UI can
    /// still show the current version.
    pub async fn check(&self) -> UpdateStatus {
        match self.fetch_history().await {
            Ok(history) => {
                let latest = history.iter().find(|r| !r.prerelease).or(history.first());
                let latest_version = latest.map(|r| r.version.clone());
                let update_available = latest_version
                    .as_deref()
                    .map(|v| is_newer(v, &self.current_version))
                    .unwrap_or(false);
                UpdateStatus {
                    current_version: self.current_version.clone(),
                    latest_version,
                    update_available,
                    latest_release: latest.cloned(),
                    history,
                    error: None,
                }
            }
            Err(e) => UpdateStatus {
                current_version: self.current_version.clone(),
                latest_version: None,
                update_available: false,
                latest_release: None,
                history: Vec::new(),
                error: Some(e.to_string()),
            },
        }
    }

    /// Fetch release history, falling back to tags if there are no releases.
    async fn fetch_history(&self) -> Result<Vec<ReleaseInfo>> {
        let releases = self.fetch_releases().await?;
        if !releases.is_empty() {
            return Ok(releases);
        }
        self.fetch_tags().await
    }

    /// Fetch published releases (newest first).
    async fn fetch_releases(&self) -> Result<Vec<ReleaseInfo>> {
        let url = format!(
            "https://api.github.com/repos/{}/{}/releases?per_page=30",
            self.owner, self.repo
        );
        let resp = self
            .client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| CoreError::Network(e.to_string()))?;

        if !resp.status().is_success() {
            return Err(CoreError::OAuthServer {
                status: resp.status().as_u16(),
                body: "github releases request failed".to_string(),
            });
        }

        let releases: Vec<GhRelease> = resp
            .json()
            .await
            .map_err(|e| CoreError::JsonParse(e.to_string()))?;

        Ok(releases
            .into_iter()
            .filter(|r| !r.draft)
            .map(|r| ReleaseInfo {
                version: normalize(&r.tag_name).to_string(),
                tag: r.tag_name,
                name: r.name,
                body: r.body,
                published_at: r.published_at,
                prerelease: r.prerelease,
                html_url: r.html_url,
            })
            .collect())
    }

    /// Fetch tags as a fallback when no GitHub releases are published.
    async fn fetch_tags(&self) -> Result<Vec<ReleaseInfo>> {
        let url = format!(
            "https://api.github.com/repos/{}/{}/tags?per_page=30",
            self.owner, self.repo
        );
        let resp = self
            .client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| CoreError::Network(e.to_string()))?;

        if !resp.status().is_success() {
            return Err(CoreError::OAuthServer {
                status: resp.status().as_u16(),
                body: "github tags request failed".to_string(),
            });
        }

        let tags: Vec<GhTag> = resp
            .json()
            .await
            .map_err(|e| CoreError::JsonParse(e.to_string()))?;

        Ok(tags
            .into_iter()
            .map(|t| ReleaseInfo {
                version: normalize(&t.name).to_string(),
                tag: t.name.clone(),
                name: None,
                body: None,
                published_at: None,
                prerelease: false,
                html_url: Some(format!(
                    "https://github.com/{}/{}/releases/tag/{}",
                    self.owner, self.repo, t.name
                )),
            })
            .collect())
    }
}

#[cfg(test)]
mod update_tests {
    use super::*;

    #[test]
    fn newer_version_detected() {
        assert!(is_newer("v0.2.0", "0.1.0"));
        assert!(is_newer("0.1.1", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("v0.1.0", "0.2.0"));
    }

    #[test]
    fn normalize_strips_v() {
        assert_eq!(normalize("v1.2.3"), "1.2.3");
        assert_eq!(normalize("1.2.3"), "1.2.3");
    }
}
