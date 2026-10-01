// lib/documentLifecycle/reverse.ts
//
// Selective undo for the lifecycle operations.
//
// Lifecycle operations are reversed via "compensating actions"
// rather than hard deletes — this preserves audit immutability,
// which the directive requires and which any PSM-style audit
// reconstruction depends on.
//
// Each reverse* function reads the original audit_logs row by id,
// extracts the doc IDs it touched, and performs the inverse:
//
//   reverseSplit(splitAuditId)
//     → mark each new doc Superseded with reason "reverted_split"
//     → un-supersede the source doc, back to the status it HELD before the
//       split (REV-12: recorded on the DOC_SPLIT event as priorStatus)
//     → delete the split's supersession rows
//     → only then void each parked sheet's in-flight review draft and
//       revoke its share links, and write DOC_SPLIT_REVERSED
//
//   reverseMerge(mergeAuditId)
//     → mark the merge target Superseded FIRST if it was newly created
//       by the merge (leave alone if it was an extended existing doc)
//     → un-supersede every source doc, each to the status it held
//       (DOC_MERGED carries priorStatuses for all siblings)
//     → delete the merge's supersession rows
//     → only then void the parked target's review draft, revoke its links,
//       and write DOC_MERGE_REVERSED
//
//   REV-6 (review fix 3): a reversal is TWO-PHASE. Before anything is
//   written, every document it will restore is proved restorable (a live
//   document now carrying the same uniqueness key in its library would make
//   the restore fail on the partial unique index, 20260619 — the retired
//   number was free to reuse). Then the parks, the restores and the lineage
//   delete run as one saga (withCompensation): each registers its put-back
//   BEFORE it writes, so a refusal at any step puts every document back the
//   way it was and re-inserts any lineage row already removed. Only once the
//   saga has landed are the irreversible steps run — voiding a parked
//   document's review (a voided sign-off never returns, 20261070) and
//   revoking its share links (revoked_at is frozen, 20261080) — with their
//   outcomes on the reversal's record.
//
//   HLD-2 (review fix 4): a document the reversal PARKS may carry a hold
//   opened after the operation. Parking it as Superseded and bringing the
//   source back bare would launder that hold away, so phase one reads the
//   parked documents' active holds and refuses unless the controller
//   explicitly proceeds over them (`force`); the saga then carries each such
//   hold onto every restored document BEFORE it is restored.
//
//   A split or merge recorded before Round F carries no prior status: the
//   reversal REFUSES rather than guess one (it used to write 'Issued', which
//   resurrected Void and Draft sources as controlled copies) unless the caller
//   names the status explicitly. Reversal rewrites the supersession record,
//   whose rows only Document Control / Admin may delete (20261131) — so it is
//   their act, checked here before anything moves.
//
//   reverseRenumber(renumberAuditId)
//     → the SAME gate as renumberDocument (OWN-19 authority, HLD-1 hold) —
//       an undo is a renumber, not a way round its rules
//     → set documents.document_number back to the previous value
//       (carried in the original audit's details), checked for the row
//     → write DOC_RENUMBER_REVERSED
//
// We deliberately scope reversal to a single audit event so that
// "undo" can't accidentally unwind unrelated operations the user
// did in the same session.

import { supabase } from "@/lib/supabase";
import { logRevisionEvent } from "@/lib/audit";
import { resolveActorPrincipal } from "@/lib/principal";
import { isControllerPrincipal } from "@/lib/permissions";
import { resolveCanControlLibrary } from "@/lib/documentGuards";
import { isEffectiveOwnerOfDocument } from "@/lib/ownership";
import { assertNotOnHold } from "@/lib/holdGate";
import { voidPendingDraftAfterPublish, revokeLiveSharesForDocument } from "@/lib/revisions";
import {
  withCompensation, copyActiveHoldsToDoc, releaseCarriedHolds,
  type Compensation, type ActorContext,
} from "./common";

export interface ReverseResult {
  reversedDocIds: string[];
  preservedAsSuperseded: number;
  warnings: string[];
}

// ─── Shared internals ───────────────────────────────────────────

type AuditEventRow = {
  id: string; action: string; resource_id: string; details: Record<string, unknown> | null; timestamp?: string | null;
};

async function loadAuditEvent(auditId: string): Promise<AuditEventRow | null> {
  const { data, error } = await supabase
    .from("audit_logs")
    .select("id, action, resource_id, details, timestamp")
    .eq("id", auditId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as AuditEventRow | null) ?? null;
}

/** REV-12: the instant the reversed operation happened — the auditAt the
 *  forward operation now records, else the audit row's own timestamp. Never
 *  the epoch: a warning counted from 1970 counts the operation itself. */
export function operationInstant(ev: Pick<AuditEventRow, "details" | "timestamp">): string {
  const at = ev.details?.auditAt;
  if (typeof at === "string" && at) return at;
  if (ev.timestamp) return ev.timestamp;
  throw new Error("The operation's time is not recorded — cannot tell what happened after it.");
}

/** Statuses a caller may name for a legacy (pre-Round-F) reversal whose
 *  prior status was never recorded. */
export const LEGACY_RESTORE_STATUSES = ["Issued", "Draft", "In Review", "Void"] as const;

