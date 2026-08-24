// acl_index expiry-aware build + nightly rebuild (DB-4 / OWN-7 / DEC-10).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildAclIndexFromRules, buildAclIndexFromChain } from "@/lib/acl";
import type { AccessControl, AccessRule } from "@/types/schema";

const allow = (id: string, ...actions: string[]): AccessRule =>
  ({ effect: "allow", subject: { type: "role", id }, actions: actions as AccessRule["actions"] });
const withExpiry = (r: AccessRule, expiresAt: string): AccessRule => ({ ...r, expiresAt });

describe("buildAclIndexFromRules — expiry filtering (OWN-7)", () => {
  it("keeps every rule when no clock is passed (byte-identical to before)", () => {
    const rules = [withExpiry(allow("Drafter", "publish"), "2000-01-01T00:00:00Z")];
    const idx = buildAclIndexFromRules(rules); // no nowMs
    expect(idx?.allow.roles?.publish).toContain("Drafter");
  });

  it("drops an expired rule when a clock is passed", () => {
    const rules = [withExpiry(allow("Drafter", "publish"), "2000-01-01T00:00:00Z")];
    const idx = buildAclIndexFromRules(rules, Date.parse("2026-08-24T00:00:00Z"));
    // The only rule expired → the index is empty (null).
    expect(idx).toBeNull();
  });

  it("keeps an unexpired rule and drops an expired sibling", () => {
    const rules = [
      allow("Admin", "publish"),
      withExpiry(allow("Drafter", "publish"), "2000-01-01T00:00:00Z"),
    ];
    const idx = buildAclIndexFromRules(rules, Date.parse("2026-08-24T00:00:00Z"));
    expect(idx?.allow.roles?.publish).toContain("Admin");
    expect(idx?.allow.roles?.publish ?? []).not.toContain("Drafter");
  });
});

describe("buildAclIndexFromChain — expiry threads through the chain", () => {
  it("drops an expired ancestor grant during rebuild", () => {
    const lib: AccessControl = { rules: [withExpiry(allow("Drafter", "read"), "2000-01-01T00:00:00Z")] };
    const doc: AccessControl = { rules: [allow("Admin", "read")] };
    const idx = buildAclIndexFromChain([lib, doc], Date.parse("2026-08-24T00:00:00Z"));
    expect(idx?.allow.roles?.read).toContain("Admin");
    expect(idx?.allow.roles?.read ?? []).not.toContain("Drafter");
  });
});

// ── Rebuild walk ─────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  updates: [] as Array<{ table: string; patch: Record<string, unknown>; id: string }>,
  readErrors: {} as Record<string, string>,
  writeErrors: {} as Record<string, string>,
}));

function chain(table: string) {
  let pendingPatch: Record<string, unknown> | null = null;
  const c: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) =>
          resolve(state.readErrors[table]
            ? { data: null, error: { message: state.readErrors[table] } }
            : { data: state.tables[table] ?? [], error: null });
      }
      return (...args: unknown[]) => {
        if (prop === "update") pendingPatch = args[0] as Record<string, unknown>;
        if (prop === "eq" && pendingPatch) {
          const [col, val] = args as [string, string];
          if (col === "id") {
            const patch = pendingPatch;
            pendingPatch = null;
            if (state.writeErrors[table]) return Promise.resolve({ error: { message: state.writeErrors[table] } });
            state.updates.push({ table, patch, id: val });
            return Promise.resolve({ error: null });
          }
        }
        return new Proxy(c, handler);
      };
    },
  };
  return new Proxy(c, handler);
}

const sb = { from: (t: string) => chain(t) } as unknown as import("@supabase/supabase-js").SupabaseClient;

import { rebuildAclIndexes } from "@/lib/aclIndexRebuild";

beforeEach(() => {
  state.tables = {};
  state.updates = [];
  state.readErrors = {};
  state.writeErrors = {};
});

