// lib/documentNoticeRecord.ts
//
// document-control Round G — P38 DOCUMENT NOTICE RECORD (DIST-19, the
// document half of drafting-flow EVID-8). Every reminder and escalation the
// three document scans send — the pre-publish review scan (lib/reviewControl.ts
// scanReviews), the read-&-understood scan (lib/acknowledgments.ts
// scanAndNotifyAcks) and the distribution-ack nag (lib/distributionAcks.ts
// scanDistributionAcks) — is a durable fact on the record once its bell row
// LANDED: one append-only document_notice_events row per notice (20261257,
// the ticket_notice_events shape of 20261255). The bell rows themselves are
// purgeable; this record is not, and it is never rewritten.
//
// DEC-90 rulings for P38 (fail-safe, no regression):
//   · a row is written only for a notice that actually landed (notifyCompliance
//     answered true); a notice that dead-lettered leaves no row;
//   · a write failure NEVER fails the scan and never changes who is reminded
//     or when: every existing column (notified_at) is written exactly as
//     before, in the same place. A failed write is retried once at once; if it
//     still fails, the rows are kept in ONE audit row
//     (DOCUMENT_NOTICE_RECORD_DEFERRED, the system actor) and the scan's next
//     run writes them (replayDeferredNotices — the same row ids, so a replay
//     never writes a second copy);
//   · merge-time fix pass: audit_logs is readable by every member of the
//     workspace (audit_logs_org_access), while the record is read as the
//     document reads (ACL included) and a not_emailed row only by its person.
//     So the deferred audit row keeps only what a replay needs
//     (deferredPayloadRow): the ids, kind, source and noticed_at, and of
//     details only finite numbers, booleans and the one known enum value
//     (cause: "review_timeout") — never free text, never a not_emailed
//     row's details.reason, never the revision label (the replay re-reads
//     it from the obligation's own row). What it still shows every member:
//     that a notice of that kind about that document went to that person at
//     that time — for a document under an ACL, a fact the record itself
//     would show only to its readers (said in DIST-19);
//   · P38 fix pass: the replay trusts ONLY a system row (user_id NULL — a
//     signed-in member's insert must name their own uid under
//     audit_logs_insert, and 20261257 refuses them the action outright), and
//     rebuilds each row from the DocumentNoticeRow columns alone: kind and
//     source checked against the unions, ids checked to be non-empty text
//     (the database refuses one that is not a UUID — 22P02, dropped for good
//     by the replay), noticed_at never later than the audit row that kept
//     it. The cooldown read never counts a notice dated in the future, and
//     (merge-time fix pass) is keyset-paged, so PostgREST's max-rows never
//     truncates it silently;
//   · before 20261257 is pasted (42P01 / PGRST205, or 42703 / PGRST204 for a
//     column) nothing is written and nothing is deferred: today's behaviour,
//     said once per run in the scan's line.
//
// document-control Round G — P39 NOTICE RECORD REQUESTS (DIST-20; DEC-90
// rulings (1)–(5) for P39). The request paths and the manual reminders are
// on the record too: requestAcks (a distribution request — `delivered` — and
// its reminder to a recipient already asked — `reminded`), openReviewRoster
// and recomputeDocumentAck (the roster requests — `delivered`),
// nudgeAcknowledgment and renudgeUnacked (a controller's manual re-send —
// `reminded`, details.manual) and the manual activateAlternate
// (`alternate_activated`, details.manual) each append one row per person
// once its bell row LANDED, through recordRequestNotices:
//   · the row is built from the BELL ROW ITSELF (verifiedRequestRows): the
//     notification it names is read on the server (the service role) and
//     must be this document's, that person's, of the notice's kind, written
//     by the acting member (by its id when the writer chose one —
//     lib/inAppNotifications.ts newNotificationId — or, for an emit() fan-out
//     that answers no ids, the newest such row since the action began, at
//     most NOTICE_VERIFY_WINDOW_MS ago); noticed_at is the bell row's own
//     created_at and notification_id its id; the row's id is derived from
//     the bell row's id (requestNoticeId), so a repeat records nothing twice.
//     A notice whose bell row is not found (refused, dead-lettered) leaves no
//     row — "once its notice landed";
//   · in the BROWSER the record cannot be written by the member (20261257
//     grants no client write), so the rows go through POST
//     /api/documents/notice-record, which verifies the caller (an active
//     member who can read the document) and builds the rows as above with the
//     service role; on the SERVER (the maintenance cron, a route bound to the
//     service role) they are built and written directly;
//   · a record failure never fails the action and never changes who is
//     notified: the bell rows, emails, pushes, notified_at stamps and audit
//     rows are written exactly as before, first; the record write is retried
//     and deferred to the audit log exactly as P38's (noticeRecorder), and
//     the source's daily scan replays it. An unreachable route is said in the
//     console and the notice is not on the record (residual, DIST-20);
//   · the distribution nag's cooldown (scanDistributionAcks) reads the record
//     ONLY once 20261257 is in place and the read completes
//     (recentDistributionNotices `complete`): a manual request or re-nudge is
//     a delivered / reminded row, so it still holds the robot's nudge for one
//     cooldown; before the paste (or on a refused / capped read) the bell rows
//     count, exactly as today.
//
// Never throws.

import { supabase } from "@/lib/supabase";
import { logAuditAction } from "@/lib/audit";
import { noteComplianceScan } from "@/lib/complianceNotify";

/** The migration that creates the record. */
export const DOCUMENT_NOTICE_MIGRATION = "20261257_dc_roundG_document_notice_record.sql";
/** The audit action a record that could not be written is kept under. */
export const DOCUMENT_NOTICE_RECORD_DEFERRED = "DOCUMENT_NOTICE_RECORD_DEFERRED";
/** How far back a run looks for deferred records to write. */
export const DEFERRED_NOTICE_LOOKBACK_MS = 30 * 86_400_000;
/** Deferred audit rows one page of the replay read takes, newest first. */
export const DEFERRED_NOTICE_ROWS = 500;
/** Pages one replay reads at most (the run's line says when it stopped short). */
export const DEFERRED_NOTICE_PAGES = 10;
/** Rows one page of the distribution nag's cooldown read asks for (PostgREST's
 *  default max-rows; a lower server cap only means more pages). */
