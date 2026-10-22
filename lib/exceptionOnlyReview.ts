// lib/exceptionOnlyReview.ts
//
// drafting-flow Round G, DF-P26 ISSUING-PATH STOPS — GAP-115 / GAP-109
// mechanism 3, EXCEPTION-ONLY REVIEW (DEC-90 ruling (1) for DF-P26: both
// limbs, one merge, fail-safe).
//
// THE OPT-IN. A document controller marks a routing slot `exception_only`
// (lib/routingControl.ts — a "must sign off" slot that is not the
// engineering sign-off, not an assurance check, not one accepting a standing
// pre-authorization and not the requester's own acceptance). It is frozen on
// the roster slot when a review opens (`exceptionOnly`).
//
// LIMB 1 — SATISFIED AT OPEN BY A RECORDED SYSTEM ACT NAMING THE RULE. When
// a submission opens the review, each such slot is satisfied by the rule
// (`via: "rule"` — no signer, no signature; the history line, the audit row
// and the roster ledger's event name the rule) ONLY when:
//   * the request is not engineered work (the route's engineered-lane answer
//     at submission — which also counts a like-in-kind declaration that
//     could not be checked); never on the engineered lane;
//   * no exception is on record: the request's source has not moved since it
//     was raised (read now), and no examination-data waiver is recorded;
//   * after it, the review still waits on a LIVE sign-off that someone other
//     than the drafter may give now — an open "must sign off" slot that does
//     not accept a standing pre-authorization (so neither silence nor a
//     standing consent can stand in for it). The rule is never the last
//     sign-off a review waits on and never the DEC-12 second person (the
//     producer floor — lib/workflow.ts rosterLacksIndependentSignOff,
//     lib/consentWindow.ts consentFloorHolds, lib/ticketPreauthorization.ts
//     preauthLeavesNoSecondPerson — never counts a slot satisfied by rule);
//   * the database carries 20261268 (exception_only_review_ready() answers):
//     before the paste the ledger cannot record a "rule" satisfaction, so
//     the slot waits for its sign-off — today's review.
// Anything unreadable applies nothing: the slot waits for its sign-off.
//
// LIMB 2 — RE-OPENED BEFORE ANYTHING ISSUES. Every issuing path checks, on a
// roster carrying a slot satisfied by the rule, whether an exception is on
// record NOW — the source revision moved (whatever the approver
// acknowledges), an override sign-off on the roster, an examination-data
// waiver, a like-in-kind declaration whose signature is not on record, the
// request become engineered work — and when one
// is, re-opens that slot for its reviewer in the SAME compare-and-set as the
// act (the act still lands — a sign-off is recorded, a window closes — but
// the request does not issue: it waits on the re-opened slot). Paths: the
// workflow route's roster sign-off (sign_slot — the only issuing act a
// request under a roster has; the serial issuing approvals are not offered
// there, and the route refuses one on such a roster anyway) and the consent
// window's close (lib/consentWindowScan.ts). A read that cannot prove there
// is no exception (the waiver row, the source documents — all of them, by
// readSourceMoved — or the like-in-kind declaration's signature) is a retry
// — 503 on the route, the window waits a run — never a pass, and never an
// exception either (a failed read is not a fact on record).
//
// Default off: a roster with no exception-only slot reads nothing here and
// behaves exactly as before (pinned by A/B sweeps).

import type { Ticket, TicketReviewRoster, TicketReviewSlot } from "@/types/schema";
import { slotSignPlan } from "@/lib/workflow";
import { requesterOnlySlot } from "@/lib/assuranceExamination";
import { parseSourceDocuments, revDrift } from "@/lib/sourceDocRef";

/** The database update that lets the ledger record a "rule" satisfaction
 *  and a "reopened" event. */
export const EXCEPTION_ONLY_MIGRATION = "20261268";
/** Who the rule's ledger events and audit rows name (no person acted). */
export const EXCEPTION_RULE_ACTOR = "System — exception-only review";
/** What a slot satisfied by the rule says it was satisfied by. */
export const RULE_SATISFIED_NAME = "the exception-only rule (no exception on record)";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_READ_CAP = 100;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any; rpc?: (fn: string, args?: Record<string, unknown>) => any };