describe("rebuildAclIndexes (DB-4 / DEC-10)", () => {
  it("rewrites a document whose stored index is stale, and skips a correct one", async () => {
    // The "correct" stored value is whatever the real builder produces for the
    // inherited chain — production indexes carry the full bucket shape.
    const libAcl: AccessControl = { rules: [allow("Drafter", "read")] };
    const correctIdx = buildAclIndexFromChain([libAcl], Date.parse("2026-08-24T00:00:00Z"));
    state.tables.orgs = [{ id: "org1" }];
    // library index is already correct so the library is not rewritten.
    state.tables.libraries = [{ id: "lib1", acl: libAcl, acl_index: correctIdx }];
    state.tables.collections = [];
    state.tables.documents = [
      // stale: stored index empty though it should inherit Drafter read
      { id: "docStale", library_id: "lib1", collection_id: null, acl: null, acl_index: null },
      // correct: stored index already matches the recompute
      { id: "docOk", library_id: "lib1", collection_id: null, acl: null, acl_index: correctIdx },
    ];
    const counts = await rebuildAclIndexes(sb, Date.parse("2026-08-24T00:00:00Z"));
    const docUpdates = state.updates.filter((u) => u.table === "documents").map((u) => u.id);
    expect(docUpdates).toContain("docStale");
    expect(docUpdates).not.toContain("docOk");
    expect(counts.documents).toBe(1);
  });

  it("drops an expired grant from a rebuilt index (OWN-7)", async () => {
    state.tables.orgs = [{ id: "org1" }];
    state.tables.libraries = [{ id: "lib1", acl: { rules: [withExpiry(allow("Drafter", "read"), "2000-01-01T00:00:00Z")] }, acl_index: { allow: { roles: { read: ["Drafter"] } }, deny: {} } }];
    state.tables.collections = [];
    state.tables.documents = [];
    await rebuildAclIndexes(sb, Date.parse("2026-08-24T00:00:00Z"));
    const libUpdate = state.updates.find((u) => u.table === "libraries" && u.id === "lib1");
    expect(libUpdate).toBeDefined();
    // The expired grant is gone → recomputed index is null.
    expect(libUpdate!.patch.acl_index).toBeNull();
  });

  it("skips the whole org when any read fails — never rebuilds from partial data", async () => {
    // A failed collections read must not strip folder rules from every
    // document's rebuilt index; the org is skipped and the failure reported.
    state.tables.orgs = [{ id: "org1" }];
    state.tables.libraries = [{ id: "lib1", acl: { rules: [allow("Drafter", "read")] }, acl_index: null }];
    state.tables.documents = [{ id: "doc1", library_id: "lib1", collection_id: null, acl: null, acl_index: null }];
    state.readErrors.collections = "statement timeout";
    const counts = await rebuildAclIndexes(sb, Date.parse("2026-08-24T00:00:00Z"));
    expect(state.updates).toHaveLength(0);
    expect(counts.orgs).toBe(0);
    expect(counts.errors.some((e) => e.includes("org1") && e.includes("statement timeout"))).toBe(true);
  });

  it("skips a node with a dangling ancestor instead of rebuilding it ruleless", async () => {
    state.tables.orgs = [{ id: "org1" }];
    state.tables.libraries = [{ id: "lib1", acl: { rules: [allow("Drafter", "read")] }, acl_index: buildAclIndexFromChain([{ rules: [allow("Drafter", "read")] }], 0) }];
    state.tables.collections = [];
    state.tables.documents = [
      // stale index AND a collection_id that resolves to no fetched folder —
      // rebuilding would strip the missing ancestor's rules, so it must skip.
      { id: "docDangling", library_id: "lib1", collection_id: "ghost", acl: null, acl_index: null },
    ];
    const counts = await rebuildAclIndexes(sb, Date.parse("2026-08-24T00:00:00Z"));
    expect(state.updates.filter((u) => u.table === "documents")).toHaveLength(0);
    expect(counts.errors.some((e) => e.includes("docDangling") && e.includes("ghost"))).toBe(true);
  });

  it("surfaces a write failure in errors instead of reporting silent success", async () => {
    state.tables.orgs = [{ id: "org1" }];
    state.tables.libraries = [{ id: "lib1", acl: { rules: [allow("Drafter", "read")] }, acl_index: null }];
    state.tables.collections = [];
    state.tables.documents = [];
    state.writeErrors.libraries = "permission denied";
    const counts = await rebuildAclIndexes(sb, Date.parse("2026-08-24T00:00:00Z"));
    expect(counts.libraries).toBe(0);
    expect(counts.errors.some((e) => e.includes("lib1") && e.includes("permission denied"))).toBe(true);
  });

  it("rebuilds a stale document_sets index from the library→set chain", async () => {
    // document_sets is RLS-gated directly on its own acl_index
    // (document_sets_acl_select, 20260813) — a stale set index is as
    // fail-open as a stale document index, so the walk must cover it.
    const libAcl: AccessControl = { rules: [allow("Drafter", "read")] };
    state.tables.orgs = [{ id: "org1" }];
    state.tables.libraries = [{ id: "lib1", acl: libAcl, acl_index: buildAclIndexFromChain([libAcl], 0) }];
    state.tables.collections = [];
    state.tables.documents = [];
    state.tables.document_sets = [
      { id: "set1", library_id: "lib1", acl: { rules: [withExpiry(allow("Viewer", "read"), "2000-01-01T00:00:00Z")] }, acl_index: { allow: { roles: { read: ["Drafter", "Viewer"] } }, deny: {} } },
    ];
    const counts = await rebuildAclIndexes(sb, Date.parse("2026-08-24T00:00:00Z"));
    const setUpdate = state.updates.find((u) => u.table === "document_sets" && u.id === "set1");
    expect(setUpdate).toBeDefined();
    const idx = setUpdate!.patch.acl_index as { allow: { roles?: Record<string, string[]> } };
    // Library grant survives; the set's own expired grant is dropped.
    expect(idx.allow.roles?.read).toContain("Drafter");
    expect(idx.allow.roles?.read ?? []).not.toContain("Viewer");
    expect(counts.sets).toBe(1);
  });
});
