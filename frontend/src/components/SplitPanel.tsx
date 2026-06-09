import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  Pagination,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DownloadIcon from "@mui/icons-material/Download";
import FolderZipIcon from "@mui/icons-material/FolderZip";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { useEffect, useRef, useState } from "react";
import { convertStream, downloadSplitZip, splitAccounts } from "../api";
import { dateStamp, toCockpit, toSub2apiExport } from "../formats";
import type { BatchResult, CodexAccount, SplitAccount, SplitFormat, SplitResult } from "../types";
import { CpaUploadDialog, type UploadFile } from "./CpaUploadDialog";

const PAGE_SIZE = 100;

interface Props {
  onToast: (message: string) => void;
  /// Panel title (defaults to the account-split wording).
  title?: string;
  /// Info text under the title.
  description?: React.ReactNode;
  /// Placeholder/sample text for the input box.
  sample?: string;
}

interface RefreshStats {
  uploaded: number;
  failed: number;
  usable: number;
}

/// Filesystem-safe email/name for a split account.
function accountSlug(account: SplitAccount): string {
  const raw = account.email && account.email.trim() ? account.email : account.filename_base;
  return raw.replace(/[^A-Za-z0-9.@_-]/g, "_");
}

function accountKey(account: SplitAccount, index: number): string {
  return `${account.filename_base}:${index}`;
}

function splitFromCodex(account: CodexAccount, index: number): SplitAccount {
  const email = account.email;
  const base = accountSlug({
    email,
    filename_base: account.id ? `codex_${account.id.slice(0, 12)}` : `codex_account_${index}`,
    cpa: {},
    sub2api: {},
  });
  return {
    email,
    filename_base: base,
    cpa: toCockpit(account) as unknown as Record<string, unknown>,
    sub2api: toSub2apiExport([account]) as unknown as Record<string, unknown>,
  };
}

function splitResultFromBatch(batch: BatchResult): SplitResult {
  return {
    total: batch.accounts.length,
    accounts: batch.accounts.map(splitFromCodex),
  };
}

function cpaObjectStream(accounts: SplitAccount[]): string {
  return accounts.map((account) => JSON.stringify(account.cpa)).join("\n");
}

const SAMPLE = `粘贴号商发的账号数据，支持：
• 单个账号对象 { ... }
• 账号数组 [{ ... }, { ... }]
• 多段裸对象 { ... } 换行 { ... }
• Sub2API 导出 JSON
• 多文件批量导入

每个账号会按 codex_{email}.json 命名，
可单独下载 CPA / Sub2API，或打包成 zip。`;

const FREE_SAMPLE = `粘贴 Free 号 JSON（号商常见格式），支持：
• 单个账号对象 { "version":1, "refresh_token":"rt_...", ... }
• 账号数组 [{ ... }, { ... }]
• 多段裸对象 { ... } 换行 { ... }
• 多文件批量导入

自动提取 refresh / access / id token，
换出 CPA / Sub2API，可下载或打包 zip。`;
export { FREE_SAMPLE };

async function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error(`读取失败: ${file.name}`));
    reader.readAsText(file);
  });
}

/// Normalize each uploaded file into a stream of top-level JSON objects. This
/// lets users select many single-object files, array files, Sub2API exports, or
/// already-concatenated object streams and parse them together.
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
    // Keep object-stream/plain text as-is.
  }

  return trimmed;
}

async function readUploadedBatch(files: FileList | null): Promise<string> {
  const picked = Array.from(files ?? []);
  if (picked.length === 0) return "";
  const parts = await Promise.all(picked.map((file) => readTextFile(file)));
  return parts.map(normalizeUploadedText).filter(Boolean).join("\n");
}

/// Trigger a browser download for a blob.
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/// Download a single object as pretty JSON.
function saveJson(obj: unknown, filename: string) {
  saveBlob(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }), filename);
}