/** A roster slot the exception-only rule may act on (the opt-in, re-checked
 *  on the frozen slot). Pure. */
export function isExceptionOnlySlot(slot: Pick<TicketReviewSlot, "exceptionOnly" | "mode" | "engineering" | "recordsExamination" | "acceptsPreauthorization" | "primaries">, ticket: Pick<Ticket, "requesterId">): boolean {
  return slot.exceptionOnly === true && slot.mode === "blocking" && slot.engineering !== true
    && slot.recordsExamination !== true && slot.acceptsPreauthorization !== true && !requesterOnlySlot(slot, ticket);
}

/** The slots the rule satisfied (and nobody re-opened). Pure. */
export function ruleSatisfiedSlots(roster: Pick<TicketReviewRoster, "slots"> | null | undefined): TicketReviewSlot[] {
  return roster && Array.isArray(roster.slots) ? roster.slots.filter((s) => s.status === "satisfied" && s.via === "rule") : [];
}

/** True when the roster carries a slot the rule could act on — the only
 *  rosters anything here reads for. Pure. */
export function rosterHasExceptionOnlySlot(roster: Pick<TicketReviewRoster, "slots"> | null | undefined, ticket: Pick<Ticket, "requesterId">): boolean {
  return !!roster && Array.isArray(roster.slots) && roster.slots.some((s) => isExceptionOnlySlot(s, ticket));
}

/** The roster with `kinds` satisfied by the rule at `now`. Pure. */
export function applyExceptionRule(roster: TicketReviewRoster, kinds: readonly string[], now: string): TicketReviewRoster {
  const set = new Set(kinds);
  return {
    ...roster,
    slots: roster.slots.map((s) => (s.status === "open" && set.has(s.kind)
      ? { ...s, status: "satisfied" as const, via: "rule" as const, satisfiedBy: null, satisfiedByName: RULE_SATISFIED_NAME, satisfiedAt: now, signatureId: null }
      : s)),
  };
}

/**
 * Does the roster still wait on a LIVE sign-off someone other than the
 * drafter may give now? An open "must sign off" slot that is not satisfied
 * by any rule or standing consent — mode blocking (never a consent window),
 * not accepting a standing pre-authorization — with an occupant (a primary,
 * never an overrider: an override is itself an exception) whom the engine
 * offers that slot now. Below the DEC-12 threshold, or with no drafter
 * assigned, any such occupant counts. Pure.
 */
export function waitsOnLiveSecondPerson(roster: TicketReviewRoster, ticket: Pick<Ticket, "requesterId" | "assignedDrafterId">, sodActive: boolean, now: number): boolean {
  const drafter = ticket.assignedDrafterId ?? null;
  for (const s of roster.slots) {
    if (s.status !== "open" || s.mode !== "blocking" || s.acceptsPreauthorization === true) continue;
    for (const uid of new Set(s.primaries)) {
      if (!uid || (sodActive && drafter && uid === drafter)) continue;
      if (slotSignPlan(roster, ticket, uid, sodActive, now).fillable.some((f) => f.slot.kind === s.kind && f.via !== "override")) return true;
    }
  }
  return false;
}

/**
 * Which exception-only slots the rule may satisfy when this review opens —
 * each kept only while the review still waits on a live sign-off by someone
 * other than the drafter afterwards (waitsOnLiveSecondPerson); never on
 * engineered work. Pure.
 */
export function planExceptionRule(roster: TicketReviewRoster, ctx: { ticket: Pick<Ticket, "requesterId" | "assignedDrafterId">; sodActive: boolean; engineered: boolean; now: number }): string[] {
  if (ctx.engineered) return [];
  const chosen: string[] = [];
  const at = new Date(ctx.now).toISOString();
  for (const s of roster.slots) {
    if (s.status !== "open" || !isExceptionOnlySlot(s, ctx.ticket)) continue;
    const trial = applyExceptionRule(roster, [...chosen, s.kind], at);
    if (waitsOnLiveSecondPerson(trial, ctx.ticket, ctx.sodActive, ctx.now)) chosen.push(s.kind);
  }
  return chosen;
}

