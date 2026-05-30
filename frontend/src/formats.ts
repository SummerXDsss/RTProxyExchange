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
    concurrency: 0,
    priority: 0,
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

/// Serialize a batch of accounts in the chosen format as pretty JSON.
export function serializeBatch(accounts: CodexAccount[], format: OutputFormat): string {
  const value =
    format === "cpa" ? accounts.map(toCockpit) : toSub2apiExport(accounts);
  return JSON.stringify(value, null, 2);
}

/// Serialize a single account in the chosen format as pretty JSON.
export function serializeAccount(account: CodexAccount, format: OutputFormat): string {
  const value =
    format === "cpa" ? toCockpit(account) : toSub2apiExport([account]);
  return JSON.stringify(value, null, 2);
}

/// Suggested download filename for a batch in the chosen format.
export function batchFilename(format: OutputFormat): string {
  return format === "cpa" ? "accounts.cpa.json" : "accounts.sub2api.json";
}
