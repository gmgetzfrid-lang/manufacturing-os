// lib/intakeLinks.ts
//
// The contractor intake link as a bounded credential (projects Round G, J1 —
// projects-tab SEC-5 / SEC-8 / SEC-16, projects-and-cost INTK-8 / INTK-11 /
// PM-2 / INTK-12). One module both public routes, the Intake tab and the
// project model share, so the rules cannot drift between the door and the
// screens that mint it:
//
//   * where the token travels (a header or the query string — NEVER the
//     multipart body, which the server would have to buffer before it knew
//     whether the caller holds a link at all);
//   * how long a link may live (14 days by default, 90 at most — the
//     database CHECK in 20261104 is the backstop);
//   * which project states close the door;
//   * the text limits a submission is held to;
//   * `revokeProjectIntakeLinks` — THE revoke helper. The project model
//     (lib/projects.ts, projects Round G J8) calls it when a project is
//     closed or deleted; 20261104's trg_projects_close_intake_links (a
//     trigger, not a foreign key — an FK would break org restore) is the
//     database's own answer for a delete that bypasses the app.
//
// Client-safe: no service-role import. The server passes its own client.

import { supabase } from "@/lib/supabase";
import { computeUniquenessKey, type DocFieldsForUniqueness } from "@/lib/uniqueness";

/** The token format both public routes accept. */
export const INTAKE_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** Header the portal sends the token in (the query string works too). */
export const INTAKE_TOKEN_HEADER = "x-intake-token";

/** The token a request carries — header first, then `?token=`. Never read
 *  from the body (INTK-8: the credential is checked before the body is). */
export function intakeTokenFromRequest(req: { headers: Headers; url: string }): string {
  const fromHeader = req.headers.get(INTAKE_TOKEN_HEADER);
  if (fromHeader && fromHeader.trim()) return fromHeader.trim();
  try {
    return (new URL(req.url).searchParams.get("token") ?? "").trim();
  } catch {
    return "";
  }
}

/** Link lifetime (SEC-5 / INTK-12): default and ceiling, in days. The DB
 *  CHECK (20261104) allows 92: an end-of-day LOCAL expiry picked from a
 *  UTC date (the Costs tab's default) lands up to ~91.5 days out west of
 *  UTC in the evening, and must not be refused. */
export const INTAKE_LINK_DEFAULT_DAYS = 14;
export const INTAKE_LINK_MAX_DAYS = 90;

/** Project states in which a link no longer accepts anything (PM-1's route
 *  limb): the work is over, so the external door is too. `paused` is not
 *  closed — a paused project still takes its contractors' drawings. */
export const CLOSED_PROJECT_STATUSES: ReadonlySet<string> = new Set(["completed", "cancelled", "archived"]);

/** The portal's answers for a link that no longer opens anything. A link
 *  the database does not hold at all is answered DEFINITELY too (PM-2 dw2):
 *  20261104's trg_projects_close_intake_links DELETES a deleted project's
 *  links, so "not found" is usually a withdrawn link, not a typo. */
export const LINK_INVALID_MESSAGE = "This link is no longer valid — it may have been withdrawn or mistyped. Contact your project contact for a new link.";
export const LINK_GONE_MESSAGE = "This link is no longer valid — the project it belonged to no longer exists. Contact your project contact for a new link.";
export const PROJECT_CLOSED_MESSAGE = "This project is closed — the link no longer accepts submissions. Contact your project contact if you still need to send something.";

/** Text limits on a submission (INTK-11 dw3). Refused, never truncated —
 *  a silently shortened drawing number is a different drawing number. */
export const INTAKE_TITLE_MAX = 200;
export const INTAKE_NUMBER_MAX = 64;
export const INTAKE_NOTE_MAX = 2000;
/** A revision label: letters and digits, with `.` or `-` inside
 *  (A, B, 0, 2A, IFC-1, 3.1) — at most 24 characters. It becomes the
 *  controlled revision label on an auto-publish, so free text is refused. */
export const REV_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,22}[A-Za-z0-9])?$/;

export function validateIntakeText(input: {
  title: string | null; number: string | null; revLabel: string | null;
}): string | null {
  if (input.title && input.title.length > INTAKE_TITLE_MAX) {
    return `The title is limited to ${INTAKE_TITLE_MAX} characters.`;
  }
  if (input.number && input.number.length > INTAKE_NUMBER_MAX) {
    return `The drawing number is limited to ${INTAKE_NUMBER_MAX} characters.`;
  }
  if (input.revLabel && !REV_LABEL_RE.test(input.revLabel)) {
    return "A revision label is letters and digits (with . or - inside), at most 24 characters — for example B, 2A or IFC-1.";
  }
  return null;
}

/** The expiry the Intake tab writes for a chosen date: that day's end,
 *  local time. Refuses a blank, past or over-ceiling date. */
