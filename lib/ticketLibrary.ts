// lib/ticketLibrary.ts
//
// drafting-flow Round G, DF-P4 LIBRARY — GAP-105 / DCW-1: the ticket gets a
// library, the prerequisite for every library-scoped rule (DF-P5's routing,
// DF-P6's roster).
//
// A ticket's library is `tickets.library_id` (20261208). It is the source
// document's own library (`documents.library_id` — the root of the one
// container chain, lib/containerChain.ts, DEC-36; nothing here walks
// folders), derived by /api/tickets/create; with no source document it is
// set — or corrected — by triage (`assign` / `request_eng_review` at
// PENDING_ASSIGNMENT, /api/tickets/workflow-action). It is NEVER required at
// intake (99-fix-sequencing Phase 2 item 1, "Do not make it required at
// intake"): a request with no library is filed, assigned and issued exactly
// as before, and a library-scoped rule simply has nothing to match on it.
//
// Pure helpers only — no I/O — so the routes, the picker and the tests read
// the same rules.

import { canDiscover, type Principal } from "@/lib/permissions";
import type { AccessControl, NodeVisibility } from "@/types/schema";

/** A PostgREST / Postgres error that says `tickets.library_id` is not there
 *  yet (20261208 not pasted): 42703 undefined column, PGRST204 column not in
 *  the schema cache — naming the column. The caller retries without it
 *  (today's path). */
export function missingLibraryColumn(err: { code?: unknown; message?: unknown } | null | undefined): boolean {
  if (!err) return false;
  const code = typeof err.code === "string" ? err.code : "";
  const msg = typeof err.message === "string" ? err.message : "";
  return (code === "42703" || code === "PGRST204") && /library_id/.test(msg);
}

/** EDGE-8 (DF-P4): a request the assignment queue was never told about.
 *  /api/tickets/create marks every request it files `created_notice_owed`
 *  and stamps `created_notice_at` once a queue recipient's bell has the
 *  notice; a request still waiting in PENDING_ASSIGNMENT with the mark and
 *  no stamp was never announced (the route answered `notified: false`). A
 *  request filed before the mark existed is never counted — it cannot be
 *  told apart from one that was announced. */
export function creationNoticeOwed(
  status: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (status !== "PENDING_ASSIGNMENT") return false;
  const m = metadata ?? {};
  return m.created_notice_owed === true && !m.created_notice_at;
}

/** One library as the picker reads it (the columns canDiscover decides on). */
export interface LibraryChoiceRow {
  id: string;
  name: string | null;
  visibility?: NodeVisibility | string | null;
  acl?: AccessControl | null;
  ownerUserId?: string | null;
}

/** The libraries triage may target: those the CALLER may discover
 *  (lib/permissions canDiscover — controllers, the library's owner, an ACL
 *  that lets them see it; a normal library is open to members). A library
 *  the caller cannot see is never offered. No principal (no role known —
 *  SESS-6) offers nothing. Sorted by name. */
export function offerableLibraries(rows: readonly LibraryChoiceRow[], principal: Principal | null): Array<{ id: string; name: string }> {
  if (!principal) return [];
  return rows
    .filter((l) => typeof l.id === "string" && l.id.length > 0)
    .filter((l) => canDiscover({
      principal,
      aclChain: [l.acl ?? undefined],
      visibility: ((l.visibility as NodeVisibility | null | undefined) ?? "normal") as NodeVisibility,
      effectiveOwnerUserId: l.ownerUserId ?? null,
    }))
    .map((l) => ({ id: l.id, name: (l.name ?? "").trim() || "Untitled library" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** What a ticket's history line and its close notice may call a library
 *  (DCW-1 / DCW-4, DF-P4 fix passes). Both are read by everyone who can read
 *  the ticket — the requester and the watchers included — so a library that
 *  is not open to every member is named "the target library", never by its
 *  name: a library the reader cannot discover must not be disclosed through
 *  a request about it. "Open to every member" is decided conservatively:
 *  the library is normal (or its visibility unknown, read as normal, as
 *  canDiscover does) AND its ACL carries no rule at all and no restricted
 *  visibility of its own. A normal library with ANY ACL rule — a deny that
 *  hides it from a role or a team (canDiscover → isDiscoverable), or an
 *  allow list — is not named, since the ticket's readers are not known here.
 *  An ACL that cannot be read as one (not an object, `rules` not a list) is
 *  treated as restrictive. */
export const UNNAMED_TARGET_LIBRARY = "the target library";
export function libraryLabelForTicket(row: { name?: string | null; visibility?: string | null; acl?: unknown } | null | undefined): string {
  if (!row) return UNNAMED_TARGET_LIBRARY;
  const visibility = (row.visibility ?? "normal") as string;
  if (visibility === "hidden" || visibility === "private") return UNNAMED_TARGET_LIBRARY;
  if (!aclOpenToEveryMember(row.acl)) return UNNAMED_TARGET_LIBRARY;
  return (row.name ?? "").trim() || UNNAMED_TARGET_LIBRARY;
}

/** No ACL, or an ACL with no rule and no restricted visibility of its own. */
function aclOpenToEveryMember(acl: unknown): boolean {
  if (acl === null || acl === undefined) return true;
  if (typeof acl !== "object" || Array.isArray(acl)) return false;
  const a = acl as { rules?: unknown; visibility?: unknown };
  if (a.visibility === "hidden" || a.visibility === "private") return false;
  if (a.rules === undefined || a.rules === null) return true;
  return Array.isArray(a.rules) && a.rules.length === 0;
}

/** DCW-5 (DF-P4): the request form's "link a document by number" search.
 *  The text a requester types, made safe for a PostgREST `or=(…)` filter
 *  (its separators and wildcards removed), or null when too short to
 *  search. The rows come back through the requester's OWN session, so the
 *  database's discover decision applies (documents_acl_select →
 *  node_visible: a document is returned when the requester may at least
 *  discover it — any allow grant, ownership, or a normal library) — and the
 *  search selects only the number, the title and the revision: never a file. */
export function linkableDocumentQuery(raw: string | null | undefined): string | null {
  const q = String(raw ?? "").replace(/[,()%*\\"']/g, " ").replace(/\s+/g, " ").trim();
  return q.length >= 2 ? q.slice(0, 60) : null;
}

/** The PostgREST `or` filter for {@link linkableDocumentQuery}'s text. */
export function linkableDocumentFilter(q: string): string {
  return `document_number.ilike.%${q}%,title.ilike.%${q}%`;
}
