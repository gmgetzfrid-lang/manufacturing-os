// lib/distributionAcks.ts
//
// ACKNOWLEDGED DISTRIBUTION — notification is not acknowledgment.
//
// For safety-critical revisions, Document Control needs "I sent Rev 5 to
// these 12 people — 8 have CONFIRMED they have it", with one-click
// acknowledge for recipients and re-nudge for the unconfirmed. One row per
// (version, recipient); acknowledging stamps the row. The audit answer to
// "prove the field knew about the change".
//
// Pre-migration tolerance: helpers no-op / return empty until 20260825 is
// applied.
//
// drafting-flow EVID-7 (DF-P11): there is no module-level latch any more.
// A read answers, PER CALL, one of three things the panel renders apart:
// "ok" (the rows — an empty list is "none requested"), "unavailable" (the
// table or a column is not in this database — named, never shown as empty)
// and "error" (the query failed — said, with the reason). A transient
// schema-cache miss after a deploy no longer blinds the rest of the session:
// the next call asks again.
// drafting-flow EVID-2 (DF-P11): acknowledging writes an
// ACK_DISTRIBUTION_CONFIRMED audit row beside the stamped row — two
// independent records; 20261239 refuses un-acknowledging and bounds
// requested_at at the database.

import { supabase } from "@/lib/supabase";
import { logAuditAction } from "@/lib/audit";
// DELIV-16 / DELIV-7 dw1 (notifications N15): the scan's notices retry and
// dead-letter (DEC-102) — one import line, every call site unchanged.
import { notifyCompliance as notify } from "@/lib/complianceNotify";
import { emit } from "@/lib/notify/dispatch";
import { assertNotOnHold } from "@/lib/holdGate";
// DIST-19 (document-control P38): each nudge and escalation the daily nag
// lands is a row on the append-only notice record, and the nag's cooldown
// counts from that record (the notifications rows still count too).
import { noticeRecorder, noticeRow, recentDistributionNotices, replayDeferredNotices } from "@/lib/documentNoticeRecord";

export interface DistributionAck {
  id: string;
  documentId: string;
  versionId: string;
  revLabel: string | null;
  recipientUserId: string;
  recipientEmail: string | null;
  requestedByName: string | null;
  requestedAt: string;
  acknowledgedAt: string | null;
}

/** EVID-7: what one read of the distribution record found. */
export type AckRead<T> =
  | { status: "ok"; value: T }
  | { status: "unavailable"; reason: string }
  | { status: "error"; message: string };

const UNAVAILABLE_REASON =
  "The distribution record isn't in this database yet (migration 20260825, or a column it needs, is missing).";

function isMissingAckSchema(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === "42P01" || e.code === "PGRST205" || e.code === "PGRST204" || e.code === "42703") return true;
  const msg = (e.message ?? "").toLowerCase();
  return msg.includes("distribution_acks") &&
    (msg.includes("does not exist") || msg.includes("schema cache") || msg.includes("could not find"));
}

function rowToAck(r: Record<string, unknown>): DistributionAck {
  return {
    id: String(r.id),
    documentId: String(r.document_id),
    versionId: String(r.version_id),
    revLabel: (r.rev_label as string | null) ?? null,
    recipientUserId: String(r.recipient_user_id),
    recipientEmail: (r.recipient_email as string | null) ?? null,
    requestedByName: (r.requested_by_name as string | null) ?? null,
    requestedAt: String(r.requested_at),
    acknowledgedAt: (r.acknowledged_at as string | null) ?? null,
  };
}

/** EVID-7: every ack row for one version — "ok" with the rows (an empty
 *  list means none was requested), "unavailable" when the table or a column
 *  is not in this database, "error" when the read failed. Asked every call. */
