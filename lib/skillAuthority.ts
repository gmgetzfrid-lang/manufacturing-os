// lib/skillAuthority.ts — who may do what to a skill (DEC-55).
//
// Both skill classes — Reasoning Skills (answer_skills: text that rides every
// colleague's answer prompt) and Connection Skills (link_rules: patterns the
// engine runs over the whole corpus) — share one authority model, enforced
// by the database since 20261125 and mirrored here so the controls a person
// sees are exactly the writes RLS admits:
//
//   * a member authors PRIVATE skills; a private reasoning skill rides only
//     its author's questions, a private connection skill is a draft the
//     Studio's tester runs and the engine does not;
//   * publishing org-wide is the CONTROLLER tier (is_org_controller — the
//     collection, never a role name at the call site, DEC-35). A member asks
//     to share (share_requested); a controller approves or declines;
//   * an org-wide row is changed by a controller; its author may unshare or
//     delete it, never rewrite or re-enable it while it is org-wide;
//   * built-ins belong to nobody: controllers switch them on and off, nobody
//     deletes them, nobody shares or unshares them.
//
// Pure — no I/O — so the page, the review panel and the Studio ask the same
// question and the tests can hold it against the policies.

import { isControllerRole } from "@/lib/permissions";
import type { Role } from "@/types/schema";

/** The controller tier, by the held collection (what is_org_controller
 *  means). */
export function isSkillController(roles: readonly string[]): boolean {
  return roles.some((r) => isControllerRole(r as Role));
}

export interface SkillRowLike {
  builtin_key: string | null;
  visibility: string;
  created_by: string | null;
  share_requested?: boolean | null;
}

export interface SkillControls {
  /** Switch it on / off. */
  toggle: boolean;
  /** Private → org-wide (a controller's own row, or approving a request). */
  share: boolean;
  /** Org-wide → private. */
  unshare: boolean;
  /** The author asks a controller to share it. */
  requestShare: boolean;
  /** The author withdraws that request. */
  withdrawRequest: boolean;
  /** A controller turns a share request down (the row stays private). */
  declineShare: boolean;
  remove: boolean;
}

const NONE: SkillControls = {
  toggle: false, share: false, unshare: false, requestShare: false,
  withdrawRequest: false, declineShare: false, remove: false,
};

export function skillControls(
  row: SkillRowLike,
  viewer: { uid: string | null; isController: boolean },
): SkillControls {
  if (row.builtin_key) return { ...NONE, toggle: viewer.isController };
  const mine = viewer.uid !== null && row.created_by === viewer.uid;
  const org = row.visibility === "org";
  const requested = !!row.share_requested;
  if (viewer.isController) {
    return {
      ...NONE,
      toggle: true,
      share: !org,
      unshare: org,
      // A controller's own private draft is simply shared; a request from a
      // member can also be turned down.
      requestShare: false,
      withdrawRequest: mine && !org && requested,
      declineShare: !mine && !org && requested,
      remove: true,
    };
  }
  if (!mine) return NONE;
  return {
    ...NONE,
    toggle: !org,
    unshare: org,
    requestShare: !org && !requested,
    withdrawRequest: !org && requested,
    remove: true,
  };
}

/** The sharing choices the Studio offers the author of a NEW skill. */
export type StudioSharing = "private" | "request" | "org";
export function studioSharingChoices(isController: boolean): StudioSharing[] {
  return isController ? ["private", "org"] : ["private", "request"];
}

/** What a new row carries for a sharing choice. */
export function sharingColumns(choice: StudioSharing): { visibility: "org" | "private"; share_requested: boolean } {
  if (choice === "org") return { visibility: "org", share_requested: false };
  return { visibility: "private", share_requested: choice === "request" };
}
