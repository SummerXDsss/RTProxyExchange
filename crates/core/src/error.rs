//! Error types for the Codex Token converter core.

use thiserror::Error;

/// Result alias used across the core crate.
pub type Result<T> = std::result::Result<T, CoreError>;

/// Errors that can occur during token conversion.
#[derive(Debug, Error)]
pub enum CoreError {
    /// The refresh token was rejected by the OAuth endpoint. Carries the real
    /// OAuth error `code` and human-readable `message` when available.
    #[error("{message}")]
    TokenRejected { code: String, message: String },

    /// The OAuth server returned an error status.
    #[error("oauth server error: {status} {body}")]
    OAuthServer { status: u16, body: String },

    /// Rate limited by the OAuth endpoint.
    #[error("rate limited by oauth endpoint")]
    RateLimited,

    /// A network-level failure occurred (timeout, DNS, connection).
    #[error("network error: {0}")]
    Network(String),

    /// Failed to decode a JWT payload.
    #[error("failed to decode jwt: {0}")]
    JwtDecode(String),

    /// Failed to parse JSON input.
    #[error("failed to parse json: {0}")]
    JsonParse(String),

    /// The input did not contain a usable refresh token.
    #[error("no refresh token found in input")]
    NoRefreshToken,
}

impl CoreError {
    /// Whether this error class is worth retrying.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            CoreError::Network(_) | CoreError::RateLimited | CoreError::OAuthServer { .. }
        )
    }

    /// The OAuth error code, when this is a rejection (e.g. `refresh_token_reused`).
    pub fn oauth_code(&self) -> Option<&str> {
        match self {
            CoreError::TokenRejected { code, .. } => Some(code.as_str()),
            _ => None,
        }
    }
}
