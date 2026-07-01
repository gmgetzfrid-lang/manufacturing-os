// lib/acknowledgments.ts
//
// Read-&-understood (training acknowledgment). When a controlled document is
// ISSUED under an acknowledgment policy, the people who do that work must each
// attest "I have read and understood Rev N" — tracked per person, per revision
// in `document_acknowledgments`. This is the proof-of-training an OSHA PSM /
// ISO 9001 audit asks for.
//
// Robustness rule (by request): the roster is the SOURCE OF TRUTH. The pill, the
// optional list column, the inbox queue, and the daily scan all read from it;
// completion is ALWAYS computed (signed vs required), never cached to drift. And
// there are NO silent failures — an empty/unsatisfiable roster is flagged to the
// owner + Admin/DocCtrl instead of quietly counting as "done".

import { supabase } from "@/lib/supabase";
import { notify } from "@/lib/inAppNotifications";
import { logAuditAction } from "@/lib/audit";
import { recordSignature } from "@/lib/eSignatures";
import { resolveEffectiveOwner, effectiveOwnerForDocument, getOrgControllers } from "@/lib/ownership";
import type { AckPolicy } from "@/types/schema";

type Level = "library" | "collection" | "document";
interface PolicyCols { ack_policy?: AckPolicy | null }

const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)));

// ── Pure policy resolution (mirrors resolveEffectivePolicy in reviewCycles) ───

/** Most specific DEFINED level wins (document > folder > library). An explicit
 *  enabled:false at any level means "no acknowledgment required". */
export function resolveEffectiveAckPolicy(
  docPolicy?: AckPolicy | null, folderPolicy?: AckPolicy | null, libraryPolicy?: AckPolicy | null,
): AckPolicy | null {
  for (const p of [docPolicy, folderPolicy, libraryPolicy]) {
    if (p) return p.enabled ? p : null;
  }
  return null;
}

export async function effectiveAckPolicyForDocument(doc: {
  ackPolicy?: AckPolicy | null; collectionId?: string | null; libraryId: string;
}): Promise<AckPolicy | null> {
  let folder: AckPolicy | null = null;
  if (doc.collectionId) {
    const { data } = await supabase.from("collections").select("ack_policy").eq("id", doc.collectionId).maybeSingle();
    folder = (data as PolicyCols)?.ack_policy ?? null;
  }
  const { data: lib } = await supabase.from("libraries").select("ack_policy").eq("id", doc.libraryId).maybeSingle();
  return resolveEffectiveAckPolicy(doc.ackPolicy ?? null, folder, (lib as PolicyCols)?.ack_policy ?? null);
}

// ── Assignee expansion (named people + role members) ─────────────────────────

export interface AckAssignee { uid: string; name: string | null; role: string | null; source: "person" | "role" }

/** Resolve a policy to concrete people. Named individuals + every active member
 *  of each named role. `warnings` surfaces gaps (a role with no members, a
 *  person who's left) so the caller can flag them rather than silently drop. */
export async function expandAssignees(orgId: string, policy: AckPolicy): Promise<{ assignees: AckAssignee[]; warnings: string[] }> {
  const warnings: string[] = [];
  const byUid = new Map<string, AckAssignee>();

  const ids = uniq(policy.assigneeIds ?? []);
  if (ids.length) {
    const { data } = await supabase.from("org_members").select("uid, display_name, email, status").eq("org_id", orgId).in("uid", ids);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const found = new Set(rows.map((r) => r.uid as string));
    for (const r of rows) {
      const name = (r.display_name as string) || (r.email as string) || null;
      if (r.status !== "active") { warnings.push(`${name || r.uid} is not an active member`); continue; }
      byUid.set(r.uid as string, { uid: r.uid as string, name, role: null, source: "person" });
    }
    for (const id of ids) if (!found.has(id)) warnings.push(`An assigned person is no longer in the organization`);
  }

  const roles = uniq(policy.assigneeRoles ?? []);
  if (roles.length) {
    const { data } = await supabase.from("org_members").select("uid, display_name, email, role").eq("org_id", orgId).eq("status", "active").in("role", roles);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const covered = new Set(rows.map((r) => r.role as string));
    for (const r of rows) {
      const uidv = r.uid as string;
      if (!byUid.has(uidv)) byUid.set(uidv, { uid: uidv, name: (r.display_name as string) || (r.email as string) || null, role: r.role as string, source: "role" });
    }
    for (const role of roles) if (!covered.has(role)) warnings.push(`Role "${role}" has no active members`);
  }

  return { assignees: Array.from(byUid.values()), warnings };
}

