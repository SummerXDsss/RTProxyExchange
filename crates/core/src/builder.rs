//! Build CPA-format CodexAccount objects from tokens and user info.

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

use crate::models::{AccountTokens, CodexAccount, TokenResponse, UserInfo};

/// Generate a stable account id: SHA256(email + account_id + organization_id).
pub fn generate_account_id(
    email: Option<&str>,
    account_id: Option<&str>,
    org_id: Option<&str>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(email.unwrap_or_default().as_bytes());
    hasher.update(account_id.unwrap_or_default().as_bytes());
    hasher.update(org_id.unwrap_or_default().as_bytes());
    hex::encode(hasher.finalize())
}

/// Convert a unix timestamp (seconds) to an RFC3339 string.
fn ts_to_rfc3339(ts: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp(ts, 0).map(|dt| dt.to_rfc3339())
}

/// Build a CPA account from a refresh, token response and extracted user info.
///
/// `input_refresh_token` is the token originally supplied; if the OAuth response
/// returns an empty refresh token we preserve the original to avoid losing creds.
pub fn build_codex_account(
    input_refresh_token: &str,
    tokens: &TokenResponse,
    info: &UserInfo,
) -> CodexAccount {
    let refresh_token = if tokens.refresh_token.trim().is_empty() {
        input_refresh_token.to_string()
    } else {
        tokens.refresh_token.clone()
    };

    let id = generate_account_id(
        info.email.as_deref(),
        info.account_id.as_deref(),
        info.organization_id.as_deref(),
    );

    let now = Utc::now().timestamp();
    let subscription_active_until = info.expires_at.and_then(ts_to_rfc3339);

    CodexAccount {
        id,
        email: info.email.clone(),
        auth_mode: "oauth".to_string(),
        openai_api_key: None,
        api_base_url: None,
        api_provider_mode: "openai_builtin".to_string(),
        user_id: info.user_id.clone(),
        plan_type: info.plan_type.clone(),
        subscription_active_until,
        account_id: info.account_id.clone(),
        organization_id: info.organization_id.clone(),
        tokens: AccountTokens {
            id_token: tokens.id_token.clone(),
            access_token: tokens.access_token.clone(),
            refresh_token,
        },
        token_generation: 1,
        token_source_mode: "managed".to_string(),
        requires_reauth: false,
        quota: None,
        tags: Vec::new(),
        created_at: now,
        last_used: now,
    }
}
