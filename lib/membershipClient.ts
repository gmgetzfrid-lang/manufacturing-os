// lib/membershipClient.ts - the browser's side of /api/auth/membership:
// which workspaces the signed-in account is in, answered by the server.
//
// Four outcomes, never mixed up:
//   { ok: true, ... }        the server's answer (possibly no workspace)
//   SignedOut                the sign-in is gone or expired and couldn't be
//                            renewed: sign in again
//   ServerBusy               the server is busy or didn't answer in time:
//                            the sign-in is kept, try again a little later
//   any other throw          the check couldn't run: try again (never read
//                            as "no workspace")
//
// Also here: signing out of this device (signOutHere), which never waits
// on the server.

import { supabase } from "@/lib/supabase";

export interface ServerMembership { id: string; orgId: string; orgName: string | null; role: string; roles: string[] | null; status: string; email: string | null }
export interface MembershipAnswer { memberships: ServerMembership[]; defaultOrgId: string | null }

export class SignedOut extends Error { constructor() { super("Your sign-in ended. Sign in again."); } }
/** Busy or too slow to answer: not signed out, just not now. */
export class ServerBusy extends Error { constructor() { super("The server is busy right now. You're still signed in."); } }

/** How long one ask waits for the server. */
const ASK_MS = 15_000;

async function ask(token: string, signal?: AbortSignal): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ASK_MS);
  const pass = () => ctl.abort();
  if (signal?.aborted) pass(); else signal?.addEventListener("abort", pass, { once: true });
  try {
    return await fetch("/api/auth/membership", { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: ctl.signal });
  } catch (e) {
    // No answer in time (and not called off by the caller): busy.
    if (ctl.signal.aborted && !signal?.aborted) throw new ServerBusy();
    throw e;
  } finally {
    clearTimeout(t);
    signal?.removeEventListener("abort", pass);
  }
}

/** A renewal the server turned down (the sign-in is really gone), not one
 *  it couldn't answer. */
const refused = (e: { status?: number } | null) => !!e && typeof e.status === "number" && e.status >= 400 && e.status < 500;

export async function fetchMemberships(signal?: AbortSignal): Promise<MembershipAnswer> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new SignedOut();
  let res = await ask(session.access_token, signal);
  if (res.status === 401) {
    // An access token that just ran out: renew it once and ask again.
    const { data: renewed, error: renewErr } = await supabase.auth.refreshSession();
    if (!renewed.session?.access_token) {
      // The server couldn't answer the renewal: keep the sign-in.
      if (renewErr && !refused(renewErr as { status?: number })) throw new ServerBusy();
      throw new SignedOut();
    }
    res = await ask(renewed.session.access_token, signal);
    if (res.status === 401) throw new SignedOut();
  }
  // Busy, or a gateway that gave up waiting: never "signed out".
  if (res.status === 503 || res.status === 502 || res.status === 504) throw new ServerBusy();
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

/** Sign out of this device at once, whatever the server answers (plant
 *  PCs are shared), then end the sign-in everywhere else without waiting.
 *  supabase-js's own sign-out asks the server first and keeps the session
 *  when the server fails, so the stored sign-in is cleared here first. */
export async function signOutHere(): Promise<void> {
  const auth = supabase.auth;
  const key = (auth as unknown as { storageKey?: string }).storageKey ?? "";
  let token: string | null = null;
  try {
    const raw = key ? window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key) : null;
    token = raw ? ((JSON.parse(raw) as { access_token?: string }).access_token ?? null) : null;
  } catch { /* unreadable: this device is still cleared */ }
  try {
    for (const store of [window.localStorage, window.sessionStorage]) {
      for (const k of Object.keys(store)) if ((key && k.startsWith(key)) || /^sb-.+-auth-token/.test(k)) store.removeItem(k);
    }
  } catch { /* private mode */ }
  // Nothing stored now, so this asks no server: it only tells the app
  // (which clears this account's data on this device).
  await Promise.race([auth.signOut({ scope: "local" }).catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]);
  // Everywhere else: best effort, never waited for.
  if (token) void auth.admin.signOut(token, "global").catch(() => undefined);
}
