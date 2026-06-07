import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import Grid from "@mui/material/Grid2";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import LoginIcon from "@mui/icons-material/Login";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import PlaylistAddCheckIcon from "@mui/icons-material/PlaylistAddCheck";
import SearchIcon from "@mui/icons-material/Search";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { useRef } from "react";

export type Mode = "single" | "batch";

interface Props {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  input: string;
  onInputChange: (value: string) => void;
  timeout: string;
  onTimeoutChange: (value: string) => void;
  concurrency: string;
  onConcurrencyChange: (value: string) => void;
  loading: boolean;
  onConvert: () => void;
  onDryRun: () => void;
  oauthAuthUrl: string;
  oauthRedirectUri: string;
  oauthCallbackUrl: string;
  onOAuthStart: () => void;
  onOAuthCallbackChange: (value: string) => void;
  onOAuthExchange: () => void;
}

const SINGLE_PLACEHOLDER = `粘贴单个 Refresh Token 登录：
v1.MzEyMzQ1Njc4OTAtb2F1dGg...`;

const BATCH_PLACEHOLDER = `批量输入，支持：
• 多行 Token（每行一个）
• Sub2API 导出的 JSON
• 自定义 JSON： {"refresh_token": "..."}
• 多段裸对象：{...}
  {...}`;

/// Input panel: mode switch (single login / batch), token text, advanced
/// options and action buttons. No ClientID is requested — login uses the
/// refresh token alone.
export function InputPanel(props: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const single = props.mode === "single";

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => props.onInputChange(String(reader.result ?? ""));
    reader.readAsText(file);
    e.target.value = "";
  };

  return (
    <Stack spacing={2}>
      <ToggleButtonGroup
        value={props.mode}
        exclusive
        size="small"
        color="primary"
        onChange={(_, v) => v && props.onModeChange(v)}
        fullWidth
      >
        <ToggleButton value="single">单 Token 登录</ToggleButton>
        <ToggleButton value="batch">批量转换</ToggleButton>
      </ToggleButtonGroup>

      {single && (
        <Stack spacing={1.25}>
          <Alert severity="info" variant="outlined" sx={{ py: 0.5 }}>
            可直接粘贴 Refresh Token，也可以通过 OAuth 登录获取 RT。
          </Alert>
          <Button
            variant="outlined"
            startIcon={<OpenInNewIcon />}
            onClick={props.onOAuthStart}
            disabled={props.loading}
          >
            OAuth 获取 RT
          </Button>

          {props.oauthAuthUrl && (
            <Stack spacing={1.25}>
              <Alert severity="success" variant="outlined" sx={{ py: 0.5 }}>
                授权页打开后，登录完成会跳到本地 callback。页面打不开没关系，把地址栏里的完整链接粘贴回来。
              </Alert>
              <TextField
                label="授权链接"
                value={props.oauthAuthUrl}
                fullWidth
                size="small"
                slotProps={{
                  input: { readOnly: true },
                  htmlInput: { style: { fontFamily: "monospace", fontSize: 12 } },
                }}
              />
              <TextField
                label="回调链接"
                value={props.oauthCallbackUrl}
                onChange={(e) => props.onOAuthCallbackChange(e.target.value)}
                placeholder={`${props.oauthRedirectUri || "http://localhost:1455/auth/callback"}?code=...&state=...`}
                fullWidth
                multiline
                minRows={2}
                slotProps={{ htmlInput: { style: { fontFamily: "monospace", fontSize: 12 } } }}
              />
              <Button
                variant="contained"
                onClick={props.onOAuthExchange}
                disabled={props.loading || !props.oauthCallbackUrl.trim()}
              >
                回传并填入 RT
              </Button>
            </Stack>
          )}
        </Stack>
      )}

      <TextField
        label={single ? "Refresh Token" : "批量输入"}
        multiline
        minRows={single ? 4 : 12}
        value={props.input}
        onChange={(e) => props.onInputChange(e.target.value)}
        placeholder={single ? SINGLE_PLACEHOLDER : BATCH_PLACEHOLDER}
        fullWidth
        slotProps={{ htmlInput: { style: { fontFamily: "monospace", fontSize: 13 } } }}
      />

      {!single && (
        <Box>
          <input ref={fileRef} type="file" accept=".txt,.json" hidden onChange={handleFile} />
          <Button
            variant="outlined"
            startIcon={<UploadFileIcon />}
            onClick={() => fileRef.current?.click()}
            size="small"
          >
            从文件导入
          </Button>
        </Box>
      )}

      <Accordion disableGutters>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="body2" color="text.secondary">
            高级选项
          </Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Grid container spacing={2}>
            <Grid size={{ xs: 6 }}>
              <TextField
                label="超时 (秒)"
                type="number"
                value={props.timeout}
                onChange={(e) => props.onTimeoutChange(e.target.value)}
                fullWidth
                size="small"
              />
            </Grid>
            <Grid size={{ xs: 6 }}>
              <TextField
                label="并发数"
                type="number"
                value={props.concurrency}
                onChange={(e) => props.onConcurrencyChange(e.target.value)}
                fullWidth
                size="small"
                disabled={single}
              />
            </Grid>
          </Grid>
        </AccordionDetails>
      </Accordion>

      <Stack direction="row" spacing={2}>
        <Button
          variant="contained"
          startIcon={single ? <LoginIcon /> : <PlaylistAddCheckIcon />}
          onClick={props.onConvert}
          disabled={props.loading || !props.input.trim()}
          fullWidth
        >
          {single ? "登录并转换" : "批量转换"}
        </Button>
        <Button
          variant="outlined"
          startIcon={<SearchIcon />}
          onClick={props.onDryRun}
          disabled={props.loading || !props.input.trim()}
        >
          仅解析
        </Button>
      </Stack>
    </Stack>
  );
}
