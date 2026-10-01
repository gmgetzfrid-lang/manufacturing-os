// /api/ai/usage — the spend meter behind the AI settings dialog.
//
//   GET  ?orgId=…   → your current-month usage vs your cap:
//                     { spentUsd, capUsd, locked, percent, inputTokens,
//                       outputTokens, asks, calls, byOp, avgPromptTokens,
//                       monthLabel, canManageCaps }
//                     Controllers and cap managers additionally get
//                     { team: [...] } — every member's month spend — and
//                     { orgCapUsd, selfUserId, selfFollowsDefault } for the
//                     editor (holders: soleCapsHolder).
//   POST { orgId, capUsd } (ai.manage_caps) → set the org-default monthly cap.
//
// ONE meter (GOV-1): the figures are every op the member's calls wrote —
// questions, vision indexing, the meaning index, the assistant, locate,
// flow reading, drafting, imports, connection tests — with `byOp` naming
// which feature spent what. A ledger that cannot be read answers 503, never
// "$0.00" (GOV-4). A $0 cap is LOCKED (GOV-3): `locked: true`, 100%.
// Who may set caps is the `ai.manage_caps` capability (GOV-10, default
// Admin) read from the org's capability policy — never a role list — and
// nobody raises their OWN cap while someone else holds the capability: not
// by an override, not by clearing one onto a higher default, and not by
// raising the workspace default they follow (their own cap is then held
// where it was, as a personal override, in the same request). A SOLE holder
// — nobody else active holds ai.manage_caps, as in a one-person workspace —
// has no second signature to ask for, so their own raise goes through,
// audited `soleHolder: true` and said in the response (DEC-44 item 5) —
// that audit row is written FIRST and checked, so a raise it cannot record
// is not made. The target is a uuid in any spelling Postgres accepts; the
// route uses the uid the database returns, never the request's spelling,
// so `{ userId: <your own uid in upper case> }` is still your own cap.
// The ban holds at WRITE time, not only when the request is read: clearing
// your own override is refused outright while another holder exists (a
// lower figure is set directly — it is never needed, and racing it against
// a default raise used to delete the hold after it was written); an update
// the caller's own cap was decided from — the workspace default, their own
// override — is guarded by the figure it was decided from (a figure that
// changed underneath answers 409 and changes nothing). Setting your own
// cap while you follow the default is an INSERT, which no figure guards:
// the default is read before it (one that now reads below the figure
// answers 409, nothing written) and again after it, and an override the
// default fell below in between is taken back out, only as it was written
// — audited `compensated`, the other holders told, 409 (503 `unverified`
// when the default cannot be read back). After every write that can RAISE
// the caller's own cap — a default raise, taking a hold back out after a
// default write that did not land, taking that override back out — the
// route reads it again, with the row it comes from: one that ended above
// where it started on the caller's own write is put back DOWN (a guarded
// write that never overwrites a figure set since; its insert is read back
// against the default the same way), audited `compensated` with the figure
// it replaced, the other holders told, and answered 409; a rise another
// holder signed stands — their override of the caller, or a default they
// wrote at or above what the caller's own write set (one they only trimmed
// below it leaves the caller's own rise, which is put back); one that
// cannot be read back is audited `unverified` and answered 503, never a
// plain success. A default lowering cannot raise anyone and is not
// re-read. A hold is written at the lower of the default and the setter's
// own cap as read, and comes back out only as written and only while the
// default is no higher than it (another request may be counting on it); a
// hold that stays is said and told. What the response says about the
// setter's own cap is that re-read, never the intent: `selfHeldAtUsd` when
// it is no higher than it started, `selfCapUsd` + `selfCapSetByAnother`
// when another holder's figure now applies.
// Every change is audited and notifies the other holders and the person
// whose cap moved. A cap table that cannot be read refuses (503) — the team
// view and the "previous figure" never fall back to $10.
//
// Reads are service-role only: ai_usage_events and ai_usage_limits have RLS
// with zero client policies, so this route is the only window into them.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getMonthUsage, getMonthUsageByUser, getCapUsd, DEFAULT_MONTHLY_CAP_USD, capIsLocked, displayCapUsd,
  type MonthUsage,
} from "@/lib/ai/usageServer";
import { GovernedCallError } from "@/lib/ai/gateError";
import { loadCapabilityPolicyStrict, policyAllows, type CapabilityPolicy } from "@/lib/capabilityPolicy";
import { isControllerPrincipal } from "@/lib/permissions";
import type { Role } from "@/types/schema";

export const runtime = "nodejs";

/** GOV-10: the capability that sets monthly AI caps. */
const AI_MANAGE_CAPS = "ai.manage_caps" as const;

function bad(msg: string, status = 400, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: msg, ...extra }, { status });
}

async function authMember(req: NextRequest, orgId: string) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (error || !user) return null;
  const { data: member } = await supabaseAdmin
    .from("org_members").select("uid, role, roles, display_name, email")
    .eq("org_id", orgId).eq("uid", user.id).eq("status", "active")
    .maybeSingle();
  if (!member) return null;
  const role = member.role as Role;
  const roles = ((member.roles as Role[] | null) ?? []);
  return {
    userId: user.id,
    role,
    roles,
    name: (member.display_name as string) || (member.email as string) || "Member",
    // The controller tier by the held collection (DEC-35: through the helper).
    isController: isControllerPrincipal({ role, roles }),
  };
}
type Auth = NonNullable<Awaited<ReturnType<typeof authMember>>>;

/** The capability decision, fail CLOSED: a policy that cannot be read denies. */
async function capsAuthority(orgId: string, auth: Auth): Promise<{ ok: true; allowed: boolean; policy: CapabilityPolicy } | { ok: false; error: string }> {
  const loaded = await loadCapabilityPolicyStrict(orgId, supabaseAdmin);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return { ok: true, policy: loaded.policy, allowed: policyAllows(loaded.policy, AI_MANAGE_CAPS, auth.role, auth.roles, auth.userId) };
}

/** GOV-10: the OTHER active members who hold ai.manage_caps — who a cap
 *  notice goes to, and the second signature a self-raise needs. An error
 *  when the roster cannot be read (never "nobody else"). */
async function otherCapsHolders(orgId: string, auth: Auth, policy: CapabilityPolicy):
  Promise<{ ok: true; uids: string[] } | { ok: false; error: string }> {
  const { data, error } = await supabaseAdmin
    .from("org_members").select("uid, role, roles")
    .eq("org_id", orgId).eq("status", "active");
  if (error) return { ok: false, error: error.message };
  return { ok: true, uids: holdersAmong(data, policy).filter((uid) => uid !== auth.userId) };
}

/** The members of `rows` the policy lets set caps. */
function holdersAmong(rows: unknown, policy: CapabilityPolicy): string[] {
  return ((rows ?? []) as Array<{ uid: string; role: string | null; roles: string[] | null }>)
    .filter((m) => policyAllows(policy, AI_MANAGE_CAPS, m.role, m.roles ?? [], m.uid))
    .map((m) => m.uid);
}

const limitsTableMissing = (e: { code?: string; message: string }) =>
  e.code === "42P01" || /does not exist/i.test(e.message);

