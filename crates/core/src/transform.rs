//! Offline format conversion and account splitting (no token refresh).
//!
//! Three formats are involved:
//!
//! - **Cockpit-tools / CPA**: a flat account object. A batch is a JSON array
//!   `[{...}, {...}]`. This is the format account sellers (号商) hand out and
//!   the format CLIProxyAPI consumes.
//!
//!   ```json
//!   {
//!     "id_token": "...", "access_token": "...", "refresh_token": "...",
//!     "account_id": "...", "last_refresh": "...Z",
//!     "email": "...", "type": "codex", "expired": "...Z"
//!   }
//!   ```
//!
//! - **Sub2API**: a wrapper document with structured accounts.
//!
//!   ```json
//!   {
//!     "exported_at": "...Z", "proxies": [],
//!     "accounts": [{
//!       "name": "<email>", "platform": "openai", "type": "oauth",
//!       "credentials": { "access_token": "...", "expires_at": "...Z",
//!         "refresh_token": "...", "id_token": "...", "email": "...",
//!         "chatgpt_account_id": "...", "chatgpt_user_id": "...",
//!         "plan_type": "plus" },
//!       "concurrency": 0, "priority": 0
//!     }],
//!     "type": "subdata", "version": 1
//!   }
//!   ```
//!
//! All conversions are pure and deterministic. Where Sub2API needs claims that
//! the flat CPA object does not carry (chatgpt_user_id, plan_type), they are
//! recovered by decoding the embedded id_token / access_token JWTs.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::input::{looks_like_sub2api_export, parse_json_object_stream};
use crate::jwt::extract_user_info;
use crate::models::{CodexAccount, TokenResponse};

pub const DEFAULT_SUB2API_CONCURRENCY: i64 = 3;
pub const DEFAULT_SUB2API_PRIORITY: i64 = 50;

// ---------------------------------------------------------------------------
// Cockpit-tools / CPA flat account
// ---------------------------------------------------------------------------

/// A flat cockpit-tools / CPA account object.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CpaAccount {
    #[serde(default)]
    pub id_token: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(
        default,
        alias = "chatgpt_account_id",
        skip_serializing_if = "Option::is_none"
    )]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_refresh: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(rename = "type", default = "default_codex_type")]
    pub kind: String,
    #[serde(
        default,
        alias = "expires_at",
        alias = "subscription_active_until",
        skip_serializing_if = "Option::is_none"
    )]
    pub expired: Option<String>,
}

fn default_codex_type() -> String {
    "codex".to_string()
}

// ---------------------------------------------------------------------------
// Sub2API data model
// ---------------------------------------------------------------------------

/// OAuth credentials block inside a Sub2API account.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Sub2ApiCredentials {
    #[serde(default)]
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub id_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chatgpt_account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chatgpt_user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
}

/// A single Sub2API account record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sub2ApiAccount {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default = "default_platform")]
    pub platform: String,
    #[serde(rename = "type", default = "default_oauth_type")]
    pub kind: String,
    #[serde(default)]
    pub credentials: Sub2ApiCredentials,
    #[serde(default = "default_sub2api_concurrency")]
    pub concurrency: i64,
    #[serde(default = "default_sub2api_priority")]
    pub priority: i64,
}

fn default_platform() -> String {
    "openai".to_string()
}
fn default_oauth_type() -> String {
    "oauth".to_string()
}
fn default_subdata_type() -> String {
    "subdata".to_string()
}
fn default_version() -> i64 {
    1
}
fn default_sub2api_concurrency() -> i64 {
    DEFAULT_SUB2API_CONCURRENCY
}
fn default_sub2api_priority() -> i64 {
    DEFAULT_SUB2API_PRIORITY
}

/// A Sub2API export wrapper document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sub2ApiExport {
    pub exported_at: String,
    #[serde(default)]
    pub proxies: Vec<serde_json::Value>,
    pub accounts: Vec<Sub2ApiAccount>,
    #[serde(rename = "type", default = "default_subdata_type")]
    pub kind: String,
    #[serde(default = "default_version")]
    pub version: i64,
}

impl Sub2ApiExport {
    /// Wrap a set of accounts into an export document stamped with now.
    pub fn wrap(accounts: Vec<Sub2ApiAccount>) -> Self {
        Self {
            exported_at: Utc::now().to_rfc3339(),
            proxies: Vec::new(),
            accounts,
            kind: default_subdata_type(),
            version: default_version(),
        }
    }
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

/// Parse cockpit-tools / CPA input which may be a single object or an array.
/// Also accepts a Sub2API export (auto-detected) and unwraps it to CPA.
pub fn parse_cpa_accounts(json: &str) -> Result<Vec<CpaAccount>> {
    let trimmed = json.trim();
    let value: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(err) => {
            if let Some(values) = parse_json_object_stream(trimmed)? {
                let mut accounts = Vec::new();
                for value in values {
                    accounts.extend(cpa_accounts_from_value(value)?);
                }
                return Ok(accounts);
            }
            return Err(CoreError::JsonParse(err.to_string()));
        }
    };

