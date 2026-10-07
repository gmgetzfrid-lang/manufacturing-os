// NEDGE-8 (notifications Round G, N9): a restore brings the watch/follow graph
// back. `subscriptions` was in SKIP_TABLES under a billing reason — but the
// table is the follow store every `followers: true` notice resolves through
// (lib/subscriptions.ts, lib/notify/recipients.ts), and billing state lives
// on the orgs row (lib/subscription.ts). So every restore dropped every
// document / project / asset / library follow and reported it as deliberate.
//
// Pinned here, through the one shared write (applyRestoreChunk) on the
// in-memory service-role stand-in:
//   · the table is restorable, ordered after every resource it can name, and
//     upserts on its real key (user, type, id) — a follow already held is kept;
//   · a restored follow names the RECONCILED person (uid remap) and lands in
//     the target workspace: a non-zero subscriptions count afterwards;
//   · its resource is bounded like a foreign key: a follow of a resource that
//     is not a row of this workspace, or of a type with no table, is refused.

import { describe, it, expect, beforeEach } from "vitest";
import { db, from, type Row } from "./helpers/restoreMemoryDb";
import {
  applyRestoreChunk, conflictTargetFor, isSkippedTable, planRestore, RESTORE_POLYMORPHIC_PARENTS,
  restorePolymorphicParentFor, RESTORE_TABLE_ORDER, restoreTableRefusal, skipReasonFor,
} from "@/lib/dataRestore";
import { censusSchema } from "./helpers/schemaKeys";

const ORG = "org-target";
const OTHER = "org-other";
const remap = { orgId: { "backup-org": ORG }, uid: { "old-alice": "new-alice", "old-bob": "new-bob" } };
const sb = { from } as never;
const subs = () => (db.rows.subscriptions ?? []) as Row[];

beforeEach(() => {
  db.rows = {
    orgs: [{ id: ORG, name: "Acme" }, { id: OTHER, name: "Other" }],
    documents: [{ id: "doc-1", org_id: ORG }, { id: "doc-2", org_id: ORG }, { id: "doc-foreign", org_id: OTHER }],
    projects: [{ id: "proj-1", org_id: ORG }],
    assets: [{ id: "asset-1", org_id: ORG }],
    libraries: [{ id: "lib-1", org_id: ORG }],
    tickets: [{ id: "t-1", org_id: ORG }],
  };
  // The real unique key (20260622 / 20260723: subscriptions_user_resource_uniq).
  db.keys = { subscriptions: [["id"], ["user_id", "resource_type", "resource_id"]] };
  db.writeError = null;
  db.readError = {};
  db.writes = [];
  db.attempts = [];
  db.countless = false;
  db.fks = {};
  db.maxRows = 1000;
  db.generated = {};
  db.authUsers = null;
});

const follow = (id: string, user: string, type: string, resource: string): Row =>
  ({ id, org_id: "backup-org", user_id: user, resource_type: type, resource_id: resource, created_at: "2026-09-01T00:00:00Z" });

describe("NEDGE-8 — the watch/follow table is restorable", () => {
  it("is no longer skipped (the billing reason named the wrong table) and is a restore position", () => {
    expect(isSkippedTable("subscriptions")).toBe(false);
    expect(skipReasonFor("subscriptions")).toBeFalsy();
    expect(restoreTableRefusal("subscriptions")).toBeNull();
    expect(RESTORE_TABLE_ORDER).toContain("subscriptions");
    // push_subscriptions (device registrations) stays skipped — a different table.
    expect(isSkippedTable("push_subscriptions")).toBe(true);
  });

  it("is ordered after every resource table a follow can name", () => {
    const at = RESTORE_TABLE_ORDER.indexOf("subscriptions");
    for (const parent of Object.values(RESTORE_POLYMORPHIC_PARENTS.subscriptions.parents)) {
      expect(RESTORE_TABLE_ORDER.indexOf(parent), parent).toBeGreaterThanOrEqual(0);
      expect(RESTORE_TABLE_ORDER.indexOf(parent), parent).toBeLessThan(at);
    }
  });

  it("upserts on its real unique key — the one lib/subscriptions.ts watch() upserts on — and the schema has it", () => {
    expect(conflictTargetFor("subscriptions")).toBe("user_id,resource_type,resource_id");
    const keys = censusSchema().get("subscriptions")?.keys ?? [];
    expect(keys).toContainEqual(["user_id", "resource_type", "resource_id"]);
  });

  it("every resource type the app follows has a bounded table (lib/subscriptions.ts WatchResourceType + tickets)", () => {
    const poly = restorePolymorphicParentFor("subscriptions")!;
    expect(poly).toMatchObject({ typeColumn: "resource_type", idColumn: "resource_id" });
    expect(Object.keys(poly.parents).sort()).toEqual(["asset", "document", "library", "project", "ticket"]);
    expect(restorePolymorphicParentFor("documents")).toBeNull();
  });

  it("the restore plan imports it now", () => {
    const plan = planRestore(
      { manifest: { orgId: "backup-org", orgName: "Acme" }, tables: { org_members: [], subscriptions: [follow("s1", "old-alice", "document", "doc-1")] } },
      { orgId: ORG, orgName: "Acme", members: [] },
    );
    const item = plan.counts.tables.find((t) => t.name === "subscriptions");
    expect(item?.willImport).toBe(true);
  });
});