export class PriorStatusUnknownError extends Error {
  constructor(label: string) {
    super(
      `This operation was recorded before prior statuses were captured, so the reversal can't prove what status ${label} held — ` +
      "it will not guess (restoring Issued would make a withdrawn or draft document a controlled copy again). " +
      "Document Control can restore it with an explicit status.",
    );
    this.name = "PriorStatusUnknownError";
  }
}

/** REV-16: does reversing this event need the caller to NAME the status to
 *  restore? True for a split / merge recorded before prior statuses were
 *  captured (no `priorStatus` on a DOC_SPLIT; a DOC_MERGED whose
 *  `priorStatuses` does not cover every sibling). Pure — the reverse dialog
 *  asks it to decide whether to show its status picker; the reversal itself
 *  still prefers whatever IS recorded. */
export function reversalNeedsLegacyStatus(action: string, details: Record<string, unknown> | null | undefined): boolean {
  const d = details ?? {};
  const has = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  if (action === "DOC_SPLIT") return !has(d.priorStatus);
  if (action === "DOC_MERGED") {
    const recorded = (d.priorStatuses && typeof d.priorStatuses === "object" ? d.priorStatuses : {}) as Record<string, unknown>;
    const siblings = ((d.mergeSiblings as string[] | undefined) ?? []).filter(Boolean);
    if (siblings.length === 0) return !has(d.priorStatus);
    return !siblings.every((id) => has(recorded[id]));
  }
  return false;
}

/** REV-12: the status to restore — recorded on the event, else the caller's
 *  explicit (validated) choice for a legacy event, else refuse. */
function statusToRestore(recorded: unknown, explicit: string | undefined, label: string): string {
  if (typeof recorded === "string" && recorded.trim()) return recorded;
  if (explicit) {
    if (!(LEGACY_RESTORE_STATUSES as readonly string[]).includes(explicit)) {
      throw new Error(`Cannot restore to "${explicit}" — choose ${LEGACY_RESTORE_STATUSES.join(", ")}.`);
    }
    return explicit;
  }
  throw new PriorStatusUnknownError(label);
}

/** Reversal is a Document Control / Admin act (it deletes supersession rows,
 *  which the database reserves to them — 20261131). */
async function assertReversalAuthority(orgId: string, actorUserId: string, actorRole?: string): Promise<void> {
  const principal = await resolveActorPrincipal({ uid: actorUserId, orgId, headlineRole: actorRole });
  if (!isControllerPrincipal(principal)) {
    throw new Error("Reversing a split or merge rewrites the supersession record — ask Document Control or an Admin.");
  }
}

type Register = (c: Compensation) => void;

/** The status fields a reversal changes on a document — what its rollback
 *  puts back. */
interface StatusSnapshot {
  status: string;
  superseded_at: unknown;
  superseded_by_user: unknown;
  supersession_reason: unknown;
  supersession_moc: unknown;
}

async function readStatusSnapshot(docId: string): Promise<StatusSnapshot> {
  const { data, error } = await supabase
    .from("documents")
    .select("status, superseded_at, superseded_by_user, supersession_reason, supersession_moc")
    .eq("id", docId).maybeSingle();
  if (error || !data) throw new Error(`Reversal stopped: couldn't read ${docId}'s status (${error?.message ?? "not found"}).`);
  return { ...(data as StatusSnapshot) };
}

/** Compensation: put a document's status fields back as they were (checked —
 *  a put-back that is refused THROWS, so withCompensation names it). */
async function putStatusBack(docId: string, snap: StatusSnapshot, actorUserId: string): Promise<void> {
  const { data, error } = await supabase.from("documents").update({
    status: snap.status,
    superseded_at: snap.superseded_at ?? null,
    superseded_by_user: snap.superseded_by_user ?? null,
    supersession_reason: snap.supersession_reason ?? null,
    supersession_moc: snap.supersession_moc ?? null,
    updated_at: new Date().toISOString(),
    updated_by: actorUserId,
  }).eq("id", docId).select("id");
  if (error || ((data as unknown[] | null) ?? []).length === 0) {
    throw new Error(`${docId} could not be put back to ${snap.status} (${error?.message ?? "the write was refused"})`);
  }
}

/** The outcome of one status write a reversal makes: `attempted` is set just
 *  before the write, `landed` once its success is confirmed. */
interface WriteOutcome { attempted: boolean; landed: boolean }

/** REV-6 (review fix 4): the put-back for a status write whose outcome may be
 *  UNKNOWN. A confirmed write is put back. A write that was attempted but
 *  whose answer was lost (a transport error after the database committed
 *  reads exactly like a refusal) is re-read, and put back only if the row
 *  really changed — so a lost response never leaves a sheet parked under a
 *  "no partial changes were kept" message, and a plain refusal (nothing
 *  changed) is not reported as a failed put-back. A re-read that fails
 *  throws, so withCompensation names the document. */
function putBackIfChanged(docId: string, snap: StatusSnapshot, actorUserId: string, outcome: WriteOutcome): () => Promise<void> {
  return async () => {
    if (outcome.landed) return putStatusBack(docId, snap, actorUserId);
    if (!outcome.attempted) return;
    let now: StatusSnapshot;
    try {
      now = await readStatusSnapshot(docId);
    } catch (e) {
      throw new Error(`whether ${docId}'s status write landed could not be confirmed (${(e as Error).message}) — check its status`);
    }
    const changed = (Object.keys(snap) as Array<keyof StatusSnapshot>).some((k) => String(now[k] ?? "") !== String(snap[k] ?? ""));
    if (changed) await putStatusBack(docId, snap, actorUserId);
  };
}

