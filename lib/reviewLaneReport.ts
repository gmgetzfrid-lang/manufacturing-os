// lib/reviewLaneReport.ts
//
// drafting-flow GAP-101 acceptance 5 (Round G, DF-P19 — the integrator's
// ruling (4) under DEC-90: read-only, built from what the ticket already
// records, no new write path, placed where the request reports live):
// "A report can count, for any period: tickets by lane, and every
// declaration with its author and text" — and, by the ruling, its work and
// code class. This is the number that says whether the like-in-kind lane is
// being used honestly.
//
// Pure: it computes the report in the browser from rows read AS THE CALLER
// (RLS decides what is counted, exactly as for the rest of the analytics
// page). Nothing is written. DF-P19 second fix pass (review major 1): the
// rows come from /api/admin/analytics/review-lanes, which reads EVERY
// request filed in the chosen period — filtered on created_at on the server
// and paged past PostgREST's max-rows (readReviewLanePeriod) — so the counts
// hold for any period, not only for the newest rows the analytics page's
// shared read holds. That shared read (newest first, counted) remains the
// fallback when the period read fails, with its coverage notice.
//
// The lanes are what the ticket records (DF-P6, 20261250), never a guess,
// and they are decided exactly as the engine decides the gate
// (lib/reviewModel.ts ticketEngineeringRequired — fix pass, review major 1:
// engineering_required true always wins, a declaration counts only while it
// is false):
//   - engineered    — engineering review is required (engineering_required
//                     true: the default for a request filed since the paste,
//                     a class or the assigner's flag, or the backfill) —
//                     INCLUDING a request declared like-in-kind and raised to
//                     engineering review since (a class marked "Requires
//                     engineering", or the assigner's flag; DF-P6 / DF-P18):
//                     the engine reviews it as engineered.
//   - like_in_kind  — the requester declared it like-in-kind at filing
//                     (lib/reviewModel.ts isDeclaredLikeInKind: a statement
//                     and its time) and engineering_required is false. The
//                     report does not re-check the declaration's e-signature
//                     (the workflow route does, and evaluates a declaration
//                     whose signature is not on record as undeclared); it
//                     says so on the page.
//   - legacy_gate   — filed before the review model and left to today's
//                     role-based gate, evaluated live (engineering_required
//                     false, no declaration).
//   - not_recorded  — the review-model columns are not in this database yet
//                     (20261250 not pasted): the lane was never recorded.
// A period is a range of FILING dates (created_at), inclusive at both ends,
// compared as UTC calendar dates (YYYY-MM-DD); either end may be open.

import { csvLine } from "@/lib/csvSafe";
import { isDeclaredLikeInKind, reviewModelFieldsFromRow } from "@/lib/reviewModel";
import type { Ticket } from "@/types/schema";

export type ReviewLane = "like_in_kind" | "engineered" | "legacy_gate" | "not_recorded";
export const REVIEW_LANES: readonly ReviewLane[] = ["engineered", "like_in_kind", "legacy_gate", "not_recorded"];
export const REVIEW_LANE_LABEL: Record<ReviewLane, string> = {
  engineered: "Engineered (engineering review required)",
  like_in_kind: "Declared like-in-kind",
  legacy_gate: "Filed before the review model (role-based gate)",
  not_recorded: "Lane not recorded (review-model columns not installed)",
};

/** What the report reads from a ticket — fields the request already carries. */
export type LaneTicket = Pick<Ticket,
  "id" | "ticketId" | "title" | "status" | "createdAt" | "requesterId" | "requesterName"
  | "engineeringRequired" | "likeInKindStatement" | "likeInKindDeclaredBy" | "likeInKindDeclaredAt" | "workClass" | "codeClass">;

/** The lane a request is in, from what it records — in the engine's order
 *  (ticketEngineeringRequired): engineering required first, then a
 *  declaration, then the pre-review-model gate. */
export function reviewLaneOf(t: Pick<LaneTicket, "engineeringRequired" | "likeInKindStatement" | "likeInKindDeclaredAt">): ReviewLane {
  if (t.engineeringRequired === true) return "engineered";
  if (t.engineeringRequired === false) return isDeclaredLikeInKind(t) ? "like_in_kind" : "legacy_gate";
  return "not_recorded";
}

export interface ReviewLanePeriod {
  /** First filing date counted (YYYY-MM-DD, UTC), or null for no lower bound. */
  from: string | null;
  /** Last filing date counted (YYYY-MM-DD, UTC), or null for no upper bound. */
  to: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A period end as typed: a valid YYYY-MM-DD or nothing. */
export function periodBound(v: string | null | undefined): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? s : null;
}

