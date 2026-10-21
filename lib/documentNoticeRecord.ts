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
  actor_name: string;
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

/** Build a row (a fresh id, noticed now, the System as actor). */
export function noticeRow(input: Omit<DocumentNoticeRow, "id" | "notification_id" | "actor_name" | "noticed_at" | "details"> & {
  details?: Record<string, unknown>; noticedAt?: string;
}): DocumentNoticeRow {
  const { details, noticedAt, ...rest } = input;
  return {
    id: newId(), ...rest, notification_id: null, actor_name: "System",
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
    actor_name: typeof r.actor_name === "string" ? r.actor_name : "System",
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
 *  reminded / escalated for which document since `sinceIso` (never a notice
 *  dated in the future). Keyset-paged newest first on (noticed_at, id), so
 *  PostgREST's max-rows never truncates it silently (merge-time fix pass);
 *  it stops after COOLDOWN_NOTICE_PAGES pages and says so in the run's line
 *  — the older notices of the window are then counted from the
 *  notifications rows alone, as before (the caller's union only ever
 *  withholds more). null when the record cannot be read (missing or
 *  refused, on any page) — the caller then counts from the notifications
 *  rows alone, exactly as before. */
export async function recentDistributionNotices(orgId: string, sinceIso: string): Promise<{ reminded: Set<string>; escalated: Set<string> } | null> {
  const reminded = new Set<string>();
  const escalated = new Set<string>();
  try {
    // a notice dated in the future never holds a nudge (P38 fix pass)
    const nowIso = new Date().toISOString();
    let cursor: { at: string; id: string } | null = null;
    let read = 0;
    for (let page = 0; ; page += 1) {
      if (page >= COOLDOWN_NOTICE_PAGES) {
        noteComplianceScan(`the distribution nag's cooldown read of the document notice record stopped at ${read} rows (${COOLDOWN_NOTICE_PAGES} pages) — the window's older notices were counted from the bell rows alone, as before`);
        break;
      }
      let q = db().from("document_notice_events")
        .select("id, recipient, document_id, kind, noticed_at")
        .eq("org_id", orgId).eq("source", "distribution_ack")
        .in("kind", ["reminded", "escalated"])
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
        if (r.kind === "reminded") reminded.add(key);
        else if (r.kind === "escalated") escalated.add(key);
      }
      const last = list[list.length - 1];
      if (!last?.noticed_at || !last?.id) break;
      cursor = { at: last.noticed_at, id: last.id };
    }
    return { reminded, escalated };
  } catch {
    return null;
  }
}
