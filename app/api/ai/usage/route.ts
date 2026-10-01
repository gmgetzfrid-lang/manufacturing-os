// /api/ai/usage — the spend meter behind the AI settings dialog.
//
//   GET  ?orgId=…   → your current-month usage vs your cap:
//                     { spentUsd, capUsd, locked, percent, inputTokens,
//                       outputTokens, asks, calls, byOp, avgPromptTokens,
//                       monthLabel, canManageCaps }
//                     Controllers and cap managers additionally get
//                     { team: [...] } — every member's month spend — and
//                     { orgCapUsd } for the editor.
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
// a default raise used to delete the hold after it was written); a write
// the caller's own cap was decided from — the workspace default, their own
// override — is guarded by the figure it was decided from (a figure that
// changed underneath answers 409 and changes nothing); and after every
// write that can move the caller's own cap the route reads it again — one
// that ended above where it started is put back, audited `compensated`,
// and answered 409. What the response says about the setter's own cap
// (`selfHeldAtUsd`) is that re-read, never the intent.
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
 *  column's value as read — what a write decided from it is guarded by. */
async function readOrgDefault(orgId: string): Promise<
  { ok: true; capUsd: number; exists: boolean; stored: number | string | null; tableMissing: boolean } | { ok: false; error: string }
> {
  const { data, error } = await supabaseAdmin.from("ai_usage_limits")
    .select("monthly_cap_usd").eq("org_id", orgId).is("user_id", null).maybeSingle();
  if (error && !limitsTableMissing(error)) return { ok: false, error: error.message };
  const stored = (data as { monthly_cap_usd?: number | string | null } | null)?.monthly_cap_usd ?? null;
  const raw = Number(stored);
  return {
    ok: true,
    capUsd: stored !== null && Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MONTHLY_CAP_USD,
    exists: !!data, stored, tableMissing: !!error,
  };
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

/** GOV-10: put the caller's own cap back at `capUsd` — their own override,
 *  updated or written. The reason when it could not be. */
async function holdOwnCapAt(orgId: string, auth: Auth, capUsd: number): Promise<string | null> {
  const fields = { monthly_cap_usd: capUsd, updated_by: auth.userId, updated_at: new Date().toISOString() };
  const { data: own, error: readError } = await supabaseAdmin.from("ai_usage_limits")
    .select("id").eq("org_id", orgId).eq("user_id", auth.userId).maybeSingle();
  if (readError) return readError.message;
  const { error } = own
    ? await supabaseAdmin.from("ai_usage_limits").update(fields).eq("org_id", orgId).eq("user_id", auth.userId)
    : await supabaseAdmin.from("ai_usage_limits").insert({ org_id: orgId, user_id: auth.userId, ...fields });
  return error ? (error.message || "the write was refused") : null;
}

const fmtCap = (v: number) => (v === 0 ? "$0 (locked)" : `$${v}`);
/** A unique-index refusal: another request wrote the same row first. */
const isUniqueViolation = (e: { code?: string } | null) => e?.code === "23505";

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
 *  audit row are already written. */
async function notifyCapChange(orgId: string, auth: Auth, policy: CapabilityPolicy, change: {
  targetUserId: string | null; capUsd: number | null; previousCapUsd: number | null;
}) {
  const others = await otherCapsHolders(orgId, auth, policy);
  const recipients = new Set(others.ok ? others.uids : []);
  if (change.targetUserId) recipients.add(change.targetUserId);
  for (const uid of [...recipients]) if (sameUid(uid, auth.userId)) recipients.delete(uid);
  if (recipients.size === 0) return;
  const what = change.targetUserId ? "a person's monthly AI cap" : "the workspace's default monthly AI cap";
  const fmt = (v: number | null) => (v === null ? "the workspace default" : v === 0 ? "$0 (locked)" : `$${v}`);
  await supabaseAdmin.from("notifications").insert([...recipients].map((uid) => ({
    org_id: orgId,
    user_id: uid,
    kind: "ai_cap_changed",
    title: uid === change.targetUserId ? "Your monthly AI cap changed" : "A monthly AI cap changed",
    body: `${auth.name} changed ${what} from ${fmt(change.previousCapUsd)} to ${fmt(change.capUsd)}.`,
    link: "/intelligence/setup",
    resource_type: "ai_usage_limit",
    resource_id: orgId,
    actor_user_id: auth.userId,
    actor_name: auth.name,
    metadata: { targetUserId: change.targetUserId, capUsd: change.capUsd, previousCapUsd: change.previousCapUsd },
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
  // against after every write that can move it (their own override, or the
  // workspace default).
  let ownBeforeUsd: number | null = selfTarget ? previousCapUsd : null;
  if (!targetUserId) {
    ownBeforeUsd = await readOwnCap(orgId, auth);
    if (ownBeforeUsd === null) {
      return bad("Couldn't read your own cap, so the default was not changed — AI caps can't be read right now.", 503);
    }
  }

  // GOV-10: raising the WORKSPACE default must not raise the setter's own
  // cap. A setter whose cap follows the default (no override of their own)
  // is held where they are — an override at the previous default, written
  // and audited BEFORE the default moves. The default row was read above,
  // so the only step left after the hold is the write itself, and a write
  // that fails (or finds the default changed) takes the hold back out.
  // Raising it later takes another holder, like any other self-raise. A
  // sole holder is not held: they follow the default like everyone else.
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
      const { error: pinError } = await supabaseAdmin.from("ai_usage_limits").insert({
        org_id: orgId, user_id: auth.userId, monthly_cap_usd: previousCapUsd,
        updated_by: auth.userId, updated_at: new Date().toISOString(),
      });
      if (pinError) {
        return bad(
          `Couldn't hold your own cap at its current figure, so the default was not raised: ${pinError.message}`,
          isUniqueViolation(pinError) ? 409 : 500,
        );
      }
      pinnedSelfAtUsd = previousCapUsd;
      await auditCapChange(orgId, auth, { targetUserId: auth.userId, capUsd: previousCapUsd, previousCapUsd, heldOnDefaultRaise: true });
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
    const { error } = await supabaseAdmin.from("ai_usage_limits").insert({ org_id: orgId, user_id: targetUserId, ...fields });
    saveError = error;
  }
  if (saveError || conflict) {
    conflict = conflict || isUniqueViolation(saveError);
    const why = saveError?.message || "the cap changed while this was being saved";
    // The audit row already says it happened: say it did not.
    if (soleHolder) await auditCapChange(orgId, auth, { ...details, notApplied: true, error: why });
    // The setter's hold was written for a default raise that did not happen:
    // take it back out (only as written — a figure someone has changed since
    // is theirs), and say so on the log.
    if (pinnedSelfAtUsd !== null) {
      const { error: undoError } = await supabaseAdmin.from("ai_usage_limits").delete()
        .eq("org_id", orgId).eq("user_id", auth.userId).eq("monthly_cap_usd", pinnedSelfAtUsd);
      await auditCapChange(orgId, auth, {
        targetUserId: auth.userId, capUsd: pinnedSelfAtUsd, previousCapUsd: pinnedSelfAtUsd, heldOnDefaultRaise: true,
        ...(undoError ? { defaultNotRaised: true, holdKept: undoError.message } : { notApplied: true }), error: why,
      });
    }
    if (conflict) {
      return bad(
        targetUserId
          ? "That cap changed while you were saving it (another change landed at the same time), so nothing was changed — reload the caps and try again."
          : "The workspace default changed while you were saving it (another change landed at the same time), so nothing was changed — reload the caps and try again.",
        409, { conflict: true },
      );
    }
    return bad(`Couldn't save the cap: ${why}`, 500);
  }

  if (!soleHolder) await auditCapChange(orgId, auth, details);

  // GOV-10: every write that can move the caller's own cap is checked by
  // reading it again. One that ended ABOVE where it started — another
  // change took the hold out between this request's steps — is put back at
  // the starting figure and answered 409 (unless the caller is the sole
  // holder, whose raise needs nobody). What the response says about the
  // setter's own cap is this re-read, never the intent.
  let ownAfterUsd: number | null = null;
  if (!targetUserId || selfTarget) {
    ownAfterUsd = await readOwnCap(orgId, auth);
    if (ownAfterUsd !== null && ownBeforeUsd !== null && ownAfterUsd > ownBeforeUsd && !soleHolder) {
      const v = await soleHolderVerdict();
      if (!(v.ok && v.sole)) {
        const holdError = await holdOwnCapAt(orgId, auth, ownBeforeUsd);
        await auditCapChange(orgId, auth, {
          targetUserId: auth.userId, capUsd: ownBeforeUsd, previousCapUsd: ownAfterUsd, compensated: true,
          ...(holdError ? { notApplied: true, error: holdError } : {}),
        });
        const ownNowUsd = await readOwnCap(orgId, auth);
        await notifyCapChange(orgId, auth, caps.policy, { targetUserId, capUsd, previousCapUsd });
        const saved = targetUserId ? "Your cap was saved" : `The default monthly cap is now ${fmtCap(capUsd)}`;
        const moved = `${saved}, but your own cap rose to ${fmtCap(ownAfterUsd)} while it was being saved — another cap change landed at the same time`;
        return bad(
          holdError
            ? `${moved}, and it could not be put back at ${fmtCap(ownBeforeUsd)} (${holdError}). Tell another person who manages AI caps.`
            : `${moved} — so it was put back at ${fmtCap(ownBeforeUsd)}. Nobody raises their own cap; reload the caps, and ask another person who manages AI caps if yours should be higher.`,
          holdError ? 500 : 409,
          { conflict: true, compensated: true, capUsd, ...(ownNowUsd !== null ? { selfCapUsd: ownNowUsd } : {}) },
        );
      }
    }
  }

  await notifyCapChange(orgId, auth, caps.policy, { targetUserId, capUsd, previousCapUsd });

  return NextResponse.json({
    ok: true, capUsd, locked: capUsd === 0,
    // The setter was held on a default raise: where their cap reads NOW.
    ...(pinnedSelfAtUsd !== null && ownAfterUsd !== null ? { selfHeldAtUsd: ownAfterUsd } : {}),
    // GOV-10: said, not silent — the setter's own cap moved with no second
    // signature because nobody else holds the capability.
    ...(soleHolder ? { soleHolder: true } : {}),
  });
}
