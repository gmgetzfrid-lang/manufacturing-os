// lib/adminGate.ts
//
// SURF-9 / WF-20: the ONE server-enforced admin gate. `authorizeAdminSurface`
// verifies the bearer token, loads the caller's ACTIVE membership and its
// full role collection (SURF-10: never the headline alone), and decides the
// surface from lib/adminSurfaces.ts. For a capability surface it reads the
// org's capability policy with the service client through the STRICT loader
// — a policy that cannot be read is a DENIAL (503), never an admission on
// the shipped defaults — and consults it with the caller's uid, so a
// per-person grant of admin.analytics_view / admin.archive_view /
// admin.audit_view works exactly as a role token does.
//
// Callers: /api/admin/gate (asked by the admin layout before it renders any
// /admin page) and the API routes that back a surface. Server-only.

import { authorizeOrgRole, type AuthorizedActor, type AuthError } from "@/lib/serverAuth";
import { loadCapabilityPolicyStrict } from "@/lib/capabilityPolicy";
import { adminSurface, adminSurfaceAllows, type AdminSurface } from "@/lib/adminSurfaces";
import { ALL_ROLES } from "@/types/schema";

export type AdminGateActor = AuthorizedActor & { surface: AdminSurface };

export async function authorizeAdminSurface(
  req: Request,
  orgId: string,
  surfaceKey: string,
): Promise<AdminGateActor | AuthError> {
  const surface = adminSurface(surfaceKey);
  if (!surface) return { error: `Unknown admin surface: ${surfaceKey || "(none)"}`, status: 400 };

  // Any ACTIVE member with at least one role gets past the membership rail;
  // the surface decides from here. (authorizeOrgRole already refuses an
  // inactive or roleless membership.)
  const actor = await authorizeOrgRole(req, orgId, ALL_ROLES as string[]);
  if ("error" in actor) return actor;

  let policy = null;
  if (surface.cap) {
    const loaded = await loadCapabilityPolicyStrict(orgId, actor.admin);
    if (!loaded.ok) {
      // FAIL CLOSED (WF-20 done-when 2): the gate cannot verify, so it does
      // not admit. 503 so the client can tell "not allowed" from "try again".
      return { error: "Could not verify your permissions for this page — try again.", status: 503 };
    }
    policy = loaded.policy;
  }

  if (!adminSurfaceAllows(surface, actor.roles, policy, actor.userId)) {
    return { error: surface.denied, status: 403 };
  }
  return { ...actor, surface };
}
