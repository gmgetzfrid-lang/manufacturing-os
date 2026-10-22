// lib/ticketAttention.ts
//
// Single source of truth for "does this ticket need MY action right now?".
//
// This logic used to be copy-pasted into two places — the attention hook
// (hooks/useTicketNotifications.ts, which feeds the sidebar badge, the header
// bell, and the /inbox cockpit) and the Drafting Request Portal
// (app/(protected)/requests/page.tsx) — and then, once centralised here, it
// was still a PARALLEL TABLE of role × status that drifted from the workflow
// engine: a DraftingSupervisor's badge counted every PENDING_REVIEW and
// PENDING_FINAL_APPROVAL ticket while the ticket page showed "View Only — No
// Actions Available" (WF-24 / CHAIN-3), so the badge could never clear.
//
// WF-24: "must act" is now DERIVED FROM THE ENGINE. A ticket needs the
// viewer's action exactly when lib/workflow.ts offers them a live action that
// is not marked `optional` (overrides, reassignment, cancellation, reopen,
// attaching a file) and not disabled by separation of duties. The badge, the
// portal's row markers and the ticket page's buttons therefore agree for
// every role/status combination by construction — there is no second table
// to keep in sync. The management tier itself is defined once, in
// lib/managementRoles.ts.
//
// Two different questions, deliberately: routing (lib/ticketRouting.ts) says
// who is TOLD when a ticket lands in a queue; this says who must ACT. A
// supervisor is told about a PENDING_IFC package (so they can chase the
// drafter) but the engine offers them nothing there, so it is not their
// action item — it is a bell row, not a badge count.
//
// drafting-flow Round G, DF-P9 TICKET-PAGE:
//   * FRIC-7 — the badge takes the requesters' CURRENT role collections
//     (AttentionContext.requesterRoles), so a departed requester's co-review,
//     which the page and the route require, is counted by the badge too.
//   * UI-1 / GAP-108 — who a ticket is waiting on (holdersFor) and since when
//     (waitingSince), from the ticket's own identity columns and the routed
//     pool's names the caller resolved (lib/ticketRouting.ts queuePool); no
//     role table here.
//   * UI-4 — why a viewer has nothing to do (explainNoActions): not their
//     turn (they act at another stage of this request) vs not permitted
//     (no stage of it offers them anything), naming who to talk to.
//   * ROUTE-1 done-when 2 — attentionLabel tells a revision with a drafter
//     from one without.

import type { Role, Ticket, TicketStatus } from "@/types/schema";
import { WorkflowEngine } from "@/lib/workflow";
// ROUTE-15 (DF-P17): a routed review's holders come from its roster.
import { currentRoster, slotBlocks, slotAlternatesActive, slotPartyLegReason, separationOfDutiesActive } from "@/lib/workflow";
// DF-P22 (the DF-P7 hand-off): a running consent window's people are told,
// not waited on.
import { windowRunning, recordMoment } from "@/lib/consentWindow";
import type { CapabilityPolicy } from "@/lib/capabilityPolicy";
import { MANAGEMENT_ROLES } from "@/lib/managementRoles";

/** VISIBILITY scope, not authority: the roles that see the whole request
 *  queue (the supervisor board, the org-wide attention fetch). Wider than the
 *  management tier by exactly the queue owner, who runs assignment without
 *  holding the override tier. */
export const QUEUE_VIEW_ROLES: readonly Role[] = [...MANAGEMENT_ROLES, "DraftingSupervisor"] as Role[];

/** True if the collection holds a role that sees the whole queue. */
export function isQueueViewer(roles: readonly Role[]): boolean {
  return roles.some((r) => QUEUE_VIEW_ROLES.includes(r));
}

/** True if the collection holds any engineering role (Engineer-1..4). */
export function isEngineerRole(roles: readonly Role[]): boolean {
  return roles.some((r) => r.startsWith("Engineer"));
}

