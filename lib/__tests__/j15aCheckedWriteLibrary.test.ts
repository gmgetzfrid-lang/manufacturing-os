// projects-tab SAF-18 — the J15 checked-write sweep, batch J15a (the
// document-control / library files), part 1 of 3: the library's own
// collections, folders, views, favourites, follows and the asset registry.
//
// Every update / delete in these files now reads its matched rows (DEC-90's
// rulings): a person's decision that matched no row is the typed refusal
// (class a — nothing claims it happened); a zero-row match that is legitimate
// (class c — already unfavourited, nothing to clear) stays a success while a
// database error is never silent; bookkeeping (class b — a descendant's
// path) never fails the act and is said when it did not land. Each case
// below also pins the success path: the same write, the same filters, the
// same answer as before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Op = { m: string; args: unknown[] };
type Call = { table: string; ops: Op[] };
const h = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; ops: Array<{ m: string; args: unknown[] }> }>,
  /** `${table}:${kind}` → an answer, or a function of the call. A write with
   *  no answer set matches one row (PostgREST's RETURNING); a read answers
   *  nothing. */
  answers: {} as Record<string, unknown>,
}));
vi.mock("@/lib/supabase", () => {
  const WRITES = ["update", "delete", "insert", "upsert"];
  const kind = (ops: Array<{ m: string }>) => WRITES.find((k) => ops.some((o) => o.m === k)) ?? "select";
  const answer = (call: { table: string; ops: Array<{ m: string; args: unknown[] }> }) => {
    const a = h.answers[`${call.table}:${kind(call.ops)}`];
    const v = typeof a === "function" ? (a as (c: typeof call) => unknown)(call) : a;
    if (v !== undefined) return v;
    return kind(call.ops) === "select" ? { data: null, error: null } : { data: [{ id: "row-1" }], error: null };
  };
  const chain = (table: string) => {
    const call = { table, ops: [] as Array<{ m: string; args: unknown[] }> };
    h.calls.push(call);
    const p: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve().then(() => answer(call)).then(res, rej);
        return (...args: unknown[]) => { call.ops.push({ m: String(prop), args }); return p; };
      },
    });
    return p;
  };
  const channel = { send: async () => "ok", httpSend: async () => ({ success: true }) };
  return {
    supabase: {
      from: (t: string) => chain(t),
      getChannels: () => [],
      channel: () => channel,
      removeChannel: async () => "ok",
      auth: { getSession: async () => ({ data: { session: null } }), getUser: async () => ({ data: { user: null } }) },
    },
  };
});
const NONE = { data: [], error: null };
const writes = (table?: string) => h.calls.filter((c) => (!table || c.table === table) && c.ops.some((o) => ["update", "delete", "insert", "upsert"].includes(o.m)));
const opsOf = (c: Call) => c.ops.map((o) => `${o.m}(${o.args.map((a) => typeof a === "string" ? JSON.stringify(a) : Array.isArray(a) ? `[${a.join(",")}]` : typeof a === "object" && a !== null ? "{…}" : String(a)).join(", ")})`).join(".");

vi.mock("@/lib/audit", async (orig) => ({ ...(await orig<typeof import("@/lib/audit")>()), logAuditAction: vi.fn(async () => ({ error: null })) }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => true), appAlert: vi.fn(async () => undefined), appPrompt: vi.fn(async () => null) }));

import { CHECKED_WRITE_REFUSED } from "@/lib/checkedWrite";
import { updateCollection, deleteCollection, removeItem, reorderItems, updateItemNotes } from "@/lib/collections";
import { updateCollectionAppearance, updateCollectionHomeConfig, updateFolder, renameFolderAndDescendants, reorderFolders } from "@/lib/libraryCollections";
import { deleteView, setDefault } from "@/lib/libraryViews";
import { unfavoriteDoc } from "@/lib/favorites";
import { deleteTableView, tableViewId } from "@/lib/tableViews";
import { unwatch } from "@/lib/watches";
import { updatePhoto, unlinkAssetFile } from "@/lib/assets";

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.calls.length = 0;
  h.answers = {};
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { warn.mockRestore(); });

