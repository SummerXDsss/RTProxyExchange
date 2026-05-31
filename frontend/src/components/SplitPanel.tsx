import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  List,
  ListItem,
  ListItemText,
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
import { useRef, useState } from "react";
import { downloadSplitZip, splitAccounts } from "../api";
import { dateStamp } from "../formats";
import type { SplitAccount, SplitFormat, SplitResult } from "../types";
import { CpaUploadDialog, type UploadFile } from "./CpaUploadDialog";

interface Props {
  onToast: (message: string) => void;
  /// Panel title (defaults to the account-split wording).
  title?: string;
  /// Info text under the title.
  description?: React.ReactNode;
  /// Placeholder/sample text for the input box.
  sample?: string;
}

/// Filesystem-safe email/name for a split account.
function accountSlug(account: SplitAccount): string {
  const raw = account.email && account.email.trim() ? account.email : account.filename_base;
  return raw.replace(/[^A-Za-z0-9.@_-]/g, "_");
}

const SAMPLE = `粘贴号商发的账号数据，支持：
• 单个账号对象 { ... }
• 账号数组 [{ ... }, { ... }]
• Sub2API 导出 JSON

每个账号会按 codex_{email}.json 命名，
可单独下载 CPA / Sub2API，或打包成 zip。`;

const FREE_SAMPLE = `粘贴 Free 号 JSON（号商常见格式），支持：
• 单个账号对象 { "version":1, "refresh_token":"rt_...", ... }
• 账号数组 [{ ... }, { ... }]

自动提取 refresh / access / id token，
换出 CPA / Sub2API，可下载或打包 zip。`;
export { FREE_SAMPLE };

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
  onDownload,
  onCopy,
}: {
  account: SplitAccount;
  onDownload: (account: SplitAccount, format: SplitFormat) => void;
  onCopy: (account: SplitAccount, format: SplitFormat) => void;
}) {
  return (
    <ListItem
      divider
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
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setInput(String(reader.result ?? ""));
    reader.readAsText(file);
    e.target.value = "";
  };

  const runSplit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await splitAccounts(input);
      setResult(res);
      if (res.total === 0) onToast("未解析到任何账号");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setBusy(false);
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
    setCpaFiles(
      result.accounts.map((a) => ({
        name: `${accountSlug(a)}.json`,
        content: a.cpa,
      })),
    );
    setCpaOpen(true);
  };

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
              <code>{"{}"}</code>，可直接上传 CLIProxyAPI。
            </>
          )}
        </Alert>

        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Box>
          <input ref={fileRef} type="file" accept=".json,.txt" hidden onChange={handleFile} />
          <Button
            size="small"
            startIcon={<UploadFileIcon />}
            onClick={() => fileRef.current?.click()}
          >
            从文件导入
          </Button>
        </Box>

        <TextField
          multiline
          minRows={10}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={sample ?? SAMPLE}
          fullWidth
          slotProps={{ htmlInput: { style: { fontFamily: "monospace", fontSize: 12 } } }}
        />

        <Button
          variant="contained"
          startIcon={<CallSplitIcon />}
          onClick={runSplit}
          disabled={busy || !input.trim()}
        >
          拆分
        </Button>

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
                添加到 CLIProxyAPI
              </Button>
            </Stack>

            <List dense sx={{ maxHeight: 360, overflow: "auto" }}>
              {result.accounts.map((account, i) => (
                <AccountRow
                  key={i}
                  account={account}
                  onDownload={downloadOne}
                  onCopy={copyOne}
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
