//! Direct import into a user-provided Sub2API instance.
//!
//! The browser sends credential JSON to this backend. We can forward complete
//! Sub2API account records or build records from access tokens, API keys and
//! refreshed tokens, then upload them with the transient admin credential.

use std::time::Duration;

use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use chrono::{DateTime, Utc};
use codex_core::{
    converter::CodexConverter,
    input::parse_input,
    models::CodexAccount,
    transform::{DEFAULT_SUB2API_CONCURRENCY, DEFAULT_SUB2API_PRIORITY},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::api::AppState;

const OPENAI_AUTH_CLAIM: &str = "https://api.openai.com/auth";

#[derive(Debug, Deserialize)]
pub struct Sub2ApiImportRequest {
    pub base_url: String,
    pub admin_key: String,
    pub input: String,
    #[serde(default)]
    pub group_ids: Vec<i64>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    #[serde(default)]
    pub concurrency: Option<usize>,
    #[serde(default)]
    pub account_concurrency: Option<i64>,
    #[serde(default)]
    pub priority: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct Sub2ApiTestRequest {
    pub base_url: String,
    pub admin_key: String,
}

#[derive(Debug, Deserialize)]
pub struct Sub2ApiLoginRequest {
    pub base_url: String,
    pub email: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct Sub2ApiLoginResponse {
    pub access_token: String,
    pub token_type: Option<String>,
    pub email: Option<String>,
    pub role: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Sub2ApiGroup {
    pub id: i64,
    pub name: String,
    pub platform: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct Sub2ApiImportItem {
    pub name: String,
    pub ok: bool,
    pub email: Option<String>,
    pub expires_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Sub2ApiImportResponse {
    pub total: usize,
    pub success: usize,
    pub failed: usize,
    pub results: Vec<Sub2ApiImportItem>,
}

#[derive(Debug, Clone)]
struct Sub2ApiAccountDraft {
    name: String,
    email: Option<String>,
    expires_at: Option<String>,
    payload: Value,
}

#[derive(Debug, Clone, Copy)]
struct Sub2ApiAccountOptions {
    concurrency: i64,
    priority: i64,
}

impl Sub2ApiAccountOptions {
    fn from_request(req: &Sub2ApiImportRequest) -> Self {
        Self {
            concurrency: req
                .account_concurrency
                .unwrap_or(DEFAULT_SUB2API_CONCURRENCY)
                .max(0),
            priority: req.priority.unwrap_or(DEFAULT_SUB2API_PRIORITY),
        }
    }
}

pub async fn login(Json(req): Json<Sub2ApiLoginRequest>) -> axum::response::Response {
    let base = match normalize_base(&req.base_url) {
        Ok(b) => b,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, e),
    };
    if req.email.trim().is_empty() || req.password.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "邮箱和密码不能为空");
    }
    let client = match sub2api_client() {
        Ok(c) => c,
        Err(e) => return err_json(StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    let url = format!("{base}/api/v1/auth/login");
    let resp = match client
        .post(url)
        .json(&json!({
            "email": req.email.trim(),
            "password": req.password,
        }))
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => return err_json(StatusCode::BAD_GATEWAY, format!("无法连接 Sub2API: {e}")),
    };

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return err_json(
            StatusCode::BAD_GATEWAY,
            extract_error_message(&body)
                .unwrap_or_else(|| format!("登录失败 HTTP {}", status.as_u16())),
        );
    }

    let data = match response_data(&body) {
        Some(data) => data,
        None => return err_json(StatusCode::BAD_GATEWAY, "Sub2API 登录响应异常"),
    };
    let Some(access_token) = data.get("access_token").and_then(Value::as_str) else {
        return err_json(StatusCode::BAD_GATEWAY, "Sub2API 未返回 access_token");
    };
    let user = data.get("user");
    (
        StatusCode::OK,
        Json(Sub2ApiLoginResponse {
            access_token: access_token.to_string(),
            token_type: data
                .get("token_type")
                .and_then(Value::as_str)
                .map(str::to_string),
            email: user
                .and_then(|u| u.get("email"))
                .and_then(Value::as_str)
                .map(str::to_string),
            role: user
                .and_then(|u| u.get("role"))
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
    )
        .into_response()
}

pub async fn list_groups(Json(req): Json<Sub2ApiTestRequest>) -> axum::response::Response {
    let base = match normalize_base(&req.base_url) {
        Ok(b) => b,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, e),
    };
    if req.admin_key.trim().is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "Admin Key / JWT 不能为空");
    }
    let client = match sub2api_client() {
        Ok(c) => c,
        Err(e) => return err_json(StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    let url = format!("{base}/api/v1/admin/groups/all");
    let resp = match add_sub2api_auth(client.get(url), req.admin_key.trim())
        .query(&[("platform", "openai")])
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => return err_json(StatusCode::BAD_GATEWAY, format!("无法连接 Sub2API: {e}")),
    };

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return err_json(
            StatusCode::BAD_GATEWAY,
            extract_error_message(&body)
                .unwrap_or_else(|| format!("读取分组失败 HTTP {}", status.as_u16())),
        );
    }

    let Some(Value::Array(items)) = response_data(&body) else {
        return err_json(StatusCode::BAD_GATEWAY, "Sub2API 分组响应异常");
    };
    let groups: Vec<Sub2ApiGroup> = items
        .iter()
        .filter_map(|item| {
            let id = item.get("id").and_then(Value::as_i64)?;
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("未命名分组")
                .to_string();
            Some(Sub2ApiGroup {
                id,
                name,
                platform: item
                    .get("platform")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                status: item
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect();

    (StatusCode::OK, Json(json!({ "groups": groups }))).into_response()
}

pub async fn test_connection(Json(req): Json<Sub2ApiTestRequest>) -> axum::response::Response {
    let base = match normalize_base(&req.base_url) {
        Ok(b) => b,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, e),
    };
    if req.admin_key.trim().is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "Admin API Key 不能为空");
    }
    let client = match sub2api_client() {
        Ok(c) => c,
        Err(e) => return err_json(StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    let url = format!("{base}/api/v1/admin/accounts");
    match add_sub2api_auth(client.get(url), req.admin_key.trim())
        .query(&[("page", "1"), ("page_size", "1")])
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
            } else if status.as_u16() == 401 {
                err_json(StatusCode::UNAUTHORIZED, "Sub2API Admin Key 无效")
            } else if status.as_u16() == 403 {
                err_json(StatusCode::FORBIDDEN, "当前 Key 没有管理员权限")
            } else {
                err_json(
                    StatusCode::BAD_GATEWAY,
                    format!("Sub2API 返回 {}", status.as_u16()),
                )
            }
        }
        Err(e) => err_json(StatusCode::BAD_GATEWAY, format!("无法连接 Sub2API: {e}")),
    }
}

pub async fn import_access_tokens(
    Json(req): Json<Sub2ApiImportRequest>,
) -> axum::response::Response {
    let base = match normalize_base(&req.base_url) {
        Ok(b) => b,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, e),
    };
    if req.admin_key.trim().is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "Admin API Key 不能为空");
    }

    let tokens = match extract_access_tokens(&req.input) {
        Ok(tokens) => tokens,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, e),
    };
    if tokens.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "没有找到 access_token");
    }

    let accounts: Vec<Sub2ApiAccountDraft> = tokens
        .iter()
        .enumerate()
        .map(|(index, token)| {
            build_access_token_account(index, token, Sub2ApiAccountOptions::from_request(&req))
        })
        .collect();

    let client = match sub2api_client() {
        Ok(c) => c,
        Err(e) => return err_json(StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    let group_ids = req.group_ids;
    match upload_batch(&client, &base, req.admin_key.trim(), &accounts, &group_ids).await {
        Ok(mut results) => {
            if results.len() != accounts.len() {
                results = accounts
                    .iter()
                    .map(|account| Sub2ApiImportItem {
                        name: account.name.clone(),
                        ok: true,
                        email: account.email.clone(),
                        expires_at: account.expires_at.clone(),
                        error: None,
                    })
                    .collect();
            }
            let success = results.iter().filter(|r| r.ok).count();
            let failed = results.len() - success;
            (
                StatusCode::OK,
                Json(Sub2ApiImportResponse {
                    total: results.len(),
                    success,
                    failed,
                    results,
                }),
            )
                .into_response()
        }
        Err(e) => err_json(StatusCode::BAD_GATEWAY, e),
    }
}

pub async fn import_accounts(Json(req): Json<Sub2ApiImportRequest>) -> axum::response::Response {
    let base = match normalize_base(&req.base_url) {
        Ok(b) => b,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, e),
    };
    if req.admin_key.trim().is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "Admin API Key / JWT 不能为空");
    }

    let accounts =
        match extract_sub2api_account_drafts(&req.input, Sub2ApiAccountOptions::from_request(&req))
        {
            Ok(accounts) => accounts,
            Err(e) => return err_json(StatusCode::BAD_REQUEST, e),
        };
    if accounts.is_empty() {
        return err_json(
            StatusCode::BAD_REQUEST,
            "没有找到 Sub2API 账号，支持 accounts 或 items[].content.accounts 结构",
        );
    }

    let client = match sub2api_client() {
        Ok(c) => c,
        Err(e) => return err_json(StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    match upload_batch(
        &client,
        &base,
        req.admin_key.trim(),
        &accounts,
        &req.group_ids,
    )
    .await
    {
        Ok(mut results) => {
            if results.len() != accounts.len() {
                results = success_results(&accounts);
            }
            let success = results.iter().filter(|r| r.ok).count();
            let failed = results.len() - success;
            (
                StatusCode::OK,
                Json(Sub2ApiImportResponse {
                    total: results.len(),
                    success,
                    failed,
                    results,
                }),
            )
                .into_response()
        }
        Err(e) => err_json(StatusCode::BAD_GATEWAY, e),
    }
}

pub async fn import_api_keys(Json(req): Json<Sub2ApiImportRequest>) -> axum::response::Response {
    let base = match normalize_base(&req.base_url) {
        Ok(b) => b,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, e),
    };
    if req.admin_key.trim().is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "Admin API Key 不能为空");
    }

    let keys = match extract_api_keys(&req.input) {
        Ok(keys) => keys,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, e),
    };
    if keys.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "没有找到 api_key");
    }

    let accounts: Vec<Sub2ApiAccountDraft> = keys
        .iter()
        .enumerate()
        .map(|(index, key)| {
            build_api_key_account(index, key, Sub2ApiAccountOptions::from_request(&req))
        })
        .collect();

    let client = match sub2api_client() {
        Ok(c) => c,
        Err(e) => return err_json(StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    let group_ids = req.group_ids;
    match upload_batch(&client, &base, req.admin_key.trim(), &accounts, &group_ids).await {
        Ok(mut results) => {
            if results.len() != accounts.len() {
                results = success_results(&accounts);
            }
            let success = results.iter().filter(|r| r.ok).count();
            let failed = results.len() - success;
            (
                StatusCode::OK,
                Json(Sub2ApiImportResponse {
                    total: results.len(),
                    success,
                    failed,
                    results,
                }),
            )
                .into_response()
        }
        Err(e) => err_json(StatusCode::BAD_GATEWAY, e),
    }
}

pub async fn import_refresh_tokens(
    State(state): State<AppState>,
    Json(req): Json<Sub2ApiImportRequest>,
) -> axum::response::Response {
    let base = match normalize_base(&req.base_url) {
        Ok(b) => b,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, e),
    };
    if req.admin_key.trim().is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "Admin API Key / JWT 不能为空");
    }

    let tokens = match parse_input(&req.input) {
        Ok(tokens) => tokens,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, e.to_string()),
    };
    if tokens.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "没有找到 Refresh Token");
    }

    let mut config = (*state.default_config).clone();
    if let Some(timeout) = req.timeout_secs {
        config.timeout_secs = timeout;
    }
    if let Some(concurrency) = req.concurrency {
        config.concurrency = concurrency.max(1);
    }
    let converter = match CodexConverter::new(config) {
        Ok(c) => c,
        Err(e) => return err_json(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    let refreshed = converter.convert_batch(&tokens).await;
    let refresh_errors: Vec<Sub2ApiImportItem> = refreshed
        .errors
        .iter()
        .map(|err| Sub2ApiImportItem {
            name: format!("RT {}", err.index + 1),
            ok: false,
            email: None,
            expires_at: None,
            error: Some(format!("{}: {}", err.token_preview, err.error)),
        })
        .collect();

    let accounts: Vec<Sub2ApiAccountDraft> = refreshed
        .accounts
        .iter()
        .enumerate()
        .map(|(index, account)| {
            build_refreshed_account(index, account, Sub2ApiAccountOptions::from_request(&req))
        })
        .collect();

    if accounts.is_empty() {
        let failed = refresh_errors.len();
        return (
            StatusCode::OK,
            Json(Sub2ApiImportResponse {
                total: refreshed.total,
                success: 0,
                failed,
                results: refresh_errors,
            }),
        )
            .into_response();
    }

    let client = match sub2api_client() {
        Ok(c) => c,
        Err(e) => return err_json(StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    let group_ids = req.group_ids;
    match upload_batch(&client, &base, req.admin_key.trim(), &accounts, &group_ids).await {
        Ok(mut upload_results) => {
            if upload_results.len() != accounts.len() {
                upload_results = success_results(&accounts);
            }
            let mut results = upload_results;
            results.extend(refresh_errors);
            let success = results.iter().filter(|r| r.ok).count();
            let failed = results.len() - success;
            (
                StatusCode::OK,
                Json(Sub2ApiImportResponse {
                    total: refreshed.total,
                    success,
                    failed,
                    results,
                }),
            )
                .into_response()
        }
        Err(e) => err_json(StatusCode::BAD_GATEWAY, e),
    }
}

fn normalize_base(raw: &str) -> Result<String, String> {
    let mut trimmed = raw.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        return Err("Sub2API 地址不能为空".into());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("Sub2API 地址必须以 http:// 或 https:// 开头".into());
    }
    for suffix in [
        "/api/v1/admin/accounts/batch",
        "/api/v1/admin/accounts",
        "/api/v1/admin",
        "/api/v1",
        "/admin",
    ] {
        if trimmed.ends_with(suffix) {
            trimmed.truncate(trimmed.len() - suffix.len());
            break;
        }
    }
    Ok(trimmed)
}

fn sub2api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("client build: {e}"))
}

