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
//   * `revokeProjectIntakeLinks` — a checked, audited revoke of a project's
//     live links. The project model (lib/projects.ts, projects Round G J8)
//     revokes inline on close and delete, because its refusal must throw
//     before the status changes; 20261104's trg_projects_close_intake_links
//     (a trigger, not a foreign key — an FK would break org restore) is the
//     database's own answer for a delete that bypasses the app.
//
// Client-safe: no service-role import. The server passes its own client.

import { supabase } from "@/lib/supabase";
import { computeUniquenessKey, type DocFieldsForUniqueness } from "@/lib/uniqueness";

/** The token format both public routes accept. */
export const INTAKE_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** Header the portal sends the token in (the query string works too). */
export const INTAKE_TOKEN_HEADER = "x-intake-token";

/** INTK-15: header a multipart fallback carries naming the direct upload it
 *  replaces (the begin's staged key) — the begin already counted the
 *  attempt, so the door claims it once and does not count it again. */
export const INTAKE_BEGUN_HEADER = "x-intake-begun";

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

// ── SEC-19: the credential is stored as its SHA-256, never read back ───────
// 20261141 keeps no usable token in project_intake_links: a token written by
// any writer is hashed into token_hash (sha256 hex) and token_prefix (its
// first six characters) by trg_project_intake_links_hash_token, and the
// `token` column is held NULL by a CHECK. Both public routes look a link up
// by the hash. So the screens that mint a link show its address ONCE, at
// creation, and a lost address is RE-ISSUED (a new token on the same link),
// never read back. Before 20261141 is applied the plain column still exists
// and is read — every reader below falls back on a missing column.

/** How many leading characters of a token the lists show (20261141). */
export const INTAKE_TOKEN_PREFIX_LEN = 6;

/** A fresh link token: 40 characters from two random UUIDs (the format both
 *  mint screens always used; INTAKE_TOKEN_RE accepts it). */
export function newIntakeToken(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "").slice(0, 40);
}

/** The portal path a token opens. */
export function intakePortalPath(token: string): string {
  return `/submit/${token}`;
}

type PgErr = { message?: string | null; code?: string | null; details?: string | null } | null | undefined;

/** A database that has not received a column yet (PostgREST / Postgres). */
export function isMissingColumnError(e: PgErr, col?: string): boolean {
  if (!e) return false;
  const msg = `${e.message ?? ""} ${e.details ?? ""}`;
  const missing = /^(42703|PGRST204)$/.test(String(e.code ?? "")) || /does not exist|could not find/i.test(msg);
  return missing && (!col || msg.includes(col));
}

/** What a list may show of a link's credential: the full token only where
 *  the database still stores it (before 20261141), otherwise its prefix. */
export function linkCredentialView(row: Record<string, unknown>): { token: string | null; prefix: string | null } {
  const token = typeof row.token === "string" && row.token ? row.token : null;
  const stored = typeof row.token_prefix === "string" && row.token_prefix ? row.token_prefix : null;
  return { token, prefix: stored ?? (token ? token.slice(0, INTAKE_TOKEN_PREFIX_LEN) : null) };
}

/** Run each read in turn and keep the first that is not refused for a
 *  missing column (a later read is the pre-migration column list). */
export async function firstReadWithColumns<T>(
  reads: Array<() => PromiseLike<{ data: T | null; error: PgErr }>>,
): Promise<{ data: T | null; error: PgErr }> {
  let last: { data: T | null; error: PgErr } = { data: null, error: null };
  for (const read of reads) {
    last = await read();
    if (!last.error || !isMissingColumnError(last.error)) return last;
  }
  return last;
}

/** The link a presented token names — looked up by its SHA-256 (the caller
 *  hashes: lib/intakeRateLimit sha256Hex, server side). Before 20261141 the
 *  hash column does not exist and the plain column is read instead. */
export async function readIntakeLinkByToken(client: LinkClient, input: {
  token: string; tokenHash: string; columns: string;
}): Promise<{ data: Record<string, unknown> | null; error: PgErr }> {
  const byHash = await client.from("project_intake_links").select(input.columns)
    .eq("token_hash", input.tokenHash).maybeSingle();
  if (!byHash.error) return { data: (byHash.data as Record<string, unknown> | null) ?? null, error: null };
  if (!isMissingColumnError(byHash.error, "token_hash")) return { data: null, error: byHash.error };
  const byToken = await client.from("project_intake_links").select(input.columns)
    .eq("token", input.token).maybeSingle();
  return { data: (byToken.data as Record<string, unknown> | null) ?? null, error: byToken.error ?? null };
}

/**
 * Re-issue a link (SEC-19): a NEW token on the same link — its id, its
 * authorship of the documents it created, its history, expiry and budget stay;
 * the address the contractor holds stops working. The database hashes the
 * token (20261141); the caller shows the returned token ONCE. Only a live
 * link — not revoked, not expired — is re-issued: a new address on an
 * expired link would answer "This link has expired." to whoever it is sent
 * to. Zero rows is a refusal, never a success. The audit row names the link
 * — never token material.
 */
export async function reissueIntakeLink(input: {
  linkId: string; orgId: string; projectId: string; company: string;
  actorId: string; actorEmail?: string | null; client?: LinkClient;
}): Promise<{ ok: true; token: string; auditError?: string } | { ok: false; error: string }> {
  const client = input.client ?? supabase;
  const token = newIntakeToken();
  const { data, error } = await client.from("project_intake_links")
    .update({ token }).eq("id", input.linkId).is("revoked_at", null)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .select("id");
  if (error) return { ok: false, error: `Couldn't re-issue the link: ${error.message}` };
  if (((data ?? []) as unknown[]).length === 0) {
    return { ok: false, error: `${input.company}'s link was not re-issued — it may have been revoked or have expired (an expired link is not revived: create a new one), or you may not have permission. Refresh to see its state.` };
  }
  const { error: auditErr } = await client.from("audit_logs").insert({
    action: "INTAKE_LINK_REISSUED",
    resource_type: "project_intake_link", resource_id: input.linkId,
    org_id: input.orgId, user_id: input.actorId, user_email: input.actorEmail ?? null,
    details: { company: input.company, projectId: input.projectId },
  });
  return auditErr ? { ok: true, token, auditError: auditErr.message } : { ok: true, token };
}
