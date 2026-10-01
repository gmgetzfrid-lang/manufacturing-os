import { describe, it, expect } from "vitest";
import {
  planRestore, remapRow, orderTablesForRestore, mergeNewUserUids, type RestoreEnvelopeLike, type CurrentOrgContext,
  CONFLICT_TARGETS, conflictTargetFor, RESTORE_CONTRACT_TABLES, isSkippedTable, skipReasonFor, isImmutableTable,
  RESTORE_TABLE_ORDER, RESTORE_PARENT_RULES, RESTORE_FK_PARENT_WAIVERS, ORG_LESS_RESTORE_PARENTS, restoreParentRulesFor,
  restoreRowsInOrder, restoreTableRefusal,
} from "@/lib/dataRestore";
import { censusSchema } from "./helpers/schemaKeys";

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

describe("orderTablesForRestore", () => {
  it("puts parents before children (documents before document_versions)", () => {
    const ordered = orderTablesForRestore(["document_versions", "documents", "libraries"]);
    expect(ordered.indexOf("libraries")).toBeLessThan(ordered.indexOf("documents"));
    expect(ordered.indexOf("documents")).toBeLessThan(ordered.indexOf("document_versions"));
  });
  it("appends unknown tables after known ones, alphabetically", () => {
    const ordered = orderTablesForRestore(["zeta_custom", "documents", "alpha_custom"]);
    expect(ordered[0]).toBe("documents");
    expect(ordered.indexOf("alpha_custom")).toBeLessThan(ordered.indexOf("zeta_custom"));
  });
});

describe("mergeNewUserUids", () => {
  it("folds created uids into the remap without mutating the original", () => {
    const base = { orgId: { O: "N" }, uid: { a: "A" } };
    const merged = mergeNewUserUids(base, { b: "B" });
    expect(merged.uid).toEqual({ a: "A", b: "B" });
    expect(base.uid).toEqual({ a: "A" }); // untouched
  });
});

// BKP-12 (admin-and-org Round G): the conflict-target tripwire. Every table a
// restore writes upserts ON CONFLICT (<target>) DO NOTHING; a target that is
// not one of the table's PRIMARY KEY / UNIQUE keys makes Postgres refuse the
// whole chunk (42703 / 42P10), so a re-run of the "additive and safe" restore
// fails that table. The census reads supabase/ (schema.sql + migrations).
describe("BKP-12 — every restorable table's conflict target is a real key", () => {
  const schema = censusSchema();

  it("the census sees keys (sanity): composite PK, single-column PK, table UNIQUE, unique index", () => {
    expect(schema.get("recently_viewed_docs")?.keys).toContainEqual(["user_id", "document_id"]);
    expect(schema.get("codebook_config")?.keys).toContainEqual(["org_id"]);
    expect(schema.get("project_members")?.keys).toContainEqual(["project_id", "user_id"]);
    expect(schema.get("documents")?.keys).toContainEqual(["id"]);
  });

  it("the four id-less tables the finding names have their real key as target", () => {
    expect(conflictTargetFor("codebook_config")).toBe("org_id");
    expect(conflictTargetFor("document_equipment_suggestions")).toBe("org_id,document_id");
    expect(conflictTargetFor("recently_viewed_docs")).toBe("user_id,document_id");
    expect(conflictTargetFor("library_numbering")).toBe("library_id");
  });

  it("for EVERY restorable contract table, conflictTargetFor names a PRIMARY KEY or UNIQUE key of that table", () => {
    const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((c) => b.includes(c));
    const bad: string[] = [];
    for (const table of [...RESTORE_CONTRACT_TABLES].filter((t) => !isSkippedTable(t)).sort()) {
      const target = conflictTargetFor(table).split(",").map((c) => c.trim());
      const keys = schema.get(table)?.keys ?? [];
      if (!keys.some((k) => sameSet(k, target))) bad.push(`${table} (target ${target.join(",")}; keys ${JSON.stringify(keys)})`);
    }
    expect(bad, `conflict targets that are not a key — add the real key to CONFLICT_TARGETS: ${bad.join("; ")}`).toEqual([]);
  });

  it("every CONFLICT_TARGETS entry names a contract table, and its target is a real key there too", () => {
    const stale = Object.keys(CONFLICT_TARGETS).filter((t) => !RESTORE_CONTRACT_TABLES.has(t));
    expect(stale).toEqual([]);
    // org_configurations is append-only to the restore (SURF-8) but keeps its documented key
    expect(schema.get("org_configurations")?.keys).toContainEqual(["org_id", "key"]);
  });
});