fn add_sub2api_auth(builder: reqwest::RequestBuilder, credential: &str) -> reqwest::RequestBuilder {
    let trimmed = credential.trim();
    if let Some(token) = trimmed
        .strip_prefix("Bearer ")
        .or_else(|| trimmed.strip_prefix("bearer "))
    {
        builder.header("Authorization", format!("Bearer {token}"))
    } else {
        builder.header("x-api-key", trimmed)
    }
}

fn err_json(status: StatusCode, message: impl Into<String>) -> axum::response::Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

fn extract_sub2api_account_drafts(
    input: &str,
    options: Sub2ApiAccountOptions,
) -> Result<Vec<Sub2ApiAccountDraft>, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Sub2API 账号 JSON 不能为空".into());
    }

    let mut account_values = Vec::new();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        collect_sub2api_account_values(&value, &mut account_values);
    } else {
        let stream = serde_json::Deserializer::from_str(trimmed).into_iter::<Value>();
        for value in stream {
            let value = value.map_err(|e| format!("Sub2API 账号 JSON 解析失败: {e}"))?;
            collect_sub2api_account_values(&value, &mut account_values);
        }
    }

    account_values
        .into_iter()
        .enumerate()
        .map(|(index, value)| build_imported_account(index, value, options))
        .collect()
}

