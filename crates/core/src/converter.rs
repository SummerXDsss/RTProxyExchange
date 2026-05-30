//! High-level orchestration: refresh token -> user info -> CPA account.
//!
//! Batch conversion is concurrent (bounded by `RefreshConfig::concurrency`) but
//! deduplication is applied deterministically in original input order so results
//! are reproducible regardless of completion order.

use std::collections::HashMap;

use chrono::Utc;
use futures::stream::{self, StreamExt};
use tokio::sync::mpsc;

use crate::builder::build_codex_account;
use crate::config::RefreshConfig;
use crate::error::Result;
use crate::jwt::extract_user_info;
use crate::models::{token_preview, BatchResult, CodexAccount, ConversionError, ProgressEvent};
use crate::refresher::TokenRefresher;

/// Internal per-token outcome carrying the original index for ordered merging.
struct Outcome {
    index: usize,
    token_preview: String,
    result: Result<CodexAccount>,
}

/// Top-level converter combining refresh, extraction and account building.
#[derive(Clone)]
pub struct CodexConverter {
    refresher: TokenRefresher,
    concurrency: usize,
}

impl CodexConverter {
    /// Construct a converter with the given refresh configuration.
    pub fn new(config: RefreshConfig) -> Result<Self> {
        let concurrency = config.concurrency.max(1);
        Ok(Self {
            refresher: TokenRefresher::new(config)?,
            concurrency,
        })
    }

    /// Convert a single refresh token into a CPA account.
    pub async fn convert_token(&self, refresh_token: &str) -> Result<CodexAccount> {
        let tokens = self.refresher.refresh(refresh_token).await?;
        let info = extract_user_info(&tokens);
        Ok(build_codex_account(refresh_token, &tokens, &info))
    }

    /// Convert a batch of refresh tokens concurrently, deduplicating by account
    /// id and aggregating per-token errors.
    pub async fn convert_batch(&self, tokens: &[String]) -> BatchResult {
        let mut outcomes = self.run_concurrent(tokens, None).await;
        outcomes.sort_by_key(|o| o.index);
        assemble(tokens.len(), outcomes)
    }

    /// Convert a batch concurrently, emitting [`ProgressEvent`]s on `sink` as
    /// each token completes. A final [`ProgressEvent::Done`] carries the full
    /// aggregated result.
    pub async fn convert_batch_streaming(
        &self,
        tokens: &[String],
        sink: mpsc::Sender<ProgressEvent>,
    ) {
        let total = tokens.len();
        let _ = sink.send(ProgressEvent::Started { total }).await;

        let mut outcomes = self.run_concurrent(tokens, Some(sink.clone())).await;
        outcomes.sort_by_key(|o| o.index);
        let result = assemble(total, outcomes);

        let _ = sink.send(ProgressEvent::Done { result }).await;
    }

    /// Run the refresh+build pipeline over all tokens with bounded concurrency.
    /// When `sink` is provided, an [`ProgressEvent::Item`] is emitted per token.
    async fn run_concurrent(
        &self,
        tokens: &[String],
        sink: Option<mpsc::Sender<ProgressEvent>>,
    ) -> Vec<Outcome> {
        let total = tokens.len();
        let completed = std::sync::atomic::AtomicUsize::new(0);
        let completed = &completed;
        let sink = &sink;

        stream::iter(tokens.iter().cloned().enumerate())
            .map(|(index, token)| async move {
                let result = self.convert_token(&token).await;
                let preview = token_preview(&token);

                if let Some(tx) = sink {
                    let done = completed.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    let event = match &result {
                        Ok(account) => ProgressEvent::Item {
                            index,
                            token_preview: preview.clone(),
                            ok: true,
                            email: account.email.clone(),
                            error: None,
                            completed: done,
                            total,
                        },
                        Err(err) => ProgressEvent::Item {
                            index,
                            token_preview: preview.clone(),
                            ok: false,
                            email: None,
                            error: Some(err.to_string()),
                            completed: done,
                            total,
                        },
                    };
                    let _ = tx.send(event).await;
                }

                Outcome {
                    index,
                    token_preview: preview,
                    result,
                }
            })
            .buffer_unordered(self.concurrency)
            .collect()
            .await
    }
}

/// Merge index-ordered outcomes into a deduplicated [`BatchResult`].
fn assemble(total: usize, outcomes: Vec<Outcome>) -> BatchResult {
    let mut accounts: Vec<CodexAccount> = Vec::new();
    let mut index_by_id: HashMap<String, usize> = HashMap::new();
    let mut errors: Vec<ConversionError> = Vec::new();

    for outcome in outcomes {
        match outcome.result {
            Ok(account) => merge_account(&mut accounts, &mut index_by_id, account),
            Err(err) => errors.push(ConversionError {
                index: outcome.index,
                token_preview: outcome.token_preview,
                error: err.to_string(),
            }),
        }
    }

    let success = accounts.len();
    BatchResult {
        accounts,
        exported_at: Utc::now().to_rfc3339(),
        total,
        success,
        failed: errors.len(),
        errors,
    }
}

/// Insert or update an account by its dedup id, preserving an old refresh token
/// when the incoming one is empty.
fn merge_account(
    accounts: &mut Vec<CodexAccount>,
    index_by_id: &mut HashMap<String, usize>,
    incoming: CodexAccount,
) {
    if let Some(&idx) = index_by_id.get(&incoming.id) {
        let existing = &mut accounts[idx];
        let preserved_refresh = if incoming.tokens.refresh_token.trim().is_empty() {
            existing.tokens.refresh_token.clone()
        } else {
            incoming.tokens.refresh_token.clone()
        };
        existing.tokens = incoming.tokens;
        existing.tokens.refresh_token = preserved_refresh;
        existing.last_used = incoming.last_used;
        existing.token_generation += 1;
    } else {
        index_by_id.insert(incoming.id.clone(), accounts.len());
        accounts.push(incoming);
    }
}