/// One row per split account with per-format copy + download buttons.
function AccountRow({
  account,
  index,
  selected,
  onDownload,
  onCopy,
  onToggle,
}: {
  account: SplitAccount;
  index: number;
  selected: boolean;
  onDownload: (account: SplitAccount, format: SplitFormat) => void;
  onCopy: (account: SplitAccount, format: SplitFormat) => void;
  onToggle: (key: string) => void;
}) {
  const key = accountKey(account, index);
  return (
    <ListItem
      divider
      sx={{ pl: 0 }}
      secondaryAction={
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Tooltip title="复制 CPA 格式">
            <Button
              size="small"
              startIcon={<ContentCopyIcon sx={{ fontSize: 14 }} />}
              onClick={() => onCopy(account, "cpa")}
            >
              CPA
            </Button>
          </Tooltip>
          <Tooltip title="复制 Sub2API 格式">
            <Button
              size="small"
              startIcon={<ContentCopyIcon sx={{ fontSize: 14 }} />}
              onClick={() => onCopy(account, "sub2api")}
            >
              S2A
            </Button>
          </Tooltip>
          <Tooltip title="下载 CPA 格式">
            <Button
              size="small"
              startIcon={<DownloadIcon sx={{ fontSize: 14 }} />}
              onClick={() => onDownload(account, "cpa")}
            >
              CPA
            </Button>
          </Tooltip>
          <Tooltip title="下载 Sub2API 格式">
            <Button
              size="small"
              startIcon={<DownloadIcon sx={{ fontSize: 14 }} />}
              onClick={() => onDownload(account, "sub2api")}
            >
              S2A
            </Button>
          </Tooltip>
        </Stack>
      }
    >
      <Checkbox
        edge="start"
        checked={selected}
        onChange={() => onToggle(key)}
        inputProps={{ "aria-label": `选择 ${account.email ?? account.filename_base}` }}
      />
      <ListItemText
        primary={account.email ?? "(无邮箱)"}
        secondary={`${accountSlug(account)}-{cpa|sub2api}-${dateStamp()}.json`}
        slotProps={{
          primary: { sx: { fontSize: 14 } },
          secondary: { sx: { fontFamily: "monospace", fontSize: 12 } },
        }}
      />
    </ListItem>
  );
}