fn collect_sub2api_account_values(value: &Value, out: &mut Vec<Value>) {
    if looks_like_sub2api_account(value) {
        out.push(value.clone());
        return;
    }

    match value {
        Value::Array(items) => {
            for item in items {
                collect_sub2api_account_values(item, out);
            }
        }
        Value::Object(obj) => {
            if let Some(accounts) = obj.get("accounts").and_then(Value::as_array) {
                for account in accounts {
                    collect_sub2api_account_values(account, out);
                }
            }
            if let Some(items) = obj.get("items").and_then(Value::as_array) {
                for item in items {
                    collect_sub2api_account_values(item.get("content").unwrap_or(item), out);
                }
            }
            if let Some(content) = obj.get("content") {
                collect_sub2api_content(content, out);
            }
        }
        Value::String(_) => collect_sub2api_content(value, out),
        _ => {}
    }
}

fn collect_sub2api_content(content: &Value, out: &mut Vec<Value>) {
    match content {
        Value::String(text) => {
            if let Ok(value) = serde_json::from_str::<Value>(text) {
                collect_sub2api_account_values(&value, out);
            }
        }
        value => collect_sub2api_account_values(value, out),
    }
}

fn looks_like_sub2api_account(value: &Value) -> bool {
    value
        .get("credentials")
        .and_then(Value::as_object)
        .is_some()
}

