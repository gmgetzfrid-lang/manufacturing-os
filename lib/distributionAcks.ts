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
import { notifyMany } from "@/lib/inAppNotifications";

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

/** One-click acknowledge (recipient side). */
export async function acknowledge(ackId: string): Promise<void> {
  const { error } = await supabase
    .from("distribution_acks")
    .update({ acknowledged_at: new Date().toISOString() })
    .eq("id", ackId)
    .is("acknowledged_at", null);
  if (error) throw new Error(error.message);
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
