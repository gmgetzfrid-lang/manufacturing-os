// Pins the workspace self-heal ordering contract (audit finding ORGSEL-1).
//
// The defect being pinned: the fallback was `LIMIT 1` with no ORDER BY over a
// multi-org membership set — an arbitrary pick that Postgres does not keep
// stable across updates or plan flips — and the pick was then persisted as
// the new default workspace. The contract: the pick is deterministic, the
// most capable membership wins, and the caller can tell "one membership"
// apart from "a choice among several".

import { describe, it, expect } from "vitest";
import { pickBestMembership } from "@/lib/membershipSelection";

const mem = (over: Record<string, unknown>) => ({
  org_id: "org-x",
  role: "Viewer",
  roles: ["Viewer"],
  status: "active",
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("pickBestMembership", () => {
  it("the Admin membership beats the Viewer membership — the reported failure case", () => {
    // The owner's scenario: Admin in their own workspace, Viewer in a demo
    // workspace. The unordered pick could land them in the demo as a Viewer.
    const admin = mem({ org_id: "org-own", role: "Admin", roles: ["Admin"] });
    const viewer = mem({ org_id: "org-demo", role: "Viewer", roles: ["Viewer"] });
    expect(pickBestMembership([viewer, admin])!.orgId).toBe("org-own");
    expect(pickBestMembership([admin, viewer])!.orgId).toBe("org-own");
  });

  it("is deterministic across repeated resolutions and input orderings", () => {
    const rows = [
      mem({ org_id: "b", role: "Drafter", roles: ["Drafter"] }),
      mem({ org_id: "a", role: "DocCtrl", roles: ["DocCtrl"] }),
      mem({ org_id: "c", role: "Manager", roles: ["Manager"] }),
    ];
    const first = pickBestMembership(rows)!.orgId;
    for (let i = 0; i < 10; i++) {
      expect(pickBestMembership([...rows].reverse())!.orgId).toBe(first);
      expect(pickBestMembership(rows)!.orgId).toBe(first);
    }
    expect(first).toBe("c"); // Manager (90) outranks DocCtrl (70) and Drafter (50)
  });

  it("ranks by the additive collection, not just the headline column", () => {
    // A stale headline must not hide a stronger stacked role.
    const stacked = mem({ org_id: "org-stacked", role: "Requester", roles: ["Requester", "DraftingSupervisor"] });
    const plain = mem({ org_id: "org-plain", role: "Drafter", roles: ["Drafter"] });
    expect(pickBestMembership([plain, stacked])!.orgId).toBe("org-stacked");
  });

  it("breaks rank ties by oldest membership, then org id", () => {
    const older = mem({ org_id: "org-old", created_at: "2025-01-01T00:00:00Z" });
    const newer = mem({ org_id: "org-new", created_at: "2026-02-01T00:00:00Z" });
    expect(pickBestMembership([newer, older])!.orgId).toBe("org-old");

    const sameA = mem({ org_id: "aaa" });
    const sameB = mem({ org_id: "bbb" });
    expect(pickBestMembership([sameB, sameA])!.orgId).toBe("aaa");
  });

  it("reports how many candidates were in the running, so a choice is never silent", () => {
    const one = pickBestMembership([mem({ org_id: "only" })]);
    expect(one!.candidateCount).toBe(1);
    const two = pickBestMembership([mem({ org_id: "a" }), mem({ org_id: "b" })]);
    expect(two!.candidateCount).toBe(2);
  });

  it("stays deterministic when two equal-rank rows both lack a parseable created_at", () => {
    // Regression pin for the NaN-comparator defect: Infinity - Infinity is
    // NaN, which Array.sort treats as 0 — silently skipping the org_id
    // tiebreak and making the pick depend on input order.
    const a = { org_id: "aaa", role: "Viewer", roles: ["Viewer"], status: "active" };
    const b = { org_id: "bbb", role: "Viewer", roles: ["Viewer"], status: "active" };
    expect(pickBestMembership([a, b])!.orgId).toBe("aaa");
    expect(pickBestMembership([b, a])!.orgId).toBe("aaa");

    const c = { ...a, created_at: "not-a-date" };
    const d = { ...b, created_at: "also-not-a-date" };
    expect(pickBestMembership([d, c])!.orgId).toBe("aaa");
  });

  it("tolerates legacy rows: missing roles[], missing created_at, missing org_id", () => {
    const legacy = { org_id: "org-legacy", role: "Admin", status: "active" };
    const broken = { role: "Admin", status: "active" }; // no org_id — unusable
    const pick = pickBestMembership([broken, legacy]);
    expect(pick!.orgId).toBe("org-legacy");
    expect(pick!.candidateCount).toBe(1);
    expect(pickBestMembership([])).toBeNull();
    expect(pickBestMembership([broken])).toBeNull();
  });
});
