import { useCallback, useEffect, useState } from "react";
import type { BatchResult, HistoryEntry } from "../types";

const STORAGE_KEY = "codex-converter:history";
const MAX_ENTRIES = 20;

/// Persist recent batch results in localStorage. Results may contain full
/// credentials, so the privacy notice explicitly discloses this behavior.
export function useHistory() {
  const [entries, setEntries] = useState<HistoryEntry[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // storage may be full or disabled; ignore
    }
  }, [entries]);

  const add = useCallback((result: BatchResult) => {
    const entry: HistoryEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      total: result.total,
      success: result.success,
      failed: result.failed,
      result,
    };
    setEntries((prev) => [entry, ...prev].slice(0, MAX_ENTRIES));
  }, []);

  const remove = useCallback((id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const clear = useCallback(() => setEntries([]), []);

  return { entries, add, remove, clear };
}
