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
    let Some(accounts) = value.get("accounts").and_then(Value::as_array) else {
        return false;
    };

    let kind = value.get("type").and_then(Value::as_str);
    if kind == Some("subdata") || value.get("proxies").is_some() {
        return true;
    }

    if accounts.is_empty() {
        return value.get("exported_at").is_some();
    }

    accounts
        .iter()
        .any(|a| a.get("credentials").is_some() && a.get("platform").is_some())
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
/// - Multiple bare JSON objects pasted one after another
pub fn parse_input(text: &str) -> Result<Vec<String>> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(CoreError::NoRefreshToken);
    }

    // Try JSON first.
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return tokens_from_json(&value);
    }

    if let Some(values) = parse_json_object_stream(trimmed)? {
        return tokens_from_json_sequence(&values);
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
            } else if let Some(accounts) = value.get("accounts").and_then(Value::as_array) {
                let out: Vec<String> = accounts.iter().filter_map(find_refresh_token).collect();
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

fn tokens_from_json_sequence(values: &[Value]) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for value in values {
        if let Ok(tokens) = tokens_from_json(value) {
            out.extend(tokens);
        }
    }

    if out.is_empty() {
        Err(CoreError::NoRefreshToken)
    } else {
        Ok(out)
    }
}

/// Parse text made of top-level JSON objects without an enclosing array:
/// `{...}\n{...}`. Whitespace is ignored and a comma between objects is accepted
/// because many sellers paste objects copied out of an array.
pub(crate) fn parse_json_object_stream(text: &str) -> Result<Option<Vec<Value>>> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let mut values = Vec::new();
    let mut start: Option<usize> = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (index, ch) in trimmed.char_indices() {
        if start.is_none() {
            if ch.is_whitespace() || (ch == ',' && !values.is_empty()) {
                continue;
            }
            if ch != '{' {
                return if values.is_empty() {
                    Ok(None)
                } else {
                    Err(CoreError::JsonParse(
                        "unexpected text between JSON objects".into(),
                    ))
                };
            }
            start = Some(index);
            depth = 1;
            in_string = false;
            escaped = false;
            continue;
        }

        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let begin = start.take().unwrap();
                    let end = index + ch.len_utf8();
                    let value = serde_json::from_str::<Value>(&trimmed[begin..end])
                        .map_err(|e| CoreError::JsonParse(e.to_string()))?;
                    values.push(value);
                }
            }
            _ => {}
        }
    }

    if start.is_some() {
        return Err(CoreError::JsonParse("unterminated JSON object".into()));
    }

    if values.is_empty() {
        Ok(None)
    } else {
        Ok(Some(values))
    }
}