describe("lib/collections.ts — class (a): a collection edit that matched no row is refused, never saved", () => {
  it("updateCollection: the same write and its read-back; zero rows rejects with the typed refusal", async () => {
    await expect(updateCollection("c1", { name: "Book" }, "u1")).resolves.toBeUndefined();
    expect(writes().map(opsOf)).toEqual(['update({…}).eq("id", "c1").select("id")']);
    expect(writes()[0].ops[0].args[0]).toMatchObject({ name: "Book", updated_by: "u1" });
    h.calls.length = 0;
    h.answers["curated_collections:update"] = NONE;
    await expect(updateCollection("c1", { name: "Book" }, "u1")).rejects.toThrow(`The collection was not saved. ${CHECKED_WRITE_REFUSED}`);
  });
  it("updateCollection: the pre-migration retry still sees the whole error (folder_id), then is checked too", async () => {
    let n = 0;
    h.answers["curated_collections:update"] = () => (++n === 1 ? { data: null, error: { code: "PGRST204", message: "Could not find the 'folder_id' column" } } : NONE);
    await expect(updateCollection("c1", { folder_id: "f1" }, "u1")).rejects.toThrow(CHECKED_WRITE_REFUSED);
    expect(writes()).toHaveLength(2);
    expect(writes()[1].ops[0].args[0]).not.toHaveProperty("folder_id");
    // …and a database error keeps its own words, as before
    h.answers["curated_collections:update"] = { data: null, error: { code: "23505", message: "duplicate key value" } };
    await expect(updateCollection("c1", { name: "x" }, "u1")).rejects.toThrow("duplicate key value");
  });
  it("deleteCollection: zero rows rejects; a matched delete resolves", async () => {
    await expect(deleteCollection("c1")).resolves.toBeUndefined();
    expect(writes().map(opsOf)).toEqual(['delete().eq("id", "c1").select("id")']);
    h.answers["curated_collections:delete"] = NONE;
    await expect(deleteCollection("c1")).rejects.toThrow(`The collection was not deleted. ${CHECKED_WRITE_REFUSED}`);
  });
  it("removeItem / updateItemNotes read back document_id (the table has no id column); zero rows rejects", async () => {
    h.answers["curated_collection_items:delete"] = { data: [{ document_id: "d1" }], error: null };
    h.answers["curated_collection_items:update"] = { data: [{ document_id: "d1" }], error: null };
    await expect(removeItem("c1", "d1")).resolves.toBeUndefined();
    await expect(updateItemNotes("c1", "d1", "note")).resolves.toBeUndefined();
    expect(writes().map(opsOf)).toEqual([
      'delete().eq("collection_id", "c1").eq("document_id", "d1").select("document_id")',
      'update({…}).eq("collection_id", "c1").eq("document_id", "d1").select("document_id")',
    ]);
    h.answers["curated_collection_items:delete"] = NONE;
    h.answers["curated_collection_items:update"] = NONE;
    await expect(removeItem("c1", "d1")).rejects.toThrow(`The document was not removed from the collection. ${CHECKED_WRITE_REFUSED}`);
    await expect(updateItemNotes("c1", "d1", "note")).rejects.toThrow(`The note was not saved. ${CHECKED_WRITE_REFUSED}`);
    h.answers["curated_collection_items:delete"] = { data: null, error: { code: "42501", message: "permission denied for table curated_collection_items" } };
    await expect(removeItem("c1", "d1")).rejects.toThrow("permission denied for table curated_collection_items");
  });
  it("reorderItems: every position is still written; one that matched no row is said once all answered", async () => {
    h.answers["curated_collection_items:update"] = { data: [{ document_id: "x" }], error: null };
    await expect(reorderItems("c1", ["a", "b", "c"])).resolves.toBeUndefined();
    expect(writes().map((c) => c.ops[0].args[0])).toEqual([{ sort_order: 0 }, { sort_order: 1 }, { sort_order: 2 }]);
    h.calls.length = 0;
    h.answers["curated_collection_items:update"] = (c: Call) => (c.ops.some((o) => o.m === "eq" && o.args[1] === "b") ? NONE : { data: [{ document_id: "x" }], error: null });
    // (the integrator's MINOR 4: never "nothing was changed" — two positions landed)
    const said = await reorderItems("c1", ["a", "b", "c"]).catch((e: Error) => e.message);
    expect(said).toBe("1 of 3 position(s) were not saved — you may not have permission to reorder these, or someone else changed them first. The others were saved. Reload to see the order as it stands.");
    expect(said).not.toMatch(/nothing was changed/i);
    expect(writes()).toHaveLength(3);
    // a database error among them is said in its own reason (REASON form), not the permission guess (re-review B)
    h.answers["curated_collection_items:update"] = (c: Call) => (c.ops.some((o) => o.m === "eq" && o.args[1] === "b") ? { data: null, error: { code: "40P01", message: "deadlock detected" } } : { data: [{ document_id: "x" }], error: null });
    expect(await reorderItems("c1", ["a", "b", "c"]).catch((e: Error) => e.message)).toBe("1 of 3 position(s) were not saved — Someone else changed this at the same moment — try again. The others were saved. Reload to see the order as it stands.");
    h.calls.length = 0;
  });
});

