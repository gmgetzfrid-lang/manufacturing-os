// lib/ticketEquipment.ts
//
// drafting-flow Round G, DF-P18 — intelligence GAP-312 (equipment after
// filing). The pure rules behind POST /api/tickets/equipment, shared with the
// request page's "Add equipment" control on components/requests/DeclarationCard.tsx
// so the control shows exactly where the route will take the write.
//
// DEC-90 ruling (4) for DF-P18: the request's participants (its requester, its
// assigned drafter, its assigned engineer) and the assignment queue (the
// holders of `ticket.assign` for the request's resource) — nobody else; the
// workspace is checked on the server; the write is checked; an audit row is
// written first. Before 20261251 is pasted the table is not there: the control
// says the list is not available and the route answers 503 `not_migrated`.

import { isMissingSchemaError } from "@/lib/checkedWrite";

/** The tag's length bound — ticket_equipment.tag's CHECK (20261251). */
export const EQUIPMENT_TAG_MAX = 80;

/** A tag as the route stores it: trimmed, whitespace collapsed; null when
 *  empty or longer than the column's CHECK allows. */
export function cleanEquipmentTag(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const tag = raw.replace(/\s+/g, " ").trim();
  if (tag.length < 1 || tag.length > EQUIPMENT_TAG_MAX) return null;
  return tag;
}

/** Is this person one of the request's participants? */
export function isTicketParticipant(
  ticket: { requesterId?: string | null; assignedDrafterId?: string | null; assignedEngineerId?: string | null },
  uid: string | null | undefined,
): boolean {
  if (!uid) return false;
  return ticket.requesterId === uid || ticket.assignedDrafterId === uid || ticket.assignedEngineerId === uid;
}

/** The statuses whose equipment is no longer edited (the record is closed). */
export const EQUIPMENT_CLOSED_STATUSES: ReadonlySet<string> = new Set(["CLOSED", "CANCELED"]);

/** May this person add or correct the request's equipment? (pure) */
export function equipmentEditAllowed(input: { participant: boolean; queue: boolean; status: string | null | undefined; archived: boolean }): boolean {
  if (input.archived || EQUIPMENT_CLOSED_STATUSES.has(String(input.status ?? ""))) return false;
  return input.participant || input.queue;
}

/** A read or write that met the table before 20261251 is pasted. */
export function isMissingEquipmentTable(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code ?? "");
  if (code === "42P01" || code === "PGRST205") return true;
  return isMissingSchemaError({ code: err.code ?? null, message: String(err.message ?? "") }) && /ticket_equipment/.test(String(err.message ?? ""));
}

/** What the answer says about a tag the route recorded. */
export function equipmentOutcomeLine(tag: string, asset: "linked" | "not_found" | "lookup_failed"): string {
  if (asset === "linked") return `${tag} is linked to the equipment registry.`;
  if (asset === "lookup_failed") return `${tag} could not be checked against the equipment registry (the lookup failed) — kept as typed.`;
  return `${tag} was not found in the equipment registry — kept as typed.`;
}

/** The control's sentence before 20261251 is pasted (GAP-312, ruling (4)). */
export const EQUIPMENT_NOT_AVAILABLE = "The equipment list is not available yet (database update 20261251 is not applied) — equipment cannot be added here until it is.";

/** The characters a listing key drops: ASCII other than [a-z0-9] (exactly
 *  what lib/codebook.ts tagKey drops from an ASCII tag), and the Unicode
 *  spaces and dashes a pasted tag carries ("E–22" from a word processor is
 *  "E-22"). Every other character — a Cyrillic, Greek or CJK letter — is
 *  KEPT, so "Насос-1" and "Компрессор-1" stay two tags (tagKey alone keeps
 *  only "1" of each). 20261265's ticket_equipment_tag_key strips this same
 *  set, code point for code point (pinned by the PG16 test). */
const LISTING_KEY_STRIP = /[^\u0080-\uffffa-z0-9]|[\u00a0\u00ad\u2000-\u200b\u2010-\u2015\u2212\u202f\u3000\ufeff]/g;

/** drafting-flow DF-P23 fix pass (intelligence GAP-312 follow-up): the key a
 *  request's equipment list compares tags by — the route's check
 *  (equipmentTagListed), its respelling rule, the create-time dedupe and
 *  20261265's unique index (ticket_equipment_tag_key) all use it. For an
 *  ASCII tag it IS tagKey ("P-101", "p 101" and "P101" are one tag); a tag
 *  with nothing left falls back to the trimmed lowercase tag. Lowercasing is
 *  made context-free so the database's per-character lower() is never
 *  stricter than this: a dotted capital I (U+0130) is "i" before it, and a
 *  final sigma is the sigma after it ("ΟΔΟΣ", "οδος" and "οδοσ" are one
 *  tag). (pure) */
export function equipmentListingKey(raw: string): string {
  const s = String(raw ?? "");
  const k = s.replace(/\u0130/g, "i").toLowerCase().replace(/\u03c2/g, "\u03c3").replace(LISTING_KEY_STRIP, "");
  return k || s.trim().toLowerCase();
}

/** DF-P18 fix pass (review, minor): is this tag already listed on the
 *  request? Compared through the registry's one tag grammar (tagKey — "P-101"
 *  and "p 101" are the same tag), skipping the row a correction replaces.
 *  DF-P23 fix pass: by equipmentListingKey — tagKey on an ASCII tag, and a
 *  non-Latin tag's letters are kept rather than dropped.
 *  ticket_equipment has no uniqueness constraint, so the route asks this
 *  before it writes anything (a sequential double click or retry lists
 *  nothing twice; two requests racing past the read can — a check, not a
 *  constraint, DF-P18 fix pass 2).
 *  (pure) */
export function equipmentTagListed<R extends { id?: string | null; tag: string }>(
  rows: readonly R[],
  tag: string,
  exceptRowId?: string | null,
): R | null {
  const key = equipmentListingKey(tag);
  return rows.find((r) => (exceptRowId == null || r.id !== exceptRowId) && equipmentListingKey(String(r.tag ?? "")) === key) ?? null;
}