/** GOV-10: a uuid in any spelling Postgres's uuid input accepts — upper or
 *  lower case, wrapped in braces, a hyphen after any group of four digits
 *  or none — as the canonical lowercase 8-4-4-4-12 form; null for anything
 *  else. The uuid columns match every one of those spellings, so a
 *  comparison against the caller's own id must never use the request's. */
function canonicalUuid(raw: string): string | null {
  const braced = /^\{(.*)\}$/.exec(raw);
  const body = braced ? braced[1] : raw;
  if (!/^[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}$/i.test(body)) return null;
  const hex = body.replace(/-/g, "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** The same member, whatever the spelling (ids that are not uuids compare as written). */
const sameUid = (a: string, b: string) => (canonicalUuid(a) ?? a) === (canonicalUuid(b) ?? b);

/** Write one AI_CAP_CHANGED row; the reason when it was not written. */
async function auditCapChange(orgId: string, auth: Auth, details: Record<string, unknown>): Promise<string | null> {
  try {
    const { error } = await supabaseAdmin.from("audit_logs").insert({
      action: "AI_CAP_CHANGED",
      resource_type: "ai_usage_limit", resource_id: orgId,
      org_id: orgId, user_id: auth.userId,
      details,
    });
    return error ? (error.message || "the audit log refused the row") : null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
const SOLE_AUDIT_FAILED = "Couldn't write the audit record that raising your own cap without a second signature needs, so nothing was changed";

/** The stored workspace default (display figure: 0 = locked), $10 when no
 *  row exists; an error when the table cannot be read. `stored` is the
 *  column's value as read — what a write decided from it is guarded by —
 *  and `writtenBy` who last wrote it (`updated_by`; null when unrecorded). */
async function readOrgDefault(orgId: string): Promise<
  | { ok: true; capUsd: number; exists: boolean; stored: number | string | null; writtenBy: string | null; tableMissing: boolean }
  | { ok: false; error: string }
> {
  const { data, error } = await supabaseAdmin.from("ai_usage_limits")
    .select("monthly_cap_usd, updated_by").eq("org_id", orgId).is("user_id", null).maybeSingle();
  if (error && !limitsTableMissing(error)) return { ok: false, error: error.message };
  const row = data as { monthly_cap_usd?: number | string | null; updated_by?: string | null } | null;
  const stored = row?.monthly_cap_usd ?? null;
  const raw = Number(stored);
  return {
    ok: true,
    capUsd: stored !== null && Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MONTHLY_CAP_USD,
    exists: !!data, stored, writtenBy: row?.updated_by ?? null, tableMissing: !!error,
  };
}
/** The default read twice (once more when the first read fails). */
async function rereadOrgDefault(orgId: string) {
  const first = await readOrgDefault(orgId);
  return first.ok ? first : readOrgDefault(orgId);
}

/** GOV-10: the caller's own cap now (display figure: 0 = locked); null when
 *  it cannot be read. */
async function readOwnCap(orgId: string, auth: Auth): Promise<number | null> {
  try { return displayCapUsd(await getCapUsd(orgId, auth.userId)); }
  catch (e) {
    if (e instanceof GovernedCallError) return null;
    throw e;
  }
}

/** A unique-index refusal: another request wrote the same row first. */
const isUniqueViolation = (e: { code?: string } | null) => e?.code === "23505";

/** GOV-10: the caller's own cap now (display figure: 0 = locked), the row it
 *  comes from — their own override, else the workspace default — and who
 *  last wrote that row (`updated_by`; null when it was never recorded). An
 *  error when either row cannot be read. */
async function readOwnCapSource(orgId: string, auth: Auth): Promise<
  | { ok: true; capUsd: number; override: boolean; stored: number | string | null; writtenBy: string | null }
  | { ok: false; error: string }
> {
  const [own, def] = await Promise.all([
    supabaseAdmin.from("ai_usage_limits").select("monthly_cap_usd, updated_by")
      .eq("org_id", orgId).eq("user_id", auth.userId).limit(1),
    supabaseAdmin.from("ai_usage_limits").select("monthly_cap_usd, updated_by")
      .eq("org_id", orgId).is("user_id", null).limit(1),
  ]);
  for (const res of [own, def]) {
    if (res.error && !limitsTableMissing(res.error)) return { ok: false, error: res.error.message };
  }
  type LimitRow = { monthly_cap_usd?: number | string | null; updated_by?: string | null };
  const ownRow = (own.error ? null : ((own.data ?? []) as LimitRow[])[0]) ?? null;
  const row = ownRow ?? (def.error ? null : ((def.data ?? []) as LimitRow[])[0]) ?? null;
  const stored = row?.monthly_cap_usd ?? null;
  const raw = Number(stored);
  return {
    ok: true,
    capUsd: stored !== null && Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MONTHLY_CAP_USD,
    override: ownRow !== null, stored, writtenBy: row?.updated_by ?? null,
  };
}

/** GOV-10: a row another member wrote last — their figure, signed by them. */
const writtenByAnother = (writtenBy: string | null, auth: Auth) => writtenBy !== null && !sameUid(writtenBy, auth.userId);

/** GOV-10: whether the figure the caller's cap now comes from is ANOTHER
 *  holder's signed raise, which stands. Their override of the caller is.
 *  The workspace default is only when they wrote it at or above what the
 *  caller's own write set (`ownWriteUsd`: the figure a default raise wrote,
 *  or the default a removed hold or override let them follow) — a default
 *  another holder TRIMMED below that leaves the caller where their own
 *  write lifted them, so the rise is still the caller's and is put back. */
const risenByAnother = (
  row: { override: boolean; capUsd: number; writtenBy: string | null }, auth: Auth, ownWriteUsd: number,
) => writtenByAnother(row.writtenBy, auth) && (row.override || row.capUsd >= ownWriteUsd);

const fmtCap = (v: number) => (v === 0 ? "$0 (locked)" : `$${v}`);

/** What putting the caller's own cap back did (`holdOwnCapAt`). */
type PutBack =
  | { kind: "putBack"; fromUsd: number }
  | { kind: "none"; nowUsd: number }
  | { kind: "theirs"; nowUsd: number }
  | { kind: "unverified"; fromUsd: number; error: string }
  | { kind: "failed"; error: string; fromUsd: number | null };

/** GOV-10: put the caller's own cap back DOWN to `capUsd` after a write of
 *  theirs let it rise. It only ever lowers, and never over another holder's
 *  figure: it reads the cap and the row it comes from, and the write is
 *  guarded by the figure it replaces and by who wrote it, so a figure set
 *  since — a lock another holder put on, a raise of theirs — is never
 *  overwritten. An override another request inserted first (the unique
 *  index's 23505) is read again and lowered under the same guard. A caller
 *  who follows the default is put back by an INSERT, which no figure
 *  guards: the default is read again after it, and a put-back the default
 *  moved under — now at or below it (a lock), or another holder's signed
 *  figure (`risenByAnother`, against `ownWriteUsd`) — is taken back out,
 *  only as it was written, and the cap read again.
 *    putBack    — lowered from `fromUsd`, the figure it actually replaced
 *    none       — already at or below `capUsd`: nothing to put back
 *    theirs     — another holder wrote the figure since: it stands
 *    unverified — put back, but the default could not be read back
 *    failed     — the write was refused, or the cap kept changing. */
async function holdOwnCapAt(orgId: string, auth: Auth, capUsd: number, ownWriteUsd: number): Promise<PutBack> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const fields = { monthly_cap_usd: capUsd, updated_by: auth.userId, updated_at: new Date().toISOString() };
    const now = await readOwnCapSource(orgId, auth);
    if (!now.ok) return { kind: "failed", error: now.error, fromUsd: null };
    if (now.capUsd <= capUsd) return { kind: "none", nowUsd: now.capUsd };
    if (risenByAnother(now, auth, ownWriteUsd)) return { kind: "theirs", nowUsd: now.capUsd };
    if (now.override) {
      let write = supabaseAdmin.from("ai_usage_limits").update(fields)
        .eq("org_id", orgId).eq("user_id", auth.userId)
        .gt("monthly_cap_usd", capUsd).eq("monthly_cap_usd", now.stored as number | string);
      write = now.writtenBy === null ? write.is("updated_by", null) : write.eq("updated_by", now.writtenBy);
      const { data, error } = await write.select("id");
      if (error) return { kind: "failed", error: error.message || "the write was refused", fromUsd: now.capUsd };
      if (((data as unknown[] | null) ?? []).length > 0) return { kind: "putBack", fromUsd: now.capUsd };
      // The row changed underneath: read it again.
    } else {
      const { error } = await supabaseAdmin.from("ai_usage_limits").insert({ org_id: orgId, user_id: auth.userId, ...fields });
      if (error && !isUniqueViolation(error)) return { kind: "failed", error: error.message || "the write was refused", fromUsd: now.capUsd };
      if (!error) {
        // The default this put-back was decided from, read again.
        const def = await rereadOrgDefault(orgId);
        if (!def.ok) return { kind: "unverified", fromUsd: now.capUsd, error: def.error };
        if (String(def.stored) === String(now.stored) && def.writtenBy === now.writtenBy) return { kind: "putBack", fromUsd: now.capUsd };
        const since = { override: false, capUsd: def.capUsd, writtenBy: def.writtenBy };
        // Moved, but still the caller's own rise above the put-back: it replaced that.
        if (def.capUsd > capUsd && !risenByAnother(since, auth, ownWriteUsd)) return { kind: "putBack", fromUsd: def.capUsd };
        // At or below the put-back now, or another holder's signed figure:
        // the put-back is not the caller's to keep. Out, only as written.
        const { error: undoError } = await supabaseAdmin.from("ai_usage_limits").delete()
          .eq("org_id", orgId).eq("user_id", auth.userId).eq("monthly_cap_usd", capUsd)
          .eq("updated_by", auth.userId).select("id");
        if (undoError) {
          return {
            kind: "failed", fromUsd: now.capUsd,
            error: `the default changed to ${fmtCap(def.capUsd)} as it was put back, and the put-back could not be taken back out (${undoError.message || "the delete was refused"})`,
          };
        }
      }
      // An override was written first, or the put-back came back out: read it again.
    }
  }
  return { kind: "failed", error: "the cap kept changing while it was being put back", fromUsd: null };
}

const monthLabel = () =>
  new Date().toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** GOV-3: a locked cap reads 100%; otherwise spend over cap, clamped. */
function usagePercent(spentUsd: number, capUsd: number): number {
  if (capIsLocked(capUsd)) return 100;
  return Math.min(100, Math.round((spentUsd / capUsd) * 100));
}

export async function GET(req: NextRequest) {
  const orgId = (req.nextUrl.searchParams.get("orgId") ?? "").trim();
  if (!orgId) return bad("orgId is required");
  const auth = await authMember(req, orgId);
  if (!auth) return bad("Unauthorized", 401);

  let mine: MonthUsage;
  let capUsd: number;
  try {
    [mine, capUsd] = await Promise.all([
      getMonthUsage(orgId, auth.userId),
      getCapUsd(orgId, auth.userId),
    ]);
  } catch (e) {
    // GOV-4: say it — an unreadable ledger is not "$0.00 spent".
    if (e instanceof GovernedCallError) return bad(e.message, e.status, { usageUnavailable: true });
    throw e;
  }
  const caps = await capsAuthority(orgId, auth);
  const canManageCaps = caps.ok && caps.allowed;

  const payload: Record<string, unknown> = {
    ...mine,
    capUsd: displayCapUsd(capUsd),
    locked: capIsLocked(capUsd),
    percent: usagePercent(mine.spentUsd, capUsd),
    monthLabel: monthLabel(),
    canManageCaps,
  };

  if (auth.isController || canManageCaps) {
    let byUser: Map<string, MonthUsage>;
    try {
      byUser = await getMonthUsageByUser(orgId);
    } catch (e) {
      if (e instanceof GovernedCallError) return bad(e.message, e.status, { usageUnavailable: true });
      throw e;
    }
    const [membersRes, limitsRes] = await Promise.all([
      supabaseAdmin.from("org_members")
        .select("uid, display_name, email, role, roles")
        .eq("org_id", orgId).eq("status", "active"),
      supabaseAdmin.from("ai_usage_limits")
        .select("user_id, monthly_cap_usd")
        .eq("org_id", orgId),
    ]);
    // GOV-4: a cap table that cannot be read is said — never everyone "on
    // the $10 default", which a manager would then re-set caps from.
    if (limitsRes.error && !limitsTableMissing(limitsRes.error)) {
      return bad(`AI caps can't be read right now (${limitsRes.error.message}).`, 503, { usageUnavailable: true });
    }
    const members = (membersRes.data ?? []) as Array<{ uid: string; display_name: string | null; email: string | null }>;
    const limits = (limitsRes.error ? [] : (limitsRes.data ?? [])) as Array<{ user_id: string | null; monthly_cap_usd: number | string }>;
    const orgCapRaw = Number(limits.find((l) => l.user_id === null)?.monthly_cap_usd);
    const orgCapUsd = Number.isFinite(orgCapRaw) && orgCapRaw >= 0 ? orgCapRaw : DEFAULT_MONTHLY_CAP_USD;
    const overrideByUser = new Map(
      limits.filter((l) => l.user_id !== null).map((l) => [l.user_id as string, Number(l.monthly_cap_usd)]),
    );
    payload.orgCapUsd = orgCapUsd;
    // The viewer's own row in `team` (GOV-10): the editor offers it no
    // figure the server would refuse as a self-raise.
    payload.selfUserId = auth.userId;
    // Whether the viewer's own cap follows the default — a holder who raises
    // the default is then held at their current cap (GOV-10) — unless they
    // are the SOLE holder, who has nobody else to raise it.
    payload.selfFollowsDefault = !overrideByUser.has(auth.userId);
    if (caps.ok && caps.allowed && !membersRes.error) {
      payload.soleCapsHolder = holdersAmong(membersRes.data, caps.policy).every((uid) => uid === auth.userId);
    }
    payload.team = members
      .map((m) => {
        const u = byUser.get(m.uid);
        const override = overrideByUser.get(m.uid);
        const cap = Number.isFinite(override) ? (override as number) : orgCapUsd;
        return {
          userId: m.uid,
          name: m.display_name || m.email || "Member",
          spentUsd: u?.spentUsd ?? 0,
          asks: u?.asks ?? 0,
          calls: u?.calls ?? 0,
          byOp: u?.byOp ?? {},
          inputTokens: u?.inputTokens ?? 0,
          outputTokens: u?.outputTokens ?? 0,
          capUsd: cap,
          locked: cap === 0,
          hasOverride: Number.isFinite(override),
        };
      })
      .sort((a, b) => b.spentUsd - a.spentUsd);
  }

  return NextResponse.json(payload);
}

/** Bell notice to every OTHER holder of ai.manage_caps, and to the person
 *  whose own cap moved (GOV-10 done-when 4). Best-effort: the change and its
 *  audit row are already written. Three notices are about the actor's OWN
 *  cap after a change of theirs (so they go to the other holders only):
 *  `putBack` — the route put it back down at `capUsd` from `previousCapUsd`
 *  (the figure it replaced) because it rose (with `error` when it could not
 *  be put back; `overrideRemoved` when it was their own new override the
 *  default fell below, taken back out so they follow the default at
 *  `capUsd`); `unverified` — it could not be read back, so nobody has
 *  checked it; `holdKept` — a default raise of theirs did not land, and the
 *  hold it wrote stays (the reason), so they no longer follow the default. */
async function notifyCapChange(orgId: string, auth: Auth, policy: CapabilityPolicy, change: {
  targetUserId: string | null; capUsd: number | null; previousCapUsd: number | null;
  putBack?: { error: string | null; overrideRemoved?: boolean }; unverified?: boolean; holdKept?: string;
}) {
  const others = await otherCapsHolders(orgId, auth, policy);
  const recipients = new Set(others.ok ? others.uids : []);
  if (change.targetUserId) recipients.add(change.targetUserId);
  for (const uid of [...recipients]) if (sameUid(uid, auth.userId)) recipients.delete(uid);
  if (recipients.size === 0) return;
  const what = change.targetUserId ? "a person's monthly AI cap" : "the workspace's default monthly AI cap";
  const fmt = (v: number | null) => (v === null ? "the workspace default" : v === 0 ? "$0 (locked)" : `$${v}`);
  const own = `${auth.name}'s own monthly AI cap`;
  const together = "a cap change of theirs and another change landed at the same moment";
  const body = change.putBack?.error
    ? `${own} rose from ${fmt(change.capUsd)} to ${fmt(change.previousCapUsd)} when ${together}, and it could not be put back (${change.putBack.error}). Nobody raises their own cap — check it in AI settings.`
    : change.putBack?.overrideRemoved
      ? `${own} was set to ${fmt(change.previousCapUsd)} by them while the workspace default they followed fell to ${fmt(change.capUsd)} — ${together} — so their new override was taken back out and they follow the default again. Nobody raises their own cap.`
    : change.putBack
      ? `${own} was put back from ${fmt(change.previousCapUsd)} to ${fmt(change.capUsd)}: ${together} and raised it, and nobody raises their own cap. If you had raised it, raise it again.`
      : change.unverified
        ? `${own} could not be read back after a cap change of theirs, so nobody has checked that it stayed at ${fmt(change.previousCapUsd)}. Nobody raises their own cap — check it in AI settings.`
        : change.holdKept
          ? `${own} stays held at ${fmt(change.capUsd)}: a raise of the workspace default by them did not land, and the hold it wrote stays — ${change.holdKept}. They no longer follow the default; if they should, clear their cap in AI settings.`
          : `${auth.name} changed ${what} from ${fmt(change.previousCapUsd)} to ${fmt(change.capUsd)}.`;
  const title = (uid: string) => change.putBack?.error ? "A monthly AI cap could not be put back"
    : change.putBack ? "A monthly AI cap was put back"
      : change.unverified ? "A monthly AI cap needs checking"
        : change.holdKept ? "A monthly AI cap is still held"
          : uid === change.targetUserId ? "Your monthly AI cap changed" : "A monthly AI cap changed";
  await supabaseAdmin.from("notifications").insert([...recipients].map((uid) => ({
    org_id: orgId,
    user_id: uid,
    kind: "ai_cap_changed",
    title: title(uid),
    body,
    link: "/intelligence/setup",
    resource_type: "ai_usage_limit",
    resource_id: orgId,
    actor_user_id: auth.userId,
    actor_name: auth.name,
    metadata: {
      targetUserId: change.targetUserId, capUsd: change.capUsd, previousCapUsd: change.previousCapUsd,
      ...(change.putBack ? {
        putBack: true,
        ...(change.putBack.error ? { putBackError: change.putBack.error } : {}),
        ...(change.putBack.overrideRemoved ? { overrideRemoved: true } : {}),
      } : {}),
      ...(change.unverified ? { unverified: true } : {}),
      ...(change.holdKept ? { holdKept: change.holdKept } : {}),
    },
  }))).then(() => undefined, () => undefined);
}

export async function POST(req: NextRequest) {
  // { orgId, capUsd }                → set the org-default cap
  // { orgId, capUsd, userId }        → set THAT person's cap (override)
  // { orgId, capUsd: null, userId }  → clear the override (back to default)
  let body: { orgId?: string; capUsd?: number | null; userId?: string };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  if (!orgId) return bad("orgId is required");
  const auth = await authMember(req, orgId);
  if (!auth) return bad("Unauthorized", 401);
  const caps = await capsAuthority(orgId, auth);
  if (!caps.ok) return bad(`Couldn't read the capability policy, so no cap was changed: ${caps.error}`, 503);
  if (!caps.allowed) {
    return bad("Setting monthly AI caps takes the “Manage AI spend caps” permission (Admin by default — it can be granted in Permissions).", 403);
  }

  // GOV-10: the target as the DATABASE spells it. org_members.uid is a uuid
  // column, so `.eq("uid", …)` matches the caller's own id written in upper
  // case, in braces or without hyphens — a request spelling compared with
  // auth.userId would miss it and let the caller raise their own cap. Every
  // read, write, comparison, audit row and notice below uses the uid the
  // lookup returns.
  const rawTarget = String(body.userId ?? "").trim();
  let targetUserId: string | null = null;
  if (rawTarget) {
    const asUuid = canonicalUuid(rawTarget);
    if (!asUuid) return bad("userId must be a workspace member's id.");
    const { data: target } = await supabaseAdmin
      .from("org_members").select("uid")
      .eq("org_id", orgId).eq("uid", asUuid).eq("status", "active")
      .maybeSingle();
    if (!target) return bad("That person isn't an active member of this workspace.", 404);
    targetUserId = String((target as { uid: string }).uid);
  }

  // The cap that applies to the target before this change (display figure:
  // 0 = locked) — the self-raise test and the notice both read it.
  const selfTarget = targetUserId !== null && sameUid(targetUserId, auth.userId);
  let previousCapUsd: number | null = null;
  let orgDefault: Extract<Awaited<ReturnType<typeof readOrgDefault>>, { ok: true }> | null = null;
  if (targetUserId) {
    try { previousCapUsd = displayCapUsd(await getCapUsd(orgId, targetUserId)); }
    catch (e) {
      if (e instanceof GovernedCallError) return bad(e.message, e.status);
      throw e;
    }
  } else {
    const prev = await readOrgDefault(orgId);
    if (!prev.ok) return bad(`Couldn't read the current default cap, so nothing was changed: ${prev.error}`, 503);
    previousCapUsd = prev.capUsd;
    orgDefault = prev;
  }
  // GOV-10: nobody raises their OWN cap — not by an override, not by
  // clearing one onto a higher default. Lowering it is always allowed.
  // (Display figures compare directly: 0 = locked is the lowest.)
  const selfRaise = (next: number) => selfTarget && previousCapUsd !== null && next > previousCapUsd;
  const SELF_RAISE = "You can't raise your own monthly AI cap — another person with the “Manage AI spend caps” permission has to.";
  /** GOV-10: the second signature a self-raise needs exists only when
   *  someone else holds ai.manage_caps. A SOLE holder (a one-person
   *  workspace; the only Admin, with nobody else granted it) has nobody to
   *  ask, so the raise goes through — audited `soleHolder: true`, that row
   *  written BEFORE the change and checked: it is the only control on the
   *  raise, so one that cannot be written refuses (503, nothing changed).
   *  A roster that cannot be read refuses: never "nobody else". */
  const soleHolderVerdict = async (): Promise<{ ok: true; sole: boolean } | { ok: false; res: NextResponse }> => {
    const others = await otherCapsHolders(orgId, auth, caps.policy);
    if (!others.ok) {
      return { ok: false, res: bad(`Couldn't check who else manages AI caps, so nothing was changed: ${others.error}`, 503) };
    }
    return { ok: true, sole: others.uids.length === 0 };
  };
  let soleHolder = false;
  /** GOV-10: after a write that can RAISE the caller's own cap — a raise of
   *  the workspace default, taking a hold back out, and taking back out an
   *  override of their own the default fell below — read it again (once
   *  more if the read fails), with the row it comes from. A write that
   *  cannot raise it (a default lowering, an update of their own override,
   *  guarded by the figure it was decided from: a raise there is a sole
   *  holder's) is not re-read: the re-read could only catch another
   *  holder's write, and putting that back would undo it. One that ended
   *  ABOVE `ownBeforeUsd`:
   *    - is theirs — a signed raise — and stands (`theirs`), never put back,
   *      on their override of the caller, or on a default they wrote at or
   *      above `ownWriteUsd`, what the caller's own write set
   *      (`risenByAnother`);
   *    - otherwise, for a caller who is not the sole holder, it is put back
   *      DOWN there (`holdOwnCapAt`, guarded: it never overwrites a figure
   *      set since), audited `compensated` with the figure it replaced
   *      (`notApplied` too when the put-back fails), and the other holders
   *      are told.
   *  One that cannot be read back — or a put-back that cannot be checked
   *  against the default — is audited `unverified` and said, never a plain
   *  success the route could not check. A sole holder's own raise needs
   *  nobody, so it is not checked. */
  const recheckOwnCap = async (ownBeforeUsd: number, ownWriteUsd: number): Promise<
    | { kind: "ok"; ownAfterUsd: number | null }
    | { kind: "theirs"; ownAfterUsd: number }
    | { kind: "compensated"; ownAfterUsd: number; holdError: string | null; ownNowUsd: number | null }
    | { kind: "unverified" }
  > => {
    if (soleHolder) return { kind: "ok", ownAfterUsd: null };
    let now = await readOwnCapSource(orgId, auth);
    if (!now.ok) now = await readOwnCapSource(orgId, auth);
    if (now.ok && now.capUsd <= ownBeforeUsd) return { kind: "ok", ownAfterUsd: now.capUsd };
    if (now.ok && risenByAnother(now, auth, ownWriteUsd)) return { kind: "theirs", ownAfterUsd: now.capUsd };
    // Risen, or unknown: is there a second signature the caller answers to?
    // (A roster that cannot be read is never "nobody else".)
    const v = await soleHolderVerdict();
    if (v.ok && v.sole) return { kind: "ok", ownAfterUsd: now.ok ? now.capUsd : null };
    if (!now.ok) {
      await auditCapChange(orgId, auth, { targetUserId: auth.userId, previousCapUsd: ownBeforeUsd, unverified: true });
      await notifyCapChange(orgId, auth, caps.policy, { targetUserId: auth.userId, capUsd: null, previousCapUsd: ownBeforeUsd, unverified: true });
      return { kind: "unverified" };
    }
    const put = await holdOwnCapAt(orgId, auth, ownBeforeUsd, ownWriteUsd);
    // Lowered since by someone (nothing to put back), or another holder's figure now: it stands.
    if (put.kind === "none") return { kind: "ok", ownAfterUsd: put.nowUsd };
    if (put.kind === "theirs") return { kind: "theirs", ownAfterUsd: put.nowUsd };
    if (put.kind === "unverified") {
      // Put back, but nobody has checked it against the default since.
      await auditCapChange(orgId, auth, {
        targetUserId: auth.userId, capUsd: ownBeforeUsd, previousCapUsd: put.fromUsd, compensated: true, unverified: true, error: put.error,
      });
      await notifyCapChange(orgId, auth, caps.policy, { targetUserId: auth.userId, capUsd: null, previousCapUsd: ownBeforeUsd, unverified: true });
      return { kind: "unverified" };
    }
    // What was audited and told is the figure actually replaced.
    const fromUsd = put.fromUsd ?? now.capUsd;
    const holdError = put.kind === "failed" ? put.error : null;
    await auditCapChange(orgId, auth, {
      targetUserId: auth.userId, capUsd: ownBeforeUsd, previousCapUsd: fromUsd, compensated: true,
      ...(holdError ? { notApplied: true, error: holdError } : {}),
    });
    await notifyCapChange(orgId, auth, caps.policy, {
      targetUserId: auth.userId, capUsd: ownBeforeUsd, previousCapUsd: fromUsd, putBack: { error: holdError },
    });
    return { kind: "compensated", ownAfterUsd: fromUsd, holdError, ownNowUsd: await readOwnCap(orgId, auth) };
  };

  // Clearing a per-user override — the person falls back to the org default.
  if (targetUserId && body.capUsd === null) {
    // GOV-10: clearing your OWN override is refused while anyone else holds
    // the capability, whatever the two figures read now. It is never needed
    // — a lower figure is set directly — and a clear is only as good as the
    // default it was compared with: racing one against a default raise
    // deleted the hold the raise had just written, leaving the holder on
    // the raised default. A sole holder may clear it (audited below).
    if (selfTarget) {
      const v = await soleHolderVerdict();
      if (!v.ok) return v.res;
      if (!v.sole) {
        return bad("You can't clear your own monthly AI cap override while another person has the “Manage AI spend caps” permission — set a lower figure for yourself directly, or ask them to change it.", 403);
      }
    }
    // The self-raise test reads the default: unreadable → nothing changes.
    const def = await readOrgDefault(orgId);
    if (!def.ok) return bad(`Couldn't read the default cap, so the override was not cleared: ${def.error}`, 503);
    const fallback = def.capUsd;
    // Only a sole holder reaches a self-raise here.
    if (selfRaise(fallback)) soleHolder = true;
    const details = { targetUserId, cleared: true, previousCapUsd, ...(soleHolder ? { soleHolder: true } : {}) };
    if (soleHolder) {
      const auditError = await auditCapChange(orgId, auth, details);
      if (auditError) return bad(`${SOLE_AUDIT_FAILED}: ${auditError}`, 503);
    }
    const { error } = await supabaseAdmin
      .from("ai_usage_limits").delete()
      .eq("org_id", orgId).eq("user_id", targetUserId);
    if (error) {
      // The audit row already says it happened: say it did not.
      if (soleHolder) await auditCapChange(orgId, auth, { ...details, notApplied: true, error: error.message });
      return bad(`Couldn't clear the cap override: ${error.message}`, 500);
    }
    if (!soleHolder) await auditCapChange(orgId, auth, details);
    await notifyCapChange(orgId, auth, caps.policy, { targetUserId, capUsd: null, previousCapUsd });
    return NextResponse.json({ ok: true, cleared: true, ...(soleHolder ? { soleHolder: true } : {}) });
  }

  const capUsd = Number(body.capUsd);
  if (body.capUsd === null || body.capUsd === undefined || !Number.isFinite(capUsd) || capUsd < 0 || capUsd > 10000) {
    return bad("capUsd must be a number between 0 and 10000 (0 locks AI for that person until it is raised).");
  }
  if (selfRaise(capUsd)) {
    const v = await soleHolderVerdict();
    if (!v.ok) return v.res;
    if (!v.sole) return bad(SELF_RAISE, 403);
    soleHolder = true;
  }
  if (orgDefault?.tableMissing) {
    return bad("The ai_usage_limits table doesn't exist yet — run migration 20260916 in Supabase first.", 424);
  }

  // GOV-10: the caller's own cap before this change — what it is read
  // against after every write that can raise it (a default raise, and
  // taking a hold back out), and the most a hold may hold them at.
  let ownBeforeUsd: number | null = selfTarget ? previousCapUsd : null;
  if (!targetUserId) {
    ownBeforeUsd = await readOwnCap(orgId, auth);
    if (ownBeforeUsd === null) {
      return bad("Couldn't read your own cap, so the default was not changed — AI caps can't be read right now.", 503);
    }
  }

  // GOV-10: raising the WORKSPACE default must not raise the setter's own
  // cap. A setter whose cap follows the default (no override of their own)
  // is held where they are — an override, written and audited BEFORE the
  // default moves, at the LOWER of the default as first read and their own
  // cap as read since (the default can be lowered between those reads, and
  // a hold at the first figure would raise them). The default row was read
  // above, so the only step left after the hold is the write itself, and a
  // write that fails (or finds the default changed) takes the hold back
  // out. Raising it later takes another holder, like any other self-raise.
  // A sole holder is not held: they follow the default like everyone else.
  let pinnedSelfAtUsd: number | null = null;
  if (!targetUserId && previousCapUsd !== null && capUsd > previousCapUsd) {
    const { data: own, error: ownError } = await supabaseAdmin.from("ai_usage_limits")
      .select("id").eq("org_id", orgId).eq("user_id", auth.userId).maybeSingle();
    if (ownError && !limitsTableMissing(ownError)) {
      return bad(`Couldn't read your own cap, so the default was not changed: ${ownError.message}`, 503);
    }
    const v = !own && !ownError ? await soleHolderVerdict() : null;
    if (v && !v.ok) return v.res;
    if (v?.ok && v.sole) soleHolder = true;
    else if (v?.ok) {
      const pinAt = Math.min(previousCapUsd, ownBeforeUsd ?? previousCapUsd);
      const { error: pinError } = await supabaseAdmin.from("ai_usage_limits").insert({
        org_id: orgId, user_id: auth.userId, monthly_cap_usd: pinAt,
        updated_by: auth.userId, updated_at: new Date().toISOString(),
      });
      if (pinError) {
        return bad(
          `Couldn't hold your own cap at its current figure, so the default was not raised: ${pinError.message}`,
          isUniqueViolation(pinError) ? 409 : 500,
        );
      }
      pinnedSelfAtUsd = pinAt;
      await auditCapChange(orgId, auth, { targetUserId: auth.userId, capUsd: pinAt, previousCapUsd: ownBeforeUsd ?? previousCapUsd, heldOnDefaultRaise: true });
    }
  }

  // Whether the row exists: the default's was read above; a person's here.
  let rowExists: boolean;
  if (targetUserId) {
    const { data: existing, error: readError } = await supabaseAdmin.from("ai_usage_limits")
      .select("id").eq("org_id", orgId).eq("user_id", targetUserId).maybeSingle();
    if (readError) {
      const missing = limitsTableMissing(readError);
      return bad(
        missing
          ? "The ai_usage_limits table doesn't exist yet — run migration 20260916 in Supabase first."
          : `Couldn't read the current cap: ${readError.message}`,
        missing ? 424 : 500,
      );
    }
    rowExists = !!existing;
  } else {
    rowExists = orgDefault!.exists;
  }
  const details = {
    ...(targetUserId ? { targetUserId } : {}), capUsd, previousCapUsd,
    ...(soleHolder ? { soleHolder: true } : {}),
  };
  // GOV-10: a sole holder's own raise has no second signature — its audit
  // row is the record, so it is written first and a refusal changes nothing.
  if (soleHolder) {
    const auditError = await auditCapChange(orgId, auth, details);
    if (auditError) return bad(`${SOLE_AUDIT_FAILED}: ${auditError}`, 503);
  }
  // GOV-10: the write is guarded by the figure the decision above was made
  // from — the default as read (every default change), or the caller's own
  // cap as read (their own override). A row that no longer carries it
  // matches nothing: the figure changed underneath this request, and
  // writing over it could hand the caller a cap nobody signed for (another
  // holder lowers it, this request "lowers" it less). A row written first
  // by another request is the unique index's refusal — the same conflict.
  // Setting your OWN cap while you follow the default (no override row) is
  // an INSERT, which no figure guards: your cap is then the default, so the
  // default is read first, and one that now reads below the figure — it was
  // lowered or locked, or the override it was decided from was cleared
  // since — would make the insert a raise: 409, nothing written. It is read
  // again after the insert (below). A sole holder's own raise needs neither.
  const selfInsert = selfTarget && !rowExists && !soleHolder;
  const fields = { monthly_cap_usd: capUsd, updated_by: auth.userId, updated_at: new Date().toISOString() };
  let saveError: { code?: string; message: string } | null = null;
  let conflict = false;
  if (rowExists) {
    let write = supabaseAdmin.from("ai_usage_limits").update(fields).eq("org_id", orgId);
    write = targetUserId ? write.eq("user_id", targetUserId) : write.is("user_id", null);
    if (!targetUserId) write = write.eq("monthly_cap_usd", orgDefault!.stored as number | string);
    else if (selfTarget) write = write.eq("monthly_cap_usd", previousCapUsd as number);
    const { data: written, error } = await write.select("id");
    saveError = error;
    conflict = !error && (!targetUserId || selfTarget) && ((written as unknown[] | null) ?? []).length === 0;
  } else {
    if (selfInsert) {
      const def = await readOrgDefault(orgId);
      if (!def.ok) return bad(`Couldn't read the default cap, so your own cap was not changed: ${def.error}`, 503);
      conflict = def.capUsd < capUsd;
    }
    if (!conflict) {
      const { error } = await supabaseAdmin.from("ai_usage_limits").insert({ org_id: orgId, user_id: targetUserId, ...fields });
      saveError = error;
    }
  }
  if (saveError || conflict) {
    conflict = conflict || isUniqueViolation(saveError);
    const why = saveError?.message || "the cap changed while this was being saved";
    // The audit row already says it happened: say it did not.
    if (soleHolder) await auditCapChange(orgId, auth, { ...details, notApplied: true, error: why });
    let status = conflict ? 409 : 500;
    let ownSaid = "";
    const ownExtra: Record<string, unknown> = {};
    // The setter's hold was written for a default raise that did not happen.
    // GOV-10: it comes back out only while the default would leave them no
    // higher than the hold. Another request may have raised the default
    // since — the same holder's second raise writes no hold of its own when
    // it finds this one, and counts on it — and taking it out then would
    // raise the setter's own cap: so it stays, said on the log (`holdKept`),
    // in the answer, and to the other holders (the setter no longer follows
    // the default). A kept hold is never above where the setter started:
    // it was written at the lower of the two figures read. Taking it out is
    // itself a write that can move their cap, so it is checked
    // (`recheckOwnCap`): read again, put back if it rose on the setter's own
    // write (the default can move between the read and the delete). Only as
    // written — a hold someone has changed or cleared since is theirs: the
    // delete matches nothing, and nothing is re-read or put back.
    if (pinnedSelfAtUsd !== null) {
      const held = { targetUserId: auth.userId, capUsd: pinnedSelfAtUsd, previousCapUsd: pinnedSelfAtUsd, heldOnDefaultRaise: true };
      const tellKept = (reason: string) => notifyCapChange(orgId, auth, caps.policy, {
        targetUserId: auth.userId, capUsd: pinnedSelfAtUsd, previousCapUsd: pinnedSelfAtUsd, holdKept: reason,
      });
      const now = await readOrgDefault(orgId);
      const keptFor = !now.ok ? `the default cap can't be read (${now.error})`
        : now.capUsd > pinnedSelfAtUsd ? `the default now reads ${fmtCap(now.capUsd)}` : null;
      if (keptFor) {
        await auditCapChange(orgId, auth, { ...held, defaultNotRaised: true, holdKept: keptFor, error: why });
        ownSaid = ` Your own cap stays held at ${fmtCap(pinnedSelfAtUsd)}: ${keptFor}, and nobody raises their own cap.`;
        ownExtra.holdKept = true;
        await tellKept(keptFor);
      } else {
        const { data: undone, error: undoError } = await supabaseAdmin.from("ai_usage_limits").delete()
          .eq("org_id", orgId).eq("user_id", auth.userId).eq("monthly_cap_usd", pinnedSelfAtUsd)
          .eq("updated_by", auth.userId).select("id");
        const removed = !undoError && ((undone as unknown[] | null) ?? []).length > 0;
        await auditCapChange(orgId, auth, {
          ...held,
          ...(undoError ? { defaultNotRaised: true, holdKept: undoError.message }
            : removed ? { notApplied: true } : { defaultNotRaised: true, holdChanged: true }),
          error: why,
        });
        if (undoError) {
          const reason = `it could not be taken back out (${undoError.message})`;
          ownSaid = ` Your own cap stays held at ${fmtCap(pinnedSelfAtUsd)}: ${reason}, so you no longer follow the workspace default — ask another person who manages AI caps to clear it if you should.`;
          ownExtra.holdKept = true;
          await tellKept(reason);
        } else if (!removed) {
          ownSaid = " Your hold had been changed by another cap change in the meantime, so it was left as it now stands.";
          ownExtra.holdChanged = true;
        }
        const before = ownBeforeUsd ?? pinnedSelfAtUsd;
        // What taking the hold out set: the default as read just before it.
        const defaultAtDelete = now.ok ? now.capUsd : pinnedSelfAtUsd;
        const check = removed ? await recheckOwnCap(before, defaultAtDelete) : null;
        if (check?.kind === "theirs") {
          ownSaid = ` Your hold was taken back out, so your own cap now reads ${fmtCap(check.ownAfterUsd)} — a figure another person who manages AI caps set.`;
          Object.assign(ownExtra, { selfCapUsd: check.ownAfterUsd, selfCapSetByAnother: true });
        } else if (check?.kind === "compensated") {
          const rose = ` Taking your hold back out let your own cap rise to ${fmtCap(check.ownAfterUsd)} — another change landed at the same time`;
          ownSaid = check.holdError
            ? `${rose} — and it could not be put back at ${fmtCap(before)} (${check.holdError}). Tell another person who manages AI caps.`
            : `${rose} — so it was put back at ${fmtCap(before)}.`;
          if (check.holdError) status = 500;
          Object.assign(ownExtra, { compensated: true, ...(check.ownNowUsd !== null ? { selfCapUsd: check.ownNowUsd } : {}) });
        } else if (check?.kind === "unverified") {
          ownSaid = " Your own cap could not be read back after your hold was taken out, so nobody has checked it — tell another person who manages AI caps if yours rose.";
          status = 503;
          ownExtra.unverified = true;
        }
      }
    }
    if (conflict) {
      const head = targetUserId
        ? "That cap changed while you were saving it (another change landed at the same time)"
        : "The workspace default changed while you were saving it (another change landed at the same time)";
      return bad(
        ownSaid ? `${head}, so it was not changed.${ownSaid} Reload the caps and try again.`
          : `${head}, so nothing was changed — reload the caps and try again.`,
        status, { conflict: true, ...ownExtra },
      );
    }
    return bad(`Couldn't save the cap: ${why}${ownSaid ? `.${ownSaid}` : ""}`, status, ownExtra);
  }

  if (!soleHolder) await auditCapChange(orgId, auth, details);
  // The change has landed: the other holders and the person whose cap moved
  // are told, whatever the check below finds about the setter's own cap.
  await notifyCapChange(orgId, auth, caps.policy, { targetUserId, capUsd, previousCapUsd });

  // GOV-10: your own override, INSERTED while you followed the default, is
  // checked against the default read again now. One that fell below it
  // while it was being saved — another holder lowered or locked it for
  // everyone who follows it — would leave you above that figure, so the
  // override comes back out, only as it was written (a row another holder
  // has changed since is theirs and stays), audited `compensated`, the
  // other holders told, and answered 409: you follow the default again.
  // Taking it out is itself a write that can raise you (the default can
  // move again before the delete), so it is re-read like a hold's removal.
  // A default that cannot be read back is audited `unverified` and
  // answered 503 — the change landed, unchecked.
  if (selfInsert) {
    const after = await rereadOrgDefault(orgId);
    if (!after.ok) {
      await auditCapChange(orgId, auth, { targetUserId: auth.userId, capUsd, previousCapUsd, unverified: true, error: after.error });
      await notifyCapChange(orgId, auth, caps.policy, { targetUserId: auth.userId, capUsd: null, previousCapUsd: capUsd, unverified: true });
      return bad(
        `Your own cap is now ${fmtCap(capUsd)}, but the workspace default could not be read back afterwards, so nobody has checked that it did not fall below that while it was being saved — reload the caps, and tell another person who manages AI caps if it did.`,
        503, { saved: true, unverified: true, capUsd },
      );
    }
    if (after.capUsd < capUsd) {
      const defaultNow = after.capUsd;
      const head = `Your own cap was set to ${fmtCap(capUsd)}, but the workspace default you follow fell to ${fmtCap(defaultNow)} while it was being saved (another cap change landed at the same time)`;
      const { data: out, error: outError } = await supabaseAdmin.from("ai_usage_limits").delete()
        .eq("org_id", orgId).eq("user_id", auth.userId).eq("monthly_cap_usd", capUsd)
        .eq("updated_by", auth.userId).select("id");
      if (outError) {
        await auditCapChange(orgId, auth, {
          targetUserId: auth.userId, capUsd: defaultNow, previousCapUsd: capUsd, compensated: true, notApplied: true, error: outError.message,
        });
        await notifyCapChange(orgId, auth, caps.policy, {
          targetUserId: auth.userId, capUsd: defaultNow, previousCapUsd: capUsd, putBack: { error: outError.message },
        });
        return bad(
          `${head}, and your new override could not be taken back out (${outError.message}), so it stays above the default. Tell another person who manages AI caps.`,
          500, { conflict: true, compensated: true, capUsd },
        );
      }
      if (((out as unknown[] | null) ?? []).length === 0) {
        // Changed or cleared by another holder since: theirs, as it stands.
        await auditCapChange(orgId, auth, { targetUserId: auth.userId, capUsd, previousCapUsd, defaultNowUsd: defaultNow, overrideChanged: true });
        const nowCap = await readOwnCap(orgId, auth);
        return bad(
          `${head}, and another cap change has changed your cap since, so it was left as it now stands. Reload the caps.`,
          409, { conflict: true, overrideChanged: true, capUsd, ...(nowCap !== null ? { selfCapUsd: nowCap } : {}) },
        );
      }
      await auditCapChange(orgId, auth, {
        targetUserId: auth.userId, capUsd: defaultNow, previousCapUsd: capUsd, compensated: true, overrideRemoved: true,
      });
      await notifyCapChange(orgId, auth, caps.policy, {
        targetUserId: auth.userId, capUsd: defaultNow, previousCapUsd: capUsd, putBack: { error: null, overrideRemoved: true },
      });
      const check = await recheckOwnCap(defaultNow, defaultNow);
      let said = `${head}, so your new override was taken back out and you follow the default again. Nobody raises their own cap; reload the caps and try again.`;
      let status = 409;
      const extra: Record<string, unknown> = { conflict: true, compensated: true, capUsd };
      if (check.kind === "theirs") {
        said += ` Your own cap now reads ${fmtCap(check.ownAfterUsd)} — a figure another person who manages AI caps set.`;
        Object.assign(extra, { selfCapUsd: check.ownAfterUsd, selfCapSetByAnother: true });
      } else if (check.kind === "compensated") {
        const rose = ` Taking it out let your own cap rise to ${fmtCap(check.ownAfterUsd)} — another change landed at the same time`;
        said += check.holdError
          ? `${rose} — and it could not be put back at ${fmtCap(defaultNow)} (${check.holdError}). Tell another person who manages AI caps.`
          : `${rose} — so it was put back at ${fmtCap(defaultNow)}.`;
        if (check.holdError) status = 500;
        if (check.ownNowUsd !== null) extra.selfCapUsd = check.ownNowUsd;
      } else if (check.kind === "unverified") {
        said += " Your own cap could not be read back after the override was taken out, so nobody has checked it — tell another person who manages AI caps if yours rose.";
        status = 503;
        extra.unverified = true;
      } else if (check.ownAfterUsd !== null) {
        extra.selfCapUsd = check.ownAfterUsd;
      }
      return bad(said, status, extra);
    }
  }

  // GOV-10: a write that can RAISE the caller's own cap — a raise of the
  // default — is checked by reading it again (recheckOwnCap). One that
  // ended ABOVE where it started on the caller's own write — another change
  // took the hold out between this request's steps — is put back at the
  // starting figure and answered 409; a rise another holder signed (their
  // override of the caller, or a default they wrote at or above this raise)
  // stands; a default another holder only trimmed below this raise leaves
  // the rise the caller's own, and it is put back; one that cannot be read
  // back is answered 503 (the change landed; the setter's own cap is
  // unchecked). A default lowering and an update of one's own override
  // (guarded by the figure decided from: only ever a lowering, unless a
  // sole holder's) cannot raise it, and are not re-read; an override of
  // one's own that was INSERTED is checked above. What the response says
  // about the setter's own cap is this re-read, never the intent:
  // `selfHeldAtUsd` when it is no higher than it started, `selfCapUsd` with
  // `selfCapSetByAnother` when another holder's figure now applies.
  let ownAfterUsd: number | null = null;
  let ownSetByAnother = false;
  if (!targetUserId && previousCapUsd !== null && capUsd > previousCapUsd && ownBeforeUsd !== null) {
    const check = await recheckOwnCap(ownBeforeUsd, capUsd);
    const saved = `The default monthly cap is now ${fmtCap(capUsd)}`;
    if (check.kind === "compensated") {
      const moved = `${saved}, but your own cap rose to ${fmtCap(check.ownAfterUsd)} while it was being saved — another cap change landed at the same time`;
      return bad(
        check.holdError
          ? `${moved}, and it could not be put back at ${fmtCap(ownBeforeUsd)} (${check.holdError}). Tell another person who manages AI caps.`
          : `${moved} — so it was put back at ${fmtCap(ownBeforeUsd)}. Nobody raises their own cap; reload the caps, and ask another person who manages AI caps if yours should be higher.`,
        check.holdError ? 500 : 409,
        { conflict: true, compensated: true, capUsd, ...(check.ownNowUsd !== null ? { selfCapUsd: check.ownNowUsd } : {}) },
      );
    }
    if (check.kind === "unverified") {
      return bad(
        `${saved}, but your own cap could not be read back afterwards, so nobody has checked that it did not rise with the change — reload the caps, and tell another person who manages AI caps if yours rose.`,
        503, { saved: true, unverified: true, capUsd },
      );
    }
    ownAfterUsd = check.ownAfterUsd;
    ownSetByAnother = check.kind === "theirs";
  }

  return NextResponse.json({
    ok: true, capUsd, locked: capUsd === 0,
    // Another holder's figure applies to the setter now (it rose, signed by them).
    ...(ownSetByAnother && ownAfterUsd !== null ? { selfCapUsd: ownAfterUsd, selfCapSetByAnother: true }
      // The setter was held on a default raise: where their cap reads NOW,
      // no higher than it started.
      : pinnedSelfAtUsd !== null && ownAfterUsd !== null && ownBeforeUsd !== null && ownAfterUsd <= ownBeforeUsd
        ? { selfHeldAtUsd: ownAfterUsd }
        : ownAfterUsd !== null && ownBeforeUsd !== null && ownAfterUsd > ownBeforeUsd ? { selfCapUsd: ownAfterUsd } : {}),
    // GOV-10: said, not silent — the setter's own cap moved with no second
    // signature because nobody else holds the capability.
    ...(soleHolder ? { soleHolder: true } : {}),
  });
}
