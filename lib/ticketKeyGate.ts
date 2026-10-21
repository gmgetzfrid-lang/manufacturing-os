// lib/ticketKeyGate.ts — the bytes doors' read decision for a drafting-ticket
// file key (drafting-flow AUTHZ-4 / EVID-16 done-when 2's remainder, DF-P11;
// ruled by the integrator under DEC-90, 2026-10-20, ruling (2)).
//
// Every file a drafting request carries is stored under orgs/<org>/tickets/
// (lib/storage.ts makeTicketAttachmentPath: orgs/<org>/tickets/<number>/…,
// and the requester's staging folder orgs/<org>/tickets/pending/<uid>/…,
// lib/ticketCreate.ts). /api/storage/download-url and /api/storage/resolve
// used to sign such a key for any active member of the workspace. The
// database narrows who may READ a ticket (20261166, DEC-89 item 1: a member
// every one of whose held roles is Contractor reads only the tickets they
// requested, draft, review as engineer, follow, or were mentioned on), so
// signing the ticket's files on membership alone handed a Contractor-only
// member the bytes of a request they cannot open.
//
// The rule, the one /api/tickets/copy applies (lib/ticketReadScope.ts — the
// SQL's predicate, mirrored):
//   * a member who is NOT Contractor-only keeps exactly today's access: no
//     further read is made and the key is signed as before (DF-P11 fix pass
//     3: the routes hand over the role / roles of the membership row they
//     already read, so such a member is decided with no second org_members
//     read that could fail — a 503 here would be a regression);
//   * a key some document_versions row names is decided by the document gate
//     (lib/documentKeyGate.ts, DEC-43's controller rail and record) — this
//     gate stands aside;
//   * a Contractor-only member's own staged file is theirs;
//   * otherwise the key is signed only when a ticket of the key's workspace
//     that names it in `attachments` is inside the member's read scope —
//     asked of EVERY such ticket, never a capped sample (DF-P11 fix pass 2:
//     a `.limit(25)` let a member entitled to the 26th ticket be refused):
//     the direct legs (requester, drafter, engineer, watcher) are filtered
//     in the query itself, then the mention leg pages through the naming
//     tickets' ids; past MAX_TICKET_PAGES pages the answer is 503 — a bound
//     is never a 403;
//   * a read that cannot be made (the member row when the route did not
//     hand one over, the document lookup, the ticket lookup, the mention
//     lookup) answers 503 — never a signed URL on
//     a check not made.
// Shared by the two routes; a Next route module is no library.
//
// An intake redline appended to a request (append_ticket_redline) lives
// under orgs/<org>/project-intake/<p>/redlines/…, outside the tickets/
// prefix: intakeRedlineKeyGate below decides it (DF-P11 integrator fix pass;
// ruled by the integrator at the DF-P11 merge, 2026-10-21, DEC-90 — it was
// signed on membership alone).

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { documentsNamingKey, ACCESS_UNVERIFIED } from "@/lib/documentKeyGate";
import { isContractorOnly } from "@/lib/ticketReadScope";
import { isStagedKeyOf } from "@/lib/ticketCreate";
import { memberHoldsAny } from "@/lib/roleHeld";

/** A key under the drafting-request prefix of some workspace. */
const TICKET_KEY_RE = /^orgs\/([0-9a-fA-F-]{36})\/tickets\//;

/** The refusal a caller outside the ticket's read scope gets (the document
 *  gate's wording for the same decision). */
export const TICKET_FILE_REFUSED = "Not authorized for this file";

/** True when `path` is stored under a workspace's drafting-request prefix. */
export function isTicketFileKey(path: string): boolean {
  return TICKET_KEY_RE.test(path);
}

type TicketScopeRow = {
  id: string;
  requester_id: string | null;
  assigned_drafter_id: string | null;
  assigned_engineer_id: string | null;
  watchers: string[] | null;
};

/** Ids per page of the mention leg's walk over the tickets naming a key. */
export const TICKET_PAGE = 200;
/** Pages walked before the gate answers 503 instead of guessing. */
export const MAX_TICKET_PAGES = 50;

/** The direct legs of lib/ticketReadScope.ts, on one row. */
function directLeg(t: TicketScopeRow, uid: string): boolean {
  return t.requester_id === uid || t.assigned_drafter_id === uid || t.assigned_engineer_id === uid
    || (Array.isArray(t.watchers) && t.watchers.includes(uid));
}

/**
 * May this member be handed a URL for this ticket-file key? `null` = yes (or
 * the key is not a ticket file, or a document decides it); otherwise the
 * refusal to send. `keyOrg` is the workspace the key was attributed to (its
 * orgs/<org>/ prefix); the caller has already checked an active membership
 * there. `memberRow` is that membership row's role / roles, when the caller
 * read them (both routes do): the gate then makes no org_members read of
 * its own. Without it the gate reads the row, and a failed read is a 503.
 */
