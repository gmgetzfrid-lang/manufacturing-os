// admin-and-org ORG-23 (fleet F3-member-gate-and-restore, DEC-90): a
// principal KNOWN not to be an active member (isActiveMember === false —
// lib/principal.ts resolveActorPrincipal's successful read with no active
// row, ORG-22) passes none of lib/permissions.ts's shortcuts: the controller
// tier (isControllerPrincipal) and the effective-owner rung now sit behind
// the member gate, and every decision answers false for that principal.
//
// NO REGRESSION, pinned exhaustively: every exported function of
// lib/permissions.ts is asked the same questions of the frozen base copy
// (lib/__tests__/fixtures/permissionsBase_b88651d1.ts) and of the live module,
// over every role (headline and additive), every action, every ACL shape
// (rule per subject kind x effect x action, on every visibility), the owner
// rung, the index forms, and the three membership states. An active member
// (true) and an unknown status (no flag) answer byte-identically; only an
// inactive member's answers change, and only to "denied".

import { describe, it, expect } from "vitest";
import * as live from "@/lib/permissions";
import * as base from "@/lib/__tests__/fixtures/permissionsBase_b88651d1";
import { buildAclIndex } from "@/lib/acl";
import { ALL_ROLES } from "@/types/schema";
import type { AccessControl, AclIndex, NodeVisibility, PermissionAction, Role } from "@/types/schema";
import type { Principal } from "@/lib/permissions";

const UID = "u-1";
const TEAM = "team-1";
const ORG = "org-1";
const ACTIONS: PermissionAction[] = [
  "discover", "read", "download", "upload", "createFolder", "editMetadata", "write", "publish", "managePermissions", "admin",
];
const VISIBILITIES: NodeVisibility[] = ["normal", "hidden", "private"];
const ACTIVE: Array<boolean | undefined> = [true, undefined, false];

/** Every principal shape: each role as the headline alone, the same with an
 *  explicit one-role collection, and additive collections that make a
 *  non-controller headline a controller (and the reverse). */
function principals(active: boolean | undefined): Principal[] {
  const out: Principal[] = [];
  const flag = active === undefined ? {} : { isActiveMember: active };
  for (const r of ALL_ROLES) {
    out.push({ uid: UID, role: r, orgId: ORG, teamIds: [TEAM], ...flag });
    out.push({ uid: UID, role: r, roles: [r], orgId: ORG, teamIds: [TEAM], ...flag });
  }
  out.push({ uid: UID, role: "Manager", roles: ["Manager", "DocCtrl"], orgId: ORG, teamIds: [TEAM], ...flag });
  out.push({ uid: UID, role: "Viewer", roles: ["Viewer", "Admin"], orgId: ORG, teamIds: [TEAM], ...flag });
  out.push({ uid: UID, role: "Admin", roles: ["Admin", "Drafter"], orgId: ORG, teamIds: [TEAM], ...flag });
  out.push({ uid: "", role: "Drafter", ...flag });
  return out;
}

/** The ACL shapes: none, an empty rule list, and one rule per subject kind
 *  (the principal's uid, its headline role, a controller role, its team, its
 *  org, someone else) x effect x action — on every visibility. */
function acls(p: Principal): Array<AccessControl | undefined> {
  const out: Array<AccessControl | undefined> = [undefined];
  for (const visibility of VISIBILITIES) {
    out.push({ visibility, rules: [] });
    const subjects: Array<{ type: "user" | "role" | "team" | "org"; id: string }> = [
      { type: "user", id: p.uid || "nobody" }, { type: "role", id: p.role }, { type: "role", id: "DocCtrl" },
      { type: "team", id: TEAM }, { type: "org", id: ORG }, { type: "user", id: "someone-else" },
    ];
    for (const subject of subjects) {
      for (const effect of ["allow", "deny"] as const) {
        for (const a of ACTIONS) out.push({ visibility, rules: [{ effect, subject, actions: [a] }] });
      }
    }
  }
  return out;
}

