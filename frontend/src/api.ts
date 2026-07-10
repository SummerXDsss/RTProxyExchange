import type {
  BackendConfig,
  ApplyUpdateResponse,
  BatchResult,
  CodexAccount,
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
  TransformZipFile,
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

/// Batch offline transform and download the converted JSON files as a zip.
export async function transformZip(
  direction: TransformRequest["direction"],
  files: TransformZipFile[],
): Promise<Blob> {
  const resp = await fetch("/api/transform/zip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ direction, files }),
  });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  return resp.blob();
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
  const base = normalizeRemoteBase(baseUrl, "CLIProxyAPI 地址", ["/v0/management"]);
  const resp = await directFetch(
    `${base}/v0/management/latest-version`,
    { headers: { Authorization: `Bearer ${managementKey}` } },
    "CLIProxyAPI",
  );
  if (!resp.ok) {
    if (resp.status === 401) throw new Error("管理密钥无效或缺失");
    if (resp.status === 403) throw new Error("CLIProxyAPI 未开启远程管理");
    if (resp.status === 404) throw new Error("未配置管理密钥，或地址不是 CLIProxyAPI 管理接口");
    throw new Error(await remoteErrorMessage(resp, "CLIProxyAPI"));
  }
  const body = await safeJson(resp);
  const version = readStringField(body, "latest-version");
  return { ok: true, cpa_version: version ?? undefined };
}

/// Upload one or more CPA account files to a CLIProxyAPI instance.
export async function cpaUpload(
  baseUrl: string,
  managementKey: string,
  files: { name: string; content: unknown }[],
): Promise<CpaUploadResponse> {
  const base = normalizeRemoteBase(baseUrl, "CLIProxyAPI 地址", ["/v0/management"]);
  if (files.length === 0) throw new Error("没有要上传的文件");

  const results = await Promise.all(
    files.map(async (file) => {
      const name = sanitizeUploadName(file.name);
      const url = `${base}/v0/management/auth-files?${new URLSearchParams({ name })}`;
      try {
        const resp = await directFetch(
          url,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${managementKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(file.content),
          },
          "CLIProxyAPI",
        );
        if (resp.ok) return { name, ok: true, error: null };
        return { name, ok: false, error: await remoteErrorMessage(resp, "CLIProxyAPI") };
      } catch (e) {
        return { name, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );

  const success = results.filter((r) => r.ok).length;
  return { total: results.length, success, failed: results.length - success, results };
}

/// Test connectivity + admin auth against a Sub2API instance.
export async function sub2apiTest(
  baseUrl: string,
  adminKey: string,
): Promise<{ ok: boolean }> {
  const base = normalizeSub2ApiBase(baseUrl);
  const resp = await directFetch(
    `${base}/api/v1/admin/accounts?page=1&page_size=1`,
    { headers: sub2ApiAuthHeaders(adminKey) },
    "Sub2API",
  );
  if (!resp.ok) {
    if (resp.status === 401) throw new Error("Sub2API Admin Key / JWT 无效");
    if (resp.status === 403) throw new Error("当前凭据没有管理员权限");
    throw new Error(await remoteErrorMessage(resp, "Sub2API"));
  }
  return { ok: true };
}

/// Login to Sub2API with an admin account and return a JWT.
export async function sub2apiLogin(
  baseUrl: string,
  email: string,
  password: string,
): Promise<Sub2ApiLoginResponse> {
  const base = normalizeSub2ApiBase(baseUrl);
  const resp = await directFetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  }, "Sub2API");
  if (!resp.ok) throw new Error(await remoteErrorMessage(resp, "Sub2API 登录"));

  const body = await safeJson(resp);
  assertSub2ApiOk(body);
  const data = responseData(body);
  const accessToken = readStringField(data, "access_token");
  if (!accessToken) throw new Error("Sub2API 未返回 access_token");
  const user = isRecord(data) && isRecord(data.user) ? data.user : {};
  return {
    access_token: accessToken,
    token_type: readStringField(data, "token_type"),
    email: readStringField(user, "email"),
    role: readStringField(user, "role"),
  };
}

/// List OpenAI groups from Sub2API using Admin API Key or admin JWT.
export async function sub2apiGroups(
  baseUrl: string,
  adminKey: string,
): Promise<Sub2ApiGroup[]> {
  const base = normalizeSub2ApiBase(baseUrl);
  const resp = await directFetch(
    `${base}/api/v1/admin/groups/all?platform=openai`,
    { headers: sub2ApiAuthHeaders(adminKey) },
    "Sub2API",
  );
  if (!resp.ok) throw new Error(await remoteErrorMessage(resp, "Sub2API 分组"));
  const body = await safeJson(resp);
  assertSub2ApiOk(body);
  const data = responseData(body);
  const items = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.groups)
      ? data.groups
      : [];
  return items.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = Number(item.id);
    if (!Number.isFinite(id)) return [];
    return [{
      id,
      name: readStringField(item, "name") ?? "未命名分组",
      platform: readStringField(item, "platform"),
      status: readStringField(item, "status"),
    }];
  });
}