export async function ticketKeyGate(
  keyOrg: string,
  path: string,
  user: { id: string },
  memberRow?: { role?: unknown; roles?: unknown } | null,
): Promise<NextResponse | null> {
  if (!isTicketFileKey(path)) return null;
  const refuse = (error: string, status: number) => NextResponse.json({ error }, { status });
  try {
    let member: { role?: unknown; roles?: unknown } | null = memberRow ?? null;
    if (!member) {
      const { data, error: memberErr } = await supabaseAdmin
        .from("org_members")
        .select("role, roles")
        .eq("org_id", keyOrg)
        .eq("uid", user.id)
        .eq("status", "active")
        .maybeSingle();
      if (memberErr) return refuse(ACCESS_UNVERIFIED, 503);
      if (!data) return refuse("Not a member of this workspace", 403);
      member = data as { role?: unknown; roles?: unknown };
    }
    // Everyone the database lets read the workspace's tickets keeps today's
    // access, with no further lookup.
    if (!isContractorOnly(member)) return null;

    // A key a revision names is the document gate's (DEC-43): it ran first.
    const docIds = await documentsNamingKey(path); // throws → 503 below
    if (docIds.length > 0) return null;

    // The member's own staged upload (before its ticket exists, or a
    // creation-time file whose re-key never ran).
    if (isStagedKeyOf(path, keyOrg, user.id)) return null;

    const scope = await contractorReadsTicketNaming(keyOrg, path, user.id);
    if (scope === "unverified") return refuse(ACCESS_UNVERIFIED, 503);
    if (scope === "yes") return null;
    return refuse(TICKET_FILE_REFUSED, 403);
  } catch {
    return refuse(ACCESS_UNVERIFIED, 503);
  }
}

/** lib/ticketReadScope.ts's legs for a Contractor-only member, asked of EVERY
 *  ticket of `keyOrg` whose `attachments` name `path`: "yes" when one is in
 *  the member's read scope, "no" when none is, "unverified" when a read
 *  failed or the page bound was reached (the caller answers 503). Moved out
 *  of ticketKeyGate unchanged (DF-P11 integrator fix pass) so the intake
 *  redline gate asks the same question. */
async function contractorReadsTicketNaming(keyOrg: string, path: string, uid: string): Promise<"yes" | "no" | "unverified"> {
  const attachments = JSON.stringify([{ url: path }]);
  // 1. The direct legs, filtered in the query: any ticket naming the key on
  //    which the member is requester, drafter, engineer or a watcher. The
  //    row is re-checked here (lib/ticketReadScope.ts's legs).
  const { data: direct, error: directErr } = await supabaseAdmin
    .from("tickets")
    .select("id, requester_id, assigned_drafter_id, assigned_engineer_id, watchers")
    .eq("org_id", keyOrg)
    .contains("attachments", attachments)
    .or(`requester_id.eq.${uid},assigned_drafter_id.eq.${uid},assigned_engineer_id.eq.${uid},watchers.cs.{${uid}}`)
    .limit(1);
  if (directErr) return "unverified";
  const directRows = (Array.isArray(direct) ? direct : direct ? [direct] : []) as TicketScopeRow[];
  if (directRows.some((t) => directLeg(t, uid))) return "yes";

  // 2. The mention leg, over EVERY ticket naming the key (paged): a live
  //    comment on one of them that mentions the member — ticketReadScope's
  //    mention lookup, asked per page instead of per ticket.
  for (let page = 0; ; page++) {
    if (page >= MAX_TICKET_PAGES) return "unverified";
    const { data: idRows, error: idErr } = await supabaseAdmin
      .from("tickets")
      .select("id")
      .eq("org_id", keyOrg)
      .contains("attachments", attachments)
      .order("id", { ascending: true })
      .range(page * TICKET_PAGE, page * TICKET_PAGE + TICKET_PAGE - 1);
    if (idErr) return "unverified";
    const ids = ((Array.isArray(idRows) ? idRows : idRows ? [idRows] : []) as Array<{ id: string }>).map((r) => r.id).filter(Boolean);
    if (ids.length === 0) break;
    const { data: hit, error: hitErr } = await supabaseAdmin
      .from("ticket_comments")
      .select("id")
      .in("ticket_id", ids)
      .contains("mentioned_uids", [uid])
      .is("deleted_at", null)
      .limit(1);
    if (hitErr) return "unverified";
    if ((hit ?? []).length > 0) return "yes";
    if (ids.length < TICKET_PAGE) break;
  }
  return "no";
}