export const COOLDOWN_NOTICE_ROWS = 1000;
/** Pages the cooldown read takes at most (the run's line says when it stopped). */
export const COOLDOWN_NOTICE_PAGES = 20;
/** SQLSTATEs a replayed row can never get past: its document or workspace is
 *  gone (23503, foreign key) or a value is not a valid id (22P02). Such a row
 *  is dropped, not retried as a transient refusal. */
export const PERMANENT_NOTICE_REFUSALS: readonly string[] = ["23503", "22P02"];

/** Which obligation a notice chases (the source table). */
export type DocumentNoticeSource = "review_signoff" | "acknowledgment" | "distribution_ack";
/** What happened (the CHECK in 20261257). The three scans write reminded,
 *  escalated and alternate_activated; delivered and not_emailed are declared
 *  for the request paths (owner: the integrator — DIST-19's Partial). */
export type DocumentNoticeKind = "delivered" | "reminded" | "escalated" | "alternate_activated" | "not_emailed";
/** The unions as values (the replay's whitelist; equal to 20261257's CHECKs — pinned). */
export const DOCUMENT_NOTICE_SOURCES: readonly DocumentNoticeSource[] = ["review_signoff", "acknowledgment", "distribution_ack"];
export const DOCUMENT_NOTICE_KINDS: readonly DocumentNoticeKind[] = ["delivered", "reminded", "escalated", "alternate_activated", "not_emailed"];

/** One document_notice_events row as the app writes it. */
export interface DocumentNoticeRow {
  id: string;
  org_id: string;
  document_id: string;
  version_id: string | null;
  revision_label: string | null;
  source: DocumentNoticeSource;
  /** the obligation's own row (document_review_signoffs / document_acknowledgments / distribution_acks) */
  source_id: string | null;
  kind: DocumentNoticeKind;
  /** the person the notice went to */
  recipient: string;
  /** the person whose response is awaited (the reviewer / assignee / recipient) */
  subject_user_id: string | null;
  notification_id: string | null;
  /** "System" for a scan's notice; the acting member's name for a request
   *  path's (DIST-20), or null where it was not kept (a replayed member row) */
  actor_name: string | null;
  details: Record<string, unknown>;
  /** when the notice landed (the app's clock) — kept by a replay */
  noticed_at: string;
}

const newId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // RFC 4122 v4 from Math.random — only where no crypto is present (never in Node 18+ or a browser)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
};

/** DIST-20 (P39): a fresh id for a bell row its writer will name on the
 *  record (the row is written under it — lib/inAppNotifications.ts
 *  NotificationInput.id). A v4 UUID, like every bell row's. */
export function newBellId(): string {
  return newId();
}

/** A run's line, best-effort: never lets the saying of a line throw. */
function say(note: string): void {
  try { noteComplianceScan(note); } catch { /* the line is best-effort */ }
}

/** Build a row (a fresh id, noticed now, the System as actor). DIST-20
 *  (P39): `notificationId`, when the writer knows the bell row its notice
 *  landed as (lib/inAppNotifications.ts newNotificationId) — none otherwise,
 *  exactly as before. */
export function noticeRow(input: Omit<DocumentNoticeRow, "id" | "notification_id" | "actor_name" | "noticed_at" | "details"> & {
  details?: Record<string, unknown>; noticedAt?: string; notificationId?: string | null;
}): DocumentNoticeRow {
  const { details, noticedAt, notificationId, ...rest } = input;
  return {
    id: newId(), ...rest, notification_id: notificationId ?? null, actor_name: "System",
    details: details ?? {}, noticed_at: noticedAt ?? new Date().toISOString(),
  };
}

type PgError = { code?: string | null; message?: string | null } | null | undefined;

/** The record is not in this database yet (20261257 not pasted). */
export function isMissingNoticeSchema(err: PgError): boolean {
  if (!err) return false;
  const code = String(err.code ?? "");
  const msg = String(err.message ?? "");
  // only when the missing relation IS the record (DF-P7's model,
  // lib/consentWindow.ts): another missing relation is a refusal, deferred
  if (code === "42P01" || code === "PGRST205") return /document_notice_events/.test(msg);
  if (code === "42703" || code === "PGRST204") return /document_notice_events/.test(msg);
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any };
const db = (): Db => supabase as unknown as Db;

/** What one write came to: written, missing (before the paste), deferred to
 *  the audit log (the next run writes it), or lost (neither landed — said). */
export type NoticeWriteOutcome = "written" | "missing" | "deferred" | "lost" | "none";

async function insertOnce(rows: DocumentNoticeRow[]): Promise<{ ok: true } | { ok: false; missing: boolean; code: string; error: string }> {
  try {
    // ON CONFLICT (id) DO NOTHING: a row a lost answer already wrote is never
    // written twice (the append-only trigger never sees an UPDATE).
    const { error } = await db().from("document_notice_events").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
    if (!error) return { ok: true };
    return { ok: false, missing: isMissingNoticeSchema(error), code: String(error.code ?? ""), error: String(error.message ?? "insert refused") };
  } catch (e) {
    return { ok: false, missing: false, code: "", error: (e as Error)?.message ?? String(e) };
  }
}

/** The one string value a deferred row's details may carry (per key). */
const DEFERRED_DETAIL_TEXT: Readonly<Record<string, readonly string[]>> = { cause: ["review_timeout"] };

/**
 * A row's details as a deferred audit row may carry them (every member of
 * the workspace reads audit_logs): finite numbers, booleans and the one
 * known enum value only — never free text, an object or an array; a
 * not_emailed row's `reason` never, whatever its type (it is private to
 * its person). Pure.
 */
export function deferrableDetails(kind: DocumentNoticeKind | string, details: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!details || typeof details !== "object" || Array.isArray(details)) return out;
  for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
    if (k === "__proto__") continue;
    if (kind === "not_emailed" && k === "reason") continue;
    if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string" && Object.prototype.hasOwnProperty.call(DEFERRED_DETAIL_TEXT, k) && DEFERRED_DETAIL_TEXT[k].includes(v)) out[k] = v;
  }
  return out;
}

