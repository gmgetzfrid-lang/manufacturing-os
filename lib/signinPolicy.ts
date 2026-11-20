// lib/signinPolicy.ts
//
// How people get into a workspace. Two doors:
//   Microsoft  for anyone whose email is on one of the workspace's own
//              domains (e.g. kernenergy.com). Their password, multi-factor
//              and leaving are handled by the company's Microsoft accounts.
//              A password sign-in for those emails is refused.
//   Password   for people without a company Microsoft account (contractors,
//              vendors), if the workspace allows it. The admin never picks
//              or sees a lasting password: the app issues a one-time
//              password, the person must set their own the same day, and
//              if they don't, the account is suspended until an admin
//              resets it.
// Saved per workspace in org_configurations under key "signin".

export interface SigninPolicy {
  /** Email domains that must sign in with Microsoft, lowercased, no "@". */
  microsoftDomains: string[];
  /** Whether people outside those domains may have a password account. */
  allowPasswords: boolean;
}

export const DEFAULT_SIGNIN_POLICY: SigninPolicy = { microsoftDomains: [], allowPasswords: true };
export const SIGNIN_KEY = "signin";
/** Shortest password a person may set for themselves. */
export const MIN_PASSWORD = 12;

/** "Jane@KernEnergy.com" → "kernenergy.com". */
export function domainOf(email: string | null | undefined): string {
  const at = (email ?? "").trim().toLowerCase().lastIndexOf("@");
  return at < 0 ? "" : (email ?? "").trim().toLowerCase().slice(at + 1);
}

/** Clean a typed list ("@kernenergy.com, Kern.com") into domains. */
export function parseDomains(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/[\s,;]+/)) {
    const d = raw.trim().toLowerCase().replace(/^@/, "");
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) out.add(d);
  }
  return [...out];
}

export function normalizePolicy(raw: unknown): SigninPolicy {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<SigninPolicy>;
  const domains = Array.isArray(o.microsoftDomains) ? parseDomains(o.microsoftDomains.join(",")) : [];
  return { microsoftDomains: domains, allowPasswords: o.allowPasswords !== false };
}

/** Does this email have to use Microsoft under this policy? */
export function mustUseMicrosoft(email: string | null | undefined, policy: SigninPolicy): boolean {
  const d = domainOf(email);
  return !!d && policy.microsoftDomains.some((m) => d === m || d.endsWith(`.${m}`));
}

/** What a password check says about a new password. Null when it's fine. */
export function passwordProblem(pw: string, email?: string | null): string | null {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (!/[a-zA-Z]/.test(pw) || !/[0-9\W_]/.test(pw)) return "Mix letters with numbers or symbols.";
  const local = (email ?? "").split("@")[0]?.toLowerCase();
  if (local && local.length >= 3 && pw.toLowerCase().includes(local)) return "Don't use your email name in it.";
  if (/^(password|welcome|changeme|letmein)/i.test(pw)) return "That's a common password. Pick another.";
  return null;
}

/** The end of the given day in the viewer's time zone, as an ISO string. */
export function endOfDay(now: Date = new Date()): string {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

/** What's stored on a person's account (app_metadata, which only the
 *  server can write) while they hold a one-time password. */
export interface TempPasswordMeta {
  /** Set once the person has chosen their own password here. Accounts
   *  from before this rule (an admin typed their password) don't have it,
   *  so their next password sign-in asks them to set their own. */
  password_owned?: boolean;
  temp_password?: boolean;
  temp_issued_at?: string;
  temp_expires_at?: string;
  temp_issued_by?: string;
}

export function tempState(meta: TempPasswordMeta | null | undefined, now = Date.now()): "none" | "active" | "expired" {
  if (!meta?.temp_password) return "none";
  const exp = meta.temp_expires_at ? Date.parse(meta.temp_expires_at) : NaN;
  if (!Number.isFinite(exp) || now > exp) return "expired";
  return "active";
}

