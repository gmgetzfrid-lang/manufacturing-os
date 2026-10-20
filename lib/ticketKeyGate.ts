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
//     further read is made and the key is signed as before;
//   * a key some document_versions row names is decided by the document gate
//     (lib/documentKeyGate.ts, DEC-43's controller rail and record) — this
//     gate stands aside;
//   * a Contractor-only member's own staged file is theirs;
//   * otherwise the key is signed only when a ticket of the key's workspace
//     that names it in `attachments` is inside the member's read scope;
//   * a read that cannot be made (the member row, the document lookup, the
//     ticket lookup, the mention lookup) answers 503 — never a signed URL on
//     a check not made.
// Shared by the two routes; a Next route module is no library.

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { documentsNamingKey, ACCESS_UNVERIFIED } from "@/lib/documentKeyGate";
import { isContractorOnly, ticketReadScope } from "@/lib/ticketReadScope";
import { isStagedKeyOf } from "@/lib/ticketCreate";

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

/**
 * May this member be handed a URL for this ticket-file key? `null` = yes (or
 * the key is not a ticket file, or a document decides it); otherwise the
 * refusal to send. `keyOrg` is the workspace the key was attributed to (its
 * orgs/<org>/ prefix); the caller has already checked an active membership
 * there.
 */
export async function ticketKeyGate(
  keyOrg: string,
  path: string,
  user: { id: string },
): Promise<NextResponse | null> {
  if (!isTicketFileKey(path)) return null;
  const refuse = (error: string, status: number) => NextResponse.json({ error }, { status });
  try {
    const { data: member, error: memberErr } = await supabaseAdmin
      .from("org_members")
      .select("role, roles")
      .eq("org_id", keyOrg)
      .eq("uid", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (memberErr) return refuse(ACCESS_UNVERIFIED, 503);
    if (!member) return refuse("Not a member of this workspace", 403);
    // Everyone the database lets read the workspace's tickets keeps today's
    // access, with no further lookup.
    if (!isContractorOnly(member)) return null;

    // A key a revision names is the document gate's (DEC-43): it ran first.
    const docIds = await documentsNamingKey(path); // throws → 503 below
    if (docIds.length > 0) return null;

    // The member's own staged upload (before its ticket exists, or a
    // creation-time file whose re-key never ran).
    if (isStagedKeyOf(path, keyOrg, user.id)) return null;

    const { data, error } = await supabaseAdmin
      .from("tickets")
      .select("id, requester_id, assigned_drafter_id, assigned_engineer_id, watchers")
      .eq("org_id", keyOrg)
      .contains("attachments", JSON.stringify([{ url: path }]))
      .limit(25);
    if (error) return refuse(ACCESS_UNVERIFIED, 503);
    const tickets = (Array.isArray(data) ? data : data ? [data] : []) as TicketScopeRow[];
    let unknown = false;
    for (const t of tickets) {
      const scope = await ticketReadScope(supabaseAdmin, member, user.id, {
        id: t.id,
        requesterId: t.requester_id,
        assignedDrafterId: t.assigned_drafter_id,
        assignedEngineerId: t.assigned_engineer_id,
        watchers: t.watchers,
      });
      if (scope === "in") return null;
      if (scope === "unknown") unknown = true;
    }
    if (unknown) return refuse(ACCESS_UNVERIFIED, 503);
    return refuse(TICKET_FILE_REFUSED, 403);
  } catch {
    return refuse(ACCESS_UNVERIFIED, 503);
  }
}