/** What one row of a DOCUMENT_NOTICE_RECORD_DEFERRED audit row holds: what
 *  the replay needs and no more (no revision_label — re-read from the
 *  obligation's row; no actor_name — always the System; details through
 *  deferrableDetails). */
export type DeferredNoticePayload = Pick<DocumentNoticeRow,
  "id" | "org_id" | "document_id" | "version_id" | "source" | "source_id" | "kind" | "recipient" | "subject_user_id" | "notification_id" | "noticed_at" | "details">;

/** Build one deferred row from a record row. Pure. */
export function deferredPayloadRow(r: DocumentNoticeRow): DeferredNoticePayload {
  return {
    id: r.id, org_id: r.org_id, document_id: r.document_id, version_id: r.version_id,
    source: r.source, source_id: r.source_id, kind: r.kind, recipient: r.recipient,
    subject_user_id: r.subject_user_id, notification_id: r.notification_id, noticed_at: r.noticed_at,
    details: deferrableDetails(r.kind, r.details),
  };
}

/** One scan run's writer: it says a missing record once per run and, once
 *  the record is known to be missing, stops asking. */
export interface NoticeRecorder {
  record(rows: DocumentNoticeRow[]): Promise<NoticeWriteOutcome>;
}

/**
 * A scan run's writer. record() appends notice rows — checked, retried once,
 * deferred to the audit log when both attempts fail. If the deferring audit
 * row is refused too, the rows are LOST to the record: logAuditAction keeps
 * the refused audit row in the EVID-6 outbox, but the drain writes it as an
 * AUDIT_DEAD_LETTER row (lib/auditOutboxDrain.ts — never as the original
 * action), which the replay does not read; the outbox copy is the only trace
 * (said in the run's line). Never throws; never changes anything else.
 */
export function noticeRecorder(): NoticeRecorder {
  let missing = false;
  const sayMissing = () => {
    if (missing) return;
    missing = true;
    noteComplianceScan(`the document notice record (${DOCUMENT_NOTICE_MIGRATION}) is not in this database yet — reminders are sent and stamped exactly as before, with no record of each one`);
  };
  return {
    async record(rows: DocumentNoticeRow[]): Promise<NoticeWriteOutcome> {
      if (rows.length === 0) return "none";
      if (missing) return "missing";
      let r = await insertOnce(rows);
      if (r.ok) return "written";
      if (r.missing) { sayMissing(); return "missing"; }
      r = await insertOnce(rows);
      if (r.ok) return "written";
      if (r.missing) { sayMissing(); return "missing"; }
      const first = rows[0];
      try {
        const kept = await logAuditAction({
          action: DOCUMENT_NOTICE_RECORD_DEFERRED,
          resourceType: "document",
          resourceId: first.document_id,
          orgId: first.org_id,
          userId: "system",
          // only what the replay needs (deferredPayloadRow — every member reads audit_logs)
          details: { source: first.source, error: r.error.slice(0, 300), rows: rows.map(deferredPayloadRow) },
        });
        if (kept && kept.ok === false) throw new Error(kept.error ?? "audit insert refused");
        noteComplianceScan(`${rows.length} document notice record row(s) could not be written (${r.error}) — kept in the audit log; the next run writes them`);
        return "deferred";
      } catch (e) {
        noteComplianceScan(`${rows.length} document notice record row(s) could not be written (${r.error}) and the audit row keeping them was refused too (${(e as Error)?.message ?? String(e)}; the rows are lost to the record — at most a copy stays in the audit dead-letter outbox, which is never replayed into it) — the reminders themselves were sent and stamped as before`);
        return "lost";
      }
    },
  };
}

const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const textOrNull = (v: unknown): string | null | undefined => (v == null ? null : isText(v) ? v : undefined);

/**
 * One deferred row, rebuilt from the DocumentNoticeRow columns ONLY (every
 * other key — created_at, anything a writer added — is dropped): this
 * workspace and this scan's source only; kind and source from the unions;
 * every id a string (the database refuses one that is not a UUID — that row
 * alone, see the replay); noticed_at a real time and never later than the audit row
 * that kept it (`keptAt`). null when the row is not one the recorder wrote.
 */
export function deferredNoticeRow(v: unknown, orgId: string, source: DocumentNoticeSource, keptAt: string): DocumentNoticeRow | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const kept = Date.parse(keptAt);
  if (!Number.isFinite(kept)) return null;
  if (r.org_id !== orgId || r.source !== source || !DOCUMENT_NOTICE_SOURCES.includes(source)) return null;
  if (typeof r.kind !== "string" || !(DOCUMENT_NOTICE_KINDS as readonly string[]).includes(r.kind)) return null;
  if (!isText(r.id) || !isText(r.document_id) || !isText(r.recipient)) return null;
  const version_id = textOrNull(r.version_id);
  const source_id = textOrNull(r.source_id);
  const subject_user_id = textOrNull(r.subject_user_id);
  const notification_id = textOrNull(r.notification_id);
  if (version_id === undefined || source_id === undefined || subject_user_id === undefined || notification_id === undefined) return null;
  if (r.revision_label != null && typeof r.revision_label !== "string") return null;
  const at = typeof r.noticed_at === "string" ? Date.parse(r.noticed_at) : NaN;
  return {
    id: r.id, org_id: orgId, document_id: r.document_id, version_id,
    revision_label: (r.revision_label as string | null | undefined) ?? null,
    source, source_id, kind: r.kind as DocumentNoticeKind, recipient: r.recipient, subject_user_id, notification_id,
    // DIST-20 (P39): a member's notice (details.byMember) or a manual one
    // (details.manual) was not the System's; the deferred payload keeps no
    // name, so the replay says none
    actor_name: typeof r.actor_name === "string" ? r.actor_name
      : (r.details && typeof r.details === "object"
          && ((r.details as Record<string, unknown>).byMember === true || (r.details as Record<string, unknown>).manual === true) ? null : "System"),
    details: deferrableDetails(r.kind, r.details),
    noticed_at: new Date(Number.isFinite(at) ? Math.min(at, kept) : kept).toISOString(),
  };
}