export async function readAcksForVersion(versionId: string): Promise<AckRead<DistributionAck[]>> {
  try {
    const { data, error } = await supabase
      .from("distribution_acks")
      .select("*")
      .eq("version_id", versionId)
      .order("acknowledged_at", { ascending: true, nullsFirst: true });
    if (error) {
      if (isMissingAckSchema(error)) return { status: "unavailable", reason: UNAVAILABLE_REASON };
      return { status: "error", message: error.message || "the distribution record could not be read" };
    }
    return { status: "ok", value: ((data as Record<string, unknown>[]) ?? []).map(rowToAck) };
  } catch (e) {
    return { status: "error", message: (e as Error)?.message || "the distribution record could not be read" };
  }
}

/** EVID-7: my own pending ack on this version (drives the acknowledge bar),
 *  with the same three answers. */
export async function readMyPendingAck(versionId: string, userId: string): Promise<AckRead<DistributionAck | null>> {
  try {
    const { data, error } = await supabase
      .from("distribution_acks")
      .select("*")
      .eq("version_id", versionId)
      .eq("recipient_user_id", userId)
      .is("acknowledged_at", null)
      .maybeSingle();
    if (error) {
      if (isMissingAckSchema(error)) return { status: "unavailable", reason: UNAVAILABLE_REASON };
      return { status: "error", message: error.message || "your confirmation request could not be read" };
    }
    return { status: "ok", value: data ? rowToAck(data as Record<string, unknown>) : null };
  } catch (e) {
    return { status: "error", message: (e as Error)?.message || "your confirmation request could not be read" };
  }
}

/** Every ack row for the CURRENT version of a document — the rows, or an
 *  empty list when the record could not be read (callers that must tell
 *  the two apart use readAcksForVersion). No latch: each call asks. */
export async function listAcksForVersion(versionId: string): Promise<DistributionAck[]> {
  const r = await readAcksForVersion(versionId);
  return r.status === "ok" ? r.value : [];
}

/** My own pending ack on this version, or null when there is none OR it
 *  could not be read (readMyPendingAck tells them apart). No latch. */
export async function getMyPendingAck(
  versionId: string,
  userId: string,
): Promise<DistributionAck | null> {
  const r = await readMyPendingAck(versionId, userId);
  return r.status === "ok" ? r.value : null;
}

/** Request acknowledgment of the current revision from a set of members.
 *
 *  DIST-12: an existing row's requested_at is EVIDENCE — it anchors the
 *  cron's nag cutoff and the 10-day escalation to the requester. The old
 *  blanket upsert rewrote it to now() for every re-selected recipient, so
 *  "reminding" someone erased the proof they had gone quiet. Now: NEW
 *  recipients get a row + the request; recipients with an outstanding row
 *  get a REMINDER and their clock is left alone (ON CONFLICT DO NOTHING
 *  makes even a race unable to rewrite it); already-confirmed recipients
 *  are untouched. */
