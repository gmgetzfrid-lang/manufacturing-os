// lib/accessRecert.ts
//
// Access recertification — the periodic "does everyone on this list still need
// access?" control. On a cadence, the library's owner / Admin / DocCtrl reviews
// who has access (from the library ACL) and attests it's still appropriate; the
// attestation snapshots the access list for the record and resets the clock.
// DEL-6: the owner is notified AND can open the flow (the library page admits
// the owner alongside controllers); the write is checked, so a refused
// attestation surfaces instead of silently no-oping.
// ALOG-2 (admin-and-org P9): the attestation RECORD is checked too, and the
// database binds it (20261188): only the library's owner or a controller
// (Admin / DocCtrl by the role collection) may write one, naming themselves,
// and nobody may change or delete one. The people the scan notifies are
// exactly the people who may record the review.

import { supabase } from "@/lib/supabase";
import { normalizeRoles } from "@/lib/roleCapabilities";
import { notify } from "@/lib/inAppNotifications";
import { logAuditAction } from "@/lib/audit";
import { getOrgControllers } from "@/lib/ownership";
import type { RecertPolicy, AccessControl, AccessRule } from "@/types/schema";

const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)));
const todayISO = () => new Date().toISOString().slice(0, 10);

export type RecertStatus = "none" | "current" | "due_soon" | "overdue";

export function computeNextRecertDate(fromISO: string, intervalMonths: number): string {
  const d = new Date(fromISO);
  // Clamp to the target month's last day — naive setMonth overflows month-end
  // dates (Aug 31 + 6mo would land on Mar 3 instead of Feb 28).
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + intervalMonths);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