/** The request's filing date as a UTC calendar date, or null when unreadable. */
export function filingDate(createdAt: unknown): string | null {
  if (typeof createdAt !== "string" || !createdAt) return null;
  const ms = Date.parse(createdAt);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
}

/** Is this request filed inside the period? A request whose filing date
 *  cannot be read is counted only when the period is open at both ends. */
export function filedInPeriod(t: Pick<LaneTicket, "createdAt">, period: ReviewLanePeriod): boolean {
  const from = periodBound(period.from);
  const to = periodBound(period.to);
  const d = filingDate(t.createdAt);
  if (d === null) return from === null && to === null;
  return (from === null || d >= from) && (to === null || d <= to);
}

export interface DeclarationLine {
  id: string;
  ticketId: string;
  title: string;
  status: string;
  filed: string | null;
  declaredAt: string | null;
  /** The declaring person's uid, and their name where the request names them
   *  (the declaration is the requester's own, at filing). */
  declaredBy: string | null;
  declaredByName: string | null;
  statement: string;
  workClass: string | null;
  codeClass: string | null;
  /** The lane the request is in now. A declaration whose request was raised
   *  to engineering review since (a class marked "Requires engineering", or
   *  the assigner's flag) is still listed — the report lists EVERY
   *  declaration — and is counted under "engineered". */
  lane: ReviewLane;
  /** True when engineering review is required despite the declaration (the
   *  declaration was overridden). */
  overridden: boolean;
}

export interface ReviewLaneSummary {
  period: ReviewLanePeriod;
  total: number;
  lanes: Record<ReviewLane, number>;
  /** Every declaration filed in the period, oldest first — whatever lane
   *  its request is in now (an overridden one says so). */
  declarations: DeclarationLine[];
  /** Requests in the period per work class / code class (null = none set). */
  byWorkClass: Array<{ value: string | null; count: number }>;
  byCodeClass: Array<{ value: string | null; count: number }>;
}

function classCounts(rows: readonly LaneTicket[], pick: (t: LaneTicket) => string | null | undefined): Array<{ value: string | null; count: number }> {
  const m = new Map<string | null, number>();
  for (const t of rows) {
    const v = pick(t);
    const key = typeof v === "string" && v.length > 0 ? v : null;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => (a.value === null ? 1 : b.value === null ? -1 : a.value.localeCompare(b.value)));
}

/** The report for one period. Read-only; the lane counts add up to `total`. */
export function summarizeReviewLanes(rows: readonly LaneTicket[], period: ReviewLanePeriod): ReviewLaneSummary {
  const inPeriod = rows.filter((t) => filedInPeriod(t, period));
  const lanes = Object.fromEntries(REVIEW_LANES.map((l) => [l, 0])) as Record<ReviewLane, number>;
  const declarations: DeclarationLine[] = [];
  for (const t of inPeriod) {
    const lane = reviewLaneOf(t);
    lanes[lane] += 1;
    if (!isDeclaredLikeInKind(t)) continue;
    const by = typeof t.likeInKindDeclaredBy === "string" && t.likeInKindDeclaredBy ? t.likeInKindDeclaredBy : null;
    declarations.push({
      id: String(t.id ?? ""),
      ticketId: t.ticketId ?? "",
      title: t.title ?? "",
      status: String(t.status ?? ""),
      filed: filingDate(t.createdAt),
      declaredAt: typeof t.likeInKindDeclaredAt === "string" ? t.likeInKindDeclaredAt : null,
      declaredBy: by,
      declaredByName: by && by === t.requesterId && typeof t.requesterName === "string" && t.requesterName ? t.requesterName : null,
      statement: String(t.likeInKindStatement ?? "").trim(),
      workClass: t.workClass || null,
      codeClass: t.codeClass || null,
      lane,
      overridden: lane === "engineered",
    });
  }
  declarations.sort((a, b) => (a.declaredAt ?? "").localeCompare(b.declaredAt ?? "") || a.ticketId.localeCompare(b.ticketId));
  return {
    period: { from: periodBound(period.from), to: periodBound(period.to) },
    total: inPeriod.length,
    lanes,
    declarations,
    byWorkClass: classCounts(inPeriod, (t) => t.workClass),
    byCodeClass: classCounts(inPeriod, (t) => t.codeClass),
  };
}