export async function requestAcks(input: {
  orgId: string;
  documentId: string;
  libraryId?: string | null;
  docLabel: string;
  versionId: string;
  revLabel: string | null;
  recipients: Array<{ uid: string; email?: string | null }>;
  actorUserId: string;
  actorName: string;
  /** false = create/keep the rows silently (the recall path sends its own
   *  notification); defaults to notifying. */
  notify?: boolean;
}): Promise<{ requested: number; reminded: number }> {
  // HLD-1: an acknowledgment is an assignment against the revision — nobody
  // is asked to confirm they hold a drawing that is under a stop-work. The
  // recall close-out (`notify: false`, DIST-10) is the record of a recall
  // already sent to holders of an OUTDATED copy, not an assignment against
  // the held revision, and proceeds. Fails closed on an unreadable hold set.
  if (input.notify !== false) {
    await assertNotOnHold(input.documentId, { action: "requesting confirmations" });
  }
  const now = new Date().toISOString();
  const uids = input.recipients.map((r) => r.uid);
  let existing = new Map<string, { acknowledged: boolean }>();
  try {
    const { data } = await supabase
      .from("distribution_acks")
      .select("recipient_user_id, acknowledged_at")
      .eq("version_id", input.versionId)
      .in("recipient_user_id", uids);
    existing = new Map(
      (((data as Array<{ recipient_user_id: string; acknowledged_at: string | null }>) ?? []))
        .map((r) => [r.recipient_user_id, { acknowledged: !!r.acknowledged_at }]),
    );
  } catch { /* read miss → treat all as new; DO NOTHING below stays safe */ }
  const fresh = input.recipients.filter((r) => !existing.has(r.uid));
  const pendingExisting = input.recipients.filter((r) => {
    const e = existing.get(r.uid);
    return !!e && !e.acknowledged;
  });

  if (fresh.length > 0) {
    const rows = fresh.map((r) => ({
      org_id: input.orgId,
      document_id: input.documentId,
      version_id: input.versionId,
      rev_label: input.revLabel,
      recipient_user_id: r.uid,
      recipient_email: r.email ?? null,
      requested_by: input.actorUserId,
      requested_by_name: input.actorName,
      requested_at: now,
    }));
    const { error } = await supabase
      .from("distribution_acks")
      .upsert(rows, { onConflict: "version_id,recipient_user_id", ignoreDuplicates: true });
    if (error) {
      if (isMissingAckSchema(error)) {
        throw new Error("Acknowledged distribution needs the 20260825 migration applied first.");
      }
      throw new Error(error.message);
    }
  }

  if (input.notify !== false && fresh.length > 0) {
    await emit({
      orgId: input.orgId,
      category: "assignment",
      // PROD-13 / TAX-13 (N9): an acknowledgment request rides the
      // acknowledgment kind (ack_requested), never the supersede notice.
      kind: "ack_requested",
      title: `Please confirm: ${input.docLabel} Rev ${input.revLabel ?? "?"}`,
      body: `${input.actorName} needs your confirmation that you have the current revision. Open the document and tap "I have this revision" — takes two seconds, goes on the distribution record.`,
      link: input.libraryId ? `/documents/${input.libraryId}?doc=${input.documentId}` : undefined,
      resource: { type: "document", id: input.documentId },
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      audience: { involved: fresh.map((r) => r.uid) },
      metadata: { ackRequest: true, versionId: input.versionId },
    });
  }
  if (input.notify !== false && pendingExisting.length > 0) {
    await emit({
      orgId: input.orgId,
      category: "assignment",
      kind: "ack_requested",   // PROD-13 / TAX-13 (N9)
      title: `Reminder: confirm ${input.docLabel} Rev ${input.revLabel ?? "?"}`,
      body: `Still waiting on your confirmation that you have the current revision — open the document and tap "I have this revision".`,
      link: input.libraryId ? `/documents/${input.libraryId}?doc=${input.documentId}` : undefined,
      resource: { type: "document", id: input.documentId },
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      audience: { involved: pendingExisting.map((r) => r.uid) },
      metadata: { ackRequest: true, versionId: input.versionId },
    });
  }
  return { requested: fresh.length, reminded: pendingExisting.length };
}

/** DIST-4: close out obligations that no longer bind. Called on publish
 *  (`currentVersionId` = the new current — PENDING acks on every other
 *  version close) and on retirement (`null` — every pending ack closes; the
 *  document itself is gone, DIST-1's recall says so). Acknowledged rows are
 *  completed history and are never touched. Stamps the 20261035
 *  `superseded_at` column; quietly no-ops on an older database — the read
 *  paths below also currency-scope in JS, so an unstamped orphan is inert
 *  either way. Best-effort: any refusal or throw answers 0 (the checked
 *  variant below says which). */
export async function closeStaleAcksForDocument(
  documentId: string,
  currentVersionId: string | null,
): Promise<number> {
  return (await closeStaleAcksForDocumentChecked(documentId, currentVersionId)).closed;
}

/** REV-34 (c) (document-control P34 final fix pass): closeStaleAcksForDocument's
 *  one statement, with its outcome — `closed`, the acks it stamped (0 on a
 *  refusal), and `error`, the database's refusal or the throw (null when the
 *  statement landed). Never throws. A caller that must name a refusal
 *  (lib/revisions.ts finishRetirementDuties) reads `error`, and decides
 *  itself whether a database before the column (42703 / PGRST204 —
 *  isMissingSchemaError) is a refusal; closeStaleAcksForDocument keeps its
 *  quiet best-effort answer. */
