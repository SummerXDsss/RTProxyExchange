//! HTTP API handlers for the Codex Token converter backend.

use std::{
    collections::HashMap,
    convert::Infallible,
    io::{Cursor, Write},
    sync::Arc,
    time::Duration,
};

use axum::{
    body::Body,
    extract::State,
    http::{header, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use codex_core::{
    config::RefreshConfig, converter::CodexConverter, input::parse_input, models::BatchResult,
};
use futures::stream::Stream;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use zip::{write::SimpleFileOptions, ZipWriter};

const OAUTH_SESSION_TTL: Duration = Duration::from_secs(600);

#[derive(Debug, Clone)]
pub struct PendingOAuthSession {
    pub state: String,
    pub code_verifier: String,
    pub redirect_uri: String,
    pub created_at: std::time::Instant,
}

/// Shared application state.
#[derive(Clone)]
pub struct AppState {
    /// Default refresh configuration (endpoint, client id, timeouts).
    pub default_config: Arc<RefreshConfig>,
    /// Cached update-check result with its fetch time.
    pub update_cache:
        Arc<tokio::sync::Mutex<Option<(std::time::Instant, codex_core::UpdateStatus)>>>,
    /// Short-lived PKCE sessions waiting for a pasted callback URL.
    pub oauth_sessions: Arc<tokio::sync::Mutex<HashMap<String, PendingOAuthSession>>>,
}

/// Request body for the convert endpoints.
#[derive(Debug, Deserialize)]
pub struct ConvertRequest {
    /// Raw input: plain token(s), batch text, Sub2API JSON, or custom JSON.
    pub input: String,
    /// Optional request timeout override (seconds).
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// Optional concurrency override.
    #[serde(default)]
    pub concurrency: Option<usize>,
    /// If true, only parse tokens without performing refresh.
    #[serde(default)]
    pub dry_run: bool,
}

impl ConvertRequest {
    /// Build a per-request [`RefreshConfig`] from the defaults plus overrides.
    fn build_config(&self, base: &RefreshConfig) -> RefreshConfig {
        let mut config = base.clone();
        if let Some(timeout) = self.timeout_secs {
            config.timeout_secs = timeout;
        }
        if let Some(concurrency) = self.concurrency {
            config.concurrency = concurrency.max(1);
        }
        config
    }
}

/// Response for a dry-run parse.
#[derive(Debug, Serialize)]
pub struct DryRunResponse {
    pub total: usize,
    pub token_previews: Vec<String>,
}

/// A successful convert response is either a batch result or a dry-run summary.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum ConvertResponse {
    Batch(BatchResult),
    DryRun(DryRunResponse),
}

/// Response returned when starting browser OAuth.
#[derive(Debug, Serialize)]
pub struct OAuthStartResponse {
    pub session_id: String,
    pub auth_url: String,
    pub redirect_uri: String,
    pub expires_in_secs: u64,
}

/// Request body for exchanging a pasted callback URL.
#[derive(Debug, Deserialize)]
pub struct OAuthExchangeRequest {
    pub session_id: String,
    pub callback_url: String,
}

/// Response after exchanging an authorization code.
#[derive(Debug, Serialize)]
pub struct OAuthExchangeResponse {
    pub refresh_token: String,
    pub email: Option<String>,
}

/// Response when a self-update helper has been started.
#[derive(Debug, Serialize)]
pub struct ApplyUpdateResponse {
    pub started: bool,
    pub message: String,
    pub helper_container: Option<String>,
}

/// Error payload returned to clients.
#[derive(Debug, Serialize)]
pub struct ApiError {
    pub error: String,
}

/// Wrapper so handlers can return a typed error with status code.
pub struct ApiErrorResponse {
    status: StatusCode,
    message: String,
}

impl ApiErrorResponse {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }
    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiErrorResponse {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ApiError {
                error: self.message,
            }),
        )
            .into_response()
    }
}

/// Health check endpoint.
pub async fn health() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "service": "rtproxyexchange",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

/// Effective (non-secret) configuration, for the UI to display defaults.
/// Note: `client_id` is an internal built-in constant and is intentionally
/// not surfaced here — users log in with a refresh token alone.
pub async fn config(State(state): State<AppState>) -> impl IntoResponse {
    let c = &state.default_config;
    Json(serde_json::json!({
        "endpoint": c.endpoint,
        "scope": c.scope,
        "timeout_secs": c.timeout_secs,
        "max_retries": c.max_retries,
        "concurrency": c.concurrency,
    }))
}

