import { Role, TicketStatus, Ticket, type TicketReviewRoster, type TicketReviewSlot } from "@/types/schema";
import { policyAllows, scopedTokensFor, grantActive, type CapabilityPolicy, type CapabilityResource, type UserGrant } from "@/lib/capabilityPolicy";
import { isManagementRole } from "@/lib/managementRoles";
import { CANCEL_OUTCOMES, type TicketOutcome } from "@/lib/ticketOutcome";
import { ticketEngineeringRequired, reviewModelBinds, isDeclaredLikeInKind } from "@/lib/reviewModel";

export interface WorkflowAction {
  label: string;
  action: string;
  variant: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link' | 'success' | 'warning';
  requiresFile?: boolean;
  requiresComment?: boolean;
  requiresEngineerPick?: boolean;   // UI Guard: open the engineer-picker modal first
  description?: string;
  /** GAP-2/DEC-12: set when separation-of-duties blocks this action for THIS
   *  actor. The action renders DISABLED with this explanation (a missing
   *  button is indistinguishable from a bug), and the server route refuses
   *  it with the same message. */
  disabledReason?: string;
  /** WF-24: the action is AVAILABLE but the ticket is not waiting on THIS
   *  actor for it — a management override of an assigned reviewer, a
   *  reassignment, a cancellation, a reopen, a file attachment, force close.
   *  The attention feed (lib/ticketAttention.ts) derives "must act" from the
   *  engine and ignores optional actions, so the badge and the ticket page
   *  agree by construction. */
  optional?: boolean;
  /** LEAK-9 / GAP-107 (DF-P3): the action ends the request and must say HOW
   *  — one of `outcomes` (lib/ticketOutcome.ts), beside the comment that
   *  carries the free text. The workflow route validates it. */
  requiresOutcome?: boolean;
  /** The outcomes this action may record (with `requiresOutcome`). */
  outcomes?: readonly TicketOutcome[];
  /** DF-P5 ROSTER (GAP-103, EVID-12): the action carries an e-signature
   *  minted by /api/signatures/sign against the ticket and bound to the
   *  roster's content hash — the roster panel runs the ceremony, then posts
   *  the action with `signatureId`. */
  requiresSignature?: boolean;
  /** SM-3 (DF-P6, DEC-90 ruling (3)): taking this action on THIS ticket is a
   *  management OVERRIDE of the engineering sign-off — the ticket requires
   *  engineering review and the actor holds no Engineer role and does not
   *  occupy the engineer's place. The route records it as an override
   *  (history line, audit `authority.override`) and never stamps
   *  engineer_approved_at for it. */
  engineeringOverride?: boolean;
  /** DF-P6 fix pass 4 (review, minor 5): this action issues WITHOUT an
   *  engineer's sign-off although the request does not require one — a
   *  manager issuing from PENDING_FINAL_APPROVAL a request that was sent to
   *  an engineer only because a type-scoped `ticket.direct_approve` rule
   *  kept its requester from approving. Never stamps engineer_approved_at,
   *  and is recorded neutrally: no override marker, no override wording. */
  withoutEngineerSignOff?: boolean;
  /** HAND-7 done-when 3 (DF-P6): the request's source document has moved to
   *  a newer revision since the request was raised — approving it asks for
   *  an explicit acknowledgement (`sourceDriftAcknowledged` on the request),
   *  which the history line and the audit row record. */
  requiresSourceDriftAck?: boolean;
}

/** Optional evaluation context for getActions (WF-7, GAP-2, WF-15).
 *  Everything is optional and absent values reproduce prior behavior, so
 *  existing callers stay correct while the route and the ticket page pass
 *  the full picture. */
export interface WorkflowContext {
  /** WF-7: the member's FULL additive role collection. Authority must be
   *  identical whether a role is the headline or an additive one. */
  userRoles?: Role[];
  /** GAP-2/DEC-12: the org's active member count. The independence
   *  predicates enforce at >= 3; below that the single-person loop is
   *  legitimate (a two-person shop has nobody else to route to). */
  activeMemberCount?: number;
  /** WF-15: request types allowed to close from DRAFTING without review —
   *  a property of the CONFIGURED type, not a hardcoded string. Defaults to
   *  ['RFI'] (the historical behavior). */
  closeWithoutReviewTypes?: string[];
  /** DEC-16 / WF-12 / DRAFT-3: the requester's CURRENT role collection (their
   *  org_members row today), when known. The engineer gate requires approval
   *  if EITHER the snapshot stamped at filing OR the current collection says
   *  so — the snapshot can only fail closed, never open. `null` / undefined =
   *  unknown (snapshot decides); `[]` = known to hold nothing (required). */
  requesterRoles?: readonly string[] | null;
  /** DRAFT-2: request types the org marked "engineering first" — a ticket of
   *  such a type cannot be assigned (or picked up) until engineering has
   *  been in the loop. A property of the CONFIGURED type, read from the same
   *  option list as `closeWithoutReviewTypes`. Absent = no type is gated. */
  engineeringFirstTypes?: string[];
  /** DF-P5: the clock a roster's alternates are activated against (ms since
   *  the epoch). Absent = now. */
  now?: number;
  /** TIER-5 (DF-P5 fix pass 3): the ticket's library routes its reviews (a
   *  routing table on its chain, and the 20261242 ledger there). A routed
   *  ticket in review WITHOUT a roster (reopened, or in review before the
   *  table was declared) is never approved on the serial path: those
   *  approvals are rendered disabled with ROUTED_NO_ROSTER_REASON and the
   *  route refuses them (409). Absent / false = today's behaviour. */
  reviewRouted?: boolean;
  /** DF-P5 fix pass 4: the reason those approvals are disabled with, when
   *  it is not ROUTED_NO_ROSTER_REASON — a routing table that cannot be used
   *  (routedNoRosterReason), where a revision would be refused too. */
  reviewRoutedReason?: string | null;
  /** HAND-7 done-when 3 (DF-P6): the source documents whose register
   *  revision has moved since the request was raised, as a person reads
   *  them ("P-101 (now Rev 4)"). Absent / empty = none known to have moved
   *  (a read that could not be made says nothing — never "moved"). */
  sourceDrift?: readonly string[] | null;
  /** DF-P6 fix pass (review, issues 1 and 2): can the ticket's requester
   *  pick an engineer at all — does the workspace hold an active member the
   *  engineer pick accepts (lib/ticketPage.ts engineerCandidates, less the
   *  people the pick refuses in orgs of 3+: the requester, the drafter, the
   *  picker)? `false` = KNOWN that nobody can be picked; absent / true =
   *  assume someone can (the strict reading). The route and the request page
   *  compute it only where it decides something: the requester holds
   *  `ticket.manage`, the request requires engineering review, and it is in
   *  review. */
  engineerPickAvailable?: boolean;
}

/** DF-P6 fix pass 3 (review, minor): what "Flag for Engineering Review"
 *  says when it BINDS — on a request filed under the review model that does
 *  not yet require engineering, request_eng_review raises
 *  engineering_required, and the database refuses the way back. */
export const FLAG_ENG_REVIEW_BINDS_DESCRIPTION = "Optional: route to a specific engineer for scope review before a drafter is assigned. This also makes an engineer's sign-off required before the request issues, and that cannot be withdrawn.";
/** The description a co-reviewer's override at PENDING_REVIEW carries
 *  (fix pass 3, review minor): said before the click, as at
 *  PENDING_FINAL_APPROVAL. */
export const CO_REVIEW_OVERRIDE_NOTE = "Recorded as an override in the history and the audit trail; the engineering sign-off stays unrecorded.";

/** DF-P6 fix pass 4 (review, major 2 — DEC-90 ruling (3) as given): a
 *  requester holding `ticket.manage` may override the engineering sign-off
 *  on their own request, as a manager can today; it is recorded as an
 *  override, and the requester says why (a required comment). The
 *  sentence the action's description carries. */
export const SELF_OVERRIDE_NOTE = "You asked for this work: say why in the comment — it is recorded with the override.";

/** DF-P6 fix pass (review, issue 1): why "Send for Engineer Final Approval"
 *  cannot go when nobody can be picked as the engineer. */
export const NO_ENGINEER_TO_PICK_REASON = "Nobody in this workspace can be picked as the reviewing engineer (an Engineer role, and not the requester or the drafter in orgs of 3+). An Admin can add an Engineer role to someone in Admin → Users; until then a manager may issue it as a recorded override.";

