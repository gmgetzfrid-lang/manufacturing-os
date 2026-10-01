// lib/turnover.ts — turnover package + punch list data layer.
//
// "Has the contractor delivered turnover documents and a quality package,
// and did OUR side actually review them?" — that question becomes rows.
// Each turnover item is one required content of the package (weld map, NDE
// reports, MTRs…), seeded by job size, tracked open → received → accepted /
// rejected / waived with the reviewer's name on the decision and — on
// accept — the document that was reviewed (QUAL-13). Every status change
// also lands as a turnover_review_events row (QUAL-11) — written by the
// DATABASE (20261091's trigger on turnover_items), in the same statement as
// the decision, so a decision can never land without its history row and a
// client can never write a history row of its own: a review history that is
// never overwritten, in which a rejection is a nonconformance event the
// scorecard and the report can read, and from which an accepted or waived
// item can be reopened with a reason. Accepted items become evidence the
// checklist engine can cite. The punch list is the closeout snag list —
// small, dated, and visible until it's empty — and closing an item records
// who closed it, what was done, and whether it was done or voided (QUAL-7).
//
// Every decision write is a checked write (lib/checkedWrite.ts, GAP-402):
// a refusal surfaces and audits nothing. Waive, reject, reopen and void
// require a typed reason of their OWN that meets the bar (SAF-4 / GAP-405 —
// the note already on the row belongs to the earlier decision): checked
// here, and enforced by the database for a write that bypasses this file,
// which also keeps a standing decision's note and reviewer (and a void's
// reason) until the next decision, and stamps the reviewer / closer with the
// caller's uid and profile name whatever the client sends (20261091).
//
// An acceptance is a SIGNED sign-off (QUAL-4, 20261136): the acceptor's
// e-signature on the item, minted through the ceremony (20261050) before the
// write, which the database binds to the item; and whoever added the item
// does not accept it while another eligible signer exists on the project
// (DEC-12 / DEC-37 — allowed and marked single-signer when nobody else can).
// Who may write these rows at all is the database's decision: a controller,
// the project owner, or a quality.sign_off holder for the project.

import { supabase } from "@/lib/supabase";
import type { Actor } from "@/lib/costs";
import { checkedWrite, describeWriteError, isMissingSchemaError } from "@/lib/checkedWrite";
import { reasonKey, reasonProblem } from "@/lib/checklistEngine";
import {
  captureQualitySignoff, loadSignoffAuthority, signoffSeparation, QUALITY_SIGNOFF_RESOURCE, type SignoffInput,
} from "@/lib/checklists";

export type TurnoverStatus = "open" | "received" | "accepted" | "rejected" | "waived";

export const TURNOVER_STATUS_LABEL: Record<TurnoverStatus, string> = {
  open: "Not received",
  received: "Received — awaiting QA/QC review",
  accepted: "Accepted",
  rejected: "Rejected — resubmission needed",
  waived: "Waived",
};

export interface TurnoverItem {
  id: string;
  orgId: string;
  projectId: string;
  partyId: string | null;
  name: string;
  description: string | null;
  required: boolean;
  status: TurnoverStatus;
  documentId: string | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewNote: string | null;
  createdAt: string | null;
  /** QUAL-4: who added the item (the database stamps the caller, 20261136). */
  createdBy?: string | null;
  /** QUAL-4: the e-signature a standing acceptance rests on (20261136). */
  reviewedSignatureId?: string | null;
  /** DEC-12: accepted by its creator because nobody else could. */
  reviewedSingleSigner?: boolean | null;
}

export type TurnoverEventKind = "review" | "reopen" | "nonconformance";

/** One row of the review history (QUAL-11) — append-only at the database. */
export interface TurnoverReviewEvent {
  id: string;
  itemId: string;
  fromStatus: TurnoverStatus | null;
  toStatus: TurnoverStatus;
  kind: TurnoverEventKind;
  reviewerName: string | null;
  note: string | null;
  documentId: string | null;
  createdAt: string | null;
}

export interface PunchItem {
  id: string;
  orgId: string;
  projectId: string;
  partyId: string | null;
  title: string;
  description: string | null;
  location: string | null;
  status: "open" | "done" | "void";
  dueDate: string | null;
  closedAt: string | null;
  closedByName: string | null;
  closureNote: string | null;
  createdByName: string | null;
  createdAt: string | null;
}

/** What a turnover package must contain, sized by job kind — each seed
 *  explains itself in plain terms so a rookie knows what to chase. The
 *  lists nest: standard includes small, capital includes both. */