/// Start a manual browser OAuth handoff. No local callback server is started:
/// the UI opens `auth_url`, then the user pastes the final callback URL back.
pub async fn oauth_start(
    State(state): State<AppState>,
) -> Result<Json<OAuthStartResponse>, ApiErrorResponse> {
    let start = codex_core::oauth::create_pkce_session(&state.default_config)
        .map_err(|e| ApiErrorResponse::internal(e.to_string()))?;
    let session_id = start.state.clone();

    let mut sessions = state.oauth_sessions.lock().await;
    sessions.retain(|_, session| session.created_at.elapsed() < OAUTH_SESSION_TTL);
    sessions.insert(
        session_id.clone(),
        PendingOAuthSession {
            state: start.state,
            code_verifier: start.code_verifier,
            redirect_uri: start.redirect_uri.clone(),
            created_at: std::time::Instant::now(),
        },
    );

    Ok(Json(OAuthStartResponse {
        session_id,
        auth_url: start.auth_url,
        redirect_uri: start.redirect_uri,
        expires_in_secs: OAUTH_SESSION_TTL.as_secs(),
    }))
}

/// Exchange the user-pasted callback URL for a refresh token.
pub async fn oauth_exchange(
    State(state): State<AppState>,
    Json(req): Json<OAuthExchangeRequest>,
) -> Result<Json<OAuthExchangeResponse>, ApiErrorResponse> {
    let callback = codex_core::oauth::parse_callback_url(&req.callback_url)
        .map_err(|e| ApiErrorResponse::bad_request(e.to_string()))?;

    let pending = {
        let mut sessions = state.oauth_sessions.lock().await;
        sessions.retain(|_, session| session.created_at.elapsed() < OAUTH_SESSION_TTL);
        let Some(session) = sessions.get(&req.session_id).cloned() else {
            return Err(ApiErrorResponse::bad_request(
                "OAuth 会话已过期，请重新获取授权链接",
            ));
        };
        if session.state != callback.state {
            return Err(ApiErrorResponse::bad_request(
                "OAuth state 不匹配，请重新获取授权链接",
            ));
        }
        session
    };

    let tokens = codex_core::oauth::exchange_code_for_tokens(
        &state.default_config,
        &callback.code,
        &pending.code_verifier,
        &pending.redirect_uri,
    )
    .await
    .map_err(|e| ApiErrorResponse::bad_request(e.to_string()))?;

    if tokens.refresh_token.trim().is_empty() {
        return Err(ApiErrorResponse::bad_request(
            "OAuth 未返回 Refresh Token，请重新授权",
        ));
    }

    {
        let mut sessions = state.oauth_sessions.lock().await;
        sessions.remove(&req.session_id);
    }

    let info = codex_core::jwt::extract_user_info(&tokens);
    Ok(Json(OAuthExchangeResponse {
        refresh_token: tokens.refresh_token,
        email: info.email,
    }))
}

/// Non-streaming convert: parse input and (unless dry-run) refresh + build.
pub async fn convert(
    State(state): State<AppState>,
    Json(req): Json<ConvertRequest>,
) -> Result<Json<ConvertResponse>, ApiErrorResponse> {
    let tokens =
        parse_input(&req.input).map_err(|e| ApiErrorResponse::bad_request(e.to_string()))?;

    if req.dry_run {
        let token_previews = tokens
            .iter()
            .map(|t| codex_core::models::token_preview(t))
            .collect();
        return Ok(Json(ConvertResponse::DryRun(DryRunResponse {
            total: tokens.len(),
            token_previews,
        })));
    }

    let config = req.build_config(&state.default_config);
    let converter =
        CodexConverter::new(config).map_err(|e| ApiErrorResponse::internal(e.to_string()))?;

    let result = converter.convert_batch(&tokens).await;
    Ok(Json(ConvertResponse::Batch(result)))
}

/// Streaming convert via Server-Sent Events. Emits `started`, `item` per token,
/// and a final `done` event carrying the aggregated result.
pub async fn convert_stream(
    State(state): State<AppState>,
    Json(req): Json<ConvertRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiErrorResponse> {
    let tokens =
        parse_input(&req.input).map_err(|e| ApiErrorResponse::bad_request(e.to_string()))?;
    let config = req.build_config(&state.default_config);
    let converter =
        CodexConverter::new(config).map_err(|e| ApiErrorResponse::internal(e.to_string()))?;

    // Channel of progress events from the converter task to the SSE stream.
    let (tx, rx) = mpsc::channel(64);

    tokio::spawn(async move {
        converter.convert_batch_streaming(&tokens, tx).await;
    });

    let stream = ReceiverStream::new(rx).map(|event| {
        let json = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
        // Use the event type as the SSE event name for easy client dispatch.
        let name = event_name(&event);
        Ok(Event::default().event(name).data(json))
    });

    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

/// Map a progress event to its SSE event name.
fn event_name(event: &codex_core::models::ProgressEvent) -> &'static str {
    use codex_core::models::ProgressEvent::*;
    match event {
        Started { .. } => "started",
        Item { .. } => "item",
        Done { .. } => "done",
    }
}

/// Direction for an offline format transform.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransformDirection {
    /// Sub2API export JSON -> CPA accounts.
    Sub2apiToCpa,
    /// CPA accounts JSON -> Sub2API export.
    CpaToSub2api,
}