// ── Intake redlines (DF-P11 integrator fix pass, EVID-16 done-when 2) ───────

/** A redline the contractor door stores for a request:
 *  orgs/<org>/project-intake/<project>/redlines/<file> (app/api/intake/
 *  upload/route.ts; the database's intake_door_append_redline pins the
 *  same shape). */
const INTAKE_REDLINE_KEY_RE = /^orgs\/([0-9a-fA-F-]{36})\/project-intake\/([^/]+)\/redlines\/[^/]+$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The project a redline key is stored under, or null when `path` is not an
 *  intake redline key. */
export function intakeRedlineProject(path: string): string | null {
  return path.match(INTAKE_REDLINE_KEY_RE)?.[2] ?? null;
}

/** The controller tier (DEC-43), headline or additive. */
const CONTROLLER_ROLES = ["Admin", "DocCtrl"] as const;

/**
 * May this member be handed a URL for an intake redline key? `null` = yes (or
 * the key is not an intake redline, or a document decides it); otherwise the
 * refusal. Ruled by the integrator at the DF-P11 merge, 2026-10-21 (DEC-90):
 * signed only for a caller who may read that project's intake — the
 * workspace's controller tier or a member of the project (its owner or a
 * project_members row; the intake surfaces' rule) — and, so every legitimate
 * reader keeps access, for anyone who may read a request that carries the
 * redline (it is only ever shown as a request attachment): a member who is
 * not Contractor-only reads every request of the workspace (tickets RLS), a
 * Contractor-only member the requests in their read scope
 * (lib/ticketReadScope.ts). A read that cannot be made answers 503; a member
 * none of these admits gets 403.
 */
export async function intakeRedlineKeyGate(
  keyOrg: string,
  path: string,
  user: { id: string },
  memberRow?: { role?: unknown; roles?: unknown } | null,
): Promise<NextResponse | null> {
  const projectId = intakeRedlineProject(path);
  if (projectId === null || !path.startsWith(`orgs/${keyOrg}/`)) return null;
  const refuse = (error: string, status: number) => NextResponse.json({ error }, { status });
  try {
    let member: { role?: unknown; roles?: unknown } | null = memberRow ?? null;
    if (!member) {
      const { data, error: memberErr } = await supabaseAdmin
        .from("org_members").select("role, roles")
        .eq("org_id", keyOrg).eq("uid", user.id).eq("status", "active").maybeSingle();
      if (memberErr) return refuse(ACCESS_UNVERIFIED, 503);
      if (!data) return refuse("Not a member of this workspace", 403);
      member = data as { role?: unknown; roles?: unknown };
    }
    // The controller tier reads every project's intake (no further read).
    if (memberHoldsAny(member, CONTROLLER_ROLES)) return null;

    // A key a revision names is the document gate's (DEC-43): it ran first.
    const docIds = await documentsNamingKey(path); // throws → 503 below
    if (docIds.length > 0) return null;

    // A member of the project: its owner, or on its roster.
    if (UUID_RE.test(projectId)) {
      const { data: project, error: projErr } = await supabaseAdmin
        .from("projects").select("id, owner_user_id")
        .eq("id", projectId).eq("org_id", keyOrg).maybeSingle();
      if (projErr) return refuse(ACCESS_UNVERIFIED, 503);
      if (project) {
        if ((project as { owner_user_id?: string | null }).owner_user_id === user.id) return null;
        const { data: roster, error: rosterErr } = await supabaseAdmin
          .from("project_members").select("user_id")
          .eq("project_id", projectId).eq("user_id", user.id).limit(1);
        if (rosterErr) return refuse(ACCESS_UNVERIFIED, 503);
        if (((roster ?? []) as unknown[]).length > 0) return null;
      }
    }

    // A reader of a request that carries the redline.
    if (!isContractorOnly(member)) {
      const { data: naming, error: namingErr } = await supabaseAdmin
        .from("tickets").select("id")
        .eq("org_id", keyOrg)
        .contains("attachments", JSON.stringify([{ url: path }]))
        .limit(1);
      if (namingErr) return refuse(ACCESS_UNVERIFIED, 503);
      if (((Array.isArray(naming) ? naming : naming ? [naming] : []) as unknown[]).length > 0) return null;
      return refuse(TICKET_FILE_REFUSED, 403);
    }
    const scope = await contractorReadsTicketNaming(keyOrg, path, user.id);
    if (scope === "unverified") return refuse(ACCESS_UNVERIFIED, 503);
    if (scope === "yes") return null;
    return refuse(TICKET_FILE_REFUSED, 403);
  } catch {
    return refuse(ACCESS_UNVERIFIED, 503);
  }
}
