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
import { effectiveOwnerForDocument, getOrgControllers, isEffectiveOwnerOfDocument } from "@/lib/ownership";
import { resolveActorPrincipal } from "@/lib/principal";
import { isControllerPrincipal } from "@/lib/permissions";
import { resolveCanControlLibrary } from "@/lib/documentGuards";
import { readActiveHolds, decideHoldGate, HoldBlockedError } from "@/lib/holdGate";
import {
  resolveEffectiveRetentionPolicy, computeRetentionUntil, disposeActionFor, scheduledActionLabel,
} from "@/lib/retentionPolicy";
import type { RetentionPolicy } from "@/types/schema";

// The pure resolution/date logic lives in lib/retentionPolicy.ts so server
// routes (which must not import the browser client) share it; re-exported
// here to keep every existing import site working.
export {
  resolveEffectiveRetentionPolicy, computeRetentionUntil,
  scheduledActionFor, scheduledActionLabel, disposeActionFor, describeRetentionPolicy,
  retentionStatusFor,
} from "@/lib/retentionPolicy";
export type { RetentionStatus } from "@/lib/retentionPolicy";

type Level = "library" | "collection" | "document";
interface PolicyCols { retention_policy?: RetentionPolicy | null }
const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)));
const todayISO = () => new Date().toISOString().slice(0, 10);

export async function effectiveRetentionPolicyForDocument(doc: {
  retentionPolicy?: RetentionPolicy | null; collectionId?: string | null; libraryId: string;
}): Promise<RetentionPolicy | null> {
  // RET-11: the reads are CHECKED — a failed folder or library read must not
  // quietly resolve to the document's own (usually null) policy and name the
  // wrong scheduled action.
  let folder: RetentionPolicy | null = null;
  if (doc.collectionId) {
    const { data, error } = await supabase.from("collections").select("retention_policy").eq("id", doc.collectionId).maybeSingle();
    if (error) throw new Error(`Could not read the folder's retention policy: ${error.message}`);
    folder = (data as PolicyCols)?.retention_policy ?? null;
  }
  const { data: lib, error: libErr } = await supabase.from("libraries").select("retention_policy").eq("id", doc.libraryId).maybeSingle();
  if (libErr) throw new Error(`Could not read the library's retention policy: ${libErr.message}`);
  return resolveEffectiveRetentionPolicy(doc.retentionPolicy ?? null, folder, (lib as PolicyCols)?.retention_policy ?? null);
}

// ── Recompute denormalized state ─────────────────────────────────────────────

interface DocForRetention {
  id: string; retention_policy: RetentionPolicy | null; collection_id: string | null; library_id: string;
  created_at: string | null; updated_at: string | null; effective_date: string | null;
  disposition_state: string | null;
}

/** Recompute a document's retention_until + disposition_state from its effective
 *  policy and basis date. A disposed record is left as-is. RET-5: both writes
 *  are CHECKED — a refused re-clock throws instead of leaving a stale deadline
 *  that reads as current. */
export async function recomputeRetention(documentId: string): Promise<void> {
  const { data, error: readErr } = await supabase.from("documents")
    .select("id, retention_policy, collection_id, library_id, created_at, updated_at, effective_date, disposition_state")
    .eq("id", documentId).maybeSingle();
  if (readErr) throw new Error(`Couldn't read the record to re-clock its retention: ${readErr.message}`);
  if (!data) return;
  const doc = data as unknown as DocForRetention;
  if (doc.disposition_state === "disposed") return;

  const policy = await effectiveRetentionPolicyForDocument({
    retentionPolicy: doc.retention_policy, collectionId: doc.collection_id, libraryId: doc.library_id,
  });
  if (!policy) {
    const { error } = await supabase.from("documents").update({ retention_until: null, disposition_state: null }).eq("id", doc.id);
    if (error) throw new Error(`Retention clock was NOT cleared: ${error.message}`);
    return;
  }
  const basis = policy.basis ?? "created";
  const basisISO =
    basis === "created" ? doc.created_at
    : basis === "effective" ? (doc.effective_date || doc.updated_at || doc.created_at)
    : /* issued | superseded */ (doc.updated_at || doc.created_at);
  const until = computeRetentionUntil(basisISO, policy);
  const state = until && until <= todayISO() ? "eligible" : "active";
  const { error } = await supabase.from("documents").update({ retention_until: until, disposition_state: state }).eq("id", doc.id);
  if (error) throw new Error(`Retention clock was NOT updated: ${error.message}`);
}

