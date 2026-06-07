// Shared types mirroring the backend API contracts.

export interface AccountTokens {
  id_token: string;
  access_token: string;
  refresh_token: string;
}

export interface CodexAccount {
  id: string;
  email: string | null;
  auth_mode: string;
  openai_api_key: string | null;
  api_base_url: string | null;
  api_provider_mode: string;
  user_id: string | null;
  plan_type: string | null;
  subscription_active_until: string | null;
  account_id: string | null;
  organization_id: string | null;
  tokens: AccountTokens;
  token_generation: number;
  token_source_mode: string;
  requires_reauth: boolean;
  quota: unknown | null;
  tags: string[];
  created_at: number;
  last_used: number;
}

export interface ConversionError {
  index: number;
  token_preview: string;
  error: string;
}

export interface BatchResult {
  accounts: CodexAccount[];
  exported_at: string;
  total: number;
  success: number;
  failed: number;
  errors: ConversionError[];
}

export interface DryRunResult {
  total: number;
  token_previews: string[];
}

export interface ConvertRequest {
  input: string;
  timeout_secs?: number;
  concurrency?: number;
  dry_run?: boolean;
}

export interface OAuthStartResponse {
  session_id: string;
  auth_url: string;
  redirect_uri: string;
  expires_in_secs: number;
}

export interface OAuthExchangeResponse {
  refresh_token: string;
  email: string | null;
}

// A batch result has `accounts`; a dry-run result has `token_previews`.
export type ConvertResponse = BatchResult | DryRunResult;

export function isDryRun(r: ConvertResponse): r is DryRunResult {
  return (r as DryRunResult).token_previews !== undefined;
}

/// Effective backend configuration surfaced by GET /api/config.
export interface BackendConfig {
  endpoint: string;
  client_id: string;
  scope: string;
  timeout_secs: number;
  max_retries: number;
  concurrency: number;
  proxy_configured: boolean;
}

/// Progress events streamed over SSE from POST /api/convert/stream.
export type ProgressEvent =
  | { type: "started"; total: number }
  | {
      type: "item";
      index: number;
      token_preview: string;
      ok: boolean;
      email: string | null;
      error: string | null;
      completed: number;
      total: number;
    }
  | { type: "done"; result: BatchResult };

/// One live row in the progress list.
export interface ProgressRow {
  index: number;
  token_preview: string;
  ok: boolean;
  email: string | null;
  error: string | null;
}

/// Direction for the offline format transform.
export type TransformDirection = "sub2api_to_cpa" | "cpa_to_sub2api";

export interface TransformRequest {
  input: string;
  direction: TransformDirection;
}

/// Output format for split account files.
export type SplitFormat = "cpa" | "sub2api";

/// A single split account returned by /api/split.
export interface SplitAccount {
  email: string | null;
  filename_base: string;
  cpa: Record<string, unknown>;
  sub2api: Record<string, unknown>;
}

/// Response from /api/split.
export interface SplitResult {
  total: number;
  accounts: SplitAccount[];
}

/// One release entry in the version history.
export interface ReleaseInfo {
  tag: string;
  version: string;
  name: string | null;
  body: string | null;
  published_at: string | null;
  prerelease: boolean;
  html_url: string | null;
}

/// Update-check result from GET /api/update.
export interface UpdateStatus {
  current_version: string;
  latest_version: string | null;
  update_available: boolean;
  latest_release: ReleaseInfo | null;
  history: ReleaseInfo[];
  error: string | null;
}

/// Per-file CPA upload outcome.
export interface CpaUploadItem {
  name: string;
  ok: boolean;
  error: string | null;
}

/// Aggregated CPA upload response.
export interface CpaUploadResponse {
  total: number;
  success: number;
  failed: number;
  results: CpaUploadItem[];
}

/// A saved run in local history.
export interface HistoryEntry {
  id: string;
  timestamp: number;
  total: number;
  success: number;
  failed: number;
  result: BatchResult;
}