/// Request body for the offline transform endpoint.
#[derive(Debug, Deserialize)]
pub struct TransformRequest {
    /// Raw JSON text to convert.
    pub input: String,
    /// Which way to convert.
    pub direction: TransformDirection,
}

/// One file in a batch offline transform.
#[derive(Debug, Deserialize)]
pub struct TransformZipFile {
    pub name: Option<String>,
    pub input: String,
}

/// Request body for batch transform zip download.
#[derive(Debug, Deserialize)]
pub struct TransformZipRequest {
    /// Which way to convert.
    pub direction: TransformDirection,
    /// Source files to convert.
    pub files: Vec<TransformZipFile>,
}

/// Offline format conversion between CPA and Sub2API. No network / refresh.
///
/// Returns the converted document directly (a CPA `BatchResult` or a Sub2API
/// export), so the client can display and download it as-is.
pub async fn transform(
    Json(req): Json<TransformRequest>,
) -> Result<Json<serde_json::Value>, ApiErrorResponse> {
    let value = transform_value(&req.input, req.direction)
        .map_err(|e| ApiErrorResponse::bad_request(e.to_string()))?;
    Ok(Json(value))
}

fn transform_value(
    input: &str,
    direction: TransformDirection,
) -> Result<serde_json::Value, String> {
    match direction {
        TransformDirection::Sub2apiToCpa => {
            let result =
                codex_core::transform::sub2api_json_to_cpa(input).map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        TransformDirection::CpaToSub2api => {
            let export =
                codex_core::transform::cpa_json_to_sub2api(input).map_err(|e| e.to_string())?;
            serde_json::to_value(export).map_err(|e| e.to_string())
        }
    }
}

fn transform_output_suffix(direction: TransformDirection) -> &'static str {
    match direction {
        TransformDirection::Sub2apiToCpa => "cpa",
        TransformDirection::CpaToSub2api => "sub2api",
    }
}

fn safe_file_stem(name: Option<&str>, index: usize) -> String {
    let raw = name
        .and_then(|s| s.rsplit(['/', '\\']).next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("account");
    let stem = raw
        .strip_suffix(".json")
        .or_else(|| raw.strip_suffix(".txt"))
        .unwrap_or(raw);
    let safe: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@') {
                c
            } else {
                '_'
            }
        })
        .collect();

    if safe.is_empty() {
        format!("account_{}", index + 1)
    } else {
        safe
    }
}

fn transform_zip_bytes(req: TransformZipRequest) -> Result<Vec<u8>, String> {
    if req.files.is_empty() {
        return Err("没有可转换的文件".into());
    }

    let mut buf = Cursor::new(Vec::new());
    let mut errors = Vec::new();
    {
        let mut zip = ZipWriter::new(&mut buf);
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o600);
        let suffix = transform_output_suffix(req.direction);
        let mut success = 0usize;

        for (index, file) in req.files.iter().enumerate() {
            if file.input.trim().is_empty() {
                errors.push(serde_json::json!({
                    "index": index,
                    "name": file.name,
                    "error": "文件内容为空"
                }));
                continue;
            }

            match transform_value(&file.input, req.direction) {
                Ok(value) => {
                    let name = format!(
                        "{}-{}.json",
                        safe_file_stem(file.name.as_deref(), index),
                        suffix
                    );
                    let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
                    zip.start_file(name, options).map_err(|e| e.to_string())?;
                    zip.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
                    success += 1;
                }
                Err(error) => errors.push(serde_json::json!({
                    "index": index,
                    "name": file.name,
                    "error": error
                })),
            }
        }

        if !errors.is_empty() {
            let text = serde_json::to_string_pretty(&serde_json::json!({
                "success": success,
                "failed": errors.len(),
                "errors": errors
            }))
            .map_err(|e| e.to_string())?;
            zip.start_file("_errors.json", options)
                .map_err(|e| e.to_string())?;
            zip.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }

        zip.finish().map_err(|e| e.to_string())?;
    }
    Ok(buf.into_inner())
}