/** Set (or clear) the retention policy at a level, then recompute the covered
 *  documents so the state is immediately correct. */
export async function setRetentionPolicy(input: {
  level: Level; id: string; orgId: string; policy: RetentionPolicy | null; actorId?: string | null; actorName?: string | null;
}): Promise<void> {
  const table = input.level === "library" ? "libraries" : input.level === "collection" ? "collections" : "documents";
  if (input.level === "document") {
    await assertRetentionAuthority({ orgId: input.orgId, actorId: input.actorId, documentId: input.id });
  } else if (input.level === "library") {
    await assertRetentionAuthority({ orgId: input.orgId, actorId: input.actorId, libraryId: input.id });
  }
  // (folder-level policy writes are controller-only at the database.)
  // OWN-14: checked write — a refused policy save must not be logged as set.
  const { data: polRows, error: polErr } = await supabase
    .from(table)
    .update({ retention_policy: input.policy })
    .eq("id", input.id)
    .select("id");
  if (polErr) throw new Error(polErr.message);
  if (!polRows || polRows.length === 0) {
    throw new Error(`Retention policy was NOT saved — you don't have authority over this ${input.level}.`);
  }
  await logEvent(input.orgId, { scopeType: input.level, scopeId: input.id, documentId: input.level === "document" ? input.id : null, action: "retention_set", detail: input.policy ?? undefined, actorId: input.actorId, actorName: input.actorName });

  if (input.level === "document") { await recomputeRetention(input.id); return; }
  const col = input.level === "library" ? "library_id" : "collection_id";
  const { data } = await supabase.from("documents").select("id").eq(col, input.id);
  const ids = ((data ?? []) as Array<Record<string, unknown>>).map((r) => r.id as string);
  for (let i = 0; i < ids.length; i += 25) {
    await Promise.all(ids.slice(i, i + 25).map((id) => recomputeRetention(id)));
  }
}

// ── Authority (SURF-3) ───────────────────────────────────────────────────────
// Mirrors trg_document_retention_guard: legal hold is a CONTROLLER decision
// (spoliation liability); retention settings and disposition belong to a
// controller, the document's effective owner, or a publisher of its library.
// The database enforces the same rule for a direct PATCH; this gives the app
// a clear refusal before it writes anything.

async function assertLegalHoldAuthority(orgId: string, actorId: string | null | undefined, verb: string): Promise<void> {
  if (!actorId) throw new Error(`Legal hold can only be ${verb} by an Admin or Document Controller.`);
  const p = await resolveActorPrincipal({ uid: actorId, orgId });
  if (!isControllerPrincipal(p)) {
    throw new Error(`Legal hold can only be ${verb} by an Admin or Document Controller.`);
  }
}