/** DF-P19 fix pass (review minor 5): is the loaded set the whole of the
 *  period? /api/admin/analytics reads the requests NEWEST FIRST
 *  (created_at desc) with an exact count, so when the server's row limit
 *  cut the read, the requests missing are exactly those filed before the
 *  oldest one loaded. `total` is the count the route returned (null when
 *  it did not come back: then nothing can be said about a cut).
 *  - truncated: the load holds fewer requests than the workspace has
 *    (null = unknown);
 *  - oldestLoaded: the oldest filing date (UTC) in the load;
 *  - periodComplete: the period starts strictly after that date (the
 *    oldest loaded date itself may be only partly loaded), or nothing was
 *    cut. */
export interface ReviewLaneCoverage {
  loaded: number;
  total: number | null;
  truncated: boolean | null;
  oldestLoaded: string | null;
  periodComplete: boolean;
}
export function reviewLaneCoverage(rows: readonly Pick<LaneTicket, "createdAt">[], total: number | null | undefined, period: ReviewLanePeriod): ReviewLaneCoverage {
  const loaded = rows.length;
  const tot = typeof total === "number" && Number.isFinite(total) ? total : null;
  const truncated = tot === null ? null : tot > loaded;
  let oldestLoaded: string | null = null;
  for (const t of rows) {
    const d = filingDate(t.createdAt);
    if (d !== null && (oldestLoaded === null || d < oldestLoaded)) oldestLoaded = d;
  }
  const from = periodBound(period.from);
  const periodComplete = truncated === false || (truncated === true && from !== null && oldestLoaded !== null && from > oldestLoaded);
  return { loaded, total: tot, truncated, oldestLoaded, periodComplete };
}

/** The report as a CSV file (every cell through lib/csvSafe, PM-15): the lane
 *  counts, then one row per declaration. `classLabel` names a class value as
 *  the workspace's list names it now (the value itself when unlisted). */
export function reviewLaneReportCsv(
  s: ReviewLaneSummary,
  classLabel: (kind: "workClasses" | "codeClasses", value: string) => string = (_k, v) => v,
): string {
  const lines: string[] = [];
  lines.push(csvLine(["Period from", s.period.from ?? "(open)", "Period to", s.period.to ?? "(open)"]));
  lines.push(csvLine(["Lane", "Requests"]));
  for (const l of REVIEW_LANES) lines.push(csvLine([REVIEW_LANE_LABEL[l], s.lanes[l]]));
  lines.push(csvLine(["Total", s.total]));
  lines.push("");
  lines.push(csvLine(["Request", "Title", "Status", "Filed", "Declared at", "Declared by", "Statement", "Work class", "Code class", "Engineering review required since (declaration overridden)"]));
  for (const d of s.declarations) {
    lines.push(csvLine([
      d.ticketId, d.title, d.status, d.filed ?? "", d.declaredAt ?? "",
      d.declaredByName ?? d.declaredBy ?? "", d.statement,
      d.workClass ? classLabel("workClasses", d.workClass) : "",
      d.codeClass ? classLabel("codeClasses", d.codeClass) : "",
      d.overridden ? "Yes" : "No",
    ]));
  }
  return lines.join("\n");
}

// ── DF-P19 second fix pass (review major 1): the period read ────────────────
// "For any period" holds only if the report gets the whole period, whatever
// the workspace's size: /api/admin/analytics/review-lanes filters created_at
// on the server and pages through PostgREST's max-rows until every request
// of the period is read (or the hard cap below, which is then said).

/** The columns the report reads (never comments / history / attachments):
 *  with 20261250's review-model columns, then without them (every request
 *  then reads as "lane not recorded"), then "*" — tried in order on 42703. */
export const REVIEW_LANE_BASE_COLUMNS = "id, ticket_id, title, status, created_at, requester_id, requester_name";
export const REVIEW_LANE_COLUMNS = `${REVIEW_LANE_BASE_COLUMNS}, engineering_required, review_model_filed, like_in_kind_statement, like_in_kind_declared_by, like_in_kind_declared_at, like_in_kind_signature_id, work_class, code_class`;
export const REVIEW_LANE_COLUMN_LADDER: readonly string[] = [REVIEW_LANE_COLUMNS, REVIEW_LANE_BASE_COLUMNS, "*"];
/** Rows asked for per request; the server may return fewer (its max-rows),
 *  and the next page starts after the rows that actually came back. */
export const REVIEW_LANE_PAGE = 1000;
/** The most rows one period read returns; a period holding more is said to
 *  be incomplete (complete: false) and the panel says so. */
export const REVIEW_LANE_READ_CAP = 50000;

/** The UTC calendar date after `d` (YYYY-MM-DD) — the exclusive upper bound
 *  of an inclusive "to" date. */
export function nextUtcDate(d: string): string {
  const ms = Date.parse(`${d}T00:00:00Z`);
  return new Date(ms + 86400000).toISOString().slice(0, 10);
}

