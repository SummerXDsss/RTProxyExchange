//! Account-splitting endpoints: split a batch of accounts into per-account
//! files, downloadable individually or as a zip archive.
//!
//! Naming convention: each account file is `codex_{email}.json`. Two output
//! formats are supported: `cpa` (flat cockpit-tools object) and `sub2api`
//! (standalone Sub2API export wrapper).

use std::io::{Cursor, Write};

use axum::{
    body::Body,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use codex_core::transform::{split_accounts, SplitResult};
use serde::Deserialize;
use zip::{write::SimpleFileOptions, ZipWriter};

/// Output format for a split account file.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SplitFormat {
    /// Flat cockpit-tools / CPA object.
    Cpa,
    /// Standalone Sub2API export wrapper.
    Sub2api,
}

impl SplitFormat {
    /// File name suffix distinguishing the two formats inside a zip.
    fn suffix(self) -> &'static str {
        match self {
            SplitFormat::Cpa => "cpa",
            SplitFormat::Sub2api => "sub2api",
        }
    }
}

/// Request body for the split preview endpoint.
#[derive(Debug, Deserialize)]
pub struct SplitRequest {
    /// Raw JSON: a cockpit-tools array/object or a Sub2API export.
    pub input: String,
}

/// Request body for the zip download endpoint.
#[derive(Debug, Deserialize)]
pub struct SplitZipRequest {
    pub input: String,
    /// Which formats to include. If empty, both are included.
    #[serde(default)]
    pub formats: Vec<SplitFormat>,
}

/// Error payload returned to clients.
#[derive(Debug, serde::Serialize)]
struct SplitError {
    error: String,
}

fn bad_request(message: String) -> Response {
    (StatusCode::BAD_REQUEST, Json(SplitError { error: message })).into_response()
}

/// Current UTC date as `YYYY-MM-DD` for filenames.
fn date_stamp() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

/// Filesystem-safe email for a split account, falling back to its file base.
fn email_slug(account: &codex_core::transform::SplitAccount) -> String {
    let raw = account
        .email
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&account.filename_base);
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Parse input and return per-account split metadata + both-format payloads.
pub async fn split(Json(req): Json<SplitRequest>) -> Response {
    let result = tokio::task::spawn_blocking(move || split_accounts(&req.input)).await;
    match result {
        Ok(Ok(result)) => Json(result).into_response(),
        Ok(Err(e)) => bad_request(e.to_string()),
        Err(e) => bad_request(format!("split task failed: {e}")),
    }
}

/// Parse input and build zip off the async runtime worker.
fn split_and_zip(input: String, formats: Vec<SplitFormat>) -> Result<Vec<u8>, String> {
    let result = split_accounts(&input).map_err(|e| e.to_string())?;
    build_zip(&result, &formats).map_err(|e| format!("failed to build zip: {e}"))
}

/// Serialize a [`SplitResult`] into a zip archive of per-account JSON files.
fn build_zip(result: &SplitResult, formats: &[SplitFormat]) -> std::io::Result<Vec<u8>> {
    let formats: Vec<SplitFormat> = if formats.is_empty() {
        vec![SplitFormat::Cpa, SplitFormat::Sub2api]
    } else {
        formats.to_vec()
    };
    let both = formats.len() > 1;

    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut buf);
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o600);

        for account in &result.accounts {
            for &format in &formats {
                // File name: {email}-{format}-{date}.json. When both formats are
                // requested, group into per-format subfolders to avoid clashes.
                let leaf = format!(
                    "{}-{}-{}.json",
                    email_slug(account),
                    format.suffix(),
                    date_stamp()
                );
                let name = if both {
                    format!("{}/{}", format.suffix(), leaf)
                } else {
                    leaf
                };

                let json = match format {
                    SplitFormat::Cpa => serde_json::to_string_pretty(&account.cpa),
                    SplitFormat::Sub2api => serde_json::to_string_pretty(&account.sub2api),
                }
                .unwrap_or_else(|_| "{}".to_string());

                zip.start_file(name, options)?;
                zip.write_all(json.as_bytes())?;
            }
        }
        zip.finish()?;
    }
    Ok(buf.into_inner())
}

/// Split accounts and stream back a zip archive for batch download.
pub async fn split_zip(Json(req): Json<SplitZipRequest>) -> Response {
    let result = tokio::task::spawn_blocking(move || split_and_zip(req.input, req.formats)).await;
    match result {
        Ok(Ok(bytes)) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/zip".to_string()),
                (
                    header::CONTENT_DISPOSITION,
                    "attachment; filename=\"codex_accounts.zip\"".to_string(),
                ),
            ],
            Body::from(bytes),
        )
            .into_response(),
        Ok(Err(e)) => bad_request(e),
        Err(e) => bad_request(format!("zip task failed: {e}")),
    }
}