/** The statuses the documents' partial unique index skips (20260619:
 *  documents_library_uniqkey_uniq … WHERE status NOT IN ('Archived',
 *  'Superseded')) — a document in one of them does not hold its key. */
const UNIQUE_KEY_FREE_STATUSES = ["Archived", "Superseded"] as const;

/** REV-6 (review fix 3), phase one: before a reversal writes ANYTHING, prove
 *  every document it will restore can be restored. A retired document's
 *  uniqueness key is free (the partial unique index skips Superseded rows),
 *  so a live document may have taken it since the operation — its restore
 *  would then fail on 23505 after the sheets were already parked. Two of
 *  the restored documents sharing a key would collide with each other the
 *  same way. The documents the reversal parks are leaving the index, so they
 *  are not a collision. An unreadable answer refuses (fails closed). */
async function assertRestorable(restoreIds: string[], parkedIds: string[]): Promise<void> {
  const { data, error } = await supabase
    .from("documents")
    .select("id, library_id, uniqueness_key, document_number, title")
    .in("id", restoreIds);
  if (error) throw new Error(`Couldn't confirm the documents to restore are free to come back (${error.message}) — nothing was changed.`);
  type KeyRow = { id: string; library_id: string | null; uniqueness_key: string | null; document_number: string | null; title: string | null };
  const rows = (data as KeyRow[] | null) ?? [];
  const missing = restoreIds.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length > 0) throw new Error(`Couldn't read ${missing.join(", ")} — nothing was changed.`);
  const free = new Set<string>(UNIQUE_KEY_FREE_STATUSES);
  const leaving = new Set([...restoreIds, ...parkedIds]);
  const seen = new Map<string, KeyRow>();
  for (const r of rows) {
    if (!r.uniqueness_key || !r.library_id) continue;
    const label = r.document_number || r.title || r.id;
    const twin = seen.get(`${r.library_id}::${r.uniqueness_key}`);
    if (twin) {
      throw new Error(`Cannot reverse: ${label} and ${twin.document_number || twin.title || twin.id} would both come back with the same document key in their library. Renumber one of them first — nothing was changed.`);
    }
    seen.set(`${r.library_id}::${r.uniqueness_key}`, r);
    const { data: clashes, error: clashErr } = await supabase
      .from("documents")
      .select("id, status, document_number, title")
      .eq("library_id", r.library_id)
      .eq("uniqueness_key", r.uniqueness_key)
      .not("status", "in", `(${UNIQUE_KEY_FREE_STATUSES.map((st) => `"${st}"`).join(",")})`)
      .limit(5);
    if (clashErr) throw new Error(`Couldn't confirm ${label}'s number is free to come back (${clashErr.message}) — nothing was changed.`);
    const clash = ((clashes as Array<{ id: string; status: string | null; document_number: string | null; title: string | null }> | null) ?? [])
      .find((c) => !leaving.has(c.id) && !free.has(String(c.status ?? "")));
    if (clash) {
      throw new Error(
        `Cannot reverse: ${label} can't come back — another live document ("${clash.document_number || clash.title || clash.id}", ${clash.status ?? "status unknown"}) now carries its number in that library. ` +
        "Renumber or retire that document first, then reverse. Nothing was changed.",
      );
    }
  }
}

/** Park a document a reversal retires: mark it Superseded (checked) — the
 *  status write ONLY. Its put-back is registered with the reversal's saga
 *  BEFORE the write (and runs if the park landed — or may have: an
 *  unconfirmed outcome is re-read, putBackIfChanged), so a later refusal
 *  un-parks it. Voiding its review and revoking its links are the
 *  irreversible half (finishParking), run only after the saga has landed. */
async function parkAsSuperseded(docId: string, supersessionReason: string, actorUserId: string, now: string, register: Register): Promise<void> {
  const snap = await readStatusSnapshot(docId);
  const outcome: WriteOutcome = { attempted: false, landed: false };
  register({ describe: `un-park ${docId}`, run: putBackIfChanged(docId, snap, actorUserId, outcome) });
  outcome.attempted = true;
  const { data, error } = await supabase.from("documents").update({
    status: "Superseded",
    superseded_at: now,
    superseded_by_user: actorUserId,
    supersession_reason: supersessionReason,
    updated_at: now,
    updated_by: actorUserId,
  }).eq("id", docId).select("id");
  if (error || ((data as unknown[] | null) ?? []).length === 0) {
    throw new Error(`Reversal stopped: ${docId} could not be parked as Superseded (${error?.message ?? "the write was refused"}).`);
  }
  outcome.landed = true;
}

/** The irreversible half of parking, run only once the reversal's saga has
 *  landed: void the parked document's in-flight review draft (REV-6) and
 *  revoke its share links (REV-10). Never throws — the reversal has
 *  committed, so a failure is returned for its record (finalize refuses a
 *  retired document, REV-5; the share routes refuse its status). */
