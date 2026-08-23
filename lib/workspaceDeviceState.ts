// lib/workspaceDeviceState.ts
//
// The device's remembered workspace, with an owner stamp (audit finding
// IDENT-4). The bare key predates multi-identity reality: one browser
// carrying two accounts (work Microsoft + password, say) let identity B boot
// from identity A's workspace candidate, which then fed the self-heal
// relocation (ORGSEL-1). The stored org now carries the uid that wrote it;
// a reader presenting a different uid gets null instead of inheriting.
//
// The pre-paint restore in RoleContext CANNOT validate ownership — it runs
// before the session is known (deliberately: reading localStorage in a
// useState initializer caused React #418 hydration errors, see the comment
// at its call site). So validation happens at resolution time instead, via
// readStoredOrgIdFor(uid). An unowned value (written before this module
// existed, or by setActiveOrgId before uid propagated) is accepted as-is —
// the stamp is an invalidation mechanism, not a gate.

const LS_ORG_KEY = "manufacturingos.activeOrgId";
const LS_ORG_OWNER_KEY = "manufacturingos.activeOrgId.owner";

/** Pure decision: does the stored workspace belong to this uid?
 *  Exported for tests. Owner absent → legacy value, accept. */
export function validateStoredOrg(
  storedOrgId: string | null,
  storedOwnerUid: string | null,
  uid: string
): string | null {
  if (!storedOrgId) return null;
  if (storedOwnerUid && storedOwnerUid !== uid) return null;
  return storedOrgId;
}

/** Raw read for the pre-paint restore — no owner check possible yet. */
export function readStoredOrgId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LS_ORG_KEY);
  } catch {
    return null;
  }
}

/** Owner-validated read for resolution. A mismatched owner also clears the
 *  stale value so it cannot keep resurfacing as a candidate. */
export function readStoredOrgIdFor(uid: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(LS_ORG_KEY);
    const owner = window.localStorage.getItem(LS_ORG_OWNER_KEY);
    const valid = validateStoredOrg(stored, owner, uid);
    if (stored && !valid) clearStoredOrgId();
    return valid;
  } catch {
    return null;
  }
}

/** Write the workspace, stamping the owner when known. `ownerUid: null`
 *  (uid not yet propagated) writes the value unstamped — better a legacy
 *  value than a lost workspace switch. */
export function writeStoredOrgId(orgId: string | null, ownerUid: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (orgId) {
      window.localStorage.setItem(LS_ORG_KEY, orgId);
      if (ownerUid) window.localStorage.setItem(LS_ORG_OWNER_KEY, ownerUid);
      else window.localStorage.removeItem(LS_ORG_OWNER_KEY);
    } else {
      clearStoredOrgId();
    }
  } catch {
    /* private mode — resolution falls back to the profile default */
  }
}

export function clearStoredOrgId(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LS_ORG_KEY);
    window.localStorage.removeItem(LS_ORG_OWNER_KEY);
  } catch {
    /* ignore */
  }
}