async function assertRetentionAuthority(input: { orgId: string; actorId?: string | null; documentId?: string | null; libraryId?: string | null }): Promise<void> {
  if (!input.actorId) throw new Error("Retention settings can only be changed by a controller, the document's owner, or a publisher of its library.");
  const p = await resolveActorPrincipal({ uid: input.actorId, orgId: input.orgId });
  if (isControllerPrincipal(p)) return;
  if (input.documentId && await isEffectiveOwnerOfDocument(input.documentId, input.actorId)) return;
  if (input.libraryId && await resolveCanControlLibrary(input.libraryId, p)) return;
  throw new Error("Retention settings can only be changed by a controller, the document's owner, or a publisher of its library.");
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
  await assertLegalHoldAuthority(input.orgId, input.actorId, "placed");
  const nowIso = new Date().toISOString();
  const patch = { legal_hold: true, legal_hold_matter: input.matter, legal_hold_reason: input.reason ?? null, legal_hold_by: input.actorId ?? null, legal_hold_at: nowIso };
  const ids = await scopeDocumentIds(input.scope, input.id);
  // OWN-14: every batch is CHECKED, and the count returned is what actually
  // held. The old form returned ids.length and notified regardless — a
  // refused write produced a "N documents held" toast, a hold_placed log
  // row, and zero actual protection.
  let held = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const { data, error } = await supabase.from("documents").update(patch).in("id", batch).select("id");
    if (error) throw new Error(`Legal hold failed after ${held} of ${ids.length} documents: ${error.message}`);
    held += data?.length ?? 0;
  }
  if (held < ids.length) {
    throw new Error(`Legal hold was only applied to ${held} of ${ids.length} documents — the rest were refused. Nothing has been logged as held; verify authority and retry.`);
  }
  await logEvent(input.orgId, { scopeType: input.scope, scopeId: input.id, documentId: input.scope === "document" ? input.id : null, action: "hold_placed", matter: input.matter, reason: input.reason, actorId: input.actorId, actorName: input.actorName });
  await notifyHold(input.orgId, ids, "legal_hold_placed", input.matter, input.actorId, input.actorName);
  return held;
}

export async function releaseLegalHold(input: {
  scope: Level; id: string; orgId: string; reason?: string; actorId?: string | null; actorName?: string | null;
}): Promise<number> {
  await assertLegalHoldAuthority(input.orgId, input.actorId, "released");
  const patch = { legal_hold: false, legal_hold_matter: null, legal_hold_reason: null, legal_hold_by: null, legal_hold_at: null };
  const ids = await scopeDocumentIds(input.scope, input.id);
  // OWN-14: checked, with the real released count (see placeLegalHold).
  let released = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const { data, error } = await supabase.from("documents").update(patch).in("id", batch).select("id");
    if (error) throw new Error(`Hold release failed after ${released} of ${ids.length} documents: ${error.message}`);
    released += data?.length ?? 0;
  }
  if (released < ids.length) {
    throw new Error(`The hold was only released on ${released} of ${ids.length} documents — the rest were refused. Nothing has been logged as released; verify authority and retry.`);
  }
  await logEvent(input.orgId, { scopeType: input.scope, scopeId: input.id, documentId: input.scope === "document" ? input.id : null, action: "hold_released", reason: input.reason, actorId: input.actorId, actorName: input.actorName });
  await notifyHold(input.orgId, ids, "legal_hold_released", input.reason ?? "", input.actorId, input.actorName);
  return released;
}

// ── Disposition ──────────────────────────────────────────────────────────────

/** Dispose an eligible record — archive it and mark it disposed (never a hard
 *  delete here; the audit trail is preserved). Blocked while on legal hold,
 *  and (HLD-1) while an operational hold is open on the document. */
