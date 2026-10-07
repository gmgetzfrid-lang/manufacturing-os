// /api/ai/usage — the spend meter behind the AI settings dialog.
//
//   GET  ?orgId=…   → your current-month usage vs your cap:
//                     { spentUsd, capUsd, locked, percent, inputTokens,
//                       outputTokens, asks, calls, byOp, avgPromptTokens,
//                       monthLabel, canManageCaps }
//                     Controllers and cap managers additionally get
//                     { team: [...] } — every member's month spend (or
//                     { teamUnavailable: reason } when the team ledger
//                     cannot be summed) — and
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
// where it was, as a personal override, in the same change). A SOLE holder
// — nobody else active holds ai.manage_caps, as in a one-person workspace —
// has no second signature to ask for, so their own raise goes through,
// audited `soleHolder: true` and said in the response (DEC-73 item 5) —
// that audit row is written FIRST and checked, so a raise it cannot record
// is not made. The target is a uuid in any spelling Postgres accepts; the
// route uses the uid the database returns, never the request's spelling,
// so `{ userId: <your own uid in upper case> }` is still your own cap.
//
// GOV-15: a cap change is ONE database transaction — ai_cap_change
// (migration 20261173, lib/ai/capChange.ts) takes the workspace's
// cap-change lock and the rows it reads, decides the ban against the
// figures it locked, writes and audits. Two changes in flight therefore run
// one after the other, each deciding from what the other committed; the
// route reads nothing back and puts nothing back. Inside that lock a
// holder's self-clear that is not a raise is allowed. Until 20261173 is
// pasted the same change runs app-side — the same sequential answers,
// notices and audit rows, without the lock (said once in the server log):
// there a holder's own self-clear stays refused while another holder exists.
//
// Every change is audited and notifies the other holders; a change to one
// person's cap notifies that person too (the members who follow the default
// are not told one by one when it moves), and names whose cap it is. A
// request that changes nothing — clearing an override that is not there
// (your own included), a figure the cap already has — answers
// `unchanged: true`, and is neither audited nor told. A person who
// follows the default given its figure as their own is a change (the
// default no longer moves them), said as that (`pinnedAtDefault`, in the
// answer and the notice); so is the hold a default raise writes for its
// setter, which the default's notice names (`heldSelfAtUsd`).
// A cap table that cannot be read refuses (503) — the team
// view and the "previous figure" never fall back to $10. A team ledger that
// cannot be summed (an outage, or past the 100,000-row read ceiling) leaves
// the viewer's own meter and the default's editor up and says the team view
// is unavailable (`teamUnavailable`), never "$0.00" per person.
//
// Reads are service-role only: ai_usage_events and ai_usage_limits have RLS
// with zero client policies, so this route is the only window into them.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getMonthUsage, getMonthUsageByUser, getCapUsd, DEFAULT_MONTHLY_CAP_USD, capIsLocked, displayCapUsd, LOCKED_CAP_USD,
  AiUsageUnavailableError, type MonthUsage,
} from "@/lib/ai/usageServer";
import { GovernedCallError } from "@/lib/ai/gateError";
import {
  canonicalUuid, sameUid, limitsTableMissing, auditCapChange, callCapChangeFunction, applyCapChangeAppSide,
  sayAppSideOnce, type CapChangeOutcome, type CapChangeRequest,
} from "@/lib/ai/capChange";
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
type Roster = { ok: true; uids: string[] } | { ok: false; error: string };
async function otherCapsHolders(orgId: string, auth: Auth, policy: CapabilityPolicy): Promise<Roster> {
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
    // GOV-3: getMonthUsage floors a locked member's month at LOCKED_CAP_USD
    // so the legacy `cap > 0 && spent >= cap` gates refuse; that floor is a
    // device for those gates, not money — the meter shows what was spent.
    spentUsd: capIsLocked(capUsd) && mine.spentUsd <= LOCKED_CAP_USD ? 0 : mine.spentUsd,
    capUsd: displayCapUsd(capUsd),
    locked: capIsLocked(capUsd),
    percent: usagePercent(mine.spentUsd, capUsd),
    monthLabel: monthLabel(),
    canManageCaps,
  };

  if (auth.isController || canManageCaps) {
    // GOV-4 / GOV-1: a team ledger that cannot be summed — an outage since
    // the viewer's own read, or more rows this month than the read ceiling
    // (getMonthUsageByUser) — is said as that: the team view is unavailable
    // (`teamUnavailable`, the reason), never "$0.00" per person, and the
    // viewer's own meter (read above) and the default's editor stay up.
    let byUser: Map<string, MonthUsage> | null = null;
    try {
      byUser = await getMonthUsageByUser(orgId);
    } catch (e) {
      if (!(e instanceof GovernedCallError)) throw e;
      payload.teamUnavailable = e instanceof AiUsageUnavailableError ? e.detail : e.message;
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
    // GOV-4: a member list that cannot be read is said the way an
    // unsummable ledger is (`teamUnavailable`) — never an empty team, which
    // reads as nobody having spent anything.
    if (membersRes.error) {
      payload.teamUnavailable ??= `the member list can't be read (${membersRes.error.message})`;
      return NextResponse.json(payload);
    }
    if (byUser === null) return NextResponse.json(payload);
    const spendByUser = byUser;
    payload.team = members
      .map((m) => {
        const u = spendByUser.get(m.uid);
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

/** Bell notice to every OTHER holder of ai.manage_caps, and — for a change
 *  to one person's cap — to that person (GOV-10 done-when 4). A change to
 *  the workspace default goes to the other holders only: the members who
 *  follow it are not told one by one. A request that changes nothing sends
 *  none. Best-effort: the change and its audit row are already written.
 *  `pinnedAtDefault`: a person who followed the default was given its figure
 *  as their own — the figure is the same, but the default no longer moves
 *  it, and the notice says that rather than "from $10 to $10".
 *  `heldSelfAtUsd`: a default raise held the actor's own cap at that figure
 *  as a personal override (the same transition as a pin at the default:
 *  the default no longer moves it), so the default's notice says so.
 *  `targetName`: the person whose cap it is, named in the notice (the
 *  actor's own cap reads "their own"); "a person's" only when the member
 *  row carries no name. `holdKept` (app-side only, GOV-15): a default raise
 *  of the actor's did not land and the hold it wrote could not be taken
 *  back out (the reason), so they no longer follow the default — told to
 *  the other holders. */
async function notifyCapChange(orgId: string, auth: Auth, others: Roster, change: {
  targetUserId: string | null; capUsd: number | null; previousCapUsd: number | null;
  holdKept?: string; pinnedAtDefault?: boolean; heldSelfAtUsd?: number | null; targetName?: string | null;
}) {
  const recipients = new Set(others.ok ? others.uids : []);
  if (change.targetUserId) recipients.add(change.targetUserId);
  for (const uid of [...recipients]) if (sameUid(uid, auth.userId)) recipients.delete(uid);
  if (recipients.size === 0) return;
  const what = !change.targetUserId ? "the workspace's default monthly AI cap"
    : sameUid(change.targetUserId, auth.userId) ? "their own monthly AI cap"
      : `${change.targetName ? `${change.targetName}'s` : "a person's"} monthly AI cap`;
  const fmt = (v: number | null) => (v === null ? "the workspace default" : v === 0 ? "$0 (locked)" : `$${v}`);
  const held = typeof change.heldSelfAtUsd === "number"
    ? `; ${auth.name}'s own cap stays at ${fmt(change.heldSelfAtUsd)} as a personal cap, so a change to the default no longer moves it`
    : "";
  const own = `${auth.name}'s own monthly AI cap`;
  const body = change.holdKept
    ? `${own} stays held at ${fmt(change.capUsd)}: a raise of the workspace default by them did not land, and the hold it wrote stays — ${change.holdKept}. They no longer follow the default; if they should, clear their cap in AI settings.`
    : change.pinnedAtDefault
      ? `${auth.name} set ${what} to ${fmt(change.capUsd)} — the figure of the workspace default it followed until now — so a change to the default no longer moves it.`
      : `${auth.name} changed ${what} from ${fmt(change.previousCapUsd)} to ${fmt(change.capUsd)}${held}.`;
  const title = (uid: string) => change.holdKept ? "A monthly AI cap is still held"
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
      ...(change.holdKept ? { holdKept: change.holdKept } : {}),
      ...(change.pinnedAtDefault ? { pinnedAtDefault: true } : {}),
      ...(typeof change.heldSelfAtUsd === "number" ? { heldSelfAtUsd: change.heldSelfAtUsd } : {}),
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
  // Who the person is, for the notices (GOV-10: a notice names whose cap changed).
  let targetName: string | null = null;
  if (rawTarget) {
    const asUuid = canonicalUuid(rawTarget);
    if (!asUuid) return bad("userId must be a workspace member's id.");
    const { data: target } = await supabaseAdmin
      .from("org_members").select("uid, display_name, email")
      .eq("org_id", orgId).eq("uid", asUuid).eq("status", "active")
      .maybeSingle();
    if (!target) return bad("That person isn't an active member of this workspace.", 404);
    const t = target as { uid: string; display_name?: string | null; email?: string | null };
    targetUserId = String(t.uid);
    targetName = t.display_name || t.email || null;
  }

  // Clearing a per-person override — the person falls back to the default.
  const clear = targetUserId !== null && body.capUsd === null;
  const capUsd = clear ? null : Number(body.capUsd);
  if (!clear && (body.capUsd === null || body.capUsd === undefined || !Number.isFinite(capUsd) || (capUsd as number) < 0 || (capUsd as number) > 10000)) {
    return bad("capUsd must be a number between 0 and 10000 (0 locks AI for that person until it is raised).");
  }

  // The other holders: the second signature a self-raise needs (a roster
  // that cannot be read is never "nobody else" — the change refuses only
  // where it needs the answer), and who the notices go to.
  const others = await otherCapsHolders(orgId, auth, caps.policy);
  const change: CapChangeRequest = {
    orgId, actorId: auth.userId, targetUserId, capUsd, clear,
    otherHolders: others.ok ? others.uids.length > 0 : null,
    rosterError: others.ok ? null : others.error,
  };

  // GOV-15: one transaction (20261173); app-side until it is pasted.
  let outcome: CapChangeOutcome;
  const viaFunction = await callCapChangeFunction(change);
  if (viaFunction.kind === "failed") {
    // The transaction rolled back: nothing changed, nobody is told.
    return bad(`Couldn't save the cap: ${viaFunction.error}`, 500);
  }
  if (viaFunction.kind === "missing") {
    sayAppSideOnce();
    outcome = await applyCapChangeAppSide(change);
  } else {
    outcome = viaFunction.outcome;
    // A row the log refused inside the transaction did not stop the change
    // (only a sole holder's own raise is refused unrecorded): tried again
    // now that it has landed, best-effort like every other change's.
    if (outcome.kind === "changed") for (const details of outcome.auditRetry) await auditCapChange(orgId, auth.userId, details);
  }

  if (outcome.kind === "refused") {
    if (outcome.holdKept) {
      await notifyCapChange(orgId, auth, others, {
        targetUserId: auth.userId, capUsd: outcome.holdKept.atUsd, previousCapUsd: outcome.holdKept.atUsd, holdKept: outcome.holdKept.reason,
      });
    }
    return bad(outcome.error, outcome.status, outcome.extra ?? {});
  }
  if (outcome.kind === "unchanged") {
    // Nothing changed — nothing is audited or told, and the answer says so.
    return NextResponse.json(clear
      ? { ok: true, cleared: false, unchanged: true }
      : { ok: true, capUsd, locked: capUsd === 0, unchanged: true });
  }
  if (clear) {
    await notifyCapChange(orgId, auth, others, { targetUserId, capUsd: null, previousCapUsd: outcome.previousCapUsd, targetName });
    return NextResponse.json({ ok: true, cleared: true, ...(outcome.soleHolder ? { soleHolder: true } : {}) });
  }
  // The change has landed: the other holders and the person whose cap moved
  // are told. A hold written for a default raise moved the setter off the
  // default (as a pin at its figure does), so the default's notice says so.
  await notifyCapChange(orgId, auth, others, {
    targetUserId, capUsd, previousCapUsd: outcome.previousCapUsd, targetName,
    ...(outcome.pinnedAtDefault ? { pinnedAtDefault: true } : {}),
    ...(outcome.heldSelfAtUsd !== null ? { heldSelfAtUsd: outcome.heldSelfAtUsd } : {}),
  });
  return NextResponse.json({
    ok: true, capUsd, locked: capUsd === 0,
    // A person who followed the default was given its figure as their own:
    // the same figure, but the default no longer moves it (said, not silent).
    ...(outcome.pinnedAtDefault ? { pinnedAtDefault: true } : {}),
    // The setter was held on a raise of the default they followed.
    ...(outcome.heldSelfAtUsd !== null ? { selfHeldAtUsd: outcome.heldSelfAtUsd } : {}),
    // GOV-10: said, not silent — the setter's own cap moved with no second
    // signature because nobody else holds the capability.
    ...(outcome.soleHolder ? { soleHolder: true } : {}),
  });
}
