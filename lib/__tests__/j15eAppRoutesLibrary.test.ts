// projects-joint J15e APP AND COMPONENT WRITE SWEEP, batch J15e-app
// (projects-tab SAF-22) — the library, knowledge and template routes.
//
// Each route's UPDATE / DELETE now reads its matched rows (lib/checkedWrite.ts).
// Driven end to end against lib/__tests__/helpers/fakeSupabase.ts: a table in
// `refuseWrites` answers an UPDATE / DELETE with zero rows and no error — the
// shape row-level security, or a row removed between the read and the write,
// gives. Every case pairs the zero-row answer with the ordinary path, which
// writes exactly what it wrote before.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { newFakeDb, type FakeDb, type Row } from "./helpers/fakeSupabase";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));

vi.mock("@/lib/supabaseAdmin", async () => {
  const { makeFakeSupabase: make } = await import("./helpers/fakeSupabase");
  return {
    supabaseAdmin: {
      from: (t: string) => make(h.db).from(t),
      auth: { getUser: async () => ({ data: { user: { id: "u1", email: "dc@x.io" } }, error: null }) },
    },
  };
});
vi.mock("@/lib/knowledgeAccess", async (orig) => ({
  ...(await orig<typeof import("@/lib/knowledgeAccess")>()),
  loadPrincipal: async () => ({ uid: "u1", orgId: "o1", role: "DocCtrl", roles: ["DocCtrl"], isController: true, teamIds: [] }),
}));
vi.mock("@/lib/serverRetention", async (orig) => ({
  ...(await orig<typeof import("@/lib/serverRetention")>()),
  loadDestinationPolicies: async () => ({ folderPolicy: null, libPolicy: null }),
  reclockRetentionForDocs: vi.fn(async (_sb: unknown, docs: unknown[]) => ({ updated: docs.length, failed: 0, firstError: null })),
}));
vi.mock("@/lib/serverCollections", () => ({
  loadCollectionTree: async () => ({ byId: new Map([["f1", { id: "f1", parent_id: null, name: "A" }], ["f2", { id: "f2", parent_id: null, name: "B" }]]) }),
  rebuildSubtreePaths: vi.fn(async () => 1),
  rebuildSubtreeAclIndex: vi.fn(async () => ({ folders: 1, documents: 0 })),
}));
vi.mock("@/lib/aclIndexRebuild", () => ({ rebuildAclIndexes: vi.fn(async () => ({ errors: [], documents: 2 })) }));
vi.mock("@/lib/knowledgeSourceSync", () => ({ syncKnowledgeLibrarySources: vi.fn(async () => ({ added: 0 })) }));
vi.mock("@/lib/orgMemberName", () => ({ memberDisplayName: async () => "Dana" }));

import { POST as FOLDER_DELETE } from "@/app/api/collections/delete/route";
import { POST as FOLDER_MOVE } from "@/app/api/collections/move/route";
import { POST as RESTORE_ROUTE } from "@/app/api/collections/trash/route";
const FOLDER_RESTORE = async (r: NextRequest) => (await RESTORE_ROUTE(r))!;
import { POST as DOCS_MOVE } from "@/app/api/documents/move/route";
import { POST as EXCLUDE } from "@/app/api/knowledge/exclusion/route";
import { POST as RATE } from "@/app/api/knowledge/feedback/route";
import { DELETE as SOURCE_DELETE } from "@/app/api/knowledge/sources/route";
import { POST as TEMPLATE_SAVE, DELETE as TEMPLATE_DELETE } from "@/app/api/templates/route";
import { POST as GENERATE } from "@/app/api/templates/generate/route";

const req = (url: string, body: unknown, method = "POST") => new NextRequest(`https://app${url}`, {
  method, headers: { "content-type": "application/json", authorization: "Bearer t" }, body: JSON.stringify(body),
});
const rows = (t: string) => (h.db.tables[t] ??= []);
const audits = (action: string) => rows("audit_logs").filter((r) => r.action === action);
const writes = (t: string, m: "update" | "delete") => h.db.calls.filter((c) => c.table === t && c.method === m);