export const TURNOVER_SEEDS: Record<"small" | "standard" | "capital", Array<{ name: string; description: string }>> = {
  small: [
    { name: "Work completion sign-off", description: "The contractor's statement that the scope is finished — who signed and when." },
    { name: "As-built markups / redlines", description: "Marked-up drawings showing what was ACTUALLY installed, wherever it differs from the design." },
    { name: "Test records", description: "Whatever proving was done — pressure test, loop check, rotation check — with the numbers, not just a checkmark." },
  ],
  standard: [
    { name: "Weld map & weld log", description: "Which weld is where, who welded it, and with what procedure. The map ties every weld number to a drawing location." },
    { name: "NDE reports", description: "Non-destructive examination results (X-ray/RT, ultrasonic/UT, dye penetrant) for the welds that required them." },
    { name: "Material certs (MTRs)", description: "Mill test reports proving the pipe and fittings are the alloy the spec ordered — heat numbers must trace to what was installed." },
    { name: "Pressure / leak test records", description: "Test pressure, hold time, test medium, and the witness signature. The chart or gauge log comes with it." },
    { name: "Equipment data sheets", description: "Vendor data for anything new that was installed — capacities, materials, ratings." },
  ],
  capital: [
    { name: "ITP records (hold/witness points)", description: "The inspection & test plan with every hold and witness point signed off in order — proof nothing skipped inspection." },
    { name: "Welder qualification records", description: "Current qualification papers for every welder who touched the job, matched to the procedures they welded." },
    { name: "Calibration certs for M&TE", description: "Calibration certificates for the gauges and instruments used in testing — an uncalibrated gauge proves nothing." },
    { name: "PSSR support package", description: "Everything the pre-startup safety review needs: updated P&IDs, procedures, training records for the change." },
    { name: "Vendor manuals & spare parts list", description: "Operating manuals and the recommended spares list for new equipment — maintenance needs these on day one." },
    { name: "Final as-built drawings", description: "The drafted, issued as-built revisions — not just field markups — closing the loop in document control." },
  ],
};

/** The full seed list for a job kind (lists nest upward). */
export function seedsForJobKind(jobKind: string | null | undefined): Array<{ name: string; description: string }> {
  const k = jobKind === "capital" ? "capital" : jobKind === "small" ? "small" : "standard";
  if (k === "small") return TURNOVER_SEEDS.small;
  if (k === "standard") return [...TURNOVER_SEEDS.small, ...TURNOVER_SEEDS.standard];
  return [...TURNOVER_SEEDS.small, ...TURNOVER_SEEDS.standard, ...TURNOVER_SEEDS.capital];
}

function mapItem(r: Record<string, unknown>): TurnoverItem {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    projectId: String(r.project_id),
    partyId: (r.party_id as string | null) ?? null,
    name: String(r.name ?? ""),
    description: (r.description as string | null) ?? null,
    required: r.required !== false,
    status: (r.status as TurnoverStatus) ?? "open",
    documentId: (r.document_id as string | null) ?? null,
    reviewedAt: (r.reviewed_at as string | null) ?? null,
    reviewedByName: (r.reviewed_by_name as string | null) ?? null,
    reviewNote: (r.review_note as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
    reviewedSignatureId: (r.reviewed_signature_id as string | null) ?? null,
    reviewedSingleSigner: typeof r.reviewed_single_signer === "boolean" ? r.reviewed_single_signer : null,
  };
}

