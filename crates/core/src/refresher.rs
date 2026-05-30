//! Token refresher: exchanges a refresh token for a full token set via OAuth.

use std::time::Duration;

use reqwest::Client;

use crate::config::RefreshConfig;
use crate::error::{CoreError, Result};
use crate::models::TokenResponse;

/// Performs OAuth refresh-token exchanges against the configured endpoint.
#[derive(Clone)]
pub struct TokenRefresher {
    client: Client,
    config: RefreshConfig,
}

impl TokenRefresher {
    /// Build a refresher from config, constructing the underlying HTTP client.
    pub fn new(config: RefreshConfig) -> Result<Self> {
        let mut builder = Client::builder()
            .timeout(Duration::from_secs(config.timeout_secs))
            .connect_timeout(Duration::from_secs(config.connect_timeout_secs))
            .user_agent(config.user_agent.clone());

        // Force IPv4 to avoid stalls on hosts with a broken IPv6 route to a
        // dual-stack CDN (the resolver may hand back AAAA records first).
        if config.force_ipv4 {
            builder = builder.local_address(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
        }

        let client = builder
            .build()
            .map_err(|e| CoreError::Network(format!("client build: {e}")))?;

        Ok(Self { client, config })
    }

    /// Refresh with retry + exponential backoff for retryable errors.
    pub async fn refresh(&self, refresh_token: &str) -> Result<TokenResponse> {
        let mut attempt = 0;
        loop {
            match self.refresh_once(refresh_token).await {
                Ok(resp) => return Ok(resp),
                Err(err) if err.is_retryable() && attempt < self.config.max_retries => {
                    let backoff = 1u64 << attempt; // 1s, 2s, 4s
                    tokio::time::sleep(Duration::from_secs(backoff)).await;
                    attempt += 1;
                }
                Err(err) => return Err(err),
            }
        }
    }

    /// Single refresh attempt without retry.
    async fn refresh_once(&self, refresh_token: &str) -> Result<TokenResponse> {
        let form = [
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", self.config.client_id.as_str()),
            ("scope", self.config.scope.as_str()),
        ];

        let resp = self
            .client
            .post(&self.config.endpoint)
            .form(&form)
            .send()
            .await
            .map_err(|e| CoreError::Network(e.to_string()))?;

        let status = resp.status();
        if status.is_success() {
            let body = resp
                .text()
                .await
                .map_err(|e| CoreError::Network(e.to_string()))?;
            return serde_json::from_str::<TokenResponse>(&body)
                .map_err(|e| CoreError::JsonParse(e.to_string()));
        }

        let code = status.as_u16();
        let body = resp.text().await.unwrap_or_default();

        // 429 is rate limiting regardless of body.
        if code == 429 {
            return Err(CoreError::RateLimited);
        }

        // Try to parse OpenAI's structured error: { "error": { "code", "message", ... } }
        // or the OAuth2 flat form: { "error": "...", "error_description": "..." }.
        if let Some((err_code, message)) = parse_oauth_error(&body) {
            return Err(CoreError::TokenRejected {
                code: err_code,
                message,
            });
        }

        // 4xx without a parseable body is still a client-side rejection.
        match code {
            400 | 401 | 403 => Err(CoreError::TokenRejected {
                code: "invalid_request".to_string(),
                message: "refresh token rejected (no error detail returned)".to_string(),
            }),
            _ => Err(CoreError::OAuthServer { status: code, body }),
        }
    }
}

/// Parse an OAuth/OpenAI error body into `(code, message)`.
///
/// Handles both the nested OpenAI shape:
/// `{ "error": { "code": "refresh_token_reused", "message": "..." } }`
/// and the flat OAuth2 shape:
/// `{ "error": "invalid_grant", "error_description": "..." }`.
fn parse_oauth_error(body: &str) -> Option<(String, String)> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let error = value.get("error")?;

    match error {
        // Nested object form.
        serde_json::Value::Object(_) => {
            let code = error
                .get("code")
                .and_then(|v| v.as_str())
                .or_else(|| error.get("type").and_then(|v| v.as_str()))
                .unwrap_or("invalid_request")
                .to_string();
            let message = error
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("refresh token rejected")
                .to_string();
            Some((code, message))
        }
        // Flat string form.
        serde_json::Value::String(code) => {
            let message = value
                .get("error_description")
                .and_then(|v| v.as_str())
                .unwrap_or(code)
                .to_string();
            Some((code.clone(), message))
        }
        _ => None,
    }
}