/** DEC-13 stage 2: the RESOURCE a ticket presents to the capability policy —
 *  its request type and unit. The route, the page and the simulator all
 *  build it from here, so a type-scoped rule reads the same fields
 *  everywhere. (`discipline` is not a ticket property. `libraryId` is —
 *  `tickets.library_id`, GAP-105 / DF-P4 — but it is deliberately NOT in the
 *  resource yet: the request page and the attention badge build their Ticket
 *  without it, so a `when.libraryId` rule would govern the route and not the
 *  screens, and a stored library rule on a ticket.* capability would start
 *  matching backfilled tickets with no inventory. DF-P5 adds it together with
 *  those mappers and that inventory — 99-fix-sequencing "Hand-offs from
 *  DF-P4".) */
// DF-P6 fix pass (review, issue 6): the library, the work class and the code
// class stay OUT of the resource for the reason above — the requests list
// and lib/inbox.ts still build their Ticket without them (the attention
// badge), so a rule scoped on any of them would govern the route and the
// request page and not the badge. They join with those mappers
// (99-fix-sequencing "Hand-offs from DF-P6": the mappers spread
// lib/reviewModel.ts reviewModelFieldsFromRow). The evaluator already reads
// workClass / codeClass (lib/capabilityPolicy.ts TICKET_RESOURCE_KEYS), and
// 20261250's inventory counts any stored ticket.* rule scoped on them.
export function ticketResource(ticket: Pick<Ticket, "requestType" | "unit">): CapabilityResource {
  return { requestType: ticket.requestType || null, unit: ticket.unit || null };
}

/** TIER-1 / DEC-33 (DF-P6): is engineering review required before THIS
 *  request may issue? The column (lib/reviewModel.ts ticketEngineeringRequired)
 *  where it can speak for the ticket; today's role-based gate — the SEED,
 *  engineerApprovalRequired, evaluated live — where it cannot (before
 *  20261250, and the undeclared rows that predate it). The engine, the
 *  workflow route (and the roster it opens) and the roster panel share it. */
export function engineeringGateRequired(
  ticket: Ticket,
  currentRoles?: readonly string[] | null,
  policy?: CapabilityPolicy | null,
): boolean {
  return ticketEngineeringRequired(ticket, () => engineerApprovalRequired(ticket.requesterRole, currentRoles, policy, ticket.requesterId, ticketResource(ticket)));
}

/** DF-P6 fix pass 5 (review, minor): do the requester-binding limbs of
 *  DEC-33 (the requester's recorded override with its comment, the
 *  engineer-pick question) apply to this request? On a request filed under
 *  the review model whose column says engineering is required
 *  (lib/reviewModel.ts reviewModelBinds) — and on a pre-paste row whose
 *  requirement was RAISED after the paste (the assigner's flag_engineering,
 *  or an engineering class): its column says required while today's
 *  role-based gate says not. The backfill sets true only where that gate
 *  requires an engineer, so a row it set keeps today's paths exactly while
 *  that gate still requires one (DEC-90 ruling (2)); if the gate later stops
 *  requiring one (the requester promoted or reactivated, an exempt list or
 *  grant stored), the row stays required (fail-safe) and this applies to it
 *  too — its manager requester gets the recorded override with a required
 *  comment (the DF-P6 merge, review minor). A raised row is the one today's
 *  engine let its requester approve directly, and without this its manager
 *  requester could be left with only "Send for Engineer Final Approval" and
 *  nobody to pick. */
export function requesterBindingApplies(
  ticket: Ticket,
  requesterRoles: readonly string[] | null | undefined,
  policy: CapabilityPolicy | null | undefined,
): boolean {
  if (reviewModelBinds(ticket)) return true;
  return ticket.engineeringRequired === true
    && !engineerApprovalRequired(ticket.requesterRole, requesterRoles, policy, ticket.requesterId, ticketResource(ticket));
}

/** DF-P6: the actions that issue (or, at final approval, sign off) a
 *  deliverable — the delivery gate's transitions (DEC-33), and the ones an
 *  approval over a moved source asks to acknowledge (HAND-7). */
export const ISSUING_APPROVALS: ReadonlySet<string> = new Set(['approve_draft_ifc', 'approve_minor_correction', 'engineer_approve_final', 'override_engineer_final']);

/** DF-P6 fix pass (review, issues 1 and 2): does `WorkflowContext.
 *  engineerPickAvailable` decide anything for this caller on this ticket?
 *  Only for the requester who holds `ticket.manage`, on a request filed
 *  under the review model whose column says engineering review is required
 *  (lib/reviewModel.ts reviewModelBinds), in serial review. The route and the request
 *  page read the members (and set the flag) exactly when this is true, so
 *  both evaluate the engine on the same context. */
export function engineerPickQuestionApplies(
  ticket: Ticket,
  uid: string | null | undefined,
  userRole: Role,
  userRoles: readonly Role[] | null | undefined,
  policy: CapabilityPolicy | null | undefined,
  requesterRoles: readonly string[] | null | undefined,
): boolean {
  if (!uid || ticket.requesterId !== uid) return false;
  // Only on a request FILED under the review model whose column says
  // engineering is required (fix pass 2, review issue 1: a pre-paste row
  // the backfill set true keeps today's path exactly — no read, no flag).
  // Fix pass 5 (review, minor): and on a pre-paste row whose requirement
  // was raised after the paste (requesterBindingApplies).
  if (!requesterBindingApplies(ticket, requesterRoles, policy)) return false;
  if (ticket.status !== 'PENDING_REVIEW' && ticket.status !== 'PENDING_FINAL_APPROVAL') return false;
  if (currentRoster(ticket)) return false;
  if (!policyAllows(policy, 'ticket.manage', userRole, userRoles && userRoles.length > 0 ? [...userRoles] : null, uid, ticketResource(ticket))) return false;
  return engineeringGateRequired(ticket, requesterRoles, policy);
}

/** DEC-12 threshold: independence appears exactly when it becomes possible
 *  to honour. */
export function separationOfDutiesActive(activeMemberCount?: number): boolean {
  return (activeMemberCount ?? 0) >= 3;
}

// ─── ROLE HELPERS ────────────────────────────────────────────────────────
// Centralised so the workflow + UI don't disagree on what counts as
// "qualified to approve engineering work."
// DEC-35 (DF-P5): these name-matching helpers are QUARANTINED as the seeded
// default routing (lib/routingControl.ts SEEDED_ROUTING) — the behaviour of
// an org that configured no routing table. They are not deleted and new
// routing code never calls them: a configured routing table names its slots'
// fill as data.

export function isEngineerRole(role?: Role | string): boolean {
  return !!role && role.includes("Engineer");
}

// WF-24 / CHAIN-3: the management tier is defined ONCE, in
// lib/managementRoles.ts; the engine, the capability defaults and the
// attention feed all read that definition.
export { isManagementRole };

export function isDocCtrlRole(role?: Role | string): boolean {
  return role === "DocCtrl";
}

/**
 * DEC-16 (WF-12 / DRAFT-3): the engineer gate, evaluated against BOTH the
 * role snapshot stamped on the ticket at filing AND the requester's current
 * role collection. Required if either requires it. The snapshot is a
 * historical record and is never refreshed; the current collection is
 * looked up at evaluation time by the workflow route (authoritative) and,
 * best-effort, by the ticket page. Unknown current (`null`/`undefined`) lets
 * the snapshot decide; a known-empty current collection (the requester is no
 * longer an active member) requires an engineer.
 *
 * DEC-13 stage 3: WHICH roles are exempt is the org's
 * `ticket.engineer_gate_exempt` capability (default: management, every
 * Engineer tier, DocCtrl — byte-identical to the historical hardcoded test),
 * so `policy` / `requesterId` / `resource` select the org's list, honour a
 * personal grant of it, and let a request-type override narrow it. The
 * disjunction above is NOT configurable: the capability only decides who is
 * exempt, never whether the snapshot OR current test runs.
 */
export function engineerApprovalRequired(
  snapshotRole?: Role | string | null,
  currentRoles?: readonly string[] | null,
  policy?: CapabilityPolicy | null,
  requesterId?: string | null,
  resource?: CapabilityResource | null,
): boolean {
  const bySnapshot = requiresEngineerApproval(snapshotRole ?? undefined, null, policy, requesterId, resource);
  if (currentRoles === null || currentRoles === undefined) return bySnapshot;
  const byCurrent = currentRoles.length === 0
    ? true
    : requiresEngineerApproval(undefined, currentRoles, policy, requesterId, resource);
  return bySnapshot || byCurrent;
}

