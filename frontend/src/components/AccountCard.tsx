import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Chip,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DownloadIcon from "@mui/icons-material/Download";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import PersonIcon from "@mui/icons-material/Person";
import { Button } from "@mui/material";
import { useState } from "react";
import type { CodexAccount } from "../types";
import type { OutputFormat } from "../formats";
import { FormatMenuButton } from "./FormatMenuButton";

interface Props {
  account: CodexAccount;
  onCopy: (account: CodexAccount, format: OutputFormat) => void;
  onDownload: (account: CodexAccount, format: OutputFormat) => void;
  onPush: (account: CodexAccount) => void;
  onToast: (message: string) => void;
}

/// Truncate a long token for display.
function shorten(value: string, head = 16, tail = 8): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/// A plain read-only field (no copy).
function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
        {value ?? "—"}
      </Typography>
    </Box>
  );
}

/// A field whose full value can be copied with one click. Shows a truncated
/// preview; clicking the row (or the icon) copies the complete value.
function CopyableField({
  label,
  value,
  onToast,
}: {
  label: string;
  value: string;
  onToast: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      onToast(`已复制 ${label}`);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      onToast("复制失败");
    }
  };

  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Tooltip title={value ? "点击复制完整内容" : ""} placement="top-start">
        <Stack
          direction="row"
          alignItems="center"
          spacing={0.5}
          onClick={copy}
          sx={{
            cursor: value ? "pointer" : "default",
            borderRadius: 1,
            px: 0.5,
            mx: -0.5,
            "&:hover": value ? { bgcolor: "action.hover" } : undefined,
          }}
        >
          <Typography
            variant="body2"
            sx={{ fontFamily: "monospace", wordBreak: "break-all", flexGrow: 1 }}
          >
            {value ? shorten(value) : "—"}
          </Typography>
          {value && (
            <IconButton size="small" edge="end" sx={{ p: 0.25 }}>
              <ContentCopyIcon
                fontSize="inherit"
                color={copied ? "success" : "inherit"}
              />
            </IconButton>
          )}
        </Stack>
      </Tooltip>
    </Box>
  );
}

/// Expandable card showing a single converted CPA account.
export function AccountCard({ account, onCopy, onDownload, onPush, onToast }: Props) {
  return (
    <Accordion disableGutters>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ width: "100%" }}>
          <PersonIcon color="primary" fontSize="small" />
          <Typography sx={{ flexGrow: 1 }}>{account.email ?? "(无邮箱)"}</Typography>
          {account.plan_type && (
            <Chip label={account.plan_type} size="small" color="primary" variant="outlined" />
          )}
          {account.token_generation > 1 && (
            <Chip label={`gen ${account.token_generation}`} size="small" variant="outlined" />
          )}
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} onClick={(e) => e.stopPropagation()}>
            <FormatMenuButton
              label="复制"
              icon={<ContentCopyIcon fontSize="small" />}
              size="small"
              onPick={(format) => onCopy(account, format)}
            />
            <FormatMenuButton
              label="下载"
              icon={<DownloadIcon fontSize="small" />}
              size="small"
              onPick={(format) => onDownload(account, format)}
            />
            <Button
              size="small"
              variant="outlined"
              startIcon={<CloudUploadIcon fontSize="small" />}
              onClick={() => onPush(account)}
            >
              添加到 CPA
            </Button>
          </Stack>
          <Field label="ID (SHA256)" value={shorten(account.id, 20, 12)} />
          <Field label="User ID" value={account.user_id} />
          <Field label="Account ID" value={account.account_id} />
          <Field label="Organization ID" value={account.organization_id} />
          <Field label="订阅有效期" value={account.subscription_active_until} />
          <CopyableField
            label="Refresh Token"
            value={account.tokens.refresh_token}
            onToast={onToast}
          />
          <CopyableField
            label="Access Token"
            value={account.tokens.access_token}
            onToast={onToast}
          />
          <CopyableField label="ID Token" value={account.tokens.id_token} onToast={onToast} />
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