/** PostgREST keyset condition: rows strictly after (`col`, id), newest first. */
function beforeCursor(c: { at: string; id: string }, col = "timestamp"): string {
  const v = (x: string) => `"${x.replace(/["\\]/g, (ch) => `\\${ch}`)}"`;
  return `${col}.lt.${v(c.at)},and(${col}.eq.${v(c.at)},id.lt.${v(c.id)})`;
}

/** Where each source's obligation row keeps its revision label. */
const LABEL_SOURCE: Record<DocumentNoticeSource, { table: string; column: string }> = {
  review_signoff: { table: "document_review_signoffs", column: "revision_label" },
  acknowledgment: { table: "document_acknowledgments", column: "revision_label" },
  distribution_ack: { table: "distribution_acks", column: "rev_label" },
};

/** The revision label of each obligation row named (the label the scan
 *  wrote — it reads the same column). A row that is gone has none. Throws
 *  on a refused read (the replay then waits for a later run). */
async function obligationLabels(orgId: string, source: DocumentNoticeSource, ids: string[]): Promise<Map<string, string | null>> {
  const { table, column } = LABEL_SOURCE[source];
  const out = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db().from(table).select(`id, ${column}`).eq("org_id", orgId).in("id", ids.slice(i, i + 200));
    if (error) throw new Error(error.message ?? String(error));
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const v = r[column];
      out.set(String(r.id), typeof v === "string" ? v : null);
    }
  }
  return out;
}

/**
 * SERVER (a scan's first step): write the rows an earlier run of this scan
 * could not (DOCUMENT_NOTICE_RECORD_DEFERRED, the last 30 days). Only a
 * SYSTEM audit row is read (user_id NULL — the recorder's; a member cannot
 * write one), keyset-paged newest first up to DEFERRED_NOTICE_PAGES pages
 * (the run's line says when it stopped short), and each row is rebuilt by
 * deferredNoticeRow (a row it refuses is skipped and counted). A row with no
 * revision label (the deferred payload carries none) takes its obligation
 * row's label. The same row ids — a row already written is skipped (ON
 * CONFLICT DO NOTHING). A chunk the database refuses is retried row by row:
 * a row refused for good (PERMANENT_NOTICE_REFUSALS — its document or
 * workspace gone, or not a valid id) is dropped and counted in one line; any
 * other refused row is skipped and said, to be tried again on a later run;
 * the rest are written, and the next chunk is still tried. Answers the rows
 * written. Never throws; a failure is a line in the scan's report.
 */
export async function replayDeferredNotices(orgId: string, source: DocumentNoticeSource): Promise<number> {
  let rows: DocumentNoticeRow[] = [];
  let malformed = 0;
  let capped = false;
  try {
    const since = new Date(Date.now() - DEFERRED_NOTICE_LOOKBACK_MS).toISOString();
    let cursor: { at: string; id: string } | null = null;
    for (let page = 0; ; page += 1) {
      if (page >= DEFERRED_NOTICE_PAGES) { capped = true; break; }
      let q = db().from("audit_logs").select("id, details, timestamp")
        .eq("org_id", orgId).eq("action", DOCUMENT_NOTICE_RECORD_DEFERRED)
        .is("user_id", null)
        .gte("timestamp", since);
      if (cursor) q = q.or(beforeCursor(cursor));
      const { data, error } = await q.order("timestamp", { ascending: false }).order("id", { ascending: false }).limit(DEFERRED_NOTICE_ROWS);
      if (error) throw new Error(error.message ?? String(error));
      const list = (data ?? []) as Array<{ id?: string; details?: Record<string, unknown> | null; timestamp?: string }>;
      for (const a of list) {
        const d = a.details ?? null;
        if (!d || d.source !== source || !Array.isArray(d.rows)) continue;
        for (const r of d.rows) {
          const row = deferredNoticeRow(r, orgId, source, String(a.timestamp ?? ""));
          if (row) rows.push(row); else malformed += 1;
        }
      }
      if (list.length < DEFERRED_NOTICE_ROWS) break;
      const last = list[list.length - 1];
      if (!last?.timestamp || !last?.id) break;
      cursor = { at: last.timestamp, id: last.id };
    }
  } catch (e) {
    noteComplianceScan(`the deferred document notice records could not be read (${(e as Error)?.message ?? String(e)}) — they are written on a later run`);
    return 0;
  }
  if (malformed > 0) noteComplianceScan(`${malformed} deferred document notice record row(s) were not replayed — not a well-formed record of this workspace's ${source} notices`);
  if (capped) noteComplianceScan(`the deferred document notice records were read up to ${DEFERRED_NOTICE_PAGES * DEFERRED_NOTICE_ROWS} audit rows — older ones are read on a later run, while they are inside ${DEFERRED_NOTICE_LOOKBACK_MS / 86_400_000} days`);
  if (rows.length === 0) return 0;
  rows = [...new Map(rows.map((r) => [r.id, r] as const)).values()];
  // the revision label is never in the audit row (merge-time fix pass): the
  // obligation row's own, as the scan wrote it
  const unlabelled = [...new Set(rows.filter((r) => r.revision_label == null && r.source_id).map((r) => r.source_id as string))];
  if (unlabelled.length > 0) {
    try {
      const labels = await obligationLabels(orgId, source, unlabelled);
      rows = rows.map((r) => (r.revision_label == null && r.source_id ? { ...r, revision_label: labels.get(r.source_id) ?? null } : r));
    } catch (e) {
      noteComplianceScan(`the revision labels of ${rows.length} deferred document notice record row(s) could not be read (${(e as Error)?.message ?? String(e)}) — they are written on a later run`);
      return 0;
    }
  }
  let written = 0;
  let refused = 0;
  let firstRefusal = "";
  let dropped = 0;
  let firstDrop = "";
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const r = await insertOnce(chunk);
    if (r.ok) { written += chunk.length; continue; }
    if (r.missing) return written;   // before the paste: nothing to write into (the scan's own write says so)
    // one refused row must not hold back the rest: row by row
    for (const one of chunk) {
      const o = await insertOnce([one]);
      if (o.ok) { written += 1; continue; }
      if (o.missing) return written;
      if (PERMANENT_NOTICE_REFUSALS.includes(o.code)) {
        dropped += 1;
        if (!firstDrop) firstDrop = `${o.code}: ${o.error}`;
        continue;
      }
      refused += 1;
      if (!firstRefusal) firstRefusal = o.error;
    }
  }
  if (dropped > 0) noteComplianceScan(`${dropped} deferred document notice record row(s) were dropped — refused for good (${firstDrop}; a document or workspace that no longer exists, or a value that is not a valid id), so they are never written; the audit row that kept them stays as it is`);
  if (refused > 0) noteComplianceScan(`${refused} deferred document notice record row(s) could not be written (${firstRefusal}) — skipped this run and retried on the next while inside ${DEFERRED_NOTICE_LOOKBACK_MS / 86_400_000} days; the other ${written} were written`);
  return written;
}