// ── Completion summaries (drift-free — always computed from rows) ─────────────

export type AckStatus = "none" | "complete" | "partial" | "overdue" | "blocked";

export interface AckSummary {
  required: number;   // people who must sign = pending + acknowledged (waived excused)
  done: number;       // acknowledged
  pending: number;    // still outstanding
  waived: number;
  hardGate: boolean;  // an issued rev is "pending acknowledgment" until complete
  oldestPendingAt: string | null;
}

const GRACE_DAYS = 14;

/** Build a per-document completion summary for the active roster (the current
 *  rev's rows). One grouped query for the whole page — cheap and drift-free. */
export async function getAckSummaries(orgId: string, documentIds: string[]): Promise<Map<string, AckSummary>> {
  const map = new Map<string, AckSummary>();
  const ids = uniq(documentIds);
  if (!ids.length) return map;
  const { data } = await supabase
    .from("document_acknowledgments")
    .select("document_id, status, assigned_at")
    .eq("org_id", orgId)
    .in("document_id", ids)
    .in("status", ["pending", "acknowledged", "waived"]);
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const did = r.document_id as string;
    const s = map.get(did) ?? { required: 0, done: 0, pending: 0, waived: 0, hardGate: false, oldestPendingAt: null };
    const st = r.status as string;
    if (st === "acknowledged") { s.done++; s.required++; }
    else if (st === "waived") { s.waived++; }
    else {
      s.pending++; s.required++;
      const at = r.assigned_at as string;
      if (at && (!s.oldestPendingAt || at < s.oldestPendingAt)) s.oldestPendingAt = at;
    }
    map.set(did, s);
  }
  // hardGate is a policy flag — fold it in for the docs that have a roster.
  if (map.size) {
    const rosterDocIds = Array.from(map.keys());
    const { data: docs } = await supabase.from("documents").select("id, ack_policy, collection_id, library_id").in("id", rosterDocIds);
    for (const d of (docs ?? []) as Array<Record<string, unknown>>) {
      const s = map.get(d.id as string);
      if (!s) continue;
      // Cheap approximation for the pill: honor a doc-level hardGate directly.
      const p = (d.ack_policy as AckPolicy | null) ?? null;
      if (p?.enabled && p.hardGate) s.hardGate = true;
    }
  }
  return map;
}

/** Pill status from a summary. `none` when there is no roster at all. */
export function ackStatusFor(summary: AckSummary | null | undefined, graceDays = GRACE_DAYS): AckStatus {
  if (!summary || summary.required === 0) return "none";
  if (summary.pending === 0) return "complete";
  if (summary.oldestPendingAt) {
    const days = Math.floor((Date.now() - new Date(summary.oldestPendingAt).getTime()) / 86_400_000);
    if (days > graceDays) return "overdue";
  }
  return summary.hardGate ? "blocked" : "partial";
}

// ── Roster reads ─────────────────────────────────────────────────────────────

export interface AckRosterRow {
  id: string; documentVersionId: string | null; revisionLabel: string | null;
  assigneeUserId: string; assigneeName: string | null; assigneeRole: string | null; source: string;
  status: "pending" | "acknowledged" | "waived" | "void";
  signatureId: string | null; acknowledgedAt: string | null;
  waivedReason: string | null; assignedAt: string;
}