// admin-and-org Round G, P1 fix pass. The restore stops at the first table
// that fails, so a parent restored AFTER its child stops every restore of an
// org that has such a row (a checkout session with an episode, a document in
// a set, a library with an owner team, a knowledge mention). The census reads
// every FOREIGN KEY in supabase/ (inline, table-level, ALTER … ADD) less the
// ones a later migration drops (intelligence ILIFE-2's done-when 2).
describe("FK order — every parent is restored before its child (census of supabase/)", () => {
  const schema = censusSchema();
  const idx = (t: string) => RESTORE_TABLE_ORDER.indexOf(t);

  it("the census sees foreign keys (sanity): inline, table-level, ALTER … ADD COLUMN, ALTER … ADD CONSTRAINT, and drops", () => {
    const fk = (t: string, c: string) => schema.get(t)?.fks.find((f) => f.columns.length === 1 && f.columns[0] === c)?.parent;
    expect(fk("checkout_sessions", "episode_id")).toBe("checkout_episodes");
    expect(fk("libraries", "owner_team_id")).toBe("teams");               // 20261045: ALTER … ADD CONSTRAINT inside DO $$
    expect(fk("knowledge_documents", "source_document_id")).toBe("documents"); // 20261122
    expect(fk("entity_mentions", "knowledge_document_id")).toBe("knowledge_documents");
    expect(fk("team_members", "team_id")).toBe("teams");
    expect(fk("documents", "authored_by_link_id")).toBeUndefined();        // 20261104 drops it (restore order)
    expect(fk("project_intake_links", "project_id")).toBeUndefined();      // 20261104 drops it
    expect(fk("users", "id")).toBe("auth.users");
  });

  it("for EVERY foreign key between two tables RESTORE_TABLE_ORDER places, the parent comes first", () => {
    const inverted: string[] = [];
    for (const child of RESTORE_TABLE_ORDER) {
      for (const f of schema.get(child)?.fks ?? []) {
        if (f.parent === child || idx(f.parent) < 0) continue;
        if (idx(f.parent) > idx(child)) inverted.push(`${child}.${f.columns.join("+")} -> ${f.parent} (child ${idx(child)}, parent ${idx(f.parent)})`);
      }
    }
    expect(inverted, `parents restored after their children: ${inverted.join("; ")}`).toEqual([]);
  });

  it("the eight inversions the review named are fixed, and the knowledge layer precedes its referrers (I-01 phase B)", () => {
    const before = (a: string, b: string) => expect(idx(a), `${a} before ${b}`).toBeLessThan(idx(b));
    before("checkout_episodes", "checkout_sessions");
    before("teams", "libraries");
    before("document_sets", "documents");
    before("documents", "projects");
    before("knowledge_documents", "process_flows");
    before("knowledge_documents", "entity_mentions");
    before("knowledge_libraries", "knowledge_documents");
    before("knowledge_sources", "knowledge_documents");
    before("tickets", "milestones");
    before("tickets", "document_holds");
  });

  it("orderTablesForRestore follows the order", () => {
    expect(orderTablesForRestore(["checkout_sessions", "libraries", "checkout_episodes", "teams", "entity_mentions", "knowledge_documents"]))
      .toEqual(["teams", "libraries", "knowledge_documents", "entity_mentions", "checkout_episodes", "checkout_sessions"]);
  });
});