async function finishParking(docId: string, actorUserId: string): Promise<{ revokedShareLinks: number; liveShareLinksLeft: number | null; shareRevokeError: string | null; voidedDraft: string | null; voidProblem: string | null }> {
  const draftVoid = await voidPendingDraftAfterPublish(docId, actorUserId);
  const shares = await revokeLiveSharesForDocument(docId, actorUserId);
  const shareProblem = [shares.error, shares.auditError].filter(Boolean).join("; ") || null;
  return { revokedShareLinks: shares.revoked, liveShareLinksLeft: shares.liveLeft, shareRevokeError: shareProblem, voidedDraft: draftVoid.voidedVersionId, voidProblem: draftVoid.problem };
}

/** Un-supersede one document to the status it held (checked). Its put-back
 *  (Superseded again, with its own supersession fields) is registered
 *  before the write and runs if the restore landed — or may have (review
 *  fix 4: an unconfirmed outcome is re-read, putBackIfChanged). */
async function restoreStatus(docId: string, status: string, actorUserId: string, now: string, register: Register): Promise<void> {
  const snap = await readStatusSnapshot(docId);
  const outcome: WriteOutcome = { attempted: false, landed: false };
  register({ describe: `put ${docId} back to ${snap.status}`, run: putBackIfChanged(docId, snap, actorUserId, outcome) });
  outcome.attempted = true;
  const { data, error } = await supabase.from("documents").update({
    status,
    superseded_at: null,
    superseded_by_user: null,
    supersession_reason: null,
    supersession_moc: null,
    updated_at: now,
    updated_by: actorUserId,
  }).eq("id", docId).select("id");
  if (error || ((data as unknown[] | null) ?? []).length === 0) {
    throw new Error(`Reversal stopped: ${docId} could not be restored to ${status} (${error?.message ?? "the write was refused"}).`);
  }
  outcome.landed = true;
}

/** Delete this operation's supersession rows — the saga's LAST step
 *  (checked: a row left behind would keep asserting a replacement the
 *  reversal undid; a removal whose read-back fails is UNCONFIRMED, never
 *  reported clean). The rows are read first and a compensation registered
 *  that re-inserts any of them found missing, so a failure here rolls the
 *  whole reversal back with the lineage whole. */
async function deleteLineage(filter: { supersededIds: string[]; replacementIds: string[] }, register: Register): Promise<void> {
  type LineageRow = { id: string; org_id: string; superseded_doc_id: string; replacement_doc_id: string; reason: string | null; created_by: string; created_at: string | null };
  const { data: before, error: beforeErr } = await supabase
    .from("document_supersessions")
    .select("id, org_id, superseded_doc_id, replacement_doc_id, reason, created_by, created_at")
    .in("superseded_doc_id", filter.supersededIds)
    .in("replacement_doc_id", filter.replacementIds);
  if (beforeErr) throw new Error(`Reversal stopped: couldn't read this operation's supersession links (${beforeErr.message}).`);
  const snapshot = (before as LineageRow[] | null) ?? [];
  register({
    describe: `re-link ${snapshot.length} supersession row(s)`,
    run: async () => {
      if (snapshot.length === 0) return;
      const { data: now, error: nowErr } = await supabase
        .from("document_supersessions").select("superseded_doc_id, replacement_doc_id")
        .in("superseded_doc_id", filter.supersededIds)
        .in("replacement_doc_id", filter.replacementIds);
      if (nowErr) throw new Error(`whether the supersession links survived could not be read (${nowErr.message}) — up to ${snapshot.length} may be missing`);
      const have = new Set(((now as Array<{ superseded_doc_id: string; replacement_doc_id: string }> | null) ?? []).map((r) => `${r.superseded_doc_id}>${r.replacement_doc_id}`));
      const gone = snapshot.filter((r) => !have.has(`${r.superseded_doc_id}>${r.replacement_doc_id}`));
      if (gone.length === 0) return;
      const { error: reErr } = await supabase
        .from("document_supersessions")
        .upsert(gone, { onConflict: "superseded_doc_id,replacement_doc_id", ignoreDuplicates: true });
      if (reErr) throw new Error(`${gone.length} supersession link(s) were removed and could not be re-inserted (${reErr.message}): ${gone.map((r) => `${r.superseded_doc_id} → ${r.replacement_doc_id}`).join(", ")}`);
    },
  });
  const { error } = await supabase
    .from("document_supersessions")
    .delete()
    .in("superseded_doc_id", filter.supersededIds)
    .in("replacement_doc_id", filter.replacementIds);
  const { data: left, error: leftErr } = await supabase
    .from("document_supersessions").select("id")
    .in("superseded_doc_id", filter.supersededIds)
    .in("replacement_doc_id", filter.replacementIds);
  if (leftErr) {
    throw new Error(`Reversal stopped: whether this operation's supersession links were removed could not be confirmed (${leftErr.message})${error ? `; the delete answered: ${error.message}` : ""} — some may remain.`);
  }
  const remaining = ((left as unknown[] | null) ?? []).length;
  if (error || remaining > 0) {
    throw new Error(`Reversal stopped: ${remaining || "the"} supersession link(s) could not be removed${error ? ` (${error.message})` : ""}.`);
  }
}

