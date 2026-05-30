//! HTTP API handlers for the Codex Token converter backend.

use std::{convert::Infallible, sync::Arc, time::Duration};

use axum::{
    extract::State,
    http::StatusCode,
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

/// Shared application state.
#[derive(Clone)]
pub struct AppState {
    /// Default refresh configuration (endpoint, client id, timeouts).
    pub default_config: Arc<RefreshConfig>,
    /// Cached update-check result with its fetch time.
    pub update_cache:
        Arc<tokio::sync::Mutex<Option<(std::time::Instant, codex_core::UpdateStatus)>>>,
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

/// Offline format conversion between CPA and Sub2API. No network / refresh.
///
/// Returns the converted document directly (a CPA `BatchResult` or a Sub2API
/// export), so the client can display and download it as-is.
pub async fn transform(
    Json(req): Json<TransformRequest>,
) -> Result<Json<serde_json::Value>, ApiErrorResponse> {
    let value = match req.direction {
        TransformDirection::Sub2apiToCpa => {
            let result = codex_core::transform::sub2api_json_to_cpa(&req.input)
                .map_err(|e| ApiErrorResponse::bad_request(e.to_string()))?;
            serde_json::to_value(result).map_err(|e| ApiErrorResponse::internal(e.to_string()))?
        }
        TransformDirection::CpaToSub2api => {
            let export = codex_core::transform::cpa_json_to_sub2api(&req.input)
                .map_err(|e| ApiErrorResponse::bad_request(e.to_string()))?;
            serde_json::to_value(export).map_err(|e| ApiErrorResponse::internal(e.to_string()))?
        }
    };
    Ok(Json(value))
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