export async function disposeDocument(input: {
  documentId: string; orgId: string; action?: "archive" | "destroy"; reason?: string; actorId?: string | null; actorName?: string | null;
}): Promise<{ ok: boolean; reason?: string; action?: "archive" | "destroy" }> {
  if (await isLegalHold(input.documentId)) return { ok: false, reason: "legal_hold" };
  await assertRetentionAuthority({ orgId: input.orgId, actorId: input.actorId, documentId: input.documentId });
  // HLD-1 (dispose gate): a hold is a stop-work signal — "this document can't
  // be advanced until X is cleared" — and disposal is the most final advance
  // there is. An open document_holds row refuses here for EVERYONE (release
  // the hold first; the hold queue shows who placed it and why), and the
  // retention guard (20261077) refuses the same write at the database for
  // non-controllers. The hold read fails CLOSED: it throws, disposal waits.
  // Through lib/holdGate.ts — THE one hold gate (HLD-1; document-control
  // Round F wave 3, P14): one read, one decision. A known hold is the
  // dispose gate's own answer (`active_hold`, as P9 shipped it, which the
  // panel turns into "release the hold first"); an unreadable hold set
  // throws the gate's HoldBlockedError (fail closed).
  const holdGate = decideHoldGate(await readActiveHolds(input.documentId), "disposing it");
  if (holdGate.blocked) {
    if (holdGate.unreadable) throw new HoldBlockedError(holdGate);
    return { ok: false, reason: "active_hold" };
  }
  // RET-11: the action recorded is the schedule's, not a hard-coded "archive",
  // unless the caller names one explicitly.
  let action: "archive" | "destroy" = input.action ?? "archive";
  if (!input.action) {
    // Checked: a failed read must not record 'archive' for a destroy schedule.
    const { data: row, error: rowErr } = await supabase.from("documents").select("retention_policy, collection_id, library_id").eq("id", input.documentId).maybeSingle();
    if (rowErr) throw new Error(`Could not read the record's retention schedule; nothing was disposed: ${rowErr.message}`);
    if (row) {
      const policy = await effectiveRetentionPolicyForDocument({
        retentionPolicy: (row.retention_policy as RetentionPolicy | null) ?? null,
        collectionId: (row.collection_id as string | null) ?? null, libraryId: row.library_id as string,
      });
      action = disposeActionFor(policy);
    }
  }
  const nowIso = new Date().toISOString();
  // Checked write: the DB guard refuses disposition under a hold placed
  // between the read above and this write (the TOCTOU the app check alone
  // could not close) — a refusal must not be logged as disposed.
  const { data: disposed, error: dispErr } = await supabase.from("documents")
    .update({ disposition_state: "disposed", disposed_at: nowIso, status: "Archived", updated_at: nowIso })
    .eq("id", input.documentId).select("id");
  if (dispErr) throw new Error(dispErr.message);
  if (!disposed || disposed.length === 0) return { ok: false, reason: "refused" };
  await logEvent(input.orgId, { scopeType: "document", scopeId: input.documentId, documentId: input.documentId, action: "disposed", reason: input.reason, detail: { action }, actorId: input.actorId, actorName: input.actorName });
  return { ok: true, action };
}

// ── Daily scan: flag newly-eligible records ──────────────────────────────────