/**
 * Returns true when a requester with this role MUST route their PENDING_REVIEW
 * approval through an engineer. The exempt roles are the org's
 * `ticket.engineer_gate_exempt` list (DEC-13 stage 3); with no policy the
 * shipped default applies — Engineers and Management approve directly and
 * DocCtrl is included with management for IFC sign-off purposes. Drafter is
 * borderline — excluded by default since drafters approving their own work as
 * requester is a separate antipattern. No role at all fails closed.
 */
export function requiresEngineerApproval(
  requesterRole?: Role | string,
  requesterRoles?: readonly string[] | null,
  policy?: CapabilityPolicy | null,
  requesterId?: string | null,
  resource?: CapabilityResource | null,
): boolean {
  // ADD-3: when the requester's full collection is known, ANY held exempt
  // role waives the engineer route — relevance, not rank.
  if (requesterRoles && requesterRoles.length > 0) {
    if (policyAllows(policy, 'ticket.engineer_gate_exempt', null, [...requesterRoles], requesterId, resource)) return false;
  }
  if (!requesterRole) return true;
  return !policyAllows(policy, 'ticket.engineer_gate_exempt', requesterRole, null, requesterId, resource);
}

/** WF-16: the personal grants WITHOUT WHICH this actor would not be offered
 *  `actionName` — evaluated by re-running the state machine with each of the
 *  actor's live grants removed in turn (a grant that is merely redundant with
 *  their roles is not named). Empty = the action came from a role or from
 *  identity. Pure; the workflow route writes the result into the audit row. */
export function decisiveGrants(
  ticket: Ticket, userRole: Role, userId: string, policy: CapabilityPolicy | undefined, ctx: WorkflowContext | undefined, actionName: string,
): UserGrant[] {
  const mine = (policy?.grants ?? []).filter((g) => g.uid === userId && grantActive(g));
  if (mine.length === 0) return [];
  const offers = (p: CapabilityPolicy | undefined) => WorkflowEngine.getActions(ticket, userRole, userId, p, ctx).some((a) => a.action === actionName);
  const without = (drop: (g: UserGrant) => boolean): CapabilityPolicy => ({ ...(policy ?? {}), grants: (policy?.grants ?? []).filter((g) => !drop(g)) });
  const decisive = mine.filter((g) => !offers(without((x) => x === g)));
  if (decisive.length > 0) return decisive;
  // Two grants each sufficient on their own: neither is individually
  // decisive, but together they are — name them all.
  return offers(without((g) => g.uid === userId)) ? [] : mine;
}

// ─── DF-P5 ROSTER (GAP-103 / GAP-112 / DEC-37) ───────────────────────────
// A ticket whose library declares a routing table reviews on a PARALLEL
// roster: the workflow route opens it when the draft enters PENDING_REVIEW
// (`metadata.review_roster`, written compare-and-set with the status), every
// unsatisfied blocking slot is offered to its occupants at once, and the
// ticket issues when the last blocking slot is satisfied — one wait state
// however many slots there are. A ticket with no roster (every ticket of an
// org that configured nothing) runs the serial machine below, unchanged.

/** The roster under review now, or null (legacy path). Current only while
 *  the ticket is in PENDING_REVIEW and the roster has not been closed. */
export function currentRoster(ticket: Pick<Ticket, "status" | "metadata">): TicketReviewRoster | null {
  if (ticket.status !== "PENDING_REVIEW") return null;
  const r = (ticket.metadata as Record<string, unknown> | undefined)?.review_roster as TicketReviewRoster | undefined;
  if (!r || typeof r !== "object" || r.v !== 1 || !Array.isArray(r.slots) || r.closedAt) return null;
  return r;
}

/** A slot the ticket waits on (consent_window waits like blocking until
 *  consent windows exist — DEC-38). */
export const slotBlocks = (s: Pick<TicketReviewSlot, "mode">): boolean => s.mode !== "notify_only";

const DAY_MS = 86_400_000;

/** Has `slot`'s alternate window opened (its timeoutDays elapsed since the
 *  roster opened)? The one rule slotSignPlan and rosterPartialReleased share
 *  (DF-P5 fix pass 5). */
export function slotAlternatesActive(
  roster: Pick<TicketReviewRoster, "openedAt">,
  slot: Pick<TicketReviewSlot, "timeoutDays">,
  now: number,
): boolean {
  const opened = Date.parse(roster.openedAt);
  return slot.timeoutDays !== null && Number.isFinite(opened) && now >= opened + slot.timeoutDays * DAY_MS;
}

export interface SlotSignPlan {
  /** The open blocking slots this actor's ONE sign-off satisfies now. */
  fillable: Array<{ slot: TicketReviewSlot; via: "primary" | "alternate" | "override" }>;
  /** Slots this actor occupies but may not sign, each with the reason
   *  (DEC-37: the independence constraint that blocked it, named). */
  blocked: Array<{ slot: TicketReviewSlot; reason: string }>;
}

/**
 * Which open blocking slots `uid` may sign now, and which they occupy but
 * may not (DEC-37: one person satisfies every slot they can fill, in one
 * action; independence is a property of the SLOT, enforced at the DEC-12
 * threshold). Pure — the engine, the route and the roster panel share it.
 */
export function slotSignPlan(
  roster: TicketReviewRoster,
  ticket: Pick<Ticket, "requesterId" | "assignedDrafterId">,
  uid: string | null | undefined,
  sodActive: boolean,
  now: number = Date.now(),
): SlotSignPlan {
  const plan: SlotSignPlan = { fillable: [], blocked: [] };
  if (!uid) return plan;
  const fillsKind = (kind: string): boolean =>
    roster.slots.some((s) => s.kind === kind && s.status === "satisfied" && s.satisfiedBy === uid)
    || plan.fillable.some((f) => f.slot.kind === kind);
  for (const slot of roster.slots) {
    if (slot.status !== "open" || !slotBlocks(slot)) continue;
    const alternateActive = slotAlternatesActive(roster, slot, now);
    const via = slot.primaries.includes(uid) ? "primary" as const
      : alternateActive && slot.alternates.includes(uid) ? "alternate" as const
      : slot.overriders.includes(uid) ? "override" as const
      : null;
    if (!via) continue;
    const label = slot.label || slot.kind;
    let reason: string | null = null;
    if (sodActive) {
      for (const k of slot.independentOf) {
        if (k === "drafter" && uid === ticket.assignedDrafterId) {
          reason = `Needs a second person: "${label}" must be independent of the drafter, and you are this deliverable's drafter (orgs of 3+).`;
        } else if (k === "requester" && uid === ticket.requesterId) {
          reason = `Needs a second person: "${label}" must be independent of the requester, and you asked for this work (orgs of 3+).`;
        } else if (k !== "drafter" && k !== "requester" && fillsKind(k)) {
          const other = roster.slots.find((s) => s.kind === k);
          reason = `Needs a second person: "${label}" must be independent of "${other?.label || k}", which you sign (orgs of 3+).`;
        }
        if (reason) break;
      }
      if (!reason) {
        // The constraint read from the other side: a slot this actor fills
        // (or is filling now) that declares itself independent of THIS one.
        const conflict = roster.slots.find((s) => s.kind !== slot.kind && s.independentOf.includes(slot.kind) && fillsKind(s.kind));
        if (conflict) reason = `Needs a second person: "${conflict.label || conflict.kind}", which you sign, must be independent of "${label}" (orgs of 3+).`;
      }
    }
    if (reason) plan.blocked.push({ slot, reason });
    else plan.fillable.push({ slot, via });
  }
  // DEC-12 / DEC-37 acceptance 2 — the producer-versus-checker FLOOR, held
  // whatever the routing table declares: above the threshold the drafter
  // may not be the one whose sign-off completes the review unless somebody
  // else has already satisfied a blocking slot. The drafter may still sign
  // the slots they occupy, but one stays open for a second person.
  if (sodActive && ticket.assignedDrafterId && uid === ticket.assignedDrafterId && plan.fillable.length > 0
    && rosterLacksIndependentSignOff(roster, uid, plan.fillable.map((f) => f.slot.kind))) {
    const others = (s: TicketReviewSlot) => [...s.primaries, ...s.alternates, ...s.overriders].some((u) => u !== uid);
    const idx = [...plan.fillable.keys()].reverse().find((i) => others(plan.fillable[i].slot)) ?? plan.fillable.length - 1;
    const [held] = plan.fillable.splice(idx, 1);
    plan.blocked.push({ slot: held.slot, reason: PRODUCER_FLOOR_REASON });
  }
  return plan;
}

