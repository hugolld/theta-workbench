/**
 * The notebook view-model (M7b-1 ticket #3): the research project's
 * `.theta/notebook.jsonl` rendered whole in theta-agent's `/notebook`
 * grammar — a header with the entry count and the grade totals, one row
 * per entry in file order (the journal is append-only, so file order is
 * provenance order), evidence items as grade-badged lines. The grammar is
 * theta-agent's own (`extensions/notebook-command.ts`, the B2 command,
 * and `extensions/notebook-cards.ts`, the validator): line bytes are the
 * entry identity, so identical lines dedupe; a line that does not parse
 * as a typed, dated provenance entry never renders; and a trailing
 * segment without its newline is a torn write in flight — it stays
 * invisible until the write completes. Pure and JSON-shaped: the API
 * route serves it and the pane component draws it.
 *
 * Ticket #4 adds the live tail: the file's complete lines as raw bytes
 * (`notebookLines`, the pane's buffer and the GET route's handover) and
 * the appended lines between two reads (`newNotebookLines`, the watch
 * route's deltas). Both are byte-honest — malformed lines and duplicates
 * ride along — because rendering's gate above, not the tail, judges them.
 */

/** The evidence grades (theta-agent GLOSSARY): the trust mark on a source, never on judgment. */
export const GRADES = ["asserted", "cross-checked", "re-executed"] as const;

export type EvidenceGrade = (typeof GRADES)[number];

/** The five entry types (ADR 0003) and the id prefix each sequences under. */
export const TYPE_PREFIX = {
  hypothesis: "hyp",
  method: "mth",
  observation: "obs",
  decision: "dec",
  confidence: "cnf",
} as const;

export type EntryType = keyof typeof TYPE_PREFIX;

/** One evidence item as the recorder writes it — connector output or job record. */
export interface EvidenceItem {
  source: string;
  endpoints?: string[];
  query?: string | null;
  retrieved: string;
  grade: EvidenceGrade;
  snapshot?: string;
  supports?: string;
  job_id?: string;
  template?: string | null;
  state?: string;
}

/** A provenance entry as the recorder writes it — one notebook line. */
export interface NotebookEntry {
  id: string;
  type: EntryType;
  date: string;
  text: string;
  /** The observation's own grade — an observation is itself a source claim. */
  grade?: EvidenceGrade;
  /** The hypothesis a confidence entry judges — judgment's named subject. */
  hypothesis?: string;
  evidence?: EvidenceItem[];
}

/** One grade's header total, in GRADES order. */
export interface NotebookGradeTotal {
  grade: EvidenceGrade;
  count: number;
}

export interface NotebookHeader {
  /** The grammar bytes: "Theta notebook - 5 entries - grades: 2 asserted, 1 cross-checked". */
  text: string;
  entryCount: number;
  /** Only the grades something carries, greatest vocabulary order first (GRADES order). */
  gradeTotals: NotebookGradeTotal[];
}

/** One evidence item as the pane draws it — the badge and the expandable detail. */
export interface NotebookEvidenceView {
  source: string;
  grade: EvidenceGrade;
  /** The provenance detail bytes: endpoints called, or the job's identity. */
  detail: string;
  /** The hypothesis this evidence supports. */
  supports?: string;
  /** The content-addressed snapshot reference, when the recorder captured one. */
  snapshot?: string;
}

/** One entry as the pane draws it — one row of the trail. */
export interface NotebookEntryView {
  id: string;
  type: EntryType;
  date: string;
  text: string;
  /** The row's text column per the grammar: observation "[grade] text", confidence "judgment on X - text". */
  rowText: string;
  /** The observation's own grade — the row's badge. */
  grade?: EvidenceGrade;
  /** The hypothesis a confidence entry judges. */
  hypothesis?: string;
  evidence: NotebookEvidenceView[];
}

export interface NotebookViewModel {
  header: NotebookHeader;
  entries: NotebookEntryView[];
}

/**
 * One evidence item's provenance detail — the endpoints called, or the
 * job's identity. Ported byte-identical from theta-agent's
 * `evidenceDetail` (extensions/notebook-cards.ts), so the detail never
 * forks between the TUI surfaces and this pane.
 */
