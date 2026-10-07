import { NextRequest, NextResponse, after } from "next/server";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { WorkflowEngine, ticketResource, decisiveGrants } from "@/lib/workflow";
import { loadCapabilityPolicyStrict, policyAllows, scopedTokensFor } from "@/lib/capabilityPolicy";
import { r2, R2_BUCKET } from "@/lib/r2";
import { isSafeStorageKey } from "@/lib/storageKey";
import { publicOrigin } from "@/lib/publicOrigin";
import { plainMentions, wrapEmailBody } from "@/lib/emailRender";
import { flaggedRequestTypes } from "@/lib/requestTypes";
import {
  computeTransition,
  classifyTransitionNotification,
  rowToTicket,
  escapeHtml,
  type TransitionInput,
} from "@/lib/ticketTransitions";
import type { Role, TicketAttachment } from "@/types/schema";
import { TICKET_INTENT_TTL_MS } from "@/lib/intents";
import { parseSourceDocument } from "@/lib/sourceDocRef";
import { heldRoles } from "@/lib/roleHeld";
import { noteDeliverableNotInRegister, deliverableStateOf } from "@/lib/ticketHandback";
import { resolveTicketRecipients } from "@/lib/ticketRouting";
import { ticketReadScope } from "@/lib/ticketReadScope";

// POST /api/tickets/workflow-action
//
// SERVER-SIDE workflow enforcement. The client sends only its inputs (action
// name + comment/picks/uploads); this route:
//   1. authenticates the caller (bearer token)
//   2. verifies active org membership and reads their role
//   3. validates the action against WorkflowEngine.getActions — the same
//      state machine the UI renders, now enforced where the client can't lie
//   4. recomputes the full update server-side (lib/ticketTransitions)
//   5. writes the audit row FIRST (EVID-12 / SM-7: a row that cannot be
//      written refuses the transition, nothing applied)
//   6. applies it compare-and-set on status (concurrent transitions -> 409,
//      recorded against the audit row as not applied)
//   7. fans out notifications + emails server-side, so neither can be
//      skipped by a closed tab or a tampered client.

interface Body {
  ticketId: string;
  actionType: string;
  comment?: string | null;
  preFilledComment?: string | null;
  category?: string | null;
  isReassigning?: boolean;
  assignment?: { id: string; name: string } | null;
  engineer?: { id: string; name: string; email: string } | null;
  redlineAttachment?: TicketAttachment | null;
  finalAttachment?: TicketAttachment | null;
  /** WF-9: the file an `attach_file` action adds. The bytes are already in
   *  storage (client upload); the ticket row's attachments + history write
   *  is what this route applies compare-and-set. */
  attachment?: TicketAttachment | null;
  /** LIFE-6 / DEC-25: how the closer addressed the hold(s) this ticket
   *  opened — release them now, or keep them with a stated reason. Absent
   *  when a close would leave one open, the close is refused (409 holds_open). */
  holdResolution?: { action: "release" | "keep"; reason?: string | null } | null;
}

/** DCW-4 / HAND-3: the shape of a register row id (document_versions.id,
 *  documents.id). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** EVID-12: the actions that approve a submitted draft — their audit row
 *  names the drafts the approval was given on. */
const APPROVING_ACTIONS: ReadonlySet<string> = new Set(["approve_draft_ifc", "engineer_approve_final", "approve_minor_correction"]);

/** SM-12: a member's name as the app shows it — display name, else the
 *  local part of their email; null when the membership row carries neither. */
function memberName(m: { display_name?: unknown; email?: unknown } | null | undefined): string | null {
  const display = typeof m?.display_name === "string" ? m.display_name.trim() : "";
  if (display) return display;
  const email = typeof m?.email === "string" ? m.email.trim() : "";
  return email ? email.split("@")[0] : null;
}

/** SM-12: the label a drafter is shown under when neither the membership row
 *  nor the account names them. It is never the client's string. */
const UNNAMED_MEMBER = "Unnamed member";

/** SM-12: the local part of the account's sign-in email (service role), or
 *  null when the account cannot be read or carries no email. */
async function accountName(uid: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(uid);
    const email = !error && typeof data?.user?.email === "string" ? data.user.email.trim() : "";
    return email ? email.split("@")[0] : null;
  } catch {
    return null;
  }
}

/** EVID-12: what an audit row records of a file — enough to match the
 *  approval to the object in storage. `etag` is the storage entity tag the
 *  route read when it vetted the file (null for one already on the ticket);
 *  it is the store's tag, not a content hash this route computed. */
function fileIdentity(a: TicketAttachment, etag: string | null | undefined) {
  return { id: a.id ?? null, name: a.name ?? null, url: a.url ?? null, size: a.size ?? null, etag: etag ?? null };
}

/** EVID-12 / SM-7 (DF-P1): one audit row, written with the fixed id it
 *  carries, so a retry after a lost reply finds it there (23505, the primary
 *  key) instead of writing it twice. Retried once. null when the row is in
 *  the table; otherwise the error. */
async function insertAuditRowOnce(row: { id: string } & Record<string, unknown>): Promise<string | null> {
  const attempt = async (): Promise<string | null> => {
    try {
      const { error } = await supabaseAdmin.from("audit_logs").insert(row);
      if (!error || (error as { code?: string }).code === "23505") return null;
      return error.message || "insert refused";
    } catch (e) {
      return (e as Error)?.message ?? String(e);
    }
  };
  return (await attempt()) && (await attempt());
}

function formatBytes(n: number | undefined): string | undefined {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * AUTHZ-11 / SM-13: a file record a client asks this route to append to the
 * ticket. Refused unless its key lies under the ticket's own prefix
 * (`orgs/<org>/tickets/<ticket number>/`, what uploadTicketAttachment mints)
 * and is a plain key, the slot's type rule holds (an issued package is typed
 * Final; a redline is a Reference; an attached file one of the four types),
 * and the object is in storage — or already listed on the ticket. Who
 * uploaded it, when, its size (from storage when it answers) and status are
 * stamped here; the client's claims about them are not kept.
 */
