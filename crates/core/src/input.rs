//! Input parsing: plain tokens, batch text, Sub2API exports and custom JSON.

use serde_json::Value;

use crate::error::{CoreError, Result};

/// Extract a refresh token from a JSON object using the documented priority order.
///
/// Priority:
/// 1. refresh_token / refreshToken
/// 2. credentials.refresh_token / credentials.refreshToken
/// 3. tokens.refresh_token / tokens.refreshToken
pub fn find_refresh_token(value: &Value) -> Option<String> {
    const DIRECT: [&str; 2] = ["refresh_token", "refreshToken"];
    const NESTED: [&str; 2] = ["credentials", "tokens"];

    for key in DIRECT {
        if let Some(s) = value.get(key).and_then(Value::as_str) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }

    for parent in NESTED {
        if let Some(obj) = value.get(parent) {
            for key in DIRECT {
                if let Some(s) = obj.get(key).and_then(Value::as_str) {
                    if !s.is_empty() {
                        return Some(s.to_string());
                    }
                }
            }
        }
    }

    None
}

/// Heuristic: does this JSON value look like a Sub2API export payload?
pub fn looks_like_sub2api_export(value: &Value) -> bool {
    if value.get("exported_at").is_some() || value.get("proxies").is_some() {
        return true;
    }
    value
        .get("accounts")
        .and_then(Value::as_array)
        .map(|accounts| {
            accounts
                .iter()
                .any(|a| a.get("credentials").is_some() && a.get("platform").is_some())
        })
        .unwrap_or(false)
}

/// Is a Sub2API account a Codex OAuth account?
pub fn is_codex_oauth_account(account: &Value) -> bool {
    let platform = account.get("platform").and_then(Value::as_str);
    let kind = account.get("type").and_then(Value::as_str);
    platform == Some("openai") && kind == Some("oauth")
}

/// Parse arbitrary input text into a list of refresh tokens.
///
/// Accepts:
/// - Plain single token
/// - Newline-separated batch of tokens
/// - A JSON object (custom or single Sub2API account)
/// - A Sub2API export (object with `accounts` array)
/// - A JSON array of tokens or objects
pub fn parse_input(text: &str) -> Result<Vec<String>> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(CoreError::NoRefreshToken);
    }

    // Try JSON first.
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return tokens_from_json(&value);
    }

    // Fall back to line-based parsing (plain or batch tokens).
    let tokens: Vec<String> = trimmed
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| l.to_string())
        .collect();

    if tokens.is_empty() {
        Err(CoreError::NoRefreshToken)
    } else {
        Ok(tokens)
    }
}

/// Extract refresh tokens from a parsed JSON value.
fn tokens_from_json(value: &Value) -> Result<Vec<String>> {
    match value {
        Value::Array(items) => {
            let mut out = Vec::new();
            for item in items {
                match item {
                    Value::String(s) if !s.trim().is_empty() => out.push(s.trim().to_string()),
                    Value::Object(_) => {
                        if let Some(t) = find_refresh_token(item) {
                            out.push(t);
                        }
                    }
                    _ => {}
                }
            }
            if out.is_empty() {
                Err(CoreError::NoRefreshToken)
            } else {
                Ok(out)
            }
        }
        Value::Object(_) => {
            if looks_like_sub2api_export(value) {
                let accounts = value
                    .get("accounts")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let mut out = Vec::new();
                for account in &accounts {
                    if is_codex_oauth_account(account) {
                        if let Some(t) = find_refresh_token(account) {
                            out.push(t);
                        }
                    }
                }
                if out.is_empty() {
                    Err(CoreError::NoRefreshToken)
                } else {
                    Ok(out)
                }
            } else {
                find_refresh_token(value)
                    .map(|t| vec![t])
                    .ok_or(CoreError::NoRefreshToken)
            }
        }
        _ => Err(CoreError::NoRefreshToken),
    }
}
