//! Data models for tokens, user info and CPA account output.

use serde::{Deserialize, Serialize};

/// Raw response from the OAuth token endpoint.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TokenResponse {
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub id_token: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub expires_in: i64,
    #[serde(default)]
    pub token_type: String,
    #[serde(default)]
    pub scope: String,
}

/// User identity extracted from the JWT claims.
#[derive(Debug, Clone, Default, Serialize)]
pub struct UserInfo {
    pub email: Option<String>,
    pub user_id: Option<String>,
    pub account_id: Option<String>,
    pub organization_id: Option<String>,
    pub plan_type: Option<String>,
    /// Unix timestamp (seconds) of token expiry, used for subscription_active_until.
    pub expires_at: Option<i64>,
}

/// Token triple stored on a CPA account.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AccountTokens {
    #[serde(default)]
    pub id_token: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
}

/// A CLIProxyAPI-format account record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexAccount {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default = "default_auth_mode")]
    pub auth_mode: String,
    #[serde(default)]
    pub openai_api_key: Option<String>,
    #[serde(default)]
    pub api_base_url: Option<String>,
    #[serde(default = "default_api_provider_mode")]
    pub api_provider_mode: String,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub plan_type: Option<String>,
    #[serde(default)]
    pub subscription_active_until: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub organization_id: Option<String>,
    #[serde(default)]
    pub tokens: AccountTokens,
    #[serde(default = "default_token_generation")]
    pub token_generation: u32,
    #[serde(default = "default_token_source_mode")]
    pub token_source_mode: String,
    #[serde(default)]
    pub requires_reauth: bool,
    #[serde(default)]
    pub quota: Option<serde_json::Value>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub last_used: i64,
}

fn default_auth_mode() -> String {
    "oauth".to_string()
}
fn default_api_provider_mode() -> String {
    "openai_builtin".to_string()
}
fn default_token_source_mode() -> String {
    "managed".to_string()
}
fn default_token_generation() -> u32 {
    1
}

/// Per-token error entry in a batch result.
#[derive(Debug, Clone, Serialize)]
pub struct ConversionError {
    pub index: usize,
    pub token_preview: String,
    pub error: String,
}

/// Aggregated result of a batch conversion.
#[derive(Debug, Clone, Serialize)]
pub struct BatchResult {
    pub accounts: Vec<CodexAccount>,
    pub exported_at: String,
    pub total: usize,
    pub success: usize,
    pub failed: usize,
    pub errors: Vec<ConversionError>,
}

/// Produce a safe preview (first 10 chars) of a token for logging/errors.
pub fn token_preview(token: &str) -> String {
    let preview: String = token.chars().take(10).collect();
    format!("{preview}...")
}

/// Progress event emitted during a streaming batch conversion.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProgressEvent {
    /// Emitted once at the start with the total token count.
    Started { total: usize },
    /// Emitted when a single token finishes (success or failure).
    Item {
        index: usize,
        token_preview: String,
        ok: bool,
        /// Present on success: the resulting account email (may be null).
        email: Option<String>,
        /// Present on failure: the error message.
        error: Option<String>,
        /// Running counters.
        completed: usize,
        total: usize,
    },
    /// Emitted once at the end with the full aggregated result.
    Done { result: BatchResult },
}