/** One exception on record, as people read it. */
export interface ReviewException { kind: "source_moved" | "override" | "waiver" | "declaration" | "engineered"; text: string }

/** The exceptions on record now (facts already recorded — never a free-text
 *  heuristic). Pure. */
export function exceptionsOnRecord(input: {
  driftLabels: readonly string[];
  roster: Pick<TicketReviewRoster, "slots">;
  waiver: boolean;
  declarationUnverified: string | null;
  engineered: boolean;
}): ReviewException[] {
  const out: ReviewException[] = [];
  if (input.driftLabels.length > 0) out.push({ kind: "source_moved", text: `the source revision has moved since the request was raised (${input.driftLabels.join("; ")})` });
  for (const s of input.roster.slots) {
    if (s.status === "satisfied" && s.via === "override") out.push({ kind: "override", text: `"${s.label || s.kind}" was signed as an override` });
  }
  if (input.waiver) out.push({ kind: "waiver", text: "a waiver of required examination data is recorded" });
  // DF-P26 review fix: only a declaration whose signature is NOT on record
  // is an exception; one that merely could not be READ ("unchecked") is a
  // retry for the caller (the route refuses 503 exception_review_unchecked),
  // never a permanent re-open.
  if (input.declarationUnverified === "missing") out.push({ kind: "declaration", text: "the like-in-kind declaration's signature is not on record" });
  if (input.engineered) out.push({ kind: "engineered", text: "the request is now engineered work" });
  return out;
}

/** The roster with every slot the rule satisfied RE-OPENED for its reviewer
 *  (its satisfaction cleared, the exceptions named on it). Pure. */
export function reopenRuleSatisfied(roster: TicketReviewRoster, exceptions: readonly string[], now: string): TicketReviewRoster {
  return {
    ...roster,
    slots: roster.slots.map((s) => {
      if (s.status !== "satisfied" || s.via !== "rule") return s;
      const rest = { ...s };
      delete rest.satisfiedBy; delete rest.satisfiedByName; delete rest.satisfiedAt; delete rest.signatureId; delete rest.via;
      return { ...rest, status: "open" as const, exceptionReopened: { at: now, exceptions: [...exceptions] } };
    }),
  };
}

/** The history note of a rule satisfaction at open. Pure. */
export function ruleOpenNote(labels: readonly string[]): string {
  return `Satisfied by rule (exception-only review — no exception on record): ${labels.join(", ")}. Re-opened for its reviewer if an exception comes on record before the request issues.`;
}

/** The history note of a re-open. Pure. */
export function ruleReopenNote(labels: readonly string[], exceptions: readonly string[]): string {
  return `Re-opened for its reviewer: ${labels.join(", ")} — exception-only review no longer stands because ${exceptions.join("; ")}. The request does not issue until it is signed.`;
}

/** Does the database carry 20261268? (exception_only_review_ready()
 *  answers true.) Anything else — the function missing (PGRST202 / 42883),
 *  an error, a throw — is "no": the rule applies nothing. */
export async function exceptionOnlyReady(db: Db): Promise<boolean> {
  if (typeof db.rpc !== "function") return false;
  try {
    const { data, error } = await db.rpc("exception_only_review_ready");
    return !error && data === true;
  } catch {
    return false;
  }
}

/** Is an examination-data waiver recorded on the request? Before 20261266
 *  (the table missing) none can be. */