export interface AttentionContext {
  /** The viewer's user id. */
  uid: string | null | undefined;
  /** The viewer's full additive role collection for the active org. */
  roles: readonly Role[];
  /** The org's capability policy when the caller has loaded it; absent, the
   *  shipped defaults apply — the same fallback the ticket page uses before
   *  its policy arrives, so the two never disagree for longer than a load. */
  policy?: CapabilityPolicy | null;
  /** The org's active member count, when known (separation-of-duties
   *  disables an action the viewer cannot take; absent = not applied). */
  activeMemberCount?: number;
  /** DRAFT-2: the org's "engineering first" request types — the ticket page
   *  passes them, and without them the badge flagged a Drafter to pick up a
   *  ticket the page showed as disabled. Read with
   *  `flaggedRequestTypes(cfg, 'engineeringFirst')` from the drafting row. */
  engineeringFirstTypes?: string[];
  /** WF-15: request types that close from DRAFTING without review — the
   *  same configured option list, so the inputs match the page's. */
  closeWithoutReviewTypes?: string[];
  /** FRIC-7 (DF-P9): each requester's CURRENT role collection, by uid — the
   *  input the route and the ticket page pass the engine (DEC-16). An entry
   *  with roles is an active member holding them; an entry `[]` is known NOT
   *  to be an active member (departed or suspended — the engine then
   *  requires the co-review on their behalf). A requester with no entry, and
   *  an absent / null map, is unknown: assumed present, the behaviour before
   *  this field (a failed read never invents a departure). Read with
   *  lib/ticketRequesterRoles.ts loadRequesterRoles. */
  requesterRoles?: ReadonlyMap<string, readonly string[]> | null;
}

/** FRIC-7: the requester collection the engine is given for `ticket` under
 *  `ctx` — what the route resolves for the same requester, or undefined
 *  (unknown) when the context does not cover them. */
export function requesterRolesFor(ticket: Pick<Ticket, "requesterId">, ctx: Pick<AttentionContext, "requesterRoles">): readonly string[] | undefined {
  if (!ctx.requesterRoles || !ticket.requesterId) return undefined;
  return ctx.requesterRoles.get(ticket.requesterId);
}

/**
 * Whether `ticket` is waiting on an action from the viewer described by `ctx`:
 * the workflow engine offers them at least one action that is neither
 * `optional` nor disabled. Identity (requester / assigned drafter / assigned
 * engineer), the claim pool, the co-review pool and the management gates all
 * come from the engine — this function holds no role table of its own.
 */
export function isActionRequired(ticket: Ticket, ctx: AttentionContext): boolean {
  const { uid, roles } = ctx;
  if (!uid) return false;
  if (ticket.status === "CLOSED" || ticket.status === "CANCELED") return false;
  const headline = (roles[0] ?? "Viewer") as Role;
  const actions = WorkflowEngine.getActions(ticket, headline, uid, ctx.policy ?? undefined, {
    userRoles: roles.length > 0 ? [...roles] : undefined,
    activeMemberCount: ctx.activeMemberCount,
    engineeringFirstTypes: ctx.engineeringFirstTypes,
    closeWithoutReviewTypes: ctx.closeWithoutReviewTypes,
    requesterRoles: requesterRolesFor(ticket, ctx),
  });
  return actions.some((a) => !a.optional && !a.disabledReason);
}

/** Short human label for WHY a ticket needs attention, given its status.
 *  Used by the bell / inbox to describe an action-required row, and by the
 *  ticket page's status header (UI-1).
 *
 *  ROUTE-1 done-when 2 (DF-P9): a revision (or a drafting ticket) whose
 *  drafter is known to be NONE is not "in progress" — nobody owns it —
 *  so `{ hasDrafter: false }` says it needs a drafter. Without the option
 *  (or with a drafter) the label is exactly what it always was. */
