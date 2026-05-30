import {
  Alert,
  AlertTitle,
  Box,
  Chip,
  Divider,
  List,
  ListItem,
  ListItemText,
  Stack,
  Typography,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DownloadIcon from "@mui/icons-material/Download";
import type { BatchResult, CodexAccount, ConvertResponse, DryRunResult } from "../types";
import { isDryRun } from "../types";
import type { OutputFormat } from "../formats";
import { AccountCard } from "./AccountCard";
import { FormatMenuButton } from "./FormatMenuButton";

interface Props {
  result: ConvertResponse | null;
  onCopy: (format: OutputFormat) => void;
  onCopyAccount: (account: CodexAccount, format: OutputFormat) => void;
  onDownload: (format: OutputFormat) => void;
  onDownloadAccount: (account: CodexAccount, format: OutputFormat) => void;
}

/// Summary stat chips for a batch result.
function StatChips({ result }: { result: BatchResult }) {
  return (
    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
      <Chip label={`总计 ${result.total}`} variant="outlined" />
      <Chip label={`成功 ${result.success}`} color="success" />
      {result.failed > 0 && <Chip label={`失败 ${result.failed}`} color="error" />}
    </Stack>
  );
}

function DryRunView({ result }: { result: DryRunResult }) {
  return (
    <Stack spacing={2}>
      <Alert severity="info">
        <AlertTitle>仅解析模式</AlertTitle>
        共识别到 {result.total} 个 Token，未执行刷新。
      </Alert>
      <List dense>
        {result.token_previews.map((preview, i) => (
          <ListItem key={i} divider>
            <ListItemText
              primary={preview}
              slotProps={{ primary: { sx: { fontFamily: "monospace" } } }}
            />
          </ListItem>
        ))}
      </List>
    </Stack>
  );
}

function BatchView({
  result,
  onCopy,
  onCopyAccount,
  onDownload,
  onDownloadAccount,
}: Props & { result: BatchResult }) {
  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" useFlexGap>
        <StatChips result={result} />
        <Stack direction="row" spacing={1}>
          <FormatMenuButton
            label="复制 JSON"
            icon={<ContentCopyIcon />}
            onPick={onCopy}
            disabled={result.accounts.length === 0}
          />
          <FormatMenuButton
            label="下载"
            icon={<DownloadIcon />}
            variant="contained"
            onPick={onDownload}
            disabled={result.accounts.length === 0}
          />
        </Stack>
      </Stack>

      {result.errors.length > 0 && (
        <Alert severity="warning">
          <AlertTitle>{result.errors.length} 个 Token 转换失败</AlertTitle>
          {result.errors.map((e) => (
            <Typography key={e.index} variant="body2">
              #{e.index} ({e.token_preview}): {e.error}
            </Typography>
          ))}
        </Alert>
      )}

      {result.accounts.length > 0 && (
        <Box>
          <Divider sx={{ mb: 1 }}>
            <Typography variant="caption" color="text.secondary">
              账号 ({result.accounts.length})
            </Typography>
          </Divider>
          <Stack spacing={1}>
            {result.accounts.map((acc) => (
              <AccountCard
                key={acc.id}
                account={acc}
                onCopy={onCopyAccount}
                onDownload={onDownloadAccount}
              />
            ))}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}

/// Right-hand panel rendering either a dry-run preview or a full batch result.
export function ResultPanel(props: Props) {
  if (!props.result) {
    return (
      <Box
        sx={{
          height: "100%",
          minHeight: 200,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Typography color="text.secondary">转换结果将显示在这里</Typography>
      </Box>
    );
  }

  return isDryRun(props.result) ? (
    <DryRunView result={props.result} />
  ) : (
    <BatchView {...props} result={props.result} />
  );
}
