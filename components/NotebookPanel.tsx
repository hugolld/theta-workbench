"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { NOTEBOOK_LIVENESS_EVENTS, useWatchRecovery } from "@/hooks/useWatchRecovery";
import { notebookViewModel, type NotebookViewModel } from "@/lib/notebook";

/**
 * The notebook pane (M7b-1 tickets #3–#4): the research project's notebook
 * drawn whole in theta-agent's `/notebook` grammar — the grammar's bytes
 * come from `lib/notebook.ts`, this surface only draws them. A project
 * view, unlike the TUI's per-session cards: every pre-existing entry
 * renders from the start, in file order (provenance order). Read-only by
 * construction — the pane fetches and draws, and no method here touches
 * the notebook; recording stays in the loop's recorder. Evidence items
 * are grade-badged lines; the retrieval detail (and the snapshot
 * reference) sits behind an expand, so the trail reads at a glance and
 * the provenance is one click away.
 *
 * Liveness (ticket #4): one watch stream per open pane. The stream hands
 * over the appended lines' bytes; the pane appends them to its buffer of
 * raw lines and re-derives the view-model through the grammar's gate —
 * no reload, whichever session appended the lines, malformed lines never
 * rendering and re-sent lines deduping by their bytes. A `reset` (the
 * file rewritten under the stream) re-reads the whole notebook.
 */

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** An expandable evidence line's state key — the entry's id and the item's place in it. */
const evidenceKey = (entryId: string, itemIndex: number): string => `${entryId}:${itemIndex}`;

/** The grade badge — the grammar's bracket bytes, as a span the grade names. */
function GradeBadge({ grade }: { grade: string }) {
  return (
    <span className="notebook-grade" data-grade={grade} style={{
      color: "var(--accent)",
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      whiteSpace: "nowrap",
    }}>
      {`[${grade}]`}
    </span>
  );
}

export interface NotebookPanelViewProps {
  /** The whole notebook's view-model, or null: no notebook (or none yet read). */
  notebook: NotebookViewModel | null;
  /** The last read failed — say so, never render a stale trail. */
  failed: boolean;
  /** The first read is still in flight. */
  loading: boolean;
  /** The expanded evidence lines' state keys. */
  expanded: ReadonlySet<string>;
  onToggleEvidence: (key: string) => void;
  onRefresh: () => void;
  t: Translate;
}