fn build_imported_account(
    index: usize,
    value: Value,
    options: Sub2ApiAccountOptions,
) -> Result<Sub2ApiAccountDraft, String> {
    let Value::Object(mut payload) = value else {
        return Err(format!("第 {} 个 Sub2API 账号不是 JSON 对象", index + 1));
    };
    let credentials = payload
        .get("credentials")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("第 {} 个 Sub2API 账号缺少 credentials", index + 1))?;

    let email = credentials
        .get("email")
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .get("extra")
                .and_then(Value::as_object)
                .and_then(|extra| extra.get("email"))
                .and_then(Value::as_str)
        })
        .or_else(|| payload.get("email").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let expires_at = credentials
        .get("expires_at")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let fallback_id = credentials
        .get("agent_runtime_id")
        .or_else(|| credentials.get("chatgpt_account_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| email.clone())
        .or_else(|| fallback_id.map(str::to_string))
        .unwrap_or_else(|| format!("sub2api-account-{}", index + 1));
    let inferred_kind = if credentials.get("api_key").is_some() {
        "apikey"
    } else {
        "oauth"
    };

    payload.insert("name".into(), Value::String(name.clone()));
    payload
        .entry("platform")
        .or_insert_with(|| Value::String("openai".into()));
    payload
        .entry("type")
        .or_insert_with(|| Value::String(inferred_kind.into()));
    payload
        .entry("auto_pause_on_expired")
        .or_insert(Value::Bool(true));
    payload
        .entry("concurrency")
        .or_insert(json!(options.concurrency));
    payload.entry("priority").or_insert(json!(options.priority));
    payload.entry("rate_multiplier").or_insert(json!(1));
    payload
        .entry("confirm_mixed_channel_risk")
        .or_insert(Value::Bool(true));

    if let Some(email) = &email {
        match payload.entry("extra") {
            serde_json::map::Entry::Vacant(entry) => {
                entry.insert(json!({ "email": email }));
            }
            serde_json::map::Entry::Occupied(mut entry) => {
                if let Some(extra) = entry.get_mut().as_object_mut() {
                    extra
                        .entry("email")
                        .or_insert_with(|| Value::String(email.clone()));
                }
            }
        }
    }

    Ok(Sub2ApiAccountDraft {
        name,
        email,
        expires_at,
        payload: Value::Object(payload),
    })
}

fn extract_access_tokens(input: &str) -> Result<Vec<String>, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("AT JSON 不能为空".into());
    }

    let mut tokens = Vec::new();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        collect_access_tokens(&value, false, true, &mut tokens);
    } else {
        for line in trimmed
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            if let Ok(value) = serde_json::from_str::<Value>(line) {
                collect_access_tokens(&value, false, true, &mut tokens);
            } else if looks_like_token(line) {
                tokens.push(line.to_string());
            }
        }
    }

    let mut deduped = Vec::new();
    for token in tokens {
        let token = strip_bearer(&token);
        if token.is_empty() || deduped.iter().any(|seen| seen == &token) {
            continue;
        }
        deduped.push(token);
    }
    Ok(deduped)
}