export async function closeStaleAcksForDocumentChecked(
  documentId: string,
  exceptVersionId: string | null,
): Promise<{ closed: number; error: { message: string; code: string | null } | null }> {
  try {
    let q = supabase
      .from("distribution_acks")
      .update({ superseded_at: new Date().toISOString() })
      .eq("document_id", documentId)
      .is("acknowledged_at", null)
      .is("superseded_at", null);
    if (exceptVersionId) q = q.neq("version_id", exceptVersionId);
    const { data, error } = await q.select("id");
    if (error) return { closed: 0, error: { message: String(error.message ?? error), code: (error as { code?: string | null }).code ?? null } };
    return { closed: data?.length ?? 0, error: null };
  } catch (e) {
    const err = e as { message?: unknown; code?: unknown } | null;
    return { closed: 0, error: { message: typeof err?.message === "string" ? err.message : String(e), code: typeof err?.code === "string" ? err.code : null } };
  }
}

/** The DIST-4 currency rule, shared by every obligation reader: a pending
 *  ack binds only while its version IS the document's current version and
 *  the document is alive. (The confirm bar is version-scoped already; a
 *  reader that ignores currency resurrects immortal, un-dischargeable
 *  obligations.) */
function ackStillBinds(
  row: { version_id?: unknown },
  doc: { current_version_id?: unknown; status?: unknown } | undefined,
): boolean {
  if (!doc) return false;
  const status = String(doc.status ?? "");
  if (status === "Superseded" || status === "Void" || status === "Archived") return false;
  return String(row.version_id ?? "") === String(doc.current_version_id ?? "");
}

/** Distribution confirmations pending on THIS user — for the inbox / My
 *  Desk, so a missed bell doesn't bury the request forever. */
export async function listMyPendingDistributionAcks(orgId: string, uid: string): Promise<Array<{
  ackId: string; documentId: string; libraryId: string | null; label: string;
  revLabel: string | null; requestedAt: string; requestedByName: string | null;
}>> {
  if (!uid) return [];
  const { data } = await supabase
    .from("distribution_acks")
    .select("id, document_id, version_id, rev_label, requested_at, requested_by_name")
    .eq("org_id", orgId)
    .eq("recipient_user_id", uid)
    .is("acknowledged_at", null)
    .order("requested_at", { ascending: true })
    .limit(50);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (!rows.length) return [];
  const docIds = [...new Set(rows.map((r) => r.document_id as string))];
  const { data: docs } = await supabase
    .from("documents").select("id, library_id, document_number, title, name, current_version_id, status").in("id", docIds);
  const byId = new Map(((docs ?? []) as Array<Record<string, unknown>>).map((d) => [d.id as string, d]));
  // DIST-4: only CURRENT-version obligations surface — a Rev-4 row after
  // Rev 5 issues used to sit in the inbox forever, linking to a page where
  // the confirm bar (correctly version-scoped) could never render.
  return rows.filter((r) => ackStillBinds(r, byId.get(r.document_id as string))).map((r) => {
    const d = byId.get(r.document_id as string);
    return {
      ackId: r.id as string,
      documentId: r.document_id as string,
      libraryId: (d?.library_id as string | null) ?? null,
      label: String(d?.document_number || d?.title || d?.name || "Document"),
      revLabel: (r.rev_label as string | null) ?? null,
      requestedAt: r.requested_at as string,
      requestedByName: (r.requested_by_name as string | null) ?? null,
    };
  });
}

/** One-click acknowledge (recipient side). Pinned to the RECIPIENT's own row
 *  (DIST-3): filtered by id alone, any member could stamp another person's
 *  acknowledgment and forge the "N of M confirmed" register. The write is
 *  checked — zero rows means the row wasn't yours (or was already stamped)
 *  and must not read as success. */
