import {
  Box,
  LinearProgress,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Stack,
  Typography,
} from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import type { ProgressRow } from "../types";

interface Props {
  total: number;
  completed: number;
  rows: ProgressRow[];
}

/// Live progress view shown while a batch conversion streams over SSE.
export function ProgressPanel({ total, completed, rows }: Props) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <Stack spacing={2}>
      <Box>
        <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            正在转换 {completed} / {total}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {pct}%
          </Typography>
        </Stack>
        <LinearProgress variant="determinate" value={pct} />
      </Box>

      {rows.length >= 200 && (
        <Typography variant="caption" color="text.secondary">
          仅显示最近 200 条结果，完整结果会在完成后输出。
        </Typography>
      )}

      <List dense sx={{ maxHeight: 360, overflow: "auto" }}>
        {rows.map((row) => (
          <ListItem key={row.index} divider>
            <ListItemIcon sx={{ minWidth: 36 }}>
              {row.ok ? (
                <CheckCircleIcon color="success" fontSize="small" />
              ) : (
                <ErrorIcon color="error" fontSize="small" />
              )}
            </ListItemIcon>
            <ListItemText
              primary={row.ok ? (row.email ?? "(无邮箱)") : row.error}
              secondary={row.token_preview}
              slotProps={{
                primary: { sx: { fontSize: 14 } },
                secondary: { sx: { fontFamily: "monospace", fontSize: 12 } },
              }}
            />
          </ListItem>
        ))}
      </List>
    </Stack>
  );
}
