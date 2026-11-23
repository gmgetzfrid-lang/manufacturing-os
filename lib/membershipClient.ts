// lib/membershipClient.ts - the browser's side of /api/auth/membership:
// which workspaces the signed-in account is in, answered by the server.
//
// Three outcomes, never mixed up:
//   { ok: true, ... }        the server's answer (possibly no workspace)
//   SignedOut                the sign-in is gone or expired and couldn't be
//                            renewed: sign in again
//   any other throw          the check couldn't run: try again (never read
//                            as "no workspace")

import { supabase } from "@/lib/supabase";

export interface ServerMembership { id: string; orgId: string; orgName: string | null; role: string; roles: string[] | null; status: string; email: string | null }
export interface MembershipAnswer { memberships: ServerMembership[]; defaultOrgId: string | null }

export class SignedOut extends Error { constructor() { super("Your sign-in ended. Sign in again."); } }

async function ask(token: string): Promise<Response> {
  return fetch("/api/auth/membership", { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
}

export async function fetchMemberships(): Promise<MembershipAnswer> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new SignedOut();
  let res = await ask(session.access_token);
  if (res.status === 401) {
    // An access token that just ran out: renew it once and ask again.
    const { data: renewed } = await supabase.auth.refreshSession();
    if (!renewed.session?.access_token) throw new SignedOut();
    res = await ask(renewed.session.access_token);
    if (res.status === 401) throw new SignedOut();
  }
  const body = (await res.json().catch(() => null)) as (MembershipAnswer & { error?: string }) | null;
  if (!res.ok || !body || !Array.isArray(body.memberships)) throw new Error(body?.error ?? `The server answered ${res.status}.`);
  return { memberships: body.memberships, defaultOrgId: body.defaultOrgId ?? null };
}

/** The workspace to open: this device's last one when the account is
 *  active there, else the profile's home workspace, else the first active. */
export function pickMembership(a: MembershipAnswer, lastOrg: string | null): ServerMembership | null {
  const active = a.memberships.filter((m) => m.status === "active");
  return active.find((m) => m.orgId === lastOrg) ?? active.find((m) => m.orgId === a.defaultOrgId) ?? active[0] ?? null;
}
