//! Core logic for the Codex Token -> CLIProxyAPI converter.
//!
//! This crate is transport-agnostic: it knows how to parse input, refresh
//! tokens against the OAuth endpoint, decode JWTs, and build CPA accounts.

pub mod builder;
pub mod config;
pub mod converter;
pub mod error;
pub mod file_config;
pub mod input;
pub mod jwt;
pub mod models;
pub mod oauth;
pub mod refresher;
pub mod transform;
pub mod update;

#[cfg(test)]
mod tests;

pub use config::RefreshConfig;
pub use converter::CodexConverter;
pub use error::{CoreError, Result};
pub use models::{
    AccountTokens, BatchResult, CodexAccount, ConversionError, ProgressEvent, TokenResponse,
    UserInfo,
};
pub use transform::{
    cpa_accounts_to_sub2api, cpa_json_to_sub2api, cpa_to_sub2api_account, split_accounts,
    sub2api_account_to_cpa, sub2api_export_to_cpa, sub2api_json_to_cpa, CpaAccount, SplitAccount,
    SplitResult, Sub2ApiAccount, Sub2ApiCredentials, Sub2ApiExport,
};
pub use update::{ReleaseInfo, UpdateChecker, UpdateStatus};