function mapEvent(r: Record<string, unknown>): TurnoverReviewEvent {
  return {
    id: String(r.id),
    itemId: String(r.item_id),
    fromStatus: (r.from_status as TurnoverStatus | null) ?? null,
    toStatus: (r.to_status as TurnoverStatus) ?? "open",
    kind: (r.kind as TurnoverEventKind) ?? "review",
    reviewerName: (r.reviewer_name as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    documentId: (r.document_id as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
  };
}

function mapPunch(r: Record<string, unknown>): PunchItem {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    projectId: String(r.project_id),
    partyId: (r.party_id as string | null) ?? null,
    title: String(r.title ?? ""),
    description: (r.description as string | null) ?? null,
    location: (r.location as string | null) ?? null,
    status: (r.status as PunchItem["status"]) ?? "open",
    dueDate: (r.due_date as string | null) ?? null,
    closedAt: (r.closed_at as string | null) ?? null,
    closedByName: (r.closed_by_name as string | null) ?? null,
    closureNote: (r.closure_note as string | null) ?? null,
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
  };
}

async function audit(action: string, orgId: string, resourceId: string, actor: Actor, details: Record<string, unknown>) {
  await supabase.from("audit_logs").insert({
    action, resource_type: "project", resource_id: resourceId,
    org_id: orgId, user_id: actor.uid, user_email: actor.email,
    details,
  }).then(() => undefined, () => undefined);
}

const actorName = (actor: Actor) => actor.email?.split("@")[0] ?? null;

/** The refusal when a decision would reuse the note already on the row —
 *  that note is the earlier decision's (the database refuses it too). */
const OWN_REASON = "Give this decision its own reason — the note on the item is the earlier decision's.";

// ── Turnover items ───────────────────────────────────────────────────────

/** The turnover items, or a thrown error the surface renders as "failed to
 *  load" — never an empty state standing in for a denial (UX-10). */
export async function listTurnoverItems(orgId: string, projectId: string): Promise<TurnoverItem[]> {
  const { data, error } = await supabase.from("turnover_items").select("*")
    .eq("org_id", orgId).eq("project_id", projectId)
    .order("created_at", { ascending: true }).limit(300);
  if (error) throw new Error(describeWriteError(error));
  return (((data ?? []) as Array<Record<string, unknown>>)).map(mapItem);
}

/** The review history for a project's turnover items, oldest first. Only a
 *  missing table (the migration not applied yet) is an empty history; any
 *  other failure throws, so the surface says "history unavailable" instead
 *  of hiding a nonconformance behind an empty list (UX-10). */
export async function listTurnoverReviewEvents(orgId: string, projectId: string): Promise<TurnoverReviewEvent[]> {
  const { data, error } = await supabase.from("turnover_review_events").select("*")
    .eq("org_id", orgId).eq("project_id", projectId)
    .order("created_at", { ascending: true }).limit(1000);
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw new Error(describeWriteError(error));
  }
  return (((data ?? []) as Array<Record<string, unknown>>)).map(mapEvent);
}

/** Seed the required contents for the job size — skipping names that
 *  already exist, so re-seeding after a job-kind change only adds. */
export async function seedTurnoverItems(input: {
  orgId: string; projectId: string;
  jobKind: string | null;
  partyId?: string | null;
  actor: Actor;
}): Promise<{ ok: boolean; error?: string; added: number }> {
  let existing: TurnoverItem[];
  try { existing = await listTurnoverItems(input.orgId, input.projectId); }
  catch (e) { return { ok: false, error: (e as Error).message, added: 0 }; }
  const have = new Set(existing.map((i) => i.name.toLowerCase()));
  const rows = seedsForJobKind(input.jobKind)
    .filter((s) => !have.has(s.name.toLowerCase()))
    .map((s) => ({
      org_id: input.orgId, project_id: input.projectId,
      party_id: input.partyId ?? null,
      name: s.name, description: s.description, required: true,
      created_by: input.actor.uid,
    }));
  if (rows.length === 0) return { ok: true, added: 0 };
  const w = await checkedWrite(supabase.from("turnover_items").insert(rows).select("id"));
  if (!w.ok) return { ok: false, error: w.error, added: 0 };
  await audit("TURNOVER_SEEDED", input.orgId, input.projectId, input.actor, {
    jobKind: input.jobKind, added: w.ids.length,
  });
  return { ok: true, added: w.ids.length };
}