/** When a completed roster's engineering approval was given: the latest
 *  sign-off among its satisfied engineering slots (lib/ticketRoster.ts
 *  marks a slot `engineering` from its fill's capability), or null when the
 *  roster has none — the roster itself is then the record of who signed. */
export function rosterEngineerApprovedAt(roster: TicketReviewRoster): string | null {
  const at = roster.slots.filter((s) => s.engineering && s.status === "satisfied" && s.satisfiedAt).map((s) => s.satisfiedAt as string).sort();
  return at.length > 0 ? at[at.length - 1] : null;
}

export const PRODUCER_FLOOR_REASON = "Needs a second person: you are this deliverable's drafter, and at least one sign-off on its review must come from someone else (orgs of 3+).";

/**
 * True when the roster would be complete with `signing` satisfied by `uid`
 * and NO blocking slot satisfied by anyone else — the case the
 * producer-versus-checker floor refuses (DEC-12 / DEC-37). Pure.
 */
export function rosterLacksIndependentSignOff(roster: TicketReviewRoster, uid: string, signing: readonly string[] = []): boolean {
  const blocking = roster.slots.filter((s) => slotBlocks(s) && s.status !== "void");
  const completes = blocking.every((s) => s.status === "satisfied" || signing.includes(s.kind));
  const independent = blocking.some((s) => s.status === "satisfied" && !!s.satisfiedBy && s.satisfiedBy !== uid);
  return completes && !independent;
}

/** FRIC-5: the drafter marked the draft under review issue-ready — the last
 *  approval issues it as the final package (no second upload). Bound to the
 *  revision label it was marked on, so a new submission clears it. */
export function issueReadyFor(ticket: Pick<Ticket, "metadata" | "deliverableRev">): boolean {
  const mark = (ticket.metadata as Record<string, unknown> | undefined)?.issue_ready as { rev?: unknown } | undefined;
  return !!ticket.deliverableRev && typeof mark?.rev === "string" && mark.rev === ticket.deliverableRev;
}

/** EVID-12 (DF-P5 fix pass 2): the files a roster binds by identity only
 *  (not by content — lib/ticketRoster.ts rosterBinding), as a person reads
 *  them; named on the roster panel and in every sign-off statement. Here,
 *  not in lib/ticketRoster.ts, because the panel is a client component and
 *  that module hashes with node:crypto. */
export function unhashedFilesNote(roster: Pick<TicketReviewRoster, "files">): string | null {
  const un = (roster.files ?? []).filter((f) => !f.sha256);
  if (un.length === 0) return null;
  return `Bound by name, storage location and size only — too large or too slow to fingerprint when the review opened: ${un.map((f) => `${f.name ?? "a file"} (${f.unhashed ?? "not hashed"})`).join(", ")}.`;
}

export const ISSUE_AS_IS_NOTE = "The drafter marked this draft issue-ready: approving it issues the approved draft as the final package — no second upload.";

/** FRIC-5 (DF-P5 fix pass 2): the approvals that issue a marked draft
 *  as-is (lib/ticketTransitions.ts asIsIssue) — a minor correction still
 *  returns the request to the drafter. */
export const ISSUE_AS_IS_APPROVALS: ReadonlySet<string> = new Set(['approve_draft_ifc', 'engineer_approve_final', 'override_engineer_final']);

/** FRIC-5: the question an approver answers before an approval that issues
 *  the draft as-is — null for every other action, and whenever the drafter
 *  has not marked the draft under review. The request page asks it in a
 *  confirm dialog; the roster panel puts the note in the signed statement. */
export function issueAsIsConfirmation(action: Pick<WorkflowAction, 'action'>, ticket: Pick<Ticket, 'metadata' | 'deliverableRev'>): string | null {
  if (!ISSUE_AS_IS_APPROVALS.has(action.action) || !issueReadyFor(ticket)) return null;
  return `${ISSUE_AS_IS_NOTE} The request goes straight to the issued package (Rev ${ticket.deliverableRev} as the Final) — there is no separate step where the drafter uploads the stamped file. Approve and issue as-is?`;
}

/** FRIC-5: the banner the request page shows while a marked draft waits on
 *  a SERIAL approval (a routed review shows the note on its roster panel). */
export function issueAsIsBanner(ticket: Pick<Ticket, 'metadata' | 'deliverableRev' | 'status'>): string | null {
  if (ticket.status !== 'PENDING_REVIEW' && ticket.status !== 'PENDING_FINAL_APPROVAL') return null;
  if (!issueReadyFor(ticket) || currentRoster(ticket)) return null;
  return ISSUE_AS_IS_NOTE;
}

/** TIER-5 (DF-P5 fix pass 3): the serial approvals a routed ticket with no
 *  roster may not take — each would issue (or route to an issue) without the
 *  slots its library's routing table declares (DEC-36: fail closed). */
export const ROSTERLESS_APPROVALS: ReadonlySet<string> = new Set(['approve_draft_ifc', 'approve_minor_correction', 'request_final_engineer_approval', 'engineer_approve_final', 'override_engineer_final']);

export const ROUTED_NO_ROSTER_REASON = "This request's library routes its reviews, and this review has no sign-off roster (it was reopened, or was already in review when the routing was set). Request a revision so the drafter resubmits — the submission opens the review with every sign-off the routing names.";

/** DF-P5 fix pass 4: why a routed review with no roster cannot be approved,
 *  from the routing that applies. A table that cannot be used refuses the
 *  resubmission too (routing_invalid), so the way forward is the document
 *  controller, not a revision. */
export function routedNoRosterReason(routing?: { state: string; level?: string; error?: string } | null): string {
  if (routing?.state !== 'invalid') return ROUTED_NO_ROSTER_REASON;
  const where = routing.level === 'collection' ? 'folder' : routing.level || 'library';
  return `The review routing set on this request's ${where} can't be used (${routing.error || 'it is malformed'}), so this review can't be approved, and a resubmission would be refused too. Ask a document controller to correct the routing.`;
}

/** DF-P5 fix pass 4: what the request page says for a 409 from
 *  /api/tickets/workflow-action. A refusal that carries its own code (the
 *  routing needs a roster, an unconfirmed issue-as-is, a routing table that
 *  cannot be used, nothing to review…) is SAID, with its way forward; null
 *  for the compare-and-set conflict (`conflict: true`), a hold to resolve
 *  (`holds_open`, handled before this) or a body without a code — those
 *  keep the "someone else updated it" message. */
export function workflowRefusalMessage(body: unknown): string | null {
  const j = (body && typeof body === 'object' ? body : {}) as { code?: unknown; error?: unknown; conflict?: unknown };
  if (j.conflict === true || typeof j.code !== 'string' || !j.code || j.code === 'holds_open') return null;
  return typeof j.error === 'string' && j.error.trim() ? j.error : null;
}

/** UI-4 (DF-P5 fix pass 2): the drafter's optional issue-as-is mark /
 *  withdrawal — offered beside the "who this waits on" note, never in place
 *  of it (an optional mark is not something the request waits for). */
export const ISSUE_MARK_ACTIONS: ReadonlySet<string> = new Set(['mark_issue_ready', 'clear_issue_ready']);

