import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import ErrorIcon from "@mui/icons-material/Error";
import LinkIcon from "@mui/icons-material/Link";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { useEffect, useRef, useState } from "react";
import {
  sub2apiGroups,
  sub2apiImportApiKeys,
  sub2apiImportAt,
  sub2apiImportRefreshTokens,
  sub2apiLogin,
  sub2apiTest,
} from "../api";
import type { Sub2ApiGroup, Sub2ApiImportResponse } from "../types";

const LS_BASE = "rtpx:sub2api:base_url";
const LS_KEY = "rtpx:sub2api:admin_key";
const LS_MODE = "rtpx:sub2api:import_mode";
const LS_AUTH_MODE = "rtpx:sub2api:auth_mode";
const RESULT_DISPLAY_LIMIT = 300;

type ImportMode = "at" | "api_key" | "rt";
type AuthMode = "key" | "login";

const AT_SAMPLE = `[
  {
    "access_token": "eyJhbGciOi..."
  },
  {
    "credentials": {
      "access_token": "eyJhbGciOi..."
    }
  }
]`;

const API_KEY_SAMPLE = `[
  {
    "api_key": "sk-..."
  },
  {
    "credentials": {
      "api_key": "sk-..."
    }
  }
]`;

const RT_SAMPLE = `v1.MzEy...
v1.NDU2...

也支持包含 refresh_token 的 JSON`;

async function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error(`读取失败: ${file.name}`));
    reader.readAsText(file);
  });
}

function normalizeUploadedText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";

  try {
    const value = JSON.parse(trimmed);
    if (Array.isArray(value)) {
      return value.map((item) => JSON.stringify(item)).join("\n");
    }
    if (value && typeof value === "object") {
      return JSON.stringify(value);
    }
  } catch {
    // Keep plain token lines / object streams as-is.
  }

  return trimmed;
}