/** HLD-2 (review fix 4), phase one: the active holds on the documents a
 *  reversal will PARK. A held one refuses the reversal unless the controller
 *  explicitly proceeds over it (`force`) — never by releasing the hold,
 *  which would bring the restored document back with no hold. Unreadable
 *  holds refuse (fails closed). Returns the held parked ids with labels. */
async function assertParkedHoldsDecided(
  parkIds: string[],
  force: boolean | undefined,
  restoredLabel: string,
): Promise<Array<{ id: string; label: string; reasons: string[] }>> {
  if (parkIds.length === 0) return [];
  const { data, error } = await supabase
    .from("document_holds").select("document_id, reason")
    .in("document_id", parkIds).is("released_at", null);
  if (error) throw new Error(`Couldn't check the documents this reversal parks for active holds (${error.message}) — nothing was changed.`);
  const byDoc = new Map<string, string[]>();
  for (const h of (data as Array<{ document_id: string; reason: string }> | null) ?? []) {
    byDoc.set(h.document_id, [...(byDoc.get(h.document_id) ?? []), h.reason]);
  }
  if (byDoc.size === 0) return [];
  const { data: named } = await supabase.from("documents").select("id, document_number").in("id", [...byDoc.keys()]);
  const numbers = new Map(((named as Array<{ id: string; document_number: string | null }> | null) ?? []).map((r) => [r.id, r.document_number]));
  const held = [...byDoc.entries()].map(([id, reasons]) => ({ id, label: numbers.get(id) || id, reasons }));
  if (force !== true) {
    const count = held.reduce((n, h) => n + h.reasons.length, 0);
    const list = held.map((h) => `${h.label} (${h.reasons.join(", ")})`).join("; ");
    throw new Error(
      `Cannot reverse without an explicit decision: active ${count === 1 ? "hold" : "holds"} on ${list}, which the reversal parks as Superseded. ` +
      `Confirm "Proceed over the active hold" and ${count === 1 ? "it is" : "they are"} carried back onto ${restoredLabel}. ` +
      `Do not release the hold to get past this — ${restoredLabel} would come back with no hold. Nothing was changed.`,
    );
  }
  return held;
}

/** HLD-2 (review fix 4), inside the saga: carry every held parked
 *  document's active holds onto each document the reversal restores, BEFORE
 *  it is restored (it never comes back live without them). Each carry
 *  registers the release of exactly the holds it placed. */
async function carryParkedHolds(
  held: Array<{ id: string; label: string }>,
  restoreIds: string[],
  opLabel: "split" | "merge",
  actor: ActorContext,
  register: Register,
): Promise<number> {
  let carried = 0;
  for (const h of held) {
    for (const restoreId of restoreIds) {
      const r = await copyActiveHoldsToDoc({
        sourceDocId: h.id, targetDocId: restoreId,
        originLabel: `${h.label} (reversed ${opLabel})`,
        actor,
      });
      carried += r.copied;
      register({
        describe: `release the holds carried from ${h.label} onto ${restoreId}`,
        run: () => releaseCarriedHolds(r.holdIds, actor),
      });
    }
  }
  return carried;
}

/** Best-effort check for "stuff happened on these new docs after
 *  the original op." Doesn't block the reversal — it surfaces
 *  warnings the UI can show in the confirmation. REV-12: counted from the
 *  operation's own instant, so the operation's own events never count. */
async function summarizeDerivativeWork(docIds: string[], sinceIso: string, opLabel: "split" | "merge" = "split"): Promise<string[]> {
  if (docIds.length === 0) return [];
  const warnings: string[] = [];
  const { data: events } = await supabase
    .from("audit_logs")
    .select("action, resource_id, timestamp")
    .in("resource_id", docIds)
    .gt("timestamp", sinceIso)
    .order("timestamp", { ascending: false })
    .limit(200);
  const rows = (events as Array<{ action: string; resource_id: string; timestamp: string }>) ?? [];
  if (rows.length === 0) return [];
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.action] = (counts[r.action] ?? 0) + 1;
  const interesting = ["CHECK_OUT", "DOCUMENT_CHECKOUT", "REV_UP", "DOWNLOAD", "HOLD_OPENED"];
  for (const a of interesting) {
    if (counts[a]) warnings.push(`${counts[a]} ${a.replace("_", " ").toLowerCase()} event${counts[a] === 1 ? "" : "s"} happened on the new docs since the ${opLabel}.`);
  }
  return warnings;
}

// ─── reverseSplit ───────────────────────────────────────────────

interface ReverseSplitInput {
  splitAuditEventId: string;
  reason: string;                // why the user is reversing
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  /** Only for a split recorded before prior statuses were captured: the
   *  status to restore the source to, named explicitly (REV-12). */
  legacyRestoreStatus?: string;
  /** HLD-2 (review fix 4): the controller's explicit decision to reverse
   *  over an active hold on a sheet the reversal parks; the hold is carried
   *  back onto the restored source. */
  force?: boolean;
}

