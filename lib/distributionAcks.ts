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

import { supabase } from "@/lib/supabase";
import { notify, notifyMany } from "@/lib/inAppNotifications";

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

let ackSchemaMissing = false;
export function resetAckSchemaFlag(): void { ackSchemaMissing = false; }

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

/** Every ack row for the CURRENT version of a document. */
export async function listAcksForVersion(versionId: string): Promise<DistributionAck[]> {
  if (ackSchemaMissing) return [];
  try {
    const { data, error } = await supabase
      .from("distribution_acks")
      .select("*")
      .eq("version_id", versionId)
      .order("acknowledged_at", { ascending: true, nullsFirst: true });
    if (error) {
      if (isMissingAckSchema(error)) { ackSchemaMissing = true; return []; }
      throw new Error(error.message);
    }
    return ((data as Record<string, unknown>[]) ?? []).map(rowToAck);
  } catch {
    return [];
  }
}

/** My own pending ack on this version (drives the acknowledge bar). */
export async function getMyPendingAck(
  versionId: string,
  userId: string,
): Promise<DistributionAck | null> {
  if (ackSchemaMissing) return null;
  try {
    const { data, error } = await supabase
      .from("distribution_acks")
      .select("*")
      .eq("version_id", versionId)
      .eq("recipient_user_id", userId)
      .is("acknowledged_at", null)
      .maybeSingle();
    if (error) {
      if (isMissingAckSchema(error)) ackSchemaMissing = true;
      return null;
    }
    return data ? rowToAck(data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Request acknowledgment of the current revision from a set of members.
 *  Upsert per (version, recipient): re-requesting refreshes, never dupes. */
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
}): Promise<void> {
  const now = new Date().toISOString();
  const rows = input.recipients.map((r) => ({
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
    .upsert(rows, { onConflict: "version_id,recipient_user_id", ignoreDuplicates: false });
  if (error) {
    if (isMissingAckSchema(error)) {
      ackSchemaMissing = true;
      throw new Error("Acknowledged distribution needs the 20260825 migration applied first.");
    }
    throw new Error(error.message);
  }

  await notifyMany({
    orgId: input.orgId,
    userIds: input.recipients.map((r) => r.uid),
    actorUserId: input.actorUserId,
    actorName: input.actorName,
    kind: "doc_superseded",
    title: `Please confirm: ${input.docLabel} Rev ${input.revLabel ?? "?"}`,
    body: `${input.actorName} needs your confirmation that you have the current revision. Open the document and tap "I have this revision" — takes two seconds, goes on the distribution record.`,
    link: input.libraryId ? `/documents/${input.libraryId}?doc=${input.documentId}` : undefined,
    resourceType: "document",
    resourceId: input.documentId,
    metadata: { ackRequest: true, versionId: input.versionId },
  });
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
    .select("id, document_id, rev_label, requested_at, requested_by_name")
    .eq("org_id", orgId)
    .eq("recipient_user_id", uid)
    .is("acknowledged_at", null)
    .order("requested_at", { ascending: true })
    .limit(50);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (!rows.length) return [];
  const docIds = [...new Set(rows.map((r) => r.document_id as string))];
  const { data: docs } = await supabase
    .from("documents").select("id, library_id, document_number, title, name").in("id", docIds);
  const byId = new Map(((docs ?? []) as Array<Record<string, unknown>>).map((d) => [d.id as string, d]));
  return rows.map((r) => {
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

/** One-click acknowledge (recipient side). */
export async function acknowledge(ackId: string): Promise<void> {
  const { error } = await supabase
    .from("distribution_acks")
    .update({ acknowledged_at: new Date().toISOString() })
    .eq("id", ackId)
    .is("acknowledged_at", null);
  if (error) throw new Error(error.message);
}

/**
 * Daily scan (cron): auto-nag outstanding distribution acks. Requests older
 * than `nagAfterDays` with no acknowledgment re-notify the recipient; once
 * `escalateAfterDays` old, the requester is told who has gone quiet so the
 * loop closes with a phone call instead of a stuck counter. "8 of 12
 * confirmed" must not be able to sit at 8 forever on silence alone.
 */
export async function scanDistributionAcks(orgId: string, opts?: {
  nagAfterDays?: number; escalateAfterDays?: number;
}): Promise<number> {
  const nagAfterDays = opts?.nagAfterDays ?? 3;
  const escalateAfterDays = opts?.escalateAfterDays ?? 10;
  const nagCutoff = new Date(Date.now() - nagAfterDays * 86_400_000).toISOString();
  const { data } = await supabase
    .from("distribution_acks")
    .select("id, document_id, version_id, rev_label, recipient_user_id, recipient_email, requested_by, requested_by_name, requested_at")
    .eq("org_id", orgId)
    .is("acknowledged_at", null)
    .lt("requested_at", nagCutoff);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (!rows.length) return 0;

  // One nudge per (recipient, document) per run; escalate stale ones to the
  // requester grouped per document so they get one summary, not N pings.
  const docIds = [...new Set(rows.map((r) => r.document_id as string))];
  const { data: docRows } = await supabase
    .from("documents").select("id, library_id, document_number, title, name").in("id", docIds);
  const docs = new Map(((docRows ?? []) as Array<Record<string, unknown>>).map((d) => [d.id as string, d]));

  let n = 0;
  const escalations = new Map<string, { requesterId: string; docId: string; names: string[] }>();
  for (const r of rows) {
    const doc = docs.get(r.document_id as string);
    const label = (doc?.document_number as string) || (doc?.title as string) || (doc?.name as string) || "Document";
    const link = doc?.library_id ? `/documents/${doc.library_id as string}?doc=${r.document_id as string}` : undefined;
    await notify({
      orgId,
      userId: r.recipient_user_id as string,
      kind: "doc_superseded",
      title: `Still unconfirmed: ${label} Rev ${(r.rev_label as string) ?? "?"}`,
      body: `Your confirmation of the current revision is outstanding. Open the document and tap "I have this revision".`,
      link,
      resourceType: "document",
      resourceId: r.document_id as string,
      actorName: "System",
      metadata: { ackRequest: true, autoNag: true },
    });
    n += 1;

    const ageDays = (Date.now() - Date.parse(r.requested_at as string)) / 86_400_000;
    if (ageDays >= escalateAfterDays && r.requested_by) {
      const key = `${r.requested_by as string}:${r.document_id as string}`;
      const e = escalations.get(key) ?? { requesterId: r.requested_by as string, docId: r.document_id as string, names: [] };
      e.names.push((r.recipient_email as string) || "a recipient");
      escalations.set(key, e);
    }
  }
  for (const e of escalations.values()) {
    const doc = docs.get(e.docId);
    const label = (doc?.document_number as string) || (doc?.title as string) || (doc?.name as string) || "Document";
    await notify({
      orgId,
      userId: e.requesterId,
      kind: "doc_superseded",
      title: `${e.names.length} unconfirmed after ${escalateAfterDays}+ days: ${label}`,
      body: `Not confirmed despite reminders: ${e.names.slice(0, 5).join(", ")}${e.names.length > 5 ? ` +${e.names.length - 5} more` : ""}. Time to follow up directly.`,
      link: doc?.library_id ? `/documents/${doc.library_id as string}?doc=${e.docId}` : undefined,
      resourceType: "document",
      resourceId: e.docId,
      actorName: "System",
      metadata: { ackEscalation: true },
    });
    n += 1;
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
  await notifyMany({
    orgId: input.orgId,
    userIds: pending.map((a) => a.recipientUserId),
    actorUserId: input.actorUserId,
    actorName: input.actorName,
    kind: "doc_superseded",
    title: `Reminder: confirm ${input.docLabel} Rev ${input.revLabel ?? "?"}`,
    body: `Still waiting on your confirmation that you have the current revision — open the document and tap "I have this revision".`,
    link: input.libraryId ? `/documents/${input.libraryId}?doc=${input.documentId}` : undefined,
    resourceType: "document",
    resourceId: input.documentId,
    metadata: { ackRequest: true },
  });
  return pending.length;
}
