import {
  Alert,
  AppBar,
  Backdrop,
  Box,
  Button,
  CircularProgress,
  Container,
  CssBaseline,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import Grid from "@mui/material/Grid2";
import { ThemeProvider } from "@mui/material/styles";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import HistoryIcon from "@mui/icons-material/History";
import LightModeIcon from "@mui/icons-material/LightMode";
import PrivacyTipIcon from "@mui/icons-material/PrivacyTip";
import TransformIcon from "@mui/icons-material/Transform";
import { useEffect, useState } from "react";
import { convert, convertStream, oauthExchange, oauthStart } from "./api";
import { InputPanel, type Mode } from "./components/InputPanel";
import { HistoryDrawer } from "./components/HistoryDrawer";
import { ProgressPanel } from "./components/ProgressPanel";
import { ResultPanel } from "./components/ResultPanel";
import { SplitPanel, FREE_SAMPLE } from "./components/SplitPanel";
import { Sub2ApiAtImportPanel } from "./components/Sub2ApiAtImportPanel";
import { TransformPanel } from "./components/TransformPanel";
import { UpdatePanel } from "./components/UpdatePanel";
import { CpaUploadDialog, type UploadFile } from "./components/CpaUploadDialog";
import { useColorMode } from "./hooks/useColorMode";
import { useHistory } from "./hooks/useHistory";
import type { BatchResult, CodexAccount, ConvertResponse, ProgressRow } from "./types";
import { isDryRun } from "./types";
import {
  accountFilename,
  batchFilename,
  batchIsSingleFile,
  serializeAccount,
  serializeBatch,
  toCockpit,
  type OutputFormat,
} from "./formats";

type MainSection = "sub2api" | "cliproxyapi" | "formats" | "tools";
type AppTab = "sub2api_import" | "convert" | "format" | "split" | "free" | "update";

const SECTION_DEFAULT_TAB: Record<MainSection, AppTab> = {
  sub2api: "sub2api_import",
  cliproxyapi: "convert",
  formats: "format",
  tools: "update",
};

const SECTION_TABS: Record<MainSection, { value: AppTab; label: string }[]> = {
  sub2api: [{ value: "sub2api_import", label: "账号导入" }],
  cliproxyapi: [{ value: "convert", label: "RT 登录与账号转换" }],
  formats: [
    { value: "format", label: "Sub2API / CPA 互转" },
    { value: "split", label: "账号拆分与打包" },
    { value: "free", label: "Free 号转换" },
  ],
  tools: [{ value: "update", label: "检查更新" }],
};

const PRIVACY_NOTICE_KEY = "rtpx:privacy_notice:v2";

export function App() {
  const { mode, toggle, theme } = useColorMode();
  const history = useHistory();

  const [section, setSection] = useState<MainSection>("sub2api");
  const [tab, setTab] = useState<AppTab>("sub2api_import");
  const [inputMode, setInputMode] = useState<Mode>("single");
  const [input, setInput] = useState("");
  const [timeout, setTimeout] = useState("");
  const [concurrency, setConcurrency] = useState("32");
  const [oauthSessionId, setOauthSessionId] = useState("");
  const [oauthAuthUrl, setOauthAuthUrl] = useState("");
  const [oauthRedirectUri, setOauthRedirectUri] = useState("");
  const [oauthCallbackUrl, setOauthCallbackUrl] = useState("");

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ConvertResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);

  // CPA push dialog state.
  const [cpaOpen, setCpaOpen] = useState(false);
  const [cpaFiles, setCpaFiles] = useState<UploadFile[]>([]);

  // Live streaming progress state.
  const [streaming, setStreaming] = useState(false);
  const [progressTotal, setProgressTotal] = useState(0);
  const [progressDone, setProgressDone] = useState(0);
  const [progressRows, setProgressRows] = useState<ProgressRow[]>([]);

  const numOrUndef = (s: string): number | undefined => {
    const n = Number(s);
    return s.trim() && Number.isFinite(n) ? n : undefined;
  };

  useEffect(() => {
    try {
      setPrivacyOpen(localStorage.getItem(PRIVACY_NOTICE_KEY) !== "accepted");
    } catch {
      setPrivacyOpen(true);
    }
  }, []);

  const acceptPrivacyNotice = () => {
    try {
      localStorage.setItem(PRIVACY_NOTICE_KEY, "accepted");
    } catch {
      // Still let the user continue when storage is blocked.
    }
    setPrivacyOpen(false);
  };

  /// Dry-run or single-token: use the simple non-streaming endpoint.
  const runSimple = async (dryRun: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await convert({
        input,
        timeout_secs: numOrUndef(timeout),
        dry_run: dryRun,
      });
      setResult(res);
      if (!dryRun && !isDryRun(res)) history.add(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  /// Batch convert with live SSE progress.
  const runStreaming = async () => {
    setStreaming(true);
    setError(null);
    setResult(null);
    setProgressRows([]);
    setProgressDone(0);
    setProgressTotal(0);
    try {
      await convertStream(
        {
          input,
          timeout_secs: numOrUndef(timeout),
          concurrency: numOrUndef(concurrency),
        },
        (event) => {
          if (event.type === "started") {
            setProgressTotal(event.total);
          } else if (event.type === "item") {
            setProgressDone(event.completed);
            setProgressRows((prev) =>
              [
                ...prev,
                {
                  index: event.index,
                  token_preview: event.token_preview,
                  ok: event.ok,
                  email: event.email,
                  error: event.error,
                },
              ].slice(-200),
            );
          } else if (event.type === "done") {
            setResult(event.result);
            history.add(event.result);
          }
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming(false);
    }
  };

  const handleConvert = () => {
    if (inputMode === "single") runSimple(false);
    else runStreaming();
  };

  const handleOAuthStart = async () => {
    const popup = window.open("about:blank", "_blank");
    setLoading(true);
    setError(null);
    try {
      const res = await oauthStart();
      setOauthSessionId(res.session_id);
      setOauthAuthUrl(res.auth_url);
      setOauthRedirectUri(res.redirect_uri);
      setOauthCallbackUrl("");

      if (popup) popup.location.href = res.auth_url;
      else window.open(res.auth_url, "_blank", "noopener,noreferrer");
      setToast("已打开 OAuth 授权页");
    } catch (e) {
      popup?.close();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleOAuthExchange = async () => {
    if (!oauthSessionId) {
      setError("请先获取 OAuth 授权链接");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await oauthExchange(oauthSessionId, oauthCallbackUrl);
      setInputMode("single");
      setInput(res.refresh_token);
      setOauthSessionId("");
      setOauthAuthUrl("");
      setOauthRedirectUri("");
      setOauthCallbackUrl("");
      setToast(res.email ? `已获取 RT：${res.email}` : "已获取 RT");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  /// The accounts of the current batch result, or null for dry-run/empty.
  const resultAccounts = (): CodexAccount[] | null => {
    if (!result || isDryRun(result)) return null;
    return result.accounts;
  };

  const copyText = async (text: string, message: string) => {
    await navigator.clipboard.writeText(text);
    setToast(message);
  };

  const downloadText = (text: string, filename: string, message: string) => {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    setToast(message);
  };

  const handleCopy = (format: OutputFormat) => {
    const accounts = resultAccounts();
    if (accounts) copyText(serializeBatch(accounts, format), `已复制 ${format.toUpperCase()} JSON`);
  };

  const handleCopyAccount = (account: CodexAccount, format: OutputFormat) => {
    copyText(serializeAccount(account, format), `已复制账号 ${format.toUpperCase()} JSON`);
  };

  const handleDownload = (format: OutputFormat) => {
    const accounts = resultAccounts();
    if (!accounts || accounts.length === 0) return;

    // CPA only accepts a single object {} per file. For multiple accounts,
    // download one valid {} file each instead of an (invalid) array file.
    if (!batchIsSingleFile(accounts, format)) {
      accounts.forEach((acc) => {
        downloadText(
          JSON.stringify(toCockpit(acc), null, 2),
          accountFilename(acc.email, format),
          "",
        );
      });
      setToast(`已分别下载 ${accounts.length} 个 CPA 文件`);
      return;
    }

    const name = batchFilename(format);
    downloadText(serializeBatch(accounts, format), name, `已下载 ${name}`);
  };

  const handleDownloadAccount = (account: CodexAccount, format: OutputFormat) => {
    const name = accountFilename(account.email, format);
    downloadText(serializeAccount(account, format), name, `已下载 ${name}`);
  };

  /// Open the CPA push dialog for all current accounts (CPA single-object form).
  const handlePushAll = () => {
    const accounts = resultAccounts();
    if (!accounts || accounts.length === 0) return;
    setCpaFiles(
      accounts.map((acc) => ({
        name: `${acc.email ?? acc.id.slice(0, 12)}.json`,
        content: toCockpit(acc),
      })),
    );
    setCpaOpen(true);
  };

  /// Open the CPA push dialog for a single account.
  const handlePushAccount = (account: CodexAccount) => {
    setCpaFiles([
      { name: `${account.email ?? account.id.slice(0, 12)}.json`, content: toCockpit(account) },
    ]);
    setCpaOpen(true);
  };

  const loadHistory = (r: BatchResult) => {
    setResult(r);
    setHistoryOpen(false);
    setToast("已加载历史记录");
  };

  // Show live progress while streaming and before the final result lands.
  const showProgress = streaming && !result;

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ minHeight: "100vh" }}>
        <AppBar position="static" elevation={0} color="transparent">
          <Toolbar>
            <TransformIcon sx={{ mr: 1.5 }} color="primary" />
            <Typography variant="h6" sx={{ flexGrow: 1 }}>
              RTProxyExchange
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ mr: 1 }}>
              OpenAI 账号转换与导入
            </Typography>
            <Tooltip title="隐私与责任声明">
              <IconButton onClick={() => setPrivacyOpen(true)} aria-label="隐私与责任声明">
                <PrivacyTipIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="历史记录">
              <IconButton onClick={() => setHistoryOpen(true)}>
                <HistoryIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title={mode === "dark" ? "切换浅色" : "切换深色"}>
              <IconButton onClick={toggle}>
                {mode === "dark" ? <LightModeIcon /> : <DarkModeIcon />}
              </IconButton>
            </Tooltip>
          </Toolbar>
        </AppBar>

        <Container maxWidth="lg" sx={{ py: 3 }}>
          <Tabs
            value={section}
            onChange={(_, v: MainSection) => {
              setSection(v);
              setTab(SECTION_DEFAULT_TAB[v]);
            }}
            variant="scrollable"
            scrollButtons="auto"
            allowScrollButtonsMobile
            sx={{ mb: 1 }}
          >
            <Tab value="sub2api" label="Sub2API" />
            <Tab value="cliproxyapi" label="CLIProxyAPI (CPA)" />
            <Tab value="formats" label="格式工具" />
            <Tab value="tools" label="系统" />
          </Tabs>
          <Tabs
            value={tab}
            onChange={(_, v: AppTab) => setTab(v)}
            variant="scrollable"
            scrollButtons="auto"
            allowScrollButtonsMobile
            sx={{ mb: 2 }}
          >
            {SECTION_TABS[section].map((item) => (
              <Tab key={item.value} value={item.value} label={item.label} />
            ))}
          </Tabs>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          {tab === "convert" ? (
            <Grid container spacing={3}>
              <Grid size={{ xs: 12, md: 5 }}>
                <Paper sx={{ p: 2.5 }}>
                  <InputPanel
                    mode={inputMode}
                    onModeChange={setInputMode}
                    input={input}
                    onInputChange={setInput}
                    timeout={timeout}
                    onTimeoutChange={setTimeout}
                    concurrency={concurrency}
                    onConcurrencyChange={setConcurrency}
                    loading={loading || streaming}
                    onConvert={handleConvert}
                    onDryRun={() => runSimple(true)}
                    oauthAuthUrl={oauthAuthUrl}
                    oauthRedirectUri={oauthRedirectUri}
                    oauthCallbackUrl={oauthCallbackUrl}
                    onOAuthStart={handleOAuthStart}
                    onOAuthCallbackChange={setOauthCallbackUrl}
                    onOAuthExchange={handleOAuthExchange}
                  />
                </Paper>
              </Grid>
              <Grid size={{ xs: 12, md: 7 }}>
                <Paper sx={{ p: 2.5, minHeight: 360 }}>
                  {showProgress ? (
                    <ProgressPanel
                      total={progressTotal}
                      completed={progressDone}
                      rows={progressRows}
                    />
                  ) : (
                    <ResultPanel
                      result={result}
                      onCopy={handleCopy}
                      onCopyAccount={handleCopyAccount}
                      onDownload={handleDownload}
                      onDownloadAccount={handleDownloadAccount}
                      onPushAll={handlePushAll}
                      onPushAccount={handlePushAccount}
                      onToast={setToast}
                    />
                  )}
                </Paper>
              </Grid>
            </Grid>
          ) : tab === "format" ? (
            <TransformPanel onToast={setToast} />
          ) : tab === "split" ? (
            <SplitPanel onToast={setToast} />
          ) : tab === "free" ? (
            <SplitPanel
              onToast={setToast}
              title="Free 号转换"
              description={
                <>
                  从 Free 号 JSON 提取 Refresh Token，换出 CPA / Sub2API。纯本地处理，不刷新 Token。
                  CPA 为单个对象，可直接上传 CLIProxyAPI。
                </>
              }
              sample={FREE_SAMPLE}
            />
          ) : tab === "sub2api_import" ? (
            <Paper sx={{ p: 2.5 }}>
              <Sub2ApiAtImportPanel onToast={setToast} />
            </Paper>
          ) : (
            <UpdatePanel onToast={setToast} />
          )}
        </Container>

        <HistoryDrawer
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          entries={history.entries}
          onSelect={(entry) => loadHistory(entry.result)}
          onRemove={history.remove}
          onClear={history.clear}
        />

        <CpaUploadDialog
          open={cpaOpen}
          onClose={() => setCpaOpen(false)}
          files={cpaFiles}
          onToast={setToast}
        />

        <Dialog open={privacyOpen} maxWidth="sm" fullWidth aria-labelledby="privacy-title">
          <DialogTitle id="privacy-title">隐私与责任声明</DialogTitle>
          <DialogContent>
            <Stack spacing={1.5} sx={{ pt: 0.5 }}>
              <Typography variant="body2">
                应用 API 只请求当前站点的 <code>/api/*</code>，Sub2API、CLIProxyAPI 与 Token
                刷新请求均由本站后端发起。
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Refresh Token、Access Token、API Key、管理密钥和账号文件会在请求期间由本站后端暂存于内存，并按你的操作转发；
                本应用不会主动写入服务端数据库或文件。
              </Typography>
              <Typography variant="body2" color="text.secondary">
                转换历史会把完整结果保存到当前浏览器 localStorage，其中可能包含 Token。你主动勾选“记住”的管理密钥也会以本机明文保存，
                请勿在共享设备上启用。
              </Typography>
              <Typography variant="body2" color="text.secondary">
                只有在你主动使用 OAuth 登录时，浏览器才会打开 OpenAI 官方授权页面。
              </Typography>
              <Alert severity="warning" variant="outlined" sx={{ py: 0.5 }}>
                公网实例的部署者负责 HTTPS、访问控制、反向代理日志和当地合规；请仅使用你有权处理的账号与凭据。
              </Alert>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              component="a"
              href="/privacy.html"
              target="_blank"
              rel="noopener noreferrer"
            >
              查看完整声明
            </Button>
            <Button variant="contained" onClick={acceptPrivacyNotice}>
              我已知悉
            </Button>
          </DialogActions>
        </Dialog>

        <Backdrop open={loading} sx={{ zIndex: (t) => t.zIndex.drawer + 1 }}>
          <CircularProgress color="primary" />
        </Backdrop>

        <Snackbar
          open={!!toast}
          autoHideDuration={2500}
          onClose={() => setToast(null)}
          message={toast}
          anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        />
      </Box>
    </ThemeProvider>
  );
}
