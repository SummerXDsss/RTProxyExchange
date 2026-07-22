import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import Grid from "@mui/material/Grid2";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DownloadIcon from "@mui/icons-material/Download";
import FolderZipIcon from "@mui/icons-material/FolderZip";
import SwapHorizIcon from "@mui/icons-material/SwapHoriz";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { useRef, useState } from "react";
import { transform, transformZip } from "../api";
import type { TransformDirection, TransformZipFile } from "../types";

interface Props {
  onToast: (message: string) => void;
}

const SUB2API_SAMPLE = `{
  "exported_at": "2026-04-18T12:00:00Z",
  "accounts": [
    {
      "platform": "openai",
      "type": "oauth",
      "email": "user@example.com",
      "credentials": { "refresh_token": "v1.MzEy...", "access_token": "...", "id_token": "..." }
    }
  ]
}`;

const CPA_SAMPLE = `[
  {
    "id_token": "...",
    "access_token": "...",
    "refresh_token": "v1.MzEy...",
    "account_id": "account-...",
    "email": "user@example.com",
    "type": "codex",
    "expired": "2026-06-06T05:28:57.000Z"
  }
]

也支持本工具导出的 {"accounts":[{"tokens":{...}}]} 结果。`;

async function readTextFile(file: File): Promise<TransformZipFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, input: String(reader.result ?? "") });
    reader.onerror = () => reject(reader.error ?? new Error(`读取失败: ${file.name}`));
    reader.readAsText(file);
  });
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/// Format converter UI (CPA <-> Sub2API). No token refresh or target upload.
export function TransformPanel({ onToast }: Props) {
  const [direction, setDirection] = useState<TransformDirection>("sub2api_to_cpa");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [batchFiles, setBatchFiles] = useState<TransformZipFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const sourceLabel = direction === "sub2api_to_cpa"
    ? "Sub2API 导出包"
    : "CPA 单账号文件或数组";
  const targetLabel = direction === "sub2api_to_cpa"
    ? "CPA 账号数组"
    : "Sub2API 导出包";
  const sample = direction === "sub2api_to_cpa" ? SUB2API_SAMPLE : CPA_SAMPLE;

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setBusy(true);
    setError(null);
    try {
      const files = Array.from(e.target.files ?? []);
      if (files.length === 0) return;
      const loaded = await Promise.all(files.map(readTextFile));
      setBatchFiles(loaded);
      setInput(loaded[0]?.input ?? "");
      setOutput("");
      onToast(`已导入 ${loaded.length} 个文件`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await transform({ input, direction });
      setOutput(JSON.stringify(result, null, 2));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setOutput("");
    } finally {
      setBusy(false);
    }
  };

  const copyOutput = async () => {
    if (!output) return;
    await navigator.clipboard.writeText(output);
    onToast("已复制结果");
  };

  const downloadOutput = () => {
    if (!output) return;
    const name = direction === "sub2api_to_cpa" ? "cpa-accounts.json" : "sub2api-export.json";
    saveBlob(new Blob([output], { type: "application/json" }), name);
    onToast(`已下载 ${name}`);
  };

  const downloadBatchZip = async () => {
    const files = batchFiles.length > 0
      ? batchFiles
      : [{ name: direction === "sub2api_to_cpa" ? "sub2api.json" : "cpa.json", input }];
    setBusy(true);
    setError(null);
    try {
      const blob = await transformZip(direction, files);
      saveBlob(blob, "format-transform.zip");
      onToast("已下载 format-transform.zip");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clearBatchFiles = () => {
    setBatchFiles([]);
    onToast("已清空批量文件");
  };

  return (
    <Paper sx={{ p: 2.5 }}>
      <Stack spacing={2}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <SwapHorizIcon color="primary" />
          <Typography variant="subtitle1">Sub2API 与 CPA 格式互转</Typography>
        </Stack>

        <ToggleButtonGroup
          value={direction}
          exclusive
          size="small"
          color="primary"
          onChange={(_, v) => v && setDirection(v)}
          fullWidth
        >
          <ToggleButton value="sub2api_to_cpa">Sub2API 导出包 → CPA 文件</ToggleButton>
          <ToggleButton value="cpa_to_sub2api">CPA 文件 → Sub2API 导出包</ToggleButton>
        </ToggleButtonGroup>

        <Alert severity="info" variant="outlined" sx={{ py: 0.5 }}>
          这里只转换 JSON 格式，不刷新 Token，也不会连接你的 Sub2API 或 CLIProxyAPI。
        </Alert>

        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 6 }}>
            <Stack spacing={1}>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="body2" color="text.secondary">
                  输入（{sourceLabel}）
                </Typography>
                <Box>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".json,.txt"
                    multiple
                    hidden
                    onChange={handleFile}
                  />
                  <Button
                    size="small"
                    startIcon={<UploadFileIcon />}
                    onClick={() => fileRef.current?.click()}
                    disabled={busy}
                  >
                    批量导入
                  </Button>
                </Box>
              </Stack>
              {batchFiles.length > 0 && (
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Chip size="small" label={`已选 ${batchFiles.length} 个文件`} />
                  <Button size="small" onClick={clearBatchFiles} disabled={busy}>
                    清空
                  </Button>
                </Stack>
              )}
              <TextField
                multiline
                minRows={16}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setBatchFiles([]);
                }}
                placeholder={sample}
                fullWidth
                slotProps={{ htmlInput: { style: { fontFamily: "monospace", fontSize: 12 } } }}
              />
            </Stack>
          </Grid>

          <Grid size={{ xs: 12, md: 6 }}>
            <Stack spacing={1}>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="body2" color="text.secondary">
                  输出（{targetLabel}）
                </Typography>
                <Stack direction="row" spacing={0.5}>
                  <Button
                    size="small"
                    startIcon={<ContentCopyIcon />}
                    onClick={copyOutput}
                    disabled={!output}
                  >
                    复制
                  </Button>
                  <Button
                    size="small"
                    startIcon={<DownloadIcon />}
                    onClick={downloadOutput}
                    disabled={!output}
                  >
                    下载
                  </Button>
                </Stack>
              </Stack>
              <TextField
                multiline
                minRows={16}
                value={output}
                slotProps={{
                  input: { readOnly: true },
                  htmlInput: { style: { fontFamily: "monospace", fontSize: 12 } },
                }}
                fullWidth
                placeholder="转换结果将显示在这里"
              />
            </Stack>
          </Grid>
        </Grid>

        <Button
          variant="contained"
          startIcon={<SwapHorizIcon />}
          onClick={run}
          disabled={busy || !input.trim()}
        >
          转换当前输入
        </Button>
        <Button
          variant="outlined"
          startIcon={<FolderZipIcon />}
          onClick={downloadBatchZip}
          disabled={busy || (!input.trim() && batchFiles.length === 0)}
        >
          批量转换并下载 ZIP
        </Button>
      </Stack>
    </Paper>
  );
}