/** One row of the period read as the report's ticket. */
export function laneTicketFromRow(r: Record<string, unknown>): LaneTicket {
  const f = reviewModelFieldsFromRow(r);
  return {
    id: String(r.id ?? ""),
    ticketId: typeof r.ticket_id === "string" ? r.ticket_id : "",
    title: typeof r.title === "string" ? r.title : "",
    status: r.status as Ticket["status"],
    createdAt: typeof r.created_at === "string" ? r.created_at : "",
    requesterId: typeof r.requester_id === "string" ? r.requester_id : "",
    requesterName: typeof r.requester_name === "string" ? r.requester_name : "",
    engineeringRequired: f.engineeringRequired,
    likeInKindStatement: f.likeInKindStatement,
    likeInKindDeclaredBy: f.likeInKindDeclaredBy,
    likeInKindDeclaredAt: f.likeInKindDeclaredAt,
    workClass: f.workClass,
    codeClass: f.codeClass,
  } as LaneTicket;
}

/** What one period read returns: every row of the period (raw), how many
 *  the server counted for it, and whether the rows are the whole period. */
export interface ReviewLanePeriodRead {
  rows: Record<string, unknown>[];
  total: number | null;
  complete: boolean;
}

/** A PostgREST query builder, as far as the period read uses it. */
interface LaneQuery extends PromiseLike<{ data: unknown[] | null; error: { message?: string; code?: string } | null; count?: number | null }> {
  eq(col: string, v: unknown): LaneQuery;
  gte(col: string, v: unknown): LaneQuery;
  lt(col: string, v: unknown): LaneQuery;
  order(col: string, opts: { ascending: boolean }): LaneQuery;
  range(from: number, to: number): LaneQuery;
}
type LaneClient = { from(table: "tickets"): { select(cols: string, opts?: { count: "exact" }): LaneQuery } };

/** Read EVERY request of `orgId` filed in `period` through `client` (the
 *  caller-scoped client: RLS applies). Filtered on created_at on the server
 *  (inclusive UTC dates: from 00:00 of `from` to before 00:00 of the day
 *  after `to`), ordered created_at, id (a stable order to page in), and paged
 *  with .range: each page starts after the rows that came back, so a max-rows
 *  smaller than REVIEW_LANE_PAGE loses nothing. Stops at an empty page, at
 *  the count, or at REVIEW_LANE_READ_CAP (complete: false). A 42703 on the
 *  first page steps down REVIEW_LANE_COLUMN_LADDER. Throws on any other
 *  error — never a silent partial answer. */
export async function readReviewLanePeriod(client: LaneClient, orgId: string, period: ReviewLanePeriod): Promise<ReviewLanePeriodRead> {
  const from = periodBound(period.from);
  const to = periodBound(period.to);
  let rung = 0;
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let total: number | null = null;
  for (;;) {
    const first = offset === 0;
    let q = client.from("tickets").select(REVIEW_LANE_COLUMN_LADDER[rung], first ? { count: "exact" } : undefined).eq("org_id", orgId);
    if (from) q = q.gte("created_at", `${from}T00:00:00.000Z`);
    if (to) q = q.lt("created_at", `${nextUtcDate(to)}T00:00:00.000Z`);
    const want = Math.min(REVIEW_LANE_PAGE, REVIEW_LANE_READ_CAP - rows.length);
    const { data, error, count } = await q.order("created_at", { ascending: true }).order("id", { ascending: true }).range(offset, offset + want - 1);
    if (error) {
      if (first && error.code === "42703" && rung < REVIEW_LANE_COLUMN_LADDER.length - 1) { rung += 1; continue; }
      throw new Error(error.message || "The period could not be read");
    }
    if (first) total = typeof count === "number" ? count : null;
    const batch = (data ?? []) as Record<string, unknown>[];
    offset += batch.length;
    for (const r of batch) {
      const id = String(r.id ?? "");
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      rows.push(r);
    }
    if (batch.length === 0) return { rows, total, complete: true };
    if (total !== null && offset >= total) return { rows, total, complete: true };
    if (rows.length >= REVIEW_LANE_READ_CAP) return { rows, total, complete: false };
  }
}

/** What the panel says about a period read — null when it is the whole
 *  period. */
export function reviewLanePeriodNotice(read: Pick<ReviewLanePeriodRead, "total" | "complete"> & { loaded: number }): string | null {
  if (read.complete) return null;
  return `Showing the first ${read.loaded} of ${read.total ?? "more"} requests filed in this period — one read stops at ${REVIEW_LANE_READ_CAP}. Narrow the period for complete counts.`;
}
