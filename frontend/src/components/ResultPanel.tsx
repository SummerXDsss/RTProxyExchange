import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Divider,
  List,
  ListItem,
  ListItemText,
  Pagination,
  Stack,
  Typography,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DownloadIcon from "@mui/icons-material/Download";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import type { BatchResult, CodexAccount, ConvertResponse, DryRunResult } from "../types";
import { isDryRun } from "../types";
import type { OutputFormat } from "../formats";
import { AccountCard } from "./AccountCard";
import { FormatMenuButton } from "./FormatMenuButton";
import { useEffect, useState } from "react";

const PAGE_SIZE = 100;
const DRY_RUN_PREVIEW_LIMIT = 200;

interface Props {
  result: ConvertResponse | null;
  onCopy: (format: OutputFormat) => void;
  onCopyAccount: (account: CodexAccount, format: OutputFormat) => void;
  onDownload: (format: OutputFormat) => void;
  onDownloadAccount: (account: CodexAccount, format: OutputFormat) => void;
  onPushAll: () => void;
  onPushAccount: (account: CodexAccount) => void;
  onToast: (message: string) => void;
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
  const previews = result.token_previews.slice(0, DRY_RUN_PREVIEW_LIMIT);

  return (
    <Stack spacing={2}>
      <Alert severity="info">
        <AlertTitle>仅解析模式</AlertTitle>
        共识别到 {result.total} 个 Token，未执行刷新。
      </Alert>
      {result.token_previews.length > DRY_RUN_PREVIEW_LIMIT && (
        <Typography variant="caption" color="text.secondary">
          仅显示前 {DRY_RUN_PREVIEW_LIMIT} 条预览。
        </Typography>
      )}
      <List dense>
        {previews.map((preview, i) => (
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
  onPushAll,
  onPushAccount,
  onToast,
}: Props & { result: BatchResult }) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(result.accounts.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visibleAccounts = result.accounts.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE,
  );

  useEffect(() => {
    setPage(1);
  }, [result]);

  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" useFlexGap>
        <StatChips result={result} />
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <FormatMenuButton
            label="复制 JSON"
            icon={<ContentCopyIcon />}
            onPick={onCopy}
            disabled={result.accounts.length === 0}
          />
          <FormatMenuButton
            label="下载"
            icon={<DownloadIcon />}
            onPick={onDownload}
            disabled={result.accounts.length === 0}
          />
          <Button
            size="small"
            variant="contained"
            startIcon={<CloudUploadIcon />}
            onClick={onPushAll}
            disabled={result.accounts.length === 0}
          >
            批量导入 CPA
          </Button>
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
          <Stack
            direction="row"
            justifyContent="space-between"
            alignItems="center"
            sx={{ mb: 1 }}
          >
            <Typography variant="caption" color="text.secondary">
              显示 {(safePage - 1) * PAGE_SIZE + 1}-
              {Math.min(safePage * PAGE_SIZE, result.accounts.length)} / {result.accounts.length}
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
          <Stack spacing={1}>
            {visibleAccounts.map((acc) => (
              <AccountCard
                key={acc.id}
                account={acc}
                onCopy={onCopyAccount}
                onDownload={onDownloadAccount}
                onPush={onPushAccount}
                onToast={onToast}
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