describe("lib/libraryCollections.ts — folders", () => {
  it("updateCollectionAppearance / updateCollectionHomeConfig / updateFolder: zero rows rejects; matched resolves", async () => {
    await expect(updateCollectionAppearance("f1", { color: "#fff" }, "u1")).resolves.toBeUndefined();
    await expect(updateCollectionHomeConfig("f1", { enabled: true, parts: [] })).resolves.toBeUndefined();
    await expect(updateFolder("f1", { name: "N" })).resolves.toBeUndefined();
    expect(writes().map(opsOf)).toEqual([
      'update({…}).eq("id", "f1").select("id")', 'update({…}).eq("id", "f1").select("id")', 'update({…}).eq("id", "f1").select("id")',
    ]);
    h.answers["collections:update"] = NONE;
    await expect(updateCollectionAppearance("f1", { color: "#fff" }, "u1")).rejects.toThrow(`The folder's appearance was not saved. ${CHECKED_WRITE_REFUSED}`);
    await expect(updateCollectionHomeConfig("f1", { enabled: true, parts: [] })).rejects.toThrow(`The folder's home was not saved. ${CHECKED_WRITE_REFUSED}`);
    await expect(updateFolder("f1", { name: "N" })).rejects.toThrow(`The folder was not updated. ${CHECKED_WRITE_REFUSED}`);
  });
  it("a database error reaches the customize modal / home board worded, never as raw Postgres text (the integrator's MINOR 3)", async () => {
    h.answers["collections:update"] = { data: null, error: { code: "42501", message: 'new row violates row-level security policy for table "collections"' } };
    const said = await Promise.all([
      updateCollectionAppearance("f1", { color: "#fff" }, "u1").catch((e: Error) => e.message),
      updateCollectionHomeConfig("f1", { enabled: true, parts: [] }).catch((e: Error) => e.message),
      updateFolder("f1", { name: "N" }).catch((e: Error) => e.message),
    ]);
    expect(said).toEqual([
      "The folder's appearance was not saved. You don't have permission to do this — nothing was changed.",
      "The folder's home was not saved. You don't have permission to do this — nothing was changed.",
      "The folder was not updated. You don't have permission to do this — nothing was changed.",
    ]);
    for (const m of said) expect(m).not.toMatch(/row-level security|"collections"/);
  });
  const node = { id: "f1", library_id: "L", name: "Old", path_names: ["Root", "Old"], path: ["Root", "Old"] };
  const kids = [{ id: "k1", path_names: ["Root", "Old", "A"], path_ids: ["f1", "k1"] }, { id: "k2", path_names: ["Root", "Old", "B"], path_ids: ["f1", "k2"] }];
  const reads = () => (c: Call) => (c.ops.some((o) => o.m === "single") ? { data: node, error: null } : { data: kids, error: null });
  it("renameFolderAndDescendants: a refused rename throws and rewrites NO descendant path (the defect before J15a)", async () => {
    h.answers["collections:select"] = reads();
    h.answers["collections:update"] = NONE;
    await expect(renameFolderAndDescendants("f1", "New")).rejects.toThrow(`The folder was not renamed. ${CHECKED_WRITE_REFUSED}`);
    expect(writes()).toHaveLength(1);
    expect(h.calls.filter((c) => c.ops.some((o) => o.m === "filter"))).toEqual([]);
  });
  it("renameFolderAndDescendants: the success path writes the folder and each descendant as before; a descendant that did not land is said, the rename stands", async () => {
    h.answers["collections:select"] = reads();
    await expect(renameFolderAndDescendants("f1", "New")).resolves.toBeUndefined();
    expect(writes().map((c) => c.ops[0].args[0])).toEqual([
      { name: "New", path: ["Root", "New"], path_names: ["Root", "New"] },
      { path: ["Root", "New", "A"], path_names: ["Root", "New", "A"] },
      { path: ["Root", "New", "B"], path_names: ["Root", "New", "B"] },
    ]);
    expect(warn).not.toHaveBeenCalled();
    h.calls.length = 0;
    h.answers["collections:update"] = (c: Call) => (c.ops.some((o) => o.m === "eq" && o.args[1] === "k2") ? NONE : { data: [{ id: "x" }], error: null });
    await expect(renameFolderAndDescendants("f1", "New")).resolves.toBeUndefined();
    expect(writes()).toHaveLength(3);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/1 descendant folder path\(s\) were not updated: k2/);
  });
  it("reorderFolders: every position is still written; one refused is said once all answered", async () => {
    await expect(reorderFolders(["a", "b"])).resolves.toBeUndefined();
    expect(writes().map(opsOf)).toEqual(['update({…}).eq("id", "a").select("id")', 'update({…}).eq("id", "b").select("id")']);
    h.calls.length = 0;
    h.answers["collections:update"] = (c: Call) => (c.ops.some((o) => o.m === "eq" && o.args[1] === "a") ? NONE : { data: [{ id: "b" }], error: null });
    await expect(reorderFolders(["a", "b"])).rejects.toThrow("1 of 2 folder position(s) were not saved — you may not have permission to reorder these, or someone else changed them first. The others were saved. Reload to see the order as it stands.");
    expect(writes()).toHaveLength(2);
    // none landed: no "the others were saved", and still never "nothing was changed" (a drag may have moved the folder first)
    h.answers["collections:update"] = NONE;
    const all = await reorderFolders(["a", "b"]).catch((e: Error) => e.message);
    expect(all).toBe("2 of 2 folder position(s) were not saved — you may not have permission to reorder these, or someone else changed them first. Reload to see the order as it stands.");
    h.answers["collections:update"] = (c: Call) => (c.ops.some((o) => o.m === "eq" && o.args[1] === "a") ? { data: null, error: { code: "42501", message: 'new row violates row-level security policy for table "collections"' } } : NONE);
    expect(await reorderFolders(["a", "b"]).catch((e: Error) => e.message)).toBe("2 of 2 folder position(s) were not saved — You don't have permission to do this. Reload to see the order as it stands.");
  });
});

