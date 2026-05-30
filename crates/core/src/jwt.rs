//! JWT payload decoding (no signature verification) and user info extraction.

use base64::Engine;
use serde_json::Value;

use crate::error::{CoreError, Result};
use crate::models::{TokenResponse, UserInfo};

const OPENAI_AUTH_CLAIM: &str = "https://api.openai.com/auth";

/// Decode the payload section of a JWT without verifying its signature.
pub fn decode_payload(jwt: &str) -> Result<Value> {
    let mut parts = jwt.split('.');
    let payload = parts
        .nth(1)
        .ok_or_else(|| CoreError::JwtDecode("missing payload segment".into()))?;

    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(payload))
        .map_err(|e| CoreError::JwtDecode(format!("base64: {e}")))?;

    serde_json::from_slice(&bytes).map_err(|e| CoreError::JwtDecode(format!("json: {e}")))
}

/// Look up a string field, trying both the top level and the nested OpenAI auth claim.
fn lookup_str(payload: &Value, auth: Option<&Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(v) = payload.get(key).and_then(Value::as_str) {
            return Some(v.to_string());
        }
        if let Some(a) = auth {
            if let Some(v) = a.get(key).and_then(Value::as_str) {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// Extract user info, preferring id_token claims and falling back to access_token.
pub fn extract_user_info(tokens: &TokenResponse) -> UserInfo {
    let mut info = UserInfo::default();

    // Primary source: id_token.
    if let Ok(payload) = decode_payload(&tokens.id_token) {
        merge_from_payload(&mut info, &payload);
    }

    // Fallback / supplement: access_token.
    if let Ok(payload) = decode_payload(&tokens.access_token) {
        merge_from_payload(&mut info, &payload);
    }

    info
}

/// Merge any missing fields from a decoded JWT payload into `info`.
fn merge_from_payload(info: &mut UserInfo, payload: &Value) {
    let auth = payload.get(OPENAI_AUTH_CLAIM);

    if info.email.is_none() {
        info.email = lookup_str(payload, auth, &["email"]);
    }
    if info.account_id.is_none() {
        info.account_id = lookup_str(payload, auth, &["chatgpt_account_id"]);
    }
    if info.user_id.is_none() {
        info.user_id = lookup_str(payload, auth, &["chatgpt_user_id", "user_id", "sub"]);
    }
    if info.organization_id.is_none() {
        info.organization_id = lookup_str(payload, auth, &["poid", "organization_id"]);
    }
    if info.plan_type.is_none() {
        info.plan_type = lookup_str(payload, auth, &["chatgpt_plan_type", "plan_type"]);
    }
    if info.expires_at.is_none() {
        info.expires_at = payload.get("exp").and_then(Value::as_i64);
    }
}