/** The pane's draw, state injected — the wrapper holds the fetch and the expand set. */
export function NotebookPanelView({ notebook, failed, loading, expanded, onToggleEvidence, onRefresh, t }: NotebookPanelViewProps) {
  if (failed) {
    return (
      <div className="notebook-panel" aria-label={t("notebook.panelLabel")} style={{ padding: "16px", color: "var(--text-muted)", fontSize: 12 }}>
        {t("notebook.loadFailed")}
      </div>
    );
  }
  if (notebook === null) {
    return (
      <div className="notebook-panel" aria-label={t("notebook.panelLabel")} style={{ padding: "16px", color: "var(--text-muted)", fontSize: 12 }}>
        {loading ? "…" : t("notebook.absent")}
      </div>
    );
  }
  const monoStyle = { fontFamily: "var(--font-mono)", fontSize: 11 } as React.CSSProperties;
  return (
    <section className="notebook-panel" aria-label={t("notebook.panelLabel")} style={{
      display: "flex", flexDirection: "column", height: "100%", minHeight: 0,
      background: "var(--bg)", color: "var(--text)",
    }}>
      <header style={{
        display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
        padding: "8px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)",
      }}>
        <span className="notebook-heading" style={{ flex: 1, fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {notebook.header.text}
        </span>
        <button
          type="button"
          className="notebook-refresh"
          onClick={onRefresh}
          title={t("notebook.refresh")}
          aria-label={t("notebook.refresh")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 24, height: 24, padding: 0, flexShrink: 0,
            background: "transparent", border: "none", color: "var(--text-muted)",
            cursor: "pointer", transition: "color 0.12s",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
          </svg>
        </button>
      </header>
      <ol className="notebook-entries" style={{
        flex: 1, minHeight: 0, overflowY: "auto", margin: 0, padding: "8px 12px",
        listStyle: "none", fontSize: 12, lineHeight: 1.5,
      }}>
        {notebook.entries.map((entry, entryIndex) => (
          <li key={`${entry.id}:${entryIndex}`} className="notebook-entry" style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
            <div className="notebook-row" style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span className="notebook-id" style={{ ...monoStyle, color: "var(--text-muted)" }}>{entry.id}</span>
              <span className="notebook-type" style={{ ...monoStyle, color: "var(--text-muted)" }}>{entry.type}</span>
              <span className="notebook-date" style={{ ...monoStyle, color: "var(--text-muted)" }}>{entry.date}</span>
              <span className="notebook-text" style={{ flex: 1, minWidth: 160, wordBreak: "break-word" }}>
                {entry.grade !== undefined ? <><GradeBadge grade={entry.grade} />{" "}{entry.text}</> : entry.rowText}
              </span>
            </div>
            {entry.evidence.map((item, itemIndex) => {
              const key = evidenceKey(entry.id, itemIndex);
              const open = expanded.has(key);
              return (
                <div key={key} className="notebook-evidence" style={{ marginLeft: 20 }}>
                  <button
                    type="button"
                    className="notebook-evidence-line"
                    onClick={() => onToggleEvidence(key)}
                    aria-expanded={open}
                    style={{
                      display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap", width: "100%",
                      padding: "2px 0", background: "transparent", border: "none",
                      color: "var(--text)", textAlign: "left", cursor: "pointer", fontSize: 12,
                    }}
                  >
                    <span aria-hidden="true" style={{ color: "var(--text-muted)" }}>{open ? "▾" : "▸"}</span>
                    <span className="notebook-evidence-source" style={{ ...monoStyle }}>{item.source}</span>
                    <GradeBadge grade={item.grade} />
                    {item.supports !== undefined && (
                      <span className="notebook-supports" style={{ color: "var(--text-muted)" }}>
                        {`${t("notebook.supports")} ${item.supports}`}
                      </span>
                    )}
                  </button>
                  {open && (
                    <div className="notebook-evidence-detail" style={{
                      marginLeft: 16, padding: "2px 0 4px",
                      color: "var(--text-muted)", ...monoStyle, wordBreak: "break-all",
                    }}>
                      <div className="notebook-evidence-provenance">{item.detail}</div>
                      {item.snapshot !== undefined && (
                        <div className="notebook-evidence-snapshot">{`${t("notebook.snapshot")} ${item.snapshot}`}</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </li>
        ))}
      </ol>
    </section>
  );
}

interface Props {
  /** The selected research project's root — the notebook's owner. */
  cwd: string;
}

/** The pane: one fetch per project cwd, the grammar drawn whole — and, from ticket #4 on, live. */
export function NotebookPanel({ cwd }: Props) {
  const { t } = useI18n();
  const [notebook, setNotebook] = useState<NotebookViewModel | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // The live buffer: the notebook's complete lines as raw bytes. The watch
  // stream appends to it and the view-model re-derives through the same
  // gate the initial fetch drew from, so a delta can never disagree with
  // the picture it amends. A failed read stays failed until a load
  // succeeds — a delta never papers over it.
  const linesRef = useRef<string[]>([]);
  // Loads and deltas reconcile through two epochs: a delta invalidates any
  // read in flight (the file moved under it — its snapshot is stale, and
  // applying it would erase the merged line), and the read re-runs instead;
  // a newer load supersedes an older one's response. Without this, a GET
  // landing after an append frame would wipe the merged lines.
  const requestRef = useRef(0);
  const frameRef = useRef(0);
  const [watchAttempt, superviseWatch] = useWatchRecovery(NOTEBOOK_LIVENESS_EVENTS);

  const load = useCallback(async () => {
    for (;;) {
      const requestId = ++requestRef.current;
      const epoch = frameRef.current;
      setLoading(true);
      try {
        const response = await fetch(`/api/notebook?cwd=${encodeURIComponent(cwd)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json() as { notebook: NotebookViewModel | null; lines?: unknown };
        if (requestId !== requestRef.current) return; // a newer load supersedes this one
        if (epoch !== frameRef.current) continue; // a delta raced the read: the file moved, read again
        linesRef.current = Array.isArray(body.lines) ? (body.lines as string[]) : [];
        setNotebook(body.notebook ?? null);
        setFailed(false);
        return;
      } catch {
        if (requestId === requestRef.current) {
          setNotebook(null);
          setFailed(true);
        }
        return;
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    }
  }, [cwd]);

  useEffect(() => {
    setExpanded(new Set());
    void load();
  }, [load]);

  // The live tail (ticket #4): the stream's deltas are the appended lines'
  // bytes — the pane merges them into its buffer and re-derives, whichever
  // session appended them, with no reload. Line bytes are the identity, so
  // a line the pane already holds renders once however often it is
  // re-sent. `connected` (the open, and every reconnect after sleep or a
  // dropped stream) and `reset` (the file rewritten under the stream) read
  // the whole notebook again: whatever rode in while the stream was gone
  // or unreadable reconciles there, never through a missed delta.
  useEffect(() => {
    const es = new EventSource(`/api/notebook/watch?cwd=${encodeURIComponent(cwd)}`);
    const stopSupervising = superviseWatch(es);
    es.addEventListener("append", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { lines?: unknown };
        if (!Array.isArray(data.lines)) return;
        const lines = data.lines.filter((line): line is string => typeof line === "string");
        if (lines.length === 0) return;
        frameRef.current += 1; // any read in flight just went stale; it re-runs
        linesRef.current.push(...lines);
        setNotebook(notebookViewModel(`${linesRef.current.join("\n")}\n`));
      } catch {
        // a malformed frame is no delta
      }
    });
    es.addEventListener("connected", () => {
      void load();
    });
    es.addEventListener("reset", () => {
      void load();
    });
    return () => {
      es.close();
      stopSupervising();
    };
  }, [cwd, watchAttempt, superviseWatch, load]);

  const toggleEvidence = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <NotebookPanelView
      notebook={notebook}
      failed={failed}
      loading={loading}
      expanded={expanded}
      onToggleEvidence={toggleEvidence}
      onRefresh={() => void load()}
      t={t}
    />
  );
}
