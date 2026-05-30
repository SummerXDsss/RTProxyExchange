import { useEffect, useMemo, useState } from "react";
import { createTheme, type Theme } from "@mui/material/styles";

export type Mode = "light" | "dark";

const STORAGE_KEY = "codex-converter:mode";

/// Build the MUI theme for a given mode.
function buildTheme(mode: Mode): Theme {
  return createTheme({
    palette: {
      mode,
      primary: { main: "#10a37f" },
      secondary: { main: "#7c4dff" },
      ...(mode === "dark"
        ? { background: { default: "#0d1117", paper: "#161b22" } }
        : { background: { default: "#f5f7fa", paper: "#ffffff" } }),
    },
    typography: {
      fontFamily: "Roboto, -apple-system, BlinkMacSystemFont, sans-serif",
    },
    shape: { borderRadius: 10 },
  });
}

/// Manage light/dark mode with persistence and a system-preference default.
export function useColorMode() {
  const [mode, setMode] = useState<Mode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as Mode | null;
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  const theme = useMemo(() => buildTheme(mode), [mode]);
  const toggle = () => setMode((m) => (m === "dark" ? "light" : "dark"));

  return { mode, toggle, theme };
}
