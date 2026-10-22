// lib/workflowAuthority.ts
//
// SERVER-ONLY (reads as the service role; lib/serverClientScope.ts uses
// node:async_hooks). drafting-flow Round G, DF-P24 merge-time fix pass
// (ruling 2): the workflow route's engine context — and the refusals it
// applies around the engine — in ONE place, so that the route and
// /api/tickets/examination-scope (who may record why a request issues
// without its examination data) always agree on who may issue it now.
//
// Extracted from app/api/tickets/workflow-action/route.ts WITHOUT changing
// the route's behaviour: the same reads, in the same order, with the same
// answers (pinned by the route's A/B sweep — lib/__tests__/
// dfRoundG_P24_issueGateRoute.test.ts — and every workflow-route test).
//   * `draftingTypeFlags` — the request types the workspace flags
//     close-without-review / engineering-first, from its 'drafting' row;
//   * `workflowEngineContext` — the requester's current roles, the
//     like-in-kind declaration's signature (a declaration KNOWN not to stand
//     is evaluated as undeclared; an unreadable one refuses the actions it
//     decides), whether the requester can pick an engineer at all, and the
//     source documents' drift — the context `WorkflowEngine.getActions`
//     is evaluated with;
//   * `rosterlessRoutedRefusal` — TIER-5: an approval on the serial path of
//     a routed library's request in review without a roster is refused;
//   * `issueAuthorityNow` — the issuing acts (an issuing approval, or a
//     roster sign-off that would complete the review) the workflow route
//     would accept from this member now, as far as the member is concerned
//     (what the act's own body must carry — a comment, an acknowledgement,
//     a signature — is not authority and is not asked here).

import type { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { CapabilityPolicy } from "@/lib/capabilityPolicy";
import type { Role, Ticket } from "@/types/schema";
import {
  WorkflowEngine, ISSUING_APPROVALS, ROSTERLESS_APPROVALS, ROUTED_NO_ROSTER_REASON, routedNoRosterReason,
  currentRoster, engineerPickQuestionApplies, ticketResource, type WorkflowAction,
} from "@/lib/workflow";
import { flaggedRequestTypes } from "@/lib/requestTypes";
import { heldRoles } from "@/lib/roleHeld";
import { isDeclaredLikeInKind, declarationSignatureStands, engineerPickAvailable as pickAvailableFrom, type DeclarationSignatureRow } from "@/lib/reviewModel";
import { loadPickerMembers } from "@/lib/ticketPickerMembers";
import { engineerCandidates } from "@/lib/ticketPage";
import { parseSourceDocument, parseSourceDocuments, revDrift } from "@/lib/sourceDocRef";
import { ticketReviewRouting } from "@/lib/routingControl";
import { signOffWouldComplete } from "@/lib/examinationScopeGate";

type Db = typeof supabaseAdmin;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The documents read's slice (the route's INTENT_BRIDGE_CHUNK). */
const DRIFT_READ_CHUNK = 100;

/** DF-P6 fix pass 4 (review, minor 3): the actions a like-in-kind
 *  declaration decides — whether the request may issue without an
 *  engineer (the issuing approvals, and a roster sign-off that may complete
 *  the review), and whether a scope review or the late flag binds the
 *  requirement. With the declaration's signature unreadable they answer 503,
 *  never a guess. */
export const DECLARATION_DECIDES: ReadonlySet<string> = new Set([...ISSUING_APPROVALS, "sign_slot", "request_eng_review", "flag_engineering"]);

/** WF-15 / DRAFT-2: the configured request types flagged close-without-review
 *  (RFI when none is) and engineering-first, from the 'drafting' row's data.
 *  Throws exactly where the route's inline reading threw (a non-array
 *  `requestTypes.options`), so the route's own try keeps its defaults. */
export function draftingTypeFlags(cfgData: unknown): { closeWithoutReviewTypes: string[]; engineeringFirstTypes: string[] } {
  const opts = ((cfgData as { requestTypes?: { options?: Array<{ value?: string; closeWithoutReview?: boolean }> } } | null | undefined)
    ?.requestTypes?.options) ?? [];
  const flagged = opts.filter((o) => o.closeWithoutReview === true).map((o) => String(o.value ?? "")).filter(Boolean);
  return { closeWithoutReviewTypes: flagged.length > 0 ? flagged : ["RFI"], engineeringFirstTypes: flaggedRequestTypes(cfgData, "engineeringFirst") };
}