fn extract_api_keys(input: &str) -> Result<Vec<String>, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("API Key 不能为空".into());
    }

    let mut keys = Vec::new();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        collect_api_keys(&value, false, true, &mut keys);
    } else {
        for line in trimmed
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            if let Ok(value) = serde_json::from_str::<Value>(line) {
                collect_api_keys(&value, false, true, &mut keys);
            } else if looks_like_api_key(line) {
                keys.push(line.to_string());
            }
        }
    }

    let mut deduped = Vec::new();
    for key in keys {
        let key = key.trim().to_string();
        if key.is_empty() || deduped.iter().any(|seen| seen == &key) {
            continue;
        }
        deduped.push(key);
    }
    Ok(deduped)
}

fn collect_access_tokens(
    value: &Value,
    key_is_access_token: bool,
    loose_string_token: bool,
    out: &mut Vec<String>,
) {
    match value {
        Value::String(s) => {
            if key_is_access_token || (loose_string_token && looks_like_token(s)) {
                out.push(s.to_string());
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_access_tokens(item, key_is_access_token, loose_string_token, out);
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                let is_access_token = key_is_access_token || normalized_key(key) == "accesstoken";
                collect_access_tokens(item, is_access_token, false, out);
            }
        }
        _ => {}
    }
}

fn collect_api_keys(
    value: &Value,
    key_is_api_key: bool,
    loose_string_key: bool,
    out: &mut Vec<String>,
) {
    match value {
        Value::String(s) => {
            if key_is_api_key || (loose_string_key && looks_like_api_key(s)) {
                out.push(s.to_string());
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_api_keys(item, key_is_api_key, loose_string_key, out);
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                let normalized = normalized_key(key);
                let is_api_key =
                    key_is_api_key || normalized == "apikey" || normalized == "openaiapikey";
                collect_api_keys(item, is_api_key, false, out);
            }
        }
        _ => {}
    }
}