async function vetTicketAttachment(
  a: TicketAttachment,
  ctx: {
    slot: "attachment" | "finalAttachment" | "redlineAttachment";
    orgId: string;
    ticketNumber: string;
    listed: TicketAttachment[];
    uploadedBy: string;
  },
): Promise<{ ok: true; attachment: TicketAttachment; etag: string | null } | { ok: false; status: number; error: string }> {
  const url = typeof a?.url === "string" ? a.url : "";
  const name = typeof a?.name === "string" ? a.name.trim().slice(0, 255) : "";
  const prefix = `orgs/${ctx.orgId}/tickets/${ctx.ticketNumber}/`;
  if (!url || !name || !ctx.ticketNumber || !isSafeStorageKey(url) || !url.startsWith(prefix) || url.length <= prefix.length) {
    return { ok: false, status: 400, error: "That file is not stored under this request — upload it to the request and try again" };
  }
  const type = String(a.type ?? "");
  if (ctx.slot === "finalAttachment" && type !== "Final") {
    return { ok: false, status: 400, error: "Issuing the final IFC package requires a file typed Final" };
  }
  if (ctx.slot === "redlineAttachment" && type !== "Reference") {
    return { ok: false, status: 400, error: "A redline is attached as a Reference file" };
  }
  if (!["Source", "Reference", "Draft", "Final"].includes(type)) {
    return { ok: false, status: 400, error: "Attaching a file requires its name, type and storage URL" };
  }
  const alreadyListed = ctx.listed.find((x) => x?.url === url) ?? null;
  let size: string | undefined = alreadyListed?.size ?? undefined;
  let etag: string | null = null;
  if (!alreadyListed) {
    try {
      const head = await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: url }));
      size = formatBytes((head as { ContentLength?: number }).ContentLength) ?? size;
      etag = typeof (head as { ETag?: unknown }).ETag === "string" ? ((head as { ETag: string }).ETag).replace(/"/g, "") : null;
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
        return { ok: false, status: 400, error: "That file is not in storage — upload it again and retry" };
      }
      console.error(`[workflow-action] could not verify ${url} in storage:`, e);
      return { ok: false, status: 503, error: "The file could not be verified in storage right now — try again in a moment" };
    }
  }
  const status: TicketAttachment["status"] =
    ctx.slot === "attachment" ? (type === "Source" ? "submitted" : "staged") : "submitted";
  const attachment = {
    ...a,
    id: typeof a.id === "string" && a.id ? a.id : crypto.randomUUID(),
    name,
    url,
    type,
    status,
    size: size ?? a.size,
    uploadedBy: alreadyListed?.uploadedBy ?? ctx.uploadedBy,
    uploadedAt: alreadyListed?.uploadedAt ?? new Date().toISOString(),
  } as TicketAttachment;
  return { ok: true, attachment, etag };
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data: { user: caller }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.ticketId || !body.actionType) {
    return NextResponse.json({ error: "ticketId and actionType are required" }, { status: 400 });
  }

  // Load the ticket (service role — RLS doesn't apply; we enforce explicitly).
  const { data: row, error: loadErr } = await supabaseAdmin
    .from("tickets")
    .select("*")
    .eq("id", body.ticketId)
    .maybeSingle();
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  if ((row as { archived_at?: string | null }).archived_at) {
    return NextResponse.json(
      { error: "This ticket is archived; restore it from its archive before acting on it." },
      { status: 409 },
    );
  }
  const ticket = rowToTicket(row as Record<string, unknown>);

  // Active membership in the ticket's org + the caller's role.
  const { data: member } = await supabaseAdmin
    .from("org_members")
    .select("role, roles, email, display_name")
    .eq("org_id", ticket.orgId)
    .eq("uid", caller.id)
    .eq("status", "active")
    .maybeSingle();
  if (!member) {
    return NextResponse.json({ error: "Forbidden: not an active member of this workspace" }, { status: 403 });
  }
  // AUTHZ-13 (DEC-89): every action writes the ticket row, and the
  // transition adds its actor to `watchers` (lib/ticketTransitions.ts), which
  // is one of the Contractor-only read scope's legs. So a Contractor-only
  // member may act only on a ticket they can already read. Any other ticket
  // answers as an unreadable one does (404, naming neither its status nor the
  // actions on it), and nothing is written. This route runs as the service
  // role and cannot ask the database for auth.uid(); lib/ticketReadScope.ts
  // holds the same predicate as 20261166.
  const scope = await ticketReadScope(supabaseAdmin, member, caller.id, {
    id: body.ticketId, requesterId: ticket.requesterId, assignedDrafterId: ticket.assignedDrafterId,
    assignedEngineerId: ticket.assignedEngineerId, watchers: ticket.watchers,
  });
  if (scope === "unknown") {
    return NextResponse.json({ error: "Couldn't confirm you can see this request — try again in a moment" }, { status: 503 });
  }
  if (scope === "out") return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  const callerRole = (member.role as Role) ?? "Viewer";
  const callerEmail = (member.email as string | null) || caller.email || "Unknown";
  // WF-7: authority is evaluated against the FULL additive collection —
  // the headline alone SUBTRACTED authority from multi-role people.
  const callerRoles: Role[] = Array.isArray(member.roles) && (member.roles as Role[]).length > 0
    ? (member.roles as Role[])
    : [callerRole];

  // GAP-2/DEC-12: the independence predicates bind at >= 3 active members.
  const { count: activeMemberCount } = await supabaseAdmin
    .from("org_members")
    .select("uid", { count: "exact", head: true })
    .eq("org_id", ticket.orgId)
    .eq("status", "active");
  const sodActive = (activeMemberCount ?? 0) >= 3;

  // WF-15: close-without-review is a property of the CONFIGURED type.
  let closeWithoutReviewTypes: string[] = ["RFI"];
  let engineeringFirstTypes: string[] = [];
  try {
    const { data: cfgRow } = await supabaseAdmin
      .from("org_configurations")
      .select("data")
      .eq("org_id", ticket.orgId)
      .eq("key", "drafting")
      .maybeSingle();
    const opts = ((cfgRow?.data as { requestTypes?: { options?: Array<{ value?: string; closeWithoutReview?: boolean }> } } | null)
      ?.requestTypes?.options) ?? [];
    const flagged = opts.filter((o) => o.closeWithoutReview === true).map((o) => String(o.value ?? "")).filter(Boolean);
    if (flagged.length > 0) closeWithoutReviewTypes = flagged;
    // DRAFT-2: "engineering first" is the same kind of type property.
    engineeringFirstTypes = flaggedRequestTypes(cfgRow?.data, "engineeringFirst");
  } catch { /* default stands */ }

  // THE enforcement: the action must be one the state machine offers this
  // caller at the ticket's current status — evaluated with the ORG'S OWN
  // capability policy, so admin-configured authority is enforced here, not
  // just drawn in the UI.
  // WF-10: the version stamp names, in the audit row, which policy this
  // decision was made under.
  // AUTHZ-7: the read is STRICT and fresh — a failed read is a refusal, never
  // the shipped defaults (which are the WIDE end of every capability an org
  // narrows). "Nothing stored" is still the defaults: that is the org's policy.
  const loadedPolicy = await loadCapabilityPolicyStrict(ticket.orgId, supabaseAdmin);
  if (!loadedPolicy.ok) {
    console.error(`[workflow-action] capability policy unreadable for org ${ticket.orgId}: ${loadedPolicy.error}`);
    return NextResponse.json(
      { error: "This workspace's permission policy could not be read, so the action was not applied. Try again in a moment.", code: "policy_unreadable" },
      { status: 503 },
    );
  }
  const capPolicy = loadedPolicy.policy;
  const policyVersion = loadedPolicy.version;
  // DEC-16: the requester's CURRENT collection rides beside the snapshot, so
  // a demotion after filing cannot leave the engineer gate bypassed. A
  // requester who is no longer an active member is known to hold nothing.
  let requesterRoles: string[] = [];
  if (ticket.requesterId) {
    const { data: reqMember } = await supabaseAdmin
      .from("org_members").select("role, roles")
      .eq("org_id", ticket.orgId).eq("uid", ticket.requesterId).eq("status", "active").maybeSingle();
    requesterRoles = heldRoles(reqMember as { role?: unknown; roles?: unknown } | null);
  }
  const engineCtx = {
    userRoles: callerRoles,
    activeMemberCount: activeMemberCount ?? 0,
    engineeringFirstTypes,
    closeWithoutReviewTypes,
    requesterRoles,
  };
  const allowed = WorkflowEngine.getActions(ticket, callerRole, caller.id, capPolicy, engineCtx);
  // DEC-13 stage 2: the resource this ticket presents to the policy — the
  // same fields getActions just evaluated with.
  const resource = ticketResource(ticket);
  const action = allowed.find((a) => a.action === body.actionType);
  if (!action) {
    return NextResponse.json(
      { error: `Action "${body.actionType}" is not available to you at status ${ticket.status}` },
      { status: 403 },
    );
  }
  // GAP-2: a separation-of-duties block is rendered disabled in the UI and
  // REFUSED here — the reason travels with it.
  if (action.disabledReason) {
    return NextResponse.json({ error: action.disabledReason }, { status: 403 });
  }
  // WF-16: WHY is this action permitted? When a personal grant is what admits
  // the caller (the state machine would not offer the action without it),
  // the audit row names the grant — role authority and delegation are
  // otherwise indistinguishable in the log. Identity relations ride along
  // as fact; grants are unscoped (WF-13 row 6), so no resource is named.
  const usedGrants = decisiveGrants(ticket, callerRole, caller.id, capPolicy, engineCtx, action.action);
  const identity = [
    ticket.requesterId === caller.id ? "requester" : null,
    ticket.assignedDrafterId === caller.id ? "drafter" : null,
    ticket.assignedEngineerId === caller.id ? "engineer" : null,
  ].filter((x): x is string => !!x);
  const authority = {
    via: usedGrants.length > 0 ? "grant" : "role",
    ...(usedGrants.length > 0 ? { grants: usedGrants.map((g) => ({ cap: g.cap, expiresAt: g.expiresAt ?? null, grantedBy: g.grantedBy ?? null, grantedAt: g.grantedAt ?? null, note: g.note ?? null })) } : {}),
    ...(identity.length > 0 ? { identity } : {}),
    roles: callerRoles,
    policyVersion,
  };
  if (action.requiresComment && !body.comment?.trim()) {
    return NextResponse.json({ error: "This action requires a comment" }, { status: 400 });
  }
  if (action.requiresEngineerPick && !body.engineer?.id) {
    return NextResponse.json({ error: "This action requires picking an engineer" }, { status: 400 });
  }
  // WF-6: the file precondition is enforced HERE, not only in the browser —
  // a direct POST could previously mint a "Final package issued" ticket with
  // no deliverable at all.
  if (action.requiresFile && action.action === "submit_final" && !body.finalAttachment?.url) {
    return NextResponse.json({ error: "Issuing the final IFC package requires the deliverable file" }, { status: 400 });
  }
  // WF-22: a transition that requires an input is refused when it is missing —
  // an assignment-less "assign" used to no-op while still writing a success
  // audit row.
  if ((action.action === "assign" || action.action === "reassign_drafter") && !body.assignment?.id) {
    return NextResponse.json({ error: "Assigning requires picking a drafter" }, { status: 400 });
  }
  // WF-18: reassigning to the current drafter is a no-op that would still
  // write an audit row and a notification — refuse it.
  if (action.action === "reassign_drafter" && body.assignment?.id === ticket.assignedDrafterId) {
    return NextResponse.json({ error: "That drafter is already assigned to this request" }, { status: 400 });
  }
  // WF-9: attaching a file requires the file record — name, type and the
  // storage URL the client's upload returned.
  const ATTACHMENT_TYPES = ["Source", "Reference", "Draft", "Final"];
  if (action.action === "attach_file") {
    const a = body.attachment;
    if (!a?.url || !a.name || !ATTACHMENT_TYPES.includes(String(a.type))) {
      return NextResponse.json({ error: "Attaching a file requires its name, type and storage URL" }, { status: 400 });
    }
  }
  // AUTHZ-11 / SM-13: every file record this action appends is VETTED, not
  // trusted — its key lies under this ticket's own prefix (the one
  // uploadTicketAttachment mints: orgs/<org>/tickets/<ticket number>/), the
  // object is in storage (or already listed on the ticket), a Final is typed
  // Final, and who uploaded it, when, its size and status are stamped here.
  const vetted: { attachment?: TicketAttachment; finalAttachment?: TicketAttachment; redlineAttachment?: TicketAttachment } = {};
  const vettedEtags: Record<string, string | null> = {};
  const toVet: Array<["attachment" | "finalAttachment" | "redlineAttachment", TicketAttachment | null | undefined]> = [
    ["attachment", action.action === "attach_file" ? body.attachment : undefined],
    ["finalAttachment", action.action === "submit_final" ? body.finalAttachment : undefined],
    ["redlineAttachment", body.redlineAttachment],
  ];
  for (const [slot, a] of toVet) {
    if (!a) continue;
    const res = await vetTicketAttachment(a, {
      slot, orgId: ticket.orgId, ticketNumber: ticket.ticketId, listed: ticket.attachments ?? [],
      uploadedBy: callerEmail,
    });
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
    vetted[slot] = res.attachment;
    vettedEtags[slot] = res.etag;
  }

  // Referenced people must be active members of the same org — and a picked
  // "engineer" must actually hold an engineer role (headline or additive).
  // SM-12: the drafter's name on the row is the member's own (display name,
  // else their email's local part) — read here, never the client's string.
  let assigneeName: string | null = null;
  for (const ref of [body.engineer?.id, body.assignment?.id].filter(Boolean) as string[]) {
    const { data: refMember } = await supabaseAdmin
      .from("org_members")
      .select("uid, role, roles, display_name, email")
      .eq("org_id", ticket.orgId)
      .eq("uid", ref)
      .eq("status", "active")
      .maybeSingle();
    if (!refMember) {
      return NextResponse.json({ error: "Referenced user is not an active member of this workspace" }, { status: 400 });
    }
    const held: string[] = Array.isArray(refMember.roles) && refMember.roles.length > 0
      ? (refMember.roles as string[])
      : [String(refMember.role ?? "")];
    if (ref === body.engineer?.id) {
      if (!held.some((r) => r.includes("Engineer"))) {
        return NextResponse.json({ error: "The selected reviewer does not hold an Engineer role" }, { status: 400 });
      }
      // DEC-13 (DRAFT-1 / GAP-1): when the org scoped the reviewing
      // capability to THIS ticket's type, the picked engineer must satisfy
      // that rule. The assigned engineer acts by identity afterwards, so the
      // pick is where a type-scoped reviewer group is enforced. No scoped
      // rule → the Engineer-role check above is the whole test, as before.
      const pickCap = body.actionType === "request_eng_review" ? "ticket.eng_review" : "ticket.final_approve";
      const scoped = scopedTokensFor(capPolicy, pickCap, resource);
      if (scoped !== null && !policyAllows(capPolicy, pickCap, (held[0] ?? "Viewer") as Role, held as Role[], ref, resource)) {
        return NextResponse.json({
          error: `The selected reviewer is outside the group this workspace allows to review ${ticket.requestType} requests (${pickCap}: ${scoped.join(", ") || "nobody"})`,
        }, { status: 400 });
      }
      // WF-14 (+DEC-12, +DEC-37): the reviewer slot is INDEPENDENT of the
      // deliverable's producer and its beneficiary. In orgs of 3+ the picked
      // engineer may not be the requester, the assigned drafter, or the
      // caller — otherwise "two-stage engineering sign-off" can be one
      // person wearing every hat on the same ticket. Below 3 members the
      // single-person loop stays legal (DEC-12).
      if (sodActive) {
        if (ref === ticket.requesterId) {
          return NextResponse.json({ error: "Needs a second person: the requester can't be the engineer who reviews their own request (orgs of 3+)." }, { status: 403 });
        }
        if (ref === ticket.assignedDrafterId) {
          return NextResponse.json({ error: "Needs a second person: the drafter can't be the engineer who reviews their own deliverable (orgs of 3+)." }, { status: 403 });
        }
        if (ref === caller.id) {
          return NextResponse.json({ error: "Needs a second person: you can't pick yourself as the reviewing engineer (orgs of 3+)." }, { status: 403 });
        }
      }
    }
    if (ref === body.assignment?.id) {
      // WF-14 done-when 3: the assignee must actually hold drafting
      // authority under the org's policy — membership alone was the only
      // check before.
      const mayDraft = policyAllows(capPolicy, "ticket.draft_work",
        (held[0] ?? "Viewer") as Role, held as Role[], ref, resource);
      if (!mayDraft) {
        return NextResponse.json({ error: "The selected drafter does not hold drafting authority (ticket.draft_work)" }, { status: 400 });
      }
      // SM-12: never the client's string. A membership row with neither a
      // display name nor an email falls back to the account's sign-in email
      // (its local part), else a neutral label.
      assigneeName = memberName(refMember as { display_name?: unknown; email?: unknown }) ?? (await accountName(ref)) ?? UNNAMED_MEMBER;
      // GAP-2/DEC-12: the assigned drafter may not be the requester (3+).
      if (sodActive && ref === ticket.requesterId) {
        return NextResponse.json({ error: "Needs a second person: the requester can't draft their own request (orgs of 3+)." }, { status: 403 });
      }
    }
  }

  // AUTHZ-14: the gated requester's note to the engineer is what the engineer
  // signs off against — required here, not only by the picker dialog's
  // default (the engine action carries no requiresComment flag). Checked
  // after the engineer pick's own validation, before anything is written.
  if (action.action === "request_final_engineer_approval" && !body.comment?.trim()) {
    return NextResponse.json({ error: "Sending for engineer final approval requires a note for the engineer" }, { status: 400 });
  }

  const input: TransitionInput = {
    actionType: action.action,
    actionLabel: action.label,
    variant: action.variant,
    comment: body.comment ?? undefined,
    preFilledComment: body.preFilledComment ?? undefined,
    category: body.category ?? undefined,
    isReassigning: body.isReassigning,
    assignment: body.assignment ? { id: body.assignment.id, name: assigneeName ?? UNNAMED_MEMBER } : undefined,
    engineer: body.engineer ?? undefined,
    redlineAttachment: vetted.redlineAttachment,
    finalAttachment: vetted.finalAttachment,
    attachment: vetted.attachment,
    actor: { uid: caller.id, email: callerEmail, role: callerRole },
  };
  const { updates, newStatus, recipients: transitionRecipients, newComment } = computeTransition(ticket, input);
  // SM-12: self-assignment names the caller from their membership too
  // (computeTransition would derive it from the email's local part).
  if (action.action === "self_assign" && updates.assigned_drafter_id === caller.id) {
    updates.assigned_drafter_name = memberName(member as { display_name?: unknown; email?: unknown }) ?? callerEmail.split("@")[0];
  }
  let recipients = transitionRecipients;

  // WF-19: a ticket (RE-)entering the assignment queue tells the queue's
  // owners — the DraftingSupervisor pool, falling back to Admins, exactly as
  // the routing policy resolves them at creation (lib/ticketRouting.ts). The
  // default fan-out only knew requester + drafter, so every engineering-review
  // round-trip landed in the queue silently. The pool joins `unread_by` too
  // (the unread badge and the follow list read that column) and rides the
  // same in-app + email path as every other recipient.
  if (newStatus === "PENDING_ASSIGNMENT" && ticket.status !== "PENDING_ASSIGNMENT") {
    try {
      const pool = (await resolveTicketRecipients(ticket.orgId, "PENDING_ASSIGNMENT", caller.id, supabaseAdmin))
        .map((m) => m.uid);
      if (pool.length > 0) {
        const unread = new Set<string>([...((updates.unread_by as string[] | undefined) ?? []), ...pool]);
        unread.delete(caller.id);
        updates.unread_by = Array.from(unread);
        recipients = Array.from(new Set([...recipients, ...pool])).filter((u) => u !== caller.id);
      }
    } catch (e) {
      console.warn("[workflow-action] assignment-queue routing failed (non-blocking)", e);
    }
  }

  // DCW-4 / HAND-3 (DF-P1): a close believes a recorded "published"
  // deliverable only when the register backs it: a version of the source
  // document, in this org, carrying this ticket as its provenance (the proof
  // /api/tickets/handback checks before it records one). The register is read
  // HERE, before anything is written (the hold release below is the first
  // write). The read must SUCCEED: a row means backed, and a successful read
  // with no row means unbacked. A failed read (a timeout, a dropped
  // connection) proves nothing, so it is a 503 with nothing written. It never
  // rewrites a real publication as "not in the register". An id that is not a
  // UUID cannot name a register row: unbacked, with no read (and no
  // invalid-input error that would block every close).
  let unbackedPublish = false;
  if (newStatus === "CLOSED") {
    const closeSrc = parseSourceDocument(ticket.metadata);
    const recordedState = deliverableStateOf(ticket.metadata);
    if (closeSrc?.id && recordedState?.state === "published") {
      if (!UUID_RE.test(String(recordedState.version_id)) || !UUID_RE.test(closeSrc.id)) {
        unbackedPublish = true;
      } else {
        const { data: backing, error: backingErr } = await supabaseAdmin
          .from("document_versions").select("id")
          .eq("id", recordedState.version_id).eq("org_id", ticket.orgId)
          .eq("record_id", closeSrc.id).eq("related_ticket_id", body.ticketId)
          .maybeSingle();
        if (backingErr) {
          console.error(`[workflow-action] register read failed while closing ticket ${body.ticketId}: ${backingErr.message}`);
          return NextResponse.json(
            { error: "The document register could not be read to confirm this request's published deliverable, so the request was not closed. Try again in a moment.", code: "register_unreadable" },
            { status: 503 },
          );
        }
        unbackedPublish = !backing;
      }
    }
  }

  // LIFE-6 / DEC-25: a ticket cannot close silently over a hold it opened.
  // The closer releases it now, or records why it stays — never auto-release.
  // WF-17: the gate keys on the TERMINAL TRANSITION, not the action name —
  // `cancel_request` (DEC-14) ends the ticket exactly as a close does, so it
  // meets the same 409 holds_open and the same release-or-keep resolution.
  // EVID-12 / SM-7 (DF-P1): the hold read and its 409 come first; the release
  // or keep WRITES wait until the transition itself has landed (after the
  // compare-and-set, below), so a close that loses its race touches no hold.
  const TERMINAL_STATUSES: readonly string[] = ["CLOSED", "CANCELED"];
  let holdPlan: {
    holds: Array<{ id: string; document_id: string; reason: string; notes: string | null }>;
    resolution: NonNullable<Body["holdResolution"]>;
    reason: string;
  } | null = null;
  if (TERMINAL_STATUSES.includes(String(newStatus))) {
    const { data: openHolds, error: holdsErr } = await supabaseAdmin
      .from("document_holds")
      .select("id, document_id, reason, notes")
      .eq("origin_ticket_id", body.ticketId)
      .is("released_at", null);
    if (holdsErr && !/origin_ticket_id/.test(holdsErr.message)) {
      return NextResponse.json({ error: `Couldn't check this ticket's holds: ${holdsErr.message}` }, { status: 500 });
    }
    const holds = (openHolds ?? []) as Array<{ id: string; document_id: string; reason: string; notes: string | null }>;
    if (holds.length > 0) {
      const resolution = body.holdResolution ?? null;
      const reason = (resolution?.reason ?? "").trim();
      if (!resolution || (resolution.action === "keep" && !reason)) {
        return NextResponse.json({
          error: "This request opened a hold that is still active. Release it, or record why it stays, before closing.",
          code: "holds_open",
          holds: holds.map((h) => ({ id: h.id, documentId: h.document_id, reason: h.reason })),
        }, { status: 409 });
      }
      holdPlan = { holds, resolution, reason };
    }
  }

  // Audit — server-written, cannot be skipped by the client.
  // EVID-12 / SM-7 (DF-P1, the fleet plan's default): the row is written
  // BEFORE anything is applied — before the ticket's compare-and-set, the
  // first write (the hold release waits for the compare-and-set to land). A
  // transition whose audit row cannot be written is
  // refused: a 500 with nothing applied, so a retry is safe. It is never
  // "ok" with a missing row. The row carries a fixed id: a retry after a lost
  // reply finds it there (23505) instead of writing it twice. If the
  // transition then does not land (a lost compare-and-set, a refused write),
  // a TICKET_<ACTION>_NOT_APPLIED row names this row's id, so the trail never
  // shows a transition that did not happen as one that did. audit_logs stays
  // append-only: no row is ever updated. The details name what was decided
  // on: the deliverable revision, and the identity of every file the action
  // carried or approved.
  const auditRow = {
    id: crypto.randomUUID(),
    action: `TICKET_${action.action.toUpperCase()}`,
    resource_id: body.ticketId,
    resource_type: "ticket",
    org_id: ticket.orgId,
    user_id: caller.id,
    user_email: callerEmail,
    user_role: callerRole,
    details: {
      from: ticket.status, to: newStatus, label: action.label, authority,
      deliverable_rev: (updates.deliverable_rev as string | null | undefined) ?? ticket.deliverableRev ?? null,
      // WF-9 / WF-18: the audit row names WHAT was attached or WHO now drafts.
      ...(vetted.attachment
        ? { attachment: { ...fileIdentity(vetted.attachment, vettedEtags.attachment), type: vetted.attachment.type } }
        : {}),
      ...(vetted.finalAttachment ? { finalAttachment: fileIdentity(vetted.finalAttachment, vettedEtags.finalAttachment) } : {}),
      ...(vetted.redlineAttachment ? { redlineAttachment: fileIdentity(vetted.redlineAttachment, vettedEtags.redlineAttachment) } : {}),
      ...(APPROVING_ACTIONS.has(action.action)
        ? { approvedDrafts: (ticket.attachments ?? []).filter((a) => a?.type === "Draft" && a.status === "submitted").map((a) => fileIdentity(a, null)) }
        : {}),
      ...(action.action === "reassign_drafter" && body.assignment
        ? { from_drafter_id: ticket.assignedDrafterId ?? null, to_drafter_id: body.assignment.id, reason: body.comment ?? null }
        : {}),
      // Written before the compare-and-set; a TICKET_<ACTION>_NOT_APPLIED row
      // naming this id follows when the transition did not land.
      recordedBeforeApply: true,
    },
  };
  const auditErr = await insertAuditRowOnce(auditRow);
  if (auditErr) {
    console.error(`[workflow-action] AUDIT ROW NOT WRITTEN for ${auditRow.action} on ticket ${body.ticketId} (${ticket.status} → ${newStatus}) by ${caller.id}: ${auditErr} — the transition was refused, nothing applied`);
    return NextResponse.json({
      error: "The action was not applied: its audit record could not be written. Nothing changed — try again in a moment.",
      code: "audit_unwritable",
      applied: false,
    }, { status: 500 });
  }
  // The attempt row above stands for a transition that did not land: say so,
  // naming it. Retried once (fixed id, 23505 = landed); a failure is LOGGED
  // with both ids so the trail can be reconciled against the ticket's history.
  const recordNotApplied = async (reason: "conflict" | "write_failed", error?: string) => {
    const notApplied = {
      id: crypto.randomUUID(),
      action: `${auditRow.action}_NOT_APPLIED`,
      resource_id: body.ticketId,
      resource_type: "ticket",
      org_id: ticket.orgId,
      user_id: caller.id,
      user_email: callerEmail,
      user_role: callerRole,
      details: { attempt: auditRow.id, from: ticket.status, to: newStatus, reason, ...(error ? { error } : {}) },
    };
    const err = await insertAuditRowOnce(notApplied);
    if (err) {
      console.error(`[workflow-action] could not record that ${auditRow.action} (audit row ${auditRow.id}) on ticket ${body.ticketId} was NOT applied (${reason}) — reconcile from the ticket's history: ${err}`);
    }
  };

  // Compare-and-set on the status we validated against. If another reviewer
  // moved the ticket since, refuse to clobber their transition.
  // CAS on status AND last-modified: status alone let two no-status-change
  // actions (save_progress, comments) interleave and clobber each other's
  // whole-array attachments/comments/history writes.
  // LIFE-1 / GAP-6 (acceptance 5): closing a ticket that was raised against a
  // controlled document and produced no register revision leaves a VISIBLE,
  // QUERYABLE state on the ticket (`metadata.deliverable.state =
  // "not_in_register"`), a history line, and a note to the people told about
  // the close — never silence. It never publishes anything (DEC-22).
  let handbackNote: string | null = null;
  if (newStatus === "CLOSED") {
    try {
      const src = parseSourceDocument(ticket.metadata);
      // DCW-4 / HAND-3 (DF-P1): `unbackedPublish` was decided above, before
      // any write. A "published" state the register does not back (a
      // hand-written state, a version id no register holds) closes as NOT in
      // the register, visibly, never as a green "published".
      const recorded = deliverableStateOf(ticket.metadata);
      if (src?.id && (recorded?.state !== "published" || unbackedPublish)) {
        const { data: docRow } = await supabaseAdmin
          .from("documents").select("rev, document_number").eq("id", src.id).eq("org_id", ticket.orgId).maybeSingle();
        const registerRev = ((docRow as { rev?: string | null } | null)?.rev ?? null);
        const docLabel = ((docRow as { document_number?: string | null } | null)?.document_number) || src.documentNumber || "the source document";
        const base = unbackedPublish ? { ...(ticket.metadata ?? {}), deliverable: undefined } : ticket.metadata;
        const merged = noteDeliverableNotInRegister(base, { documentId: src.id, registerRev });
        if (merged) {
          updates.metadata = merged;
          handbackNote = unbackedPublish
            ? `Closed without a register revision: the recorded publication could not be matched to a revision of ${docLabel} in the register, which remains at Rev ${registerRev ?? "—"}. The deliverable is treated as not published.`
            : `Closed without a register revision: ${docLabel} remains at Rev ${registerRev ?? "—"}. The deliverable was not published as a revision.`;
          const history = Array.isArray(updates.history) ? (updates.history as Array<Record<string, unknown>>) : [...(ticket.history ?? [])];
          updates.history = [...history, { action: "Closed — deliverable not in the register", user: callerEmail, role: callerRole, date: new Date().toISOString(), details: handbackNote }];
        }
      }
    } catch (e) {
      console.warn("[workflow-action] deliverable-state note failed (non-blocking)", e);
    }
  }
  const transitionNote = [body.comment ?? null, handbackNote].filter((x): x is string => !!x && x.trim().length > 0).join("\n\n") || null;
  // WF-9: attaching a file is thread ACTIVITY, not a workflow transition —
  // the ticket is in the same state waiting on the same person afterwards.
  // It must not retire the outstanding workflow alerts ("you were assigned")
  // or queue a status-change email; it leaves a comment-style bell row.
  // AUTHZ-11: the bell and email text names the VETTED record (name trimmed
  // and capped, type checked), never the client's claim about the file.
  const isActivity = action.action === "attach_file";
  const fanOutComment = isActivity
    ? (vetted.attachment ? `Added ${vetted.attachment.type} file: ${vetted.attachment.name}` : null)
    : transitionNote;

  let baseQuery = supabaseAdmin
    .from("tickets")
    .update(updates)
    .eq("id", body.ticketId)
    .eq("status", ticket.status);
  // EDGE-15: a row with no token compare-and-sets on the null itself — the
  // first writer stamps it and a concurrent second gets the 409 — instead of
  // dropping to a status-only check.
  baseQuery = ticket.lastModified
    ? baseQuery.eq("last_modified", String(ticket.lastModified))
    : baseQuery.is("last_modified", null);
  let { data: updated, error: updErr } = await baseQuery
    .select("id")
    .maybeSingle();
  // Pre-migration tolerance: if the deliverable-rev columns (20260827) aren't
  // deployed yet, retry without them so the workflow itself never blocks on a
  // pending migration.
  if (updErr && (updErr.code === "PGRST204" || updErr.code === "42703") &&
      ("deliverable_rev" in updates || "draft_iteration" in updates)) {
    const { deliverable_rev: _dr, draft_iteration: _di, ...tolerant } = updates;
    void _dr; void _di;
    let tolerantQuery = supabaseAdmin
      .from("tickets")
      .update(tolerant)
      .eq("id", body.ticketId)
      .eq("status", ticket.status);
    tolerantQuery = ticket.lastModified
      ? tolerantQuery.eq("last_modified", String(ticket.lastModified))
      : tolerantQuery.is("last_modified", null);
    ({ data: updated, error: updErr } = await tolerantQuery
      .select("id")
      .maybeSingle());
  }
  if (updErr) {
    await recordNotApplied("write_failed", updErr.message);
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }
  if (!updated) {
    await recordNotApplied("conflict");
    return NextResponse.json(
      { error: "The ticket changed while you were acting — refresh and try again", conflict: true },
      { status: 409 },
    );
  }

  // LIFE-6 / DEC-25: the closer's hold resolution, applied only now that the
  // ticket has actually closed or been canceled. EVID-12 / SM-7 (DF-P1): a
  // close or cancel that loses its compare-and-set (above) has released no
  // hold and written no hold row, so its TICKET_<ACTION>_NOT_APPLIED row is
  // the whole truth. A release that fails here cannot un-close the ticket.
  // The hold stays active, the conservative state: the document stays
  // blocked and can be released from its hold panel. The release is retried
  // once. A second failure is recorded as a TICKET_<ACTION>_HOLDS_NOT_RELEASED
  // row naming the attempt row and the holds, logged, and returned to the
  // caller as `warning` / `holdsNotReleased` with the 200 (the transition
  // stands). It is never silent.
  let holdOutcome: { warning: string; holdsNotReleased: string[] } | null = null;
  if (holdPlan) {
    const { holds, resolution, reason } = holdPlan;
    if (resolution.action === "release") {
      const nowIso = new Date().toISOString();
      // A throw is a failure like a refused update: the transition has landed,
      // so nothing here may turn it into a 500.
      const releaseHolds = async (): Promise<{ data: unknown[] | null; error: { message: string } | null }> => {
        try {
          const { data, error } = await supabaseAdmin
            .from("document_holds")
            .update({ released_at: nowIso, released_by: caller.id, released_by_name: callerEmail ?? null,
                      released_reason: reason || `Released on ${newStatus === "CANCELED" ? "cancellation" : "close"} of ticket ${ticket.ticketId ?? body.ticketId}` })
            .in("id", holds.map((h) => h.id)).is("released_at", null).select("id");
          return { data: (data as unknown[] | null) ?? null, error: error ? { message: error.message || "update refused" } : null };
        } catch (e) {
          return { data: null, error: { message: (e as Error)?.message ?? String(e) } };
        }
      };
      let { data: released, error: relErr } = await releaseHolds();
      if (relErr) ({ data: released, error: relErr } = await releaseHolds());
      if (relErr) {
        const holdIds = holds.map((h) => h.id);
        console.error(`[workflow-action] ${auditRow.action} (audit row ${auditRow.id}) on ticket ${body.ticketId} landed (${newStatus}) but its hold(s) ${holdIds.join(", ")} could not be released; they stay active: ${relErr.message}`);
        const followErr = await insertAuditRowOnce({
          id: crypto.randomUUID(),
          action: `${auditRow.action}_HOLDS_NOT_RELEASED`,
          resource_id: body.ticketId,
          resource_type: "ticket",
          org_id: ticket.orgId,
          user_id: caller.id,
          user_email: callerEmail,
          user_role: callerRole,
          details: { attempt: auditRow.id, to: newStatus, holdIds, error: relErr.message },
        });
        if (followErr) {
          console.error(`[workflow-action] could not record that the holds of ${auditRow.action} (audit row ${auditRow.id}) on ticket ${body.ticketId} were NOT released: ${followErr}`);
        }
        holdOutcome = {
          warning: `The request was ${newStatus === "CANCELED" ? "canceled" : "closed"}, but its hold could not be released, so the document is still blocked. Release the hold from the document.`,
          holdsNotReleased: holdIds,
        };
      } else {
        for (const h of holds) {
          await supabaseAdmin.from("audit_logs").insert({
            action: "HOLD_RELEASED", resource_type: "document", resource_id: h.document_id, org_id: ticket.orgId,
            user_id: caller.id, user_email: callerEmail ?? null,
            details: { holdId: h.id, reason: h.reason, releasedReason: reason || null, viaTicketClose: body.ticketId, released: (released ?? []).length },
          }).then(() => undefined, () => undefined);
        }
      }
    } else {
      for (const h of holds) {
        await supabaseAdmin.from("audit_logs").insert({
          action: "HOLD_KEPT_ON_CLOSE", resource_type: "document", resource_id: h.document_id, org_id: ticket.orgId,
          user_id: caller.id, user_email: callerEmail ?? null,
          details: { holdId: h.id, reason: h.reason, keptBecause: reason, ticketId: body.ticketId, ticketOutcome: newStatus },
        }).then(() => undefined, () => undefined);
      }
    }
  }

  // Mirror the action's comment into the ticket_comments table so the two comment
  // stores stay in sync — computeTransition only appends to the JSONB thread, and
  // until now workflow comments never reached the table. Best-effort: the JSONB is
  // what the UI renders, so a table hiccup must not fail the transition.
  // SM-7 done-when 2: best-effort is not silent — a failed mirror is retried
  // once and then LOGGED with the comment and ticket ids, so the table can be
  // reconciled from the JSONB thread.
  if (newComment) {
    const mirrorRow = {
      id: newComment.id as string,
      org_id: ticket.orgId,
      ticket_id: body.ticketId,
      author_uid: (newComment.authorUid as string) ?? caller.id,
      author_email: (newComment.user as string) ?? callerEmail,
      author_role: (newComment.role as string) ?? callerRole,
      body: (newComment.text as string) ?? "",
      type: (newComment.type as string) ?? "General",
      category: (newComment.category as string | null) ?? null,
      mentioned_uids: [],
      created_at: (newComment.date as string) ?? new Date().toISOString(),
    };
    const mirror = async (): Promise<string | null> => {
      try {
        const { error } = await supabaseAdmin.from("ticket_comments").insert(mirrorRow);
        if (!error || (error as { code?: string }).code === "23505") return null; // landed (a retry after a lost reply finds it there)
        return error.message || "insert refused";
      } catch (e) {
        return (e as Error)?.message ?? String(e);
      }
    };
    const mirrorErr = (await mirror()) && (await mirror());
    if (mirrorErr) {
      console.error(`[workflow-action] ticket_comments mirror failed for comment ${mirrorRow.id} on ticket ${body.ticketId} — reconcile from tickets.comments: ${mirrorErr}`);
    }
  }

  // Ticket ⇄ intent bridge: a ticket entering DRAFTING registers the drafter's
  // EDIT INTENT on the source document — visible on the coordination surfaces
  // and feeding overlap advisories, WITHOUT taking a lock (intent decays on
  // its own; no zombie-lock factory). Ticket closure — or cancellation, the
  // other terminal exit (WF-17) — clears it. Best-effort: never fails the
  // transition; no-op on pre-migration envs.
  try {
    const srcDoc = (ticket.metadata as Record<string, unknown> | undefined)
      ?.source_document as { id?: string } | undefined;
    if (srcDoc?.id) {
      const drafterId =
        (updates.assigned_drafter_id as string | undefined) ?? ticket.assignedDrafterId;
      const drafterName =
        (updates.assigned_drafter_name as string | undefined) ?? ticket.assignedDrafterName;
      const isReassign = action.action === "reassign_drafter";
      // Statuses where the ticket's intents are cleared wholesale (below).
      const clearsAll = newStatus === "CLOSED" || newStatus === "CANCELED" || newStatus === "FINAL_DRAFT";
      // WF-18: a reassignment hands the ticket to a different drafter, so
      // the PREVIOUS drafter's ticket-sourced intent is retired now rather
      // than lingering on the coordination surfaces until its TTL — two
      // drafters were shown editing for one ticket. Reassignment never
      // moves the status, and it is offered at every live status with a
      // drafter (PENDING_REVIEW, PENDING_FINAL_APPROVAL and PENDING_IFC
      // included), so the retirement runs for all of them — not only the
      // two statuses that register an intent.
      if (isReassign && !clearsAll && ticket.assignedDrafterId && ticket.assignedDrafterId !== drafterId) {
        await supabaseAdmin
          .from("document_intents")
          .delete()
          .eq("document_id", srcDoc.id)
          .eq("ticket_id", body.ticketId)
          .eq("source", "ticket")
          .eq("user_id", ticket.assignedDrafterId);
      }
      // The new drafter is registered where the ticket is on a drafter's
      // bench: entering DRAFTING / REVISION_REQ (every assignment), and on
      // reassignment at PENDING_IFC (the package is being issued). A
      // reassignment while the draft is under review registers nothing —
      // the next return to REVISION_REQ does.
      const registersDrafter =
        newStatus === "DRAFTING" || newStatus === "REVISION_REQ" || (isReassign && newStatus === "PENDING_IFC");
      if (registersDrafter) {
        // SM-14: the source document is read IN THE TICKET'S ORG (as the
        // CLOSED hand-back path reads it); a document id from another
        // workspace registers nothing.
        const { data: docRow } = drafterId
          ? await supabaseAdmin
              .from("documents")
              .select("current_version_id, library_id")
              .eq("id", srcDoc.id)
              .eq("org_id", ticket.orgId)
              .maybeSingle()
          : { data: null };
        if (drafterId && docRow) {
          await supabaseAdmin.from("document_intents").upsert(
            {
              org_id: ticket.orgId,
              document_id: srcDoc.id,
              library_id: (docRow as { library_id?: string | null } | null)?.library_id ?? null,
              user_id: drafterId,
              user_name: drafterName ?? null,
              kind: "edit",
              source: "ticket",
              base_version_id:
                (docRow as { current_version_id?: string | null } | null)?.current_version_id ?? null,
              ticket_id: body.ticketId,
              refreshed_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + TICKET_INTENT_TTL_MS).toISOString(),
            },
            { onConflict: "document_id,user_id,kind,source" },
          );
        }
      } else if (clearsAll) {
        await supabaseAdmin
          .from("document_intents")
          .delete()
          .eq("document_id", srcDoc.id)
          .eq("ticket_id", body.ticketId)
          .eq("source", "ticket");
      }
    }
  } catch (e) {
    console.warn("[workflow-action] intent bridge failed (non-blocking)", e);
  }

  // Fan-out — also server-side, so it survives the client closing the tab.
  // Failures here never fail the action (the transition is already committed);
  // they're logged for the maintenance cron's visibility.
  // EDGE-9: links in an EMAIL resolve against the mail client, so they are
  // absolute — the configured public origin (lib/publicOrigin.ts, with its
  // server fallback to Vercel's production domain), else the origin this
  // request arrived on.
  const emailOrigin = publicOrigin() || new URL(req.url).origin;
  try {
    await fanOut({ ticket, ticketId: body.ticketId, action: { type: action.action, label: action.label }, newStatus: String(newStatus), recipients, actorUid: caller.id, actorEmail: callerEmail, activity: isActivity, comment: fanOutComment, emailOrigin });
    // Kick the email drain AFTER the response is sent (the daily cron is the
    // fallback, not the primary path — recipients should get email in seconds).
    // WF-19 done-when 3: CRON_SECRET ships blank, and a blank bearer is a
    // 401 at the drain — so in a default deployment every workflow email
    // waited for the daily cron. The caller's own session token is a
    // legitimate drain credential (SURF-5 scopes it to their orgs, which
    // include this ticket's), so it is the fallback.
    const drainUrl = new URL("/api/notifications/send-queued", req.url);
    const drainToken = process.env.CRON_SECRET || authHeader.slice(7);
    after(async () => {
      try {
        await fetch(drainUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${drainToken}` },
        });
      } catch { /* cron fallback */ }
    });
  } catch (e) {
    console.error("[workflow-action] fan-out failed (transition committed):", e);
  }

  return NextResponse.json({ ok: true, status: newStatus, ...(holdOutcome ?? {}) });
}

async function fanOut(params: {
  ticket: ReturnType<typeof rowToTicket>;
  ticketId: string;
  action: { type: string; label: string };
  newStatus: string;
  recipients: string[];
  actorUid: string;
  actorEmail: string;
  comment: string | null;
  /** WF-9: true for thread activity (a file attachment) — no alert
   *  supersede, no email, a comment-style bell row without metadata.action
   *  (so the badge hook's stale-alert reconciliation leaves it alone). */
  activity?: boolean;
  /** EDGE-9: the absolute origin email links are built on. */
  emailOrigin: string;
}) {
  const { ticket, ticketId, action, newStatus, recipients, actorUid, actorEmail, comment, activity, emailOrigin } = params;
  if (recipients.length === 0) return;

  const ticketLabel = `${ticket.ticketId || ""} ${ticket.title}`.trim();
  // In-app rows navigate inside the app (relative); the email link leaves it.
  const link = `/requests/${ticketId}`;
  const emailLink = `${emailOrigin.replace(/\/+$/, "")}${link}`;
  const actorName = actorEmail.split("@")[0];

  // NEDGE-14 (notifications Round G, N6): only ACTIVE members of the ticket's
  // org hear about it — the predicate emit() applies centrally
  // (lib/notify/recipients.ts activeMembersOf), read here on the service role
  // together with the addresses. A read that fails keeps today's bell
  // audience (a transient error never silently drops a notice) and mails no
  // one (no address was read).
  const { data: members, error: membersErr } = await supabaseAdmin
    .from("org_members").select("uid, email").eq("org_id", ticket.orgId).eq("status", "active").in("uid", recipients);
  if (membersErr) console.warn("[workflow-action] active-membership read failed — recipients not filtered, no email sent", membersErr.message);
  const active = membersErr ? null : ((members as Array<{ uid: string; email: string | null }> | null) ?? []);
  const activeUids = new Set((active ?? []).map((m) => m.uid));
  const audience = active ? recipients.filter((uid) => activeUids.has(uid)) : recipients;

  if (activity) {
    if (audience.length === 0) return;
    // DELIV-7 dw3: a refused insert is logged, never silently dropped.
    const { error: activityErr } = await supabaseAdmin.from("notifications").insert(
      audience.map((uid) => ({
        org_id: ticket.orgId,
        user_id: uid,
        kind: "ticket_comment",
        title: `File added · ${ticketLabel}`,
        body: comment || "A file was added to this request",
        link,
        resource_type: "ticket",
        resource_id: ticketId,
        actor_user_id: actorUid,
        actor_name: actorName,
        metadata: { activity: action.type, status: newStatus },
      })),
    );
    if (activityErr) console.error("[workflow-action] activity bell rows were not written (transition committed):", activityErr.message);
    return;
  }

  const cls = classifyTransitionNotification({ actionType: action.type, actionLabel: action.label, ticketLabel });

  // 0) Supersede earlier unread WORKFLOW alerts for this ticket. A workflow
  //    notification (one carrying metadata.action) says "the ticket is in state
  //    X, act on it". The moment it transitions, that's no longer true, so we
  //    retire the old rows for everyone — otherwise a stale "issue the IFC" /
  //    "needs assignment" alert lingers in the recipient's bell long after the
  //    work moved on. Comment/mention rows have no metadata.action and are
  //    intentionally left untouched. Best-effort: never block the transition.
  //    EVID-13: retiring an alert is MARKED (metadata.superseded_at / _by), and
  //    read_at is never touched — read_at means the recipient opened it, and
  //    is the only "did they see it" signal there is. The bell's unread list
  //    leaves superseded rows out (lib/inAppNotifications.ts).
  try {
    const supersededAt = new Date().toISOString();
    const { data: stale } = await supabaseAdmin.from("notifications")
      .select("id, metadata")
      .eq("resource_id", ticketId)
      .eq("org_id", ticket.orgId)
      .is("read_at", null)
      .not("metadata->>action", "is", null)
      .is("metadata->>superseded_at", null);
    for (const row of (stale ?? []) as Array<{ id: string; metadata: Record<string, unknown> | null }>) {
      await supabaseAdmin.from("notifications")
        .update({ metadata: { ...(row.metadata ?? {}), superseded_at: supersededAt, superseded_by: action.type } })
        .eq("id", row.id)
        .is("read_at", null);
    }
  } catch (e) {
    console.warn("[workflow-action] superseding stale notifications failed:", e);
  }

  // 1) In-app bell rows — to the active audience only (NEDGE-14). The stale
  //    alerts above are retired whoever is left to tell.
  if (audience.length === 0) return;
  const { error: bellErr } = await supabaseAdmin.from("notifications").insert(
    audience.map((uid) => ({
      org_id: ticket.orgId,
      user_id: uid,
      kind: cls.inAppKind,
      title: cls.inAppTitle,
      body: comment || `Status: ${newStatus}`,
      link,
      resource_type: "ticket",
      resource_id: ticketId,
      actor_user_id: actorUid,
      actor_name: actorName,
      metadata: { action: action.type, status: newStatus },
    })),
  );
  if (bellErr) console.error("[workflow-action] bell rows were not written (transition committed):", bellErr.message);

  // 2) Email queue — preference-aware (defaults all-on when no prefs row).
  const [{ data: prefs }, { data: orgRow }] = await Promise.all([
    supabaseAdmin.from("notification_preferences").select("*").in("user_id", recipients),
    supabaseAdmin.from("orgs").select("name").eq("id", ticket.orgId).maybeSingle(),
  ]);
  const orgName = ((orgRow as { name?: string | null } | null)?.name ?? null);
  const emailByUid = new Map<string, string>();
  (active ?? []).forEach((m) => {
    if (m.email) emailByUid.set(m.uid, m.email);
  });
  const prefByUid = new Map<string, Record<string, unknown>>();
  ((prefs as Array<Record<string, unknown>>) ?? []).forEach((p) => prefByUid.set(p.user_id as string, p));

  const wantsEmail = (uid: string): boolean => {
    const p = prefByUid.get(uid);
    if (!p) return true;
    if (p.email_enabled === false) return false;
    if (p.digest_frequency === "never") return false;
    switch (cls.eventType) {
      case "assignment":
      case "engineer_review_requested":
        return p.email_on_assignment !== false;
      case "ticket_status_changed":
      case "ticket_approved":
      case "ticket_revision_requested":
      case "ticket_closed":
        return p.email_on_status_change !== false;
      default:
        return true;
    }
  };

  // NEDGE-10 dw2: a note's mention markup reaches the email as names; the
  // render layer adds the footer (lib/emailRender.ts — the drain then
  // attaches the one-click unsubscribe header).
  const note = comment ? plainMentions(comment) : null;
  const composedText = `${actorEmail} performed: ${action.label}\n\nStatus is now: ${newStatus}\n${note ? `\nNote: ${note}\n` : ""}\n${emailLink}`;
  const composedHtml = `
        <p><b>${escapeHtml(actorEmail)}</b> performed <b>${escapeHtml(action.label)}</b> on <a href="${escapeHtml(emailLink)}">${escapeHtml(ticketLabel)}</a>.</p>
        <p>Status: <b>${escapeHtml(newStatus)}</b></p>
        ${note ? `<blockquote style="border-left:3px solid #cbd5e1;padding-left:12px;color:#475569;white-space:pre-wrap">${escapeHtml(note)}</blockquote>` : ""}
        <p><a href="${escapeHtml(emailLink)}">Open ticket</a></p>`;
  let body: { bodyText: string; bodyHtml: string } | null = null;
  try {
    body = wrapEmailBody({ text: composedText, html: composedHtml, orgName, origin: emailOrigin });
  } catch (e) {
    console.warn("[workflow-action] email not rendered (queued as composed):", (e as Error).message);
  }

  const emailRows = audience
    .filter((uid) => emailByUid.has(uid) && wantsEmail(uid))
    .map((uid) => ({
      org_id: ticket.orgId,
      to_user_id: uid,
      to_email: emailByUid.get(uid)!,
      subject: cls.emailSubject,
      body_text: body ? body.bodyText : composedText,
      body_html: body ? body.bodyHtml : composedHtml,
      resource_type: "ticket",
      resource_id: ticketId,
      event_type: cls.eventType,
      metadata: { action: action.type, status: newStatus, ...(body ? { rendered: true } : {}) },
      status: "queued",
    }));
  if (emailRows.length > 0) {
    const { error: mailErr } = await supabaseAdmin.from("email_notifications").insert(emailRows);
    if (mailErr) console.error("[workflow-action] emails were not queued (transition committed):", mailErr.message);
  }
}