/// Batch offline transform and return a zip containing converted JSON files.
pub async fn transform_zip(Json(req): Json<TransformZipRequest>) -> Response {
    let result = tokio::task::spawn_blocking(move || transform_zip_bytes(req)).await;
    match result {
        Ok(Ok(bytes)) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/zip".to_string()),
                (
                    header::CONTENT_DISPOSITION,
                    "attachment; filename=\"format-transform.zip\"".to_string(),
                ),
            ],
            Body::from(bytes),
        )
            .into_response(),
        Ok(Err(e)) => ApiErrorResponse::bad_request(e).into_response(),
        Err(e) => ApiErrorResponse::internal(format!("zip task failed: {e}")).into_response(),
    }
}

// Bring StreamExt into scope for `.map` on the receiver stream.
use futures::StreamExt;

/// Cache TTL for update checks (stays well within GitHub's rate limit).
const UPDATE_CACHE_TTL: Duration = Duration::from_secs(300);

/// Check for updates against the project's GitHub releases/tags.
///
/// Result is cached for [`UPDATE_CACHE_TTL`]; pass `?refresh=1` to force a
/// fresh fetch.
pub async fn check_update(
    State(state): State<AppState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Json<codex_core::UpdateStatus>, ApiErrorResponse> {
    let force = params
        .get("refresh")
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);

    // Serve from cache when fresh and not forced.
    {
        let cache = state.update_cache.lock().await;
        if !force {
            if let Some((at, status)) = cache.as_ref() {
                if at.elapsed() < UPDATE_CACHE_TTL {
                    return Ok(Json(status.clone()));
                }
            }
        }
    }

    let checker = codex_core::UpdateChecker::new(env!("CARGO_PKG_VERSION"))
        .map_err(|e| ApiErrorResponse::internal(e.to_string()))?;
    let status = checker.check().await;

    // Only cache successful checks; keep retrying on transient failures.
    if status.error.is_none() {
        let mut cache = state.update_cache.lock().await;
        *cache = Some((std::time::Instant::now(), status.clone()));
    }

    Ok(Json(status))
}

/// Start a host-Docker helper container that updates this compose service.
///
/// This requires the app container to have `/var/run/docker.sock` mounted and
/// Docker CLI available. The helper is separate from this container, so it can
/// finish `docker compose up -d` even while this app container is replaced.
pub async fn apply_update() -> Result<Json<ApplyUpdateResponse>, ApiErrorResponse> {
    if !env_flag("CODEX_ENABLE_SELF_UPDATE") {
        return Err(ApiErrorResponse {
            status: StatusCode::FORBIDDEN,
            message: "容器内更新未启用".to_string(),
        });
    }

    let deploy_dir = std::env::var("CODEX_SELF_UPDATE_DEPLOY_DIR")
        .unwrap_or_else(|_| "/root/codex-deploy".to_string());
    let compose_file = std::env::var("CODEX_SELF_UPDATE_COMPOSE_FILE")
        .unwrap_or_else(|_| "docker-compose.proxy.yml".to_string());
    let service =
        std::env::var("CODEX_SELF_UPDATE_SERVICE").unwrap_or_else(|_| "codex-converter".into());
    let app_image = std::env::var("CODEX_SELF_UPDATE_IMAGE")
        .or_else(|_| std::env::var("CODEX_IMAGE"))
        .unwrap_or_else(|_| "ghcr.io/summerxdsss/rtproxyexchange:latest".to_string());
    let helper_image =
        std::env::var("CODEX_SELF_UPDATE_HELPER_IMAGE").unwrap_or_else(|_| "docker:27-cli".into());

    let helper_name = format!("rtproxyexchange-updater-{}", chrono::Utc::now().timestamp());
    let script = format!(
        "set -eu\nexport CODEX_IMAGE={}\nexport CODEX_DEPLOY_DIR={}\ndocker compose -f {} pull {}\ndocker compose -f {} up -d {}\ndocker image prune -f\n",
        shell_quote(&app_image),
        shell_quote(&deploy_dir),
        shell_quote(&compose_file),
        shell_quote(&service),
        shell_quote(&compose_file),
        shell_quote(&service),
    );

    let mut cmd = tokio::process::Command::new("docker");
    cmd.args(["run", "-d", "--rm", "--name", &helper_name])
        .args(["-v", "/var/run/docker.sock:/var/run/docker.sock"])
        .arg("-v")
        .arg(format!("{deploy_dir}:{deploy_dir}"))
        .args(["-w", &deploy_dir])
        .arg(&helper_image)
        .args(["sh", "-c", &script]);

    let output = cmd
        .output()
        .await
        .map_err(|e| ApiErrorResponse::internal(format!("启动更新失败: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(ApiErrorResponse::internal(format!(
            "启动更新失败: {detail}"
        )));
    }

    Ok(Json(ApplyUpdateResponse {
        started: true,
        message: "已开始更新，稍等 20-60 秒后刷新页面".to_string(),
        helper_container: Some(helper_name),
    }))
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|v| matches!(v.as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