// ORG-1 (fix pass): forcing org_id bounds a restored ROW; RESTORE_PARENT_RULES
// bounds what it points at. Every foreign key of a restorable table must be
// covered: a parent with an org_id by a rule (checked in the target
// workspace), a parent without one by a written waiver.
describe("ORG-1 — every restorable foreign key is bounded to the target workspace, or waived in writing", () => {
  const schema = censusSchema();
  const restorable = [...RESTORE_CONTRACT_TABLES].filter((t) => !isSkippedTable(t)).sort();

  it("a foreign key to an org-scoped parent has a rule; one to a parent with no org_id names a waived parent", () => {
    const missing: string[] = [];
    for (const table of restorable) {
      for (const f of schema.get(table)?.fks ?? []) {
        const parentHasOrg = schema.get(f.parent)?.columns.has("org_id") ?? false;
        if (!parentHasOrg) {
          if (!Object.prototype.hasOwnProperty.call(RESTORE_FK_PARENT_WAIVERS, f.parent)) missing.push(`${table}.${f.columns.join("+")} -> ${f.parent} (no org_id, no waiver)`);
          continue;
        }
        const covered = f.columns.length === 1 && f.parentColumns.join(",") === "id"
          && restoreParentRulesFor(table).some((r) => r.column === f.columns[0] && r.parent === f.parent);
        if (!covered) missing.push(`${table}.${f.columns.join("+")} -> ${f.parent}(${f.parentColumns.join(",")})`);
      }
    }
    expect(missing, `restorable foreign keys with no parent rule (add to RESTORE_PARENT_RULES) or waiver: ${missing.join("; ")}`).toEqual([]);
  });

  it("every rule is a real foreign key of a restorable table, onto a parent that has org_id (no stale or invented rules)", () => {
    const stale: string[] = [];
    for (const [table, rules] of Object.entries(RESTORE_PARENT_RULES)) {
      if (!restorable.includes(table)) stale.push(`${table} (not restorable)`);
      for (const r of rules) {
        const real = schema.get(table)?.fks.some((f) => f.columns.length === 1 && f.columns[0] === r.column && f.parent === r.parent);
        if (!real) stale.push(`${table}.${r.column} -> ${r.parent}`);
        if (!schema.get(r.parent)?.columns.has("org_id")) stale.push(`${r.parent} has no org_id`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("the review's minimum set is covered, and the org-less tables' bounding parents are rules too", () => {
    const rule = (t: string, c: string, p: string) => expect(restoreParentRulesFor(t), `${t}.${c}`).toContainEqual({ column: c, parent: p });
    rule("team_members", "team_id", "teams");
    for (const t of ["checkout_episodes", "checkout_sessions", "document_intents", "revision_branches"]) rule(t, "document_id", "documents");
    rule("project_documents", "project_id", "projects");
    rule("project_documents", "document_id", "documents");
    rule("document_versions", "record_id", "documents");
    for (const [t, b] of Object.entries(ORG_LESS_RESTORE_PARENTS)) rule(t, b.column, b.parent);
    expect(Object.keys(RESTORE_FK_PARENT_WAIVERS).sort()).toEqual(["orgs", "users"]);
  });
});

describe("restoreRowsInOrder — a self-referencing table's rows go parents first", () => {
  it("a version chain written newest-first is reordered oldest-first; other rows keep their order", () => {
    const rows = [
      { id: "v3", supersedes_version_id: "v2" },
      { id: "x", supersedes_version_id: null },
      { id: "v2", supersedes_version_id: "v1" },
      { id: "v1", supersedes_version_id: null },
    ];
    expect(restoreRowsInOrder("document_versions", rows).map((r) => r.id)).toEqual(["v1", "v2", "v3", "x"]);
  });
  it("a cycle is broken where it closes (every row is kept once); a table with no self-reference is untouched", () => {
    const cyc = [{ id: "a", parent_id: "b" }, { id: "b", parent_id: "a" }, { id: "c", parent_id: "a" }];
    const out = restoreRowsInOrder("collections", cyc).map((r) => r.id);
    expect([...out].sort()).toEqual(["a", "b", "c"]);
    expect(out.indexOf("a")).toBeLessThan(out.indexOf("c"));
    const flat = [{ id: "2" }, { id: "1" }];
    expect(restoreRowsInOrder("notes", flat)).toEqual(flat);
  });
  it("a deep chain (5,000 links) does not overflow the stack", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ id: `m${i}`, parent_id: i === 0 ? null : `m${i - 1}` })).reverse();
    const out = restoreRowsInOrder("milestones", rows);
    expect(out[0].id).toBe("m0");
    expect(out[4999].id).toBe("m4999");
  });
});

// The restore's lookups are own-key only: a name or a value that happens to
// be an Object.prototype key is data, never a lookup hit.
describe("prototype keys are plain data to the restore", () => {
  it("a table named after an Object.prototype key is off contract, never skipped-with-a-function-reason", () => {
    const env = JSON.parse('{"manifest":{"orgId":"b"},"tables":{"constructor":[{}],"__proto__":[{}],"toString":[{}],"notes":[{}]}}') as RestoreEnvelopeLike;
    const plan = planRestore(env, { orgId: "c", orgName: "", members: [] });
    for (const name of ["constructor", "__proto__", "toString"]) {
      const t = plan.counts.tables.find((x) => x.name === name);
      expect(t, name).toMatchObject({ willImport: false, offContract: true, reason: "not part of the backup contract — never imported" });
      expect(isSkippedTable(name), name).toBe(false);
      expect(isImmutableTable(name), name).toBe(false);
      expect(skipReasonFor(name), name).toBeNull();
      expect(restoreTableRefusal(name), name).toMatch(/not part of the backup contract/);
      expect(conflictTargetFor(name), name).toBe("id");
      expect(restoreParentRulesFor(name), name).toEqual([]);
    }
    expect(plan.counts.totalRows).toBe(1);
  });
  it("a text value that is an Object.prototype key is kept, not swapped for a function", () => {
    const out = remapRow({ id: "n1", org_id: "constructor", body: "toString", tags: ["valueOf", "hasOwnProperty"] }, { orgId: { b: "c" }, uid: {} });
    expect(out).toMatchObject({ body: "toString", tags: ["valueOf", "hasOwnProperty"] });
    expect(typeof out.org_id).toBe("string");
  });
});