/** WF-7: the caller's headline role and FULL additive collection, as the
 *  route reads its membership row. */
export function callerRolesOf(member: { role?: unknown; roles?: unknown }): { callerRole: Role; callerRoles: Role[] } {
  const callerRole = ((member.role as Role | null | undefined) ?? "Viewer") as Role;
  const callerRoles: Role[] = Array.isArray(member.roles) && (member.roles as Role[]).length > 0 ? (member.roles as Role[]) : [callerRole];
  return { callerRole, callerRoles };
}

export type EngineContext = {
  engineerPickAvailable?: boolean;
  sourceDrift?: string[];
  userRoles: Role[];
  activeMemberCount: number;
  engineeringFirstTypes: string[];
  closeWithoutReviewTypes: string[];
  requesterRoles: string[];
};

export type EngineContextResult =
  | { kind: "declaration_unreadable" }
  | {
    kind: "ok";
    engineCtx: EngineContext;
    requesterRoles: string[];
    declarationUnverified: "missing" | "unchecked" | null;
    driftLabels: string[];
    sourceDriftUnchecked: boolean;
  };

/** The engine context for one caller on one request — the route's own
 *  reads, in its order. `ticket.engineeringRequired` is set to true on the
 *  ticket passed in when its declaration is KNOWN not to stand (as the route
 *  always did on its own ticket — pass a copy to leave yours untouched).
 *  `declarationDecides`: the action asked decides the declaration
 *  (DECLARATION_DECIDES) — an unreadable signature then stops here.
 *  `readSourceDrift`: the action asked is an issuing approval or a sign-off
 *  (only those read the source documents). */