export async function reverseSplit(input: ReverseSplitInput): Promise<ReverseResult> {
  const ev = await loadAuditEvent(input.splitAuditEventId);
  if (!ev || ev.action !== "DOC_SPLIT") throw new Error("Audit event is not a DOC_SPLIT.");
  const sourceDocId = ev.resource_id;
  const replacementIds = (ev.details?.replacementDocIds as string[] | undefined) ?? [];
  if (replacementIds.length === 0) throw new Error("Split event has no replacement doc ids — cannot reverse precisely.");

  await assertReversalAuthority(input.orgId, input.actorUserId, input.actorRole);
  const priorStatus = statusToRestore(ev.details?.priorStatus, input.legacyRestoreStatus, "the source");

  // Surface what'll get parked under Superseded — work done AFTER the split.
  const warnings = await summarizeDerivativeWork(replacementIds, operationInstant(ev), "split");

  // Phase one (REV-6): the source can come back — proved before any write;
  // HLD-2: a held sheet is parked only on the controller's explicit force.
  const heldParked = await assertParkedHoldsDecided(replacementIds, input.force, "the restored source");
  await assertRestorable([sourceDocId], replacementIds);

  const now = new Date().toISOString();
  const actor: ActorContext = { orgId: input.orgId, actorUserId: input.actorUserId, actorEmail: input.actorEmail, actorRole: input.actorRole };
  // Phase two: the reversible saga. A refusal anywhere puts every sheet,
  // the source, any carried hold and the lineage back; nothing irreversible
  // has run yet.
  let holdsCarriedBack = 0;
  await withCompensation(async (register) => {
    for (const newId of replacementIds) {
      await parkAsSuperseded(newId, `Reverted split — ${input.reason}`, input.actorUserId, now, register);
    }
    // HLD-2: a parked sheet's holds onto the source BEFORE it comes back.
    holdsCarriedBack = await carryParkedHolds(heldParked, [sourceDocId], "split", actor, register);
    // Un-supersede the source — to the status it actually held (REV-12).
    await restoreStatus(sourceDocId, priorStatus, input.actorUserId, now, register);
    // Delete the join rows; the audit log retains the relationship so
    // history is still reconstructable.
    await deleteLineage({ supersededIds: [sourceDocId], replacementIds }, register);
  });

  // Phase three: the irreversible half, only now that the reversal landed.
  const parked = replacementIds.length;
  let revokedShareLinks = 0;
  const liveShareLinksLeft: Record<string, number | null> = {};
  const shareRevokeErrors: string[] = [];
  const voidedDrafts: string[] = [];
  const draftVoidProblems: string[] = [];
  for (const newId of replacementIds) {
    const r = await finishParking(newId, input.actorUserId);
    revokedShareLinks += r.revokedShareLinks;
    if (r.liveShareLinksLeft !== 0) liveShareLinksLeft[newId] = r.liveShareLinksLeft;
    if (r.shareRevokeError) shareRevokeErrors.push(`${newId}: ${r.shareRevokeError}`);
    if (r.voidedDraft) voidedDrafts.push(r.voidedDraft);
    if (r.voidProblem) draftVoidProblems.push(`${newId}: ${r.voidProblem}`);
  }

  await logRevisionEvent({
    orgId: input.orgId,
    documentId: sourceDocId,
    versionId: "",
    userId: input.actorUserId,
    userEmail: input.actorEmail ?? "",
    userRole: input.actorRole ?? "",
    type: "DOC_SPLIT_REVERSED",
    details: {
      reversedAuditEventId: input.splitAuditEventId,
      reversedNewDocIds: replacementIds,
      reason: input.reason.trim(),
      derivativeWorkWarnings: warnings,
      restoredStatus: priorStatus,
      restoredStatusSource: typeof ev.details?.priorStatus === "string" ? "recorded" : "explicit",
      proceededOverHolds: Object.fromEntries(heldParked.map((h) => [h.id, h.reasons])),
      holdsCarriedBack,
      revokedShareLinks,
      liveShareLinksLeft,
      shareRevokeErrors,
      pendingDraftsVoided: voidedDrafts,
      pendingDraftVoidProblems: draftVoidProblems,
    },
  });

  return { reversedDocIds: replacementIds, preservedAsSuperseded: parked, warnings };
}

// ─── reverseMerge ──────────────────────────────────────────────

interface ReverseMergeInput {
  mergeAuditEventId: string;       // the DOC_MERGED event on ONE of the source docs (we'll find siblings)
  reason: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  /** Only for a merge recorded before prior statuses were captured (REV-12). */
  legacyRestoreStatus?: string;
  /** HLD-2 (review fix 4): the controller's explicit decision to reverse
   *  over an active hold on a newly-created target the reversal parks; the
   *  hold is carried back onto every restored source. */
  force?: boolean;
}

