// lib/accountsServer.ts - SERVER ONLY (service role). Who has an account.
//
// The rules:
//   - An account exists only because someone made it on purpose: an admin
//     added the person to a workspace, or a workspace was paid for (its
//     first admin). Nobody makes their own.
//   - One email is one person: emails are kept trimmed and lower case, and
//     an add finds the person by their sign-in email, never by a profile
//     field a person can edit.
//   - An account in no workspace (removed from the last one, or made by a
//     Microsoft sign-in nobody asked for) is deleted, with its profile.
//
// Every read here throws when it can't be answered: "no membership" is only
// ever said when the database answered it, never when a read failed.

import { supabaseAdmin } from "@/lib/supabaseAdmin";

/** An email as stored and compared: trimmed, lower case. */
export const normEmail = (e: unknown): string => String(e ?? "").trim().toLowerCase();
/** Good enough to be an address (the sign-in provider checks the rest). */
export const looksLikeEmail = (e: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;

export interface Membership {
  id: string;
  orgId: string;
  orgName: string | null;
  role: string;
  roles: string[] | null;
  status: string;
  email: string | null;
}

/** Every workspace membership of an account, any status. */
export async function membershipsOf(uid: string): Promise<Membership[]> {
  const { data, error } = await supabaseAdmin.from("org_members").select("id, org_id, role, roles, status, email").eq("uid", uid).limit(100);
  if (error) throw new Error(`Couldn't read the memberships: ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string; org_id: string; role: string; roles: string[] | null; status: string | null; email: string | null }>;
  const names = new Map<string, string>();
  const orgIds = [...new Set(rows.map((r) => r.org_id))];
  if (orgIds.length) {
    const { data: orgs } = await supabaseAdmin.from("orgs").select("id, name").in("id", orgIds);
    for (const o of (orgs ?? []) as Array<{ id: string; name: string | null }>) if (o.name) names.set(o.id, o.name);
  }
  return rows.map((r) => ({ id: r.id, orgId: r.org_id, orgName: names.get(r.org_id) ?? null, role: r.role, roles: r.roles, status: r.status ?? "inactive", email: r.email }));
}

/** An account nobody added: in no workspace (any status) and not the
 *  account a workspace was just paid for. */
export async function isStray(uid: string): Promise<boolean> {
  if ((await membershipsOf(uid)).length > 0) return false;
  const { data, error } = await supabaseAdmin.from("orgs").select("id").eq("created_by", uid).limit(1);
  if (error) throw new Error(`Couldn't read the workspaces: ${error.message}`);
  return (data ?? []).length === 0;
}

/** Delete a sign-in account; its profile goes with it. Logged. */
export async function deleteAccount(uid: string, why: string, by: { userId: string | null; email: string | null; orgId: string | null }, email: string | null): Promise<void> {
  const { error } = await supabaseAdmin.auth.admin.deleteUser(uid);
  if (error && !/not.?found/i.test(error.message)) throw new Error(`Couldn't delete the account: ${error.message}`);
  // The profile row goes with the account (foreign key); this covers a
  // database where it doesn't.
  await supabaseAdmin.from("users").delete().eq("id", uid).then(() => undefined, () => undefined);
  await supabaseAdmin.from("audit_logs").insert({
    action: "ACCOUNT_DELETED", resource_type: "user", resource_id: uid, org_id: by.orgId, user_id: by.userId, user_email: by.email,
    details: { why, email },
  }).then(() => undefined, () => undefined);
}

/** The sign-in account with this email, if there is one. */
export async function accountByEmail(email: string): Promise<{ id: string; email: string } | null> {
  const target = normEmail(email);
  const perPage = 200;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Couldn't read the accounts: ${error.message}`);
    const users = data?.users ?? [];
    const hit = users.find((u) => normEmail(u.email) === target);
    if (hit) return { id: hit.id, email: target };
    if (users.length < perPage) return null;
  }
  throw new Error("Too many accounts to search.");
}

/** An email already used anywhere: a sign-in account, a profile or a
 *  membership. For starting a new workspace, where it must be new. */
export async function emailInUse(email: string): Promise<boolean> {
  const e = normEmail(email);
  if (await accountByEmail(e)) return true;
  const [{ data: u, error: e1 }, { data: m, error: e2 }] = await Promise.all([
    supabaseAdmin.from("users").select("id").ilike("email", e).limit(1),
    supabaseAdmin.from("org_members").select("id").ilike("email", e).limit(1),
  ]);
  if (e1 || e2) throw new Error(`Couldn't check the email: ${(e1 ?? e2)!.message}`);
  return (u ?? []).length > 0 || (m ?? []).length > 0;
}
