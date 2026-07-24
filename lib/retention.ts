// lib/retention.ts
//
// Records management: retention, disposition, and legal hold.
//   * Retention — how long a controlled record is kept, from a basis date.
//     Inherits document > folder > library (most specific DEFINED wins).
//   * Disposition — once past retention a record is ELIGIBLE for disposition;
//     acting on it (archive/destroy) is always an explicit, logged controller
//     action — records are never auto-destroyed.
//   * Legal hold — freezes a record against deletion/disposition regardless of
//     retention. Enforced in the app's delete/dispose paths (see isLegalHold).

import { supabase } from "@/lib/supabase";
import { notify } from "@/lib/inAppNotifications";
import { logAuditAction } from "@/lib/audit";
import { effectiveOwnerForDocument, getOrgControllers } from "@/lib/ownership";
import type { RetentionPolicy } from "@/types/schema";

type Level = "library" | "collection" | "document";
interface PolicyCols { retention_policy?: RetentionPolicy | null }
const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)));
const todayISO = () => new Date().toISOString().slice(0, 10);

// ── Policy resolution ────────────────────────────────────────────────────────

export function resolveEffectiveRetentionPolicy(
  docP?: RetentionPolicy | null, folderP?: RetentionPolicy | null, libP?: RetentionPolicy | null,
): RetentionPolicy | null {
  for (const p of [docP, folderP, libP]) {
    if (p) return p.enabled ? p : null;
  }
  return null;
}

export async function effectiveRetentionPolicyForDocument(doc: {
  retentionPolicy?: RetentionPolicy | null; collectionId?: string | null; libraryId: string;
}): Promise<RetentionPolicy | null> {
  let folder: RetentionPolicy | null = null;
  if (doc.collectionId) {
    const { data } = await supabase.from("collections").select("retention_policy").eq("id", doc.collectionId).maybeSingle();
    folder = (data as PolicyCols)?.retention_policy ?? null;
  }
  const { data: lib } = await supabase.from("libraries").select("retention_policy").eq("id", doc.libraryId).maybeSingle();
  return resolveEffectiveRetentionPolicy(doc.retentionPolicy ?? null, folder, (lib as PolicyCols)?.retention_policy ?? null);
}

export function computeRetentionUntil(basisISO: string | null, policy: RetentionPolicy | null): string | null {
  if (!policy || !policy.enabled || !policy.years || !basisISO) return null;
  const d = new Date(basisISO);
  if (Number.isNaN(d.getTime())) return null;
  d.setFullYear(d.getFullYear() + policy.years);
  return d.toISOString().slice(0, 10);
}

export type RetentionStatus = "none" | "active" | "eligible" | "disposed" | "hold";

/** Pill/state for a document. Legal hold wins (it's the loudest); then disposed;
 *  then eligible (past retention); then active (retained); else none. */
export function retentionStatusFor(input: { retentionUntil?: string | null; dispositionState?: string | null; legalHold?: boolean | null }): RetentionStatus {
  if (input.legalHold) return "hold";
  if (input.dispositionState === "disposed") return "disposed";
  if (input.dispositionState === "eligible") return "eligible";
  if (input.retentionUntil) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const due = new Date(`${input.retentionUntil.slice(0, 10)}T00:00:00`);
    if (!Number.isNaN(due.getTime()) && due.getTime() <= today.getTime()) return "eligible";
    return "active";
  }
  return "none";
}

// ── Recompute denormalized state ─────────────────────────────────────────────

interface DocForRetention {
  id: string; retention_policy: RetentionPolicy | null; collection_id: string | null; library_id: string;
  created_at: string | null; updated_at: string | null; effective_date: string | null;
  disposition_state: string | null;
}

/** Recompute a document's retention_until + disposition_state from its effective
 *  policy and basis date. A disposed record is left as-is. */
export async function recomputeRetention(documentId: string): Promise<void> {
  const { data } = await supabase.from("documents")
    .select("id, retention_policy, collection_id, library_id, created_at, updated_at, effective_date, disposition_state")
    .eq("id", documentId).maybeSingle();
  if (!data) return;
  const doc = data as unknown as DocForRetention;
  if (doc.disposition_state === "disposed") return;

  const policy = await effectiveRetentionPolicyForDocument({
    retentionPolicy: doc.retention_policy, collectionId: doc.collection_id, libraryId: doc.library_id,
  });
  if (!policy) {
    await supabase.from("documents").update({ retention_until: null, disposition_state: null }).eq("id", doc.id);
    return;
  }
  const basis = policy.basis ?? "created";
  const basisISO =
    basis === "created" ? doc.created_at
    : basis === "effective" ? (doc.effective_date || doc.updated_at || doc.created_at)
    : /* issued | superseded */ (doc.updated_at || doc.created_at);
  const until = computeRetentionUntil(basisISO, policy);
  const state = until && until <= todayISO() ? "eligible" : "active";
  await supabase.from("documents").update({ retention_until: until, disposition_state: state }).eq("id", doc.id);
}