export async function acknowledge(
  ackId: string,
  recipientUserId: string,
  actor?: { email?: string | null; role?: string | null },
): Promise<{ auditRecorded: boolean; auditError: string | null }> {
  const { data, error } = await supabase
    .from("distribution_acks")
    .update({ acknowledged_at: new Date().toISOString() })
    .eq("id", ackId)
    .eq("recipient_user_id", recipientUserId)
    .is("acknowledged_at", null)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error("This acknowledgment isn't yours to sign (or it was already recorded).");
  }
  // EVID-2 done-when 4 (DF-P11): a second, independent record of the act.
  // The confirmation already stands; a refused audit row is RETURNED (the
  // panel says it), never a silent success and never an un-done confirmation
  // (DEC-44's member-writer rule; lib/audit dead-letters what it cannot write).
  const { data: stamped, error: readErr } = await supabase
    .from("distribution_acks")
    .select("org_id, document_id, version_id, rev_label, acknowledged_at")
    .eq("id", ackId)
    .maybeSingle();
  if (readErr || !stamped) {
    return {
      auditRecorded: false,
      auditError: `the confirmed acknowledgment could not be re-read to write its audit row (${readErr?.message ?? "no row"})`,
    };
  }
  const row = stamped as Record<string, unknown>;
  const audit = await logAuditAction({
    action: "ACK_DISTRIBUTION_CONFIRMED",
    resourceType: "document",
    resourceId: String(row.document_id ?? ""),
    orgId: String(row.org_id ?? ""),
    userId: recipientUserId,
    userEmail: actor?.email ?? undefined,
    userRole: actor?.role ?? undefined,
    details: {
      ackId, versionId: (row.version_id as string | null) ?? null,
      revLabel: (row.rev_label as string | null) ?? null,
      acknowledgedAt: (row.acknowledged_at as string | null) ?? null,
    },
  });
  return { auditRecorded: audit.ok, auditError: audit.ok ? null : audit.error };
}

/**
 * Daily scan (cron): auto-nag outstanding distribution acks. Requests older
 * than `nagAfterDays` with no acknowledgment re-notify the recipient; once
 * `escalateAfterDays` old, the requester is told who has gone quiet so the
 * loop closes with a phone call instead of a stuck counter. "8 of 12
 * confirmed" must not be able to sit at 8 forever on silence alone.
 */
