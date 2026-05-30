import {
  Alert,
  AppBar,
  Backdrop,
  Box,
  CircularProgress,
  Container,
  CssBaseline,
  IconButton,
  Paper,
  Snackbar,
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
import TransformIcon from "@mui/icons-material/Transform";
import { useState } from "react";
import { convert, convertStream } from "./api";
import { InputPanel, type Mode } from "./components/InputPanel";
import { HistoryDrawer } from "./components/HistoryDrawer";
import { ProgressPanel } from "./components/ProgressPanel";
import { ResultPanel } from "./components/ResultPanel";
import { SplitPanel } from "./components/SplitPanel";
import { TransformPanel } from "./components/TransformPanel";
import { UpdatePanel } from "./components/UpdatePanel";
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

export function App() {
  const { mode, toggle, theme } = useColorMode();
  const history = useHistory();

  const [tab, setTab] = useState(0);
  const [inputMode, setInputMode] = useState<Mode>("single");
  const [input, setInput] = useState("");
  const [timeout, setTimeout] = useState("");
  const [concurrency, setConcurrency] = useState("4");

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ConvertResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Live streaming progress state.
  const [streaming, setStreaming] = useState(false);
  const [progressTotal, setProgressTotal] = useState(0);
  const [progressDone, setProgressDone] = useState(0);
  const [progressRows, setProgressRows] = useState<ProgressRow[]>([]);

  const numOrUndef = (s: string): number | undefined => {
    const n = Number(s);
    return s.trim() && Number.isFinite(n) ? n : undefined;
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
            setProgressRows((prev) => [
              ...prev,
              {
                index: event.index,
                token_preview: event.token_preview,
                ok: event.ok,
                email: event.email,
                error: event.error,
              },
            ]);
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
              Refresh Token → CLIProxyAPI
            </Typography>
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
          <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
            <Tab label="转换 / 登录" />
            <Tab label="格式转换" />
            <Tab label="账号拆分" />
            <Tab label="检查更新" />
          </Tabs>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          {tab === 0 ? (
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
                    />
                  )}
                </Paper>
              </Grid>
            </Grid>
          ) : tab === 1 ? (
            <TransformPanel onToast={setToast} />
          ) : tab === 2 ? (
            <SplitPanel onToast={setToast} />
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
