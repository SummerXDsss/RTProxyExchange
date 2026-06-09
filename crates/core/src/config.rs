//! Configuration for the OAuth/token refresh flow.

/// Default OAuth token endpoint.
pub const DEFAULT_OAUTH_ENDPOINT: &str = "https://auth.openai.com/oauth/token";
/// Built-in OAuth client id for codex-cli.
///
/// This is **not** a per-user credential or secret: it is a fixed public
/// constant shared by every official codex-cli install. OpenAI's token
/// endpoint requires it on the refresh grant, so it is baked in here and never
/// exposed in the UI or CLI. Users authenticate with a refresh token alone.
pub const DEFAULT_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
/// Default scope requested during refresh.
pub const DEFAULT_SCOPE: &str = "openid profile email";
/// User agent that mimics the official codex-cli client.
pub const DEFAULT_USER_AGENT: &str = "codex-cli/0.91.0";
/// Default request timeout, seconds.
pub const DEFAULT_TIMEOUT_SECS: u64 = 25;
/// Default connection-establishment timeout, seconds. Kept short so a broken
/// route (e.g. blackholed IPv6) fails fast instead of waiting the full request
/// timeout before trying the next address.
pub const DEFAULT_CONNECT_TIMEOUT_SECS: u64 = 6;
/// Default max retry attempts for retryable errors.
pub const DEFAULT_MAX_RETRIES: u32 = 2;
/// Default number of tokens processed concurrently.
pub const DEFAULT_CONCURRENCY: usize = 32;

/// Runtime configuration for token refresh requests.
#[derive(Debug, Clone)]
pub struct RefreshConfig {
    pub endpoint: String,
    pub client_id: String,
    pub scope: String,
    pub user_agent: String,
    pub timeout_secs: u64,
    /// Connection-establishment timeout (separate from the overall request
    /// timeout) so unreachable addresses fail fast.
    pub connect_timeout_secs: u64,
    pub max_retries: u32,
    /// Force IPv4 for outbound requests. Avoids stalls when the host has a
    /// broken/blackholed IPv6 route to a dual-stack CDN (e.g. Cloudflare).
    pub force_ipv4: bool,
    /// Maximum number of tokens refreshed in parallel during batch conversion.
    pub concurrency: usize,
}

impl Default for RefreshConfig {
    fn default() -> Self {
        Self {
            endpoint: DEFAULT_OAUTH_ENDPOINT.to_string(),
            client_id: DEFAULT_CLIENT_ID.to_string(),
            scope: DEFAULT_SCOPE.to_string(),
            user_agent: DEFAULT_USER_AGENT.to_string(),
            timeout_secs: DEFAULT_TIMEOUT_SECS,
            connect_timeout_secs: DEFAULT_CONNECT_TIMEOUT_SECS,
            max_retries: DEFAULT_MAX_RETRIES,
            force_ipv4: true,
            concurrency: DEFAULT_CONCURRENCY,
        }
    }
}
