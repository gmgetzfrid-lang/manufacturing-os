// lib/ticketPage.ts
//
// drafting-flow Round G, DF-P9 TICKET-PAGE — the request page's decisions,
// pure, so they are tested where they are made (the page imports them; no
// I/O here):
//
//   * EDGE-6 / ROUTE-8 — who the drafter picker offers: every active member
//     whose role COLLECTION the org's policy lets do drafting work
//     (`ticket.draft_work`, on this ticket's resource) — the workflow route's
//     own test for an `assignment` pick (WF-14), so the picker never offers a
//     drafter the server refuses and never hides one it accepts. It used to
//     filter `.eq('role', 'Drafter')` — the headline only — so a member who
//     holds Drafter beside a higher-ranked role was invisible and a small
//     org could reach a request nobody could be assigned to.
//   * SM-13 (client half) — the file an action needs, by TYPE: Submit Draft
//     needs a Draft on the ticket; Issue Final needs the Final the IFC upload
//     supplies. (The check used to accept any attachment at all.)
//   * DCW-1 / DCW-7 — what the assign modal sends for triage: the library
//     (the ticket's own sent back is no change at the route) and a unit only
//     when it differs from the ticket's.
//   * PROJ-9 — the request's write-only metadata, rendered: custom category
//     answers with their configured labels, and the project a request is
//     linked to.

import type { Ticket, TicketAttachment, CustomCategoryConfig } from "@/types/schema";
import { policyAllows, type CapabilityPolicy, type CapabilityResource } from "@/lib/capabilityPolicy";
import type { WorkflowAction } from "@/lib/workflow";

// ── EDGE-6 / ROUTE-8 ─────────────────────────────────────────────────────────

export interface MemberPickRow {
  uid?: unknown;
  email?: unknown;
  role?: unknown;
  roles?: unknown;
  display_name?: unknown;
}

export interface DrafterCandidate {
  uid: string;
  name: string;
  email: string;
  /** The member's roles, for the row's subtitle. */
  roles: string[];
}

/** The role collection the workflow route tests for a picked member: the
 *  additive collection when it has one, else the headline
 *  (app/api/tickets/workflow-action/route.ts, the reference check). Admin →
 *  Users writes both (the headline is the collection's highest rank), so this
 *  is the same set lib/roleHeld.ts heldRoles reads for every consistent row. */
export function pickRoles(m: MemberPickRow): string[] {
  if (Array.isArray(m.roles) && m.roles.length > 0) {
    return (m.roles as unknown[]).filter((r): r is string => typeof r === "string" && r.trim() !== "");
  }
  return typeof m.role === "string" && m.role.trim() ? [m.role.trim()] : [];
}

/** The members the drafter picker offers: active members (the caller reads
 *  `status = active`) whose collection the policy lets do drafting work on
 *  this ticket. Sorted by name. */