export function evidenceDetail(item: EvidenceItem): string {
  const retrieved = `retrieved ${item.retrieved}`;
  if (item.job_id !== undefined) {
    const template =
      item.template === undefined
        ? ""
        : ` · ${item.template === null ? "no template" : `template ${item.template}`}`;
    return `job ${item.job_id}${item.state === undefined ? "" : ` ${item.state}`}${template} · ${retrieved}`;
  }
  const endpoints =
    item.endpoints === undefined || item.endpoints.length === 0
      ? ""
      : ` via ${item.endpoints.join(", ")}`;
  return `${retrieved}${endpoints}`;
}

function idPattern(prefix: string): RegExp {
  return new RegExp(`^${prefix}-\\d+$`);
}

/** A hypothesis reference shape — a confidence subject or a supports link. */
function isHypRef(value: unknown): value is string {
  return typeof value === "string" && idPattern("hyp").test(value);
}

/**
 * A real YYYY-MM-DD calendar date — the same bar the recorder and
 * theta-agent's cards hold: shape alone is not a date, and `new Date`
 * rolls `2026-02-30` over instead of refusing it, so the check
 * round-trips through a UTC construction.
 */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const constructed = new Date(Date.UTC(year, month - 1, day));
  return (
    constructed.getUTCFullYear() === year &&
    constructed.getUTCMonth() === month - 1 &&
    constructed.getUTCDate() === day
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** One of the three evidence grades — the badge vocabulary, shared by the item's grade and the observation's own. */
function isGrade(value: unknown): value is EvidenceGrade {
  return typeof value === "string" && (GRADES as readonly string[]).includes(value);
}

/**
 * One evidence item, validated to the fields the pane reads: a non-empty
 * source, one of the three grades, a calendar-valid retrieval date, and —
 * when a link rides it — a hypothesis id shape. The item's deeper shape
 * (endpoints, job identity, snapshot address) is the recorder's own
 * validation; the pane renders what is there and requires only what it
 * names.
 */
function isEvidenceItem(value: unknown): value is EvidenceItem {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (!nonEmptyString(item.source)) return false;
  if (!isGrade(item.grade)) return false;
  if (typeof item.retrieved !== "string" || !isCalendarDate(item.retrieved)) return false;
  if (item.supports !== undefined && !isHypRef(item.supports)) return false;
  return true;
}

/** A non-empty evidence list — hypothesis and observation require one. */
function isEvidenceList(value: unknown): value is EvidenceItem[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => isEvidenceItem(item));
}

/**
 * One notebook line as a typed, dated provenance entry, or undefined:
 * the gate every line crosses before it renders. Ported from theta-agent's
 * `parseProvenanceEntry` (extensions/notebook-cards.ts). The id must
 * carry its own type's prefix (the recorder sequences ids per type), the
 * date must name a real calendar day, and each type's own essentials
 * must hold — evidence on a hypothesis and an observation (with its own
 * grade), a named hypothesis on a confidence. Method and decision entries
 * carry evidence only when a motivating source was recorded; a confidence
 * entry never does, and extra fields beyond the pane's needs are the
 * recorder's business.
 */
export function parseProvenanceEntry(line: string): NotebookEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const entry = parsed as Record<string, unknown>;
  const type = entry.type;
  if (typeof type !== "string" || !(type in TYPE_PREFIX)) return undefined;
  const entryType = type as EntryType;
  if (typeof entry.id !== "string" || !idPattern(TYPE_PREFIX[entryType]).test(entry.id)) {
    return undefined;
  }
  if (typeof entry.date !== "string" || !isCalendarDate(entry.date)) return undefined;
  if (!nonEmptyString(entry.text)) return undefined;
  const evidence = entry.evidence;
  if (entryType === "hypothesis" || entryType === "observation") {
    if (!isEvidenceList(evidence)) return undefined;
  } else if (evidence !== undefined && !isEvidenceList(evidence)) {
    return undefined;
  }
  if (entryType === "observation" && !isGrade(entry.grade)) return undefined;
  if (entryType === "confidence" && !isHypRef(entry.hypothesis)) return undefined;
  return { ...(entry as unknown as NotebookEntry) };
}

