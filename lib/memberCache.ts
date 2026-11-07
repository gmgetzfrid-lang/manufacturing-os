// memberCache - the signed-in account's workspace role, remembered on this
// device so a page refresh opens straight into the account (no spinner, no
// "Viewer" while the role is looked up). The role is checked again in the
// background on every load and corrected if it changed; the database's own
// rules (RLS) decide what can be read or written, never this.
//
// Pure helpers over a Storage, so they can be tested without a browser.

import type { Role } from "@/types/schema";

export const MEMBER_KEY = "manufacturingos.member";

export interface CachedMember {
  uid: string;
  orgId: string;
  role: Role;
  roles: Role[];
  status: "active";
  email?: string;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/** The remembered membership, or null (none, or not readable). */
export function readMember(store: Store | null | undefined): CachedMember | null {
  try {
    const v = JSON.parse(store?.getItem(MEMBER_KEY) ?? "null") as Partial<CachedMember> | null;
    if (!v || typeof v.uid !== "string" || typeof v.orgId !== "string" || typeof v.role !== "string" || !Array.isArray(v.roles) || v.status !== "active") return null;
    return { uid: v.uid, orgId: v.orgId, role: v.role, roles: v.roles as Role[], status: "active", ...(v.email ? { email: v.email } : {}) };
  } catch { return null; }
}

/** Remember an active membership; anything else forgets it. */
export function writeMember(store: Store | null | undefined, m: { uid: string; orgId: string; role: Role; roles: Role[]; status: string; email?: string } | null): void {
  try {
    if (m && m.status === "active") store?.setItem(MEMBER_KEY, JSON.stringify({ uid: m.uid, orgId: m.orgId, role: m.role, roles: m.roles, status: "active", ...(m.email ? { email: m.email } : {}) }));
    else store?.removeItem(MEMBER_KEY);
  } catch { /* private mode */ }
}

/** The signed-in account's id as the auth client stored it on this device
 *  ("sb-<project>-auth-token"), read without the network. */
export function storedUid(...stores: Array<Store | null | undefined>): string | null {
  for (const st of stores) {
    if (!st) continue;
    try {
      for (let i = 0; i < st.length; i++) {
        const k = st.key(i);
        if (!k || !/^sb-.+-auth-token$/.test(k)) continue;
        const v = JSON.parse(st.getItem(k) ?? "null") as { user?: { id?: string }; currentSession?: { user?: { id?: string } } } | null;
        const id = v?.user?.id ?? v?.currentSession?.user?.id;
        if (typeof id === "string" && id) return id;
      }
    } catch { /* unreadable: no id */ }
  }
  return null;
}

/** The membership to open with: remembered for this same account, in the
 *  workspace this device last used. */
export function memberToOpen(cached: CachedMember | null, uid: string | null, lastOrg: string | null): CachedMember | null {
  if (!cached || !uid || cached.uid !== uid) return null;
  if (lastOrg && lastOrg !== cached.orgId) return null;
  return cached;
}