export function attentionLabel(status: string, opts?: { hasDrafter?: boolean }): string {
  const ownerless = opts?.hasDrafter === false;
  switch (status) {
    case "PENDING_ASSIGNMENT": return "Needs a drafter assigned";
    case "PENDING_ENG_TEAM": return "Engineering review";
    case "PENDING_REVIEW": return "Needs review";
    case "PENDING_FINAL_APPROVAL": return "Needs engineer sign-off";
    case "DRAFTING": return ownerless ? "Needs a drafter assigned" : "Drafting in progress";
    case "REVISION_REQ": return ownerless ? "Revision requested — needs a drafter" : "Drafting in progress";
    case "PENDING_IFC": return ownerless ? "Needs a drafter to issue the IFC package" : "Issue the IFC package";
    case "FINAL_DRAFT": return "Acknowledge & close";
    default: return "Needs your attention";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UI-1 / GAP-108 — "where is my request": who it waits on, and since when.
// ─────────────────────────────────────────────────────────────────────────────

/** Whose turn it is: a named person on the ticket, or a pool (the
 *  assignment queue — DraftingSupervisor holders, else Admins:
 *  lib/ticketRouting.ts queuePool — or the co-reviewers, when the requester
 *  whose review or acknowledgement it is has left or was never set). The
 *  co-reviewer pool is the engine's (lib/workflow.ts, PENDING_REVIEW and
 *  FINAL_DRAFT): `ticket.direct_approve` holders (engineers by default) and
 *  `ticket.manage` holders (management); with NO requester on the ticket,
 *  `ticket.requester_review` holders too. */
export type HolderKind = "requester" | "drafter" | "engineer" | "queue" | "co_reviewers" | "consent_window";

export interface TicketHolder {
  kind: HolderKind;
  /** The person's uid when the holder is one person on the ticket; null for
   *  a pool or a name the ticket does not carry. */
  uid: string | null;
  /** What a reader is shown: a name, or the pool's description. */
  name: string;
  /** The part they play at this step, in words ("the drafter"). */
  part: string;
}

export interface HoldersContext {
  /** The assignment queue's members' names (lib/ticketRouting.ts queuePool
   *  over the org's active members), when the caller resolved them; empty or
   *  absent = described, not named. */
  queueNames?: readonly string[] | null;
  /** The requester's CURRENT role collection (the page's DEC-16 read): `[]`
   *  = known not to be an active member — their review then falls to the
   *  co-reviewers (engineers or management), as the engine says (WF-24).
   *  null / absent = assumed present (a failed read never invents a
   *  departure). */
  requesterRoles?: readonly string[] | null;
  /** drafting-flow ROUTE-15 (DF-P17): members' display names by uid, for a
   *  routed review's slot occupants (the roster names them by uid). Absent,
   *  or a uid it does not cover: described by their slot, not named. */
  memberNames?: ReadonlyMap<string, string> | null;
  /** ROUTE-15 (DF-P17 final fix pass): the org's active member count, as
   *  the engine reads it (separation of duties binds at 3+): a routed slot's
   *  occupant its drafter / requester independence leg blocks is not waited
   *  on. Absent = not applied (the engine's own default). */
  activeMemberCount?: number;
  /** ROUTE-15: the clock a slot's alternate window is read against
   *  (default: now). */
  now?: number;
}

const nameOr = (v: string | null | undefined, fallback: string): string => {
  const t = typeof v === "string" ? v.trim() : "";
  return t || fallback;
};

function queueHolders(ctx?: HoldersContext): TicketHolder[] {
  const names = (ctx?.queueNames ?? []).map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) return [{ kind: "queue", uid: null, name: "the assignment queue", part: "assigns a drafter" }];
  return names.map((name) => ({ kind: "queue" as const, uid: null, name, part: "assignment queue" }));
}

/** ROUTE-15 (DF-P17): the slots a routed review still waits on, in words
 *  ("QA, Engineering") — the roster panel's waitingSlotLabels rule
 *  (lib/ticketRoster.ts: open and blocking; a notify-only slot never waits). */
const joinLabels = (labels: readonly string[]): string => labels.join(", ");

/** The ticket fields a routed review's waiting-on reads (the slots' party
 *  legs name the drafter and the requester). */
type RosterTicket = Pick<Ticket, "status" | "metadata"> & Partial<Pick<Ticket, "requesterId" | "assignedDrafterId">>;

const uidList = (xs: unknown): string[] =>
  Array.isArray(xs) ? xs.filter((u): u is string => typeof u === "string" && u.length > 0) : [];

/**
 * ROUTE-15 (DF-P17): the open blocking slots of a routed review and, for
 * each, the people who may sign it now — its primaries and, once its
 * alternate window has opened (lib/workflow.ts slotAlternatesActive, the
 * engine's own rule), its alternates; less anyone the slot's drafter /
 * requester independence legs block while separation of duties is active
 * (lib/workflow.ts slotPartyLegReason — the leg rule slotSignPlan applies,
 * shared, not copied; `ctx.activeMemberCount` as the engine reads it, absent
 * = not applied). Null when the ticket carries no current roster, or none of
 * its slots is open and blocking.
 */
/** DF-P22 (the DF-P7 hand-off): the open slot a RUNNING consent window
 *  stands on (lib/consentWindow.ts windowRunning — opened, not objected to,
 *  not expired, its slot still open) carries `window`: its people may object
 *  until the window closes, and silence is the expected path, so they are
 *  told, never waited on. */
type RosterWait = { label: string; uids: string[]; window?: { closesAt: string; recipients: string[] } };

function rosterWaits(ticket: RosterTicket, ctx?: HoldersContext): RosterWait[] | null {
  const roster = currentRoster(ticket);
  if (!roster) return null;
  const open = roster.slots.filter((s) => s && s.status === "open" && slotBlocks(s));
  if (open.length === 0) return null;
  const sod = separationOfDutiesActive(ctx?.activeMemberCount);
  const now = ctx?.now ?? Date.now();
  const parties = { requesterId: ticket.requesterId ?? null, assignedDrafterId: ticket.assignedDrafterId ?? null };
  const w = windowRunning(roster) ? roster.consentWindow ?? null : null;
  return open.map((slot) => {
    if (w && slot.kind === w.slot && slot.mode === "consent_window") {
      return { label: slot.label || slot.kind, uids: [], window: { closesAt: w.closesAt, recipients: uidList(w.recipients) } };
    }
    const alternates = slotAlternatesActive(roster, slot, now) ? uidList(slot.alternates) : [];
    const candidates = [...new Set([...uidList(slot.primaries), ...alternates])];
    const legs = Array.isArray(slot.independentOf) ? slot.independentOf : [];
    const uids = sod ? candidates.filter((uid) => !legs.some((k) => slotPartyLegReason(slot, k, parties, uid) !== null)) : candidates;
    return { label: slot.label || slot.kind, uids };
  });
}

/**
 * ROUTE-15 (DF-P17): who a ROUTED review waits on — the people who may sign
 * its roster's OPEN BLOCKING slots now (rosterWaits: primaries, alternates
 * once their window opens, never an occupant an independence leg on the
 * drafter or the requester blocks), one holder per person (kind
 * `co_reviewers`, `part` = the labels of the slots still open, so the
 * waiting line names the slots as the roster panel does). A notify-only
 * slot never holds the review. Null when the ticket carries no current
 * roster, or none of its slots is open and blocking — the caller then
 * answers as before. Names come from `ctx.memberNames`; a person it does not
 * name is described by their slot ("a reviewer for QA", one entry per slot —
 * worded so no label needs an article: "a reviewer for Engineering"); a slot
 * nobody may sign now is "the reviewers for QA".
 */
function rosterHolders(ticket: RosterTicket, ctx?: HoldersContext): TicketHolder[] | null {
  const all = rosterWaits(ticket, ctx);
  if (!all) return null;
  // DF-P22 (the DF-P7 hand-off): a running consent window's people are told,
  // not waited on. While another slot is open the review waits on that
  // slot's people alone; when the window's slot is the only one open, the
  // review waits on nobody's sign-off and the line says who may object until
  // when (the window's card says the rest).
  const waits = all.filter((w) => !w.window);
  if (waits.length === 0) {
    return all.map((w) => {
      const names = (w.window?.recipients ?? []).map((uid) => (ctx?.memberNames?.get(uid) ?? "").trim());
      const named = names.filter(Boolean);
      const who = named.length === names.length && named.length > 0 ? named.join(", ") : "the people it asked";
      return { kind: "consent_window" as const, uid: null, name: `no sign-off ("${w.label}" goes ahead unless someone objects)`, part: `${who} may object until ${recordMoment(w.window?.closesAt)}` };
    });
  }
  const part = joinLabels(waits.map((w) => w.label));
  const out: TicketHolder[] = [];
  const seen = new Set<string>();
  for (const { label, uids } of waits) {
    if (uids.length === 0) {
      out.push({ kind: "co_reviewers", uid: null, name: `the reviewers for ${label}`, part });
      continue;
    }
    let unnamed = false;
    for (const uid of uids) {
      if (seen.has(uid)) continue;
      const name = (ctx?.memberNames?.get(uid) ?? "").trim();
      if (!name) { unnamed = true; continue; }
      seen.add(uid);
      out.push({ kind: "co_reviewers", uid, name, part });
    }
    if (unnamed) out.push({ kind: "co_reviewers", uid: null, name: `a reviewer for ${label}`, part });
  }
  return out;
}

/** ROUTE-15 (DF-P17): the uids whose names a routed review's waiting line
 *  needs (rosterWaits — the same people holdersFor names under the same
 *  `ctx`), sorted, de-duplicated; [] for a ticket without a current roster.
 *  The page reads their names once and hands them back as `memberNames`. */
export function rosterHolderUids(ticket: RosterTicket, ctx?: Pick<HoldersContext, "activeMemberCount" | "now">): string[] {
  const waits = rosterWaits(ticket, ctx);
  if (!waits) return [];
  // DF-P22: a running window's people are named too (as told, not waited on).
  return [...new Set(waits.flatMap((w) => [...w.uids, ...(w.window?.recipients ?? [])]))].sort();
}

/**
 * Who `ticket` is waiting on right now — the people (or the pool) whose
 * move the current status is. Derived from the status and the ticket's own
 * identity columns; the queue's names come from the caller. CLOSED and
 * CANCELED wait on nobody ([]). ROUTE-15 (DF-P17): a review with a current
 * routing roster (lib/workflow.ts currentRoster) waits on its open blocking
 * slots' occupants (rosterHolders); a ticket without one is answered exactly
 * as before.
 */
export function holdersFor(
  ticket: Pick<Ticket, "status" | "requesterId" | "requesterName" | "requesterEmail" | "assignedDrafterId" | "assignedDrafterName" | "assignedEngineerId" | "assignedEngineerName"> & Partial<Pick<Ticket, "metadata">>,
  ctx?: HoldersContext,
): TicketHolder[] {
  const routed = rosterHolders(ticket, ctx);
  if (routed) return routed;
  const requesterGone = Array.isArray(ctx?.requesterRoles) && ctx!.requesterRoles!.length === 0;
  // The engine's co-reviewer pool, described (lib/workflow.ts): direct
  // approvers (engineers by default) and management when the requester has
  // left; with no requester at all, requester-reviewers as well.
  const requester = (): TicketHolder[] => !ticket.requesterId
    ? [{ kind: "co_reviewers", uid: null, name: "a requester-reviewer, engineer or management", part: "reviews in the requester's place — the request has no requester" }]
    : requesterGone
      ? [{ kind: "co_reviewers", uid: null, name: "a reviewer — engineers or management", part: "reviews on the requester's behalf — the requester is no longer an active member" }]
      : [{ kind: "requester", uid: ticket.requesterId, name: nameOr(ticket.requesterName, nameOr(ticket.requesterEmail?.split("@")[0], "the requester")), part: "the requester" }];
  const drafter = (): TicketHolder[] => ticket.assignedDrafterId
    ? [{ kind: "drafter", uid: ticket.assignedDrafterId, name: nameOr(ticket.assignedDrafterName, "the assigned drafter"), part: "the drafter" }]
    : queueHolders(ctx);
  const engineer = (): TicketHolder[] => ticket.assignedEngineerId
    ? [{ kind: "engineer", uid: ticket.assignedEngineerId, name: nameOr(ticket.assignedEngineerName, "the assigned engineer"), part: "the reviewing engineer" }]
    : [{ kind: "engineer", uid: null, name: "an engineer", part: "the reviewing engineer" }];
  switch (ticket.status) {
    case "PENDING_ASSIGNMENT": return queueHolders(ctx);
    case "PENDING_ENG_TEAM": return engineer();
    case "DRAFTING":
    case "REVISION_REQ":
    case "PENDING_IFC": return drafter();
    case "PENDING_REVIEW":
    case "FINAL_DRAFT": return requester();
    case "PENDING_FINAL_APPROVAL": return engineer();
    default: return [];
  }
}

/** The history line a restore appends to a request it brought back under a
 *  fresh number (lib/dataRestore.ts renumberedTicketRow; drafting-flow
 *  EDGE-5). It records the number the request was issued; it moves neither
 *  the stage nor who holds it, so it is a NON_STEP line below — the request's
 *  wait keeps counting from its last real step, not from the restore. */
export const RESTORE_RENUMBERED_HISTORY_ACTION = "Renumbered on restore";

/** The history line POST /api/projects/deliverable-reference appends when a
 *  request's reviewed deliverable could not be put on its project register
 *  (drafting-flow PROJ-1, projects-joint J21). Bookkeeping: it moves neither
 *  the stage nor who holds it, so it is a NON_STEP line below. */
export const DELIVERABLE_REFERENCE_MISS_HISTORY_ACTION = "Deliverable not put on project register";

/** History lines that change neither the stage nor who holds it: a file, a
 *  saved draft, the triage details, the source link at creation, the
 *  register note written beside a close, the restore's renumbering note,
 *  the project-register miss note (J21).
 *  Every other line marks a step (a transition, a (re)assignment, a
 *  hand-back). A test pins this set against the engine's labels (an action
 *  that never moves the status must be named here; one named here must
 *  never move it). */
export const NON_STEP_HISTORY_ACTIONS: readonly string[] = [
  "File Uploaded",
  "Save Progress (Stage Files)",
  "Save Progress",
  "Triage details set",
  "Source Linked",
  "Closed — deliverable not in the register",
  RESTORE_RENUMBERED_HISTORY_ACTION,
  DELIVERABLE_REFERENCE_MISS_HISTORY_ACTION,
];

/**
 * When the ticket's current wait began: the date of the newest history line
 * that changed its stage or who holds it (see NON_STEP_HISTORY_ACTIONS),
 * else its creation. Returns null when no date can be read.
 */
export function waitingSince(ticket: Pick<Ticket, "history" | "createdAt">): Date | null {
  const history = Array.isArray(ticket.history) ? ticket.history : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i] as { action?: unknown; date?: unknown } | undefined;
    if (!h || typeof h.action !== "string" || NON_STEP_HISTORY_ACTIONS.includes(h.action)) continue;
    const d = toDateOrNull(h.date);
    if (d) return d;
  }
  return toDateOrNull(ticket.createdAt);
}

