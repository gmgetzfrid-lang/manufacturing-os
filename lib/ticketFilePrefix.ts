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
//     line says, and that is the restore's own: stamped actor_kind 'server'
//     by the database (admin-and-org 20261201 — only the service role or a
//     definer function writes one, and no definer function writes a
//     RESTORE_CHUNK row), or — on a row with no such stamp (written before
//     that paste, or the column absent) — written by a member who may run a
//     restore NOW (the restore surface's entry, lib/adminSurfaces.ts —
//     Admin, active). A row stamped 'member' (a member's own insert) never
//     confirms. A member can insert an audit row only in their own name
//     (audit_logs_insert), so an unstamped row written by someone outside
//     the restore surface is not the restore's. The page's mirror (ticketFileCopyPath) reads the
//     history line only — it picks a path; the server decides, and a refusal
//     takes the browser path.
//
// A request never renumbered carries no such line: every caller tests ITS
// OWN files against its own number's folder exactly as before, and none
// reads the audit trail for it. It is not read-free, though: the workflow
// route's check below runs on every request (see the next paragraph).
//
// The other side of the shared folder (EDGE-19 done-when 3): the request
// that KEEPS the old number must not attach, as its own, a key another
// request of the workspace lists (the renumbered request's files sit in its
// folder) — the workflow route asks renumberedRequestListsKey before
// admitting an UNLISTED key under its own folder. The holder carries no
// marker of its own, so this is one tickets read per unlisted attachment on
// EVERY request (renumbered or not; filtered on
// metadata->restore_renumbered->>from, no index). It refuses only when it
// SUCCEEDS and finds a renumbered request listing the key; when it fails (or
// reads more renumbered requests than it reads), the upload gets today's
// answer (the storage HEAD, exactly as before DF-P17) and the action's audit
// row records `renumberedSiblingUnchecked: true` — a never-renumbered
// request's upload never fails or differs because of it (DEC-90, the
// integrator's ruling at the DF-P17 final fix pass).

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
  contains(c: string, v: unknown): Q; is(c: string, v: null): Q;
  order(c: string, o: { ascending: boolean }): Q; limit(n: number): Q;
} & PromiseLike<Answer<Array<Record<string, unknown>>>>;

/** How many RESTORE_CHUNK rows naming the request are read per kind (a
 *  re-run of the same restore names it again; a handful is plenty — a full
 *  page of unstamped rows with no confirming writer is not confirmed). */
const AUDIT_ROWS_READ = 20;

/** The audit row's columns this check reads; ACTOR_KIND only where
 *  admin-and-org 20261201 is pasted. */
const AUDIT_COLS = "user_id, details";
const AUDIT_COLS_WITH_KIND = "user_id, details, actor_kind";

/** The column is not there yet (20261201 unpasted): Postgres 42703 on a
 *  select, PostgREST PGRST204 / a schema-cache miss naming it. */
function actorKindMissing(err: { code?: string; message?: string }): boolean {
  return err.code === "42703" || err.code === "PGRST204" || /actor_kind/.test(err.message ?? "");
}

/**
 * SERVER: whether the restore's audit trail confirms that request row
 * `ticketRowId` of `orgId` was restored as `to` in place of `from` — a
 * RESTORE_CHUNK audit row of the workspace whose `cleared` notes carry the
 * TICKET_RENUMBERED note for that row with exactly that pair (the pair is in
 * the containment filter, so a row naming another pair is never read), and
 * that is the restore's own:
 *
 *   1. rows stamped actor_kind 'server' are read FIRST (20261201: only the
 *      service role or a definer function writes one, and no definer
 *      function writes a RESTORE_CHUNK row) — one confirms by itself,
 *      whatever became of the restoring Admin;
 *   2. then UNSTAMPED rows (actor_kind null: written before that paste) —
 *      one confirms only when its writer is a member the restore surface
 *      admits who is active NOW (Admin; lib/adminSurfaces.ts);
 *   3. a row stamped 'member' (a member's own insert) never confirms, and is
 *      never read.
 *
 * Each read is ordered oldest first ("timestamp", then id) and capped at
 * AUDIT_ROWS_READ. A full page of unstamped rows with no confirming writer
 * is NOT confirmed (fail-safe: forged rows could fill the page; the answer
 * is then today's — "truncated", said on drafting-flow EDGE-19). Where the
 * column is absent (42703 / PGRST204 — 20261201 not pasted) the reads fall
 * back to today's single read with no actor_kind filter, every row taking
 * the active-Admin check. "unknown" when a read fails (the caller answers
 * 503, never admits). Reads nothing for a request the caller has no history
 * line for — call it only after restoredFromNumber.
 */