/** The record's own cooldown read for the distribution-ack nag: who was
 *  asked / reminded / escalated for which document since `sinceIso` (never
 *  a notice dated in the future). Keyset-paged newest first on
 *  (noticed_at, id), so PostgREST's max-rows never truncates it silently
 *  (merge-time fix pass); it stops after COOLDOWN_NOTICE_PAGES pages and
 *  says so in the run's line — `complete` is then false and the caller
 *  counts the window from the notifications rows as well, as before (the
 *  union only ever withholds more). null when the record cannot be read
 *  (missing or refused, on any page) — the caller then counts from the
 *  notifications rows alone, exactly as before.
 *  DIST-20 (P39): a request (`delivered`) counts with the reminders — a
 *  manual request or re-nudge is on the record now, and holds the robot's
 *  nudge for one cooldown as its bell row did; with `complete` true the
 *  caller reads the record and, for the transition only, the bell rows
 *  dated before `cutover`.
 *  `cutover` (P39 fix pass): when this workspace's first notice that names
 *  its bell row (notification_id — written only by the P39 app, the scans'
 *  and the request paths' alike) landed; null when there is none yet. A
 *  bell row dated before it may be a notice the record never got (a manual
 *  nudge sent from the app before P39), so the caller counts those as well,
 *  for one cooldown — after which no bell row is read again. */
export async function recentDistributionNotices(orgId: string, sinceIso: string): Promise<{ reminded: Set<string>; escalated: Set<string>; complete: boolean; cutover: string | null } | null> {
  const reminded = new Set<string>();
  const escalated = new Set<string>();
  let complete = true;
  let cutover: string | null = null;
  try {
    // a notice dated in the future never holds a nudge (P38 fix pass)
    const nowIso = new Date().toISOString();
    let cursor: { at: string; id: string } | null = null;
    let read = 0;
    for (let page = 0; ; page += 1) {
      if (page >= COOLDOWN_NOTICE_PAGES) {
        noteComplianceScan(`the distribution nag's cooldown read of the document notice record stopped at ${read} rows (${COOLDOWN_NOTICE_PAGES} pages) — the window's older notices were counted from the bell rows alone, as before`);
        complete = false;
        break;
      }
      let q = db().from("document_notice_events")
        .select("id, recipient, document_id, kind, noticed_at")
        .eq("org_id", orgId).eq("source", "distribution_ack")
        .in("kind", ["delivered", "reminded", "escalated"])
        .gte("noticed_at", sinceIso)
        .lte("noticed_at", nowIso);
      if (cursor) q = q.or(beforeCursor(cursor, "noticed_at"));
      const { data, error } = await q.order("noticed_at", { ascending: false }).order("id", { ascending: false }).limit(COOLDOWN_NOTICE_ROWS);
      if (error) return null;
      const list = (data ?? []) as Array<{ id?: string; recipient?: string; document_id?: string; kind?: string; noticed_at?: string }>;
      // an empty page ends it — never a short one (a server max-rows lower
      // than COOLDOWN_NOTICE_ROWS would otherwise end it early)
      if (list.length === 0) break;
      read += list.length;
      for (const r of list) {
        const key = `${String(r.recipient)}:${String(r.document_id)}`;
        if (r.kind === "reminded" || r.kind === "delivered") reminded.add(key);
        else if (r.kind === "escalated") escalated.add(key);
      }
      const last = list[list.length - 1];
      if (!last?.noticed_at || !last?.id) break;
      cursor = { at: last.noticed_at, id: last.id };
    }
    const { data: first, error: firstError } = await db().from("document_notice_events")
      .select("noticed_at")
      .eq("org_id", orgId).eq("source", "distribution_ack")
      .not("notification_id", "is", null)
      .order("noticed_at", { ascending: true }).limit(1);
    if (firstError) return null;
    const at = ((first ?? []) as Array<{ noticed_at?: unknown }>)[0]?.noticed_at;
    cutover = typeof at === "string" && at ? at : null;
    return { reminded, escalated, complete, cutover };
  } catch {
    return null;
  }
}

// ── DIST-20 (P39): the request paths and the manual reminders ───────────────

/** The kinds a request path writes (delivered: a request; reminded: a manual
 *  re-send; alternate_activated: a manual activation). */
export type RequestNoticeKind = "delivered" | "reminded" | "alternate_activated";
export const REQUEST_NOTICE_KINDS: readonly RequestNoticeKind[] = ["delivered", "reminded", "alternate_activated"];
/** How long ago a bell row may date and still be taken for a notice just sent. */
export const NOTICE_VERIFY_WINDOW_MS = 15 * 60_000;
/** A bell row dated past the server's clock by more than this is never taken. */
export const NOTICE_FUTURE_SKEW_MS = 60_000;
/** A bell row named by no id is searched for from this long before the
 *  action began (`since`) — and only when `since` is not later than the
 *  server's own clock: `since` is the writer's clock (the browser's), so a
 *  later one (a clock running fast) is never trusted and the whole
 *  NOTICE_VERIFY_WINDOW_MS is searched instead (P39 fix pass). */
export const NOTICE_SINCE_MARGIN_MS = 5 * 60_000;
/** Notices one request to the route carries at most (the browser splits a
 *  larger set; one request stays under the 64 kB a keepalive fetch may send). */
export const REQUEST_NOTICE_MAX = 200;
/** The browser's door into the record (the member cannot write it). */
export const NOTICE_RECORD_ROUTE = "/api/documents/notice-record";
/** The browser waits at most this long for the route — one request, and
 *  every chunk and repeat of an action together (one deadline, P39 fix
 *  pass): the action is never delayed past it. */