fn normalized_key(key: &str) -> String {
    key.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn strip_bearer(raw: &str) -> String {
    let trimmed = raw.trim();
    trimmed
        .strip_prefix("Bearer ")
        .or_else(|| trimmed.strip_prefix("bearer "))
        .unwrap_or(trimmed)
        .trim()
        .to_string()
}

fn looks_like_token(raw: &str) -> bool {
    let token = strip_bearer(raw);
    token.len() > 40 && token.matches('.').count() == 2
}

fn looks_like_api_key(raw: &str) -> bool {
    let key = raw.trim();
    key.len() >= 20 && (key.starts_with("sk-") || key.starts_with("sess-"))
}

fn build_access_token_account(
    index: usize,
    access_token: &str,
    options: Sub2ApiAccountOptions,
) -> Sub2ApiAccountDraft {
    let claims = codex_core::jwt::decode_payload(access_token).ok();
    let email = claims
        .as_ref()
        .and_then(|value| lookup_str(value, &["email"]));
    let user_id = claims
        .as_ref()
        .and_then(|value| lookup_str(value, &["chatgpt_user_id", "user_id", "sub"]));
    let account_id = claims
        .as_ref()
        .and_then(|value| lookup_str(value, &["chatgpt_account_id"]));
    let organization_id = claims
        .as_ref()
        .and_then(|value| lookup_str(value, &["poid", "organization_id"]));
    let plan_type = claims
        .as_ref()
        .and_then(|value| lookup_str(value, &["chatgpt_plan_type", "plan_type"]));
    let expires_at = claims
        .as_ref()
        .and_then(|value| value.get("exp").and_then(Value::as_i64))
        .and_then(|ts| DateTime::<Utc>::from_timestamp(ts, 0))
        .map(|dt| dt.to_rfc3339());

    let fallback_name = user_id
        .as_ref()
        .or(account_id.as_ref())
        .map(|s| format!("codex-{s}"))
        .unwrap_or_else(|| format!("codex-at-{}", index + 1));
    let name = email.clone().unwrap_or(fallback_name);

    let mut credentials = Map::new();
    credentials.insert(
        "access_token".into(),
        Value::String(access_token.to_string()),
    );
    if let Some(value) = &expires_at {
        credentials.insert("expires_at".into(), Value::String(value.clone()));
    }
    if let Some(value) = &email {
        credentials.insert("email".into(), Value::String(value.clone()));
    }
    if let Some(value) = &account_id {
        credentials.insert("chatgpt_account_id".into(), Value::String(value.clone()));
    }
    if let Some(value) = &user_id {
        credentials.insert("chatgpt_user_id".into(), Value::String(value.clone()));
    }
    if let Some(value) = &organization_id {
        credentials.insert("organization_id".into(), Value::String(value.clone()));
    }
    if let Some(value) = &plan_type {
        credentials.insert("plan_type".into(), Value::String(value.clone()));
    }

    let payload = json!({
        "name": name,
        "auto_pause_on_expired": true,
        "platform": "openai",
        "type": "oauth",
        "credentials": Value::Object(credentials),
        "extra": { "email": email },
        "concurrency": options.concurrency,
        "priority": options.priority,
        "rate_multiplier": 1,
        "confirm_mixed_channel_risk": true,
    });

    Sub2ApiAccountDraft {
        name,
        email,
        expires_at,
        payload,
    }
}

fn build_api_key_account(
    index: usize,
    api_key: &str,
    options: Sub2ApiAccountOptions,
) -> Sub2ApiAccountDraft {
    let name = format!("openai-apikey-{}", mask_secret_tail(api_key, index + 1));
    let payload = json!({
        "name": name,
        "auto_pause_on_expired": true,
        "platform": "openai",
        "type": "apikey",
        "credentials": {
            "api_key": api_key,
        },
        "concurrency": options.concurrency,
        "priority": options.priority,
        "rate_multiplier": 1,
        "confirm_mixed_channel_risk": true,
    });

    Sub2ApiAccountDraft {
        name,
        email: None,
        expires_at: None,
        payload,
    }
}

fn build_refreshed_account(
    index: usize,
    account: &CodexAccount,
    options: Sub2ApiAccountOptions,
) -> Sub2ApiAccountDraft {
    let name = account
        .email
        .clone()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            (!account.id.trim().is_empty()).then(|| format!("codex-{}", account.id.clone()))
        })
        .unwrap_or_else(|| format!("codex-rt-{}", index + 1));

    let mut credentials = Map::new();
    credentials.insert(
        "access_token".into(),
        Value::String(account.tokens.access_token.clone()),
    );
    credentials.insert(
        "refresh_token".into(),
        Value::String(account.tokens.refresh_token.clone()),
    );
    credentials.insert(
        "id_token".into(),
        Value::String(account.tokens.id_token.clone()),
    );
    if let Some(value) = &account.subscription_active_until {
        credentials.insert("expires_at".into(), Value::String(value.clone()));
    }
    if let Some(value) = &account.email {
        credentials.insert("email".into(), Value::String(value.clone()));
    }
    if let Some(value) = &account.account_id {
        credentials.insert("chatgpt_account_id".into(), Value::String(value.clone()));
    }
    if let Some(value) = &account.user_id {
        credentials.insert("chatgpt_user_id".into(), Value::String(value.clone()));
    }
    if let Some(value) = &account.organization_id {
        credentials.insert("organization_id".into(), Value::String(value.clone()));
    }
    if let Some(value) = &account.plan_type {
        credentials.insert("plan_type".into(), Value::String(value.clone()));
    }

    let payload = json!({
        "name": name,
        "auto_pause_on_expired": true,
        "platform": "openai",
        "type": "oauth",
        "credentials": Value::Object(credentials),
        "extra": { "email": account.email },
        "concurrency": options.concurrency,
        "priority": options.priority,
        "rate_multiplier": 1,
        "confirm_mixed_channel_risk": true,
    });

    Sub2ApiAccountDraft {
        name,
        email: account.email.clone(),
        expires_at: account.subscription_active_until.clone(),
        payload,
    }
}

fn mask_secret_tail(secret: &str, fallback: usize) -> String {
    let trimmed = secret.trim();
    if trimmed.chars().count() < 8 {
        return fallback.to_string();
    }
    let tail: String = trimmed
        .chars()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("***{tail}")
}