export async function scanDistributionAcks(orgId: string, opts?: {
  nagAfterDays?: number; escalateAfterDays?: number; nagEveryDays?: number;
}): Promise<number> {
  const nagAfterDays = opts?.nagAfterDays ?? 3;
  const escalateAfterDays = opts?.escalateAfterDays ?? 10;
  // Cadence, not clock: the scan runs DAILY, so without a cooldown every
  // outstanding row would bell its recipient every single day forever.
  const nagEveryDays = opts?.nagEveryDays ?? 3;
  const nagCutoff = new Date(Date.now() - nagAfterDays * 86_400_000).toISOString();
  // DIST-19 (P38): rows an earlier run could not write are written first;
  // this run's writer says a missing record once (never fails the scan).
  await replayDeferredNotices(orgId, "distribution_ack");
  const notices = noticeRecorder();
  const { data } = await supabase
    .from("distribution_acks")
    .select("id, document_id, version_id, rev_label, recipient_user_id, recipient_email, requested_by, requested_by_name, requested_at")
    .eq("org_id", orgId)
    .is("acknowledged_at", null)
    .lt("requested_at", nagCutoff);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (!rows.length) return 0;

  // WATERMARK — the recently-sent notifications themselves. One nudge per
  // (recipient, document) and one escalation per (requester, document) per
  // nagEveryDays window; a manual request/re-nudge inside the window also
  // counts, so a controller's fresh nudge isn't followed by a robot's.
  // PROD-13 / TAX-13 (N9): a manual request and re-nudge are ack_requested
  // rows now (they rode doc_superseded until N9; 20261191 re-files the rows
  // already written with metadata.ackRequest), so the read is the two
  // acknowledgment kinds. The metadata keys still tell this register's rows
  // from the read-&-understood roster's ack_requested rows
  // (lib/acknowledgments.ts), which carry neither key.
  const cooldownIso = new Date(Date.now() - nagEveryDays * 86_400_000).toISOString();
  const recentlyNagged = new Set<string>();
  const recentlyEscalated = new Set<string>();
  try {
    const { data: recent } = await supabase
      .from("notifications")
      .select("user_id, resource_id, metadata")
      .eq("org_id", orgId)
      .in("kind", ["ack_requested", "ack_overdue"])
      .gte("created_at", cooldownIso);
    for (const r of ((recent ?? []) as Array<Record<string, unknown>>)) {
      const meta = (r.metadata as Record<string, unknown> | null) ?? {};
      const key = `${r.user_id as string}:${r.resource_id as string}`;
      if (meta.ackRequest) recentlyNagged.add(key);
      if (meta.ackEscalation) recentlyEscalated.add(key);
    }
  } catch { /* dedupe is best-effort; worst case is one extra nudge */ }
  // DIST-19 (P38): the nag's own nudges and escalations are counted from the
  // notice record — durable, never purged — as well as from the rows above
  // (which still carry the manual request / re-nudge, not on the record).
  // Unreadable (20261257 not pasted, or refused): the rows above alone, as
  // before. The union only ever withholds a nudge the record says landed
  // inside the window: one nudge per cooldown, as today.
  const recorded = await recentDistributionNotices(orgId, cooldownIso);
  if (recorded) {
    for (const k of recorded.reminded) recentlyNagged.add(k);
    for (const k of recorded.escalated) recentlyEscalated.add(k);
  }

  // Escalate stale ones to the requester grouped per document so they get
  // one summary, not N pings.
  const docIds = [...new Set(rows.map((r) => r.document_id as string))];
  const { data: docRows } = await supabase
    .from("documents").select("id, library_id, document_number, title, name, current_version_id, status").in("id", docIds);
  const docs = new Map(((docRows ?? []) as Array<Record<string, unknown>>).map((d) => [d.id as string, d]));

  // DIST-4: the cron nags only obligations that still bind. A pending ack on
  // a non-current version (or a retired document) used to be re-nagged every
  // 3 days FOREVER while being structurally un-dischargeable — the recipient's
  // confirm bar is version-scoped and could never render for it.
  const binding = rows.filter((r) => ackStillBinds(r, docs.get(r.document_id as string)));

  let n = 0;
  // notifyCompliance answers whether its row landed (DELIV-7 dw1, N15). The
  // watermark above IS the notifications rows, per (recipient, document): a
  // notice that dead-lettered leaves no row, so nothing marks that reminder
  // sent and the next run nudges that recipient again (its retry key says so
  // in the run's line). The cron's scope counts delivered apart from
  // attempted (result.complianceBellNotices); `n` stays the rows attempted.
  const sends: Array<() => Promise<unknown>> = [];
  const escalations = new Map<string, { requesterId: string; docId: string; names: string[]; acks: Array<Record<string, unknown>> }>();
  for (const r of binding) {
    const docId = r.document_id as string;
    const doc = docs.get(docId);
    const label = (doc?.document_number as string) || (doc?.title as string) || (doc?.name as string) || "Document";
    const link = doc?.library_id ? `/documents/${doc.library_id as string}?doc=${docId}` : undefined;
    if (!recentlyNagged.has(`${r.recipient_user_id as string}:${docId}`)) {
      sends.push(() => notify({
        orgId,
        userId: r.recipient_user_id as string,
        kind: "ack_requested",
        title: `Still unconfirmed: ${label} Rev ${(r.rev_label as string) ?? "?"}`,
        body: `Your confirmation of the current revision is outstanding. Open the document and tap "I have this revision".`,
        link,
        resourceType: "document",
        resourceId: docId,
        actorName: "System",
        metadata: { ackRequest: true, autoNag: true, versionId: r.version_id as string },
      }, { retryKey: `distribution-acks:${r.id as string}` }).then((ok) => ok
        // DIST-19: a nudge that landed is a row on the record
        ? notices.record([noticeRow({
          org_id: orgId, document_id: docId, version_id: (r.version_id as string | null) ?? null,
          revision_label: (r.rev_label as string | null) ?? null, source: "distribution_ack", source_id: r.id as string,
          kind: "reminded", recipient: r.recipient_user_id as string, subject_user_id: r.recipient_user_id as string,
          details: { ageDays: Math.floor((Date.now() - Date.parse(r.requested_at as string)) / 86_400_000) },
        })]).then(() => ok)
        : ok));
      n += 1;
    }

    const ageDays = (Date.now() - Date.parse(r.requested_at as string)) / 86_400_000;
    if (ageDays >= escalateAfterDays && r.requested_by) {
      const key = `${r.requested_by as string}:${docId}`;
      const e = escalations.get(key) ?? { requesterId: r.requested_by as string, docId, names: [], acks: [] };
      e.names.push((r.recipient_email as string) || "a recipient");
      e.acks.push(r);
      escalations.set(key, e);
    }
  }
  for (const e of escalations.values()) {
    if (recentlyEscalated.has(`${e.requesterId}:${e.docId}`)) continue;
    const doc = docs.get(e.docId);
    const label = (doc?.document_number as string) || (doc?.title as string) || (doc?.name as string) || "Document";
    sends.push(() => notify({
      orgId,
      userId: e.requesterId,
      kind: "ack_overdue",
      title: `${e.names.length} unconfirmed after ${escalateAfterDays}+ days: ${label}`,
      body: `Not confirmed despite reminders: ${e.names.slice(0, 5).join(", ")}${e.names.length > 5 ? ` +${e.names.length - 5} more` : ""}. Time to follow up directly.`,
      link: doc?.library_id ? `/documents/${doc.library_id as string}?doc=${e.docId}` : undefined,
      resourceType: "document",
      resourceId: e.docId,
      actorName: "System",
      metadata: { ackEscalation: true },
    }, { retryKey: `distribution-acks:escalation:${e.requesterId}:${e.docId}` }).then((ok) => ok
      // DIST-19: an escalation that landed is one row per silent recipient it names
      ? notices.record(e.acks.map((a) => noticeRow({
        org_id: orgId, document_id: e.docId, version_id: (a.version_id as string | null) ?? null,
        revision_label: (a.rev_label as string | null) ?? null, source: "distribution_ack", source_id: a.id as string,
        kind: "escalated", recipient: e.requesterId, subject_user_id: a.recipient_user_id as string,
        details: { escalateAfterDays, silentRecipients: e.acks.length },
      }))).then(() => ok)
      : ok));
    n += 1;
  }
  // Chunked parallel sends — per-row awaits were the cron's dominant cost.
  for (let i = 0; i < sends.length; i += 20) {
    await Promise.all(sends.slice(i, i + 20).map((fn) => fn()));
  }
  return n;
}

/** Re-nudge everyone who hasn't confirmed yet. */
export async function renudgeUnacked(input: {
  orgId: string;
  documentId: string;
  libraryId?: string | null;
  docLabel: string;
  revLabel: string | null;
  acks: DistributionAck[];
  actorUserId: string;
  actorName: string;
}): Promise<number> {
  const pending = input.acks.filter((a) => !a.acknowledgedAt);
  if (pending.length === 0) return 0;
  await emit({
    orgId: input.orgId,
    category: "assignment",
    kind: "ack_requested",   // PROD-13 / TAX-13 (N9)
    title: `Reminder: confirm ${input.docLabel} Rev ${input.revLabel ?? "?"}`,
    body: `Still waiting on your confirmation that you have the current revision — open the document and tap "I have this revision".`,
    link: input.libraryId ? `/documents/${input.libraryId}?doc=${input.documentId}` : undefined,
    resource: { type: "document", id: input.documentId },
    actorUserId: input.actorUserId,
    actorName: input.actorName,
    audience: { involved: pending.map((a) => a.recipientUserId) },
    metadata: { ackRequest: true },
  });
  return pending.length;
}