    cpa_accounts_from_value(value)
}

fn cpa_accounts_from_value(value: serde_json::Value) -> Result<Vec<CpaAccount>> {
    // Auto-detect a Sub2API export and convert it down to flat CPA accounts.
    if looks_like_sub2api_export(&value) {
        let export: Sub2ApiExport =
            serde_json::from_value(value).map_err(|e| CoreError::JsonParse(e.to_string()))?;
        return Ok(export.accounts.iter().map(sub2api_account_to_cpa).collect());
    }

    match value {
        serde_json::Value::Array(items) => items
            .into_iter()
            .map(cpa_account_from_value)
            .collect::<Result<Vec<_>>>(),
        serde_json::Value::Object(obj) => {
            if let Some(serde_json::Value::Array(items)) = obj.get("accounts") {
                return items
                    .iter()
                    .cloned()
                    .map(cpa_account_from_value)
                    .collect::<Result<Vec<_>>>();
            }

            cpa_account_from_value(serde_json::Value::Object(obj)).map(|account| vec![account])
        }
        _ => Err(CoreError::JsonParse("unexpected CPA JSON shape".into())),
    }
}

fn looks_like_sub2api_account(value: &serde_json::Value) -> bool {
    value.get("credentials").is_some()
        && (value.get("platform").is_some() || value.get("type").is_some())
}

fn cpa_account_from_value(value: serde_json::Value) -> Result<CpaAccount> {
    if looks_like_sub2api_account(&value) {
        let account: Sub2ApiAccount =
            serde_json::from_value(value).map_err(|e| CoreError::JsonParse(e.to_string()))?;
        return Ok(sub2api_account_to_cpa(&account));
    }

    if value
        .get("tokens")
        .and_then(serde_json::Value::as_object)
        .is_some()
    {
        let account: CodexAccount =
            serde_json::from_value(value).map_err(|e| CoreError::JsonParse(e.to_string()))?;
        return Ok(codex_account_to_cpa(&account));
    }

    serde_json::from_value(value).map_err(|e| CoreError::JsonParse(e.to_string()))
}

fn codex_account_to_cpa(account: &CodexAccount) -> CpaAccount {
    CpaAccount {
        id_token: account.tokens.id_token.clone(),
        access_token: account.tokens.access_token.clone(),
        refresh_token: account.tokens.refresh_token.clone(),
        account_id: account.account_id.clone(),
        last_refresh: Some(Utc::now().to_rfc3339()),
        email: account.email.clone(),
        kind: "codex".to_string(),
        expired: account.subscription_active_until.clone(),
    }
}

/// Parse a Sub2API export from JSON text.
pub fn parse_sub2api_export(json: &str) -> Result<Sub2ApiExport> {
    serde_json::from_str(json.trim()).map_err(|e| CoreError::JsonParse(e.to_string()))
}

// ---------------------------------------------------------------------------
// CPA (cockpit) -> Sub2API
// ---------------------------------------------------------------------------

/// Decode the JWTs on a CPA account to recover identity claims.
fn claims_for(account: &CpaAccount) -> crate::models::UserInfo {
    let synthetic = TokenResponse {
        access_token: account.access_token.clone(),
        id_token: account.id_token.clone(),
        refresh_token: account.refresh_token.clone(),
        expires_in: 0,
        token_type: String::new(),
        scope: String::new(),
    };
    extract_user_info(&synthetic)
}

/// Convert a single flat CPA account into a Sub2API account.
pub fn cpa_to_sub2api_account(account: &CpaAccount) -> Sub2ApiAccount {
    let claims = claims_for(account);

    let email = account.email.clone().or(claims.email);
    let chatgpt_account_id = account.account_id.clone().or(claims.account_id);
    let chatgpt_user_id = claims.user_id;
    let plan_type = claims.plan_type;

    // Prefer the explicit cockpit `expired`; otherwise derive from the JWT exp.
    let expires_at = account.expired.clone().or_else(|| {
        claims
            .expires_at
            .and_then(|ts| DateTime::<Utc>::from_timestamp(ts, 0).map(|dt| dt.to_rfc3339()))
    });

    Sub2ApiAccount {
        name: email.clone(),
        email: email.clone(),
        platform: "openai".to_string(),
        kind: "oauth".to_string(),
        credentials: Sub2ApiCredentials {
            access_token: account.access_token.clone(),
            expires_at,
            refresh_token: account.refresh_token.clone(),
            id_token: account.id_token.clone(),
            email,
            chatgpt_account_id,
            chatgpt_user_id,
            plan_type,
        },
        concurrency: DEFAULT_SUB2API_CONCURRENCY,
        priority: DEFAULT_SUB2API_PRIORITY,
    }
}

