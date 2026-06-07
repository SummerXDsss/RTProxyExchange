//! Codex Token converter backend server (Axum).

mod api;
mod cpa;
mod split;

use std::{net::SocketAddr, sync::Arc};

use axum::{
    routing::{get, post},
    Router,
};
use codex_core::config::RefreshConfig;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use api::AppState;

#[tokio::main]
async fn main() {
    // Initialize tracing. Note: tokens are never logged (only previews elsewhere).
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "codex_backend=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let state = AppState {
        default_config: Arc::new(build_config_from_env()),
        update_cache: Arc::new(tokio::sync::Mutex::new(None)),
        oauth_sessions: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let api = Router::new()
        .route("/api/health", get(api::health))
        .route("/api/config", get(api::config))
        .route("/api/oauth/start", post(api::oauth_start))
        .route("/api/oauth/exchange", post(api::oauth_exchange))
        .route("/api/convert", post(api::convert))
        .route("/api/convert/stream", post(api::convert_stream))
        .route("/api/transform", post(api::transform))
        .route("/api/update", get(api::check_update))
        .route("/api/update/apply", post(api::apply_update))
        .route("/api/split", post(split::split))
        .route("/api/split/zip", post(split::split_zip))
        .route("/api/cpa/test", post(cpa::test_connection))
        .route("/api/cpa/upload", post(cpa::upload))
        .with_state(state)
        .layer(cors);

    // Serve the built frontend (if present) as static files.
    let static_dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| "frontend/dist".to_string());
    let app = api.fallback_service(ServeDir::new(static_dir));

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8787);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    tracing::info!("listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

/// Build refresh config: start from defaults, layer the on-disk config file
/// (if present), then apply environment variable overrides (highest priority).
fn build_config_from_env() -> RefreshConfig {
    let base = RefreshConfig::default();

    // Layer 1: optional ~/.codex-converter/config.json
    let mut config = match codex_core::file_config::FileConfig::load_default() {
        Some(file_cfg) => {
            tracing::info!("loaded config from ~/.codex-converter/config.json");
            file_cfg.apply_to(base)
        }
        None => base,
    };

    // Layer 2: environment variables override the file.
    if let Ok(timeout) = std::env::var("CODEX_CONVERTER_TIMEOUT") {
        if let Ok(t) = timeout.parse() {
            config.timeout_secs = t;
        }
    }
    if let Ok(client_id) = std::env::var("CODEX_CONVERTER_CLIENT_ID") {
        if !client_id.is_empty() {
            config.client_id = client_id;
        }
    }
    if let Ok(concurrency) = std::env::var("CODEX_CONVERTER_CONCURRENCY") {
        if let Ok(c) = concurrency.parse::<usize>() {
            config.concurrency = c.max(1);
        }
    }
    if let Ok(connect) = std::env::var("CODEX_CONVERTER_CONNECT_TIMEOUT") {
        if let Ok(c) = connect.parse() {
            config.connect_timeout_secs = c;
        }
    }
    // Allow disabling the IPv4-only behavior if a deployment actually needs IPv6.
    if let Ok(v) = std::env::var("CODEX_CONVERTER_FORCE_IPV4") {
        config.force_ipv4 = !matches!(v.as_str(), "0" | "false" | "no");
    }
    config
}