/**
 * The file's complete lines as raw bytes — the trailing segment without
 * its newline (a torn write in flight) held back. Malformed lines and
 * duplicates ride along: this is the pane's live buffer and the GET
 * route's handover, and the render gate judges the bytes, not the tail.
 */
export function notebookLines(content: string): string[] {
  const lines = content.split("\n");
  lines.pop();
  return lines;
}

/**
 * The complete lines appended since a previous read of the same file —
 * `[]` when nothing was appended. A tail torn off `previous` completes
 * here (its bytes plus the appended segment form the line); a tail torn
 * off `current` stays held. `null` when `current` is not an append of
 * `previous` (shrunk, rewritten, emptied): the caller resets its picture
 * of the file.
 */
export function newNotebookLines(previous: string, current: string): string[] | null {
  if (!current.startsWith(previous)) return null;
  if (current === previous) return [];
  // The segment from `previous`'s last newline: a torn tail of `previous`
  // rides at its front and completes there, the rest is appended fresh —
  // so the split's elements are already the appended lines, byte-exact.
  const tail = previous.endsWith("\n") ? "" : previous.slice(previous.lastIndexOf("\n") + 1);
  const segment = current.slice(previous.length - tail.length);
  const lines = segment.split("\n");
  lines.pop(); // `current`'s own torn tail stays invisible
  return lines;
}

/**
 * The grade totals across what renders — every evidence item's grade plus
 * the observations' own (an observation is itself a source claim), the
 * grammar's own rule (theta-agent `extensions/notebook-command.ts`). A
 * grade on any other entry type is an extra field the recorder let ride:
 * it never joins the header.
 */
function gradeTotals(entries: NotebookEntryView[]): NotebookGradeTotal[] {
  const counts = new Map<EvidenceGrade, number>();
  const count = (grade: EvidenceGrade): void => {
    counts.set(grade, (counts.get(grade) ?? 0) + 1);
  };
  for (const entry of entries) {
    if (entry.type === "observation" && entry.grade !== undefined) count(entry.grade);
    for (const item of entry.evidence) count(item.grade);
  }
  return GRADES.filter((grade) => (counts.get(grade) ?? 0) > 0).map((grade) => ({
    grade,
    count: counts.get(grade) as number,
  }));
}

/** The row's text column: the observation's grade leads, a confidence names its subject. */
function rowText(entry: NotebookEntry): string {
  if (entry.type === "observation") return `[${entry.grade}] ${entry.text}`;
  if (entry.type === "confidence") return `judgment on ${entry.hypothesis} - ${entry.text}`;
  return entry.text;
}

/**
 * The whole notebook as the pane's view-model: every complete line that
 * parses, in file order, deduped by line bytes, under the grammar header.
 */
export function notebookViewModel(content: string): NotebookViewModel {
  const lines = notebookLines(content);
  const seen = new Set<string>();
  const entries: NotebookEntryView[] = [];
  for (const line of lines) {
    if (line === "" || seen.has(line)) continue;
    seen.add(line);
    const parsed = parseProvenanceEntry(line);
    if (parsed === undefined) continue;
    const evidence = (parsed.evidence ?? []).map((item) => ({
      source: item.source,
      grade: item.grade,
      detail: evidenceDetail(item),
      ...(item.supports !== undefined && { supports: item.supports }),
      ...(item.snapshot !== undefined && { snapshot: item.snapshot }),
    }));
    entries.push({
      id: parsed.id,
      type: parsed.type,
      date: parsed.date,
      text: parsed.text,
      rowText: rowText(parsed),
      // The row badge is the observation's own grade — the grammar's rule;
      // a grade field on any other type is a stray extra field that never
      // rides the view (and so never badges in the pane).
      ...(parsed.type === "observation" && parsed.grade !== undefined && { grade: parsed.grade }),
      ...(parsed.hypothesis !== undefined && { hypothesis: parsed.hypothesis }),
      evidence,
    });
  }
  const totals = gradeTotals(entries);
  const count = `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;
  const totalsText = totals.map((total) => `${total.count} ${total.grade}`).join(", ");
  return {
    header: {
      text: totalsText === ""
        ? `Theta notebook - ${count}`
        : `Theta notebook - ${count} - grades: ${totalsText}`,
      entryCount: entries.length,
      gradeTotals: totals,
    },
    entries,
  };
}