function toDateOrNull(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "object") {
    const o = v as { toDate?: () => Date; seconds?: number };
    if (typeof o.toDate === "function") return o.toDate();
    if (typeof o.seconds === "number") return new Date(o.seconds * 1000);
    return null;
  }
  const d = new Date(v as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "3 days", "5 hours", "under an hour" — how long since `since`. */
export function waitedFor(since: Date | null, now: Date = new Date()): string | null {
  if (!since) return null;
  const ms = now.getTime() - since.getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// UI-4 — "View Only" explained.
// ─────────────────────────────────────────────────────────────────────────────

/** The open statuses, for asking the engine "would this viewer act at any
 *  stage of this request?". */
const OPEN_STATUSES: readonly TicketStatus[] = [
  "PENDING_ASSIGNMENT", "PENDING_ENG_TEAM", "DRAFTING", "REVISION_REQ", "PENDING_REVIEW",
  "PENDING_FINAL_APPROVAL", "PENDING_IFC", "FINAL_DRAFT",
];

export interface NoActionsExplanation {
  /** terminal — nothing waits on anyone; not_your_turn — the viewer acts at
   *  another stage of this request (or is a party to it); not_permitted —
   *  no stage of this request offers the viewer anything. */
  kind: "terminal" | "not_your_turn" | "not_permitted";
  /** One plain sentence for the page. */
  text: string;
}

const joinNames = (holders: readonly TicketHolder[]): string => {
  const names = holders.map((h) => h.name);
  if (names.length <= 1) return names[0] ?? "nobody";
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
};

/**
 * Why the viewer described by `ctx` has no live action on `ticket`, in one
 * sentence that names who to talk to (UI-4). The caller shows it only when
 * the engine offers the viewer nothing. "Not your turn" when the viewer is a
 * party to the request (its requester, drafter or engineer) or the engine
 * would offer them a live action at another open stage of it; otherwise
 * "not permitted", pointing at the holder and at an Admin for the policy.
 */
export function explainNoActions(
  ticket: Ticket,
  ctx: AttentionContext & { holders: readonly TicketHolder[] },
): NoActionsExplanation {
  if (ticket.status === "CLOSED" || ticket.status === "CANCELED") {
    return {
      kind: "terminal",
      text: ticket.status === "CANCELED"
        ? "This request was canceled — nothing is waiting on anyone. File a new request if the work is still needed."
        : "This request is closed — nothing is waiting on anyone. Ask the drafting supervisor to reopen it if something was missed.",
    };
  }
  const holders = ctx.holders;
  const what = attentionLabel(ticket.status, { hasDrafter: !!ticket.assignedDrafterId }).toLowerCase();
  const who = joinNames(holders);
  const uid = ctx.uid ?? null;
  const party: string | null = !uid ? null
    : ticket.assignedDrafterId === uid ? "the drafter"
      : ticket.assignedEngineerId === uid ? "the reviewing engineer"
        : ticket.requesterId === uid ? "the requester"
          : null;
  const holderPart = holders[0]?.part ?? "someone else";
  if (party) {
    // A pool (the queue, the co-reviewers) has no possessive part to name.
    const pool = holders[0]?.kind === "queue" || holders[0]?.kind === "co_reviewers" || holders[0]?.kind === "consent_window";
    const step = holderPart === party ? "not yours yet" : pool ? "not yours" : `${holderPart}'s`;
    return { kind: "not_your_turn", text: `You are ${party} — this step is ${step} (waiting on ${who}: ${what}).` };
  }
  const actsElsewhere = !!uid && OPEN_STATUSES.some((status) => status !== ticket.status
    && isActionRequired({ ...ticket, status }, ctx));
  if (actsElsewhere) {
    return { kind: "not_your_turn", text: `Not your turn — waiting on ${who} (${what}). You act on this request at another stage.` };
  }
  return {
    kind: "not_permitted",
    text: `Your roles don't act on this request — waiting on ${who} (${what}). If you should be able to, an Admin can change who may act in Admin → Permissions.`,
  };
}