export const NOTICE_RECORD_TIMEOUT_MS = 8_000;
/** A request body above this is sent without `keepalive` (the browser's
 *  in-flight keepalive bodies share one 64 KiB quota; a refused keepalive
 *  request is repeated once without it). */
export const NOTICE_KEEPALIVE_MAX_BODY = 8_000;
/** The route refuses a body larger than this (413). */
export const NOTICE_RECORD_MAX_BODY = 64_000;

/** One person's notice on a request path. */
export interface RequestNotice {
  kind: RequestNoticeKind;
  /** who was told */
  recipient: string;
  /** whose response is awaited (the recipient when omitted) */
  subject?: string | null;
  /** the bell row's id, when the writer chose it (newNotificationId) */
  notificationId?: string | null;
  /** the obligation's own row, when the writer knows it */
  sourceId?: string | null;
  /** numbers and booleans only (deferrableDetails) — e.g. { manual: true } */
  details?: Record<string, unknown>;
}

/** What a request path asks the record to hold. */
export interface RequestNoticeInput {
  orgId: string;
  documentId: string;
  source: DocumentNoticeSource;
  /** the revision the obligations are on (resolves a notice that names no sourceId) */
  versionId?: string | null;
  /** when the action began (ISO, the writer's clock): a bell row named by
   *  no id is searched for from NOTICE_SINCE_MARGIN_MS before it — never
   *  earlier than NOTICE_VERIFY_WINDOW_MS ago; a `since` later than the
   *  server's clock is ignored (the whole window is searched) */
  since?: string | null;
  notices: RequestNotice[];
}

/** Who wrote the bell rows: the acting member (the route's verified caller,
 *  or a server path's actor), or null for a server notice with no actor. */
export interface NoticeWriter { uid: string | null; name: string | null }

/** The bell kinds a request path's notice may be (the kinds those paths
 *  write today — lib/distributionAcks.ts, lib/acknowledgments.ts,
 *  lib/reviewControl.ts). Pure. */
