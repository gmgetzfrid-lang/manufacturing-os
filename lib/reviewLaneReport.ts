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
// Pure: it reads the rows /api/admin/analytics already returns (a
// select("*") of the workspace's tickets as the caller — RLS decides what
// is counted, exactly as for the rest of the analytics page) and computes
// the report in the browser. Nothing is written.
//
// The lanes are what the ticket records (DF-P6, 20261250), never a guess:
//   - like_in_kind  — the requester declared it like-in-kind at filing
//                     (lib/reviewModel.ts isDeclaredLikeInKind: a statement
//                     and its time). The report does not re-check the
//                     declaration's e-signature (the workflow route does,
//                     and evaluates a declaration whose signature is not on
//                     record as undeclared); it says so on the page.
//   - engineered    — engineering review is required (engineering_required
//                     true: the default for a request filed since the paste,
//                     a class or the assigner's flag, or the backfill).
//   - legacy_gate   — filed before the review model and left to today's
//                     role-based gate, evaluated live (engineering_required
//                     false, no declaration).
//   - not_recorded  — the review-model columns are not in this database yet
//                     (20261250 not pasted): the lane was never recorded.
// A period is a range of FILING dates (created_at), inclusive at both ends,
// compared as UTC calendar dates (YYYY-MM-DD); either end may be open.

import { csvLine } from "@/lib/csvSafe";
import { isDeclaredLikeInKind } from "@/lib/reviewModel";
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

/** The lane a request is in, from what it records. */
export function reviewLaneOf(t: Pick<LaneTicket, "engineeringRequired" | "likeInKindStatement" | "likeInKindDeclaredAt">): ReviewLane {
  if (isDeclaredLikeInKind(t)) return "like_in_kind";
  if (t.engineeringRequired === true) return "engineered";
  if (t.engineeringRequired === false) return "legacy_gate";
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
}

export interface ReviewLaneSummary {
  period: ReviewLanePeriod;
  total: number;
  lanes: Record<ReviewLane, number>;
  /** Every declaration filed in the period, oldest first. */
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
    if (lane !== "like_in_kind") continue;
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
  lines.push(csvLine(["Request", "Title", "Status", "Filed", "Declared at", "Declared by", "Statement", "Work class", "Code class"]));
  for (const d of s.declarations) {
    lines.push(csvLine([
      d.ticketId, d.title, d.status, d.filed ?? "", d.declaredAt ?? "",
      d.declaredByName ?? d.declaredBy ?? "", d.statement,
      d.workClass ? classLabel("workClasses", d.workClass) : "",
      d.codeClass ? classLabel("codeClasses", d.codeClass) : "",
    ]));
  }
  return lines.join("\n");
}
