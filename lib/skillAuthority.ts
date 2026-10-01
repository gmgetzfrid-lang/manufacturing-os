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
//   * a member's PRIVATE skill is theirs: a controller reads it (to decide a
//     share request) and approves or declines that request — nothing else.
//     It does not rewrite, switch or delete the row while it is private
//     (20261125's guards refuse it);
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
  // Before 20261125 the row has no share_requested column at all, and a
  // request could not be recorded — the control is not offered.
  const sharingInstalled = row.share_requested !== undefined;
  if (viewer.isController) {
    // A member's private skill: the controller decides its share request —
    // approve or decline — and nothing else (20261125's guards).
    if (!mine && !org) return { ...NONE, share: true, declineShare: requested };
    return {
      ...NONE,
      toggle: true,
      share: !org,
      unshare: org,
      // A controller's own private draft is simply shared.
      requestShare: false,
      withdrawRequest: mine && !org && requested,
      remove: true,
    };
  }
  if (!mine) return NONE;
  return {
    ...NONE,
    toggle: !org,
    unshare: org,
    requestShare: sharingInstalled && !org && !requested,
    withdrawRequest: !org && requested,
    remove: true,
  };
}

/** The rows a skill shelf lists, as a PostgREST `or` filter the database
 *  applies (HUB-8 fix pass 3): org-wide skills, the viewer's own, and the
 *  share requests waiting on a controller. Since 20261125 a controller READS
 *  every private skill of the org; filtering only in the browser let
 *  members' unrequested drafts fill the read window and push org-wide skills
 *  and new requests off a controller's shelf. `withRequests` is false before
 *  20261125, when there is no share_requested column (and no request). */
export function skillShelfFilter(uid: string | null, withRequests: boolean): string {
  const terms = ["visibility.eq.org"];
  if (uid) terms.push(`created_by.eq.${uid}`);
  if (withRequests) terms.push("share_requested.eq.true");
  return terms.join(",");
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
