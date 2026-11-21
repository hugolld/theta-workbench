"use client";

import { useCallback, useRef, useState } from "react";
import { FILE_WATCH_HEARTBEAT_MS } from "@/lib/file-version";

/**
 * Keeps a watch's EventSource alive (ticket #4 moves this out of
 * FileViewer: the notebook pane's live tail is the second caller, and the
 * shared shape gets one home). The browser never retries an EventSource
 * whose reconnect got an HTTP error (a proxy's 502 while pi-web restarts),
 * and a half-open connection (sleep, a dropped NAT entry) goes quiet
 * without one. Either way the caller opens a new watch — bumping the
 * returned attempt, which its effect depends on — and its `connected`
 * reads the file again if it changed meanwhile. `livenessEvents` names the
 * stream's data events (the heartbeats are `ping` for every watch): each
 * one proves the connection alive and resets the stale watchdog.
 */
// Stable identities: a fresh array per render would re-run every caller's
// effect through the changing `supervise` callback.
const DEFAULT_LIVENESS_EVENTS: readonly string[] = ["connected", "change", "ping"];

/** The notebook watch's data events (hooks/useWatchRecovery.ts consumers pass their stream's own). */
export const NOTEBOOK_LIVENESS_EVENTS: readonly string[] = ["connected", "append", "reset", "ping"];

export function useWatchRecovery(livenessEvents: readonly string[] = DEFAULT_LIVENESS_EVENTS): [number, (es: EventSource) => () => void] {
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  const supervise = useCallback((es: EventSource) => {
    let stale: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const reopen = () => {
      clearTimeout(stale);
      es.close();
      retry ??= setTimeout(() => setAttempt((n) => n + 1), Math.min(1000 * 2 ** failures.current++, FILE_WATCH_HEARTBEAT_MS));
    };
    const alive = () => {
      clearTimeout(stale);
      stale = setTimeout(reopen, FILE_WATCH_HEARTBEAT_MS * 2.5);
    };
    es.addEventListener("connected", () => { failures.current = 0; });
    for (const name of livenessEvents) es.addEventListener(name, alive);
    es.addEventListener("error", () => { if (es.readyState === EventSource.CLOSED) reopen(); });
    alive();
    return () => { clearTimeout(stale); clearTimeout(retry); };
  }, [livenessEvents]);
  return [attempt, supervise];
}
