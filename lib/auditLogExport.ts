// lib/auditLogExport.ts — the /admin/audit filters and its CSV export.
//
// admin-and-org ALOG-6 (P7): "Export CSV" serialised only the rows on screen
// (by default the last 7 days, capped at 200) under a filename that read like
// a complete export, and dropped `metadata`. Ruled (DEC-90, the integrator's
// ruling for this package): server-side paging, with the export audited.
//   * The export runs the SAME query the page runs (applyAuditFilters) and
//     pages through every matching row — in the reader's own session, so the
//     database's audit read policies decide what is in the file exactly as
//     they decide what is on screen (no service-role read, nothing widened).
//   * Keyset paging over a fixed snapshot (P7 review fix): every page of the
//     main pass is bounded above by the moment the export began ("timestamp"
//     <= it; the rows dated later are a pass of their own, below), is
//     ordered by ("timestamp" DESC, id DESC) — id is the primary key, so the
//     order is total even where many rows share one timestamp (a chunked
//     ledger write, a definer function's several rows in one transaction,
//     every member row of one transaction after 20261201) — and the next page
//     starts strictly after the last row read. OFFSET paging over the
//     non-unique timestamp could skip or repeat tied rows at a page boundary,
//     repeat a row whenever one was written mid-export, and re-ran the read
//     policies over every skipped row (n² work on a deep export). Rows with
//     no timestamp (only an explicit NULL written by the service role can
//     leave one) follow, by id, when the range is "all time" — the date
//     filters exclude them on screen and in the file alike.
//   * Rows DATED after the export began (P7 second review fix) are read
//     first, by the same keyset, and counted in the file. A row's date is a
//     clock's word, not the moment it was inserted: before 20261201 a member
//     could send a future timestamp, and a browser clock behind the database
//     dates the newest server-clocked rows after the export's start. The
//     screen shows such rows (it filters only on the lower bound), so the
//     file holds them too — "Complete: Yes" stays true for every row that
//     existed when the export began.
//   * A pass ends only on an EMPTY page (P7 review fix). PostgREST silently
//     caps a response at the project's max_rows, which an operator can set
//     below AUDIT_EXPORT_PAGE; ending on a short page would then stop after
//     the first capped page and call a truncated file complete. One extra
//     request per pass is the price.
//   * It stops at AUDIT_EXPORT_ROW_CEILING rows; the file says so inside it.
//   * The file opens with its bounds (workspace, filters, time of export, how
//     many rows, complete or stopped at the ceiling, which filters were
//     applied after paging), and its columns include User ID, Actor kind
//     (ALOG-7) and Metadata JSON.
//   * The page writes an AUDIT_LOG_EXPORTED audit row BEFORE it hands the
//     file over; a row that cannot be written means no file (who took a copy
//     of the audit log is always answerable).

import { csvCell } from "@/lib/csvSafe";
import { auditActionFilterQuery, auditRowLabel } from "@/lib/auditActions";

export type AuditRange = "24h" | "7d" | "30d" | "all";

export interface AuditFilters {
  range: AuditRange;
  /** "ALL", one action, or "family:<PREFIX>" (lib/auditActions.ts). */
  action: string;
  /** "ALL" or a resource_type. */
  resource: string;
}

export interface AuditExportRow {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string;
  orgId: string | null;
  userId: string | null;
  userEmail: string | null;
  userRole: string | null;
  actorKind: string | null;
  details: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  timestamp: string;
}

export const AUDIT_EXPORT_ROW_CEILING = 50_000;
export const AUDIT_EXPORT_PAGE = 1_000;
/** P7 review — a recorded change of file shape: before ALOG-6 the column
 *  header was line 1; the file now opens with its bounds (12 rows) and a
 *  blank line, so the header is line AUDIT_CSV_LINES_BEFORE_HEADER + 1. An
 *  import that reads row 1 as column names must skip these lines; the
 *  /admin/audit export button and its done note say so. */
export const AUDIT_CSV_LINES_BEFORE_HEADER = 13;

const RANGE_MS: Record<Exclude<AuditRange, "all">, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };

/** The lower bound a range filters on (null for "all"). */
export function rangeStartIso(range: AuditRange, nowMs: number): string | null {
  return range === "all" ? null : new Date(nowMs - RANGE_MS[range]).toISOString();
}

/** A PostgREST builder, kept structural (the generated types are too deep). */
export interface AuditQuery {
  gte(col: string, v: string): AuditQuery;
  eq(col: string, v: string): AuditQuery;
  in(col: string, v: string[]): AuditQuery;
  like(col: string, v: string): AuditQuery;
  ilike(col: string, v: string): AuditQuery;
}

