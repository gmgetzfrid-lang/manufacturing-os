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
//     It does not rewrite, switch or delete the row while it is private, and
//     approves only an OPEN request — never a draft its author did not
//     offer or withdrew, and only the version the controller was shown (an
//     author's edit withdraws the request; the approval names the row's
//     updated_at) — 20261125's guards refuse the rest;
//   * built-ins belong to nobody: controllers switch them on and off, nobody
//     deletes them, nobody shares or unshares them.
//
// Pure — no I/O of its own (readSkillShelf drives the reads it is handed) —
// so the page, the review panel and the Studio ask the same question and
// the tests can hold it against the policies.

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
  /** Private → org-wide: a controller's own private draft. */
  share: boolean;
  /** A controller approves a member's OPEN share request — for the version
   *  the shelf showed (approveSkillShare's updated_at match). */
  approveShare: boolean;
  /** Org-wide → private. */
  unshare: boolean;
  /** The author asks a controller to share it. */
  requestShare: boolean;
  /** The author withdraws that request. */
  withdrawRequest: boolean;
  /** A controller turns a share request down (the row stays private). */
  declineShare: boolean;
  remove: boolean;
  /** Why this private skill cannot be published as written — a pack or a
   *  pattern written before 20261125's checks, which the guards re-run on
   *  publish (23514). Approve, Share and the request are withheld and the
   *  card says this instead: no control edits a skill, so its author
   *  re-creates it to share it. */
  publishRefused: string | null;
}

const NONE: SkillControls = {
  toggle: false, share: false, approveShare: false, unshare: false, requestShare: false,
  withdrawRequest: false, declineShare: false, remove: false, publishRefused: null,
};

/** `publishIssue` is what the database would refuse on publishing this row
 *  (answerSkillIssue of its pack / the first of refusedSkillPatterns of its
 *  patterns), worked out by the card that knows the skill's kind. */
export function skillControls(
  row: SkillRowLike,
  viewer: { uid: string | null; isController: boolean },
  publishIssue: string | null = null,
): SkillControls {
  if (row.builtin_key) return { ...NONE, toggle: viewer.isController };
  const mine = viewer.uid !== null && row.created_by === viewer.uid;
  const org = row.visibility === "org";
  const requested = !!row.share_requested;
  // Before 20261125 the row has no share_requested column at all, and a
  // request could not be recorded — the control is not offered.
  const sharingInstalled = row.share_requested !== undefined;
  // A private skill the database would refuse to publish: nothing offers a
  // publish that can only fail (the reason is shown instead).
  const refused = !org && publishIssue ? publishIssue : null;
  if (viewer.isController) {
    // A member's private skill: the controller decides its OPEN share
    // request — approve or decline — and nothing else; a draft its author
    // has not offered (or withdrew) is not theirs to publish (20261125's
    // guards).
    if (!mine && !org) {
      return { ...NONE, approveShare: requested && !refused, declineShare: requested, publishRefused: requested ? refused : null };
    }
    return {
      ...NONE,
      toggle: true,
      share: !org && !refused,
      unshare: org,
      // A controller's own private draft is simply shared.
      requestShare: false,
      withdrawRequest: mine && !org && requested,
      remove: true,
      publishRefused: refused,
    };
  }
  if (!mine) return NONE;
  return {
    ...NONE,
    toggle: !org,
    unshare: org,
    requestShare: sharingInstalled && !org && !requested && !refused,
    withdrawRequest: !org && requested,
    remove: true,
    publishRefused: refused,
  };
}

/** What a controller is told when the skill they approve is no longer the
 *  one they were shown: its author edited it (which withdraws the request),
 *  withdrew the request, or someone else decided it first. */
export const SKILL_CHANGED_SINCE_REVIEW = "This skill changed since you opened it — reload and review it again.";

/** The rows a skill shelf pages through, as a PostgREST `or` filter the
 *  database applies (HUB-8): org-wide skills and the viewer's own. Since
 *  20261125 a controller READS every private skill of the org; filtering
 *  only in the browser let members' unrequested drafts fill the read window.
 *  The share requests waiting on a controller are a separate read
 *  (readSkillShelf), so no number of org-wide skills pushes one off. */