const OWNERS: Array<string | null | undefined> = [undefined, UID, "someone-else"];

type Answer = boolean | null;
/** Every decision both modules export, asked of one (principal, acl, owner). */
function answers(mod: typeof live, p: Principal, acl: AccessControl | undefined, owner: string | null | undefined): Record<string, Answer> {
  const vis = acl?.visibility ?? "normal";
  const idx: AclIndex | null = buildAclIndex(acl);
  const out: Record<string, Answer> = {
    isControllerPrincipal: mod.isControllerPrincipal(p),
    canPublishViaIndex: mod.canPublishViaIndex(idx, p),
    canPublishViaIndexNull: mod.canPublishViaIndex(null, p),
    canPublishOnLibrary: mod.canPublishOnLibrary({ principal: p, libraryAcl: acl }),
    canDiscover: mod.canDiscover({ principal: p, aclChain: [acl], visibility: vis, effectiveOwnerUserId: owner }),
    canServeContent: mod.canServeContent({ principal: p, aclChain: [acl], visibility: vis, effectiveOwnerUserId: owner }),
    canServeContentDraftMine: mod.canServeContent({ principal: p, aclChain: [acl], visibility: vis, effectiveOwnerUserId: owner, privateDraft: { createdBy: UID } }),
    canServeContentDraftOther: mod.canServeContent({ principal: p, aclChain: [acl], visibility: vis, effectiveOwnerUserId: owner, privateDraft: { createdBy: "someone-else" } }),
    controllerBypassDecided: mod.controllerBypassDecided({ principal: p, aclChain: [acl], visibility: vis, effectiveOwnerUserId: owner }),
  };
  for (const a of ACTIONS) {
    out[`canWithAclChain:${a}`] = mod.canWithAclChain({ principal: p, action: a, aclChain: [acl], effectiveOwnerUserId: owner });
    out[`canWithAclChain:${a}:closed`] = mod.canWithAclChain({ principal: p, action: a, aclChain: [acl], defaultAllow: false });
    out[`canReadNode:${a}`] = mod.canReadNode({ principal: p, aclChain: [acl], visibility: vis, effectiveOwnerUserId: owner, actions: [a] });
    out[`canReadViaIndex:${a}`] = mod.canReadViaIndex(idx, p, [a], owner);
    out[`canReadViaIndexNull:${a}`] = mod.canReadViaIndex(null, p, [a], owner);
  }
  return out;
}