describe("lib/libraryViews.ts", () => {
  it("deleteView: zero rows rejects (class a)", async () => {
    await expect(deleteView("v1")).resolves.toBeUndefined();
    h.answers["library_views:delete"] = NONE;
    await expect(deleteView("v1")).rejects.toThrow(`The view was not deleted. ${CHECKED_WRITE_REFUSED}`);
  });
  it("setDefault: no previous default to clear is a success (class c); the new default matching no row is refused (class a)", async () => {
    h.answers["library_views:update"] = (c: Call) => (c.ops[0].args[0] as { is_default: boolean }).is_default ? { data: [{ id: "v1" }], error: null } : NONE;
    await expect(setDefault("v1", "org", undefined, "L")).resolves.toBeUndefined();
    expect(writes().map(opsOf)).toEqual([
      'update({…}).eq("library_id", "L").eq("scope", "org").select("id")',
      'update({…}).eq("id", "v1").select("id")',
    ]);
    expect(warn).not.toHaveBeenCalled();
    h.answers["library_views:update"] = NONE;
    await expect(setDefault("v1", "user", "u1")).rejects.toThrow(`The view was not made the default. ${CHECKED_WRITE_REFUSED}`);
  });
});

describe("class (c): already done is a success, a database error is never silent", () => {
  it("unfavoriteDoc: not a favourite → resolves; an error throws its own words; reads back document_id (no id column)", async () => {
    h.answers["document_favorites:delete"] = NONE;
    await expect(unfavoriteDoc("u1", "d1")).resolves.toBeUndefined();
    expect(writes().map(opsOf)).toEqual(['delete().eq("user_id", "u1").eq("document_id", "d1").select("document_id")']);
    h.answers["document_favorites:delete"] = { data: null, error: { code: "42501", message: "permission denied for table document_favorites" } };
    await expect(unfavoriteDoc("u1", "d1")).rejects.toThrow("permission denied for table document_favorites");
  });
  it("deleteTableView: nothing saved → resolves; an error throws its own words", async () => {
    const id = tableViewId({ scope: "org", orgId: "o1" });
    h.answers["table_views:delete"] = NONE;
    await expect(deleteTableView({ scope: "org", orgId: "o1" })).resolves.toBeUndefined();
    expect(writes().map(opsOf)).toEqual([`delete().eq("id", ${JSON.stringify(id)}).select("id")`]);
    h.answers["table_views:delete"] = { data: null, error: { message: "upstream request timeout" } };
    await expect(deleteTableView({ scope: "org", orgId: "o1" })).rejects.toThrow("upstream request timeout");
  });
  it("unwatch: not following → resolves; a database error now throws (WatchButton keeps 'Following')", async () => {
    h.answers["subscriptions:delete"] = NONE;
    await expect(unwatch({ userId: "u1", resourceType: "document", resourceId: "d1" })).resolves.toBeUndefined();
    expect(writes().map(opsOf)).toEqual(['delete().eq("user_id", "u1").eq("resource_type", "document").eq("resource_id", "d1").select("id")']);
    h.answers["subscriptions:delete"] = { data: null, error: { code: "40001", message: "could not serialize access" } };
    await expect(unwatch({ userId: "u1", resourceType: "document", resourceId: "d1" })).rejects.toThrow();
  });
});

describe("lib/assets.ts — class (a)", () => {
  it("updatePhoto: zero rows rejects; matched resolves with the same patch", async () => {
    await expect(updatePhoto("p1", { status: "superseded" }, "u1")).resolves.toBeUndefined();
    expect(writes().map(opsOf)).toEqual(['update({…}).eq("id", "p1").select("id")']);
    expect(writes()[0].ops[0].args[0]).toMatchObject({ status: "superseded", status_marked_by: "u1" });
    h.answers["asset_photos:update"] = NONE;
    await expect(updatePhoto("p1", { caption: "x" }, "u1")).rejects.toThrow(`The photo was not updated. ${CHECKED_WRITE_REFUSED}`);
  });
  it("unlinkAssetFile: zero rows rejects; matched resolves", async () => {
    await expect(unlinkAssetFile("af1")).resolves.toBeUndefined();
    expect(writes().map(opsOf)).toEqual(['delete().eq("id", "af1").select("id")']);
    h.answers["asset_files:delete"] = NONE;
    await expect(unlinkAssetFile("af1")).rejects.toThrow(`The file was not unlinked. ${CHECKED_WRITE_REFUSED}`);
  });
});