export function recertStatusFor(nextDate?: string | null, leadDays = 30): RecertStatus {
  if (!nextDate) return "none";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(`${nextDate.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(due.getTime())) return "none";
  const days = Math.ceil((due.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return "overdue";
  if (days <= leadDays) return "due_soon";
  return "current";
}

export function daysUntilRecert(nextDate?: string | null): number | null {
  if (!nextDate) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(`${nextDate.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(due.getTime())) return null;
  return Math.ceil((due.getTime() - today.getTime()) / 86_400_000);
}

export function describeRecert(p?: RecertPolicy | null): string {
  if (!p || !p.enabled || !p.intervalMonths) return "No recertification cadence";
  return `Recertify every ${p.intervalMonths} month${p.intervalMonths === 1 ? "" : "s"}`;
}

// ── The EFFECTIVE access list (RET-3) ────────────────────────────────────────
// The attestation used to snapshot `libraries.acl` allow-rules — a list that is
// not the access list. Enforcement is node_visible(): a library whose
// visibility is null/'normal' is readable by EVERY active member; every
// Admin/DocCtrl reads everything; the EFFECTIVE owner reads their library
// (user_is_effective_owner, 20261042: owner_user_id when that person is an
// active member, else the supervisor of owner_team_id); and only then does
// the chain-merged `acl_index` (not `acl`) decide through
// acl_subject_in_bucket (20260708), which has users / roles / teams arms and
// NO org arm — an `orgs` bucket admits nobody at the database, so it admits
// nobody here either. An explicit deny of read/discover wins. The population
// attested here is resolved by the same rules, expanded to PEOPLE (a role
// rule admits the members holding that role additively, a team rule its
// members), with expired rules split out — they may still sit in the index
// until the nightly rebuild, which is exactly what "expired, still listed"
// means.

export type AccessGrantSource = "default" | "controller" | "owner" | "explicit" | "inherited";
export interface AccessGrant {
  subjectType: string; subjectId: string; subjectName: string; actions: string[]; expiresAt: string | null;
  /** Why this person has access (every reason that applies). */
  via?: string[];
  source?: AccessGrantSource;
  status?: "active" | "expired";
}
export interface EffectiveAccess {
  /** People who can read the library today. */
  live: AccessGrant[];
  /** Allow-rules whose expiresAt has passed — reported separately, never attested as current. */
  expired: AccessGrant[];
  /** False when any read the resolution needs failed; recertifyAccess refuses to attest. */
  complete: boolean;
  issues: string[];
  visibility: string | null;
}

type MemberRow = { uid: string; display_name: string | null; email: string | null; role: string | null; roles: string[] | null };
type BucketSide = { users?: Record<string, string[]>; roles?: Record<string, string[]>; teams?: Record<string, string[]>; orgs?: Record<string, string[]> } | null | undefined;

const ruleExpired = (r: AccessRule, nowMs: number) => !!r.expiresAt && new Date(String(r.expiresAt)).getTime() <= nowMs;
const bucketIds = (side: BucketSide, kind: "users" | "roles" | "teams"): Map<string, Set<string>> => {
  const out = new Map<string, Set<string>>();
  const m = side?.[kind] ?? {};
  for (const [action, ids] of Object.entries(m)) {
    for (const id of ids ?? []) {
      const s = out.get(id) ?? new Set<string>();
      s.add(action); out.set(id, s);
    }
  }
  return out;
};

export async function listAccessGrantsDetailed(orgId: string, libraryId: string, nowMs: number = Date.now()): Promise<EffectiveAccess> {
  const issues: string[] = [];
  const [{ data: lib, error: libErr }, { data: members, error: memErr }, { data: teamRows, error: teamErr }, { data: teams, error: supErr }] = await Promise.all([
    supabase.from("libraries").select("visibility, acl, acl_index, owner_user_id, owner_team_id").eq("id", libraryId).maybeSingle(),
    supabase.from("org_members").select("uid, display_name, email, role, roles").eq("org_id", orgId).eq("status", "active"),
    supabase.from("team_members").select("team_id, uid").eq("org_id", orgId),
    supabase.from("teams").select("id, supervisor_user_id").eq("org_id", orgId),
  ]);
  if (libErr) issues.push(`library: ${libErr.message}`);
  if (!lib && !libErr) issues.push("library: not found");
  if (memErr) issues.push(`members: ${memErr.message}`);
  if (teamErr) issues.push(`teams: ${teamErr.message}`);
  if (supErr) issues.push(`team supervisors: ${supErr.message}`);
  if (issues.length) return { live: [], expired: [], complete: false, issues, visibility: null };

  const visibility = (lib?.visibility as string | null) ?? null;
  const acl = (lib?.acl as AccessControl | null) ?? null;
  const index = (lib?.acl_index as { allow?: BucketSide; deny?: BucketSide } | null) ?? null;
  const ownerId = (lib?.owner_user_id as string | null) ?? null;
  const ownerTeamId = (lib?.owner_team_id as string | null) ?? null;
  const people = ((members ?? []) as MemberRow[]);
  const byUid = new Map(people.map((m) => [m.uid, m]));
  const supervisorOf = new Map(((teams ?? []) as Array<{ id: string; supervisor_user_id: string | null }>).map((t) => [t.id, t.supervisor_user_id ?? null]));
  const nameOf = (uid: string) => { const m = byUid.get(uid); return m ? (m.display_name || m.email || uid) : uid; };
  const holdsRole = (m: MemberRow, role: string) => (normalizeRoles(m.roles, m.role) as string[]).includes(role);
  const teamMembers = new Map<string, string[]>();
  for (const t of (teamRows ?? []) as Array<{ team_id: string; uid: string }>) {
    teamMembers.set(t.team_id, [...(teamMembers.get(t.team_id) ?? []), t.uid]);
  }

  // Accumulate per person: actions ∪, every reason recorded.
  const live = new Map<string, { actions: Set<string>; via: string[]; source: AccessGrantSource }>();
  const admit = (uid: string, actions: Iterable<string>, via: string, source: AccessGrantSource) => {
    if (!byUid.has(uid)) return; // only active members can read anything
    const cur = live.get(uid) ?? { actions: new Set<string>(), via: [], source };
    for (const a of actions) cur.actions.add(a);
    cur.via.push(via);
    live.set(uid, cur);
  };

  // 1. Controllers and the EFFECTIVE owner read regardless of the ACL
  //    (node_visible returns before the index is consulted). The owner is
  //    resolved exactly as user_is_effective_owner does: owner_user_id when
  //    that person is an active member; otherwise, for a team-owned library,
  //    the team's supervisor (when active). A departed owner admits nobody.
  for (const m of people) if (normalizeRoles(m.roles, m.role).some((r) => r === "Admin" || r === "DocCtrl")) admit(m.uid, ["read"], "Admin/DocCtrl", "controller");
  if (ownerId && byUid.has(ownerId)) admit(ownerId, ["read"], "library owner", "owner");
  else if (ownerTeamId) {
    const supervisor = supervisorOf.get(ownerTeamId) ?? null;
    if (supervisor) admit(supervisor, ["read"], "team supervisor (effective owner)", "owner");
  }
  // 2. Default visibility admits every active member.
  const isDefault = visibility == null || visibility === "normal";
  if (isDefault) for (const m of people) admit(m.uid, ["read"], "default visibility (open to every active member)", "default");

  // 3. Rules: expired ones are split out; live ones are attributed. The
  //    rule-level expiry is the only place expiry lives (the index has none).
  const rules = ((acl?.rules ?? []) as AccessRule[]).filter((r) => r.effect === "allow");
  const expired: AccessGrant[] = [];
  const expiredSubjects = new Set<string>();
  const liveSubjects = new Set<string>();
  for (const r of rules) {
    const key = `${r.subject.type}:${r.subject.id}`;
    if (ruleExpired(r, nowMs)) {
      expiredSubjects.add(key);
      expired.push({
        subjectType: r.subject.type, subjectId: r.subject.id,
        subjectName: r.subject.type === "user" ? nameOf(r.subject.id) : r.subject.id,
        actions: r.actions ?? [], expiresAt: String(r.expiresAt), source: "explicit", status: "expired",
        via: ["expired rule — still listed in the access index until the nightly rebuild"],
      });
    } else liveSubjects.add(key);
  }

  // 4. The index the database reads (any allow action lets the row through).
  //    Only the three arms acl_subject_in_bucket has: users, roles, teams. An
  //    `orgs` bucket is written by the client-side index builder but no
  //    database rule ever reads it, so it is NOT expanded — listing every
  //    member the database refuses would be the over-attestation twin of
  //    the finding.
  const allow = index?.allow ?? null;
  const explain = (key: string) => liveSubjects.has(key) ? "explicit" as const : expiredSubjects.has(key) ? null : "inherited" as const;
  for (const [uid, actions] of bucketIds(allow, "users")) {
    const src = explain(`user:${uid}`); if (!src) continue;
    admit(uid, actions, "user rule", src);
  }
  for (const [role, actions] of bucketIds(allow, "roles")) {
    const src = explain(`role:${role}`); if (!src) continue;
    for (const m of people) if (holdsRole(m, role)) admit(m.uid, actions, `role rule: ${role}`, src);
  }
  for (const [teamId, actions] of bucketIds(allow, "teams")) {
    const src = explain(`team:${teamId}`); if (!src) continue;
    for (const uid of teamMembers.get(teamId) ?? []) admit(uid, actions, `team rule: ${teamId}`, src);
  }

  // 5. An explicit deny of read/discover refuses everyone but controllers
  //    and the owner (DEC-7: an owner outranks a stray deny).
  const denied = new Set<string>([
    ...(index?.deny?.users?.read ?? []), ...(index?.deny?.users?.discover ?? []),
  ]);
  for (const uid of denied) {
    const cur = live.get(uid);
    if (cur && cur.source !== "controller" && cur.source !== "owner") live.delete(uid);
  }

  const grants: AccessGrant[] = [...live.entries()].map(([uid, g]) => ({
    subjectType: "user", subjectId: uid, subjectName: nameOf(uid),
    actions: [...g.actions], expiresAt: null, via: uniq(g.via), source: g.source, status: "active" as const,
  })).sort((a, b) => a.subjectName.localeCompare(b.subjectName));
  return { live: grants, expired, complete: true, issues: [], visibility };
}

/** The people who can read the library today (the EFFECTIVE population — see
 *  listAccessGrantsDetailed). Expired rules are not in this list. */
export async function listAccessGrants(orgId: string, libraryId: string): Promise<AccessGrant[]> {
  return (await listAccessGrantsDetailed(orgId, libraryId)).live;
}

// ── Policy + attestation ─────────────────────────────────────────────────────

/** ALOG-2 (fix pass 2): the authority rule is named only when the database
 *  refused on it (42501 — 20261188's INSERT policy). Any other failure (a
 *  timeout, a network error) is not an authority question, and telling an
 *  Admin that only an Admin can record it is the wrong answer. */
function recordRefusalWho(err: { code?: string | null } | null | undefined): string {
  return err?.code === "42501"
    ? " Only an Admin, a Document Controller or the library's owner can record it, naming themselves."
    : "";
}

export async function setRecertPolicy(input: {
  libraryId: string; orgId: string; policy: RecertPolicy | null; actorId?: string | null; actorName?: string | null;
}): Promise<void> {
  const next = input.policy?.enabled && input.policy.intervalMonths
    ? computeNextRecertDate(new Date().toISOString(), input.policy.intervalMonths)
    : null;
  // ALOG-2 (fix pass 2): the stored cadence is read CHECKED first, so a
  // refused record can put it back — a cadence in force with no history row
  // is the unrecorded change the event record exists to prevent.
  const { data: prior, error: priorErr } = await supabase
    .from("libraries")
    .select("recert_policy, next_recertification_date, recert_notified_at")
    .eq("id", input.libraryId)
    .maybeSingle();
  if (priorErr || !prior) {
    throw new Error(`The recertification cadence was NOT saved: the library could not be read (${priorErr?.message ?? "not found"}).`);
  }
  // OWN-14: checked write — a refused save must not produce a policy_set event.
  const { data: polRows, error: polErr } = await supabase
    .from("libraries")
    .update({ recert_policy: input.policy, next_recertification_date: next, recert_notified_at: null })
    .eq("id", input.libraryId)
    .select("id");
  if (polErr) throw new Error(polErr.message);
  if (!polRows || polRows.length === 0) {
    throw new Error("Recertification policy was NOT saved — you don't have authority over this library.");
  }
  // ALOG-2: the cadence's event row is checked. Since 20261188 only a
  // controller or the library's owner may write one, naming themselves; a
  // refusal is said, never reported as a recorded change — and (fix pass 2)
  // the library's previous cadence and dates are put back first, count-checked,
  // exactly as recertifyAccess puts back its attestation columns.
  const { error: evErr } = await supabase.from("access_recertification_events").insert({
    org_id: input.orgId, library_id: input.libraryId, action: "policy_set",
    next_recertification_date: next, note: null, performed_by: input.actorId ?? null, performed_by_name: input.actorName ?? null,
  });
  if (evErr) {
    const { data: backRows, error: backErr } = await supabase
      .from("libraries")
      .update({
        recert_policy: (prior.recert_policy as RecertPolicy | null) ?? null,
        next_recertification_date: (prior.next_recertification_date as string | null) ?? null,
        recert_notified_at: (prior.recert_notified_at as string | null) ?? null,
      })
      .eq("id", input.libraryId)
      .select("id");
    const putBack = !backErr && !!backRows && backRows.length > 0;
    throw new Error(putBack
      ? `The recertification cadence was NOT changed: its record was refused (${evErr.message}), so the library's previous cadence and dates were put back.${recordRefusalWho(evErr)}`
      : `The recertification cadence was saved on the library, but its record was refused (${evErr.message}) and the previous cadence could not be put back (${backErr?.message ?? "no row was updated"}) — the change is in force with no recertification-history record. Tell an Admin.${recordRefusalWho(evErr)}`);
  }
  await logAuditAction({ action: input.policy ? "ACCESS_RECERT_POLICY_SET" : "ACCESS_RECERT_POLICY_CLEARED", resourceType: "library", resourceId: input.libraryId, orgId: input.orgId, userId: input.actorId ?? "", details: { policy: input.policy } }).catch(() => {});
}

/** Record an access recertification: snapshot the current access list, reset the
 *  clock, and log it. The reviewer prunes access via the existing Permissions UI
 *  first, then attests here. */
export async function recertifyAccess(input: {
  libraryId: string; orgId: string; note?: string; actorId?: string | null; actorName?: string | null;
}): Promise<{ grantCount: number; nextDate: string | null }> {
  // RET-3: attest the EFFECTIVE population, and refuse to attest at all when
  // it could not be resolved — a snapshot signed against a partial list is
  // the false compliance record the finding describes.
  const effective = await listAccessGrantsDetailed(input.orgId, input.libraryId);
  if (!effective.complete) {
    throw new Error(`Recertification refused: the library's effective access list could not be resolved (${effective.issues.join("; ")}). Nothing was attested.`);
  }
  // ALOG-2: `grants` is the LIVE population only — rules whose expiresAt has
  // passed are in `effective.expired` and never counted or snapshotted as
  // current (RET-3), so grant_count and grants_snapshot exclude them.
  const grants = effective.live;
  // ALOG-2: the library row is read CHECKED — an unread cadence used to be
  // taken as "no cadence" and the attestation then cleared the next date.
  // The prior attestation columns are kept so a refused record can put them
  // back (below).
  const { data: lib, error: libErr } = await supabase
    .from("libraries")
    .select("recert_policy, last_recertified_at, last_recertified_by, next_recertification_date, recert_notified_at")
    .eq("id", input.libraryId)
    .maybeSingle();
  if (libErr || !lib) {
    throw new Error(`Recertification refused: the library could not be read (${libErr?.message ?? "not found"}). Nothing was attested.`);
  }
  const policy = (lib.recert_policy as RecertPolicy | null) ?? null;
  const now = new Date().toISOString();
  const nextDate = policy?.enabled && policy.intervalMonths ? computeNextRecertDate(now, policy.intervalMonths) : null;

  // OWN-14: checked — a refused attestation must not snapshot as recertified.
  const { data: certRows, error: certErr } = await supabase
    .from("libraries")
    .update({ last_recertified_at: now, last_recertified_by: input.actorId ?? null, next_recertification_date: nextDate, recert_notified_at: null })
    .eq("id", input.libraryId)
    .select("id");
  if (certErr) throw new Error(certErr.message);
  if (!certRows || certRows.length === 0) {
    throw new Error("Recertification was NOT recorded — you don't have authority over this library.");
  }
  // ALOG-2: the attestation record is the evidence, so its insert is
  // checked. Since 20261188 only a controller or the library's owner may
  // write it, naming themselves (performed_by = auth.uid()). Without it the
  // reset clock would claim a review nobody recorded, so the library's
  // attestation columns are put back before the refusal is said.
  const { error: evErr } = await supabase.from("access_recertification_events").insert({
    org_id: input.orgId, library_id: input.libraryId, action: "recertified",
    grants_snapshot: grants, grant_count: grants.length, note: input.note ?? null,
    next_recertification_date: nextDate, performed_by: input.actorId ?? null, performed_by_name: input.actorName ?? null,
  });
  if (evErr) {
    const { data: backRows, error: backErr } = await supabase
      .from("libraries")
      .update({
        last_recertified_at: (lib.last_recertified_at as string | null) ?? null,
        last_recertified_by: (lib.last_recertified_by as string | null) ?? null,
        next_recertification_date: (lib.next_recertification_date as string | null) ?? null,
        recert_notified_at: (lib.recert_notified_at as string | null) ?? null,
      })
      .eq("id", input.libraryId)
      .select("id");
    const putBack = !backErr && !!backRows && backRows.length > 0;
    throw new Error(putBack
      ? `Recertification was NOT recorded: the attestation record was refused (${evErr.message}). The library's recertification dates were put back.${recordRefusalWho(evErr)}`
      : `Recertification was NOT recorded: the attestation record was refused (${evErr.message}), and the library's recertification dates could not be put back (${backErr?.message ?? "no row was updated"}) — the library now shows a recertification that has no record. Tell an Admin.${recordRefusalWho(evErr)}`);
  }
  await logAuditAction({ action: "ACCESS_RECERTIFIED", resourceType: "library", resourceId: input.libraryId, orgId: input.orgId, userId: input.actorId ?? "", details: { grantCount: grants.length, note: input.note } }).catch(() => {});
  return { grantCount: grants.length, nextDate };
}

// ── Daily scan + inbox ───────────────────────────────────────────────────────

export async function scanAccessRecerts(orgId: string, opts?: { leadDays?: number; cooldownDays?: number }): Promise<number> {
  const leadDays = opts?.leadDays ?? 30;
  const cooldownDays = opts?.cooldownDays ?? 7;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + leadDays);
  const { data } = await supabase.from("libraries")
    .select("id, name, next_recertification_date, recert_notified_at, owner_user_id")
    .eq("org_id", orgId).not("next_recertification_date", "is", null).lte("next_recertification_date", cutoff.toISOString().slice(0, 10));
  const libs = (data ?? []) as Array<Record<string, unknown>>;
  if (!libs.length) return 0;

  const controllers = await getOrgControllers(orgId);
  const now = Date.now();
  const cooldownMs = cooldownDays * 86_400_000;
  let n = 0;
  for (const l of libs) {
    if (l.recert_notified_at && now - new Date(l.recert_notified_at as string).getTime() < cooldownMs) continue;
    const overdue = new Date(`${(l.next_recertification_date as string).slice(0, 10)}T00:00:00`).getTime() < now;
    const ownerId = (l.owner_user_id as string | null) ?? null;
    const targets = uniq([...(ownerId ? [ownerId] : []), ...controllers]);
    const name = (l.name as string) || "a library";
    const link = `/documents/${l.id as string}`;
    await Promise.all(targets.map((uid) =>
      notify({ orgId, userId: uid, kind: "access_recert_due", title: overdue ? `Access recert overdue: ${name}` : `Access recert due: ${name}`, body: "Review who has access to this library and recertify it.", link, resourceType: "library", resourceId: l.id as string })
    ));
    await supabase.from("libraries").update({ recert_notified_at: new Date().toISOString() }).eq("id", l.id as string);
    n++;
  }
  return n;
}