export async function workflowEngineContext(db: Db, input: {
  ticket: Ticket;
  ticketId: string;
  callerId: string;
  callerRole: Role;
  callerRoles: Role[];
  capPolicy: CapabilityPolicy;
  activeMemberCount: number;
  sodActive: boolean;
  engineeringFirstTypes: string[];
  closeWithoutReviewTypes: string[];
  declarationDecides: boolean;
  readSourceDrift: boolean;
}): Promise<EngineContextResult> {
  const { ticket, ticketId, callerId, callerRole, callerRoles, capPolicy, activeMemberCount, sodActive, engineeringFirstTypes, closeWithoutReviewTypes } = input;
  // DEC-16: the requester's CURRENT collection rides beside the snapshot, so
  // a demotion after filing cannot leave the engineer gate bypassed. A
  // requester who is no longer an active member is known to hold nothing.
  let requesterRoles: string[] = [];
  if (ticket.requesterId) {
    const { data: reqMember } = await db
      .from("org_members").select("role, roles")
      .eq("org_id", ticket.orgId).eq("uid", ticket.requesterId).eq("status", "active").maybeSingle();
    requesterRoles = heldRoles(reqMember as { role?: unknown; roles?: unknown } | null);
  }
  // DF-P6 fix pass (review, minor 11) / fix pass 4 (review, minor 3): a
  // declaration stands only on its e-signature. A signature KNOWN not to
  // stand ("missing") is evaluated as undeclared; a read that FAILS changes
  // nothing the engine sees, and every action the declaration decides
  // answers 503 instead.
  let declarationUnverified: "missing" | "unchecked" | null = null;
  if (ticket.engineeringRequired === false && isDeclaredLikeInKind(ticket)) {
    const sigId = ticket.likeInKindSignatureId ?? "";
    const { data: dsig, error: dsigErr } = UUID_RE.test(sigId)
      ? await db.from("e_signatures").select("id, org_id, resource_type, resource_id, signer_user_id").eq("id", sigId).maybeSingle()
      : { data: null, error: null };
    if (dsigErr) declarationUnverified = "unchecked";
    else if (!declarationSignatureStands(dsig as DeclarationSignatureRow | null, { id: ticketId, orgId: ticket.orgId, likeInKindDeclaredBy: ticket.likeInKindDeclaredBy })) declarationUnverified = "missing";
    if (declarationUnverified === "missing") ticket.engineeringRequired = true;
  }
  if (declarationUnverified === "unchecked" && input.declarationDecides) return { kind: "declaration_unreadable" };
  // DF-P6 fix pass (review, issues 1 and 2): can the requester pick an
  // engineer at all? Read only where it decides something; a read that
  // fails leaves it unknown (the strict reading: someone can be picked).
  let engineerPickAvailable: boolean | undefined;
  if (engineerPickQuestionApplies(ticket, callerId, callerRole, callerRoles, capPolicy, requesterRoles)) {
    const read = await loadPickerMembers(ticket.orgId, db);
    if (read.ok) {
      const cands = engineerCandidates(read.rows, capPolicy, "ticket.final_approve", ticketResource(ticket)).map((c) => c.uid);
      engineerPickAvailable = pickAvailableFrom(cands, ticket, callerId, sodActive);
    }
  }
  // HAND-7 done-when 3 (DF-P6; DF-P18): each source document's live
  // revision against the one the request captured, read for an issuing
  // approval or a sign-off only; a failed read is tried once more before
  // the source counts as unchecked.
  const driftLabels: string[] = [];
  let sourceDriftUnchecked = false;
  const driftRefs = input.readSourceDrift ? parseSourceDocuments(ticket.metadata).filter((r) => UUID_RE.test(r.id)) : [];
  if (driftRefs.length > 0) {
    let liveDocs: unknown[] | null = null;
    let liveErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const read = await db
        .from("documents").select("id, rev, current_version_id, document_number")
        .eq("org_id", ticket.orgId).in("id", driftRefs.slice(0, DRIFT_READ_CHUNK).map((r) => r.id));
      liveDocs = (read.data ?? null) as unknown[] | null;
      liveErr = read.error;
      if (!liveErr) break;
    }
    if (liveErr) {
      sourceDriftUnchecked = true;
    } else {
      const live = new Map(((liveDocs ?? []) as Array<{ id: string; rev: string | null; current_version_id: string | null; document_number: string | null }>).map((d) => [d.id, d]));
      for (const ref of driftRefs) {
        const d = live.get(ref.id);
        if (!d) continue;
        if (revDrift({ versionId: ref.versionId, rev: ref.rev }, { versionId: d.current_version_id, rev: d.rev }) === "drifted") {
          driftLabels.push(`${ref.documentNumber || d.document_number || "a source document"}${ref.rev ? ` raised on Rev ${ref.rev}` : ""}, now Rev ${d.rev ?? "—"}`);
        }
      }
    }
  }
  const engineCtx: EngineContext = {
    ...(engineerPickAvailable === undefined ? {} : { engineerPickAvailable }),
    ...(driftLabels.length > 0 ? { sourceDrift: driftLabels } : {}),
    userRoles: callerRoles,
    activeMemberCount: activeMemberCount ?? 0,
    engineeringFirstTypes,
    closeWithoutReviewTypes,
    requesterRoles,
  };
  return { kind: "ok", engineCtx, requesterRoles, declarationUnverified, driftLabels, sourceDriftUnchecked };
}

/** TIER-5 (DF-P5 fix pass 3): an approval on the serial path
 *  (ROSTERLESS_APPROVALS) of a request in a routed library that is in review
 *  WITHOUT a roster is refused — it would issue without every slot the
 *  routing names (DEC-36). Read only for those approvals on such a request;
 *  null = not refused. */
export async function rosterlessRoutedRefusal(db: Db, ticket: Ticket, ticketId: string, action: string): Promise<null | { status: 409 | 503; error: string; code: string }> {
  if (!(ROSTERLESS_APPROVALS.has(action) && ticket.libraryId && !currentRoster(ticket))) return null;
  let reviewRouting: Awaited<ReturnType<typeof ticketReviewRouting>>;
  try {
    const { runWithServerClient } = await import("@/lib/serverClientScope");
    reviewRouting = await runWithServerClient(db, () => ticketReviewRouting({
      id: ticketId, orgId: ticket.orgId, libraryId: ticket.libraryId, sourceDocumentId: parseSourceDocument(ticket.metadata)?.id ?? null,
    }));
  } catch (e) {
    console.error(`[workflow-action] routing unreadable for ticket ${ticketId}:`, (e as Error)?.message ?? e);
    return { status: 503, error: "This request's review routing could not be read, so the approval was not applied. Try again in a moment.", code: "routing_unreadable" };
  }
  if (!reviewRouting.routed) return null;
  // DF-P5 fix pass 4: a table that cannot be used is named — a revision
  // would be refused too (routing_invalid), so the way forward differs.
  return reviewRouting.routing.state === "invalid"
    ? { status: 409, error: routedNoRosterReason(reviewRouting.routing), code: "routing_invalid" }
    : { status: 409, error: ROUTED_NO_ROSTER_REASON, code: "routing_needs_roster" };
}

