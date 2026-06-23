import { describe, it, expect } from "vitest";
import { planRestore, remapRow, type RestoreEnvelopeLike, type CurrentOrgContext } from "@/lib/dataRestore";

function env(overrides: Partial<RestoreEnvelopeLike> = {}): RestoreEnvelopeLike {
  return {
    manifest: { orgId: "OLD_ORG", orgName: "Acme", schemaVersion: "v1", complete: true, files: { count: 2, missing: 0 } },
    tables: {
      org_members: [
        { uid: "u_alice", email: "alice@acme.com", display_name: "Alice", role: "Admin" },
        { uid: "u_bob", email: "bob@acme.com", display_name: "Bob", role: "DocCtrl" },
      ],
      documents: [{ id: "d1", org_id: "OLD_ORG", created_by: "u_alice" }],
      orgs: [{ id: "OLD_ORG", name: "Acme" }],
    },
    files: [{ path: "a" }, { path: "b" }],
    ...overrides,
  };
}

const current = (overrides: Partial<CurrentOrgContext> = {}): CurrentOrgContext => ({
  orgId: "NEW_ORG",
  orgName: "Acme",
  members: [{ uid: "new_alice", email: "alice@acme.com" }],
  ...overrides,
});

describe("planRestore — org name collision", () => {
  it("flags a collision when names differ (Acme vs Acme Inc.)", () => {
    const plan = planRestore(env({ manifest: { orgId: "OLD_ORG", orgName: "Acme Inc." } }), current({ orgName: "Acme" }));
    expect(plan.orgNameCollision).toEqual({ backupName: "Acme Inc.", currentName: "Acme" });
    expect(plan.warnings.some((w) => w.includes("Org name differs"))).toBe(true);
  });

  it("does NOT flag when names match case-insensitively", () => {
    const plan = planRestore(env({ manifest: { orgId: "OLD_ORG", orgName: "acme" } }), current({ orgName: "Acme" }));
    expect(plan.orgNameCollision).toBeNull();
  });
});

describe("planRestore — additive users by email", () => {
  it("links an existing email and creates a new placeholder for an unknown one", () => {
    const plan = planRestore(env(), current()); // alice exists, bob does not
    const alice = plan.users.find((u) => u.email === "alice@acme.com")!;
    const bob = plan.users.find((u) => u.email === "bob@acme.com")!;
    expect(alice.disposition).toBe("linked");
    expect(alice.newUid).toBe("new_alice");
    expect(bob.disposition).toBe("new");
    expect(bob.newUid).toBeUndefined();
    expect(plan.counts.matchedUsers).toBe(1);
    expect(plan.counts.newUsers).toBe(1);
  });

  it("matches email case-insensitively", () => {
    const plan = planRestore(
      env({ tables: { org_members: [{ uid: "u_a", email: "ALICE@acme.com" }] } }),
      current({ members: [{ uid: "new_alice", email: "alice@acme.com" }] }),
    );
    expect(plan.users[0].disposition).toBe("linked");
    expect(plan.users[0].newUid).toBe("new_alice");
  });

  it("dedupes duplicate emails in the backup", () => {
    const plan = planRestore(
      env({ tables: { org_members: [
        { uid: "u1", email: "dup@acme.com" },
        { uid: "u2", email: "dup@acme.com" },
      ] } }),
      current({ members: [] }),
    );
    expect(plan.users).toHaveLength(1);
  });

  it("warns when the backup has no members", () => {
    const plan = planRestore(env({ tables: { documents: [] } }), current());
    expect(plan.users).toHaveLength(0);
    expect(plan.warnings.some((w) => w.includes("No members"))).toBe(true);
  });
});

describe("planRestore — id remap", () => {
  it("always maps backup org_id to the current workspace org_id", () => {
    const plan = planRestore(env(), current());
    expect(plan.idRemap.orgId).toEqual({ OLD_ORG: "NEW_ORG" });
  });

  it("maps uid only for linked users", () => {
    const plan = planRestore(env(), current());
    expect(plan.idRemap.uid).toEqual({ u_alice: "new_alice" });
    expect(plan.idRemap.uid.u_bob).toBeUndefined();
  });
});

describe("planRestore — table plan + counts", () => {
  it("skips identity/config tables and counts only importable rows", () => {
    const plan = planRestore(env(), current());
    const orgs = plan.counts.tables.find((t) => t.name === "orgs")!;
    const members = plan.counts.tables.find((t) => t.name === "org_members")!;
    const docs = plan.counts.tables.find((t) => t.name === "documents")!;
    expect(orgs.willImport).toBe(false);
    expect(orgs.reason).toBeTruthy();
    expect(members.willImport).toBe(false);
    expect(docs.willImport).toBe(true);
    expect(plan.counts.totalRows).toBe(1); // only documents' 1 row
    expect(plan.counts.files).toBe(2);
  });
});

describe("planRestore — warnings", () => {
  it("warns on an incomplete backup and on missing files", () => {
    const plan = planRestore(
      env({ manifest: { orgId: "OLD_ORG", orgName: "Acme", complete: false, files: { count: 5, missing: 3 } } }),
      current(),
    );
    expect(plan.warnings.some((w) => w.includes("INCOMPLETE"))).toBe(true);
    expect(plan.warnings.some((w) => w.includes("3 referenced file"))).toBe(true);
  });
});

describe("remapRow", () => {
  const idRemap = { orgId: { OLD_ORG: "NEW_ORG" }, uid: { u_alice: "new_alice" } };

  it("remaps org_id and known uid columns without mutating input", () => {
    const row = { id: "d1", org_id: "OLD_ORG", created_by: "u_alice", user_id: "u_alice" };
    const out = remapRow(row, idRemap);
    expect(out.org_id).toBe("NEW_ORG");
    expect(out.created_by).toBe("new_alice");
    expect(out.user_id).toBe("new_alice");
    expect(row.org_id).toBe("OLD_ORG"); // original untouched
  });

  it("leaves unmapped uids alone (new users resolved at apply time)", () => {
    const row = { org_id: "OLD_ORG", created_by: "u_bob" };
    const out = remapRow(row, idRemap);
    expect(out.created_by).toBe("u_bob");
  });
});