export async function readWaiverOnRecord(db: Db, ticketId: string): Promise<{ ok: true; waiver: boolean } | { ok: false; error: string }> {
  try {
    const { data, error } = await db.from("ticket_examination_scopes").select("waiver").eq("ticket_id", ticketId).maybeSingle();
    if (error) {
      const code = String((error as { code?: string }).code ?? "");
      if (code === "42P01" || code === "PGRST205") return { ok: true, waiver: false };
      return { ok: false, error: (error as { message?: string }).message || "unreadable" };
    }
    const w = (data as { waiver?: unknown } | null)?.waiver;
    return { ok: true, waiver: !!w && typeof w === "object" && !Array.isArray(w) };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

/** The request's source documents' drift now, as the route reads it for an
 *  issuing act (lib/workflowAuthority.ts): each moved one labelled. A read
 *  that fails, or more sources than one read takes, is "unchecked". */
export async function readSourceMoved(db: Db, ticket: Pick<Ticket, "metadata" | "orgId">): Promise<{ ok: true; labels: string[] } | { ok: false; error: string }> {
  const refs = parseSourceDocuments(ticket.metadata as Record<string, unknown> | null | undefined).filter((r) => UUID_RE.test(r.id));
  if (refs.length === 0) return { ok: true, labels: [] };
  if (refs.length > SOURCE_READ_CAP) return { ok: false, error: "more source documents than one read takes" };
  try {
    const { data, error } = await db.from("documents").select("id, rev, current_version_id, document_number").eq("org_id", ticket.orgId).in("id", refs.map((r) => r.id));
    if (error) return { ok: false, error: (error as { message?: string }).message || "unreadable" };
    const live = new Map(((data ?? []) as Array<{ id: string; rev: string | null; current_version_id: string | null; document_number: string | null }>).map((d) => [d.id, d]));
    const labels: string[] = [];
    for (const ref of refs) {
      const d = live.get(ref.id);
      if (!d) continue;
      if (revDrift({ versionId: ref.versionId, rev: ref.rev }, { versionId: d.current_version_id, rev: d.rev }) === "drifted") {
        labels.push(`${ref.documentNumber || d.document_number || "a source document"}${ref.rev ? ` raised on Rev ${ref.rev}` : ""}, now Rev ${d.rev ?? "—"}`);
      }
    }
    return { ok: true, labels };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

/** What the rule did when a review opened (for the audit row and history). */
export type ExceptionRuleAtOpen =
  | { applied: true; roster: TicketReviewRoster; kinds: string[]; labels: string[] }
  | { applied: false; roster: TicketReviewRoster; reason: "engineered" | "no_live_sign_off" | "not_migrated" | "source_moved" | "waiver" | "unchecked"; kinds: string[] };

/**
 * Limb 1, at a submission that opened `roster`: satisfy the exception-only
 * slots the rule may (planExceptionRule) when no exception is on record and
 * 20261268 is in place. Reads only when the roster carries such a slot (the
 * caller checks rosterHasExceptionOnlySlot first). Never throws; anything
 * unreadable applies nothing.
 */
export async function exceptionRuleAtOpen(db: Db, input: { roster: TicketReviewRoster; ticket: Ticket; ticketId: string; sodActive: boolean; engineered: boolean; now: number }): Promise<ExceptionRuleAtOpen> {
  const { roster, ticket } = input;
  const candidates = roster.slots.filter((s) => s.status === "open" && isExceptionOnlySlot(s, ticket)).map((s) => s.kind);
  if (input.engineered) return { applied: false, roster, reason: "engineered", kinds: candidates };
  const plan = planExceptionRule(roster, { ticket, sodActive: input.sodActive, engineered: false, now: input.now });
  if (plan.length === 0) return { applied: false, roster, reason: "no_live_sign_off", kinds: candidates };
  if (!(await exceptionOnlyReady(db))) return { applied: false, roster, reason: "not_migrated", kinds: candidates };
  const drift = await readSourceMoved(db, ticket);
  if (!drift.ok) return { applied: false, roster, reason: "unchecked", kinds: candidates };
  if (drift.labels.length > 0) return { applied: false, roster, reason: "source_moved", kinds: candidates };
  const waiver = await readWaiverOnRecord(db, input.ticketId);
  if (!waiver.ok) return { applied: false, roster, reason: "unchecked", kinds: candidates };
  if (waiver.waiver) return { applied: false, roster, reason: "waiver", kinds: candidates };
  const applied = applyExceptionRule(roster, plan, new Date(input.now).toISOString());
  return { applied: true, roster: applied, kinds: plan, labels: plan.map((k) => roster.slots.find((s) => s.kind === k)?.label || k) };
}