export async function reverseMerge(input: ReverseMergeInput): Promise<ReverseResult> {
  const ev = await loadAuditEvent(input.mergeAuditEventId);
  if (!ev || ev.action !== "DOC_MERGED") throw new Error("Audit event is not a DOC_MERGED.");
  const sourceDocId = ev.resource_id;
  const targetDocId = ev.details?.mergedIntoDocumentId as string | undefined;
  const allSourceIds = ((ev.details?.mergeSiblings as string[] | undefined) ?? [sourceDocId]).filter(Boolean);
  if (!targetDocId) throw new Error("Merge event has no mergedIntoDocumentId — cannot reverse precisely.");

  // Was the target newly created? Prefer the explicit flag recorded on the
  // DOC_MERGED event itself (merges after this fix carry it). Only fall back
  // to the legacy note-string heuristic for older events that predate the
  // flag — and even then, default to the SAFE branch (treat as extended /
  // leave active) when we genuinely can't tell, so we never silently park a
  // drafter's live working document.
  let targetWasNewlyCreated: boolean;
  let inferredFromLegacyHeuristic = false;
  if (typeof ev.details?.targetWasNewlyCreated === "boolean") {
    targetWasNewlyCreated = ev.details.targetWasNewlyCreated as boolean;
  } else {
    const { data: targetCreate } = await supabase
      .from("audit_logs")
      .select("details")
      .eq("resource_id", targetDocId)
      .eq("action", "CREATED_FROM_MERGE")
      .order("timestamp", { ascending: false })
      .limit(1)
      .maybeSingle();
    const targetCreateDetails = (targetCreate as { details: Record<string, unknown> | null } | null)?.details ?? null;
    if (!targetCreateDetails) {
      // No creation record at all — cannot prove the target was new.
      // Choose the non-destructive branch.
      targetWasNewlyCreated = false;
      inferredFromLegacyHeuristic = true;
    } else {
      targetWasNewlyCreated = targetCreateDetails.note !== "Existing document extended via merge";
      inferredFromLegacyHeuristic = true;
    }
  }

  await assertReversalAuthority(input.orgId, input.actorUserId, input.actorRole);
  // REV-12: each sibling back to the status IT held. A post-Round-F event
  // carries all of them; a legacy event carries none (refused unless named).
  const recorded = (ev.details?.priorStatuses as Record<string, unknown> | undefined) ?? {};
  const restoreTo = new Map<string, string>();
  for (const sId of allSourceIds) {
    const own = sId === sourceDocId ? (recorded[sId] ?? ev.details?.priorStatus) : recorded[sId];
    restoreTo.set(sId, statusToRestore(own, input.legacyRestoreStatus, sId === sourceDocId ? "the source" : `merge source ${sId}`));
  }

  const warnings = await summarizeDerivativeWork([targetDocId], operationInstant(ev), "merge");

  // Phase one (REV-6): every source can come back — proved before any write;
  // HLD-2: a held target is parked only on the controller's explicit force.
  const heldParked = await assertParkedHoldsDecided(targetWasNewlyCreated ? [targetDocId] : [], input.force, "every restored source");
  await assertRestorable(allSourceIds, targetWasNewlyCreated ? [targetDocId] : []);

  const now = new Date().toISOString();
  const actor: ActorContext = { orgId: input.orgId, actorUserId: input.actorUserId, actorEmail: input.actorEmail, actorRole: input.actorRole };
  let holdsCarriedBack = 0;
  // Phase two: the reversible saga. Park the target FIRST, if newly created
  // (reverseSplit's order), then restore every source, then delete the
  // lineage — each step's put-back registered before it writes, so a
  // refusal anywhere (the second source's restore included) un-parks the
  // target and re-supersedes the sources already restored. Never sources
  // and target live at once; nothing irreversible has run yet.
  await withCompensation(async (register) => {
    if (targetWasNewlyCreated) {
      await parkAsSuperseded(targetDocId, `Reverted merge — ${input.reason}`, input.actorUserId, now, register);
    }
    // HLD-2: the parked target's holds onto every source BEFORE it returns.
    holdsCarriedBack = await carryParkedHolds(heldParked, allSourceIds, "merge", actor, register);
    for (const sId of allSourceIds) {
      await restoreStatus(sId, restoreTo.get(sId)!, input.actorUserId, now, register);
    }
    await deleteLineage({ supersededIds: allSourceIds, replacementIds: [targetDocId] }, register);
  });

  // Phase three: the irreversible half, only now that the reversal landed.
  let parked = 0;
  let revokedShareLinks = 0;
  let liveShareLinksLeft: number | null = 0;
  let shareRevokeError: string | null = null;
  let voidedDraft: string | null = null;
  let voidProblem: string | null = null;
  if (targetWasNewlyCreated) {
    const r = await finishParking(targetDocId, input.actorUserId);
    parked = 1;
    revokedShareLinks = r.revokedShareLinks;
    liveShareLinksLeft = r.liveShareLinksLeft;
    shareRevokeError = r.shareRevokeError;
    voidedDraft = r.voidedDraft;
    voidProblem = r.voidProblem;
    if (inferredFromLegacyHeuristic) {
      warnings.unshift("This merge predates explicit intent tracking — whether the target was newly created was inferred. It has been parked as Superseded; verify this was the merge-created document and not a pre-existing one before relying on the reversal.");
    }
  } else {
    warnings.unshift("Target was an existing document extended by the merge — it stays active. Its rev-up (if any) is NOT reverted by this action; use Revert on its version history if needed.");
  }

  await logRevisionEvent({
    orgId: input.orgId,
    documentId: sourceDocId,
    versionId: "",
    userId: input.actorUserId,
    userEmail: input.actorEmail ?? "",
    userRole: input.actorRole ?? "",
    type: "DOC_MERGE_REVERSED",
    details: {
      reversedAuditEventId: input.mergeAuditEventId,
      reversedSourceDocIds: allSourceIds,
      targetDocId,
      targetWasNewlyCreated,
      targetIntentSource: inferredFromLegacyHeuristic ? "inferred" : "explicit",
      reason: input.reason.trim(),
      derivativeWorkWarnings: warnings,
      restoredStatuses: Object.fromEntries(restoreTo),
      proceededOverHolds: Object.fromEntries(heldParked.map((h) => [h.id, h.reasons])),
      holdsCarriedBack,
      revokedShareLinks,
      liveShareLinksLeft,
      shareRevokeError,
      pendingDraftVoided: voidedDraft,
      pendingDraftVoidProblem: voidProblem,
    },
  });

  return { reversedDocIds: [...allSourceIds, targetDocId], preservedAsSuperseded: parked, warnings };
}

