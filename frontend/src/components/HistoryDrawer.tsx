import {
  Box,
  Button,
  Chip,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Typography,
} from "@mui/material";
import DeleteIcon from "@mui/icons-material/Delete";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import type { HistoryEntry } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  entries: HistoryEntry[];
  onSelect: (entry: HistoryEntry) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}

/// Side drawer listing recent conversion runs stored in the browser.
export function HistoryDrawer({ open, onClose, entries, onSelect, onRemove, onClear }: Props) {
  return (
    <Drawer anchor="right" open={open} onClose={onClose}>
      <Box sx={{ width: 340, p: 2 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography variant="h6">历史记录</Typography>
          <Button
            size="small"
            color="error"
            startIcon={<DeleteSweepIcon />}
            onClick={onClear}
            disabled={entries.length === 0}
          >
            清空
          </Button>
        </Stack>

        {entries.length === 0 ? (
          <Typography color="text.secondary" variant="body2" sx={{ mt: 2 }}>
            暂无记录。转换结果会保存在本地浏览器。
          </Typography>
        ) : (
          <List dense>
            {entries.map((entry) => (
              <ListItemButton
                key={entry.id}
                onClick={() => onSelect(entry)}
                sx={{ borderRadius: 1, mb: 0.5 }}
              >
                <ListItemText
                  primary={new Date(entry.timestamp).toLocaleString()}
                  secondary={
                    <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
                      <Chip label={`成功 ${entry.success}`} size="small" color="success" />
                      {entry.failed > 0 && (
                        <Chip label={`失败 ${entry.failed}`} size="small" color="error" />
                      )}
                    </Stack>
                  }
                />
                <IconButton
                  edge="end"
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(entry.id);
                  }}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </ListItemButton>
            ))}
          </List>
        )}
      </Box>
    </Drawer>
  );
}
