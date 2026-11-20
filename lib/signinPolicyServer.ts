// lib/signinPolicyServer.ts — server only (service role).
//
// The enforcement half of lib/signinPolicy: reads a workspace's sign-in
// rules, issues one-time passwords onto an account's app_metadata (which
// only the server can write), and suspends accounts whose one-time password
// ran past its day. Suspension is real: every table's access rule requires
// an active membership.

import { randomInt } from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizePolicy, SIGNIN_KEY, tempState, type SigninPolicy, type TempPasswordMeta } from "@/lib/signinPolicy";

export async function getSigninPolicy(orgId: string): Promise<SigninPolicy> {
  const { data } = await supabaseAdmin.from("org_configurations").select("data").eq("org_id", orgId).eq("key", SIGNIN_KEY).maybeSingle();
  return normalizePolicy((data as { data?: unknown } | null)?.data ?? null);
}

/** The rules of every workspace a person belongs to (any status). */
export async function policiesForUser(uid: string): Promise<Array<{ orgId: string; policy: SigninPolicy }>> {
  const { data } = await supabaseAdmin.from("org_members").select("org_id").eq("uid", uid);
  const orgIds = [...new Set(((data ?? []) as { org_id: string }[]).map((r) => r.org_id))];
  return Promise.all(orgIds.map(async (orgId) => ({ orgId, policy: await getSigninPolicy(orgId) })));
}

// No look-alike characters (0/O, 1/l/I), so it reads aloud and types cleanly.
const CHARS = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
/** A one-time password like "Rk7m-Pq2x-Tz9w": 12 random characters. */
export function generateTempPassword(): string {
  const pick = () => CHARS[randomInt(CHARS.length)];
  const group = () => Array.from({ length: 4 }, pick).join("");
  let pw = `${group()}-${group()}-${group()}`;
  // Always at least one digit, so it passes any password rule.
  if (!/[0-9]/.test(pw)) pw = pw.slice(0, -1) + String(2 + randomInt(8));
  return pw;
}

/** The end of the day the admin issued it on, sent from their browser.
 *  Anything odd falls back to 24 hours from now. */
export function sanitizeExpiry(iso: unknown, now = Date.now()): string {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (Number.isFinite(t) && t > now && t < now + 36 * 3600_000) return new Date(t).toISOString();
  return new Date(now + 24 * 3600_000).toISOString();
}

export function tempMeta(issuedBy: string, expiresAt: string): TempPasswordMeta {
  return { temp_password: true, temp_issued_at: new Date().toISOString(), temp_expires_at: expiresAt, temp_issued_by: issuedBy };
}

export const CLEAR_TEMP: Record<Exclude<keyof TempPasswordMeta, "password_owned">, null> = { temp_password: null, temp_issued_at: null, temp_expires_at: null, temp_issued_by: null };

/** Suspend every active membership of a person. Returns how many. */
export async function suspendMemberships(uid: string): Promise<number> {
  const { data } = await supabaseAdmin.from("org_members").update({ status: "suspended" }).eq("uid", uid).eq("status", "active").select("org_id");
  return (data ?? []).length;
}

/** Nightly: suspend everyone whose one-time password ran past its day. */
export async function suspendExpiredTempPasswords(): Promise<{ checked: number; suspended: number }> {
  let checked = 0, suspended = 0;
  const perPage = 200;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error || !data?.users?.length) break;
    for (const u of data.users) {
      const meta = (u.app_metadata ?? {}) as TempPasswordMeta;
      if (!meta.temp_password) continue;
      checked++;
      if (tempState(meta) === "expired") suspended += (await suspendMemberships(u.id)) > 0 ? 1 : 0;
    }
    if (data.users.length < perPage) break;
  }
  return { checked, suspended };
}

/** How the current session signed in, from its token: "password" or "oauth". */
export function signInMethod(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { amr?: Array<{ method?: string }> };
    const methods = (payload.amr ?? []).map((a) => a.method).filter(Boolean) as string[];
    if (methods.includes("password")) return "password";
    if (methods.includes("oauth")) return "oauth";
    return methods[0] ?? null;
  } catch { return null; }
}