/** The issuing acts the workflow route would accept from this member on
 *  this request now (merge-time fix pass, ruling 2): evaluated with the
 *  route's own context (`workflowEngineContext`), the route's member-count
 *  rule (an unreadable count refuses an issuing approval, and evaluates a
 *  sign-off with separation of duties active) and its TIER-5 refusal; a
 *  roster sign-off counts only when it would COMPLETE the review.
 *   * `ok` — the acts (at least one);
 *   * `none` — the route would refuse every issuing act from this member;
 *   * `unreadable` — nothing could be decided for want of a read (the route
 *     would answer 503): never read as authority. */
export async function issueAuthorityNow(db: Db, input: {
  ticket: Ticket;
  ticketId: string;
  callerId: string;
  member: { role?: unknown; roles?: unknown };
  capPolicy: CapabilityPolicy;
  draftingCfg: unknown;
}): Promise<{ kind: "ok"; actions: string[] } | { kind: "none" } | { kind: "unreadable"; error: string }> {
  const ticket: Ticket = { ...input.ticket };
  const { callerRole, callerRoles } = callerRolesOf(input.member);
  const { count: memberCountRead, error: memberCountErr } = await db
    .from("org_members").select("uid", { count: "exact", head: true }).eq("org_id", ticket.orgId).eq("status", "active");
  const memberCountUnchecked = !!memberCountErr;
  const activeMemberCount = memberCountUnchecked ? Math.max(memberCountRead ?? 0, 3) : (memberCountRead ?? 0);
  const sodActive = activeMemberCount >= 3;
  let flags = { closeWithoutReviewTypes: ["RFI"], engineeringFirstTypes: [] as string[] };
  try { flags = draftingTypeFlags(input.draftingCfg); } catch { /* the route's defaults stand */ }
  const built = await workflowEngineContext(db, {
    ticket, ticketId: input.ticketId, callerId: input.callerId, callerRole, callerRoles, capPolicy: input.capPolicy,
    activeMemberCount, sodActive, ...flags, declarationDecides: true, readSourceDrift: true,
  });
  if (built.kind === "declaration_unreadable") return { kind: "unreadable", error: "This request's like-in-kind declaration could not be checked (it decides who may issue). Try again in a moment." };
  const offered: WorkflowAction[] = WorkflowEngine.getActions(ticket, callerRole, input.callerId, input.capPolicy, built.engineCtx);
  let unreadable: string | null = null;
  let routedRefusal: Awaited<ReturnType<typeof rosterlessRoutedRefusal>> | undefined;
  const acts: string[] = [];
  for (const a of offered) {
    if (a.disabledReason) continue;
    if (ISSUING_APPROVALS.has(a.action)) {
      if (memberCountUnchecked) { unreadable = "This workspace's members could not be counted (it decides who may issue). Try again in a moment."; continue; }
    } else if (!(a.action === "sign_slot" && signOffWouldComplete(ticket, input.callerId, sodActive))) {
      continue;
    }
    if (ROSTERLESS_APPROVALS.has(a.action)) {
      if (routedRefusal === undefined) routedRefusal = await rosterlessRoutedRefusal(db, ticket, input.ticketId, a.action);
      if (routedRefusal) { if (routedRefusal.status === 503) unreadable = routedRefusal.error; continue; }
    }
    acts.push(a.action);
  }
  if (acts.length > 0) return { kind: "ok", actions: acts };
  return unreadable ? { kind: "unreadable", error: unreadable } : { kind: "none" };
}