export async function restoreRenumberingConfirmed(
  client: PrefixClient,
  input: { orgId: string; ticketRowId: string; from: string; to: string },
): Promise<boolean | "unknown"> {
  const surface = adminSurface("restore");
  if (!surface || !input.orgId || !input.ticketRowId || !input.from || !input.to) return false;
  const read = (cols: string, kind: "server" | "unstamped" | "any") => {
    let q = (client.from("audit_logs") as Q)
      .select(cols)
      .eq("org_id", input.orgId)
      .eq("action", "RESTORE_CHUNK")
      // jsonb containment, sent as JSON text (the codebase's convention for a
      // jsonb filter: app/api/tickets/create/route.ts, lib/ticketKeyGate.ts).
      .contains("details", JSON.stringify({
        table: "tickets",
        cleared: [{ code: RESTORE_RENUMBERED_NOTE_CODE, id: input.ticketRowId, renumbered: { from: input.from, to: input.to } }],
      }));
    if (kind === "server") q = q.eq("actor_kind", "server");
    else if (kind === "unstamped") q = q.is("actor_kind", null);
    return q.order("timestamp", { ascending: true }).order("id", { ascending: true }).limit(AUDIT_ROWS_READ);
  };
  const names = (row: Record<string, unknown>): boolean => {
    const details = row.details as { table?: unknown; cleared?: unknown } | null;
    if (!details || details.table !== "tickets" || !Array.isArray(details.cleared)) return false;
    return details.cleared.some((n) => {
      const note = n as { code?: unknown; id?: unknown; renumbered?: { from?: unknown; to?: unknown } } | null;
      return !!note && note.code === RESTORE_RENUMBERED_NOTE_CODE && note.id === input.ticketRowId
        && note.renumbered?.from === input.from && note.renumbered?.to === input.to;
    });
  };
  // 1. The database's stamp: the service role wrote it.
  const server = await read(AUDIT_COLS_WITH_KIND, "server");
  let unstamped: Answer<Array<Record<string, unknown>>>;
  if (server.error) {
    if (!actorKindMissing(server.error)) return "unknown";
    // Before 20261201 the column is absent: today's single read, every row
    // unstamped.
    unstamped = await read(AUDIT_COLS, "any");
  } else {
    for (const row of Array.isArray(server.data) ? server.data : []) {
      if (row.actor_kind === "server" && names(row)) return true;
    }
    // 2. Rows written before that paste.
    unstamped = await read(AUDIT_COLS_WITH_KIND, "unstamped");
  }
  if (unstamped.error) return "unknown";
  const writers = new Set<string>();
  for (const row of Array.isArray(unstamped.data) ? unstamped.data : []) {
    // 3. A member's own insert never confirms (and the filter above never
    // returns one; this guards a database that answers otherwise).
    if (row.actor_kind !== null && row.actor_kind !== undefined) continue;
    if (!names(row)) continue;
    if (typeof row.user_id === "string" && row.user_id) writers.add(row.user_id);
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
 * the number than are read — the caller then gives today's answer and
 * records that the check did not run (never a refusal, never a 503).
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
