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

import { policyAllows, type CapabilityPolicy } from "@/lib/capabilityPolicy";

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

/** The two hold verbs, from the policy. Ownership is deliberately NOT an
 *  input: the document_holds policies and lib/holds.ts assertHoldCapability
 *  gate the write on the capability alone, so an owner outside the policy
 *  would be shown a control the write then refuses. */
export function holdAffordances(
  policy: CapabilityPolicy | null | undefined,
  role: string | null | undefined,
  roles: readonly string[] | null | undefined,
  uid: string | null | undefined,
): HoldAffordances {
  const extra = roles ? [...roles] : null;
  return {
    canOpen: policyAllows(policy, "holds.open", role ?? null, extra, uid ?? null),
    canRelease: policyAllows(policy, "holds.release", role ?? null, extra, uid ?? null),
  };
}