/** Set (or clear) the retention policy at a level, then recompute the covered
 *  documents so the state is immediately correct. */
export async function setRetentionPolicy(input: {
  level: Level; id: string; orgId: string; policy: RetentionPolicy | null; actorId?: string | null; actorName?: string | null;
}): Promise<void> {
  const table = input.level === "library" ? "libraries" : input.level === "collection" ? "collections" : "documents";
  await supabase.from(table).update({ retention_policy: input.policy }).eq("id", input.id);
  await logEvent(input.orgId, { scopeType: input.level, scopeId: input.id, documentId: input.level === "document" ? input.id : null, action: "retention_set", detail: input.policy ?? undefined, actorId: input.actorId, actorName: input.actorName });

  if (input.level === "document") { await recomputeRetention(input.id); return; }
  const col = input.level === "library" ? "library_id" : "collection_id";
  const { data } = await supabase.from("documents").select("id").eq(col, input.id);
  const ids = ((data ?? []) as Array<Record<string, unknown>>).map((r) => r.id as string);
  for (let i = 0; i < ids.length; i += 25) {
    await Promise.all(ids.slice(i, i + 25).map((id) => recomputeRetention(id)));
  }
}

// ── Legal hold ───────────────────────────────────────────────────────────────

export async function isLegalHold(documentId: string): Promise<boolean> {
  const { data } = await supabase.from("documents").select("legal_hold").eq("id", documentId).maybeSingle();
  return !!(data?.legal_hold);
}

/** Place a legal hold on a document (or every document in a folder/library). A
 *  held record can't be deleted or disposed until released. */
export async function placeLegalHold(input: {
  scope: Level; id: string; orgId: string; matter: string; reason?: string; actorId?: string | null; actorName?: string | null;
}): Promise<number> {
  const nowIso = new Date().toISOString();
  const patch = { legal_hold: true, legal_hold_matter: input.matter, legal_hold_reason: input.reason ?? null, legal_hold_by: input.actorId ?? null, legal_hold_at: nowIso };
  const ids = await scopeDocumentIds(input.scope, input.id);
  for (let i = 0; i < ids.length; i += 50) {
    await supabase.from("documents").update(patch).in("id", ids.slice(i, i + 50));
  }
  await logEvent(input.orgId, { scopeType: input.scope, scopeId: input.id, documentId: input.scope === "document" ? input.id : null, action: "hold_placed", matter: input.matter, reason: input.reason, actorId: input.actorId, actorName: input.actorName });
  await notifyHold(input.orgId, ids, "legal_hold_placed", input.matter, input.actorId, input.actorName);
  return ids.length;
}

export async function releaseLegalHold(input: {
  scope: Level; id: string; orgId: string; reason?: string; actorId?: string | null; actorName?: string | null;
}): Promise<number> {
  const patch = { legal_hold: false, legal_hold_matter: null, legal_hold_reason: null, legal_hold_by: null, legal_hold_at: null };
  const ids = await scopeDocumentIds(input.scope, input.id);
  for (let i = 0; i < ids.length; i += 50) {
    await supabase.from("documents").update(patch).in("id", ids.slice(i, i + 50));
  }
  await logEvent(input.orgId, { scopeType: input.scope, scopeId: input.id, documentId: input.scope === "document" ? input.id : null, action: "hold_released", reason: input.reason, actorId: input.actorId, actorName: input.actorName });
  await notifyHold(input.orgId, ids, "legal_hold_released", input.reason ?? "", input.actorId, input.actorName);
  return ids.length;
}

// ── Disposition ──────────────────────────────────────────────────────────────

/** Dispose an eligible record — archive it and mark it disposed (never a hard
 *  delete here; the audit trail is preserved). Blocked while on legal hold. */
export async function disposeDocument(input: {
  documentId: string; orgId: string; action?: "archive" | "destroy"; reason?: string; actorId?: string | null; actorName?: string | null;
}): Promise<{ ok: boolean; reason?: string }> {
  if (await isLegalHold(input.documentId)) return { ok: false, reason: "legal_hold" };
  const nowIso = new Date().toISOString();
  await supabase.from("documents").update({ disposition_state: "disposed", disposed_at: nowIso, status: "Archived", updated_at: nowIso }).eq("id", input.documentId);
  await logEvent(input.orgId, { scopeType: "document", scopeId: input.documentId, documentId: input.documentId, action: "disposed", reason: input.reason, detail: { action: input.action ?? "archive" }, actorId: input.actorId, actorName: input.actorName });
  return { ok: true };
}