/// Extract access_token values from AT-only JSON and create Sub2API OpenAI OAuth accounts.
export async function sub2apiImportAt(
  baseUrl: string,
  adminKey: string,
  input: string,
  groupIds: number[] = [],
  options: { accountConcurrency?: number; priority?: number } = {},
): Promise<Sub2ApiImportResponse> {
  const tokens = extractAccessTokens(input);
  if (tokens.length === 0) throw new Error("没有找到 access_token");
  const accountOptions = normalizeSub2AccountOptions(options);
  const accounts = tokens.map((token, index) => buildAccessTokenAccount(index, token, accountOptions));
  return sub2apiUploadAccountDrafts(baseUrl, adminKey, accounts, groupIds);
}

/// Extract api_key values and create Sub2API OpenAI API Key accounts.
export async function sub2apiImportApiKeys(
  baseUrl: string,
  adminKey: string,
  input: string,
  groupIds: number[] = [],
  options: { accountConcurrency?: number; priority?: number } = {},
): Promise<Sub2ApiImportResponse> {
  const keys = extractApiKeys(input);
  if (keys.length === 0) throw new Error("没有找到 api_key");
  const accountOptions = normalizeSub2AccountOptions(options);
  const accounts = keys.map((key, index) => buildApiKeyAccount(index, key, accountOptions));
  return sub2apiUploadAccountDrafts(baseUrl, adminKey, accounts, groupIds);
}

/// Refresh RTs and upload the refreshed OpenAI OAuth accounts to Sub2API.
export async function sub2apiImportRefreshTokens(
  baseUrl: string,
  adminKey: string,
  input: string,
  groupIds: number[] = [],
  options: { accountConcurrency?: number; priority?: number } = {},
): Promise<Sub2ApiImportResponse> {
  const converted = await convert({ input, concurrency: 32 });
  if (!("accounts" in converted)) throw new Error("RT 刷新没有返回结果");
  const batch: BatchResult = converted;

  const accountOptions = normalizeSub2AccountOptions(options);
  const accounts = batch.accounts.map((account, index) =>
    buildRefreshedAccount(index, account, accountOptions),
  );
  const upload = accounts.length > 0
    ? await sub2apiUploadAccountDrafts(baseUrl, adminKey, accounts, groupIds)
    : emptySub2ImportResponse();
  const refreshErrors = batch.errors.map((err) => ({
    name: err.token_preview,
    ok: false,
    email: null,
    expires_at: null,
    error: err.error,
  }));
  return aggregateSub2Results([...upload.results, ...refreshErrors]);
}

type JsonRecord = Record<string, unknown>;

interface Sub2ApiAccountOptions {
  concurrency: number;
  priority: number;
}

interface Sub2ApiAccountDraft {
  name: string;
  email: string | null;
  expires_at: string | null;
  payload: JsonRecord;
}

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