beforeEach(() => { h.db = newFakeDb(); vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); });

describe("collections delete — the folder's own delete is the person's decision (class a)", () => {
  const seed = () => {
    h.db.tables.collections = [
      { id: "f1", org_id: "o1", library_id: "l1", parent_id: "p0", name: "Radiography", path_names: [], path_ids: [] },
      { id: "c1", org_id: "o1", library_id: "l1", parent_id: "f1", name: "Sub" },
    ];
    h.db.tables.documents = [{ id: "d1", org_id: "o1", collection_id: "f1", retention_policy: null, created_at: "2020-01-01" }];
  };
  it("ordinary path: contents step up, the folder is soft-deleted, FOLDER_DELETED recorded, 200 as before", async () => {
    seed();
    const res = await FOLDER_DELETE(req("/api/collections/delete", { orgId: "o1", collectionId: "f1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, contentsMovedTo: "p0", retentionDeadlinesLost: 0 });
    expect(rows("collections").find((r) => r.id === "f1")!.deleted_at).toBeTruthy();
    expect(rows("collections").find((r) => r.id === "c1")!.parent_id).toBe("p0");
    expect(audits("FOLDER_DELETED")).toHaveLength(1);
  });
  it("a soft delete that matched no row: 409 that says the contents moved, and no FOLDER_DELETED row", async () => {
    seed();
    // the folder row is gone between the step-up and its own delete
    h.db.beforeUpdate!.collections = (next) => { if ("deleted_at" in next && next.id === "f1") { h.db.tables.collections = rows("collections").filter((r) => r.id !== "f1"); } return next; };
    h.db.refuseWrites.add("collections");
    const res = await FOLDER_DELETE(req("/api/collections/delete", { orgId: "o1", collectionId: "f1" }));
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; contentsMovedTo: string };
    expect(body.error).toMatch(/^The folder was not deleted: it was removed or changed meanwhile\. Its subfolders and documents had already been moved up to its parent\./);
    expect(body.error).not.toMatch(/nothing was changed/i);
    expect(body.contentsMovedTo).toBe("p0");
    expect(audits("FOLDER_DELETED")).toEqual([]);
    // the documents' step-up landed, so its consequence (the re-clock) still ran
    expect(rows("documents")[0].collection_id).toBe("p0");
  });
});

describe("collections move / trash restore (class a)", () => {
  it("move: ordinary path writes the parent and FOLDER_MOVED; a zero-row move is 409 with nothing rebuilt or recorded", async () => {
    h.db.tables.collections = [{ id: "f1", org_id: "o1", library_id: "l1", parent_id: null, name: "A" }, { id: "f2", org_id: "o1", library_id: "l1", parent_id: null, name: "B" }];
    h.db.tables.libraries = [{ id: "l1", acl: null }];
    const ok = await FOLDER_MOVE(req("/api/collections/move", { orgId: "o1", collectionId: "f1", newParentId: "f2" }));
    expect(ok.status).toBe(200);
    expect(rows("collections")[0].parent_id).toBe("f2");
    expect(audits("FOLDER_MOVED")).toHaveLength(1);

    h.db = newFakeDb();
    h.db.tables.collections = [{ id: "f1", org_id: "o1", library_id: "l1", parent_id: null, name: "A" }, { id: "f2", org_id: "o1", library_id: "l1", parent_id: null, name: "B" }];
    h.db.refuseWrites.add("collections");
    const { rebuildSubtreePaths } = await import("@/lib/serverCollections");
    vi.mocked(rebuildSubtreePaths).mockClear();
    const refused = await FOLDER_MOVE(req("/api/collections/move", { orgId: "o1", collectionId: "f1", newParentId: "f2" }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("The folder wasn't moved: it was removed or changed meanwhile — nothing was changed. Reload and try again.");
    expect(rebuildSubtreePaths).not.toHaveBeenCalled();
    expect(audits("FOLDER_MOVED")).toEqual([]);
  });
  it("restore: ordinary path restores and records; a zero-row restore is 409, no documents return, no FOLDER_RESTORED row", async () => {
    const seed = () => {
      h.db.tables.collections = [{ id: "f1", org_id: "o1", library_id: "l1", parent_id: null, name: "A", deleted_at: "2026-11-01", retention_policy: null }];
      h.db.tables.audit_logs = [{ action: "FOLDER_DELETED", org_id: "o1", resource_id: "f1", timestamp: "2026-11-01", details: { contentsMovedTo: null, steppedDocIds: ["d1"] } }];
      h.db.tables.documents = [{ id: "d1", org_id: "o1", library_id: "l1", collection_id: null }];
    };
    seed();
    const ok = await FOLDER_RESTORE(req("/api/collections/trash", { orgId: "o1", collectionId: "f1" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, restoredToParent: null, documentsReturned: 1 });
    expect(rows("documents")[0].collection_id).toBe("f1");
    expect(audits("FOLDER_RESTORED")).toHaveLength(1);

    h.db = newFakeDb();
    seed();
    h.db.refuseWrites.add("collections");
    const refused = await FOLDER_RESTORE(req("/api/collections/trash", { orgId: "o1", collectionId: "f1" }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/^The folder wasn't restored: it was removed meanwhile — nothing was changed\./);
    expect(rows("documents")[0].collection_id).toBeNull();
    expect(audits("FOLDER_RESTORED")).toEqual([]);
  });
  it("restore: a document since moved on purpose is not returned (class c), and its filter is the heir leg as before", async () => {
    h.db.tables.collections = [{ id: "f1", org_id: "o1", library_id: "l1", parent_id: null, name: "A", deleted_at: "2026-11-01" }];
    h.db.tables.audit_logs = [{ action: "FOLDER_DELETED", org_id: "o1", resource_id: "f1", timestamp: "2026-11-01", details: { contentsMovedTo: "heir", steppedDocIds: ["d1", "d2"] } }];
    h.db.tables.documents = [{ id: "d1", org_id: "o1", library_id: "l1", collection_id: "heir" }, { id: "d2", org_id: "o1", library_id: "l1", collection_id: "elsewhere" }];
    const res = await FOLDER_RESTORE(req("/api/collections/trash", { orgId: "o1", collectionId: "f1" }));
    expect(await res.json()).toMatchObject({ ok: true, documentsReturned: 1 });
    expect(rows("documents").map((d) => d.collection_id)).toEqual(["f1", "elsewhere"]);
    const leg = h.db.calls.filter((c) => c.table === "documents").map((c) => [c.method, ...c.args]).filter((c) => c[1] === "collection_id");
    expect(leg).toEqual([["eq", "collection_id", "heir"]]);
  });
});

describe("documents move (class a) — read through its matched rows", () => {
  const seed = () => {
    h.db.tables.documents = [
      { id: "d1", org_id: "o1", library_id: "l1", collection_id: null },
      { id: "d2", org_id: "o1", library_id: "l1", collection_id: null },
    ];
    h.db.tables.collections = [{ id: "F", org_id: "o1", library_id: "l1", retention_policy: null }];
  };
  it("ordinary path: the same answer and DOCS_MOVED row as before", async () => {
    seed();
    const res = await DOCS_MOVE(req("/api/documents/move", { orgId: "o1", docIds: ["d1", "d2"], targetFolderId: "F" }));
    expect(await res.json()).toEqual({ ok: true, moved: 2, retentionRecomputed: 2, retentionFailed: 0, aclIndexRebuilt: 2 });
    expect(audits("DOCS_MOVED")[0].details).toMatchObject({ count: 2, targetFolderId: "F", libraryId: "l1" });
    expect((audits("DOCS_MOVED")[0].details as Row).notMoved).toBeUndefined();
  });
  it("none matched: 409, nothing re-clocked or recorded", async () => {
    seed();
    h.db.refuseWrites.add("documents");
    const res = await DOCS_MOVE(req("/api/documents/move", { orgId: "o1", docIds: ["d1", "d2"], targetFolderId: "F" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/^The documents weren't moved/);
    expect(audits("DOCS_MOVED")).toEqual([]);
  });
  it("some matched: only those are counted, re-clocked and recorded, and the answer says how many were not moved", async () => {
    seed();
    // d2 is removed between the read and the write
    h.db.selectErrors!.documents = (cols) => {
      if (cols.startsWith("org_id, library_id")) queueMicrotask(() => { h.db.tables.documents = rows("documents").filter((r) => r.id !== "d2"); });
      return null;
    };
    const { reclockRetentionForDocs } = await import("@/lib/serverRetention");
    vi.mocked(reclockRetentionForDocs).mockClear();
    const res = await DOCS_MOVE(req("/api/documents/move", { orgId: "o1", docIds: ["d1", "d2"], targetFolderId: "F" }));
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, moved: 1, warning: "1 of 2 documents were not moved: removed meanwhile." });
    expect((vi.mocked(reclockRetentionForDocs).mock.calls[0][1] as unknown as Row[]).map((d) => d.id)).toEqual(["d1"]);
    expect(audits("DOCS_MOVED")[0].details).toMatchObject({ count: 1, notMoved: 1 });
  });
});

describe("knowledge exclusion / feedback / sources", () => {
  it("exclusion: ordinary path flags, purges and reports the copies the delete matched", async () => {
    h.db.tables.documents = [{ id: "d1", org_id: "o1", ai_excluded: false }];
    h.db.tables.knowledge_documents = [{ id: "k1", org_id: "o1", source_document_id: "d1" }];
    h.db.tables.entity_mentions = [{ id: "m1", org_id: "o1", document_id: "d1" }];
    const res = await EXCLUDE(req("/api/knowledge/exclusion", { orgId: "o1", documentId: "d1", excluded: true }));
    expect(await res.json()).toEqual({ excluded: true, purged: 1 });
    expect(rows("documents")[0].ai_excluded).toBe(true);
    expect(rows("knowledge_documents")).toEqual([]);
    expect(rows("entity_mentions")).toEqual([]);
  });
  it("exclusion: a flag that matched no row is 409 and nothing is purged", async () => {
    h.db.tables.documents = [{ id: "d1", org_id: "o1", ai_excluded: false }];
    h.db.tables.knowledge_documents = [{ id: "k1", org_id: "o1", source_document_id: "d1" }];
    h.db.refuseWrites.add("documents");
    const res = await EXCLUDE(req("/api/knowledge/exclusion", { orgId: "o1", documentId: "d1", excluded: true }));
    expect(res.status).toBe(409);
    expect(rows("knowledge_documents")).toHaveLength(1);
    expect(writes("knowledge_documents", "delete")).toEqual([]);
  });
  it("exclusion: a copy removed meanwhile is not counted purged; a mentions clear that fails is said (it was swallowed)", async () => {
    h.db.tables.documents = [{ id: "d1", org_id: "o1", ai_excluded: false }];
    h.db.tables.knowledge_documents = [{ id: "k1", org_id: "o1", source_document_id: "d1" }];
    h.db.tables.entity_mentions = [{ id: "m1", org_id: "o1", document_id: "d1" }];
    h.db.refuseWrites.add("knowledge_documents");
    h.db.deleteErrors!.entity_mentions = { message: "permission denied for table entity_mentions", code: "42501" };
    const res = await EXCLUDE(req("/api/knowledge/exclusion", { orgId: "o1", documentId: "d1", excluded: true }));
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.purged).toBe(0);
    expect(body.warning).toBe("The document is held back and its indexed copy removed, but the entity mentions recorded against it could not be cleared: You don't have permission to do this.");
  });
  it("feedback: the rating lands as before; a rating that matched no row is 409", async () => {
    h.db.tables.knowledge_questions = [{ id: "q1", user_id: "u1", answer: "A full answer.", context: null, rating: null }];
    const ok = await RATE(req("/api/knowledge/feedback", { questionId: "q1", rating: 1 }));
    expect(await ok.json()).toEqual({ ok: true });
    expect(rows("knowledge_questions")[0].rating).toBe(1);
    h.db.refuseWrites.add("knowledge_questions");
    const refused = await RATE(req("/api/knowledge/feedback", { questionId: "q1", rating: -1 }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("That answer was removed meanwhile, so your rating was not saved.");
  });
  it("sources: a removal lands and is recorded; one that matched no row is 409, no re-sync, no KNOWLEDGE_SOURCE_REMOVED row", async () => {
    h.db.tables.knowledge_sources = [{ id: "s1", org_id: "o1", library_id: "kl1", source_name: "Specs" }];
    const ok = await SOURCE_DELETE(req("/api/knowledge/sources", { orgId: "o1", sourceId: "s1" }, "DELETE"));
    expect(await ok.json()).toEqual({ ok: true, readded: 0 });
    expect(audits("KNOWLEDGE_SOURCE_REMOVED")).toHaveLength(1);

    h.db = newFakeDb();
    h.db.tables.knowledge_sources = [{ id: "s1", org_id: "o1", library_id: "kl1", source_name: "Specs" }];
    h.db.refuseWrites.add("knowledge_sources");
    const { syncKnowledgeLibrarySources } = await import("@/lib/knowledgeSourceSync");
    vi.mocked(syncKnowledgeLibrarySources).mockClear();
    const refused = await SOURCE_DELETE(req("/api/knowledge/sources", { orgId: "o1", sourceId: "s1" }, "DELETE"));
    expect(refused.status).toBe(409);
    expect(syncKnowledgeLibrarySources).not.toHaveBeenCalled();
    expect(audits("KNOWLEDGE_SOURCE_REMOVED")).toEqual([]);
  });
});

describe("output templates — save, delete and the filing record (class a)", () => {
  it("an edit answers the saved row as before; an edit that matched no template is 409, never `template: null`", async () => {
    h.db.tables.output_templates = [{ id: "t1", org_id: "o1", name: "Old" }];
    const ok = await TEMPLATE_SAVE(req("/api/templates", { orgId: "o1", id: "t1", name: "New" }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).template).toMatchObject({ id: "t1", name: "New" });
    h.db.refuseWrites.add("output_templates");
    const refused = await TEMPLATE_SAVE(req("/api/templates", { orgId: "o1", id: "t1", name: "Newer" }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/deleted meanwhile, so your changes were not saved/);
  });
  it("a create is unchanged (an insert, answered with its row)", async () => {
    const res = await TEMPLATE_SAVE(req("/api/templates", { orgId: "o1", name: "Fresh" }));
    expect((await res.json()).template).toMatchObject({ name: "Fresh", created_by: "u1" });
  });
  it("a delete answers ok as before; one that matched no template is 409", async () => {
    h.db.tables.output_templates = [{ id: "t1", org_id: "o1" }];
    expect(await (await TEMPLATE_DELETE(req("/api/templates", { orgId: "o1", id: "t1" }, "DELETE"))).json()).toEqual({ ok: true });
    const again = await TEMPLATE_DELETE(req("/api/templates", { orgId: "o1", id: "t1" }, "DELETE"));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/already deleted/);
  });
  it("the filing record lands as before; one that matched no row is 409 (the client's best-effort call swallows it)", async () => {
    h.db.tables.output_generations = [{ id: "g1", org_id: "o1", created_by: "u1", document_count: 3 }];
    expect(await (await GENERATE(req("/api/templates/generate", { orgId: "o1", action: "filed", generationId: "g1", filedCount: 2 }))).json()).toEqual({ ok: true, filedCount: 2 });
    h.db.refuseWrites.add("output_generations");
    const refused = await GENERATE(req("/api/templates/generate", { orgId: "o1", action: "filed", generationId: "g1", filedCount: 3 }));
    expect(refused.status).toBe(409);
    expect(rows("output_generations")[0].filed_count).toBe(2);
  });
});
