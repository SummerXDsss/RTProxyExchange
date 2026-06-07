//! OAuth authorization-code + PKCE helpers for obtaining a refresh token.
//!
//! The app does not listen on the local callback port. It generates the same
//! Codex CLI redirect URI, then lets the user paste the final callback URL back
//! into the UI for code exchange.

use std::time::Duration;

use base64::Engine;
use rand::{rngs::OsRng, RngCore};
use reqwest::Client;
use sha2::{Digest, Sha256};
use url::Url;

use crate::{
    config::RefreshConfig,
    error::{CoreError, Result},
    models::TokenResponse,
};

/// Codex CLI OAuth authorization endpoint.
pub const DEFAULT_AUTH_URL: &str = "https://auth.openai.com/oauth/authorize";
/// Codex CLI callback URI. Users paste this final URL back into the app.
pub const DEFAULT_REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
/// Scope requested by the initial browser login. `offline_access` is required
/// for a refresh token.
pub const DEFAULT_AUTH_SCOPE: &str = "openid email profile offline_access";

/// Generated browser-login session data.
#[derive(Debug, Clone)]
pub struct OAuthStart {
    pub state: String,
    pub code_verifier: String,
    pub redirect_uri: String,
    pub auth_url: String,
}

/// Parsed callback URL fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthCallback {
    pub code: String,
    pub state: String,
}

/// Create a PKCE session and the OpenAI authorization URL.
pub fn create_pkce_session(config: &RefreshConfig) -> Result<OAuthStart> {
    let code_verifier = random_urlsafe(96);
    let code_challenge = code_challenge(&code_verifier);
    let state = random_urlsafe(32);
    let redirect_uri = DEFAULT_REDIRECT_URI.to_string();

    let mut url = Url::parse(DEFAULT_AUTH_URL)
        .map_err(|e| CoreError::OAuthFlow(format!("invalid auth url: {e}")))?;
    url.query_pairs_mut()
        .append_pair("client_id", &config.client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", DEFAULT_AUTH_SCOPE)
        .append_pair("code_challenge", &code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("codex_cli_simplified_flow", "true");

    Ok(OAuthStart {
        state,
        code_verifier,
        redirect_uri,
        auth_url: url.to_string(),
    })
}

/// Parse the user-pasted callback URL and extract `code` + `state`.
pub fn parse_callback_url(raw: &str) -> Result<OAuthCallback> {
    let url = Url::parse(raw.trim())
        .map_err(|e| CoreError::OAuthFlow(format!("invalid callback url: {e}")))?;

    let mut code = None;
    let mut state = None;
    let mut oauth_error = None;
    let mut oauth_error_description = None;

    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => oauth_error = Some(value.into_owned()),
            "error_description" => oauth_error_description = Some(value.into_owned()),
            _ => {}
        }
    }

    if let Some(error) = oauth_error {
        return Err(CoreError::TokenRejected {
            code: error.clone(),
            message: oauth_error_description.unwrap_or(error),
        });
    }

    let code = code.ok_or_else(|| CoreError::OAuthFlow("callback url missing code".into()))?;
    let state = state.ok_or_else(|| CoreError::OAuthFlow("callback url missing state".into()))?;

    Ok(OAuthCallback { code, state })
}

/// Exchange an authorization code for an OAuth token set.
pub async fn exchange_code_for_tokens(
    config: &RefreshConfig,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse> {
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(config.timeout_secs))
        .connect_timeout(Duration::from_secs(config.connect_timeout_secs))
        .user_agent(config.user_agent.clone());

    if config.force_ipv4 {
        builder = builder.local_address(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
    }

    let client = builder
        .build()
        .map_err(|e| CoreError::Network(format!("client build: {e}")))?;

    let form = [
        ("grant_type", "authorization_code"),
        ("client_id", config.client_id.as_str()),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", code_verifier),
    ];

    let resp = client
        .post(&config.endpoint)
        .form(&form)
        .send()
        .await
        .map_err(|e| CoreError::Network(e.to_string()))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| CoreError::Network(e.to_string()))?;

    if status.is_success() {
        return serde_json::from_str::<TokenResponse>(&body)
            .map_err(|e| CoreError::JsonParse(e.to_string()));
    }

    if status.as_u16() == 429 {
        return Err(CoreError::RateLimited);
    }

    if let Some((code, message)) = parse_oauth_error(&body) {
        return Err(CoreError::TokenRejected { code, message });
    }

    Err(CoreError::OAuthServer {
        status: status.as_u16(),
        body,
    })
}

fn random_urlsafe(len: usize) -> String {
    let mut bytes = vec![0u8; len];
    OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn code_challenge(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash)
}

fn parse_oauth_error(body: &str) -> Option<(String, String)> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let error = value.get("error")?;

    match error {
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
                .unwrap_or("oauth request rejected")
                .to_string();
            Some((code, message))
        }
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
