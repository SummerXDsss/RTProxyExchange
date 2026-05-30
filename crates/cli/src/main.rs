//! Command-line interface for the Codex Token converter.
//!
//! Implements PRD §5.1: convert/import subcommands, output to file or
//! directory, timeout/dry-run flags, and exit codes:
//!   0 = all success, 1 = partial failure, 2 = all failed, 3 = arg error.

mod output;

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use codex_core::{
    config::RefreshConfig, converter::CodexConverter, file_config::FileConfig, input::parse_input,
    models::BatchResult,
};

/// Codex Token -> CLIProxyAPI converter.
#[derive(Parser)]
#[command(name = "codex-converter", version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Convert refresh token(s) into CPA accounts.
    Convert(ConvertArgs),
    /// Import a Sub2API export and convert its Codex OAuth accounts.
    Import(ImportArgs),
    /// Offline format conversion between CPA and Sub2API (no token refresh).
    Transform(TransformArgs),
}

/// Options shared by all conversion commands.
#[derive(Args, Clone)]
struct CommonArgs {
    /// Output file path (writes the aggregated JSON result).
    #[arg(short = 'o', long)]
    output: Option<PathBuf>,
    /// Output directory: write one file per account (batch mode).
    #[arg(short = 'd', long)]
    output_dir: Option<PathBuf>,
    /// Request timeout in seconds.
    #[arg(short = 'T', long)]
    timeout: Option<u64>,
    /// Number of tokens to process concurrently.
    #[arg(short = 'c', long)]
    concurrency: Option<usize>,
    /// Verbose output.
    #[arg(short = 'v', long)]
    verbose: bool,
    /// Parse tokens without performing refresh.
    #[arg(long)]
    dry_run: bool,
}

#[derive(Args)]
struct ConvertArgs {
    /// A single refresh token.
    #[arg(short = 't', long)]
    token: Option<String>,
    /// A file with one refresh token per line.
    #[arg(short = 'f', long)]
    file: Option<PathBuf>,
    #[command(flatten)]
    common: CommonArgs,
}

#[derive(Args)]
struct ImportArgs {
    /// Sub2API export JSON file.
    #[arg(short = 's', long)]
    sub2api: PathBuf,
    #[command(flatten)]
    common: CommonArgs,
}

/// Direction for the offline `transform` subcommand.
#[derive(Clone, Copy, clap::ValueEnum)]
enum Direction {
    /// Sub2API export JSON -> CPA accounts.
    Sub2apiToCpa,
    /// CPA accounts JSON -> Sub2API export.
    CpaToSub2api,
}

#[derive(Args)]
struct TransformArgs {
    /// Conversion direction.
    #[arg(value_enum, short = 'D', long)]
    direction: Direction,
    /// Input JSON file.
    #[arg(short = 'i', long)]
    input: PathBuf,
    /// Output file path (defaults to stdout).
    #[arg(short = 'o', long)]
    output: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli).await {
        Ok(code) => code,
        Err(err) => {
            eprintln!("error: {err:#}");
            ExitCode::from(3)
        }
    }
}

async fn run(cli: Cli) -> Result<ExitCode> {
    // Offline format conversion is handled separately (no refresh, no exit-code
    // semantics tied to success/fail counts).
    if let Command::Transform(args) = &cli.command {
        return run_transform(args);
    }

    let (raw_input, common) = match &cli.command {
        Command::Convert(args) => (gather_convert_input(args)?, args.common.clone()),
        Command::Import(args) => {
            let content = std::fs::read_to_string(&args.sub2api)
                .with_context(|| format!("reading {}", args.sub2api.display()))?;
            (content, args.common.clone())
        }
        Command::Transform(_) => unreachable!("handled above"),
    };

    let tokens = parse_input(&raw_input).context("no usable refresh token found in input")?;

    if common.verbose {
        eprintln!("parsed {} token(s)", tokens.len());
    }

    if common.dry_run {
        for (i, t) in tokens.iter().enumerate() {
            println!("#{i}: {}", codex_core::models::token_preview(t));
        }
        eprintln!("dry-run: {} token(s), no refresh performed", tokens.len());
        return Ok(ExitCode::SUCCESS);
    }

    let config = build_config(&common);
    let converter = CodexConverter::new(config).context("building converter")?;
    let result = converter.convert_batch(&tokens).await;

    report(&result, &common)?;
    write_output(&result, &common)?;

    Ok(exit_code_for(&result))
}

