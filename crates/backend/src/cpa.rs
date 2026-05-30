//! Direct integration with a user-provided CLIProxyAPI (CPA) instance.
//!
//! The browser cannot call CLIProxyAPI directly (HTTPS→HTTP mixed content +
//! CORS), so these handlers proxy requests server-side. The user supplies the
//! CPA base URL and management key; we forward to CPA's Management API
//! (`/v0/management/...`). The management key is used transiently and never
//! logged or persisted.

use std::time::Duration;

use axum::{http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};

/// A single CPA auth file to upload (filename + the account JSON object).
#[derive(Debug, Deserialize)]
pub struct CpaFile {
    /// Filename ending in `.json`, e.g. `user@example.com.json`.
    pub name: String,
    /// The CPA account object (a single `{}`, not an array).
    pub content: serde_json::Value,
}

/// Request to upload one or more auth files to CLIProxyAPI.
#[derive(Debug, Deserialize)]
pub struct CpaUploadRequest {
    /// CPA base URL, e.g. `http://1.2.3.4:8317`.
    pub base_url: String,
    /// Management key (plaintext). Sent as a Bearer token; never stored.
    pub management_key: String,
    /// Files to upload.
    pub files: Vec<CpaFile>,
}

/// Request to test connectivity / auth against a CPA instance.
#[derive(Debug, Deserialize)]
pub struct CpaTestRequest {
    pub base_url: String,
    pub management_key: String,
}

/// Per-file upload outcome.
#[derive(Debug, Serialize)]
pub struct CpaUploadItem {
    pub name: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// Aggregated upload response.
#[derive(Debug, Serialize)]
pub struct CpaUploadResponse {
    pub total: usize,
    pub success: usize,
    pub failed: usize,
    pub results: Vec<CpaUploadItem>,
}

/// Normalize a user-supplied base URL: trim, require http(s), strip trailing
/// slash and an accidental `/v0/management` suffix.
fn normalize_base(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("base URL is empty".into());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("base URL must start with http:// or https://".into());
    }
    let cleaned = trimmed
        .strip_suffix("/v0/management")
        .unwrap_or(trimmed)
        .to_string();
    Ok(cleaned)
}

/// Build an HTTP client for talking to CPA (short timeouts, IPv4).
fn cpa_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("client build: {e}"))
}

fn err_json(status: StatusCode, message: impl Into<String>) -> axum::response::Response {
    (status, Json(serde_json::json!({ "error": message.into() }))).into_response()
}

/// Test connection + management auth by calling CPA's `/latest-version`.
pub async fn test_connection(Json(req): Json<CpaTestRequest>) -> axum::response::Response {
    let base = match normalize_base(&req.base_url) {
        Ok(b) => b,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, e),
    };
    let client = match cpa_client() {
        Ok(c) => c,
        Err(e) => return err_json(StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    let url = format!("{base}/v0/management/latest-version");
    match client
        .get(&url)
        .bearer_auth(&req.management_key)
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                let body: serde_json::Value = resp.json().await.unwrap_or_default();
                (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "ok": true,
                        "cpa_version": body.get("latest-version"),
                    })),
                )
                    .into_response()
            } else if status.as_u16() == 401 {
                err_json(StatusCode::UNAUTHORIZED, "管理密钥无效或缺失")
            } else if status.as_u16() == 403 {
                err_json(
                    StatusCode::FORBIDDEN,
                    "CLIProxyAPI 未开启远程管理（remote-management.allow-remote）",
                )
            } else if status.as_u16() == 404 {
                err_json(
                    StatusCode::NOT_FOUND,
                    "未配置管理密钥，或地址不是 CLIProxyAPI 管理接口",
                )
            } else {
                err_json(
                    StatusCode::BAD_GATEWAY,
                    format!("CLIProxyAPI 返回 {}", status.as_u16()),
                )
            }
        }
        Err(e) => err_json(
            StatusCode::BAD_GATEWAY,
            format!("无法连接 CLIProxyAPI: {e}"),
        ),
    }
}

/// Upload auth files to CPA, one request per file.
pub async fn upload(Json(req): Json<CpaUploadRequest>) -> axum::response::Response {
    let base = match normalize_base(&req.base_url) {
        Ok(b) => b,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, e),
    };
    if req.files.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "没有要上传的文件");
    }
    let client = match cpa_client() {
        Ok(c) => c,
        Err(e) => return err_json(StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    let mut results = Vec::with_capacity(req.files.len());
    for file in &req.files {
        let name = sanitize_name(&file.name);
        let outcome = upload_one(&client, &base, &req.management_key, &name, &file.content).await;
        results.push(match outcome {
            Ok(()) => CpaUploadItem {
                name,
                ok: true,
                error: None,
            },
            Err(e) => CpaUploadItem {
                name,
                ok: false,
                error: Some(e),
            },
        });
    }

    let success = results.iter().filter(|r| r.ok).count();
    let failed = results.len() - success;
    (
        StatusCode::OK,
        Json(CpaUploadResponse {
            total: results.len(),
            success,
            failed,
            results,
        }),
    )
        .into_response()
}

/// Ensure the upload filename is a safe `.json` basename.
fn sanitize_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw).trim();
    let base = if base.is_empty() { "account" } else { base };
    if base.ends_with(".json") {
        base.to_string()
    } else {
        format!("{base}.json")
    }
}

/// Upload a single auth file via the raw-JSON form of CPA's POST /auth-files.
async fn upload_one(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    name: &str,
    content: &serde_json::Value,
) -> Result<(), String> {
    let url = format!("{base}/v0/management/auth-files");
    let resp = client
        .post(&url)
        .query(&[("name", name)])
        .bearer_auth(key)
        .json(content)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    // Surface CPA's error message when present.
    let body = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
    Err(detail)
}