/// Convert flat CPA accounts into a Sub2API export wrapper.
pub fn cpa_accounts_to_sub2api(accounts: &[CpaAccount]) -> Sub2ApiExport {
    Sub2ApiExport::wrap(accounts.iter().map(cpa_to_sub2api_account).collect())
}

/// Parse CPA JSON (any accepted shape) and convert to a Sub2API export.
pub fn cpa_json_to_sub2api(json: &str) -> Result<Sub2ApiExport> {
    let accounts = parse_cpa_accounts(json)?;
    Ok(cpa_accounts_to_sub2api(&accounts))
}

// ---------------------------------------------------------------------------
// Sub2API -> CPA (cockpit)
// ---------------------------------------------------------------------------

/// Convert a single Sub2API account into a flat CPA account.
pub fn sub2api_account_to_cpa(account: &Sub2ApiAccount) -> CpaAccount {
    let creds = &account.credentials;
    CpaAccount {
        id_token: creds.id_token.clone(),
        access_token: creds.access_token.clone(),
        refresh_token: creds.refresh_token.clone(),
        account_id: creds.chatgpt_account_id.clone(),
        last_refresh: Some(Utc::now().to_rfc3339()),
        email: creds
            .email
            .clone()
            .or_else(|| account.email.clone())
            .or_else(|| account.name.clone()),
        kind: "codex".to_string(),
        expired: creds.expires_at.clone(),
    }
}

/// Convert all accounts in a Sub2API export into flat CPA accounts.
pub fn sub2api_export_to_cpa(export: &Sub2ApiExport) -> Vec<CpaAccount> {
    export
        .accounts
        .iter()
        .filter(|account| account.platform == "openai" && account.kind == "oauth")
        .map(sub2api_account_to_cpa)
        .filter(|account| {
            !account.id_token.is_empty()
                || !account.access_token.is_empty()
                || !account.refresh_token.is_empty()
        })
        .collect()
}

/// Parse a Sub2API export from JSON text, then convert to CPA accounts.
pub fn sub2api_json_to_cpa(json: &str) -> Result<Vec<CpaAccount>> {
    let export = parse_sub2api_export(json)?;
    Ok(sub2api_export_to_cpa(&export))
}

// ---------------------------------------------------------------------------
// Account splitting
// ---------------------------------------------------------------------------

/// A single split account with both output formats and a stable file name base.
#[derive(Debug, Clone, Serialize)]
pub struct SplitAccount {
    /// Account email (may be absent if neither field nor JWT carries one).
    pub email: Option<String>,
    /// File name base, e.g. `codex_user_at_example.com` (no extension).
    pub filename_base: String,
    /// The account in flat CPA / cockpit format.
    pub cpa: CpaAccount,
    /// The account wrapped as a standalone Sub2API export.
    pub sub2api: Sub2ApiExport,
}

/// Result of splitting a batch of accounts.
#[derive(Debug, Clone, Serialize)]
pub struct SplitResult {
    pub total: usize,
    pub accounts: Vec<SplitAccount>,
}

/// Build a filesystem-safe file name base for an account: `codex_{email}`.
///
/// Non-alphanumeric characters (except `.`, `-`, `_`) are replaced with `_`.
/// Falls back to the account id, then a positional index.
pub fn filename_base(email: Option<&str>, account_id: Option<&str>, index: usize) -> String {
    let raw = email
        .filter(|s| !s.is_empty())
        .or(account_id.filter(|s| !s.is_empty()))
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("account_{index}"));

    let safe: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@') {
                c
            } else {
                '_'
            }
        })
        .collect();

    format!("codex_{safe}")
}

/// Split CPA / cockpit input (object, array, or a Sub2API export) into
/// individual accounts, each carrying both output formats and a file name.
pub fn split_accounts(json: &str) -> Result<SplitResult> {
    let accounts = parse_cpa_accounts(json)?;

    let split: Vec<SplitAccount> = accounts
        .into_iter()
        .enumerate()
        .map(|(index, cpa)| {
            let sub2api_account = cpa_to_sub2api_account(&cpa);
            let email = sub2api_account
                .credentials
                .email
                .clone()
                .or_else(|| cpa.email.clone());
            let base = filename_base(email.as_deref(), cpa.account_id.as_deref(), index);
            SplitAccount {
                email,
                filename_base: base,
                cpa,
                sub2api: Sub2ApiExport::wrap(vec![sub2api_account]),
            }
        })
        .collect();

    Ok(SplitResult {
        total: split.len(),
        accounts: split,
    })
}