export const WorkflowEngine = {
  // Every new request lands in the assignment queue — routed to the
  // DraftingSupervisor if one is set, otherwise Admins. Engineering review is
  // a branch the assigner triggers via "Flag for Engineering Review"; a
  // request TYPE can make that branch mandatory (`engineeringFirst`, DRAFT-2),
  // which gates assignment rather than changing the entry status. DRAFT-2:
  // the former (type, role) parameters were never read — the signature no
  // longer implies a routing capability that does not exist.
  getInitialStatus: (): TicketStatus => 'PENDING_ASSIGNMENT',

  // State Machine: Returns valid buttons/actions for the current User and
  // Ticket state. `policy` is the org's capability policy — omitted (client
  // paths that haven't loaded it) it falls back to the shipped defaults,
  // which reproduce the historical hardcoded behavior exactly. The
  // workflow-action API route always passes the org's real policy, so the
  // server is the enforcement point.
  getActions: (ticket: Ticket, userRole: Role, userId?: string, policy?: CapabilityPolicy, ctx?: WorkflowContext): WorkflowAction[] => {
    const actions: WorkflowAction[] = [];

    // Role authority + any live per-person delegation for this user.
    // WF-7: the ADDITIVE collection is threaded through — a member's ticket
    // authority is identical whether a role is their headline or an additive
    // one (the headline is max-rank, so consulting it alone SUBTRACTED
    // authority from multi-role people).
    const roleCollection = ctx?.userRoles && ctx.userRoles.length > 0 ? ctx.userRoles : null;
    // DEC-13: every capability is evaluated against THIS ticket's resource,
    // so an org's type-scoped rule ("ASBUILT → DocCtrl only") replaces the
    // base list here exactly as it does in the route and the simulator.
    const resource = ticketResource(ticket);
    const allows = (cap: Parameters<typeof policyAllows>[1]) => policyAllows(policy, cap, userRole, roleCollection, userId, resource);
    const isEng = isEngineerRole(userRole) || (roleCollection ?? []).some((r) => isEngineerRole(r));
    const isManagement = allows('ticket.manage');

    const isRequesterIdentity = !!userId && ticket.requesterId === userId;
    const isDrafterIdentity = !!userId && ticket.assignedDrafterId === userId;
    const isAssignedEngineerIdentity = !!userId && ticket.assignedEngineerId === userId;

    // Identity rights are never policy-configurable: your own ticket stays
    // yours. WF-8: the role CAPABILITIES, by contrast, are ticket-scoped —
    // `ticket.requester_review` substitutes for a requester only where there
    // is no requester to act, and `ticket.draft_work` covers unassigned
    // queue work only. Org-wide blanket substitution (any Requester approving
    // any colleague's ticket; any Drafter replacing another drafter's IFC
    // package) was the single widest hole in the workflow.
    const canActAsRequester = isRequesterIdentity
      || (!ticket.requesterId && allows('ticket.requester_review'));
    const canActAsDrafter = isDrafterIdentity
      || (!ticket.assignedDrafterId && allows('ticket.draft_work'));
    // WF-24: is there a requester who can still act? A co-reviewer's arm is
    // on the requester's behalf (optional) only while one exists AND is not
    // KNOWN to have left: the route resolves a deactivated requester's
    // current collection as `[]` (DEC-16), and a ticket nobody is flagged
    // for stalls silently. `null` / undefined = unknown = assume present.
    const requesterCanAct = !!ticket.requesterId && ctx?.requesterRoles?.length !== 0;

    // GAP-2/DEC-12 (+DEC-37): independence is a property of the SLOT — one
    // deliverable's producer cannot be its checker. Active at >= 3 members.
    const sod = separationOfDutiesActive(ctx?.activeMemberCount);
    const producerIsChecker = sod && isDrafterIdentity;
    const SOD_REASON = "Needs a second person: the assigned drafter cannot approve their own deliverable (independent approval, orgs of 3+).";

    // Does the requester need an engineer in the loop? DEC-16: the role
    // stamped at filing is a SNAPSHOT (kept as the historical record) and is
    // disjoined with the requester's current collection — approval is
    // required if either says so, so a demotion after filing cannot leave
    // an in-flight ticket bypassing the gate.
    // DEC-13 stage 3: the exempt roles are the org's
    // `ticket.engineer_gate_exempt` list, scoped to this ticket's resource.
    // TIER-1 / DEC-33 (DF-P6): the gate keys on the WORK — the like-in-kind
    // declaration and the binding flag (tickets.engineering_required) —
    // never on who asked; today's role-based gate is the SEED for a request
    // the column cannot speak for (engineeringGateRequired).
    const needsEngineerApproval = engineeringGateRequired(ticket, ctx?.requesterRoles, policy);
    // DF-P6 fix pass (review, issues 1 and 2): can an engineer be picked at
    // all? Decides whether "Send for Engineer Final Approval" can go and
    // whether the requester's override is the way forward or the exception.
    const noEngineerToPick = ctx?.engineerPickAvailable === false;
    // DF-P6 fix pass 4 (review, major 2 — DEC-90 ruling (3) as given, which
    // is also proposed ruling R1's stated default): the requester's OWN
    // override of the engineering sign-off is never taken away — "do not
    // remove an override path a legitimate manager uses today, record it
    // instead". It is recorded as an override (history note, audit
    // authority.override, metadata.engineering_override) and needs the
    // requester's comment saying why. Only on a request FILED under the
    // review model (review_model_filed, 20261250) whose column says
    // engineering is required: a pre-paste row keeps today's requester paths
    // exactly (DEC-90 ruling (2); fix pass 2, review issue 1).
    // Fix pass 5 (review, minor): and on a pre-paste row whose requirement
    // was raised after the paste (requesterBindingApplies) — a flag must
    // never leave its manager requester with no way to issue.
    const requesterBinds = requesterBindingApplies(ticket, ctx?.requesterRoles, policy);
    const selfOverride = isRequesterIdentity && requesterBinds;
    const selfOverrideComment = selfOverride ? { requiresComment: true } : {};
    // DEC-13 (DRAFT-1 / GAP-1): a rule scoped to this ticket's type on
    // `ticket.direct_approve` binds the REQUESTER'S own approval too. Identity
    // keeps every review action (request revision, send for engineer
    // approval); "who may approve THIS type" is the org's to say. With no
    // scoped rule this is false and the requester path is exactly as before.
    const requesterScopedOut = scopedTokensFor(policy, 'ticket.direct_approve', resource) !== null
      && !allows('ticket.direct_approve');
    // DRAFT-2: an "engineering first" type cannot be assigned until
    // engineering has been in the loop (a review was requested — and, being
    // back in this queue, completed — or an engineer is on the ticket).
    const engineeringFirstPending = (ctx?.engineeringFirstTypes ?? []).includes(ticket.requestType)
      && !ticket.engineerReviewRequestedAt && !ticket.assignedEngineerId;
    const ENG_FIRST_REASON = 'This request type routes through engineering first: flag it for engineering review before a drafter is assigned.';
    const isTerminal = ticket.status === 'CLOSED' || ticket.status === 'CANCELED';
    // DF-P5: the roster under review (a routed library), and the drafter's
    // issue-as-is mark on the draft under review (FRIC-5).
    const roster = currentRoster(ticket);
    const issueReady = issueReadyFor(ticket);
    // WF-24: when a specific engineer holds the review, management's arm is
    // an OVERRIDE — the ticket waits on the engineer, not on every manager.
    const engineerOverride = !!ticket.assignedEngineerId && !isAssignedEngineerIdentity;
    // DEC-14 / WF-17: the requester (or the management tier) can withdraw a
    // request that has not yet been drafted to completion, with a reason.
    const cancelRequest = (): void => {
      if (isRequesterIdentity || isManagement) {
        actions.push({
          label: 'Cancel Request',
          action: 'cancel_request',
          variant: 'destructive',
          requiresComment: true,
          // LEAK-9 / GAP-107: the category (withdrawn, duplicate, handled
          // outside the app, rejected) rides beside the reason.
          requiresOutcome: true,
          outcomes: CANCEL_OUTCOMES,
          optional: true,
          description: 'Withdraw this request. Your reason is recorded; the request is closed as canceled and cannot be reopened.',
        });
      }
    };

    switch (ticket.status) {
      // (The former NEW / PENDING_ENG_INITIAL initial-review stage is gone —
      // DEC-14: every request is born in the assignment queue, and no live
      // status consults `ticket.initial_review`, which is marked dormant.)

      // --- ENGINEERING REVIEW (Optional Loop) ---
      // Now scoped to the assigned engineer when one exists. Management
      // can still override (rare emergency case).
      case 'PENDING_ENG_TEAM':
        {
          const canActHere = ticket.assignedEngineerId
            ? isAssignedEngineerIdentity || isManagement
            : allows('ticket.eng_review') || isManagement;
          if (canActHere) {
            actions.push({
              label: 'Engineering Review Complete',
              action: 'approve_team',
              variant: 'success',
              description: 'Engineering has verified the scope. Ready for assignment.',
              ...(engineerOverride ? { optional: true } : {}),
            });
            actions.push({
              label: 'Return with Questions',
              action: 'reject',
              variant: 'destructive',
              requiresComment: true,
              ...(engineerOverride ? { optional: true } : {}),
            });
          }
        }
        break;

      // --- ASSIGNMENT STAGE ---
      case 'PENDING_ASSIGNMENT':
        // Admins AND DraftingSupervisors run the assignment queue: assign a
        // drafter directly, or branch in an engineer for scope review first.
        if (allows('ticket.assign')) {
          actions.push({
            label: 'Assign Drafter',
            action: 'assign',
            variant: 'default',
            description: 'Select a drafter to begin work.',
            ...(engineeringFirstPending ? { disabledReason: ENG_FIRST_REASON } : {}),
          });
          // DF-P6 fix pass 3 (review, minor): said before the click — on a
          // request filed under the review model the flag binds the issue
          // point for good (computeTransition's request_eng_review); not on
          // a pre-paste row, one already required, or a declared request's
          // engineering-first loop (the type's, which binds nothing).
          const flagBinds = ticket.reviewModelFiled === true && ticket.engineeringRequired !== true
            && !(engineeringFirstPending && ticket.engineeringRequired === false && isDeclaredLikeInKind(ticket));
          actions.push({
            label: 'Flag for Engineering Review',
            action: 'request_eng_review',
            variant: 'secondary',
            requiresComment: true,
            requiresEngineerPick: true,
            description: flagBinds ? FLAG_ENG_REVIEW_BINDS_DESCRIPTION : 'Optional: route to a specific engineer for scope review before a drafter is assigned.'
          });
        }
        if (allows('ticket.self_assign')) {
          // GAP-2/DEC-12: the assigned drafter may not be the requester in
          // orgs of 3+ — rendered disabled, never hidden.
          const selfIsRequester = sod && isRequesterIdentity;
          actions.push({
            label: 'Pick Up Ticket',
            action: 'self_assign',
            variant: 'outline',
            ...(engineeringFirstPending
              ? { disabledReason: ENG_FIRST_REASON }
              : selfIsRequester
                ? { disabledReason: "Needs a second person: you can't draft your own request (independent drafting, orgs of 3+)." }
                : {}),
          });
        }
        cancelRequest();
        break;

      // --- DRAFTING STAGE ---
      case 'DRAFTING':
      case 'REVISION_REQ':
        if (ticket.status === 'DRAFTING') cancelRequest();
        // SM-6 / ROUTE-1 (DF-P3): drafting work with NO drafter (one who left
        // the workspace — EDGE-4 — or a revision returned before any drafter
        // was assigned) can always be re-owned by the assignment queue, and
        // is the queue's action item until it is. (The route's transitions no
        // longer produce it; this is the backstop.)
        if (!ticket.assignedDrafterId && allows('ticket.assign')) {
          actions.push({
            label: 'Assign Drafter',
            action: 'assign',
            variant: 'default',
            description: 'This request has no drafter. Select a drafter to take it on.',
            ...(engineeringFirstPending ? { disabledReason: ENG_FIRST_REASON } : {}),
          });
        }
        if (canActAsDrafter) {
          actions.push({
            label: 'Save Progress (Stage Files)',
            action: 'save_progress',
            variant: 'outline',
            description: 'Upload files but keep ticket in Drafting.'
          });

          if (ticket.attachments?.some(a => a.type === 'Draft')) {
            actions.push({
              label: 'Submit Draft for Review',
              action: 'submit_draft',
              variant: 'default',
              requiresFile: true
            });
          }

          // WF-15: close-without-review is a property of the CONFIGURED
          // request type (defaulting to the historical RFI), never a magic
          // string any creator can stamp for a one-click close.
          const closeTypes = ctx?.closeWithoutReviewTypes ?? ['RFI'];
          if (closeTypes.includes(ticket.requestType)) {
            actions.push({
              label: 'Answer & Close RFI',
              action: 'close_rfi',
              variant: 'success',
              requiresComment: true
            });
          }
        }
        break;

      // --- REVIEW STAGE ---
      // This is where the engineer-routing fork lives.
      case 'PENDING_REVIEW':
        if (roster) {
          // DF-P5 ROSTER (GAP-103): ONE parallel wait. Every unsatisfied
          // blocking slot is an action offered to its occupants at once; the
          // route issues the ticket when the last one is signed. The
          // requester's own slot (if the routing names one) is "is this what
          // I asked for", the technical slots "is it correct" — two
          // questions, neither waiting on the other (FRIC-2).
          const plan = slotSignPlan(roster, ticket, userId, sod, ctx?.now ?? Date.now());
          const occupies = plan.fillable.length > 0 || plan.blocked.length > 0;
          if (plan.fillable.length > 0) {
            const labels = plan.fillable.map((f) => f.slot.label || f.slot.kind);
            const allOverride = plan.fillable.every((f) => f.via === "override");
            actions.push({
              label: `Sign Off — ${labels.join(", ")}`,
              action: 'sign_slot',
              variant: 'success',
              requiresSignature: true,
              description: `Your e-signature is bound to the files under review${roster.cycle ? ` (Rev ${roster.cycle})` : ""}. One sign-off covers every slot you fill.${issueReady ? ` ${ISSUE_AS_IS_NOTE}` : ""}`,
              ...(allOverride ? { optional: true } : {}),
            });
          } else if (plan.blocked.length > 0) {
            actions.push({
              label: `Sign Off — ${plan.blocked.map((b) => b.slot.label || b.slot.kind).join(", ")}`,
              action: 'sign_slot',
              variant: 'success',
              requiresSignature: true,
              disabledReason: plan.blocked[0].reason,
            });
          }
          const occupiesOnlyAsOverride = occupies && plan.fillable.length > 0 && plan.fillable.every((f) => f.via === "override") && plan.blocked.length === 0;
          if (occupies || isRequesterIdentity) {
            // The ticket waits on its occupants: a requester the routing
            // does not roster, or an occupant only by override, may send it
            // back but is not badged for it (WF-24).
            actions.push({
              label: 'Request Revision',
              action: 'request_revision',
              variant: 'warning',
              requiresComment: true,
              ...(!occupies || occupiesOnlyAsOverride ? { optional: true } : {}),
            });
          } else if (isManagement) {
            actions.push({ label: 'Request Revision', action: 'request_revision', variant: 'warning', requiresComment: true, optional: true });
          }
          break;
        }
        if (canActAsRequester) {
          if ((needsEngineerApproval && !isEng) || requesterScopedOut) {
            // Viewer-tier requesters can't sign off on engineering work.
            // Their "approve" is actually "send for engineer final approval".
            // WF-3: and their "minor correction" must be too — the old
            // unconditional fast path here was a one-click bypass of the
            // entire engineer sign-off gate for every requester tier.
            actions.push({
              label: 'Send for Engineer Final Approval',
              action: 'request_final_engineer_approval',
              variant: 'success',
              requiresEngineerPick: true,
              description: 'Engineering policy: drawings must be signed off by a qualified engineer before IFC. Pick the engineer who will review.',
              ...(noEngineerToPick ? { disabledReason: NO_ENGINEER_TO_PICK_REASON } : {}),
            });
            // DF-P6 fix pass (review, issue 1): a requester who holds
            // ticket.manage, on a request FILED under the review model whose
            // column says it requires engineering, may issue it as a
            // recorded override. A pre-paste row keeps today's path while
            // today's gate decides the same; one whose column says required
            // where that gate no longer does takes this too
            // (requesterBindingApplies — fix pass 5; the DF-P6 merge).
            // Fix pass 4 (review, major 2 — DEC-90 ruling (3)): in every
            // workspace size, with the requester's comment saying why.
            if (isManagement && requesterBinds && needsEngineerApproval && !isEng
                && !requesterScopedOut) {
              actions.push({
                label: 'Override: Issue Without Engineer Sign-off',
                action: 'approve_draft_ifc',
                variant: 'warning',
                description: `Management override: issues the deliverable without an engineer's sign-off${noEngineerToPick ? ' (nobody in this workspace can be picked as the engineer)' : ''}. Recorded as an override in the history and the audit trail; the engineering sign-off stays unrecorded.${selfOverride ? ` ${SELF_OVERRIDE_NOTE}` : ''}${issueReady ? ` ${ISSUE_AS_IS_NOTE}` : ''}`,
                engineeringOverride: true,
                ...selfOverrideComment,
                ...(producerIsChecker ? { disabledReason: SOD_REASON } : {}),
                // The way forward when nobody can be picked; beside a
                // possible pick it is the exception, never waited on.
                ...(noEngineerToPick ? {} : { optional: true }),
              });
            }
          } else {
            // Engineer requesters approve directly to IFC.
            actions.push({
              label: 'Approve (Issue for Construction)',
              action: 'approve_draft_ifc',
              variant: 'success',
              description: issueReady ? `Accepts the draft. ${ISSUE_AS_IS_NOTE}` : 'Accepts the draft. Drafter will be notified to issue IFC.',
              ...(producerIsChecker ? { disabledReason: SOD_REASON } : {}),
            });
            // The "fix this typo and it's approved" fast path — for actors
            // who could approve directly anyway (WF-3 done-when 2).
            actions.push({
              label: 'Approve with Minor Correction',
              action: 'approve_minor_correction',
              variant: 'secondary',
              requiresComment: true,
              description: 'Approve as-is except for a small fix (typo, mislabel). Your note goes to the drafter to fold into the issued file — no new review round.',
              ...(producerIsChecker ? { disabledReason: SOD_REASON } : {}),
            });
          }
          actions.push({
            label: 'Request Revision',
            action: 'request_revision',
            variant: 'warning',
            requiresComment: true
          });
        } else if (allows('ticket.direct_approve') || isManagement) {
          // Direct approvers (engineers by default) and management can co-review.
          // WF-24: the ticket waits on the REQUESTER's review; a co-reviewer
          // acting on their behalf is optional — exactly as the on-behalf
          // close at FINAL_DRAFT — so every engineer and manager is not
          // badged for every ticket in review. With no requester to act
          // (none set, or the requester is known to have left the org),
          // the co-review IS the review and stays required.
          const onBehalf = requesterCanAct ? { optional: true } : {};
          // SM-3 (DF-P6, DEC-90 ruling (3)): on a request that requires
          // engineering review, a co-reviewer holding no Engineer role who
          // approves is OVERRIDING the engineering sign-off — kept (today's
          // path), recorded as an override by the route.
          // Fix pass 3 (review, minor): and SAID to be one before the click
          // — the label and description name the override, as the
          // PENDING_FINAL_APPROVAL override does.
          const coOverrides = needsEngineerApproval && !isEng;
          const coOverride = coOverrides ? { engineeringOverride: true } : {};
          actions.push({
            label: coOverrides ? 'Override: Approve Without Engineer Sign-off' : 'Approve (Issue for Construction)',
            action: 'approve_draft_ifc',
            variant: coOverrides ? 'warning' : 'success',
            description: coOverrides
              ? `Management override: accepts the draft without an engineer's sign-off. ${CO_REVIEW_OVERRIDE_NOTE}${issueReady ? ` ${ISSUE_AS_IS_NOTE}` : ''}`
              : issueReady ? `Accepts the draft. ${ISSUE_AS_IS_NOTE}` : 'Accepts the draft. Drafter will be notified to issue IFC.',
            ...(producerIsChecker ? { disabledReason: SOD_REASON } : {}),
            ...onBehalf,
            ...coOverride,
          });
          actions.push({
            label: coOverrides ? 'Override: Approve with Minor Correction' : 'Approve with Minor Correction',
            action: 'approve_minor_correction',
            variant: 'secondary',
            requiresComment: true,
            description: coOverrides
              ? `Management override: approve as-is except for a small fix, without an engineer's sign-off. Note goes to the drafter — no new review round. ${CO_REVIEW_OVERRIDE_NOTE}`
              : 'Approve as-is except for a small fix (typo, mislabel). Note goes to the drafter — no new review round.',
            ...(producerIsChecker ? { disabledReason: SOD_REASON } : {}),
            ...onBehalf,
            ...coOverride,
          });
          actions.push({
            label: 'Request Revision',
            action: 'request_revision',
            variant: 'warning',
            requiresComment: true,
            ...onBehalf,
          });
        }
        break;

      // --- FINAL ENGINEER APPROVAL ---
      // New stage: viewer-tier requester has sent the draft for engineer
      // sign-off. Only the assigned engineer (or management as a safety
      // override) can move the ticket forward.
      case 'PENDING_FINAL_APPROVAL':
        {
          const canActHere = ticket.assignedEngineerId
            ? isAssignedEngineerIdentity || isManagement
            : allows('ticket.final_approve') || isManagement;
          if (canActHere) {
            const override = engineerOverride ? { optional: true } : {};
            // SM-3 (DF-P6, DEC-90 ruling (3)): only an engineer signs as
            // the engineer — the assigned engineer, anyone holding an
            // Engineer role, or (no engineer assigned) a holder of
            // ticket.final_approve, who occupies the slot. Management
            // without one keeps today's override (the serial path's seed:
            // waivable by management), as a DISTINCT action that is
            // recorded as an override and never stamps engineer_approved_at.
            const signsAsEngineer = isAssignedEngineerIdentity || isEng
              || (!ticket.assignedEngineerId && allows('ticket.final_approve'));
            // DF-P6 fix pass 4 (review, minor 5): an override only where the
            // request REQUIRES engineering review. A request sent here
            // without requiring it (a type-scoped ticket.direct_approve rule
            // kept its requester from approving) is issued by management
            // without the engineer's stamp, recorded neutrally.
            const overridesSignOff = !signsAsEngineer && needsEngineerApproval;
            const neutralIssue = !signsAsEngineer && !needsEngineerApproval;
            if (signsAsEngineer) {
              actions.push({
                label: 'Approve as Engineer (Issue for Construction)',
                action: 'engineer_approve_final',
                variant: 'success',
                description: issueReady ? `Engineering sign-off complete. ${ISSUE_AS_IS_NOTE}` : 'Engineering sign-off complete. Drafter will be notified to issue IFC.',
                ...(producerIsChecker ? { disabledReason: SOD_REASON } : {}),
                ...override,
              });
            } else if (overridesSignOff) {
              actions.push({
                label: 'Override: Issue Without Engineer Sign-off',
                action: 'override_engineer_final',
                variant: 'warning',
                description: `Management override: issues the deliverable without the engineer's sign-off. Recorded as an override in the history and the audit trail; the engineering sign-off stays unrecorded.${selfOverride ? ` ${SELF_OVERRIDE_NOTE}` : ''}${issueReady ? ` ${ISSUE_AS_IS_NOTE}` : ''}`,
                engineeringOverride: true,
                // DF-P6 fix pass 4 (review, major 2 — DEC-90 ruling (3)):
                // the requester's own override stands, with a comment.
                ...selfOverrideComment,
                ...(producerIsChecker ? { disabledReason: SOD_REASON } : {}),
                ...override,
              });
            } else {
              actions.push({
                label: 'Approve (Issue for Construction)',
                action: 'override_engineer_final',
                variant: 'success',
                description: `Issues the deliverable. This request does not require an engineer's sign-off, so none is recorded.${issueReady ? ` ${ISSUE_AS_IS_NOTE}` : ''}`,
                withoutEngineerSignOff: true,
                ...(producerIsChecker ? { disabledReason: SOD_REASON } : {}),
                ...override,
              });
            }
            actions.push({
              label: 'Approve with Minor Correction',
              action: 'approve_minor_correction',
              variant: 'success',
              requiresComment: true,
              description: overridesSignOff
                ? `Management override: approve as-is except for a small fix, without the engineer's sign-off. Recorded as an override; the engineering sign-off stays unrecorded.${selfOverride ? ` ${SELF_OVERRIDE_NOTE}` : ''}`
                : neutralIssue
                  ? 'Approve as-is except for a small fix (typo, mislabel). Note goes to the drafter — no new review round. This request does not require an engineer\'s sign-off, so none is recorded.'
                  : 'Approve as-is except for a small fix (typo, mislabel). Note goes to the drafter — no new review round.',
              ...(overridesSignOff ? { engineeringOverride: true } : {}),
              ...(neutralIssue ? { withoutEngineerSignOff: true } : {}),
              ...(producerIsChecker ? { disabledReason: SOD_REASON } : {}),
              ...override,
            });
            actions.push({
              label: 'Request Revision (Send Back to Drafter)',
              action: 'engineer_request_revision',
              variant: 'warning',
              requiresComment: true,
              description: 'Send back to the drafter with revision notes.',
              ...override,
            });
            actions.push({
              label: 'Return to Requester for Clarification',
              action: 'engineer_return_to_requester',
              variant: 'destructive',
              requiresComment: true,
              description: 'Send back to the original requester instead of the drafter.',
              ...override,
            });
          }
        }
        break;

      // --- IFC STAGE ---
      case 'PENDING_IFC':
        if (canActAsDrafter) {
             actions.push({
               label: 'Save Progress',
               action: 'save_progress',
               variant: 'outline'
             });

             actions.push({
               label: 'ISSUE FINAL IFC PACKAGE',
               action: 'submit_final',
               variant: 'default',
               requiresFile: true
             });
        }
        break;

      // --- CLOSURE (acknowledgment by requester) ---
      case 'FINAL_DRAFT':
         if (canActAsRequester || allows('ticket.direct_approve') || isManagement) {
             // WF-24: the ticket waits on the REQUESTER's acknowledgement;
             // a co-reviewer or manager closing on their behalf is optional
             // — unless the requester is known to have left (see
             // `requesterCanAct`), when the close IS the closure.
             const onBehalf = canActAsRequester ? {} : requesterCanAct ? { optional: true } : {};
             actions.push({
               label: 'Acknowledge & Close', action: 'close_ticket', variant: 'success',
               ...(producerIsChecker ? { disabledReason: SOD_REASON } : {}),
               ...onBehalf,
             });
             actions.push({ label: 'Reject Final (Re-Open)', action: 'reject_final', variant: 'destructive', requiresComment: true, ...onBehalf });
         }
         break;

      // --- CLOSED (resurrection) ---
      // Closed tickets aren't dead — admin/management or the original requester
      // can reopen one to recover docs, re-run a revision, or restart a stalled
      // workflow without a brand-new ticket. The action routes it back through
      // PENDING_REVIEW so the existing draft/IFC artifacts stay attached.
      case 'CLOSED':
        if (allows('ticket.reopen') || canActAsRequester) {
          actions.push({
            label: 'Reopen Ticket',
            action: 'reopen_ticket',
            variant: 'outline',
            requiresComment: true,
            optional: true,
            description: 'Move back to review status and start a new revision cycle (DEC-15): the next submission is a new draft rev and the next approval a new issued rev. All attachments and history are preserved; the comment you add becomes the reopen reason.',
          });
        }
        break;

      // --- CANCELED (terminal, DEC-14) --- nothing: a withdrawn request is
      // not resurrected; the requester files a new one.
      case 'CANCELED':
        break;
    }

    // FRIC-5 (DF-P5; DEC-90 ruling (1): opt-in per ticket by the drafter,
    // default OFF = today's PENDING_IFC hop): the drafter may mark the draft
    // issue-ready at submission (`issueReady` on submit_draft) or, the
    // nearest the request page offers until it has an at-submit checkbox,
    // before any sign-off has landed on it (PENDING_REVIEW with no roster
    // slot satisfied) — so no reviewer has signed without the issue-as-is
    // note in front of them. Once a sign-off is in, the mark can only be
    // withdrawn (withdrawing asks nothing of a reviewer). The last approval
    // then issues the approved draft as the final package instead of
    // returning the ticket for a second upload. Optional, never waited on.
    const nothingSignedYet = ticket.status === 'PENDING_REVIEW' && !(roster?.slots ?? []).some((s) => s.status === 'satisfied');
    if (isDrafterIdentity && ticket.deliverableRev && issueReady && (ticket.status === 'PENDING_REVIEW' || ticket.status === 'PENDING_FINAL_APPROVAL')) {
      actions.push({ label: 'Withdraw Issue-As-Is', action: 'clear_issue_ready', variant: 'ghost', optional: true, description: 'The approval returns the request to you to issue the final package, as usual.' });
    } else if (isDrafterIdentity && ticket.deliverableRev && !issueReady && nothingSignedYet) {
      actions.push({ label: 'Issue As-Is When Approved', action: 'mark_issue_ready', variant: 'outline', optional: true, description: `When Rev ${ticket.deliverableRev} is approved with no corrections, it is issued as the final package — you will not need to upload it again. A correction still returns it to you. Available until the first sign-off lands.` });
    }

    // GAP-111 (DF-P6): the assigner's flag, binding and late. Whoever runs
    // the assignment queue may require engineering review at any status
    // before the deliverable is approved — it sets
    // tickets.engineering_required (true, for good: the database refuses the
    // way back), changes no status and restarts nothing: drafting goes on,
    // only the issue waits for the engineering sign-off. Offered only where
    // the column speaks for the ticket and does not already say so (and not
    // on a review roster already open — its slots were fixed when it opened).
    if (allows('ticket.assign') && ticket.engineeringRequired === false
        && ['PENDING_ASSIGNMENT', 'DRAFTING', 'REVISION_REQ', 'PENDING_REVIEW'].includes(ticket.status)
        && !(ticket.status === 'PENDING_REVIEW' && roster)) {
      actions.push({
        label: 'Require Engineering Sign-off',
        action: 'flag_engineering',
        variant: 'secondary',
        requiresComment: true,
        optional: true,
        description: 'This request will require an engineer\'s sign-off before it issues (management may override it, recorded as an override). Drafting carries on; nothing restarts. Your reason is recorded, and the requirement cannot be withdrawn.',
      });
    }

    // GLOBAL OVERRIDES
    if (allows('ticket.force_close') && !isTerminal) {
       const hasClose = actions.some(a => a.action === 'close_ticket');
       if (!hasClose) {
         actions.push({ label: 'Force Close (Admin)', action: 'close_ticket', variant: 'ghost', optional: true });
       }
    }

    // Reassignment of the engineer reviewer — useful when the assigned
    // engineer is OOO and the work is blocked. Default: Admin only.
    if (allows('ticket.reassign_engineer') && ticket.status === 'PENDING_FINAL_APPROVAL' && ticket.assignedEngineerId) {
      actions.push({
        label: 'Reassign Engineer Reviewer',
        action: 'reassign_engineer',
        variant: 'ghost',
        requiresEngineerPick: true,
        optional: true,
        description: 'Admin override: pick a different engineer to review.'
      });
    }

    // WF-18: reassignment of the DRAFTER once one is assigned — the queue
    // owners (`ticket.assign`) may hand an in-flight ticket to a different
    // drafter (the first one quit, is out, or is overloaded). `assign` is
    // only offered in the queue, so the old client-side "Reassign" (which
    // posted `assign` at DRAFTING) could never pass the route. Requires the
    // reason; the route validates the pick exactly as an assignment.
    if (allows('ticket.assign') && ticket.assignedDrafterId && !isTerminal) {
      actions.push({
        label: 'Reassign Drafter',
        action: 'reassign_drafter',
        variant: 'ghost',
        requiresComment: true,
        optional: true,
        description: 'Hand this request to a different drafter. The status does not change; the new drafter is notified and the reason is recorded.',
      });
    }

    // WF-9: attaching a file is a ticket write like any other — offered to the
    // ticket's participants (requester / assigned drafter / assigned engineer
    // by identity), to the drafting pool while the ticket is unassigned, and
    // to the management tier; never to an arbitrary role across every ticket.
    // The page derives its upload affordance from THIS action and the route
    // applies it compare-and-set, so a foreign drafter can no longer attach a
    // "Draft" to someone else's ticket and a concurrent upload cannot clobber
    // an approval's history entry.
    if (!isTerminal && (isRequesterIdentity || isDrafterIdentity || isAssignedEngineerIdentity || canActAsDrafter || isManagement)) {
      actions.push({
        label: 'Add File',
        action: 'attach_file',
        variant: 'outline',
        optional: true,
        description: 'Attach a source, draft or reference file to this request.',
      });
    }

    // TIER-4 dw3 / HAND-7 dw3 (DF-P6): an approval says, before it is
    // taken, which governing-code class the request is in, and that its
    // source has moved (and asks for the acknowledgement).
    const drift = (ctx?.sourceDrift ?? []).filter((x) => typeof x === 'string' && x.trim());
    if (ticket.codeClass || drift.length > 0) {
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        if (!ISSUING_APPROVALS.has(a.action) && a.action !== 'sign_slot') continue;
        const notes = [
          ticket.codeClass ? `Code class: ${ticket.codeClass}.` : null,
          drift.length > 0 ? `The source revision has moved since this request was raised (${drift.join('; ')}) — approving asks you to acknowledge it.` : null,
        ].filter((x): x is string => !!x);
        actions[i] = { ...a, description: [a.description, ...notes].filter(Boolean).join(' '), ...(drift.length > 0 ? { requiresSourceDriftAck: true } : {}) };
      }
    }

    // TIER-5 (DF-P5 fix pass 3): a routed ticket in review with no roster is
    // never approved on the serial path — the approvals stay visible,
    // disabled, with the way forward (request a revision → resubmission
    // opens the roster). The route refuses them too.
    if (ctx?.reviewRouted && !roster && (ticket.status === 'PENDING_REVIEW' || ticket.status === 'PENDING_FINAL_APPROVAL')) {
      const reason = ctx.reviewRoutedReason || ROUTED_NO_ROSTER_REASON;
      return actions.map((a) => (ROSTERLESS_APPROVALS.has(a.action) && !a.disabledReason ? { ...a, disabledReason: reason } : a));
    }
    return actions;
  }
};
