//! Secure output writing for converted accounts.
//!
//! Per PRD §3.2, output files are created with mode 0600 (owner read/write
//! only) on Unix so that token material is not world-readable.

use std::fs::File;
use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result};
use codex_core::models::{BatchResult, CodexAccount};

/// Write the full batch result as pretty JSON to `path` with 0600 perms.
pub fn write_json_file(result: &BatchResult, path: &Path) -> Result<()> {
    let json = serde_json::to_string_pretty(result)?;
    write_secure(path, json.as_bytes())
}

/// Write an arbitrary string to `path` with 0600 perms.
pub fn write_str_secure(path: &Path, contents: &str) -> Result<()> {
    write_secure(path, contents.as_bytes())
}

/// Write one JSON file per account into `dir`, named by account id.
pub fn write_per_account(result: &BatchResult, dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)
        .with_context(|| format!("creating directory {}", dir.display()))?;
    for account in &result.accounts {
        let file_name = format!("{}.json", account_slug(account));
        let path = dir.join(file_name);
        let json = serde_json::to_string_pretty(account)?;
        write_secure(&path, json.as_bytes())?;
    }
    Ok(())
}

/// Choose a filesystem-friendly name for an account.
fn account_slug(account: &CodexAccount) -> String {
    if let Some(email) = &account.email {
        let safe: String = email
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '.' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        if !safe.is_empty() {
            return safe;
        }
    }
    // Fall back to a short prefix of the dedup id.
    account.id.chars().take(16).collect()
}

/// Write bytes to a file, restricting permissions to 0600 on Unix.
fn write_secure(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = File::create(path).with_context(|| format!("creating {}", path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        file.set_permissions(perms)
            .with_context(|| format!("setting permissions on {}", path.display()))?;
    }

    file.write_all(bytes)
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}