export function Sub2ApiAtImportPanel({ onToast }: { onToast: (message: string) => void }) {
  const [importMode, setImportMode] = useState<ImportMode>("at");
  const [authMode, setAuthMode] = useState<AuthMode>("key");
  const [baseUrl, setBaseUrl] = useState("");
  const [adminKey, setAdminKey] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginToken, setLoginToken] = useState("");
  const [rememberKey, setRememberKey] = useState(false);
  const [accountConcurrency, setAccountConcurrency] = useState("3");
  const [accountPriority, setAccountPriority] = useState("50");
  const [input, setInput] = useState("");
  const [testing, setTesting] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [importing, setImporting] = useState(false);
  const [tested, setTested] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<Sub2ApiGroup[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>([]);
  const [result, setResult] = useState<Sub2ApiImportResponse | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setBaseUrl(localStorage.getItem(LS_BASE) ?? "");
    const savedMode = localStorage.getItem(LS_MODE);
    if (savedMode === "at" || savedMode === "api_key" || savedMode === "rt") setImportMode(savedMode);
    const savedAuthMode = localStorage.getItem(LS_AUTH_MODE);
    if (savedAuthMode === "key" || savedAuthMode === "login") setAuthMode(savedAuthMode);
    const savedKey = localStorage.getItem(LS_KEY);
    if (savedKey) {
      setAdminKey(savedKey);
      setRememberKey(true);
    }
  }, []);

  const persist = () => {
    localStorage.setItem(LS_BASE, baseUrl.trim());
    localStorage.setItem(LS_MODE, importMode);
    localStorage.setItem(LS_AUTH_MODE, authMode);
    if (authMode === "key" && rememberKey) localStorage.setItem(LS_KEY, adminKey);
    else localStorage.removeItem(LS_KEY);
  };

  const authCredential = authMode === "login" ? loginToken : adminKey;

  const numberOrUndefined = (value: string): number | undefined => {
    const n = Number(value);
    return value.trim() && Number.isFinite(n) ? n : undefined;
  };

  const loadGroups = async (credential = authCredential) => {
    if (!baseUrl.trim() || !credential.trim()) return;
    setLoadingGroups(true);
    try {
      const list = await sub2apiGroups(baseUrl.trim(), credential.trim());
      setGroups(list);
      setSelectedGroupIds((prev) => prev.filter((id) => list.some((group) => group.id === id)));
    } finally {
      setLoadingGroups(false);
    }
  };

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    try {
      const files = Array.from(e.target.files ?? []);
      if (files.length === 0) return;
      const parts = await Promise.all(files.map(readTextFile));
      setInput(parts.map(normalizeUploadedText).filter(Boolean).join("\n"));
      setResult(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      e.target.value = "";
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setError(null);
    setTested(null);
    try {
      await sub2apiTest(baseUrl.trim(), authCredential);
      setTested("连接成功");
      persist();
      await loadGroups(authCredential);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const handleLogin = async () => {
    setLoggingIn(true);
    setError(null);
    setTested(null);
    try {
      const res = await sub2apiLogin(baseUrl.trim(), loginEmail.trim(), loginPassword);
      const bearer = `Bearer ${res.access_token}`;
      setLoginToken(bearer);
      setLoginPassword("");
      setTested(res.email ? `登录成功：${res.email}` : "登录成功");
      persist();
      await loadGroups(bearer);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoggingIn(false);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      const options = {
        accountConcurrency: numberOrUndefined(accountConcurrency),
        priority: numberOrUndefined(accountPriority),
      };
      const res = importMode === "at"
        ? await sub2apiImportAt(baseUrl.trim(), authCredential, input, selectedGroupIds, options)
        : importMode === "api_key"
          ? await sub2apiImportApiKeys(baseUrl.trim(), authCredential, input, selectedGroupIds, options)
          : await sub2apiImportRefreshTokens(baseUrl.trim(), authCredential, input, selectedGroupIds, options);
      setResult(res);
      persist();
      const label = importMode === "at" ? "AT" : importMode === "api_key" ? "API Key" : "RT 刷新";
      if (res.failed === 0) onToast(`已导入 ${res.success} 个 ${label} 账号到 Sub2API`);
      else onToast(`成功 ${res.success}，失败 ${res.failed}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const canSubmit = baseUrl.trim() !== "" && authCredential.trim() !== "" && input.trim() !== "";
  const visibleResults = result?.results.slice(0, RESULT_DISPLAY_LIMIT) ?? [];
  const modeLabel = importMode === "at"
    ? "AT JSON"
    : importMode === "api_key"
      ? "API Key JSON"
      : "Refresh Token / JSON";
  const modeDescription = importMode === "at"
    ? "只读取 JSON 里的 access_token，创建 Sub2API OpenAI OAuth 账号；支持无 RT。"
    : importMode === "api_key"
      ? "只读取 JSON 或文本里的 api_key，创建 Sub2API OpenAI API Key 账号。"
      : "批量刷新 Refresh Token，成功后直接上传 Sub2API OpenAI OAuth 账号。";
  const sample = importMode === "at" ? AT_SAMPLE : importMode === "api_key" ? API_KEY_SAMPLE : RT_SAMPLE;

  return (
    <Stack spacing={2.5}>
      <Stack spacing={0.5}>
        <Typography variant="h6">Sub2API 一键导入</Typography>
        <Typography variant="body2" color="text.secondary">
          {modeDescription}
        </Typography>
      </Stack>

      <ToggleButtonGroup
        size="small"
        exclusive
        value={importMode}
        onChange={(_, value: ImportMode | null) => {
          if (!value) return;
          setImportMode(value);
          setInput("");
          setResult(null);
          setError(null);
          setTested(null);
        }}
      >
        <ToggleButton value="at">AT/OAuth</ToggleButton>
        <ToggleButton value="api_key">API Key</ToggleButton>
        <ToggleButton value="rt">RT 刷新上传</ToggleButton>
      </ToggleButtonGroup>

      <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
        <TextField
          label="Sub2API 地址"
          placeholder="http://1.2.3.4:8080"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          fullWidth
          size="small"
          slotProps={{ input: { startAdornment: <LinkIcon fontSize="small" sx={{ mr: 1, opacity: 0.6 }} /> } }}
        />
      </Stack>

      <ToggleButtonGroup
        size="small"
        exclusive
        value={authMode}
        onChange={(_, value: AuthMode | null) => {
          if (!value) return;
          setAuthMode(value);
          setError(null);
          setTested(null);
        }}
      >
        <ToggleButton value="key">Admin Key</ToggleButton>
        <ToggleButton value="login">管理员登录</ToggleButton>
      </ToggleButtonGroup>

      {authMode === "key" ? (
        <TextField
          label="Admin API Key"
          type="password"
          value={adminKey}
          onChange={(e) => setAdminKey(e.target.value)}
          fullWidth
          size="small"
          autoComplete="off"
        />
      ) : (
        <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
          <TextField
            label="Sub2API 管理员邮箱"
            value={loginEmail}
            onChange={(e) => setLoginEmail(e.target.value)}
            fullWidth
            size="small"
            autoComplete="username"
          />
          <TextField
            label="Sub2API 密码"
            type="password"
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            fullWidth
            size="small"
            autoComplete="current-password"
          />
          <Button
            variant="outlined"
            onClick={handleLogin}
            disabled={loggingIn || !baseUrl.trim() || !loginEmail.trim() || !loginPassword}
            startIcon={loggingIn ? <CircularProgress size={14} /> : undefined}
            sx={{ minWidth: 120 }}
          >
            登录
          </Button>
        </Stack>
      )}

      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <input ref={fileRef} type="file" accept=".txt,.json" multiple hidden onChange={handleFiles} />
        <Button
          size="small"
          variant="outlined"
          startIcon={<UploadFileIcon />}
          onClick={() => fileRef.current?.click()}
        >
          从文件导入
        </Button>
        <Button
          size="small"
          onClick={handleTest}
          disabled={testing || !baseUrl.trim() || !authCredential}
          startIcon={testing ? <CircularProgress size={14} /> : undefined}
        >
          测试/拉分组
        </Button>
        {loadingGroups && <CircularProgress size={16} />}
        {tested && <Chip size="small" color="success" label={tested} />}
        {authMode === "key" ? (
          <label style={{ marginLeft: "auto", fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="checkbox"
              checked={rememberKey}
              onChange={(e) => setRememberKey(e.target.checked)}
            />
            记住 Key（本机明文）
          </label>
        ) : (
          <Typography variant="caption" color="text.secondary" sx={{ ml: "auto" }}>
            JWT 仅当前页面内存保存
          </Typography>
        )}
      </Stack>

      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
        <TextField
          label="Sub2API 调度数量"
          value={accountConcurrency}
          onChange={(e) => setAccountConcurrency(e.target.value)}
          type="number"
          size="small"
          fullWidth
          slotProps={{ htmlInput: { min: 0, step: 1 } }}
        />
        <TextField
          label="Sub2API 优先级"
          value={accountPriority}
          onChange={(e) => setAccountPriority(e.target.value)}
          type="number"
          size="small"
          fullWidth
          slotProps={{ htmlInput: { step: 1 } }}
        />
      </Stack>

      {groups.length > 0 && (
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">
            导入到选定分组
          </Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {groups.map((group) => (
              <FormControlLabel
                key={group.id}
                sx={{ mr: 0.5 }}
                control={
                  <Checkbox
                    size="small"
                    checked={selectedGroupIds.includes(group.id)}
                    onChange={(e) => {
                      setSelectedGroupIds((prev) =>
                        e.target.checked
                          ? [...prev, group.id]
                          : prev.filter((id) => id !== group.id),
                      );
                    }}
                  />
                }
                label={`${group.name}${group.status === "inactive" ? " (停用)" : ""}`}
              />
            ))}
          </Stack>
        </Stack>
      )}

      <TextField
        label={modeLabel}
        multiline
        minRows={16}
        maxRows={28}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={sample}
        fullWidth
        slotProps={{ htmlInput: { style: { fontFamily: "monospace", fontSize: 13 } } }}
      />

      {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}

      <Stack direction="row" spacing={1.5} alignItems="center">
        <Button
          variant="contained"
          startIcon={importing ? <CircularProgress color="inherit" size={16} /> : <CloudUploadIcon />}
          onClick={handleImport}
          disabled={importing || !canSubmit}
        >
          一键导入 Sub2API
        </Button>
        <Typography variant="caption" color="text.secondary">
          Sub2API 请求由浏览器直连目标服务，不经过本项目后端；目标服务需允许 CORS。
        </Typography>
      </Stack>

      {result && (
        <Box>
          <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
            <Chip size="small" variant="outlined" label={`总计 ${result.total}`} />
            <Chip size="small" color="success" label={`成功 ${result.success}`} />
            {result.failed > 0 && <Chip size="small" color="error" label={`失败 ${result.failed}`} />}
          </Stack>
          {result.results.length > RESULT_DISPLAY_LIMIT && (
            <Typography variant="caption" color="text.secondary">
              仅显示前 {RESULT_DISPLAY_LIMIT} 条结果。
            </Typography>
          )}
          <List dense sx={{ maxHeight: 360, overflow: "auto" }}>
            {visibleResults.map((item, index) => (
              <ListItem key={`${item.name}:${index}`} divider>
                <ListItemIcon sx={{ minWidth: 32 }}>
                  {item.ok ? (
                    <CheckCircleIcon color="success" fontSize="small" />
                  ) : (
                    <ErrorIcon color="error" fontSize="small" />
                  )}
                </ListItemIcon>
                <ListItemText
                  primary={item.email ?? item.name}
                  secondary={item.error ?? item.expires_at ?? "已创建"}
                  slotProps={{
                    primary: { sx: { fontSize: 14 } },
                    secondary: { sx: { fontSize: 12 } },
                  }}
                />
              </ListItem>
            ))}
          </List>
        </Box>
      )}
    </Stack>
  );
}
