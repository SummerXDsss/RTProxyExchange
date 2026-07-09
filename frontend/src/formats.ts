// Client-side format conversion for convert results.
//
// The convert flow produces `CodexAccount` records (full CPA format with nested
// tokens). For copy/download the user can pick an output format:
//   - "cpa": cockpit-tools flat object(s) — what account sellers/CLIProxyAPI use
//   - "sub2api": the Sub2API export wrapper
// These mappers mirror the backend `transform` logic so the browser can convert
// instantly without a round trip.

import type { CodexAccount } from "./types";

/// Output format options offered in copy/download menus.
export type OutputFormat = "cpa" | "sub2api";

export const DEFAULT_SUB2API_CONCURRENCY = 3;
export const DEFAULT_SUB2API_PRIORITY = 50;

/// Flat cockpit-tools / CPA account object.
export interface CockpitAccount {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id: string | null;
  last_refresh: string;
  email: string | null;
  type: string;
  expired: string | null;
}

interface Sub2apiCredentials {
  access_token: string;
  expires_at: string | null;
  refresh_token: string;
  id_token: string;
  email: string | null;
  chatgpt_account_id: string | null;
  chatgpt_user_id: string | null;
  plan_type: string | null;
}

interface Sub2apiAccount {
  name: string | null;
  platform: string;
  type: string;
  credentials: Sub2apiCredentials;
  concurrency: number;
  priority: number;
}

export interface Sub2apiExport {
  exported_at: string;
  proxies: unknown[];
  accounts: Sub2apiAccount[];
  type: string;
  version: number;
}

/// Map a single CodexAccount to the flat cockpit-tools / CPA shape.
export function toCockpit(account: CodexAccount): CockpitAccount {
  return {
    id_token: account.tokens.id_token,
    access_token: account.tokens.access_token,
    refresh_token: account.tokens.refresh_token,
    account_id: account.account_id,
    last_refresh: new Date().toISOString(),
    email: account.email,
    type: "codex",
    expired: account.subscription_active_until,
  };
}

/// Map a single CodexAccount to a Sub2API account entry.
function toSub2apiAccount(account: CodexAccount): Sub2apiAccount {
  return {
    name: account.email,
    platform: "openai",
    type: "oauth",
    credentials: {
      access_token: account.tokens.access_token,
      expires_at: account.subscription_active_until,
      refresh_token: account.tokens.refresh_token,
      id_token: account.tokens.id_token,
      email: account.email,
      chatgpt_account_id: account.account_id,
      chatgpt_user_id: account.user_id,
      plan_type: account.plan_type,
    },
    concurrency: DEFAULT_SUB2API_CONCURRENCY,
    priority: DEFAULT_SUB2API_PRIORITY,
  };
}

/// Wrap CodexAccounts into a Sub2API export document.
export function toSub2apiExport(accounts: CodexAccount[]): Sub2apiExport {
  return {
    exported_at: new Date().toISOString(),
    proxies: [],
    accounts: accounts.map(toSub2apiAccount),
    type: "subdata",
    version: 1,
  };
}

/// Serialize a single account in the chosen format as pretty JSON.
/// CPA is always a single object `{}` (CLIProxyAPI rejects arrays). Sub2API is
/// its standard wrapper object.
export function serializeAccount(account: CodexAccount, format: OutputFormat): string {
  const value =
    format === "cpa" ? toCockpit(account) : toSub2apiExport([account]);
  return JSON.stringify(value, null, 2);
}

/// Serialize accounts for a "batch" action.
/// - sub2api: one wrapper object containing all accounts (valid for upload).
/// - cpa: CLIProxyAPI only accepts a single `{}` per file. A single account is
///   emitted as one object; multiple accounts must be exported per-file instead
///   (see `downloadAccountsSeparately`), so this returns an array purely for
///   clipboard preview and should not be used as an uploadable CPA file.
export function serializeBatch(accounts: CodexAccount[], format: OutputFormat): string {
  if (format === "sub2api") {
    return JSON.stringify(toSub2apiExport(accounts), null, 2);
  }
  // CPA
  const value = accounts.length === 1 ? toCockpit(accounts[0]) : accounts.map(toCockpit);
  return JSON.stringify(value, null, 2);
}

/// Whether a batch action can be a single uploadable file in this format.
export function batchIsSingleFile(accounts: CodexAccount[], format: OutputFormat): boolean {
  // Sub2API always wraps into one file; CPA only when there is exactly one account.
  return format === "sub2api" || accounts.length <= 1;
}

/// Zero-padded local date stamp, e.g. "2026-05-31".
export function dateStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/// Filesystem-safe email (keeps @ . - _, replaces the rest with _).
function sanitizeEmail(email: string | null): string {
  const base = email && email.trim() ? email : "account";
  return base.replace(/[^A-Za-z0-9.@_-]/g, "_");
}

/// Per-account filename: `{email}-{format}-{date}.json`.
export function accountFilename(email: string | null, format: OutputFormat): string {
  return `${sanitizeEmail(email)}-${format}-${dateStamp()}.json`;
}

/// Suggested download filename for a batch in the chosen format.
export function batchFilename(format: OutputFormat): string {
  return format === "cpa"
    ? `accounts-cpa-${dateStamp()}.json`
    : `accounts-sub2api-${dateStamp()}.json`;
}
