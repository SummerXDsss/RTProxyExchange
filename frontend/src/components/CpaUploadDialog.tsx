import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import ErrorIcon from "@mui/icons-material/Error";
import LinkIcon from "@mui/icons-material/Link";
import { useEffect, useState } from "react";
import { cpaTest, cpaUpload } from "../api";
import type { CpaUploadResponse } from "../types";

/// A file to push: filename + the CPA account object.
export interface UploadFile {
  name: string;
  content: unknown;
}

interface Props {
  open: boolean;
  onClose: () => void;
  files: UploadFile[];
  onToast: (message: string) => void;
}

const LS_BASE = "rtpx:cpa:base_url";
const LS_KEY = "rtpx:cpa:mgmt_key";
const RESULT_DISPLAY_LIMIT = 200;

/// Dialog to push CPA account files directly into a CLIProxyAPI instance via
/// its Management API (proxied through our backend to avoid CORS/mixed-content).
export function CpaUploadDialog({ open, onClose, files, onToast }: Props) {
  const [baseUrl, setBaseUrl] = useState("");
  const [mgmtKey, setMgmtKey] = useState("");
  const [rememberKey, setRememberKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [tested, setTested] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CpaUploadResponse | null>(null);

  // Restore saved connection settings on open.
  useEffect(() => {
    if (!open) return;
    setBaseUrl(localStorage.getItem(LS_BASE) ?? "");
    const savedKey = localStorage.getItem(LS_KEY);
    if (savedKey) {
      setMgmtKey(savedKey);
      setRememberKey(true);
    }
    setError(null);
    setResult(null);
    setTested(null);
  }, [open]);

  const persist = () => {
    localStorage.setItem(LS_BASE, baseUrl.trim());
    if (rememberKey) localStorage.setItem(LS_KEY, mgmtKey);
    else localStorage.removeItem(LS_KEY);
  };

  const handleTest = async () => {
    setTesting(true);
    setError(null);
    setTested(null);
    try {
      const r = await cpaTest(baseUrl.trim(), mgmtKey);
      setTested(r.cpa_version ? `连接成功（CPA ${r.cpa_version}）` : "连接成功");
      persist();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const handleUpload = async () => {
    setUploading(true);
    setError(null);
    setResult(null);
    try {
      const r = await cpaUpload(baseUrl.trim(), mgmtKey, files);
      setResult(r);
      persist();
      if (r.failed === 0) onToast(`已添加 ${r.success} 个账号到 CLIProxyAPI`);
      else onToast(`成功 ${r.success}，失败 ${r.failed}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const canSubmit = baseUrl.trim() !== "" && mgmtKey !== "" && files.length > 0;
  const visibleResults = result?.results.slice(0, RESULT_DISPLAY_LIMIT) ?? [];

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Stack direction="row" spacing={1} alignItems="center">
          <CloudUploadIcon color="primary" />
          <span>批量导入 CPA</span>
        </Stack>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <Alert severity="info" variant="outlined" sx={{ py: 0.5 }}>
            通过 CLIProxyAPI 管理接口批量导入 {files.length} 个 CPA 账号。
            需在 CLIProxyAPI 配置中开启远程管理并设置管理密钥。
          </Alert>

          <TextField
            label="CLIProxyAPI 地址"
            placeholder="http://1.2.3.4:8317"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            fullWidth
            size="small"
            slotProps={{ input: { startAdornment: <LinkIcon fontSize="small" sx={{ mr: 1, opacity: 0.6 }} /> } }}
          />
          <TextField
            label="管理密钥 (management key)"
            type="password"
            value={mgmtKey}
            onChange={(e) => setMgmtKey(e.target.value)}
            fullWidth
            size="small"
            autoComplete="off"
          />
          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              size="small"
              onClick={handleTest}
              disabled={testing || !baseUrl.trim() || !mgmtKey}
              startIcon={testing ? <CircularProgress size={14} /> : undefined}
            >
              测试连接
            </Button>
            {tested && <Chip size="small" color="success" label={tested} />}
            <label style={{ marginLeft: "auto", fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
              <input
                type="checkbox"
                checked={rememberKey}
                onChange={(e) => setRememberKey(e.target.checked)}
              />
              记住密钥（本机明文）
            </label>
          </Stack>

          {error && <Alert severity="error">{error}</Alert>}

          {result && (
            <Box>
              <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
                <Chip size="small" color="success" label={`成功 ${result.success}`} />
                {result.failed > 0 && <Chip size="small" color="error" label={`失败 ${result.failed}`} />}
              </Stack>
              {result.results.length > RESULT_DISPLAY_LIMIT && (
                <Typography variant="caption" color="text.secondary">
                  仅显示前 {RESULT_DISPLAY_LIMIT} 条结果。
                </Typography>
              )}
              <List dense sx={{ maxHeight: 200, overflow: "auto" }}>
                {visibleResults.map((r) => (
                  <ListItem key={r.name}>
                    <ListItemIcon sx={{ minWidth: 32 }}>
                      {r.ok ? (
                        <CheckCircleIcon color="success" fontSize="small" />
                      ) : (
                        <ErrorIcon color="error" fontSize="small" />
                      )}
                    </ListItemIcon>
                    <ListItemText
                      primary={r.name}
                      secondary={r.error}
                      slotProps={{
                        primary: { sx: { fontFamily: "monospace", fontSize: 12 } },
                        secondary: { sx: { fontSize: 12 } },
                      }}
                    />
                  </ListItem>
                ))}
              </List>
            </Box>
          )}

          <Typography variant="caption" color="text.secondary">
            密钥仅用于本次请求转发，不会被服务端记录；勾选记住会保存到本机浏览器明文。
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>关闭</Button>
        <Button
          variant="contained"
          onClick={handleUpload}
          disabled={uploading || !canSubmit}
          startIcon={uploading ? <CircularProgress size={16} /> : <CloudUploadIcon />}
        >
          导入 {files.length} 个账号
        </Button>
      </DialogActions>
    </Dialog>
  );
}