function rowToRoster(r: Record<string, unknown>): AckRosterRow {
  return {
    id: r.id as string,
    documentVersionId: (r.document_version_id as string) ?? null,
    revisionLabel: (r.revision_label as string) ?? null,
    assigneeUserId: r.assignee_user_id as string,
    assigneeName: (r.assignee_name as string) ?? null,
    assigneeRole: (r.assignee_role as string) ?? null,
    source: (r.source as string) ?? "person",
    status: r.status as AckRosterRow["status"],
    signatureId: (r.signature_id as string) ?? null,
    acknowledgedAt: (r.acknowledged_at as string) ?? null,
    waivedReason: (r.waived_reason as string) ?? null,
    assignedAt: r.assigned_at as string,
  };
}

/** The active roster for a document — pending/acknowledged/waived rows, newest
 *  revision first. Pass a versionId to scope to one revision. */
export async function listRoster(documentId: string, versionId?: string | null): Promise<AckRosterRow[]> {
  let q = supabase.from("document_acknowledgments").select("*").eq("document_id", documentId).in("status", ["pending", "acknowledged", "waived"]);
  if (versionId) q = q.eq("document_version_id", versionId);
  const { data } = await q.order("status", { ascending: true }).order("assignee_name", { ascending: true });
  return ((data ?? []) as Array<Record<string, unknown>>).map(rowToRoster);
}

export interface MyPendingAck { rosterId: string; documentId: string; libraryId: string; label: string; revisionLabel: string | null; assignedAt: string }

/** Everything the current user still owes an acknowledgment on — powers the
 *  inbox/attention "awaiting your acknowledgment" queue (column-independent). */
export async function listMyPendingAcks(orgId: string, uid: string): Promise<MyPendingAck[]> {
  if (!uid) return [];
  const { data } = await supabase
    .from("document_acknowledgments")
    .select("id, document_id, revision_label, assigned_at")
    .eq("org_id", orgId).eq("assignee_user_id", uid).eq("status", "pending")
    .order("assigned_at", { ascending: true });
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (!rows.length) return [];
  const docIds = uniq(rows.map((r) => r.document_id as string));
  const { data: docs } = await supabase.from("documents").select("id, library_id, document_number, title, name").in("id", docIds);
  const dm = new Map((docs ?? []).map((d) => [(d as Record<string, unknown>).id as string, d as Record<string, unknown>]));
  return rows.map((r) => {
    const d = dm.get(r.document_id as string);
    return {
      rosterId: r.id as string,
      documentId: r.document_id as string,
      libraryId: (d?.library_id as string) ?? "",
      label: (d?.document_number as string) || (d?.title as string) || (d?.name as string) || "Document",
      revisionLabel: (r.revision_label as string) ?? null,
      assignedAt: r.assigned_at as string,
    };
  });
}

// ── Roster maintenance: open / refresh / void ────────────────────────────────

async function loadCurrentVersion(documentId: string, versionId: string | null): Promise<{ revLabel: string | null; hash: string | null }> {
  if (!versionId) return { revLabel: null, hash: null };
  const { data } = await supabase.from("document_versions").select("revision_label, file_hash").eq("id", versionId).maybeSingle();
  return { revLabel: (data?.revision_label as string) ?? null, hash: (data?.file_hash as string) ?? null };
}

interface DocForAck {
  id: string; org_id: string; library_id: string; collection_id: string | null;
  status: string | null; current_version_id: string | null;
  document_number: string | null; title: string | null; name: string | null;
  ack_policy: AckPolicy | null; owner_user_id: string | null; owner_name: string | null;
}

/** Recompute a single document's roster against its EFFECTIVE policy + current
 *  revision. Stale-rev pending rows are voided; when the doc is Issued under an
 *  enabled policy, missing assignees are added (and notified). Gaps are flagged
 *  to the owner + Admin/DocCtrl — never silently dropped. Safe to call on issue,
 *  on policy change, and idempotently thereafter. */