export interface MyDueRecert { libraryId: string; name: string; nextDate: string | null; overdue: boolean }

/** Libraries whose access recertification is due for the current user — the ones
 *  they own, plus (if they're Admin/DocCtrl) any that are due. */
export async function listMyDueRecerts(orgId: string, uid: string, opts?: { leadDays?: number }): Promise<MyDueRecert[]> {
  if (!uid) return [];
  // Same clock as scanAccessRecerts: include the lead window, so the inbox
  // and the bell agree — "due in N days" appears in both, flagged overdue
  // only once the date has actually passed.
  const leadDays = opts?.leadDays ?? 30;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + leadDays);
  const today = todayISO();
  const { data: me } = await supabase.from("org_members").select("role, roles").eq("org_id", orgId).eq("uid", uid).maybeSingle();
  const isController = normalizeRoles(me?.roles, me?.role).some((r) => r === "Admin" || r === "DocCtrl");
  const { data } = await supabase.from("libraries")
    .select("id, name, next_recertification_date, owner_user_id")
    .eq("org_id", orgId).not("next_recertification_date", "is", null)
    .lte("next_recertification_date", cutoff.toISOString().slice(0, 10));
  const libs = (data ?? []) as Array<Record<string, unknown>>;
  return libs
    .filter((l) => isController || (l.owner_user_id as string | null) === uid)
    .map((l) => {
      const next = ((l.next_recertification_date as string | null) ?? "").slice(0, 10);
      return {
        libraryId: l.id as string,
        name: (l.name as string) || "Library",
        nextDate: (l.next_recertification_date as string | null) ?? null,
        overdue: !!next && next <= today,
      };
    });
}
