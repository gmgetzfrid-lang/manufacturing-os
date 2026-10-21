// lib/ticketFilePrefix.ts
//
// drafting-flow EDGE-19 (DF-P17 RENUMBERED REQUEST FILES, ruled under DEC-90):
// the one request-prefix test — "is this storage key one of THIS request's
// files?" — shared by every caller that asks it per request number
// (lib/ticketCopyRequest.ts ticketFileCopyPath, the page's mirror;
// app/api/tickets/copy/route.ts; app/api/tickets/workflow-action/route.ts
// vetTicketAttachment). The shed (lib/ticketShed.ts isShedTicketKey) and the
// copy recall (lib/staleCopies) never test a request's number folder, so they
// need nothing here.
//
// A request's files are stored under orgs/<org>/tickets/<its number>/
// (lib/ticketCreate.ts ticketAttachmentKey). A request the restore brought
// back under a FRESH number (admin-and-org P16, drafting-flow EDGE-5 ruling
// (3)) keeps its files where the backup had them — under the ORIGINAL
// number's folder; storage objects are never moved or copied (DEC-90 ruling
// (1) for EDGE-19). So, for such a request only, the test also admits that
// one folder — and nothing else:
//
//   * the original number is read from the restore's OWN history line on the
//     request (lib/dataRestore.ts renumberedTicketRow: action
//     RESTORE_RENUMBERED_HISTORY_ACTION, user "restore", details `Issued as
//     "<from>"; … so this request was restored as "<to>".`) whose `to` is the
//     request's CURRENT number — never client input;
//   * a key under that folder is admitted only when the request already
//     LISTS it (a new upload is minted under the current number's folder; the
//     folder is still the request keeping the old number's, so admitting an
//     unlisted key there would hand this request that one's files);
//   * on the SERVER the history line alone is not proof: tickets.history is
//     member-writable wherever ticket_update_guard (20261166 / 20261221 /
//     20261250, all HOLD on the paste order) is not pasted — any member can
//     append a line naming user "restore" there. So the server binds the
//     number to the restore's AUDIT row instead (restoreRenumberingConfirmed):
//     a RESTORE_CHUNK row of this workspace whose `cleared` notes carry the
//     TICKET_RENUMBERED note for this request row, from → to as the history
//     line says, written by a member who may run a restore (the restore
//     surface's entry, lib/adminSurfaces.ts — Admin). A member can insert an
//     audit row only in their own name (audit_logs_insert), so a row written
//     by someone outside the restore surface is not the restore's. The page's
//     mirror (ticketFileCopyPath) reads the history line only — it picks a
//     path; the server decides, and a refusal takes the browser path.
//
// A request never renumbered carries no such line: every caller tests it
// exactly as before (its own number's folder), with no extra read.
//
// The other side of the shared folder (EDGE-19 done-when 3): the request
// that KEEPS the old number must not attach, as its own, a key another
// request of the workspace lists (the renumbered request's files sit in its
// folder) — the workflow route asks renumberedRequestListsKey before
// admitting an unlisted key under its own folder.

import { RESTORE_RENUMBERED_HISTORY_ACTION } from "@/lib/ticketAttention";
import { adminSurface, adminSurfaceAllows } from "@/lib/adminSurfaces";
import { heldRoles } from "@/lib/roleHeld";

/** The note code the restore gives a renumbering in its `cleared` notes and
 *  the RESTORE_CHUNK audit row — lib/dataRestore.ts TICKET_RENUMBERED (kept
 *  here as a literal so the page's mirror does not import the restore engine;
 *  a test pins the two equal). */
export const RESTORE_RENUMBERED_NOTE_CODE = "ticket_renumbered";

/** The `user` the restore's history line names (lib/dataRestore.ts
 *  renumberedTicketRow). */
export const RESTORE_HISTORY_USER = "restore";

/** The storage folder of request number `number` in workspace `orgId`. */
export function ticketFolder(orgId: string, number: string): string {
  return `orgs/${orgId}/tickets/${number}/`;
}

/** True when `key` names an object INSIDE `folder` (never the folder itself). */
export function underFolder(key: string, folder: string): boolean {
  return key.startsWith(folder) && key.length > folder.length;
}

/** A request number as a folder segment: non-empty, no slash, no quote, no
 *  traversal, no control byte. */
function plainNumber(n: string): boolean {
  if (!n || n.length > 120 || n === "." || n === "..") return false;
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f || n[i] === "/" || n[i] === "\\" || n[i] === '"') return false;
  }
  return true;
}

const RESTORE_LINE_RE = /^Issued as "([^"]+)"; [\s\S]*, so this request was restored as "([^"]+)"\./;

/**
 * The number this request was issued before the restore renumbered it — read
 * from the restore's own history line whose "restored as" number is the
 * request's CURRENT number (the newest such line) — or null: no such line (a
 * request never renumbered), a line naming another number, or a number that
 * is not a plain folder segment. Pure.
 */
export function restoredFromNumber(ticket: { ticketNumber: string | null | undefined; history: unknown }): string | null {
  const current = typeof ticket.ticketNumber === "string" ? ticket.ticketNumber : "";
  if (!current) return null;
  const history = Array.isArray(ticket.history) ? ticket.history : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i] as { action?: unknown; user?: unknown; details?: unknown } | null | undefined;
    if (!h || typeof h !== "object" || h.action !== RESTORE_RENUMBERED_HISTORY_ACTION || h.user !== RESTORE_HISTORY_USER) continue;
    if (typeof h.details !== "string") continue;
    const m = RESTORE_LINE_RE.exec(h.details);
    if (!m || m[2] !== current) continue;
    const from = m[1];
    return plainNumber(from) && from !== current ? from : null;
  }
  return null;
}

