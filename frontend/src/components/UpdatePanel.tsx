import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Link,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import NewReleasesIcon from "@mui/icons-material/NewReleases";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useCallback, useEffect, useState } from "react";
import { checkUpdate } from "../api";
import type { ReleaseInfo, UpdateStatus } from "../types";

interface Props {
  onToast: (message: string) => void;
}

/// Format an ISO timestamp to a short local date, or "—".
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

/// One entry in the version history timeline.
function HistoryItem({ release, isCurrent }: { release: ReleaseInfo; isCurrent: boolean }) {
  return (
    <Box sx={{ py: 1 }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="subtitle2" sx={{ fontFamily: "monospace" }}>
          {release.tag}
        </Typography>
        {isCurrent && <Chip label="当前版本" size="small" color="primary" />}
        {release.prerelease && <Chip label="预发布" size="small" variant="outlined" />}
        <Typography variant="caption" color="text.secondary">
          {fmtDate(release.published_at)}
        </Typography>
        {release.html_url && (
          <Link href={release.html_url} target="_blank" rel="noopener" variant="caption">
            查看
          </Link>
        )}
      </Stack>
      {release.name && release.name !== release.tag && (
        <Typography variant="body2" sx={{ mt: 0.5 }}>
          {release.name}
        </Typography>
      )}
      {release.body && (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mt: 0.5, whiteSpace: "pre-wrap", fontSize: 13 }}
        >
          {release.body.length > 600 ? `${release.body.slice(0, 600)}…` : release.body}
        </Typography>
      )}
    </Box>
  );
}

/// Update tab: shows current vs latest version, update banner, and history.
export function UpdatePanel({ onToast }: Props) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (refresh: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const s = await checkUpdate(refresh);
        setStatus(s);
        if (refresh) onToast("已刷新更新信息");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [onToast],
  );

  // Check once on first open.
  useEffect(() => {
    void load(false);
  }, [load]);

  return (
    <Paper sx={{ p: 2.5 }}>
      <Stack spacing={2}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <NewReleasesIcon color="primary" />
          <Typography variant="subtitle1" sx={{ flexGrow: 1 }}>
            检查更新
          </Typography>
          <Button
            size="small"
            startIcon={loading ? <CircularProgress size={16} /> : <RefreshIcon />}
            onClick={() => load(true)}
            disabled={loading}
          >
            刷新
          </Button>
        </Stack>

        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {status?.error && (
          <Alert severity="warning">
            无法连接 GitHub 检查更新：{status.error}
          </Alert>
        )}

        {status && (
          <>
            <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  当前版本
                </Typography>
                <Typography variant="h6" sx={{ fontFamily: "monospace" }}>
                  v{status.current_version}
                </Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  最新版本
                </Typography>
                <Typography variant="h6" sx={{ fontFamily: "monospace" }}>
                  {status.latest_version ? `v${status.latest_version}` : "—"}
                </Typography>
              </Box>
            </Stack>

            {status.update_available ? (
              <Alert
                severity="info"
                icon={<NewReleasesIcon />}
                action={
                  status.latest_release?.html_url && (
                    <Button
                      color="inherit"
                      size="small"
                      href={status.latest_release.html_url}
                      target="_blank"
                      rel="noopener"
                    >
                      查看发布
                    </Button>
                  )
                }
              >
                发现新版本 v{status.latest_version}！当前为 v{status.current_version}。
                更新方式见 DEPLOY.md（推 tag 触发 CI/CD 自动部署，或 docker compose pull）。
              </Alert>
            ) : (
              status.latest_version && (
                <Alert severity="success" icon={<CheckCircleIcon />}>
                  已是最新版本。
                </Alert>
              )
            )}

            {status.history.length > 0 && (
              <Box>
                <Divider sx={{ mb: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    版本历史
                  </Typography>
                </Divider>
                <Stack divider={<Divider flexItem />}>
                  {status.history.map((r) => (
                    <HistoryItem
                      key={r.tag}
                      release={r}
                      isCurrent={r.version === status.current_version}
                    />
                  ))}
                </Stack>
              </Box>
            )}
          </>
        )}
      </Stack>
    </Paper>
  );
}