function normalizeRemoteBase(raw: string, label: string, suffixes: string[]): string {
  let trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error(`${label}不能为空`);
  if (!/^https?:\/\//i.test(trimmed)) throw new Error(`${label}必须以 http:// 或 https:// 开头`);
  for (const suffix of suffixes) {
    if (trimmed.endsWith(suffix)) {
      trimmed = trimmed.slice(0, -suffix.length);
      break;
    }
  }
  return trimmed;
}

function normalizeSub2ApiBase(raw: string): string {
  return normalizeRemoteBase(raw, "Sub2API 地址", [
    "/api/v1/admin/accounts/batch",
    "/api/v1/admin/accounts",
    "/api/v1/admin",
    "/api/v1",
    "/admin",
  ]);
}

async function directFetch(url: string, init: RequestInit, target: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `${target} 直连失败：${detail}。请确认目标服务已允许浏览器跨域访问（CORS），并且当前页面协议可以访问目标地址。`,
    );
  }
}

async function remoteErrorMessage(resp: Response, target: string): Promise<string> {
  const fallback = `${target} 返回 ${resp.status}`;
  const text = await resp.text().catch(() => "");
  if (!text.trim()) return fallback;
  try {
    const value = JSON.parse(text);
    return extractRemoteMessage(value) ?? fallback;
  } catch {
    return text.trim() || fallback;
  }
}

async function safeJson(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readStringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : null;
}

function extractRemoteMessage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const key of ["message", "error", "detail"]) {
    const message = readStringField(value, key);
    if (message) return message;
  }
  return isRecord(value.data) ? extractRemoteMessage(value.data) : null;
}

function responseData(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return value.data ?? value;
}

function assertSub2ApiOk(value: unknown): void {
  if (!isRecord(value)) return;
  const code = typeof value.code === "number" ? value.code : null;
  if (code !== null && code !== 0) {
    throw new Error(extractRemoteMessage(value) ?? `Sub2API 返回错误 code=${code}`);
  }
}

function sub2ApiAuthHeaders(credential: string): Record<string, string> {
  const trimmed = credential.trim();
  const token = trimmed.match(/^bearer\s+(.+)$/i)?.[1];
  return token ? { Authorization: `Bearer ${token}` } : { "x-api-key": trimmed };
}

function sanitizeUploadName(raw: string): string {
  const base = raw.split(/[\\/]/).pop()?.trim() || "account";
  return base.endsWith(".json") ? base : `${base}.json`;
}

function normalizeSub2AccountOptions(
  options: { accountConcurrency?: number; priority?: number },
): Sub2ApiAccountOptions {
  return {
    concurrency: typeof options.accountConcurrency === "number" && Number.isFinite(options.accountConcurrency)
      ? options.accountConcurrency
      : 3,
    priority: typeof options.priority === "number" && Number.isFinite(options.priority)
      ? options.priority
      : 50,
  };
}

function extractAccessTokens(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("AT JSON 不能为空");

  const tokens: string[] = [];
  const whole = parseJson(trimmed);
  if (whole !== null) {
    collectAccessTokens(whole, false, true, tokens);
  } else {
    for (const line of trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      const value = parseJson(line);
      if (value !== null) collectAccessTokens(value, false, true, tokens);
      else if (looksLikeToken(line)) tokens.push(line);
    }
  }
  return dedupe(tokens.map(stripBearer).filter(Boolean));
}

function extractApiKeys(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("API Key 不能为空");

  const keys: string[] = [];
  const whole = parseJson(trimmed);
  if (whole !== null) {
    collectApiKeys(whole, false, true, keys);
  } else {
    for (const line of trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      const value = parseJson(line);
      if (value !== null) collectApiKeys(value, false, true, keys);
      else if (looksLikeApiKey(line)) keys.push(line);
    }
  }
  return dedupe(keys.map((key) => key.trim()).filter(Boolean));
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectAccessTokens(
  value: unknown,
  keyIsAccessToken: boolean,
  looseStringToken: boolean,
  out: string[],
): void {
  if (typeof value === "string") {
    if (keyIsAccessToken || (looseStringToken && looksLikeToken(value))) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectAccessTokens(item, keyIsAccessToken, looseStringToken, out));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const isAccessToken = keyIsAccessToken || normalizedKey(key) === "accesstoken";
    collectAccessTokens(item, isAccessToken, false, out);
  }
}

