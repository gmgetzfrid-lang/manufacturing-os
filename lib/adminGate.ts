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
//
// admin-and-org BKP-8 / DEC-87 §3: the admitted actor carries
// `admittedRole` — the role the surface admitted them by (the first of its
// entry roles they hold), never the headline alone — for the audit rows the
// surface's routes write: an Admin whose headline is Viewer is recorded as
// Admin. Additive; nothing else reads it.
//
// roles-and-permissions SURF-19 (admin-and-org Round G, P6): the routes
// behind a surface call this gate instead of carrying their own role
// constant. A route states its INTENT: "enter" (the default) holds the
// caller to the surface's entry rule, as before; "write" holds a mutating
// route to the surface's `writes` set as well — the entry rule AND the
// writes set, by the full collection; a surface with no `writes` set is held
// to its entry rule alone. The registry (lib/adminSurfaces.ts) is the only
// place either set is spelled, so a registry change moves the route's
// answer. For a write, `admittedRole` is the first of the writes roles held.

import { authorizeOrgRole, type AuthorizedActor, type AuthError } from "@/lib/serverAuth";
import { loadCapabilityPolicyStrict } from "@/lib/capabilityPolicy";
import { adminSurface, adminSurfaceAllows, type AdminSurface } from "@/lib/adminSurfaces";
import { memberHoldsAny } from "@/lib/roleHeld";
import { ALL_ROLES } from "@/types/schema";

export type AdminGateActor = AuthorizedActor & {
  surface: AdminSurface;
  /** The role this surface admitted the actor by: the first of its entry
   *  roles the actor holds (the headline for an open surface, or one
   *  admitted by a capability grant alone). */
  admittedRole: string;
};

/** The first of a surface's entry roles the actor holds, else the headline. */
export function admittedRoleFor(surface: Pick<AdminSurface, "entry">, roles: readonly string[], headline: string): string {
  return (surface.entry === "*" ? undefined : surface.entry.find((r) => roles.includes(r))) ?? headline;
}

/** What a route behind a surface is doing (SURF-19): "enter" reads under the
 *  entry rule; "write" is also held to the surface's `writes` set. */
export type AdminGateIntent = "enter" | "write";

const ROLE_NAMES: Record<string, string> = { DocCtrl: "Document Control" };
const andList = (xs: readonly string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** The refusal a member who may open a surface but not act on it reads. */
export function writesDeniedMessage(surface: Pick<AdminSurface, "label" | "writes">): string {
  const who = andList((surface.writes ?? []).map((r) => ROLE_NAMES[r] ?? r));
  return `Changes on ${surface.label} are limited to ${who}.`;
}

/** The write rule: the surface's `writes` set by the full collection, or —
 *  for a surface with none — nothing beyond the entry rule. */
export function adminSurfaceWriteAllows(surface: Pick<AdminSurface, "writes">, held: readonly string[]): boolean {
  if (!surface.writes) return true;
  const roles = held.filter((r) => typeof r === "string" && r.trim().length > 0);
  return memberHoldsAny({ roles }, surface.writes);
}

export async function authorizeAdminSurface(
  req: Request,
  orgId: string,
  surfaceKey: string,
  intent: AdminGateIntent = "enter",
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
  if (intent === "write") {
    if (!adminSurfaceWriteAllows(surface, actor.roles)) {
      return { error: writesDeniedMessage(surface), status: 403 };
    }
    const byWrites = surface.writes?.find((r) => actor.roles.includes(r));
    return { ...actor, surface, admittedRole: byWrites ?? admittedRoleFor(surface, actor.roles, actor.role) };
  }
  return { ...actor, surface, admittedRole: admittedRoleFor(surface, actor.roles, actor.role) };
}