export async function recomputeDocumentAck(input: {
  orgId: string; documentId: string; actorId?: string | null; actorName?: string | null; notifyNew?: boolean;
}): Promise<void> {
  const { data: docRow } = await supabase
    .from("documents")
    .select("id, org_id, library_id, collection_id, status, current_version_id, document_number, title, name, ack_policy, owner_user_id, owner_name")
    .eq("id", input.documentId).maybeSingle();
  if (!docRow) return;
  const doc = docRow as unknown as DocForAck;
  const versionId = doc.current_version_id;
  const nowIso = new Date().toISOString();

  // Always void still-pending rows that belong to an OLDER revision.
  if (versionId) {
    await supabase.from("document_acknowledgments")
      .update({ status: "void", updated_at: nowIso })
      .eq("document_id", doc.id).eq("status", "pending").not("document_version_id", "eq", versionId);
  }

  const policy = await effectiveAckPolicyForDocument({
    ackPolicy: doc.ack_policy, collectionId: doc.collection_id, libraryId: doc.library_id,
  });

  // No policy (or opted out) → void any remaining pending rows and stop.
  if (!policy || !policy.enabled) {
    await supabase.from("document_acknowledgments").update({ status: "void", updated_at: nowIso }).eq("document_id", doc.id).eq("status", "pending");
    return;
  }
  // Only Issued documents carry a live acknowledgment roster.
  if (doc.status !== "Issued" || !versionId) return;

  const { revLabel, hash } = await loadCurrentVersion(doc.id, versionId);
  const { assignees, warnings } = await expandAssignees(input.orgId, policy);
  const label = doc.document_number || doc.title || doc.name || "Document";
  const link = `/documents/${doc.library_id}?doc=${doc.id}`;

  // Which assignees are new for THIS revision? (don't re-notify existing rows)
  const { data: existing } = await supabase
    .from("document_acknowledgments").select("assignee_user_id")
    .eq("document_id", doc.id).eq("document_version_id", versionId).in("status", ["pending", "acknowledged", "waived"]);
  const have = new Set(((existing ?? []) as Array<Record<string, unknown>>).map((r) => r.assignee_user_id as string));
  const fresh = assignees.filter((a) => !have.has(a.uid));

  if (fresh.length) {
    await supabase.from("document_acknowledgments").upsert(
      fresh.map((a) => ({
        org_id: input.orgId, document_id: doc.id, document_version_id: versionId,
        revision_label: revLabel, content_hash: hash,
        assignee_user_id: a.uid, assignee_name: a.name, assignee_role: a.role, source: a.source,
        status: "pending", assigned_by: input.actorId ?? null, assigned_at: nowIso, notified_at: nowIso,
      })),
      { onConflict: "document_id,document_version_id,assignee_user_id", ignoreDuplicates: true },
    );
    if (input.notifyNew !== false) {
      await Promise.all(fresh.filter((a) => a.uid !== input.actorId).map((a) =>
        notify({
          orgId: input.orgId, userId: a.uid, kind: "ack_requested",
          title: `Please read & acknowledge: ${label}${revLabel ? ` Rev ${revLabel}` : ""}`,
          body: "Open the document and confirm you've read and understood this revision.",
          link, resourceType: "document", resourceId: doc.id,
          actorUserId: input.actorId ?? undefined, actorName: input.actorName ?? undefined,
        })
      ));
    }
    await logAuditAction({
      action: "ACK_REQUESTED", resourceType: "document", resourceId: doc.id,
      orgId: input.orgId, userId: input.actorId ?? "",
      details: { revision: revLabel, assignees: fresh.length, roles: policy.assigneeRoles ?? [], hardGate: !!policy.hardGate },
    }).catch(() => {});
  }

  // Contingency: an enabled policy that resolves to NOBODY, or has gaps, must not
  // pass silently — flag the owner + Admin/DocCtrl.
  if (assignees.length === 0 || warnings.length) {
    const owner = await effectiveOwnerForDocument({
      ownerUserId: doc.owner_user_id, ownerName: doc.owner_name, collectionId: doc.collection_id, libraryId: doc.library_id,
    });
    const controllers = await getOrgControllers(input.orgId);
    const targets = uniq([...(owner.userId ? [owner.userId] : []), ...controllers]);
    const msg = assignees.length === 0
      ? `An acknowledgment requirement is set on ${label}, but it resolved to no one — nobody will be asked to sign. Check the assigned people/roles.`
      : `The acknowledgment roster for ${label} has gaps: ${warnings.join("; ")}.`;
    await Promise.all(targets.map((uid) =>
      notify({ orgId: input.orgId, userId: uid, kind: "ack_unsatisfiable", title: `Acknowledgment needs attention: ${label}`, body: msg, link, resourceType: "document", resourceId: doc.id })
    ));
  }
}