fn lookup_str(payload: &Value, keys: &[&str]) -> Option<String> {
    let auth = payload.get(OPENAI_AUTH_CLAIM);
    for key in keys {
        if let Some(value) = payload.get(*key).and_then(Value::as_str) {
            if !value.trim().is_empty() {
                return Some(value.to_string());
            }
        }
        if let Some(value) = auth.and_then(|a| a.get(*key)).and_then(Value::as_str) {
            if !value.trim().is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

async fn upload_batch(
    client: &reqwest::Client,
    base: &str,
    admin_key: &str,
    accounts: &[Sub2ApiAccountDraft],
    group_ids: &[i64],
) -> Result<Vec<Sub2ApiImportItem>, String> {
    let url = format!("{base}/api/v1/admin/accounts/batch");
    let request_accounts: Vec<Value> = accounts
        .iter()
        .map(|account| {
            let mut payload = account.payload.clone();
            if !group_ids.is_empty() {
                if let Some(obj) = payload.as_object_mut() {
                    obj.insert("group_ids".into(), json!(group_ids));
                }
            }
            payload
        })
        .collect();
    let resp = add_sub2api_auth(client.post(url), admin_key)
        .json(&json!({ "accounts": request_accounts }))
        .send()
        .await
        .map_err(|e| format!("请求 Sub2API 失败: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let detail =
            extract_error_message(&body).unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        return Err(detail);
    }
    if let Some(detail) = extract_nonzero_code_message(&body) {
        return Err(detail);
    }

    Ok(parse_upload_results(&body, accounts))
}

fn parse_upload_results(body: &str, accounts: &[Sub2ApiAccountDraft]) -> Vec<Sub2ApiImportItem> {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return success_results(accounts);
    };
    let data = value.get("data").unwrap_or(&value);
    let Some(results) = data.get("results").and_then(Value::as_array) else {
        return success_results(accounts);
    };

    results
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let account = accounts.get(index);
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| account.map(|a| a.name.clone()))
                .unwrap_or_else(|| format!("codex-at-{}", index + 1));
            let ok = item
                .get("success")
                .and_then(Value::as_bool)
                .or_else(|| item.get("ok").and_then(Value::as_bool))
                .unwrap_or(true);
            let error = item
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|s| !s.is_empty());
            Sub2ApiImportItem {
                name,
                ok,
                email: account.and_then(|a| a.email.clone()),
                expires_at: account.and_then(|a| a.expires_at.clone()),
                error,
            }
        })
        .collect()
}

fn success_results(accounts: &[Sub2ApiAccountDraft]) -> Vec<Sub2ApiImportItem> {
    accounts
        .iter()
        .map(|account| Sub2ApiImportItem {
            name: account.name.clone(),
            ok: true,
            email: account.email.clone(),
            expires_at: account.expires_at.clone(),
            error: None,
        })
        .collect()
}