function collectApiKeys(
  value: unknown,
  keyIsApiKey: boolean,
  looseStringKey: boolean,
  out: string[],
): void {
  if (typeof value === "string") {
    if (keyIsApiKey || (looseStringKey && looksLikeApiKey(value))) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectApiKeys(item, keyIsApiKey, looseStringKey, out));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    const isApiKey = keyIsApiKey || normalized === "apikey" || normalized === "openaiapikey";
    collectApiKeys(item, isApiKey, false, out);
  }
}

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function stripBearer(raw: string): string {
  return raw.trim().replace(/^bearer\s+/i, "").trim();
}

function looksLikeToken(raw: string): boolean {
  const token = stripBearer(raw);
  return token.length > 40 && token.split(".").length === 3;
}

function looksLikeApiKey(raw: string): boolean {
  const key = raw.trim();
  return key.length >= 20 && (key.startsWith("sk-") || key.startsWith("sess-"));
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function buildAccessTokenAccount(
  index: number,
  accessToken: string,
  options: Sub2ApiAccountOptions,
): Sub2ApiAccountDraft {
  const claims = decodeJwtPayload(accessToken);
  const email = lookupClaim(claims, ["email"]);
  const userId = lookupClaim(claims, ["chatgpt_user_id", "user_id", "sub"]);
  const accountId = lookupClaim(claims, ["chatgpt_account_id"]);
  const organizationId = lookupClaim(claims, ["poid", "organization_id"]);
  const planType = lookupClaim(claims, ["chatgpt_plan_type", "plan_type"]);
  const exp = isRecord(claims) && typeof claims.exp === "number" ? claims.exp : null;
  const expiresAt = exp ? new Date(exp * 1000).toISOString() : null;
  const fallbackName = userId || accountId ? `codex-${userId ?? accountId}` : `codex-at-${index + 1}`;
  const name = email ?? fallbackName;

  const credentials: JsonRecord = { access_token: accessToken };
  if (expiresAt) credentials.expires_at = expiresAt;
  if (email) credentials.email = email;
  if (accountId) credentials.chatgpt_account_id = accountId;
  if (userId) credentials.chatgpt_user_id = userId;
  if (organizationId) credentials.organization_id = organizationId;
  if (planType) credentials.plan_type = planType;

  return {
    name,
    email,
    expires_at: expiresAt,
    payload: buildSub2ApiPayload(name, "oauth", credentials, options),
  };
}

function buildApiKeyAccount(
  index: number,
  apiKey: string,
  options: Sub2ApiAccountOptions,
): Sub2ApiAccountDraft {
  const name = `openai-apikey-${maskSecretTail(apiKey, index + 1)}`;
  return {
    name,
    email: null,
    expires_at: null,
    payload: buildSub2ApiPayload(name, "apikey", { api_key: apiKey }, options),
  };
}

function buildRefreshedAccount(
  index: number,
  account: CodexAccount,
  options: Sub2ApiAccountOptions,
): Sub2ApiAccountDraft {
  const name = account.email?.trim()
    ? account.email
    : account.id.trim()
      ? `codex-${account.id}`
      : `codex-rt-${index + 1}`;
  const credentials: JsonRecord = {
    access_token: account.tokens.access_token,
    refresh_token: account.tokens.refresh_token,
    id_token: account.tokens.id_token,
  };
  if (account.subscription_active_until) credentials.expires_at = account.subscription_active_until;
  if (account.email) credentials.email = account.email;
  if (account.account_id) credentials.chatgpt_account_id = account.account_id;
  if (account.user_id) credentials.chatgpt_user_id = account.user_id;
  if (account.organization_id) credentials.organization_id = account.organization_id;
  if (account.plan_type) credentials.plan_type = account.plan_type;

  return {
    name,
    email: account.email,
    expires_at: account.subscription_active_until,
    payload: buildSub2ApiPayload(name, "oauth", credentials, options),
  };
}

function buildSub2ApiPayload(
  name: string,
  type: "oauth" | "apikey",
  credentials: JsonRecord,
  options: Sub2ApiAccountOptions,
): JsonRecord {
  const email = typeof credentials.email === "string" ? credentials.email : null;
  return {
    name,
    auto_pause_on_expired: true,
    platform: "openai",
    type,
    credentials,
    ...(email ? { extra: { email } } : {}),
    concurrency: options.concurrency,
    priority: options.priority,
    rate_multiplier: 1,
    confirm_mixed_channel_risk: true,
  };
}

function decodeJwtPayload(token: string): JsonRecord | null {
  const part = stripBearer(token).split(".")[1];
  if (!part) return null;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const value = JSON.parse(json);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function lookupClaim(payload: JsonRecord | null, keys: string[]): string | null {
  if (!payload) return null;
  const auth = isRecord(payload[OPENAI_AUTH_CLAIM]) ? payload[OPENAI_AUTH_CLAIM] : null;
  for (const key of keys) {
    const top = readStringField(payload, key);
    if (top) return top;
    const nested = readStringField(auth, key);
    if (nested) return nested;
  }
  return null;
}

function maskSecretTail(secret: string, fallback: number): string {
  const trimmed = secret.trim();
  if (Array.from(trimmed).length < 8) return String(fallback);
  return `***${Array.from(trimmed).slice(-6).join("")}`;
}

async function sub2apiUploadAccountDrafts(
  baseUrl: string,
  adminKey: string,
  accounts: Sub2ApiAccountDraft[],
  groupIds: number[],
): Promise<Sub2ApiImportResponse> {
  if (accounts.length === 0) return emptySub2ImportResponse();
  const base = normalizeSub2ApiBase(baseUrl);
  const requestAccounts = accounts.map((account) => ({
    ...account.payload,
    ...(groupIds.length > 0 ? { group_ids: groupIds } : {}),
  }));
  const resp = await directFetch(`${base}/api/v1/admin/accounts/batch`, {
    method: "POST",
    headers: {
      ...sub2ApiAuthHeaders(adminKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ accounts: requestAccounts }),
  }, "Sub2API");

  if (!resp.ok) throw new Error(await remoteErrorMessage(resp, "Sub2API 导入"));
  const body = await safeJson(resp);
  assertSub2ApiOk(body);
  const results = parseUploadResults(body, accounts);
  return aggregateSub2Results(results.length === accounts.length ? results : successSub2Results(accounts));
}

function parseUploadResults(body: unknown, accounts: Sub2ApiAccountDraft[]) {
  const data = responseData(body);
  if (!isRecord(data) || !Array.isArray(data.results)) return successSub2Results(accounts);
  return data.results.map((item, index) => {
    const account = accounts[index];
    const ok = isRecord(item)
      ? typeof item.success === "boolean"
        ? item.success
        : typeof item.ok === "boolean"
          ? item.ok
          : true
      : true;
    return {
      name: readStringField(item, "name") ?? account?.name ?? `codex-at-${index + 1}`,
      ok,
      email: account?.email ?? null,
      expires_at: account?.expires_at ?? null,
      error: readStringField(item, "error"),
    };
  });
}

function successSub2Results(accounts: Sub2ApiAccountDraft[]) {
  return accounts.map((account) => ({
    name: account.name,
    ok: true,
    email: account.email,
    expires_at: account.expires_at,
    error: null,
  }));
}

function emptySub2ImportResponse(): Sub2ApiImportResponse {
  return { total: 0, success: 0, failed: 0, results: [] };
}

function aggregateSub2Results(results: Sub2ApiImportResponse["results"]): Sub2ApiImportResponse {
  const success = results.filter((r) => r.ok).length;
  return { total: results.length, success, failed: results.length - success, results };
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