export function bellKindsFor(source: DocumentNoticeSource, kind: RequestNoticeKind): string[] {
  if (source === "review_signoff") return kind === "alternate_activated" ? ["review_alternate_activated"] : ["review_requested"];
  if (kind === "alternate_activated") return [];
  return ["ack_requested"];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The record row's id for a notice that landed as bell row `bellId`: the
 *  bell row's own UUID with its version nibble set to 8 (every bell id is a
 *  v4 — gen_random_uuid or newNotificationId — so no two bell rows map to
 *  one record id, and no scan row's random v4 id is ever one). A repeated
 *  request for the same bell row is the same record row (ON CONFLICT (id)
 *  DO NOTHING). Pure. */
export function requestNoticeId(bellId: string): string {
  const id = bellId.toLowerCase();
  return `${id.slice(0, 14)}8${id.slice(15)}`;
}

/** Where each source's obligation row keeps its person, revision and label. */
const OBLIGATION: Record<DocumentNoticeSource, { table: string; person: string; version: string; label: string }> = {
  review_signoff: { table: "document_review_signoffs", person: "reviewer_user_id", version: "document_version_id", label: "revision_label" },
  acknowledgment: { table: "document_acknowledgments", person: "assignee_user_id", version: "document_version_id", label: "revision_label" },
  distribution_ack: { table: "distribution_acks", person: "recipient_user_id", version: "version_id", label: "rev_label" },
};

type BellRow = { id?: unknown; user_id?: unknown; kind?: unknown; actor_user_id?: unknown; actor_name?: unknown; metadata?: unknown; created_at?: unknown };

/**
 * SERVER (the route's service role, or a server path's shared client bound
 * to it): the record rows for a request path's notices, each built from the
 * bell row that LANDED for it — read here, never taken from the caller:
 * this workspace's row about this document, to that recipient, of a kind
 * the notice may be (bellKindsFor), dated no later than now (plus
 * NOTICE_FUTURE_SKEW_MS) and no earlier than NOTICE_VERIFY_WINDOW_MS ago; a
 * distribution notice only a row carrying metadata.ackRequest (what
 * requestAcks / renudgeUnacked write), a read-&-understood notice only one
 * without it; ALWAYS one the writer wrote (its actor the writer — a row
 * with no actor only for a server notice with no actor, never through the
 * route, so a member can never name a scan's own bell row). Named by its id
 * when the writer chose one; otherwise the newest such row the writer wrote
 * since the action began (`since`, the writer's clock, trusted only when not
 * later than the server's — NOTICE_SINCE_MARGIN_MS). Each bell row is taken
 * once, and a bell row already on the record under another row (a scan's)
 * is not taken again. What the caller claims is bounded too (P39 fix pass):
 * the subject is the recipient (no request path names another), and the
 * details are `manual` alone (on a reminder or an activation). The
 * obligation row (source_id, revision, label) is read here too: the one
 * named, or the person's row on the revision named. A notice with no
 * landed bell row, or no obligation row, is not recorded (counted in
 * `unmatched`). Throws on a refused read (the caller says it; nothing is
 * written).
 */
export async function verifiedRequestRows(
  client: Db, input: RequestNoticeInput, writer: NoticeWriter, nowMs: number = Date.now(),
): Promise<{ rows: DocumentNoticeRow[]; unmatched: number }> {
  const notices = input.notices
    .filter((n) => n && REQUEST_NOTICE_KINDS.includes(n.kind) && isText(n.recipient) && (!n.subject || n.subject === n.recipient))
    .slice(0, REQUEST_NOTICE_MAX);
  let unmatched = input.notices.length - notices.length;
  if (notices.length === 0) return { rows: [], unmatched };
  const floor = nowMs - NOTICE_VERIFY_WINDOW_MS;
  const began = input.since ? Date.parse(input.since) : NaN;
  // `since` is the writer's clock: one later than the server's (a fast
  // browser clock) is never trusted — the whole window is searched
  const searchFrom = Number.isFinite(began) && began <= nowMs ? Math.max(floor, began - NOTICE_SINCE_MARGIN_MS) : floor;
  const recipients = [...new Set(notices.map((n) => n.recipient))];
  const kinds = [...new Set(notices.flatMap((n) => bellKindsFor(input.source, n.kind)))];
  if (kinds.length === 0) return { rows: [], unmatched: unmatched + notices.length };

  const { data: bellData, error: bellError } = await client.from("notifications")
    .select("id, user_id, kind, actor_user_id, actor_name, metadata, created_at")
    .eq("org_id", input.orgId).eq("resource_type", "document").eq("resource_id", input.documentId)
    .in("user_id", recipients).in("kind", kinds)
    .gte("created_at", new Date(floor).toISOString())
    .order("created_at", { ascending: false }).limit(REQUEST_NOTICE_MAX * 4);
  if (bellError) throw new Error(`the bell rows could not be read (${bellError.message ?? String(bellError)})`);
  const bells = ((bellData ?? []) as BellRow[]).filter((b) => isText(b.id) && UUID_RE.test(b.id as string) && typeof b.created_at === "string");

  const used = new Set<string>();
  const matched: Array<{ n: RequestNotice; bell: BellRow; at: number }> = [];
  for (const n of notices) {
    const allowed = bellKindsFor(input.source, n.kind);
    const fits = (b: BellRow): boolean => {
      const at = Date.parse(String(b.created_at));
      if (!Number.isFinite(at) || at < floor || at > nowMs + NOTICE_FUTURE_SKEW_MS) return false;
      if (b.user_id !== n.recipient || !allowed.includes(String(b.kind)) || used.has(String(b.id))) return false;
      const ackRequest = !!(b.metadata && typeof b.metadata === "object" && (b.metadata as Record<string, unknown>).ackRequest === true);
      if (input.source === "distribution_ack" && !ackRequest) return false;
      if (input.source === "acknowledgment" && ackRequest) return false;
      return true;
    };
    // always the writer's own row (a row with no actor only when the writer
    // is none — a server notice; the route's writer is always its caller)
    const actor = (b: BellRow) => (typeof b.actor_user_id === "string" ? b.actor_user_id : null);
    const bell = n.notificationId
      ? bells.find((b) => b.id === n.notificationId && fits(b) && actor(b) === writer.uid)
      : bells.find((b) => fits(b) && actor(b) === writer.uid && Date.parse(String(b.created_at)) >= searchFrom);
    if (!bell) { unmatched += 1; continue; }
    used.add(String(bell.id));
    matched.push({ n, bell, at: Date.parse(String(bell.created_at)) });
  }
  if (matched.length === 0) return { rows: [], unmatched };

  // a bell row already on the record under another row (a scan's own
  // notice) is never recorded a second time; a repeat of this request is the
  // same row (its id is the bell row's) and is left to ON CONFLICT
  const { data: onFile, error: onFileError } = await client.from("document_notice_events")
    .select("id, notification_id")
    .eq("org_id", input.orgId).in("notification_id", matched.map((m) => String(m.bell.id)));
  if (onFileError && !isMissingNoticeSchema(onFileError)) {
    throw new Error(`the record could not be read (${onFileError.message ?? String(onFileError)})`);
  }
  const elsewhere = new Set(((onFileError ? [] : onFile ?? []) as Array<{ id?: unknown; notification_id?: unknown }>)
    .filter((r) => isText(r.notification_id) && r.id !== requestNoticeId(String(r.notification_id)))
    .map((r) => String(r.notification_id)));
  if (elsewhere.size > 0) {
    unmatched += matched.filter((m) => elsewhere.has(String(m.bell.id))).length;
    matched.splice(0, matched.length, ...matched.filter((m) => !elsewhere.has(String(m.bell.id))));
    if (matched.length === 0) return { rows: [], unmatched };
  }

  const ob = OBLIGATION[input.source];
  const subjects = [...new Set(matched.map((m) => m.n.recipient))];
  let q = client.from(ob.table).select(`id, ${ob.person}, ${ob.version}, ${ob.label}`)
    .eq("org_id", input.orgId).eq("document_id", input.documentId).in(ob.person, subjects);
  if (input.versionId) q = q.eq(ob.version, input.versionId);
  const { data: obData, error: obError } = await q;
  if (obError) throw new Error(`the obligation rows could not be read (${obError.message ?? String(obError)})`);
  const obligations = (obData ?? []) as Array<Record<string, unknown>>;

  const rows: DocumentNoticeRow[] = [];
  for (const { n, bell, at } of matched) {
    const subject = n.recipient;
    const mine = obligations.filter((o) => o[ob.person] === subject && (!n.sourceId || o.id === n.sourceId));
    if (mine.length !== 1 || !isText(mine[0].id)) { unmatched += 1; continue; }
    const o = mine[0];
    rows.push({
      id: requestNoticeId(String(bell.id)),
      org_id: input.orgId, document_id: input.documentId,
      version_id: typeof o[ob.version] === "string" ? (o[ob.version] as string) : null,
      revision_label: typeof o[ob.label] === "string" ? (o[ob.label] as string) : null,
      source: input.source, source_id: o.id as string, kind: n.kind,
      recipient: n.recipient, subject_user_id: subject,
      notification_id: String(bell.id),
      actor_name: (typeof bell.actor_name === "string" && bell.actor_name) || writer.name || (writer.uid ? null : "System"),
      details: { ...requestNoticeDetails(n.kind, n.details), ...(writer.uid ? { byMember: true } : {}) },
      noticed_at: new Date(Math.min(at, nowMs)).toISOString(),
    });
  }
  return { rows, unmatched };
}

/** The details a request path's row may carry: `manual: true` on a reminder
 *  or an activation, nothing else (a request carries none) — the only
 *  details the request paths send; anything else the caller adds is
 *  dropped (P39 fix pass). Pure. */
export function requestNoticeDetails(kind: RequestNoticeKind, details: unknown): Record<string, unknown> {
  if (kind === "delivered" || !details || typeof details !== "object" || Array.isArray(details)) return {};
  return (details as Record<string, unknown>).manual === true ? { manual: true } : {};
}

/** What a request path's record write came to: as noticeRecorder's, or, in
 *  the browser, `sent` (the route took every chunk) / `failed` (said). */
export type RequestRecordOutcome = NoticeWriteOutcome | "sent" | "failed";

/** BROWSER: hand the notices to POST /api/documents/notice-record (the
 *  member's own session as the bearer), REQUEST_NOTICE_MAX a request; a
 *  request the route could not take (unreachable, a refused keepalive, or a
 *  5xx) is sent once more, without keepalive — a repeat records nothing
 *  twice (the row id is the bell row's). Every request, chunk and repeat
 *  of one action shares ONE deadline (NOTICE_RECORD_TIMEOUT_MS), so the
 *  action is never delayed past it; what the deadline cut off is said, not
 *  recorded. keepalive (the request outlives a closed page) only on a first
 *  attempt whose body is at most NOTICE_KEEPALIVE_MAX_BODY. Never throws. */
async function postNoticeRecord(input: RequestNoticeInput): Promise<RequestRecordOutcome> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) {
    console.warn("[notice-record] no signed-in session — the notices were sent, but are not on the document notice record");
    return "failed";
  }
  let failed = false;
  const deadline = Date.now() + NOTICE_RECORD_TIMEOUT_MS;
  for (let i = 0; i < input.notices.length; i += REQUEST_NOTICE_MAX) {
    const body = JSON.stringify({ ...input, notices: input.notices.slice(i, i + REQUEST_NOTICE_MAX) });
    const count = Math.min(REQUEST_NOTICE_MAX, input.notices.length - i);
    let why = "";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const left = deadline - Date.now();
      if (left <= 0) { why = why || `the action's ${NOTICE_RECORD_TIMEOUT_MS / 1000} s for the record had passed`; break; }
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), left) : null;
      try {
        const res = await fetch(NOTICE_RECORD_ROUTE, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body,
          keepalive: attempt === 1 && body.length <= NOTICE_KEEPALIVE_MAX_BODY,
          ...(ctrl ? { signal: ctrl.signal } : {}),
        });
        if (res.ok) { why = ""; break; }
        const said = await res.json().catch(() => null) as { error?: string } | null;
        why = said?.error ?? `HTTP ${res.status}`;
        if (res.status < 500) break;                   // a refusal does not change on a repeat
      } catch (e) {
        why = `the record could not be reached: ${(e as Error)?.message ?? String(e)}`;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (why) {
      failed = true;
      console.warn(`[notice-record] the document notice record did not take ${count} notice(s) (${why}) — they were sent as before`);
    }
  }
  return failed ? "failed" : "sent";
}