describe("ORG-23: the member gate runs before every lib/permissions.ts shortcut", () => {
  it("exhaustive A/B against the frozen base: active and unknown-status answers byte-identical; an inactive member's answers change only to denied", () => {
    let compared = 0;
    let inactiveChanged = 0;
    const changedBy = new Map<string, number>();
    // Collected, then asserted once (an expect per answer would dominate the run).
    const mismatches: string[] = [];
    for (const active of ACTIVE) {
      for (const p of principals(active)) {
        for (const acl of acls(p)) {
          for (const owner of OWNERS) {
            const before = answers(base as unknown as typeof live, p, acl, owner);
            const after = answers(live, p, acl, owner);
            const keys = Object.keys(after);
            if (keys.length !== Object.keys(before).length) mismatches.push(`key count ${JSON.stringify({ p, acl, owner })}`);
            for (const k of keys) {
              compared++;
              const was = before[k];
              const now = after[k];
              if (active !== false) {
                // Byte-identical: the same answer (null stays null).
                if (now !== was) mismatches.push(`${k} changed for a member with isActiveMember=${active}: ${was} -> ${now} ${JSON.stringify({ p, acl, owner })}`);
                continue;
              }
              // Inactive: every decision denied (false) — never true, never
              // "unknown" (null); and an inactive member is never a controller.
              if (now !== false) mismatches.push(`${k} is ${now} for an inactive member ${JSON.stringify({ p, acl, owner })}`);
              if (was !== now) {
                inactiveChanged++;
                const fn = k.split(":")[0].replace(/Null$|Draft(Mine|Other)$/, "");
                changedBy.set(fn, (changedBy.get(fn) ?? 0) + 1);
              }
            }
          }
        }
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    // Sized, so the test cannot pass by asking nothing.
    expect(compared).toBeGreaterThan(1_000_000);
    // The defect was real on base: inactive principals passed shortcuts.
    expect(inactiveChanged).toBeGreaterThan(0);
    for (const fn of ["isControllerPrincipal", "canWithAclChain", "canPublishOnLibrary", "canPublishViaIndex", "canDiscover", "canReadNode", "canReadViaIndex", "canServeContent", "controllerBypassDecided"]) {
      expect(changedBy.get(fn) ?? 0, fn).toBeGreaterThan(0);
    }
  }, 120_000);

  const SUSPENDED_DOCCTRL: Principal = { uid: UID, role: "DocCtrl", roles: ["DocCtrl"], orgId: ORG, teamIds: [], isActiveMember: false };
  const SUSPENDED_OWNER: Principal = { uid: UID, role: "Drafter", roles: ["Drafter"], orgId: ORG, teamIds: [], isActiveMember: false };
  const RESTRICTED: AccessControl = { visibility: "private", rules: [{ effect: "allow", subject: { type: "user", id: "someone-else" }, actions: ["read", "publish", "discover"] }] };
  const RESTRICTED_IDX = buildAclIndex(RESTRICTED);

  it("reproduced on base: a suspended controller passed the controller shortcut of every decision, a suspended owner the owner rung", () => {
    expect(base.canWithAclChain({ principal: SUSPENDED_DOCCTRL, action: "read", aclChain: [RESTRICTED] })).toBe(true);
    expect(base.canPublishOnLibrary({ principal: SUSPENDED_DOCCTRL, libraryAcl: RESTRICTED })).toBe(true);
    expect(base.canDiscover({ principal: SUSPENDED_DOCCTRL, aclChain: [RESTRICTED], visibility: "private" })).toBe(true);
    expect(base.canReadNode({ principal: SUSPENDED_DOCCTRL, aclChain: [RESTRICTED], visibility: "private" })).toBe(true);
    expect(base.canReadViaIndex(RESTRICTED_IDX, SUSPENDED_DOCCTRL)).toBe(true);
    expect(base.canServeContent({ principal: SUSPENDED_DOCCTRL, aclChain: [RESTRICTED], visibility: "private" })).toBe(true);
    expect(base.isControllerPrincipal(SUSPENDED_DOCCTRL)).toBe(true);
    expect(base.canWithAclChain({ principal: SUSPENDED_OWNER, action: "read", aclChain: [RESTRICTED], effectiveOwnerUserId: UID })).toBe(true);
    expect(base.canDiscover({ principal: SUSPENDED_OWNER, aclChain: [RESTRICTED], visibility: "private", effectiveOwnerUserId: UID })).toBe(true);
    expect(base.canReadNode({ principal: SUSPENDED_OWNER, aclChain: [RESTRICTED], visibility: "private", effectiveOwnerUserId: UID })).toBe(true);
    expect(base.canReadViaIndex(RESTRICTED_IDX, SUSPENDED_OWNER, ["read"], UID)).toBe(true);
  });

  it("a suspended controller is refused by each controller shortcut; a suspended owner by each owner rung", () => {
    expect(live.canWithAclChain({ principal: SUSPENDED_DOCCTRL, action: "read", aclChain: [RESTRICTED] })).toBe(false);
    expect(live.canPublishOnLibrary({ principal: SUSPENDED_DOCCTRL, libraryAcl: RESTRICTED })).toBe(false);
    expect(live.canDiscover({ principal: SUSPENDED_DOCCTRL, aclChain: [RESTRICTED], visibility: "private" })).toBe(false);
    expect(live.canReadNode({ principal: SUSPENDED_DOCCTRL, aclChain: [RESTRICTED], visibility: "private" })).toBe(false);
    expect(live.canReadViaIndex(RESTRICTED_IDX, SUSPENDED_DOCCTRL)).toBe(false);
    expect(live.canServeContent({ principal: SUSPENDED_DOCCTRL, aclChain: [RESTRICTED], visibility: "private" })).toBe(false);
    expect(live.controllerBypassDecided({ principal: SUSPENDED_DOCCTRL, aclChain: [RESTRICTED], visibility: "private" })).toBe(false);
    expect(live.isControllerPrincipal(SUSPENDED_DOCCTRL)).toBe(false);
    expect(live.canWithAclChain({ principal: SUSPENDED_OWNER, action: "read", aclChain: [RESTRICTED], effectiveOwnerUserId: UID })).toBe(false);
    expect(live.canDiscover({ principal: SUSPENDED_OWNER, aclChain: [RESTRICTED], visibility: "private", effectiveOwnerUserId: UID })).toBe(false);
    expect(live.canReadNode({ principal: SUSPENDED_OWNER, aclChain: [RESTRICTED], visibility: "private", effectiveOwnerUserId: UID })).toBe(false);
    expect(live.canReadViaIndex(RESTRICTED_IDX, SUSPENDED_OWNER, ["read"], UID)).toBe(false);
  });

  it("regression: an active controller / owner and an unknown-status principal still pass the shortcuts", () => {
    for (const flag of [{ isActiveMember: true }, {}]) {
      const ctrl: Principal = { ...SUSPENDED_DOCCTRL, ...flag };
      if (!("isActiveMember" in flag)) delete (ctrl as { isActiveMember?: boolean }).isActiveMember;
      const owner: Principal = { ...SUSPENDED_OWNER, ...flag };
      if (!("isActiveMember" in flag)) delete (owner as { isActiveMember?: boolean }).isActiveMember;
      expect(live.isControllerPrincipal(ctrl)).toBe(true);
      expect(live.canWithAclChain({ principal: ctrl, action: "read", aclChain: [RESTRICTED] })).toBe(true);
      expect(live.canPublishOnLibrary({ principal: ctrl, libraryAcl: RESTRICTED })).toBe(true);
      expect(live.canDiscover({ principal: ctrl, aclChain: [RESTRICTED], visibility: "private" })).toBe(true);
      expect(live.canReadNode({ principal: ctrl, aclChain: [RESTRICTED], visibility: "private" })).toBe(true);
      expect(live.canReadViaIndex(RESTRICTED_IDX, ctrl)).toBe(true);
      expect(live.controllerBypassDecided({ principal: ctrl, aclChain: [RESTRICTED], visibility: "private" })).toBe(true);
      expect(live.canWithAclChain({ principal: owner, action: "read", aclChain: [RESTRICTED], effectiveOwnerUserId: UID })).toBe(true);
      expect(live.canDiscover({ principal: owner, aclChain: [RESTRICTED], visibility: "private", effectiveOwnerUserId: UID })).toBe(true);
      expect(live.canReadNode({ principal: owner, aclChain: [RESTRICTED], visibility: "private", effectiveOwnerUserId: UID })).toBe(true);
      expect(live.canReadViaIndex(RESTRICTED_IDX, owner, ["read"], UID)).toBe(true);
    }
  });

  it("the role shape without a membership flag (RoleContext's null headline, SESS-6) is untouched", () => {
    expect(live.isControllerPrincipal({ role: null, roles: [] })).toBe(false);
    expect(live.isControllerPrincipal({ role: null, roles: ["Admin" as Role] })).toBe(true);
    expect(live.isControllerPrincipal({ role: "DocCtrl" })).toBe(true);
  });
});