/** The filters both the list and the export apply on the server. */
export function applyAuditFilters<Q extends AuditQuery>(q: Q, f: AuditFilters, nowMs: number): Q {
  let out = q;
  const since = rangeStartIso(f.range, nowMs);
  if (since) out = out.gte("timestamp", since) as Q;
  const a = auditActionFilterQuery(f.action);
  if (a?.kind === "family") out = out.like("action", a.like) as Q;
  else if (a?.kind === "in") out = (a.actions.length === 1 ? out.eq("action", a.actions[0]) : out.in("action", a.actions)) as Q;
  if (f.resource !== "ALL") out = out.eq("resource_type", f.resource) as Q;
  return out;
}

/** The user-email filter as a server-side ILIKE pattern (wildcards escaped). */
export function userEmailPattern(q: string): string | null {
  const t = q.trim();
  if (!t) return null;
  return `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function mapAuditRow(r: Record<string, unknown>): AuditExportRow {
  return {
    id: String(r.id), action: String(r.action), resourceType: String(r.resource_type), resourceId: String(r.resource_id),
    orgId: (r.org_id as string | null) ?? null, userId: (r.user_id as string | null) ?? null,
    userEmail: (r.user_email as string | null) ?? null, userRole: (r.user_role as string | null) ?? null,
    actorKind: (r.actor_kind as string | null | undefined) ?? null,
    details: (r.details as Record<string, unknown> | null) ?? null, metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    timestamp: r.timestamp == null ? "" : String(r.timestamp),
  };
}

type PageResult = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
type PageBuilder = AuditQuery & {
  lte(col: string, v: string): PageBuilder;
  gt(col: string, v: string): PageBuilder;
  lt(col: string, v: string): PageBuilder;
  is(col: string, v: null): PageBuilder;
  or(filter: string): PageBuilder;
  order(col: string, o: { ascending: boolean }): PageBuilder;
  limit(n: number): PageResult;
};

/** A value inside a PostgREST logic-tree filter (`or=(…)`), double-quoted so
 *  a timestamp's `.` / `:` / `+` never reads as syntax. */
function pgrstValue(v: string): string {
  return `"${v.replace(/["\\]/g, (c) => `\\${c}`)}"`;
}

/** The keyset condition for the page after (ts, id), newest first. */
export function afterCursorFilter(ts: string, id: string): string {
  return `timestamp.lt.${pgrstValue(ts)},and(timestamp.eq.${pgrstValue(ts)},id.lt.${pgrstValue(id)})`;
}

/** Pages through every row the filters select, newest first, up to the
 *  ceiling: first the rows dated after nowMs (counted as datedAfterStart),
 *  then the snapshot "dated at or before nowMs" (keyset paging — see the
 *  header). `start()` returns a fresh `.from("audit_logs").select(
 *  "*").eq("org_id", …)` builder for each page. A read that fails stops the
 *  export with the error (never a partial file presented as whole). */
export async function fetchAuditRowsForExport(
  start: () => PageBuilder,
  f: AuditFilters & { userQuery?: string },
  nowMs: number,
  opts: { ceiling?: number; page?: number } = {},
): Promise<{ ok: true; rows: AuditExportRow[]; complete: boolean; datedAfterStart: number } | { ok: false; error: string }> {
  const ceiling = opts.ceiling ?? AUDIT_EXPORT_ROW_CEILING;
  const page = opts.page ?? AUDIT_EXPORT_PAGE;
  const rows: AuditExportRow[] = [];
  const pattern = userEmailPattern(f.userQuery ?? "");
  const upper = new Date(nowMs).toISOString();
  const base = (): PageBuilder => {
    let q = applyAuditFilters(start(), f, nowMs) as PageBuilder;
    if (pattern) q = q.ilike("user_email", pattern) as PageBuilder;
    return q;
  };
  let datedAfterStart = 0;
  const stopped = () => ({ ok: true as const, rows: rows.slice(0, ceiling), complete: false, datedAfterStart: Math.min(datedAfterStart, ceiling) });
  // Pass 0: rows dated AFTER the start; pass 1: dated at or before it. Both
  // ("timestamp" DESC, id DESC), keyset.
  for (const pass of ["after", "upTo"] as const) {
    let cursor: { ts: string; id: string } | null = null;
    for (;;) {
      let q = pass === "after" ? base().gt("timestamp", upper) : base().lte("timestamp", upper);
      if (cursor) q = q.or(afterCursorFilter(cursor.ts, cursor.id));
      const want = Math.min(page, ceiling + 1 - rows.length);
      const { data, error } = await q.order("timestamp", { ascending: false }).order("id", { ascending: false }).limit(want);
      if (error) return { ok: false, error: error.message };
      const got = (data ?? []) as Array<Record<string, unknown>>;
      for (const r of got) rows.push(mapAuditRow(r));
      if (pass === "after") datedAfterStart += got.length;
      if (rows.length > ceiling) return stopped();
      // Only an empty page ends the pass: a short one may be the server's
      // max_rows cap, not the end of the rows.
      if (got.length === 0) break;
      const last = got[got.length - 1];
      cursor = { ts: String(last.timestamp), id: String(last.id) };
    }
  }
  // Pass 2 (all time only): rows with no timestamp, by id DESC.
  if (rangeStartIso(f.range, nowMs) === null) {
    let lastId: string | null = null;
    for (;;) {
      let q = base().is("timestamp", null);
      if (lastId) q = q.lt("id", lastId);
      const want = Math.min(page, ceiling + 1 - rows.length);
      const { data, error } = await q.order("id", { ascending: false }).limit(want);
      if (error) return { ok: false, error: error.message };
      const got = (data ?? []) as Array<Record<string, unknown>>;
      for (const r of got) rows.push(mapAuditRow(r));
      if (rows.length > ceiling) return stopped();
      if (got.length === 0) break;
      lastId = String(got[got.length - 1].id);
    }
  }
  return { ok: true, rows, complete: true, datedAfterStart };
}