/**
 * DIST-20 (P39): put a request path's landed notices on the record — called
 * by requestAcks, renudgeUnacked, recomputeDocumentAck, nudgeAcknowledgment,
 * openReviewRoster and the manual activateAlternate AFTER everything they
 * already do (the bell rows, the stamps, the audit rows are unchanged and
 * come first). In the browser the route builds and writes the rows; on the
 * server they are built here (verifiedRequestRows, `writer` = the action's
 * actor, or none) and written by noticeRecorder (checked, retried once,
 * deferred to the audit log for the source's next scan; before 20261257 —
 * nothing written, said once). Never throws, never changes who is notified.
 */
export async function recordRequestNotices(
  input: RequestNoticeInput, writer?: { actorId?: string | null; actorName?: string | null },
): Promise<RequestRecordOutcome> {
  try {
    if (input.notices.length === 0) return "none";
    if (typeof window !== "undefined") return await postNoticeRecord(input);
    const { rows, unmatched } = await verifiedRequestRows(db(), input, { uid: writer?.actorId ?? null, name: writer?.actorName ?? null });
    if (unmatched > 0) say(`${unmatched} ${input.source} notice(s) were not put on the document notice record — no landed bell row (or no obligation row) was found for them`);
    return await noticeRecorder().record(rows);
  } catch (e) {
    say(`the ${input.source} notices could not be put on the document notice record (${(e as Error)?.message ?? String(e)}) — they were sent as before`);
    return "failed";
  }
}

/** The route's reading of a request body: the input, or why it is refused
 *  (400). Bounded: REQUEST_NOTICE_MAX notices, known kinds and sources,
 *  UUID ids, numbers / booleans in details. Pure. */
export function parseRequestNoticeBody(body: unknown): RequestNoticeInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "The body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const uuid = (v: unknown) => typeof v === "string" && UUID_RE.test(v);
  const optUuid = (v: unknown) => v == null || uuid(v);
  if (!uuid(b.orgId) || !uuid(b.documentId)) return { error: "orgId and documentId are required" };
  if (typeof b.source !== "string" || !(DOCUMENT_NOTICE_SOURCES as readonly string[]).includes(b.source)) return { error: "source is not a document notice source" };
  if (!optUuid(b.versionId)) return { error: "versionId is not an id" };
  if (b.since != null && (typeof b.since !== "string" || !Number.isFinite(Date.parse(b.since)))) return { error: "since is not a time" };
  if (!Array.isArray(b.notices) || b.notices.length === 0) return { error: "notices are required" };
  if (b.notices.length > REQUEST_NOTICE_MAX) return { error: `at most ${REQUEST_NOTICE_MAX} notices a request` };
  const notices: RequestNotice[] = [];
  for (const raw of b.notices) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "a notice must be an object" };
    const n = raw as Record<string, unknown>;
    if (typeof n.kind !== "string" || !(REQUEST_NOTICE_KINDS as readonly string[]).includes(n.kind)) return { error: "a notice's kind is not a request kind" };
    if (!uuid(n.recipient) || !optUuid(n.subject) || !optUuid(n.notificationId) || !optUuid(n.sourceId)) return { error: "a notice's ids are not ids" };
    notices.push({
      kind: n.kind as RequestNoticeKind, recipient: n.recipient as string,
      subject: (n.subject as string | null | undefined) ?? null,
      notificationId: (n.notificationId as string | null | undefined) ?? null,
      sourceId: (n.sourceId as string | null | undefined) ?? null,
      details: deferrableDetails(n.kind, n.details),
    });
  }
  return {
    orgId: b.orgId as string, documentId: b.documentId as string, source: b.source as DocumentNoticeSource,
    versionId: (b.versionId as string | null | undefined) ?? null, since: (b.since as string | null | undefined) ?? null, notices,
  };
}