/// Run an offline format conversion (CPA <-> Sub2API).
fn run_transform(args: &TransformArgs) -> Result<ExitCode> {
    let input = std::fs::read_to_string(&args.input)
        .with_context(|| format!("reading {}", args.input.display()))?;

    let output_json = match args.direction {
        Direction::Sub2apiToCpa => {
            let result = codex_core::transform::sub2api_json_to_cpa(&input)
                .context("converting Sub2API -> CPA")?;
            serde_json::to_string_pretty(&result)?
        }
        Direction::CpaToSub2api => {
            let export = codex_core::transform::cpa_json_to_sub2api(&input)
                .context("converting CPA -> Sub2API")?;
            serde_json::to_string_pretty(&export)?
        }
    };

    match &args.output {
        Some(path) => {
            output::write_str_secure(path, &output_json)?;
            eprintln!("wrote {}", path.display());
        }
        None => println!("{output_json}"),
    }
    Ok(ExitCode::SUCCESS)
}

/// Assemble raw input for the convert command from --token or --file.
fn gather_convert_input(args: &ConvertArgs) -> Result<String> {
    match (&args.token, &args.file) {
        (Some(token), None) => Ok(token.clone()),
        (None, Some(path)) => {
            std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))
        }
        (Some(_), Some(_)) => {
            anyhow::bail!("provide either --token or --file, not both")
        }
        (None, None) => anyhow::bail!("one of --token or --file is required"),
    }
}

/// Build a [`RefreshConfig`] from the file config plus CLI overrides.
fn build_config(common: &CommonArgs) -> RefreshConfig {
    let base = RefreshConfig::default();
    let mut config = match FileConfig::load_default() {
        Some(file_cfg) => file_cfg.apply_to(base),
        None => base,
    };
    if let Some(timeout) = common.timeout {
        config.timeout_secs = timeout;
    }
    if let Some(concurrency) = common.concurrency {
        config.concurrency = concurrency.max(1);
    }
    config
}

/// Print a human-readable summary to stderr.
fn report(result: &BatchResult, common: &CommonArgs) -> Result<()> {
    eprintln!(
        "total={} success={} failed={}",
        result.total, result.success, result.failed
    );
    if common.verbose {
        for err in &result.errors {
            eprintln!(
                "  failed #{} ({}): {}",
                err.index, err.token_preview, err.error
            );
        }
    }
    Ok(())
}

/// Write output to a file, a directory of per-account files, or stdout.
fn write_output(result: &BatchResult, common: &CommonArgs) -> Result<()> {
    if let Some(dir) = &common.output_dir {
        output::write_per_account(result, dir)?;
        eprintln!(
            "wrote {} account file(s) to {}",
            result.accounts.len(),
            dir.display()
        );
    } else if let Some(path) = &common.output {
        output::write_json_file(result, path)?;
        eprintln!("wrote {}", path.display());
    } else {
        // Default: pretty JSON to stdout.
        println!("{}", serde_json::to_string_pretty(result)?);
    }
    Ok(())
}

/// Map a batch result to the documented exit code.
fn exit_code_for(result: &BatchResult) -> ExitCode {
    if result.failed == 0 {
        ExitCode::SUCCESS // 0
    } else if result.success > 0 {
        ExitCode::from(1) // partial
    } else {
        ExitCode::from(2) // all failed
    }
}