export interface AuditExportBounds {
  orgId: string;
  filters: AuditFilters & { userQuery?: string; library?: { id: string; name: string } | null };
  exportedAtIso: string;
  rows: number;
  complete: boolean;
  ceiling: number;
  /** Rows the library filter left out (it is applied after paging). */
  libraryHidden?: number;
  /** Rows in the file dated after the export began (listed first). */
  datedAfterStart?: number;
}

/** The file: a bounds block, a blank line, then the header and the rows
 *  (the header on line AUDIT_CSV_LINES_BEFORE_HEADER + 1). */
export function buildAuditCsv(
  rows: readonly AuditExportRow[],
  docMeta: Map<string, { documentNumber: string | null; title: string | null }>,
  b: AuditExportBounds,
): string {
  const f = b.filters;
  const preamble: string[][] = [
    ["Audit log export"],
    ["Workspace", b.orgId],
    ["Exported at (UTC)", b.exportedAtIso],
    ["Snapshot", `every row that existed when the export began at ${b.exportedAtIso}, newest first by its date; a row inserted while the export ran may or may not be in this file`],
    ["Rows dated after the export began", `${b.datedAfterStart ?? 0} (included, listed first — a row's date is the clock of whoever wrote it, so a row can be dated later than it was written)`],
    ["Date range", f.range === "all" ? "All time" : f.range],
    ["Action filter", f.action === "ALL" ? "All actions" : f.action],
    ["Resource filter", f.resource === "ALL" ? "Any resource" : f.resource],
    ["User email contains", f.userQuery?.trim() ? f.userQuery.trim() : "(none)"],
    ["Library filter", f.library ? `${f.library.name} — document rows of this library and the library's own rows; ${b.libraryHidden ?? 0} other row(s) left out` : "(none)"],
    ["Rows in this file", String(b.rows)],
    ["Complete", b.complete
      ? "Yes — every row the filters select that you may read"
      : `NO — stopped at ${b.ceiling} rows (newest first); narrow the date range or filters for the rest`],
  ];
  const header = ["Timestamp", "Action", "Action code", "Resource Type", "Resource ID", "Resource Label", "User ID", "User Email", "User Role", "Actor kind", "Details JSON", "Metadata JSON"];
  const lines = preamble.map((r) => r.map(csvCell).join(","));
  lines.push("");
  lines.push(header.map(csvCell).join(","));
  for (const r of rows) {
    const dm = r.resourceType === "document" ? docMeta.get(r.resourceId) : undefined;
    lines.push([
      r.timestamp || "(no timestamp)", auditRowLabel(r.action, r.details), r.action, r.resourceType, r.resourceId,
      dm ? [dm.documentNumber, dm.title].filter(Boolean).join(" · ") : "",
      r.userId ?? "", r.userEmail ?? "", r.userRole ?? "", r.actorKind ?? "(before 20261201: as sent)",
      r.details ? JSON.stringify(r.details) : "", r.metadata ? JSON.stringify(r.metadata) : "",
    ].map(csvCell).join(","));
  }
  return lines.join("\n");
}

/** Applies the library filter (client-side: it needs each document's library). */
export function filterByLibrary<T extends { resourceType: string; resourceId: string }>(
  rows: readonly T[], libraryId: string, libraryOf: (docId: string) => string | undefined,
): { kept: T[]; hidden: number } {
  const kept = rows.filter((r) =>
    (r.resourceType === "document" && libraryOf(r.resourceId) === libraryId)
    || (r.resourceType === "library" && r.resourceId === libraryId));
  return { kept, hidden: rows.length - kept.length };
}
