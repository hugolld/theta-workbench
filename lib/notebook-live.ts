import type { NotebookViewModel } from "./notebook";

/**
 * The notebook pane's live reconciliation (M7b-1 ticket #4): loads and
 * deltas meet here, so the pane draws while the two epochs guarantee the
 * picture converges on the file. One home, and testable without a
 * browser — the race orderings are pinned at this seam in
 * lib/notebook-live.test.mjs.
 *
 * - A delta invalidates any read in flight (the file moved under it; its
 *   snapshot is stale, and applying it would erase the merged line), and
 *   the read re-runs instead.
 * - A newer load supersedes an older one's response.
 * - The read failing stays failed until a load succeeds — a delta never
 *   papers over it.
 */
export interface NotebookSnapshot {
  notebook: NotebookViewModel | null;
  /** The read's complete lines — the authoritative buffer the deltas amend. */
  lines: string[];
}

export interface NotebookLiveHost {
  /** The read's in-flight flag (a re-read under a racing delta keeps it lit). */
  onLoading(loading: boolean): void;
  /** A read landed and is current: the pane's picture becomes exactly this. */
  onSnapshot(snapshot: NotebookSnapshot): void;
  /** Appended lines' bytes merged into the buffer. */
  onDelta(lines: string[]): void;
  /** The read failed and nothing newer took over: the pane says so. */
  onError(): void;
}

export interface NotebookLiveDeps {
  cwd: string;
  /** The snapshot read. Throws on failure (HTTP status included). */
  fetchSnapshot(cwd: string): Promise<{ notebook: NotebookViewModel | null; lines: unknown }>;
}

export function createNotebookLive(
  deps: NotebookLiveDeps,
  host: NotebookLiveHost,
): {
  /** A `append` frame's payload lines: validated, epoch-bumped, merged. */
  delta(lines: unknown[]): void;
  /** Read the whole notebook (open, reconnect, reset, refresh). */
  load(): Promise<void>;
} {
  let request = 0;
  let frames = 0;
  return {
    delta(lines: unknown[]): void {
      const landed = lines.filter((line): line is string => typeof line === "string");
      if (landed.length === 0) return;
      frames += 1;
      host.onDelta(landed);
    },
    async load(): Promise<void> {
      for (;;) {
        const requestId = ++request;
        const epoch = frames;
        host.onLoading(true);
        try {
          const body = await deps.fetchSnapshot(deps.cwd);
          if (requestId !== request) return; // a newer load supersedes this one
          if (epoch !== frames) continue; // a delta raced the read: the file moved, read again
          host.onSnapshot({
            notebook: body.notebook ?? null,
            lines: Array.isArray(body.lines) ? (body.lines as string[]) : [],
          });
          host.onLoading(false);
          return;
        } catch (error) {
          if (requestId !== request) return; // a newer load owns the outcome
          host.onError();
          host.onLoading(false);
          throw error;
        }
      }
    },
  };
}