/** Called from the publish paths when a rev is issued — opens/refreshes the
 *  read-&-understood roster for the new revision. Best-effort; never blocks
 *  publish. */
export async function onDocumentIssuedAck(input: {
  orgId: string; documentId: string; actorId?: string | null; actorName?: string | null;
}): Promise<void> {
  try {
    await recomputeDocumentAck({ orgId: input.orgId, documentId: input.documentId, actorId: input.actorId, actorName: input.actorName });
  } catch (e) { console.warn("[ack] onDocumentIssued failed", e); }
}

// ── Signing ──────────────────────────────────────────────────────────────────

/** Record a person's read-&-understood signature and mark their roster row done.
 *  The immutable proof is the e_signature; the roster row just points at it. */
export async function recordAcknowledgment(input: {
  orgId: string; documentId: string; documentVersionId?: string | null; revisionLabel?: string | null;
  contentHash?: string | null; rosterId?: string | null;
  signerUserId: string; signerName: string; signerRole?: string | null; signerEmail?: string | null;
  statement: string; signatureImage?: string | null;
}): Promise<void> {
  const sig = await recordSignature({
    orgId: input.orgId, resourceType: "document", resourceId: input.documentId,
    documentVersionId: input.documentVersionId ?? null, contentHash: input.contentHash ?? null,
    intent: "Acknowledged", statement: input.statement,
    signerUserId: input.signerUserId, signerName: input.signerName,
    signerRole: input.signerRole ?? undefined, signerEmail: input.signerEmail ?? undefined,
    signatureImage: input.signatureImage ?? undefined,
  });

  const nowIso = new Date().toISOString();
  const patch = { status: "acknowledged", signature_id: sig.id, acknowledged_at: nowIso, updated_at: nowIso };
  if (input.rosterId) {
    await supabase.from("document_acknowledgments").update(patch).eq("id", input.rosterId);
  } else {
    let q = supabase.from("document_acknowledgments").update(patch)
      .eq("document_id", input.documentId).eq("assignee_user_id", input.signerUserId).eq("status", "pending");
    if (input.documentVersionId) q = q.eq("document_version_id", input.documentVersionId);
    await q;
  }
  await maybeNotifyComplete(input.orgId, input.documentId, input.documentVersionId ?? null, input.signerUserId, input.signerName);
}

/** When the last outstanding assignee signs (or is waived), let the owner know
 *  the revision is fully acknowledged. */
