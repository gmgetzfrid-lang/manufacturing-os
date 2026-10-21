// lib/checkoutAffordances.ts
//
// DCK-13 / HLD-8 (checkout half): the affordances the checkout surfaces draw
// — the force-release button on the status-cell popover and the Inspector
// drawer, and the Inspector's place/release hold controls — come from the
// org's CAPABILITY POLICY, evaluated the same way lib/holds.ts, the workflow
// route and the database evaluate it: role tokens, the additive roles[]
// collection, and any live per-person grant. Never a hardcoded role pair.
//
// Two symmetrical failures this closes: an admin who WIDENS
// checkout.force_release to a Drafting Supervisor saw no button (the
// delegation was inert); an admin who NARROWED it saw the button stay for a
// DocCtrl the database then refused. And a per-person UserGrant for
// holds.release — the very delegation the hold error text invites — was
// invisible to every hold control.
//
// Pure: no I/O. The caller loads the policy (loadCapabilityPolicy) and hands
// it in; a null policy means "not loaded yet", which evaluates the shipped
// defaults — byte-identical to the old literal pairs for an unconfigured org.

import { policyAllows, type CapabilityPolicy, type LoadedCapabilityPolicy } from "@/lib/capabilityPolicy";

/** May this member force-release another user's checkout? The database
 *  (enforce_checkout_release_guard, trg_checkout_session_guard, the
 *  force_release_document RPC) reads the same capability. */
export function canForceReleaseCheckout(
  policy: CapabilityPolicy | null | undefined,
  role: string | null | undefined,
  roles: readonly string[] | null | undefined,
  uid: string | null | undefined,
): boolean {
  return policyAllows(policy, "checkout.force_release", role ?? null, roles ? [...roles] : null, uid ?? null);
}

export interface HoldAffordances {
  /** May place a hold (holds.open). */
  canOpen: boolean;
  /** May release a hold (holds.release). */
  canRelease: boolean;
}

/** The two hold verbs, from the policy. DOCUMENT ownership is deliberately
 *  NOT an input: the document_holds policies and lib/holds.ts
 *  assertHoldCapability gate the write on the capability, so a document
 *  owner outside the policy would be shown a control the write then refuses.
 *  The one identity leg is the HOLD's opener (drafting-flow HAND-2, DF-P11
 *  fix pass): pass the `hold` and the person who placed it may release it —
 *  the document_holds UPDATE policy's `opened_by = auth.uid()` (20261239)
 *  and assertHoldCapability's `openedBy`. Without a hold, the answer is the
 *  policy's alone (what a surface offers on holds in general). */
export function holdAffordances(
  policy: CapabilityPolicy | null | undefined,
  role: string | null | undefined,
  roles: readonly string[] | null | undefined,
  uid: string | null | undefined,
  hold?: { openedBy?: string | null } | null,
): HoldAffordances {
  const extra = roles ? [...roles] : null;
  const opener = !!uid && !!hold?.openedBy && hold.openedBy === uid;
  return {
    canOpen: policyAllows(policy, "holds.open", role ?? null, extra, uid ?? null),
    canRelease: opener || policyAllows(policy, "holds.release", role ?? null, extra, uid ?? null),
  };
}

/** drafting-flow AUTHZ-15 (DEC-89 item 3, ratified DEC-90 A26; the
 *  integrator's ruling of 2026-10-13 under the user's delegation, recorded
 *  under DEC-89). Reads a loadCapabilityPolicyEntry answer for an AFFORDANCE
 *  surface: the fault's words when the controls the policy decides must be
 *  held back, else null.
 *  - `unreadable`: no last good entry — `policy` is the shipped defaults, so
 *    the policy-dependent controls are held back, labelled, with Try again;
 *  - `stale`: the refresh failed and the last good policy was served — it IS
 *    the org's policy as last read and is drawn as is, with no label
 *    (AUTHZ-15's Remediation: "`stale` needs no label"); every action it
 *    offers is re-checked by the server and the database. null.
 *  A good read (fresh, or within the cache's TTL with no marker) is null.
 *  On a fault the surface keeps its policy null AND forces its
 *  policy-dependent controls off (a null policy evaluates the shipped
 *  defaults in policyAllows), and says why on screen with a way to read
 *  again. A read that throws is handled by the caller as a fault too. */
export function affordancePolicyFault(
  entry: Partial<LoadedCapabilityPolicy>,
): string | null {
  if (typeof entry.unreadable === "string") return entry.unreadable || "the capability policy could not be read";
  return null;
}
