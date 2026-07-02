// lib/accessRecert.ts
//
// Access recertification — the periodic "does everyone on this list still need
// access?" control. On a cadence, the library's owner / Admin / DocCtrl reviews
// who has access (from the library ACL) and attests it's still appropriate; the
// attestation snapshots the access list for the record and resets the clock.

import { supabase } from "@/lib/supabase";
import { notify } from "@/lib/inAppNotifications";
import { logAuditAction } from "@/lib/audit";
import { getOrgControllers } from "@/lib/ownership";
import type { RecertPolicy, AccessControl, AccessRule } from "@/types/schema";

const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)));
const todayISO = () => new Date().toISOString().slice(0, 10);

export type RecertStatus = "none" | "current" | "due_soon" | "overdue";

export function computeNextRecertDate(fromISO: string, intervalMonths: number): string {
  const d = new Date(fromISO);
  d.setMonth(d.getMonth() + intervalMonths);
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

// ── The current access list (from the library ACL allow-rules) ────────────────

export interface AccessGrant { subjectType: string; subjectId: string; subjectName: string; actions: string[]; expiresAt: string | null }

export async function listAccessGrants(orgId: string, libraryId: string): Promise<AccessGrant[]> {
  const { data } = await supabase.from("libraries").select("acl").eq("id", libraryId).maybeSingle();
  const acl = (data?.acl as AccessControl | null) ?? null;
  const allows = (acl?.rules ?? []).filter((r) => (r as AccessRule).effect === "allow") as AccessRule[];
  const userIds = uniq(allows.filter((r) => r.subject.type === "user").map((r) => r.subject.id));
  const nameMap = new Map<string, string>();
  if (userIds.length) {
    const { data: us } = await supabase.from("org_members").select("uid, display_name, email").eq("org_id", orgId).in("uid", userIds);
    for (const u of (us ?? []) as Array<Record<string, unknown>>) nameMap.set(u.uid as string, (u.display_name as string) || (u.email as string) || (u.uid as string));
  }
  return allows.map((r) => ({
    subjectType: r.subject.type,
    subjectId: r.subject.id,
    subjectName: r.subject.type === "user" ? (nameMap.get(r.subject.id) || r.subject.id) : r.subject.id,
    actions: r.actions ?? [],
    expiresAt: r.expiresAt ? String(r.expiresAt) : null,
  }));
}

// ── Policy + attestation ─────────────────────────────────────────────────────

export async function setRecertPolicy(input: {
  libraryId: string; orgId: string; policy: RecertPolicy | null; actorId?: string | null; actorName?: string | null;
}): Promise<void> {
  const next = input.policy?.enabled && input.policy.intervalMonths
    ? computeNextRecertDate(new Date().toISOString(), input.policy.intervalMonths)
    : null;
  await supabase.from("libraries").update({ recert_policy: input.policy, next_recertification_date: next, recert_notified_at: null }).eq("id", input.libraryId);
  await supabase.from("access_recertification_events").insert({
    org_id: input.orgId, library_id: input.libraryId, action: "policy_set",
    next_recertification_date: next, note: null, performed_by: input.actorId ?? null, performed_by_name: input.actorName ?? null,
  });
  await logAuditAction({ action: input.policy ? "ACCESS_RECERT_POLICY_SET" : "ACCESS_RECERT_POLICY_CLEARED", resourceType: "library", resourceId: input.libraryId, orgId: input.orgId, userId: input.actorId ?? "", details: { policy: input.policy } }).catch(() => {});
}

/** Record an access recertification: snapshot the current access list, reset the
 *  clock, and log it. The reviewer prunes access via the existing Permissions UI
 *  first, then attests here. */
export async function recertifyAccess(input: {
  libraryId: string; orgId: string; note?: string; actorId?: string | null; actorName?: string | null;
}): Promise<{ grantCount: number; nextDate: string | null }> {
  const grants = await listAccessGrants(input.orgId, input.libraryId);
  const { data: lib } = await supabase.from("libraries").select("recert_policy").eq("id", input.libraryId).maybeSingle();
  const policy = (lib?.recert_policy as RecertPolicy | null) ?? null;
  const now = new Date().toISOString();
  const nextDate = policy?.enabled && policy.intervalMonths ? computeNextRecertDate(now, policy.intervalMonths) : null;

  await supabase.from("libraries").update({ last_recertified_at: now, last_recertified_by: input.actorId ?? null, next_recertification_date: nextDate, recert_notified_at: null }).eq("id", input.libraryId);
  await supabase.from("access_recertification_events").insert({
    org_id: input.orgId, library_id: input.libraryId, action: "recertified",
    grants_snapshot: grants, grant_count: grants.length, note: input.note ?? null,
    next_recertification_date: nextDate, performed_by: input.actorId ?? null, performed_by_name: input.actorName ?? null,
  });
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
export async function listMyDueRecerts(orgId: string, uid: string): Promise<MyDueRecert[]> {
  if (!uid) return [];
  const { data: me } = await supabase.from("org_members").select("role").eq("org_id", orgId).eq("uid", uid).maybeSingle();
  const isController = me?.role === "Admin" || me?.role === "DocCtrl";
  const { data } = await supabase.from("libraries")
    .select("id, name, next_recertification_date, owner_user_id")
    .eq("org_id", orgId).not("next_recertification_date", "is", null).lte("next_recertification_date", todayISO());
  const libs = (data ?? []) as Array<Record<string, unknown>>;
  return libs
    .filter((l) => isController || (l.owner_user_id as string | null) === uid)
    .map((l) => ({ libraryId: l.id as string, name: (l.name as string) || "Library", nextDate: (l.next_recertification_date as string | null) ?? null, overdue: true }));
}