// ── Daily scan: flag newly-eligible records ──────────────────────────────────

export async function scanRetention(orgId: string): Promise<number> {
  const { data } = await supabase.from("documents")
    .select("id, library_id, collection_id, document_number, title, name, retention_until, retention_policy, owner_user_id, owner_name")
    .eq("org_id", orgId)
    .eq("legal_hold", false)
    .neq("disposition_state", "disposed")
    .not("retention_until", "is", null)
    .lte("retention_until", todayISO())
    .is("retention_notified_at", null);
  const docs = (data ?? []) as Array<Record<string, unknown>>;
  if (!docs.length) return 0;

  const controllers = await getOrgControllers(orgId);
  let n = 0;
  for (const d of docs) {
    const docId = d.id as string;
    await supabase.from("documents").update({ disposition_state: "eligible", retention_notified_at: new Date().toISOString() }).eq("id", docId);
    const label = (d.document_number as string) || (d.title as string) || (d.name as string) || "Document";
    const link = `/documents/${d.library_id as string}?doc=${docId}`;
    const owner = await effectiveOwnerForDocument({
      ownerUserId: (d.owner_user_id as string | null) ?? null, ownerName: (d.owner_name as string | null) ?? null,
      collectionId: (d.collection_id as string | null) ?? null, libraryId: d.library_id as string,
    });
    const targets = uniq([...(owner.userId ? [owner.userId] : []), ...controllers]);
    await Promise.all(targets.map((uid) =>
      notify({ orgId, userId: uid, kind: "retention_eligible", title: `Retention reached: ${label}`, body: `This record has passed its retention date (${(d.retention_until as string).slice(0, 10)}) and is eligible for disposition review.`, link, resourceType: "document", resourceId: docId })
    ));
    n++;
  }
  return n;
}

// ── internals ────────────────────────────────────────────────────────────────

async function scopeDocumentIds(scope: Level, id: string): Promise<string[]> {
  if (scope === "document") return [id];
  const col = scope === "library" ? "library_id" : "collection_id";
  const { data } = await supabase.from("documents").select("id").eq(col, id);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => r.id as string);
}

async function notifyHold(orgId: string, docIds: string[], kind: "legal_hold_placed" | "legal_hold_released", matter: string, actorId?: string | null, actorName?: string | null): Promise<void> {
  // Notify controllers once (a bulk hold shouldn't spam per-doc). Owners of the
  // specific docs are told too, deduped.
  const controllers = await getOrgControllers(orgId);
  const sample = docIds.slice(0, 200);
  const { data: owners } = sample.length
    ? await supabase.from("documents").select("owner_user_id").in("id", sample).not("owner_user_id", "is", null)
    : { data: [] as Array<Record<string, unknown>> };
  const ownerIds = ((owners ?? []) as Array<Record<string, unknown>>).map((o) => o.owner_user_id as string);
  const targets = uniq([...controllers, ...ownerIds]).filter((u) => u !== actorId);
  const verb = kind === "legal_hold_placed" ? "placed" : "released";
  await Promise.all(targets.map((uid) =>
    notify({
      orgId, userId: uid, kind,
      title: `Legal hold ${verb}${matter ? `: ${matter}` : ""}`,
      body: `A legal hold was ${verb} on ${docIds.length} record${docIds.length === 1 ? "" : "s"}.${verb === "placed" ? " Held records can't be deleted or disposed." : ""}`,
      actorUserId: actorId ?? undefined, actorName: actorName ?? undefined,
    })
  ));
}

async function logEvent(orgId: string, e: {
  scopeType: Level; scopeId: string; documentId: string | null; action: string;
  matter?: string; reason?: string; detail?: unknown; actorId?: string | null; actorName?: string | null;
}): Promise<void> {
  await supabase.from("document_disposition_events").insert({
    org_id: orgId, document_id: e.documentId, scope_type: e.scopeType, scope_id: e.scopeId,
    action: e.action, matter: e.matter ?? null, reason: e.reason ?? null, detail: e.detail ?? null,
    performed_by: e.actorId ?? null, performed_by_name: e.actorName ?? null,
  });
  await logAuditAction({
    action: `RETENTION_${e.action.toUpperCase()}`, resourceType: e.scopeType, resourceId: e.scopeId,
    orgId, userId: e.actorId ?? "", details: { matter: e.matter, reason: e.reason },
  }).catch(() => {});
}