async function maybeNotifyComplete(orgId: string, documentId: string, versionId: string | null, actorId?: string, actorName?: string | null): Promise<void> {
  let q = supabase.from("document_acknowledgments").select("id", { count: "exact", head: true })
    .eq("document_id", documentId).eq("status", "pending");
  if (versionId) q = q.eq("document_version_id", versionId);
  const { count } = await q;
  if ((count ?? 0) > 0) return;

  const { data: doc } = await supabase.from("documents")
    .select("library_id, collection_id, document_number, title, name, owner_user_id, owner_name").eq("id", documentId).maybeSingle();
  if (!doc) return;
  const owner = await effectiveOwnerForDocument({
    ownerUserId: (doc.owner_user_id as string | null) ?? null, ownerName: (doc.owner_name as string | null) ?? null,
    collectionId: (doc.collection_id as string | null) ?? null, libraryId: doc.library_id as string,
  });
  const controllers = await getOrgControllers(orgId);
  const label = (doc.document_number as string) || (doc.title as string) || (doc.name as string) || "Document";
  const link = `/documents/${doc.library_id}?doc=${documentId}`;
  const targets = uniq([...(owner.userId ? [owner.userId] : controllers)]).filter((u) => u !== actorId);
  await Promise.all(targets.map((uid) =>
    notify({ orgId, userId: uid, kind: "ack_complete", title: `Fully acknowledged: ${label}`, body: "Everyone assigned has read & understood this revision.", link, resourceType: "document", resourceId: documentId, actorUserId: actorId, actorName: actorName ?? undefined })
  ));
}

/** Owner/controller excuses an assignee (left the role, on leave, etc). A waiver
 *  is explicit and logged — it never counts as an acknowledgment. */