export function drafterCandidates(
  members: readonly MemberPickRow[],
  policy: CapabilityPolicy | null | undefined,
  resource: CapabilityResource | null | undefined,
): DrafterCandidate[] {
  const out: DrafterCandidate[] = [];
  for (const m of members) {
    if (typeof m.uid !== "string" || !m.uid) continue;
    const held = pickRoles(m);
    if (held.length === 0) continue;
    if (!policyAllows(policy, "ticket.draft_work", held[0], held, m.uid, resource ?? null)) continue;
    const email = typeof m.email === "string" ? m.email : "";
    const display = typeof m.display_name === "string" ? m.display_name.trim() : "";
    out.push({ uid: m.uid, email, name: display || email.split("@")[0] || "Unnamed member", roles: held });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The picker's empty state, naming the real reason (EDGE-6 done-when 3). */
export const NO_DRAFTER_CANDIDATES =
  "No active member can be assigned drafting work: nobody in this workspace holds the Drafter role (or the drafting capability the workspace's permissions give it). An Admin can add the Drafter role to someone in Admin → Users — beside any role they already hold.";

// ── SM-13 (client half) ──────────────────────────────────────────────────────

/** The attachment TYPE an action needs, or null when it needs none. */
export function requiredFileType(action: Pick<WorkflowAction, "action" | "requiresFile">): "Draft" | "Final" | null {
  if (!action.requiresFile) return null;
  if (action.action === "submit_draft") return "Draft";
  if (action.action === "submit_final") return "Final";
  return null;
}

/** Why the action cannot go yet for want of its file, or null. Submit Draft
 *  needs a Draft on the ticket; Issue Final needs the file the IFC upload
 *  supplies, typed Final (the route refuses any other type — AUTHZ-11). */
export function missingRequiredFile(
  action: Pick<WorkflowAction, "action" | "requiresFile">,
  attachments: readonly Pick<TicketAttachment, "type">[] | null | undefined,
  finalFile?: Pick<TicketAttachment, "type"> | null,
): string | null {
  const need = requiredFileType(action);
  if (need === "Draft") {
    return (attachments ?? []).some((a) => a.type === "Draft")
      ? null
      : "Upload the draft drawing first (Add New File → Draft Drawing) — there is no Draft on this request to submit.";
  }
  if (need === "Final") {
    if (finalFile === undefined) return null; // the IFC upload modal supplies it next
    return finalFile?.type === "Final" ? null : "Issuing the final IFC package needs the stamped PDF uploaded as the Final file.";
  }
  return null;
}

// ── DCW-1 / DCW-7 ────────────────────────────────────────────────────────────

/** The triage fields the assign action carries (the route validates both and
 *  neither is ever required): the library when one is chosen (the ticket's
 *  current library sent back is no change at the route), and the unit only
 *  when it differs from the ticket's (an unchanged unit would write a history
 *  line saying nothing). Empty → nothing sent. */
export function triagePayload(
  ticket: Pick<Ticket, "unit" | "libraryId" | "metadata">,
  chosen: { libraryId?: string | null; unit?: string | null },
): { libraryId?: string; unit?: string } {
  const out: { libraryId?: string; unit?: string } = {};
  const lib = typeof chosen.libraryId === "string" ? chosen.libraryId.trim() : "";
  if (lib) out.libraryId = lib;
  const unit = typeof chosen.unit === "string" ? chosen.unit.trim() : "";
  const meta = (ticket.metadata ?? {}) as Record<string, unknown>;
  const marked = meta.unit_unknown === true || meta.unit_unlisted === true || meta.unit_unchecked != null;
  if (unit && (unit !== (ticket.unit ?? "") || marked)) out.unit = unit;
  return out;
}

// ── PROJ-9 ───────────────────────────────────────────────────────────────────

export interface CustomCategorySection {
  id: string;
  label: string;
  fields: Array<{ key: string; label: string; value: string }>;
}

const humanize = (k: string): string => {
  const t = k.replace(/[_-]+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : k;
};

function valueText(v: unknown, options?: ReadonlyArray<{ value?: unknown; label?: unknown }>): string {
  const labelOf = (x: unknown): string => {
    const hit = options?.find((o) => String(o.value) === String(x));
    return hit && typeof hit.label === "string" && hit.label ? hit.label : String(x);
  };
  if (v === null || v === undefined || v === "") return "";
  if (Array.isArray(v)) return v.map(labelOf).filter(Boolean).join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") return JSON.stringify(v);
  return labelOf(v);
}

/** metadata.custom_categories[categoryId][fieldKey] as labelled sections —
 *  the configured labels when the workspace's request form still has the
 *  category / field, else the stored keys in words (an answer is never
 *  hidden because its question was renamed or removed). Empty answers are
 *  left out; a section with none is left out. */
export function customCategorySections(
  metadata: Record<string, unknown> | null | undefined,
  config: readonly CustomCategoryConfig[] | null | undefined,
): CustomCategorySection[] {
  const raw = metadata?.custom_categories;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: CustomCategorySection[] = [];
  for (const [catId, answers] of Object.entries(raw as Record<string, unknown>)) {
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) continue;
    const cat = (config ?? []).find((c) => c.id === catId);
    const fields: CustomCategorySection["fields"] = [];
    for (const [key, v] of Object.entries(answers as Record<string, unknown>)) {
      const def = cat?.fields?.find((f) => f.key === key);
      const value = valueText(v, def?.options as ReadonlyArray<{ value?: unknown; label?: unknown }> | undefined);
      if (!value) continue;
      fields.push({ key, label: def?.label || humanize(key), value });
    }
    if (fields.length > 0) out.push({ id: catId, label: cat?.label || "Request details", fields });
  }
  return out;
}

/** The project a request is linked to: an intake collision names it
 *  (metadata.intake_collision.projectId — the only project reference a
 *  ticket carries until DF-P8 writes `tickets.project_id`). */
export function projectRefOf(metadata: Record<string, unknown> | null | undefined): string | null {
  const ic = metadata?.intake_collision;
  if (!ic || typeof ic !== "object" || Array.isArray(ic)) return null;
  const pid = (ic as { projectId?: unknown }).projectId;
  return typeof pid === "string" && pid.trim() ? pid.trim() : null;
}