fn extract_error_message(body: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(body).ok()?;
    for key in ["message", "error", "detail"] {
        if let Some(message) = value.get(key).and_then(Value::as_str) {
            if !message.trim().is_empty() {
                return Some(message.to_string());
            }
        }
    }
    value
        .get("data")
        .and_then(|data| data.get("message").or_else(|| data.get("error")))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn response_data(body: &str) -> Option<Value> {
    let value = serde_json::from_str::<Value>(body).ok()?;
    if let Some(code) = value.get("code").and_then(Value::as_i64) {
        if code != 0 {
            return None;
        }
    }
    value.get("data").cloned().or(Some(value))
}

fn extract_nonzero_code_message(body: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(body).ok()?;
    let code = value.get("code").and_then(Value::as_i64)?;
    if code == 0 {
        return None;
    }
    extract_error_message(body).or_else(|| Some(format!("Sub2API 返回错误 code={code}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_access_token_fields_without_id_token() {
        let input = r#"{
          "id_token": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
          "credentials": {
            "access_token": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIyIn0.sig"
          }
        }"#;

        let tokens = extract_access_tokens(input).unwrap();
        assert_eq!(tokens, vec!["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIyIn0.sig"]);
    }

    #[test]
    fn accepts_direct_token_string_array() {
        let input = r#"["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxLCJlbWFpbCI6ImFAYi5jb20ifQ.signature"]"#;

        let tokens = extract_access_tokens(input).unwrap();
        assert_eq!(
            tokens,
            vec!["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxLCJlbWFpbCI6ImFAYi5jb20ifQ.signature"]
        );
    }

    #[test]
    fn extracts_api_key_fields() {
        let input = r#"[
          {"credentials":{"api_key":"sk-test-abcdefghijklmnopqrstuvwxyz"}},
          {"openai_api_key":"sk-test-abcdefghijklmnopqrstuvwxyz"},
          "sess-test-abcdefghijklmnopqrstuvwxyz"
        ]"#;

        let keys = extract_api_keys(input).unwrap();
        assert_eq!(
            keys,
            vec![
                "sk-test-abcdefghijklmnopqrstuvwxyz",
                "sess-test-abcdefghijklmnopqrstuvwxyz"
            ]
        );
    }

    #[test]
    fn extracts_wrapped_sub2api_account_bundle() {
        let input = r#"{
          "generatedAt": "2026-07-22T18:15:43.703Z",
          "items": [{
            "fileName": "user@example.com.json",
            "encoding": "json",
            "content": {
              "accounts": [{
                "name": "user@example.com",
                "platform": "openai",
                "type": "oauth",
                "credentials": {
                  "auth_mode": "agentIdentity",
                  "agent_private_key": "private-key",
                  "agent_runtime_id": "agent-runtime",
                  "email": "user@example.com"
                },
                "concurrency": 10,
                "priority": 1
              }]
            }
          }]
        }"#;

        let accounts = extract_sub2api_account_drafts(
            input,
            Sub2ApiAccountOptions {
                concurrency: 3,
                priority: 50,
            },
        )
        .unwrap();

        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].name, "user@example.com");
        assert_eq!(accounts[0].email.as_deref(), Some("user@example.com"));
        assert_eq!(accounts[0].payload["concurrency"].as_i64(), Some(10));
        assert_eq!(accounts[0].payload["priority"].as_i64(), Some(1));
        assert_eq!(
            accounts[0].payload["credentials"]["agent_private_key"].as_str(),
            Some("private-key")
        );
        assert_eq!(
            accounts[0].payload["credentials"]["auth_mode"].as_str(),
            Some("agentIdentity")
        );
        assert_eq!(
            accounts[0].payload["confirm_mixed_channel_risk"].as_bool(),
            Some(true)
        );
    }

    #[test]
    fn extracts_direct_sub2api_export_and_fills_defaults() {
        let input = r#"{
          "type": "sub2api-data",
          "version": 1,
          "accounts": [{
            "credentials": {
              "api_key": "sk-test-abcdefghijklmnopqrstuvwxyz"
            }
          }]
        }"#;

        let accounts = extract_sub2api_account_drafts(
            input,
            Sub2ApiAccountOptions {
                concurrency: 8,
                priority: 66,
            },
        )
        .unwrap();

        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].payload["platform"].as_str(), Some("openai"));
        assert_eq!(accounts[0].payload["type"].as_str(), Some("apikey"));
        assert_eq!(accounts[0].payload["concurrency"].as_i64(), Some(8));
        assert_eq!(accounts[0].payload["priority"].as_i64(), Some(66));
    }

    #[test]
    fn account_options_default_to_nonzero_values() {
        let req = Sub2ApiImportRequest {
            base_url: "http://localhost:8080".to_string(),
            admin_key: "admin".to_string(),
            input: "sk-test-abcdefghijklmnopqrstuvwxyz".to_string(),
            group_ids: Vec::new(),
            timeout_secs: None,
            concurrency: None,
            account_concurrency: None,
            priority: None,
        };

        let options = Sub2ApiAccountOptions::from_request(&req);
        assert_eq!(options.concurrency, DEFAULT_SUB2API_CONCURRENCY);
        assert_eq!(options.priority, DEFAULT_SUB2API_PRIORITY);
    }

    #[test]
    fn account_payload_uses_user_schedule_options() {
        let options = Sub2ApiAccountOptions {
            concurrency: 8,
            priority: 66,
        };
        let account = build_api_key_account(0, "sk-test-abcdefghijklmnopqrstuvwxyz", options);

        assert_eq!(account.payload["concurrency"].as_i64(), Some(8));
        assert_eq!(account.payload["priority"].as_i64(), Some(66));
        assert_eq!(
            account.payload["auto_pause_on_expired"].as_bool(),
            Some(true)
        );
        assert_eq!(account.payload["rate_multiplier"].as_i64(), Some(1));
    }

    #[test]
    fn dotted_admin_key_still_uses_api_key_header() {
        let client = reqwest::Client::new();
        let req = add_sub2api_auth(client.get("http://example.test"), "adm.in.key")
            .build()
            .unwrap();
        assert_eq!(
            req.headers().get("x-api-key").and_then(|v| v.to_str().ok()),
            Some("adm.in.key")
        );
        assert!(req.headers().get("authorization").is_none());

        let req = add_sub2api_auth(client.get("http://example.test"), "Bearer jwt.token.value")
            .build()
            .unwrap();
        assert_eq!(
            req.headers()
                .get("authorization")
                .and_then(|v| v.to_str().ok()),
            Some("Bearer jwt.token.value")
        );
    }
}