/** The original number's folder of a renumbered request (see
 *  restoredFromNumber), or null. Pure. */
export function restoredFromFolder(ticket: { orgId: string | null | undefined; ticketNumber: string | null | undefined; history: unknown }): string | null {
  const org = typeof ticket.orgId === "string" ? ticket.orgId : "";
  const from = org ? restoredFromNumber(ticket) : null;
  return from ? ticketFolder(org, from) : null;
}

/** Minimal client shape the two server reads below use (supabaseAdmin). */
export interface PrefixClient {
  from(table: string): unknown;
}
type Answer<T> = { data: T | null; error: { code?: string; message?: string } | null };
type Q = {
  select(cols: string): Q; eq(c: string, v: unknown): Q; in(c: string, v: unknown[]): Q;
  contains(c: string, v: unknown): Q; limit(n: number): Q;
} & PromiseLike<Answer<Array<Record<string, unknown>>>>;

/** How many RESTORE_CHUNK rows naming the request are read (a re-run of the
 *  same restore names it again; a handful is plenty). */
const AUDIT_ROWS_READ = 20;

/**
 * SERVER: whether the restore's audit trail confirms that request row
 * `ticketRowId` of `orgId` was restored as `to` in place of `from` — a
 * RESTORE_CHUNK audit row of the workspace whose `cleared` notes carry the
 * TICKET_RENUMBERED note for that row with exactly that pair, written by an
 * active member the restore surface admits (Admin). "unknown" when a read
 * fails (the caller answers 503, never admits). Reads nothing for a request
 * the caller has no history line for — call it only after restoredFromNumber.
 */
export async function restoreRenumberingConfirmed(
  client: PrefixClient,
  input: { orgId: string; ticketRowId: string; from: string; to: string },
): Promise<boolean | "unknown"> {
  const surface = adminSurface("restore");
  if (!surface || !input.orgId || !input.ticketRowId || !input.from || !input.to) return false;
  const audit = await (client.from("audit_logs") as Q)
    .select("user_id, details")
    .eq("org_id", input.orgId)
    .eq("action", "RESTORE_CHUNK")
    // jsonb containment, sent as JSON text (the codebase's convention for a
    // jsonb filter: app/api/tickets/create/route.ts, lib/ticketKeyGate.ts).
    .contains("details", JSON.stringify({ table: "tickets", cleared: [{ code: RESTORE_RENUMBERED_NOTE_CODE, id: input.ticketRowId }] }))
    .limit(AUDIT_ROWS_READ);
  if (audit.error) return "unknown";
  const writers = new Set<string>();
  for (const row of Array.isArray(audit.data) ? audit.data : []) {
    const details = row.details as { table?: unknown; cleared?: unknown } | null;
    if (!details || details.table !== "tickets" || !Array.isArray(details.cleared)) continue;
    const names = details.cleared.some((n) => {
      const note = n as { code?: unknown; id?: unknown; renumbered?: { from?: unknown; to?: unknown } } | null;
      return !!note && note.code === RESTORE_RENUMBERED_NOTE_CODE && note.id === input.ticketRowId
        && note.renumbered?.from === input.from && note.renumbered?.to === input.to;
    });
    if (names && typeof row.user_id === "string" && row.user_id) writers.add(row.user_id);
  }
  if (writers.size === 0) return false;
  const members = await (client.from("org_members") as Q)
    .select("uid, role, roles, status")
    .eq("org_id", input.orgId)
    .eq("status", "active")
    .in("uid", [...writers]);
  if (members.error) return "unknown";
  return (Array.isArray(members.data) ? members.data : []).some((m) => typeof m.uid === "string" && writers.has(m.uid)
    && adminSurfaceAllows(surface, heldRoles(m), null, m.uid));
}

/** How many renumbered requests naming one original number are read (each
 *  restore that renumbers a carrier of the number adds one). */
const SIBLINGS_READ = 50;

/**
 * SERVER (EDGE-19 done-when 3): whether a request of `orgId` that the restore
 * renumbered AWAY from `number` (metadata.restore_renumbered.from — the
 * restore writes it as the service role beside the history line) lists the
 * storage key `key`. The request that keeps `number` must not take such a
 * key — it sits in its folder, but it is the renumbered request's file — as
 * its own. A refusal is the safe direction, so the stored marker alone
 * decides it. "unknown" when the read fails or more renumbered requests name
 * the number than are read.
 */
export async function renumberedRequestListsKey(
  client: PrefixClient,
  input: { orgId: string; number: string; key: string },
): Promise<boolean | "unknown"> {
  const res = await (client.from("tickets") as Q)
    .select("id, attachments")
    .eq("org_id", input.orgId)
    .eq("metadata->restore_renumbered->>from", input.number)
    .limit(SIBLINGS_READ + 1);
  if (res.error) return "unknown";
  const rows = Array.isArray(res.data) ? res.data : [];
  const lists = rows.some((r) => Array.isArray(r.attachments)
    && (r.attachments as Array<{ url?: unknown } | null>).some((a) => !!a && a.url === input.key));
  if (lists) return true;
  return rows.length > SIBLINGS_READ ? "unknown" : false;
}
