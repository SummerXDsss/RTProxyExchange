import {
  Alert,
  Box,
  Button,
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
import SwapHorizIcon from "@mui/icons-material/SwapHoriz";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { useRef, useState } from "react";
import { transform } from "../api";
import type { TransformDirection } from "../types";

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

const CPA_SAMPLE = `{
  "accounts": [
    {
      "email": "user@example.com",
      "tokens": { "id_token": "...", "access_token": "...", "refresh_token": "v1.MzEy..." }
    }
  ]
}`;

/// Offline format converter UI (CPA <-> Sub2API). Pure transform, no refresh.
export function TransformPanel({ onToast }: Props) {
  const [direction, setDirection] = useState<TransformDirection>("sub2api_to_cpa");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const sourceLabel = direction === "sub2api_to_cpa" ? "Sub2API" : "CPA";
  const targetLabel = direction === "sub2api_to_cpa" ? "CPA" : "Sub2API";
  const sample = direction === "sub2api_to_cpa" ? SUB2API_SAMPLE : CPA_SAMPLE;

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setInput(String(reader.result ?? ""));
    reader.readAsText(file);
    e.target.value = "";
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
    const blob = new Blob([output], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    onToast(`已下载 ${name}`);
  };

  return (
    <Paper sx={{ p: 2.5 }}>
      <Stack spacing={2}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <SwapHorizIcon color="primary" />
          <Typography variant="subtitle1">离线格式转换</Typography>
        </Stack>

        <ToggleButtonGroup
          value={direction}
          exclusive
          size="small"
          color="primary"
          onChange={(_, v) => v && setDirection(v)}
          fullWidth
        >
          <ToggleButton value="sub2api_to_cpa">Sub2API → CPA</ToggleButton>
          <ToggleButton value="cpa_to_sub2api">CPA → Sub2API</ToggleButton>
        </ToggleButtonGroup>

        <Alert severity="info" variant="outlined" sx={{ py: 0.5 }}>
          纯本地格式转换，不会刷新 Token，也不发起任何登录请求。
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
                  <input ref={fileRef} type="file" accept=".json" hidden onChange={handleFile} />
                  <Button
                    size="small"
                    startIcon={<UploadFileIcon />}
                    onClick={() => fileRef.current?.click()}
                  >
                    导入
                  </Button>
                </Box>
              </Stack>
              <TextField
                multiline
                minRows={16}
                value={input}
                onChange={(e) => setInput(e.target.value)}
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
          转换
        </Button>
      </Stack>
    </Paper>
  );
}