export async function waiveAcknowledgment(input: {
  orgId: string; rosterId: string; documentId: string; reason: string; actorId: string; actorName?: string | null;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  await supabase.from("document_acknowledgments")
    .update({ status: "waived", waived_by: input.actorId, waived_reason: input.reason, updated_at: nowIso })
    .eq("id", input.rosterId);
  await logAuditAction({
    action: "ACK_WAIVED", resourceType: "document", resourceId: input.documentId,
    orgId: input.orgId, userId: input.actorId, details: { rosterId: input.rosterId, reason: input.reason },
  }).catch(() => {});
  await maybeNotifyComplete(input.orgId, input.documentId, null, input.actorId, input.actorName);
}

/** Manually re-send the acknowledgment request to one assignee (owner/controller
 *  action from the roster panel). Resets their notified_at watermark. */
export async function nudgeAcknowledgment(input: { orgId: string; rosterId: string }): Promise<void> {
  const { data: r } = await supabase.from("document_acknowledgments").select("document_id, assignee_user_id, revision_label").eq("id", input.rosterId).maybeSingle();
  if (!r) return;
  const { data: doc } = await supabase.from("documents").select("library_id, document_number, title, name").eq("id", r.document_id as string).maybeSingle();
  const label = (doc?.document_number as string) || (doc?.title as string) || (doc?.name as string) || "Document";
  const rev = (r.revision_label as string) || "";
  await notify({
    orgId: input.orgId, userId: r.assignee_user_id as string, kind: "ack_requested",
    title: `Reminder — acknowledge ${label}${rev ? ` Rev ${rev}` : ""}`,
    body: "Please confirm you've read and understood this revision.",
    link: `/documents/${doc?.library_id as string}?doc=${r.document_id as string}`,
    resourceType: "document", resourceId: r.document_id as string,
  });
  await supabase.from("document_acknowledgments").update({ notified_at: new Date().toISOString() }).eq("id", input.rosterId);
}

// ── Policy set (doc / folder / library) ──────────────────────────────────────

/** Set (or clear) the acknowledgment policy at a level, then (re)open rosters so
 *  the change takes effect immediately on already-issued documents — not only on
 *  the next revision. */
export async function setAckPolicy(input: {
  level: Level; id: string; orgId: string; policy: AckPolicy | null;
  actorId?: string | null; actorName?: string | null;
}): Promise<void> {
  const table = input.level === "library" ? "libraries" : input.level === "collection" ? "collections" : "documents";
  await supabase.from(table).update({ ack_policy: input.policy }).eq("id", input.id);
  await logAuditAction({
    action: input.policy ? "ACK_POLICY_SET" : "ACK_POLICY_CLEARED", resourceType: input.level, resourceId: input.id,
    orgId: input.orgId, userId: input.actorId ?? "", details: { policy: input.policy },
  }).catch(() => {});

  if (input.level === "document") {
    await recomputeDocumentAck({ orgId: input.orgId, documentId: input.id, actorId: input.actorId, actorName: input.actorName });
    return;
  }
  // Library / folder: recompute every Issued document it covers, in batches.
  const col = input.level === "library" ? "library_id" : "collection_id";
  const { data } = await supabase.from("documents").select("id").eq(col, input.id).eq("status", "Issued");
  const ids = ((data ?? []) as Array<Record<string, unknown>>).map((r) => r.id as string);
  for (let i = 0; i < ids.length; i += 20) {
    await Promise.all(ids.slice(i, i + 20).map((id) =>
      recomputeDocumentAck({ orgId: input.orgId, documentId: id, actorId: input.actorId, actorName: input.actorName })));
  }
}

// ── Daily scan: re-nudge + escalate (column-independent, watermark-guarded) ───

/** Re-nudge outstanding assignees past the cooldown and escalate long-overdue
 *  ones to the owner + Admin/DocCtrl. The per-row `notified_at` watermark makes
 *  this idempotent, so a single failed send never drops the obligation. Runs
 *  daily from a controller's session, alongside the review scan. */
export async function scanAndNotifyAcks(orgId: string, opts?: { cooldownDays?: number; graceDays?: number }): Promise<number> {
  const cooldownDays = opts?.cooldownDays ?? 7;
  const graceDays = opts?.graceDays ?? GRACE_DAYS;
  const { data } = await supabase
    .from("document_acknowledgments")
    .select("id, document_id, assignee_user_id, assignee_name, revision_label, notified_at, assigned_at")
    .eq("org_id", orgId).eq("status", "pending");
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (!rows.length) return 0;

  const docIds = uniq(rows.map((r) => r.document_id as string));
  const [{ data: docs }, { data: libs }, { data: cols }, controllers] = await Promise.all([
    supabase.from("documents").select("id, library_id, collection_id, document_number, title, name, owner_user_id, owner_name").in("id", docIds),
    supabase.from("libraries").select("id, owner_user_id, owner_name").eq("org_id", orgId),
    supabase.from("collections").select("id, owner_user_id, owner_name").eq("org_id", orgId),
    getOrgControllers(orgId),
  ]);
  const dm = new Map((docs ?? []).map((d) => [(d as Record<string, unknown>).id as string, d as Record<string, unknown>]));
  const libOwn = new Map((libs ?? []).map((l) => [(l as Record<string, unknown>).id as string, l as Record<string, unknown>]));
  const colOwn = new Map((cols ?? []).map((c) => [(c as Record<string, unknown>).id as string, c as Record<string, unknown>]));

  const now = Date.now();
  const cooldownMs = cooldownDays * 86_400_000;
  let n = 0;

  for (const r of rows) {
    if (r.notified_at && now - new Date(r.notified_at as string).getTime() < cooldownMs) continue;
    const doc = dm.get(r.document_id as string);
    if (!doc) continue;
    const label = (doc.document_number as string) || (doc.title as string) || (doc.name as string) || "Document";
    const rev = (r.revision_label as string) || "";
    const link = `/documents/${doc.library_id as string}?doc=${r.document_id as string}`;

    await notify({
      orgId, userId: r.assignee_user_id as string, kind: "ack_requested",
      title: `Reminder — acknowledge ${label}${rev ? ` Rev ${rev}` : ""}`,
      body: "You still need to confirm you've read and understood this revision.",
      link, resourceType: "document", resourceId: r.document_id as string,
    });

    const overdueDays = Math.floor((now - new Date(r.assigned_at as string).getTime()) / 86_400_000);
    if (overdueDays > graceDays) {
      const owner = resolveEffectiveOwner(
        { owner_user_id: doc.owner_user_id as string | null, owner_name: doc.owner_name as string | null },
        doc.collection_id ? (colOwn.get(doc.collection_id as string) as { owner_user_id?: string | null; owner_name?: string | null } | undefined) : null,
        libOwn.get(doc.library_id as string) as { owner_user_id?: string | null; owner_name?: string | null } | undefined,
      );
      const escalateTo = uniq([...(owner.userId ? [owner.userId] : []), ...controllers]).filter((u) => u !== (r.assignee_user_id as string));
      await Promise.all(escalateTo.map((uid) =>
        notify({
          orgId, userId: uid, kind: "ack_overdue",
          title: `Acknowledgment overdue: ${label}`,
          body: `${(r.assignee_name as string) || "Someone assigned"} hasn't acknowledged ${label}${rev ? ` Rev ${rev}` : ""} — ${overdueDays} days outstanding.`,
          link, resourceType: "document", resourceId: r.document_id as string,
        })
      ));
    }

    await supabase.from("document_acknowledgments").update({ notified_at: new Date().toISOString() }).eq("id", r.id as string);
    n++;
  }
  return n;
}

// ── Acknowledgment report (proof-of-training for auditors) ────────────────────

function esc(s: string): string { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string)); }