export async function addTurnoverItem(input: {
  orgId: string; projectId: string;
  name: string; description?: string | null; required?: boolean;
  partyId?: string | null;
  actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  if (!input.name.trim()) return { ok: false, error: "Name the turnover item." };
  const w = await checkedWrite(supabase.from("turnover_items").insert({
    org_id: input.orgId, project_id: input.projectId,
    party_id: input.partyId ?? null,
    name: input.name.trim(), description: input.description?.trim() || null,
    required: input.required !== false,
    created_by: input.actor.uid,
  }).select("id"));
  if (!w.ok) return { ok: false, error: w.error };
  await audit("TURNOVER_ITEM_ADDED", input.orgId, input.projectId, input.actor, { name: input.name.trim() });
  return { ok: true };
}

/**
 * Move one item through the review: mark received (optionally attaching the
 * submitted document), then accepted / rejected / waived — decisions stamp
 * the reviewer's name, date and note (a fresh reviewed_at is what tells the
 * database's history trigger to carry the name and note into the event row),
 * and an accept records the document that was reviewed (QUAL-13). Reject and
 * waive REQUIRE a reason that meets the bar (SAF-4). The database appends
 * the turnover_review_events row in the same statement — a rejection as a
 * `nonconformance` event (QUAL-11) — so there is no second request that
 * could fail after the decision landed. Acceptance rates feed the
 * contractor's scorecard, so the decision is the record.
 * An acceptance is a signed sign-off (QUAL-4): the item's creator is
 * refused while another eligible signer exists (DEC-12), and the acceptor's
 * e-signature on the item is minted through the ceremony (`signoff`) before
 * the write — the database (20261136) binds it and refuses an unsigned one.
 */
export async function reviewTurnoverItem(input: {
  item: TurnoverItem;
  status: TurnoverStatus;
  note?: string | null;
  documentId?: string | null;
  actor: Actor;
  /** QUAL-4: the signing ceremony's output — required to accept. */
  signoff?: SignoffInput | null;
}): Promise<{ ok: boolean; error?: string }> {
  const { item } = input;
  const note = input.note?.trim() || null;
  if (input.status === "rejected" || input.status === "waived") {
    const problem = reasonProblem(note);
    if (problem) return { ok: false, error: problem };
    if (reasonKey(note) === reasonKey(item.reviewNote)) return { ok: false, error: OWN_REASON };
  }
  let signatureId: string | undefined;
  let singleSigner = false;
  if (input.status === "accepted") {
    // DEC-12 / DEC-37: whoever added the item does not accept it while
    // anyone else on the project could (fail closed — DEC-16).
    if (item.createdBy && item.createdBy === input.actor.uid) {
      const authority = await loadSignoffAuthority(item.orgId, item.projectId, input.actor);
      if (authority.error) return { ok: false, error: `Couldn't check who else can accept this item (${authority.error}) — nothing was changed.` };
      const sod = signoffSeparation(item.createdBy, input.actor.uid, authority.otherSigners, "turnover");
      if (sod.blocked) return { ok: false, error: sod.reason ?? "A second person accepts this item." };
      singleSigner = sod.singleSigner;
    }
    const sig = await captureQualitySignoff({
      orgId: item.orgId, resourceType: QUALITY_SIGNOFF_RESOURCE.turnoverItem, resourceId: item.id,
      signoff: input.signoff, actor: input.actor,
    });
    if (!sig.ok) return { ok: false, error: sig.error };
    signatureId = sig.signatureId;
  }
  const row: Record<string, unknown> = { status: input.status };
  if (input.documentId !== undefined) row.document_id = input.documentId;
  if (input.status === "accepted" || input.status === "rejected" || input.status === "waived") {
    row.reviewed_at = new Date().toISOString();
    row.reviewed_by = input.actor.uid;
    row.reviewed_by_name = actorName(input.actor);
    row.review_note = note;
  }
  const w = await checkedWrite(supabase.from("turnover_items").update(row).eq("id", item.id).select("id"));
  if (!w.ok) return { ok: false, error: w.error };
  await audit("TURNOVER_REVIEWED", item.orgId, item.projectId, input.actor, {
    itemId: item.id, name: item.name, from: item.status, status: input.status, note,
    documentId: input.documentId ?? item.documentId ?? null,
    ...(signatureId ? { signatureId, singleSigner } : {}),
  });
  return { ok: true };
}

/** Reopen an accepted or waived item for re-review (QUAL-11): the item goes
 *  back to "received — awaiting review" and the row carries WHO reopened it,
 *  WHEN and WHY (the reason is the row's review note, which the database
 *  requires for any move out of accepted / waived — a NEW note of at least
 *  10 characters; the one on the row is the decision being reopened). The acceptance itself is never lost: its history row was written
 *  when it was decided (or backfilled by 20261091 for a decision made before
 *  the history existed), and the reopen appends a `reopen` row in the same
 *  statement. Authority is the write policy's (a controller, the project
 *  owner, or a quality.sign_off holder for the project — 20261136). */
export async function reopenTurnoverItem(input: {
  item: TurnoverItem; reason: string; actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const { item } = input;
  if (item.status !== "accepted" && item.status !== "waived") {
    return { ok: false, error: "Only an accepted or waived item can be reopened." };
  }
  const reason = input.reason.trim();
  const problem = reasonProblem(reason);
  if (problem) return { ok: false, error: problem };
  if (reasonKey(reason) === reasonKey(item.reviewNote)) return { ok: false, error: OWN_REASON };
  const w = await checkedWrite(supabase.from("turnover_items").update({
    status: "received",
    reviewed_at: new Date().toISOString(), reviewed_by: input.actor.uid,
    reviewed_by_name: actorName(input.actor), review_note: reason,
  }).eq("id", item.id).eq("status", item.status).select("id"));
  if (!w.ok) return { ok: false, error: w.error };
  await audit("TURNOVER_REOPENED", item.orgId, item.projectId, input.actor, {
    itemId: item.id, name: item.name, from: item.status, reason,
    // the decision being reopened, as the row carried it
    prior: { reviewedByName: item.reviewedByName, reviewedAt: item.reviewedAt, note: item.reviewNote, documentId: item.documentId },
  });
  return { ok: true };
}

export interface TurnoverProgress {
  required: number;
  accepted: number;          // accepted — delivered and reviewed (waived NOT included)
  waived: number;            // waived — the requirement was set aside, with a reason
  received: number;          // received but not yet decided
  rejected: number;
  outstanding: string[];     // required item names still open/rejected
  pct: number;               // (accepted + waived) / required — met, with the two buckets kept apart
}

export function computeTurnoverProgress(items: TurnoverItem[]): TurnoverProgress {
  const req = items.filter((i) => i.required);
  const accepted = req.filter((i) => i.status === "accepted").length;
  const waived = req.filter((i) => i.status === "waived").length;
  return {
    required: req.length,
    accepted,
    waived,
    received: req.filter((i) => i.status === "received").length,
    rejected: req.filter((i) => i.status === "rejected").length,
    outstanding: req.filter((i) => i.status === "open" || i.status === "rejected").map((i) => i.name),
    pct: req.length > 0 ? Math.round(((accepted + waived) / req.length) * 100) : 100,
  };
}

// ── Punch list ───────────────────────────────────────────────────────────

export async function listPunchItems(orgId: string, projectId: string): Promise<PunchItem[]> {
  const { data, error } = await supabase.from("punch_items").select("*")
    .eq("org_id", orgId).eq("project_id", projectId)
    .order("created_at", { ascending: false }).limit(500);
  if (error) throw new Error(describeWriteError(error));
  return (((data ?? []) as Array<Record<string, unknown>>)).map(mapPunch);
}

export async function addPunchItem(input: {
  orgId: string; projectId: string;
  title: string; dueDate?: string | null; partyId?: string | null;
  description?: string | null; location?: string | null;
  actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  if (!input.title.trim()) return { ok: false, error: "Describe the punch item." };
  // description / location are 20261091 columns: sent only when filled, so
  // adding a plain punch item keeps working before the migration is applied.
  const description = input.description?.trim() || null;
  const location = input.location?.trim() || null;
  const w = await checkedWrite(supabase.from("punch_items").insert({
    org_id: input.orgId, project_id: input.projectId,
    party_id: input.partyId ?? null,
    title: input.title.trim(), due_date: input.dueDate || null,
    ...(description ? { description } : {}),
    ...(location ? { location } : {}),
    created_by: input.actor.uid,
    created_by_name: actorName(input.actor),
  }).select("id"));
  if (!w.ok) return { ok: false, error: w.error };
  await audit("PUNCH_ADDED", input.orgId, input.projectId, input.actor, { title: input.title.trim() });
  return { ok: true };
}

/** Close (done), void, or reopen a punch item. Done records who closed it
 *  and what closed it (closure note); void REQUIRES a reason (SAF-4) —
 *  the two are distinguishable on the row, not only by dot colour (QUAL-7). */
export async function setPunchStatus(input: {
  item: PunchItem; status: "open" | "done" | "void"; note?: string | null; actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const note = input.note?.trim() || null;
  if (input.status === "void") {
    const problem = reasonProblem(note);
    if (problem) return { ok: false, error: problem };
    if (reasonKey(note) === reasonKey(input.item.closureNote)) return { ok: false, error: OWN_REASON };
  }
  const row: Record<string, unknown> = { status: input.status };
  if (input.status === "done" || input.status === "void") {
    row.closed_at = new Date().toISOString();
    row.closed_by = input.actor.uid;
    row.closed_by_name = actorName(input.actor);
    row.closure_note = note;
  } else {
    row.closed_at = null;
    row.closed_by = null;
    row.closed_by_name = null;
    row.closure_note = null;
  }
  const w = await checkedWrite(supabase.from("punch_items").update(row).eq("id", input.item.id).select("id"));
  if (!w.ok) return { ok: false, error: w.error };
  await audit("PUNCH_STATUS", input.item.orgId, input.item.projectId, input.actor, {
    itemId: input.item.id, title: input.item.title, from: input.item.status, status: input.status, note,
  });
  return { ok: true };
}