export function intakeExpiryFor(dateInput: string, now: Date = new Date()): { ok: true; iso: string } | { ok: false; message: string } {
  if (!dateInput) return { ok: false, message: "Give the link an expiry date — a contractor link never lives forever." };
  const at = new Date(`${dateInput}T23:59:59`);
  if (!Number.isFinite(at.getTime()) || at.getTime() <= now.getTime()) {
    return { ok: false, message: "The expiry date must be in the future." };
  }
  if (at.getTime() - now.getTime() > INTAKE_LINK_MAX_DAYS * 24 * 3600 * 1000 + 24 * 3600 * 1000) {
    return { ok: false, message: `A link can live at most ${INTAKE_LINK_MAX_DAYS} days — pick an earlier date and issue a new link later if needed.` };
  }
  return { ok: true, iso: at.toISOString() };
}

// ── INTK-5: the uniqueness key a partial writer may set ────────────────────
// A library's uniqueness tuple (lib/uniqueness.ts, 20260619) can name fields
// the external door never collects — ["documentNumber","sheet"] exists so
// P&ID sheets 1..8 may all carry the same number. A key computed from what
// the door does have ('p-100::') would make sheet 2 collide with sheet 1.
// So a writer that cannot fill EVERY part of the tuple writes NULL — the
// column's documented opt-out — and skips the pre-check; the database's
// partial unique index then sees the sheet only once the missing part is
// set (the library's properties editor recomputes the key on save).

/** The tuple parts the external door itself collects. */
export const INTAKE_SUPPLIED_KEY_PARTS: ReadonlySet<string> = new Set(["documentNumber", "title"]);

/** A library's uniqueness tuple, with lib/uniqueness.ts's default. */
export function uniquenessTuple(keys: string[] | null | undefined): string[] {
  return keys && keys.length > 0 ? keys : ["documentNumber"];
}

/** Does the drawing number ALONE identify a document in this library? Only
 *  for the default tuple. In any other (a multi-sheet set, number + rev …)
 *  a second live document with the same number is expected, and the full
 *  key — not the number — decides a collision. */
export function numberIsTheKey(keys: string[] | null | undefined): boolean {
  const t = uniquenessTuple(keys);
  return t.length === 1 && t[0] === "documentNumber";
}

/** The key lib/uniqueness.ts computes — but only when EVERY part of the
 *  library's tuple is one the caller supplies (`supplied`, when given) and
 *  non-empty. Otherwise `key` is null and `missing` names the parts that
 *  could not be filled. */
export function completeUniquenessKey(
  fields: DocFieldsForUniqueness,
  keys: string[] | null | undefined,
  supplied?: ReadonlySet<string>,
): { key: string | null; missing: string[] } {
  const tuple = uniquenessTuple(keys);
  const missing = tuple.filter((k) => (supplied && !supplied.has(k)) || computeUniquenessKey(fields, [k]) === null);
  return { key: missing.length > 0 ? null : computeUniquenessKey(fields, tuple), missing };
}

/** Any client with `.from()` — the shared browser client, or a server
 *  route's service-role client. */
type LinkClient = Pick<typeof supabase, "from">;

/**
 * Revoke every live intake link of a project — documents AND quote links
 * (PM-2). Checked: the rows actually revoked are read back, and a refusal is
 * returned, never swallowed. The audit row names the project and the links
 * (ids only — never token material).
 */
export async function revokeProjectIntakeLinks(input: {
  orgId: string;
  projectId: string;
  actorId?: string | null;
  actorEmail?: string | null;
  reason: string;
  client?: LinkClient;
}): Promise<{ ok: boolean; revoked: string[]; error?: string }> {
  const client = input.client ?? supabase;
  const nowIso = new Date().toISOString();
  const { data, error } = await client.from("project_intake_links")
    .update({ revoked_at: nowIso })
    .eq("org_id", input.orgId).eq("project_id", input.projectId).is("revoked_at", null)
    .select("id");
  if (error) return { ok: false, revoked: [], error: `Couldn't revoke the project's contractor links: ${error.message}` };
  const revoked = (((data ?? []) as Array<{ id: string }>)).map((r) => String(r.id));
  if (revoked.length > 0) {
    const { error: auditErr } = await client.from("audit_logs").insert({
      action: "INTAKE_LINKS_REVOKED_WITH_PROJECT",
      resource_type: "project", resource_id: input.projectId,
      org_id: input.orgId, user_id: input.actorId ?? null, user_email: input.actorEmail ?? null,
      details: { linkIds: revoked, reason: input.reason },
    });
    if (auditErr) return { ok: true, revoked, error: `The links were revoked, but the audit record failed: ${auditErr.message}` };
  }
  return { ok: true, revoked };
}
