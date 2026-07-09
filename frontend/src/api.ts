import type {
  BackendConfig,
  ApplyUpdateResponse,
  ConvertRequest,
  ConvertResponse,
  CpaUploadResponse,
  OAuthExchangeResponse,
  OAuthStartResponse,
  ProgressEvent,
  SplitFormat,
  SplitResult,
  Sub2ApiGroup,
  Sub2ApiImportResponse,
  Sub2ApiLoginResponse,
  TransformRequest,
  UpdateStatus,
} from "./types";

/// Read the server error message from a non-2xx response.
async function errorMessage(resp: Response): Promise<string> {
  let message = `请求失败 (${resp.status})`;
  try {
    const body = await resp.json();
    if (body?.error) message = body.error;
  } catch {
    // keep generic message
  }
  return message;
}

/// Call the non-streaming convert endpoint (used for dry-run / single login).
export async function convert(req: ConvertRequest): Promise<ConvertResponse> {
  const resp = await fetch("/api/convert", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  return resp.json();
}

/// Fetch effective backend config (no client_id; that is internal).
export async function fetchConfig(): Promise<BackendConfig> {
  const resp = await fetch("/api/config");
  if (!resp.ok) throw new Error(await errorMessage(resp));
  return resp.json();
}

/// Start manual Codex OAuth. The backend only creates PKCE state and returns
/// the browser auth URL; users paste the final callback URL back for exchange.
export async function oauthStart(): Promise<OAuthStartResponse> {
  const resp = await fetch("/api/oauth/start", { method: "POST" });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  return resp.json();
}

/// Exchange a pasted localhost callback URL for a refresh token.
export async function oauthExchange(
  sessionId: string,
  callbackUrl: string,
): Promise<OAuthExchangeResponse> {
  const resp = await fetch("/api/oauth/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, callback_url: callbackUrl }),
  });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  return resp.json();
}

/// Offline format conversion between CPA and Sub2API. Returns the converted
/// document as a generic JSON value (CPA BatchResult or Sub2API export).
export async function transform(req: TransformRequest): Promise<unknown> {
  const resp = await fetch("/api/transform", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  return resp.json();
}

/// Split a batch of accounts into per-account entries (both formats included).
export async function splitAccounts(input: string): Promise<SplitResult> {
  const resp = await fetch("/api/split", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  return resp.json();
}

/// Download a zip of all split accounts in the requested formats.
export async function downloadSplitZip(
  input: string,
  formats: SplitFormat[],
): Promise<Blob> {
  const resp = await fetch("/api/split/zip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, formats }),
  });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  return resp.blob();
}

/// Check for updates against the project's GitHub releases/tags.
export async function checkUpdate(refresh = false): Promise<UpdateStatus> {
  const resp = await fetch(`/api/update${refresh ? "?refresh=1" : ""}`);
  if (!resp.ok) throw new Error(await errorMessage(resp));
  return resp.json();
}

/// Ask the backend container to start the self-update helper.
export async function applyUpdate(): Promise<ApplyUpdateResponse> {
  const resp = await fetch("/api/update/apply", { method: "POST" });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  return resp.json();
}

/// Test connectivity + management auth against a CLIProxyAPI instance.
export async function cpaTest(
  baseUrl: string,
  managementKey: string,
): Promise<{ ok: boolean; cpa_version?: string }> {
  const resp = await fetch("/api/cpa/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_url: baseUrl, management_key: managementKey }),
  });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  return resp.json();
}

/// Upload one or more CPA account files to a CLIProxyAPI instance.
export async function cpaUpload(
  baseUrl: string,
  managementKey: string,
  files: { name: string; content: unknown }[],
): Promise<CpaUploadResponse> {
  const resp = await fetch("/api/cpa/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_url: baseUrl, management_key: managementKey, files }),
  });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  return resp.json();
}

/// Test connectivity + admin auth against a Sub2API instance.
export async function sub2apiTest(
  baseUrl: string,
  adminKey: string,
): Promise<{ ok: boolean }> {
  const resp = await fetch("/api/sub2api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_url: baseUrl, admin_key: adminKey }),
  });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  return resp.json();
}

/// Login to Sub2API with an admin account and return a JWT.
export async function sub2apiLogin(
  baseUrl: string,
  email: string,
  password: string,
): Promise<Sub2ApiLoginResponse> {
  const resp = await fetch("/api/sub2api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_url: baseUrl, email, password }),
  });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  return resp.json();
}

/// List OpenAI groups from Sub2API using Admin API Key or admin JWT.
export async function sub2apiGroups(
  baseUrl: string,
  adminKey: string,
): Promise<Sub2ApiGroup[]> {
  const resp = await fetch("/api/sub2api/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_url: baseUrl, admin_key: adminKey }),
  });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  const body = await resp.json();
  return body.groups ?? [];
}

/// Extract access_token values from AT-only JSON and create Sub2API OpenAI OAuth accounts.
export async function sub2apiImportAt(
  baseUrl: string,
  adminKey: string,
  input: string,
  groupIds: number[] = [],
): Promise<Sub2ApiImportResponse> {
  const resp = await fetch("/api/sub2api/import-at", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_url: baseUrl, admin_key: adminKey, input, group_ids: groupIds }),
  });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  return resp.json();
}

/// Extract api_key values and create Sub2API OpenAI API Key accounts.
export async function sub2apiImportApiKeys(
  baseUrl: string,
  adminKey: string,
  input: string,
  groupIds: number[] = [],
): Promise<Sub2ApiImportResponse> {
  const resp = await fetch("/api/sub2api/import-api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_url: baseUrl, admin_key: adminKey, input, group_ids: groupIds }),
  });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  return resp.json();
}

/// Refresh RTs and upload the refreshed OpenAI OAuth accounts to Sub2API.
export async function sub2apiImportRefreshTokens(
  baseUrl: string,
  adminKey: string,
  input: string,
  groupIds: number[] = [],
): Promise<Sub2ApiImportResponse> {
  const resp = await fetch("/api/sub2api/import-refresh-tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_url: baseUrl, admin_key: adminKey, input, group_ids: groupIds }),
  });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  return resp.json();
}

/// Stream a batch conversion via SSE, invoking `onEvent` for each progress
/// event. Resolves when the `done` event arrives or the stream closes.
///
/// Implemented with fetch + ReadableStream (rather than EventSource) so we can
/// POST a JSON body and keep the refresh token out of the URL.
export async function convertStream(
  req: ConvertRequest,
  onEvent: (event: ProgressEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await fetch("/api/convert/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  if (!resp.body) throw new Error("服务器未返回流式响应");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = parseDataLine(frame);
      if (data) {
        try {
          onEvent(JSON.parse(data) as ProgressEvent);
        } catch {
          // ignore malformed frame
        }
      }
    }
  }
}

/// Extract the concatenated `data:` payload from one SSE frame.
function parseDataLine(frame: string): string | null {
  const lines = frame.split("\n");
  const dataParts = lines
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trimStart());
  return dataParts.length ? dataParts.join("\n") : null;
}