describe("NEDGE-8 — a restore brings the follows back, remapped and bounded", () => {
  it("lands every follow of this workspace's resources under the reconciled person: a non-zero count afterwards", async () => {
    const r = await applyRestoreChunk(sb, {
      orgId: ORG, table: "subscriptions", idRemap: remap,
      rows: [
        follow("s1", "old-alice", "document", "doc-1"),
        follow("s2", "old-alice", "project", "proj-1"),
        follow("s3", "old-bob", "asset", "asset-1"),
        follow("s4", "old-bob", "library", "lib-1"),
        follow("s5", "old-bob", "ticket", "t-1"),
      ],
    });
    expect(r).toMatchObject({ ok: true, inserted: 5, refused: [] });
    expect(subs().length).toBeGreaterThan(0);
    expect(subs().map((s) => [s.org_id, s.user_id, s.resource_type, s.resource_id])).toEqual([
      [ORG, "new-alice", "document", "doc-1"],
      [ORG, "new-alice", "project", "proj-1"],
      [ORG, "new-bob", "asset", "asset-1"],
      [ORG, "new-bob", "library", "lib-1"],
      [ORG, "new-bob", "ticket", "t-1"],
    ]);
    // No row names a backup uid.
    expect(subs().some((s) => String(s.user_id).startsWith("old-"))).toBe(false);
  });

  it("a follow the person already holds here is kept as it is (existing) — never refused 23505 — and a re-run writes nothing", async () => {
    db.rows.subscriptions = [{ id: "live-1", org_id: ORG, user_id: "new-alice", resource_type: "document", resource_id: "doc-1" }];
    const first = await applyRestoreChunk(sb, {
      orgId: ORG, table: "subscriptions", idRemap: remap,
      rows: [follow("s1", "old-alice", "document", "doc-1"), follow("s2", "old-alice", "document", "doc-2")],
    });
    expect(first).toMatchObject({ ok: true, inserted: 1, existing: 1, refused: [] });
    const again = await applyRestoreChunk(sb, {
      orgId: ORG, table: "subscriptions", idRemap: remap,
      rows: [follow("s1", "old-alice", "document", "doc-1"), follow("s2", "old-alice", "document", "doc-2")],
    });
    expect(again).toMatchObject({ ok: true, inserted: 0, existing: 2, refused: [] });
    expect(subs()).toHaveLength(2);
  });

  it("a follow of another workspace's resource, a missing one, or an unknown type is refused and never written", async () => {
    const r = await applyRestoreChunk(sb, {
      orgId: ORG, table: "subscriptions", idRemap: remap,
      rows: [
        follow("s-ok", "old-alice", "document", "doc-1"),
        follow("s-foreign", "old-alice", "document", "doc-foreign"),
        follow("s-gone", "old-alice", "project", "proj-deleted"),
        follow("s-type", "old-alice", "invoice", "doc-1"),
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.inserted).toBe(1);
    expect(r.refused.map((x) => [x.id, x.code])).toEqual([
      ["s-foreign", "parent_outside_workspace"],
      ["s-gone", "parent_outside_workspace"],
      ["s-type", "parent_outside_workspace"],
    ]);
    expect(r.refused[0].message).toMatch(/resource_id doc-foreign is not a documents row of this workspace/);
    expect(r.refused[2].message).toMatch(/resource_type "invoice" is not a resource a restore can bound/);
    expect(subs().map((s) => s.id)).toEqual(["s-ok"]);
  });

  it("a backup member the reconciliation could not map is refused (the row would name a raw backup uid)", async () => {
    const r = await applyRestoreChunk(sb, {
      orgId: ORG, table: "subscriptions",
      idRemap: { ...remap, unmappedUids: ["old-ghost"] },
      rows: [follow("s-ghost", "old-ghost", "document", "doc-1")],
    });
    expect(r.refused.map((x) => x.code)).toEqual(["person_not_mapped"]);
    expect(subs()).toEqual([]);
  });

  it("an unreadable resource table fails the chunk closed — nothing is written on a guess", async () => {
    db.readError = { documents: "statement timeout" };
    const r = await applyRestoreChunk(sb, {
      orgId: ORG, table: "subscriptions", idRemap: remap,
      rows: [follow("s1", "old-alice", "document", "doc-1")],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Could not check the documents rows/);
    expect(subs()).toEqual([]);
  });
});