export async function scanRetention(orgId: string, opts?: { renudgeDays?: number }): Promise<number> {
  // Re-nudge cadence: an eligible record that was flagged once and then
  // ignored comes back every `renudgeDays` — a dismissed bell must not bury
  // a disposition obligation forever. (`.not("legal_hold","is",true)` rather
  // than `.eq(...,false)` so pre-migration NULL rows are still scanned.)
  const renudgeDays = opts?.renudgeDays ?? 30;
  const renudgeCutoff = new Date(Date.now() - renudgeDays * 86_400_000).toISOString();
  const { data, error: scanErr } = await supabase.from("documents")
    .select("id, library_id, collection_id, document_number, title, name, retention_until, retention_policy, owner_user_id, owner_name")
    .eq("org_id", orgId)
    .not("legal_hold", "is", true)
    .neq("disposition_state", "disposed")
    .not("retention_until", "is", null)
    .lte("retention_until", todayISO())
    .or(`retention_notified_at.is.null,retention_notified_at.lt.${renudgeCutoff}`);
  if (scanErr) throw new Error(`Retention scan could not read the records: ${scanErr.message}`);
  const docs = (data ?? []) as Array<Record<string, unknown>>;
  if (!docs.length) return 0;

  // RET-11: resolve each record's EFFECTIVE policy (document > folder >
  // library) once per org so the notice can name the scheduled action.
  // CHECKED: with an empty map every notice would read "flag for review" —
  // the wrong instruction for a "then destroy" schedule — so a failed read
  // aborts the scan before any record is flagged (the cron records it per org).
  const [controllers, { data: libRows, error: libErr }, { data: colRows, error: colErr }] = await Promise.all([
    getOrgControllers(orgId),
    supabase.from("libraries").select("id, retention_policy").eq("org_id", orgId),
    supabase.from("collections").select("id, retention_policy").eq("org_id", orgId),
  ]);
  if (libErr || colErr) {
    throw new Error(`Retention scan could not read the policy chain: ${libErr ? `libraries: ${libErr.message}` : ""}${libErr && colErr ? "; " : ""}${colErr ? `collections: ${colErr.message}` : ""}`);
  }
  const libPol = new Map(((libRows ?? []) as Array<{ id: string; retention_policy: RetentionPolicy | null }>).map((l) => [l.id, l.retention_policy ?? null]));
  const colPol = new Map(((colRows ?? []) as Array<{ id: string; retention_policy: RetentionPolicy | null }>).map((c) => [c.id, c.retention_policy ?? null]));
  let n = 0;
  const failures: string[] = [];
  for (const d of docs) {
    const docId = d.id as string;
    // RET-5: a refused flag write must not be notified as "eligible" — the
    // record would read as pending review while the row still says nothing.
    const { error: flagErr } = await supabase.from("documents").update({ disposition_state: "eligible", retention_notified_at: new Date().toISOString() }).eq("id", docId);
    if (flagErr) { failures.push(`${docId}: ${flagErr.message}`); continue; }
    const policy = resolveEffectiveRetentionPolicy(
      (d.retention_policy as RetentionPolicy | null) ?? null,
      d.collection_id ? colPol.get(d.collection_id as string) ?? null : null,
      libPol.get(d.library_id as string) ?? null,
    );
    const scheduled = scheduledActionLabel(policy);
    const label = (d.document_number as string) || (d.title as string) || (d.name as string) || "Document";
    const link = `/documents/${d.library_id as string}?doc=${docId}`;
    const owner = await effectiveOwnerForDocument({
      ownerUserId: (d.owner_user_id as string | null) ?? null, ownerName: (d.owner_name as string | null) ?? null,
      collectionId: (d.collection_id as string | null) ?? null, libraryId: d.library_id as string,
    });
    const targets = uniq([...(owner.userId ? [owner.userId] : []), ...controllers]);
    await Promise.all(targets.map((uid) =>
      notify({
        orgId, userId: uid, kind: "retention_eligible",
        title: `Retention reached: ${label} — scheduled to ${scheduled}`,
        body: `This record has passed its retention date (${(d.retention_until as string).slice(0, 10)}). Its retention schedule calls for: ${scheduled}. Disposition is an explicit, logged controller action — nothing happens automatically.`,
        link, resourceType: "document", resourceId: docId,
      })
    ));
    n++;
  }
  if (failures.length) {
    throw new Error(`Retention scan flagged ${n} record(s) but ${failures.length} flag write(s) were refused — ${failures[0]}`);
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

/** The records-management trail. RET-5 / DRLS-4: the insert is CHECKED — a
 *  refused event write (the append-only, authority-gated policies of 20261043
 *  refuse it for a caller without hold/retention authority) surfaces to the
 *  caller instead of reading as a logged act. */
async function logEvent(orgId: string, e: {
  scopeType: Level; scopeId: string; documentId: string | null; action: string;
  matter?: string; reason?: string; detail?: unknown; actorId?: string | null; actorName?: string | null;
}): Promise<void> {
  const { error } = await supabase.from("document_disposition_events").insert({
    org_id: orgId, document_id: e.documentId, scope_type: e.scopeType, scope_id: e.scopeId,
    action: e.action, matter: e.matter ?? null, reason: e.reason ?? null, detail: e.detail ?? null,
    performed_by: e.actorId ?? null, performed_by_name: e.actorName ?? null,
  });
  if (error) {
    throw new Error(`The ${e.action.replace(/_/g, " ")} was applied but its records-management event could NOT be written (${error.message}). The trail is incomplete — report this.`);
  }
  await logAuditAction({
    action: `RETENTION_${e.action.toUpperCase()}`, resourceType: e.scopeType, resourceId: e.scopeId,
    orgId, userId: e.actorId ?? "", details: { matter: e.matter, reason: e.reason },
  }).catch(() => {});
}