/// Account-split UI: parse a batch, list accounts, download per-account or zip.
export function SplitPanel({ onToast, title, description, sample }: Props) {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<SplitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cpaOpen, setCpaOpen] = useState(false);
  const [cpaFiles, setCpaFiles] = useState<UploadFile[]>([]);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState<RefreshStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshDone, setRefreshDone] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const cpaFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [result]);

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setBusy(true);
    setError(null);
    try {
      const merged = await readUploadedBatch(e.target.files);
      if (!merged) return;
      setInput(merged);
      setResult(null);
      setStats(null);
      onToast(`已导入 ${e.target.files?.length ?? 0} 个文件`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  };

  const handleCpaFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setBusy(true);
    setError(null);
    try {
      const merged = await readUploadedBatch(e.target.files);
      if (!merged) return;
      setInput(merged);
      await refreshTokens(merged, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResult(null);
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  };

  const runSplit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await splitAccounts(input);
      setResult(res);
      setStats({ uploaded: res.total, failed: 0, usable: res.total });
      if (res.total === 0) onToast("未解析到任何账号");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const refreshTokens = async (source: string, openCpaAfter: boolean) => {
    setBusy(true);
    setRefreshing(true);
    setRefreshDone(0);
    setError(null);
    setStats(null);
    setResult(null);
    const finalBatchRef: { current?: BatchResult } = {};

    try {
      await convertStream(
        { input: source, concurrency: 32 },
        (event) => {
          if (event.type === "started") {
            setStats({ uploaded: event.total, failed: 0, usable: 0 });
          } else if (event.type === "item") {
            setRefreshDone(event.completed);
          } else if (event.type === "done") {
            finalBatchRef.current = event.result;
          }
        },
      );

      const finalBatch = finalBatchRef.current;
      if (!finalBatch) throw new Error("服务器未返回刷新结果");
      const usable = splitResultFromBatch(finalBatch);
      setResult(usable);
      setInput(cpaObjectStream(usable.accounts));
      setStats({
        uploaded: finalBatch.total,
        failed: finalBatch.failed,
        usable: finalBatch.success,
      });

      if (openCpaAfter && usable.accounts.length > 0) {
        setCpaFiles(filesFromAccounts(usable.accounts));
        setCpaOpen(true);
      }
      onToast(`上传 ${finalBatch.total} 个，登录失败 ${finalBatch.failed} 个，可用 ${finalBatch.success} 个`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setBusy(false);
      setRefreshing(false);
    }
  };

  const downloadOne = (account: SplitAccount, format: SplitFormat) => {
    const payload = format === "cpa" ? account.cpa : account.sub2api;
    const name = `${accountSlug(account)}-${format}-${dateStamp()}.json`;
    saveJson(payload, name);
    onToast(`已下载 ${name}`);
  };

  const copyOne = async (account: SplitAccount, format: SplitFormat) => {
    const payload = format === "cpa" ? account.cpa : account.sub2api;
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    onToast(`已复制 ${account.filename_base} 的 ${format.toUpperCase()} JSON`);
  };

  const copyAll = async (format: SplitFormat) => {
    if (!result) return;
    const payloads = result.accounts.map((a) => (format === "cpa" ? a.cpa : a.sub2api));
    await navigator.clipboard.writeText(JSON.stringify(payloads, null, 2));
    onToast(`已复制全部 ${result.total} 个账号的 ${format.toUpperCase()} JSON`);
  };

  /// Open the CPA push dialog for all split accounts (CPA single-object form).
  const pushAllToCpa = () => {
    if (!result) return;
    setCpaFiles(filesFromAccounts(result.accounts));
    setCpaOpen(true);
  };

  const filesFromAccounts = (accounts: SplitAccount[]) =>
    accounts.map((a) => ({
      name: `${accountSlug(a)}.json`,
      content: a.cpa,
    }));

  const pushSelectedToCpa = () => {
    if (!result) return;
    const picked = result.accounts.filter((account, index) =>
      selected.has(accountKey(account, index)),
    );
    setCpaFiles(filesFromAccounts(picked));
    setCpaOpen(true);
  };

  const toggleAccount = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAllUsable = () => {
    if (!result) return;
    setSelected(new Set(result.accounts.map(accountKey)));
  };

  const clearSelection = () => setSelected(new Set());

  const downloadZip = async (formats: SplitFormat[]) => {
    setBusy(true);
    try {
      const blob = await downloadSplitZip(input, formats);
      saveBlob(blob, "codex_accounts.zip");
      onToast("已下载 codex_accounts.zip");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pageCount = result ? Math.max(1, Math.ceil(result.accounts.length / PAGE_SIZE)) : 1;
  const safePage = Math.min(page, pageCount);
  const visibleAccounts =
    result?.accounts.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE) ?? [];
  const refreshPct =
    stats && stats.uploaded > 0 ? Math.round((refreshDone / stats.uploaded) * 100) : 0;

  return (
    <Paper sx={{ p: 2.5 }}>
      <Stack spacing={2}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <CallSplitIcon color="primary" />
          <Typography variant="subtitle1">{title ?? "账号拆分"}</Typography>
        </Stack>

        <Alert severity="info" variant="outlined" sx={{ py: 0.5 }}>
          {description ?? (
            <>
              纯本地拆分，不会刷新 Token。每个账号按{" "}
              <code>{"{email}"}-{"{格式}"}-{"{日期}"}.json</code> 命名。 CPA 为单个对象{" "}
              <code>{"{}"}</code>。点击“刷新 Token”后只显示可登录账号，可批量登录 CPA。
            </>
          )}
        </Alert>

        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Box>
          <input
            ref={fileRef}
            type="file"
            accept=".json,.txt"
            multiple
            hidden
            onChange={handleFiles}
          />
          <input
            ref={cpaFileRef}
            type="file"
            accept=".json,.txt"
            multiple
            hidden
            onChange={handleCpaFiles}
          />
          <Button
            size="small"
            startIcon={<UploadFileIcon />}
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            批量导入文件
          </Button>
          <Button
            size="small"
            variant="outlined"
            startIcon={<CloudUploadIcon />}
            onClick={() => cpaFileRef.current?.click()}
            disabled={busy}
            sx={{ ml: 1 }}
          >
            文件批量登录 CPA
          </Button>
        </Box>

        {stats && (
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Chip label={`上传 ${stats.uploaded}`} variant="outlined" />
            <Chip label={`登录失败 ${stats.failed}`} color={stats.failed > 0 ? "error" : "default"} />
            <Chip label={`可用 ${stats.usable}`} color="success" />
          </Stack>
        )}

        {refreshing && (
          <Box>
            <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                正在刷新 Token {refreshDone} / {stats?.uploaded ?? 0}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {refreshPct}%
              </Typography>
            </Stack>
            <LinearProgress variant="determinate" value={refreshPct} />
          </Box>
        )}

        <TextField
          multiline
          minRows={10}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={sample ?? SAMPLE}
          fullWidth
          slotProps={{ htmlInput: { style: { fontFamily: "monospace", fontSize: 12 } } }}
        />

        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button
            variant="outlined"
            startIcon={<CallSplitIcon />}
            onClick={runSplit}
            disabled={busy || !input.trim()}
          >
            仅拆分
          </Button>
          <Button
            variant="contained"
            startIcon={<CloudUploadIcon />}
            onClick={() => refreshTokens(input, false)}
            disabled={busy || !input.trim()}
          >
            刷新 Token
          </Button>
        </Stack>

        {result && result.total > 0 && (
          <Box>
            <Divider sx={{ mb: 1.5 }}>
              <Chip label={`共 ${result.total} 个账号`} size="small" />
            </Divider>

            <Stack direction="row" spacing={1} sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
              <Button
                variant="outlined"
                size="small"
                startIcon={<FolderZipIcon />}
                onClick={() => downloadZip(["cpa", "sub2api"])}
                disabled={busy}
              >
                打包下载（两种格式）
              </Button>
              <Button
                size="small"
                startIcon={<DownloadIcon />}
                onClick={() => downloadZip(["cpa"])}
                disabled={busy}
              >
                仅 CPA zip
              </Button>
              <Button
                size="small"
                startIcon={<DownloadIcon />}
                onClick={() => downloadZip(["sub2api"])}
                disabled={busy}
              >
                仅 Sub2API zip
              </Button>
              <Button
                size="small"
                startIcon={<ContentCopyIcon />}
                onClick={() => copyAll("cpa")}
                disabled={busy}
              >
                复制全部 CPA
              </Button>
              <Button
                size="small"
                startIcon={<ContentCopyIcon />}
                onClick={() => copyAll("sub2api")}
                disabled={busy}
              >
                复制全部 Sub2API
              </Button>
              <Button
                size="small"
                variant="contained"
                startIcon={<CloudUploadIcon />}
                onClick={pushAllToCpa}
                disabled={busy}
              >
                一键添加可用
              </Button>
              <Button size="small" onClick={selectAllUsable} disabled={busy}>
                全选可用
              </Button>
              <Button size="small" onClick={clearSelection} disabled={busy || selected.size === 0}>
                清空选择
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<CloudUploadIcon />}
                onClick={pushSelectedToCpa}
                disabled={busy || selected.size === 0}
              >
                添加选中 {selected.size}
              </Button>
            </Stack>

            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              sx={{ mb: 1 }}
            >
              <Typography variant="caption" color="text.secondary">
                显示 {(safePage - 1) * PAGE_SIZE + 1}-
                {Math.min(safePage * PAGE_SIZE, result.total)} / {result.total}
              </Typography>
              {pageCount > 1 && (
                <Pagination
                  count={pageCount}
                  page={safePage}
                  size="small"
                  onChange={(_, value) => setPage(value)}
                />
              )}
            </Stack>

            <List dense sx={{ maxHeight: 360, overflow: "auto" }}>
              {visibleAccounts.map((account, i) => (
                <AccountRow
                  key={accountKey(account, (safePage - 1) * PAGE_SIZE + i)}
                  account={account}
                  index={(safePage - 1) * PAGE_SIZE + i}
                  selected={selected.has(accountKey(account, (safePage - 1) * PAGE_SIZE + i))}
                  onDownload={downloadOne}
                  onCopy={copyOne}
                  onToggle={toggleAccount}
                />
              ))}
            </List>
          </Box>
        )}
      </Stack>

      <CpaUploadDialog
        open={cpaOpen}
        onClose={() => setCpaOpen(false)}
        files={cpaFiles}
        onToast={onToast}
      />
    </Paper>
  );
}