// ─── reverseRenumber ───────────────────────────────────────────

interface ReverseRenumberInput {
  renumberAuditEventId: string;
  reason: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
}

export async function reverseRenumber(input: ReverseRenumberInput): Promise<ReverseResult> {
  const ev = await loadAuditEvent(input.renumberAuditEventId);
  if (!ev || ev.action !== "DOC_RENUMBERED") throw new Error("Audit event is not a DOC_RENUMBERED.");
  const docId = ev.resource_id;
  const previous = (ev.details?.previousDocumentNumber as string | null) ?? null;
  const current  = (ev.details?.newDocumentNumber as string | null) ?? null;
  if (!previous) throw new Error("Renumber event has no previousDocumentNumber — cannot reverse.");

  // Make sure the doc still has the renumbered value before we swap
  // it back, otherwise something else changed it in between and we
  // shouldn't blindly overwrite.
  const { data: cur, error: curErr } = await supabase
    .from("documents")
    .select("document_number, library_id")
    .eq("id", docId)
    .maybeSingle();
  if (curErr || !cur) throw new Error(`Couldn't read the document (${curErr?.message ?? "not found"}) — nothing was changed.`);
  const curRow = cur as { document_number: string | null; library_id: string | null };
  const live = curRow.document_number ?? null;
  const libraryId = curRow.library_id ?? null;

  // The undo of a renumber IS a renumber: renumberDocument's own gate —
  // OWN-19 authority (per-library control, or effective ownership of this
  // document) and HLD-1 (a held document keeps the number its hold cards
  // were printed with; fails closed) — before anything is written.
  const principal = await resolveActorPrincipal({ uid: input.actorUserId, orgId: input.orgId, headlineRole: input.actorRole });
  let authorized = libraryId ? await resolveCanControlLibrary(libraryId, principal) : false;
  if (!authorized) authorized = await isEffectiveOwnerOfDocument(docId, input.actorUserId);
  if (!authorized) {
    throw new Error("You don't have authority to renumber this document, so you can't reverse its renumber either. Ask an Admin or Doc Control.");
  }
  await assertNotOnHold(docId, { action: "reversing its renumber" });
  const warnings: string[] = [];
  if (current && live !== current) {
    warnings.push(`Document number is now "${live}", not the "${current}" that this renumber set. Another change happened since. Reverse only if you're sure.`);
  }

  // Re-check uniqueness BEFORE swapping. The original number may have been
  // reused by another active doc since the renumber. The DB partial unique
  // index excludes Archived/Superseded, so we mirror that here and surface
  // an actionable error rather than letting the UPDATE die on a 23505.
  if (libraryId) {
    const { data: conflicts } = await supabase
      .from("documents")
      .select("id, status, title")
      .eq("library_id", libraryId)
      .eq("document_number", previous)
      .neq("id", docId)
      .not("status", "in", '("Archived","Superseded")')
      .limit(1);
    const clash = (conflicts as Array<{ id: string; status: string; title: string | null }> | null)?.[0];
    if (clash) {
      throw new Error(
        `Cannot restore document number "${previous}" — it's already in use by another active document ("${clash.title ?? clash.id}") in this library. ` +
        `Renumber or retire that document first, then reverse this renumber.`,
      );
    }
  }

  const now = new Date().toISOString();
  const { data: swapped, error: swapErr } = await supabase.from("documents").update({
    document_number: previous,
    updated_at: now,
    updated_by: input.actorUserId,
  }).eq("id", docId).select("id");
  if (swapErr) {
    // Last-resort guard if a concurrent write slipped in between the check
    // and the swap.
    throw new Error(
      `Couldn't restore document number "${previous}": ${swapErr.message}. ` +
      `It may have just been taken by another document.`,
    );
  }
  if (((swapped as unknown[] | null) ?? []).length === 0) {
    throw new Error(`Couldn't restore document number "${previous}" — the write was refused. Nothing was changed.`);
  }

  await logRevisionEvent({
    orgId: input.orgId,
    documentId: docId,
    versionId: "",
    userId: input.actorUserId,
    userEmail: input.actorEmail ?? "",
    userRole: input.actorRole ?? "",
    type: "DOC_RENUMBER_REVERSED",
    details: {
      reversedAuditEventId: input.renumberAuditEventId,
      restoredToDocumentNumber: previous,
      wasAtDocumentNumber: live,
      reason: input.reason.trim(),
      warnings,
    },
  });

  return { reversedDocIds: [docId], preservedAsSuperseded: 0, warnings };
}
