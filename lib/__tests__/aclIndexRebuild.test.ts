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
}));

function chain(table: string) {
  let pendingPatch: Record<string, unknown> | null = null;
  const c: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve({ data: state.tables[table] ?? [], error: null });
      }
      return (...args: unknown[]) => {
        if (prop === "update") pendingPatch = args[0] as Record<string, unknown>;
        if (prop === "eq" && pendingPatch) {
          const [col, val] = args as [string, string];
          if (col === "id") { state.updates.push({ table, patch: pendingPatch, id: val }); pendingPatch = null; return Promise.resolve({ error: null }); }
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
});