export function skillShelfFilter(uid: string | null): string {
  const terms = ["visibility.eq.org"];
  if (uid) terms.push(`created_by.eq.${uid}`);
  return terms.join(",");
}

/** A shelf's stated ceilings (HUB-8 fix pass 4): org-wide and own skills
 *  are read in pages of SKILL_SHELF_PAGE up to SKILL_SHELF_CEILING; the
 *  share requests, read on their own, up to SKILL_REQUEST_CEILING. Reaching
 *  either is said on the shelf. */
export const SKILL_SHELF_PAGE = 200;
export const SKILL_SHELF_CEILING = 1000;
export const SKILL_REQUEST_CEILING = 200;

type ReadError = { code?: string; message?: string };
type ShelfRead<T> = PromiseLike<{ data: T[] | null; error: ReadError | null }>;
type ShelfRow = SkillRowLike & { id: string; created_at?: string | null };

/** Reads a skill shelf: org-wide and own skills in pages to the ceiling,
 *  then the share requests — always read, so a controller sees every
 *  waiting request whatever the shelf holds. `readPage(from, to)` is the
 *  ordered, filtered range read; `readRequests(limit)` the requests read. A
 *  database without share_requested (before 20261125) answers the requests
 *  read with a missing column: there are no requests to read. */
export async function readSkillShelf<T extends ShelfRow>(
  readPage: (from: number, to: number) => ShelfRead<T>,
  readRequests: (limit: number) => ShelfRead<T>,
  missingColumn: (e: ReadError | null) => boolean,
): Promise<{ rows: T[]; error: ReadError | null; notes: string[] }> {
  const rows: T[] = [];
  const notes: string[] = [];
  for (let from = 0; from < SKILL_SHELF_CEILING; from += SKILL_SHELF_PAGE) {
    // The last page reads one row past the ceiling: that row is how the
    // shelf knows a skill is left unshown (a shelf of exactly the ceiling
    // hides nothing and says nothing).
    const to = Math.min(from + SKILL_SHELF_PAGE, SKILL_SHELF_CEILING) - 1;
    const last = to === SKILL_SHELF_CEILING - 1;
    const want = to - from + 1 + (last ? 1 : 0);
    const { data, error } = await readPage(from, from + want - 1);
    if (error) return { rows: [], error, notes };
    const page = data ?? [];
    rows.push(...page);
    if (page.length < want) break;
  }
  if (rows.length > SKILL_SHELF_CEILING) {
    rows.length = SKILL_SHELF_CEILING;
    notes.push(`This shelf lists the first ${SKILL_SHELF_CEILING.toLocaleString("en-US")} org-wide and own skills — any beyond that are not shown.`);
  }
  const req = await readRequests(SKILL_REQUEST_CEILING + 1);
  if (req.error) {
    if (!missingColumn(req.error)) return { rows: [], error: req.error, notes };
    return { rows, error: null, notes };
  }
  const requests = req.data ?? [];
  if (requests.length > SKILL_REQUEST_CEILING) {
    notes.push(`More than ${SKILL_REQUEST_CEILING} share requests are waiting — the oldest ${SKILL_REQUEST_CEILING} are shown.`);
  }
  const seen = new Set(rows.map((r) => r.id));
  for (const r of requests.slice(0, SKILL_REQUEST_CEILING)) {
    if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
  }
  // The shelf's order: built-ins first, then oldest first.
  rows.sort((a, b) => {
    if (!!a.builtin_key !== !!b.builtin_key) return a.builtin_key ? -1 : 1;
    if (a.builtin_key && b.builtin_key && a.builtin_key !== b.builtin_key) return a.builtin_key < b.builtin_key ? -1 : 1;
    const at = a.created_at ?? "", bt = b.created_at ?? "";
    if (at !== bt) return at < bt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { rows, error: null, notes };
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
