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
/** Deferred audit rows one replay read takes, newest first. */
export const DEFERRED_NOTICE_ROWS = 500;

/** Which obligation a notice chases (the source table). */
export type DocumentNoticeSource = "review_signoff" | "acknowledgment" | "distribution_ack";
/** What happened (the CHECK in 20261257). The three scans write reminded,
 *  escalated and alternate_activated; delivered and not_emailed are declared
 *  for the request paths (owner: the integrator — DIST-19's Partial). */
export type DocumentNoticeKind = "delivered" | "reminded" | "escalated" | "alternate_activated" | "not_emailed";

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
  if (code === "42P01" || code === "PGRST205") return /document_notice_events/.test(msg) || code === "42P01";
  if (code === "42703" || code === "PGRST204") return /document_notice_events/.test(msg);
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any };
const db = (): Db => supabase as unknown as Db;

/** What one write came to: written, missing (before the paste), deferred to
 *  the audit log (the next run writes it), or lost (neither landed — said). */
export type NoticeWriteOutcome = "written" | "missing" | "deferred" | "lost" | "none";

async function insertOnce(rows: DocumentNoticeRow[]): Promise<{ ok: true } | { ok: false; missing: boolean; error: string }> {
  try {
    // ON CONFLICT (id) DO NOTHING: a row a lost answer already wrote is never
    // written twice (the append-only trigger never sees an UPDATE).
    const { error } = await db().from("document_notice_events").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
    if (!error) return { ok: true };
    return { ok: false, missing: isMissingNoticeSchema(error), error: String(error.message ?? "insert refused") };
  } catch (e) {
    return { ok: false, missing: false, error: (e as Error)?.message ?? String(e) };
  }
}

/** One scan run's writer: it says a missing record once per run and, once
 *  the record is known to be missing, stops asking. */
export interface NoticeRecorder {
  record(rows: DocumentNoticeRow[]): Promise<NoticeWriteOutcome>;
}

/**
 * A scan run's writer. record() appends notice rows — checked, retried once,
 * deferred to the audit log when both attempts fail (logAuditAction keeps a
 * refused audit row in the EVID-6 outbox, which the maintenance cron recovers
 * into the audit log, so a deferred record still reaches the next replay).
 * Never throws; never changes anything else.
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
          details: { source: first.source, error: r.error, rows },
        });
        if (kept && kept.ok === false) throw new Error(kept.error ?? "audit insert refused");
        noteComplianceScan(`${rows.length} document notice record row(s) could not be written (${r.error}) — kept in the audit log; the next run writes them`);
        return "deferred";
      } catch (e) {
        noteComplianceScan(`${rows.length} document notice record row(s) could not be written (${r.error}) and the audit row keeping them was refused too (${(e as Error)?.message ?? String(e)}; a refused audit row is kept in the audit dead-letter outbox where the server could) — the reminders themselves were sent and stamped as before`);
        return "lost";
      }
    },
  };
}

const isNoticeRow = (v: unknown): v is DocumentNoticeRow => {
  const r = v as Record<string, unknown> | null;
  return !!r && typeof r.id === "string" && typeof r.org_id === "string" && typeof r.document_id === "string"
    && typeof r.kind === "string" && typeof r.recipient === "string" && typeof r.source === "string";
};

/**
 * SERVER (a scan's first step): write the rows an earlier run of this scan
 * could not (DOCUMENT_NOTICE_RECORD_DEFERRED, the last 30 days). The same row
 * ids — a row already written is skipped (ON CONFLICT DO NOTHING). Answers the
 * rows offered. Never throws; a failure is a line in the scan's report and the
 * rows wait for the next run.
 */
export async function replayDeferredNotices(orgId: string, source: DocumentNoticeSource): Promise<number> {
  let rows: DocumentNoticeRow[] = [];
  try {
    const { data, error } = await db().from("audit_logs").select("details, timestamp")
      .eq("org_id", orgId).eq("action", DOCUMENT_NOTICE_RECORD_DEFERRED)
      .gte("timestamp", new Date(Date.now() - DEFERRED_NOTICE_LOOKBACK_MS).toISOString())
      .order("timestamp", { ascending: false }).limit(DEFERRED_NOTICE_ROWS);
    if (error) throw new Error(error.message ?? String(error));
    for (const a of (data ?? []) as Array<{ details?: Record<string, unknown> | null }>) {
      const d = a.details ?? null;
      if (!d || d.source !== source || !Array.isArray(d.rows)) continue;
      // only this workspace's rows, whatever the audit row says
      for (const r of d.rows) if (isNoticeRow(r) && r.org_id === orgId && r.source === source) rows.push(r);
    }
  } catch (e) {
    noteComplianceScan(`the deferred document notice records could not be read (${(e as Error)?.message ?? String(e)}) — they are written on a later run`);
    return 0;
  }
  if (rows.length === 0) return 0;
  rows = [...new Map(rows.map((r) => [r.id, r] as const)).values()];
  for (let i = 0; i < rows.length; i += 200) {
    const r = await insertOnce(rows.slice(i, i + 200));
    if (!r.ok) {
      if (!r.missing) noteComplianceScan(`deferred document notice records could not be written yet (${r.error}) — retried on the next run`);
      return 0;
    }
  }
  return rows.length;
}

/** The record's own cooldown read for the distribution-ack nag: who was
 *  reminded / escalated for which document since `sinceIso`. null when the
 *  record cannot be read (missing or refused) — the caller then counts from
 *  the notifications rows alone, as before. */
export async function recentDistributionNotices(orgId: string, sinceIso: string): Promise<{ reminded: Set<string>; escalated: Set<string> } | null> {
  try {
    const { data, error } = await db().from("document_notice_events")
      .select("recipient, document_id, kind")
      .eq("org_id", orgId).eq("source", "distribution_ack")
      .in("kind", ["reminded", "escalated"])
      .gte("noticed_at", sinceIso);
    if (error) return null;
    const reminded = new Set<string>();
    const escalated = new Set<string>();
    for (const r of (data ?? []) as Array<{ recipient?: string; document_id?: string; kind?: string }>) {
      const key = `${String(r.recipient)}:${String(r.document_id)}`;
      if (r.kind === "reminded") reminded.add(key);
      else if (r.kind === "escalated") escalated.add(key);
    }
    return { reminded, escalated };
  } catch {
    return null;
  }
}
