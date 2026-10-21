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
