//! Optional on-disk configuration (`~/.codex-converter/config.json`).
//!
//! Mirrors the schema described in PRD §6.1. All fields are optional; anything
//! missing falls back to [`crate::config::RefreshConfig`] defaults.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::config::RefreshConfig;

/// `oauth` section of the config file.
#[derive(Debug, Default, Deserialize)]
pub struct OAuthSection {
    pub client_id: Option<String>,
    pub endpoint: Option<String>,
    pub scope: Option<String>,
    pub user_agent: Option<String>,
    pub timeout: Option<u64>,
}

/// `network` section of the config file.
#[derive(Debug, Default, Deserialize)]
pub struct NetworkSection {
    pub verify_ssl: Option<bool>,
    pub max_retries: Option<u32>,
    pub retry_delay: Option<u64>,
    pub concurrency: Option<usize>,
}

/// `output` section of the config file.
#[derive(Debug, Default, Deserialize)]
pub struct OutputSection {
    pub default_format: Option<String>,
    pub include_metadata: Option<bool>,
    pub pretty_print: Option<bool>,
}

/// `security` section of the config file.
#[derive(Debug, Default, Deserialize)]
pub struct SecuritySection {
    pub log_tokens: Option<bool>,
    pub file_permissions: Option<String>,
}

/// Full file configuration document.
#[derive(Debug, Default, Deserialize)]
pub struct FileConfig {
    #[serde(default)]
    pub oauth: OAuthSection,
    #[serde(default)]
    pub network: NetworkSection,
    #[serde(default)]
    pub output: OutputSection,
    #[serde(default)]
    pub security: SecuritySection,
}

impl FileConfig {
    /// Default config path: `~/.codex-converter/config.json`.
    pub fn default_path() -> Option<PathBuf> {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
        Some(
            Path::new(&home)
                .join(".codex-converter")
                .join("config.json"),
        )
    }

    /// Load and parse a config file. Returns `Ok(None)` if it does not exist.
    pub fn load(path: &Path) -> std::io::Result<Option<FileConfig>> {
        match std::fs::read_to_string(path) {
            Ok(contents) => {
                let cfg = serde_json::from_str(&contents)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
                Ok(Some(cfg))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Try the default path; returns `None` if unset or missing.
    pub fn load_default() -> Option<FileConfig> {
        Self::default_path().and_then(|p| Self::load(&p).ok().flatten())
    }

    /// Apply this file config on top of a base [`RefreshConfig`].
    pub fn apply_to(&self, mut base: RefreshConfig) -> RefreshConfig {
        if let Some(v) = &self.oauth.client_id {
            base.client_id = v.clone();
        }
        if let Some(v) = &self.oauth.endpoint {
            base.endpoint = v.clone();
        }
        if let Some(v) = &self.oauth.scope {
            base.scope = v.clone();
        }
        if let Some(v) = &self.oauth.user_agent {
            base.user_agent = v.clone();
        }
        if let Some(v) = self.oauth.timeout {
            base.timeout_secs = v;
        }
        if let Some(v) = self.network.max_retries {
            base.max_retries = v;
        }
        if let Some(v) = self.network.concurrency {
            base.concurrency = v.max(1);
        }
        base
    }
}