/** A printable acknowledgment record — "Procedure X Rev N: 12 of 12 acknowledged"
 *  with each name, role, and timestamp. This is the sheet you hand an auditor. */
export function renderAckReport(meta: { label: string; title?: string | null; revisionLabel?: string | null; generatedAt: string }, rows: AckRosterRow[]): string {
  const done = rows.filter((r) => r.status === "acknowledged");
  const pending = rows.filter((r) => r.status === "pending");
  const waived = rows.filter((r) => r.status === "waived");
  const total = done.length + pending.length;
  const line = (r: AckRosterRow) => `<tr>
    <td>${esc(r.assigneeName || r.assigneeUserId)}</td>
    <td>${esc(r.assigneeRole || "—")}</td>
    <td>${r.status === "acknowledged" ? "Acknowledged" : r.status === "waived" ? `Waived${r.waivedReason ? ` — ${esc(r.waivedReason)}` : ""}` : "Outstanding"}</td>
    <td>${r.acknowledgedAt ? esc(r.acknowledgedAt.slice(0, 16).replace("T", " ")) : "—"}</td>
  </tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Acknowledgment record — ${esc(meta.label)}</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,Arial,sans-serif;color:#0f172a;margin:32px;font-size:13px}
    h1{font-size:18px;margin:0 0 2px} .sub{color:#64748b;margin:0 0 16px}
    .kpi{display:inline-block;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:10px;padding:8px 14px;margin:0 8px 16px 0;font-weight:700}
    table{border-collapse:collapse;width:100%;margin-top:8px} th,td{border:1px solid #e2e8f0;padding:6px 10px;text-align:left}
    th{background:#f8fafc;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#475569}
    .foot{margin-top:18px;color:#94a3b8;font-size:11px}
  </style></head><body>
  <h1>Read &amp; understood — acknowledgment record</h1>
  <p class="sub">${esc(meta.label)}${meta.title ? ` · ${esc(meta.title)}` : ""}${meta.revisionLabel ? ` · Rev ${esc(meta.revisionLabel)}` : ""}</p>
  <div>
    <span class="kpi">${done.length} of ${total} acknowledged</span>
    ${pending.length ? `<span class="kpi" style="background:#fef3c7;border-color:#fde68a">${pending.length} outstanding</span>` : ""}
    ${waived.length ? `<span class="kpi" style="background:#f1f5f9">${waived.length} waived</span>` : ""}
  </div>
  <table><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Signed</th></tr></thead>
  <tbody>${[...done, ...pending, ...waived].map(line).join("")}</tbody></table>
  <p class="foot">Generated ${esc(meta.generatedAt.slice(0, 16).replace("T", " "))}. Each acknowledgment is backed by an immutable electronic signature.</p>
  </body></html>`;
}

/** Open the acknowledgment report in a new tab for print/save. */
export function openAckReport(meta: { label: string; title?: string | null; revisionLabel?: string | null; generatedAt: string }, rows: AckRosterRow[]): void {
  const html = renderAckReport(meta, rows);
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(html);
  w.document.close();
}
