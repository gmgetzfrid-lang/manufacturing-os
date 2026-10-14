// intelligence Round G, package I-12 DOCUMENT ACL BOUNDARY — the continuation
// pass: the remainders the first commits left.
//
//   DACL-10  a legacy library whose read list names NO role binds its
//            contents (a zero-rule normal rung would say nothing).
//   KACL-12  a folder whose library is absent from a fully read landscape is
//            unreadable — to everyone but a controller (DEC-43).
//   KACL-9   find_documents and the link proposer ask lib/aiBoundary
//            aiReadability (the one function every AI door calls).
//   VFY-7    the short link's second candidate read matches the normalized
//            number exactly (an anchored, case-insensitive pattern).
//   DACL-1   (criterion 3) a document move rebuilds the library's
//            chain-resolved acl_index in the same request.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import type { AccessControl } from "@/types/schema";
import type { Principal } from "@/lib/permissions";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ── DACL-1 c3: the move route (service role, retention and rebuild faked) ──
const mv = vi.hoisted(() => ({
  docs: [] as Array<Record<string, unknown>>,
  folder: null as null | Record<string, unknown>,
  updates: [] as Array<{ table: string; patch: unknown }>,
  audits: [] as Array<Record<string, unknown>>,
  rebuild: vi.fn(),
  principal: { uid: "u-dc", orgId: "o1", role: "DocCtrl", roles: ["DocCtrl"], isController: true, teamIds: [] } as unknown,
}));

vi.mock("@/lib/supabaseAdmin", () => {
  const chain = (table: string) => {
    let op = "select";
    let patch: unknown = null;
    const q: Record<string, unknown> = {};
    const self = new Proxy(q, {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) => {
            if (op === "update") { mv.updates.push({ table, patch }); resolve({ data: null, error: null }); return; }
            if (op === "insert") { resolve({ data: null, error: null }); return; }
            if (table === "documents") resolve({ data: mv.docs, error: null });
            else resolve({ data: [], error: null });
          };
        }
        if (prop === "maybeSingle") return async () => ({ data: table === "collections" ? mv.folder : null, error: null });
        if (prop === "update") return (p: unknown) => { op = "update"; patch = p; return self; };
        if (prop === "insert") return (row: Record<string, unknown>) => {
          op = "insert";
          if (table === "audit_logs") mv.audits.push(row);
          return self;
        };
        return () => self;
      },
    });
    return self;
  };
  return {
    supabaseAdmin: {
      auth: { getUser: async () => ({ data: { user: { id: "u-dc", email: "dc@x" } }, error: null }) },
      from: (t: string) => chain(t),
    },
  };
});
vi.mock("@/lib/knowledgeAccess", async (orig) => ({
  ...(await orig<typeof import("@/lib/knowledgeAccess")>()),
  loadPrincipal: async () => mv.principal,
}));
vi.mock("@/lib/serverRetention", () => ({
  RETENTION_DOC_COLUMNS: "id, collection_id, retention_policy, retention_until, status, updated_at, created_at",
  loadDestinationPolicies: async () => ({ libPolicy: null }),
  reclockRetentionForDocs: async () => ({ updated: 1, failed: 0, firstError: null }),
}));
vi.mock("@/lib/aclIndexRebuild", () => ({ rebuildAclIndexes: (...a: unknown[]) => mv.rebuild(...a) }));

const moveReq = (body: Record<string, unknown>) => new NextRequest("http://localhost/api/documents/move", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("DACL-1 criterion 3 — a document move rebuilds the chain-resolved acl_index in the same request", () => {
  beforeEach(() => {
    mv.docs = [{ id: "d1", org_id: "o1", library_id: "L1", collection_id: "F-old" }];
    mv.folder = { id: "F-new", org_id: "o1", library_id: "L1", retention_policy: null };
    mv.updates = []; mv.audits = [];
    mv.rebuild.mockReset();
  });

  it("reproduction → fix: the move rebuilds the library's indexes (scoped to that library) after the folder change, and the audit row counts what it rewrote", async () => {
    mv.rebuild.mockResolvedValue({ libraries: 0, folders: 0, documents: 1, sets: 0, orgs: 1, errors: [] });
    const { POST } = await import("@/app/api/documents/move/route");
    const res = await POST(moveReq({ orgId: "o1", docIds: ["d1"], targetFolderId: "F-new" }));
    const out = await res.json();
    expect(res.status).toBe(200);
    expect(mv.updates.find((u) => u.table === "documents")?.patch).toMatchObject({ collection_id: "F-new" });
    expect(mv.rebuild).toHaveBeenCalledTimes(1);
    expect(mv.rebuild.mock.calls[0][2]).toEqual({ orgId: "o1", libraryId: "L1" });
    expect(out).toMatchObject({ ok: true, moved: 1, aclIndexRebuilt: 1 });
    expect(out.warning).toBeUndefined();
    expect((mv.audits[0].details as Record<string, unknown>).aclIndexRebuilt).toBe(1);
  });

  it("a rebuild that reports an error is said — the move stands (the nightly rebuild is the backstop), never a silent success", async () => {
    mv.rebuild.mockResolvedValue({ libraries: 0, folders: 0, documents: 0, sets: 0, orgs: 0, errors: ["org o1 skipped: collections timeout"] });
    const { POST } = await import("@/app/api/documents/move/route");
    const out = await (await POST(moveReq({ orgId: "o1", docIds: ["d1"], targetFolderId: "F-new" }))).json();
    expect(out.ok).toBe(true);
    expect(out.warning).toMatch(/access index couldn't be fully rebuilt for the new folder \(org o1 skipped: collections timeout\)/);
    expect((mv.audits[0].details as Record<string, unknown>).aclIndexError).toBe("org o1 skipped: collections timeout");
  });

  it("a rebuild that throws is reported the same way", async () => {
    mv.rebuild.mockRejectedValue(new Error("boom"));
    const { POST } = await import("@/app/api/documents/move/route");
    const out = await (await POST(moveReq({ orgId: "o1", docIds: ["d1"], targetFolderId: null }))).json();
    expect(out.ok).toBe(true);
    expect(out.warning).toMatch(/\(boom\)/);
  });

  it("regression: a non-controller is still refused before anything is written or rebuilt", async () => {
    mv.principal = { ...(mv.principal as object), isController: false, role: "Engineer", roles: ["Engineer"] };
    try {
      const { POST } = await import("@/app/api/documents/move/route");
      const res = await POST(moveReq({ orgId: "o1", docIds: ["d1"], targetFolderId: "F-new" }));
      expect(res.status).toBe(403);
      expect(mv.updates).toHaveLength(0);
      expect(mv.rebuild).not.toHaveBeenCalled();
    } finally {
      mv.principal = { ...(mv.principal as object), isController: true, role: "DocCtrl", roles: ["DocCtrl"] };
    }
  });
});

// ── DACL-10: an empty legacy read list ─────────────────────────────────────
describe("DACL-10 — a legacy library whose read list names no role binds its contents", () => {
  const V: Principal = { uid: "u-v", role: "Viewer" as never, roles: ["Viewer" as never], orgId: "o1", teamIds: [], isActiveMember: true };

  it("reproduction → fix: readAccess [] with an ACL that says nothing — the home page hides the card, and the library page no longer lists its documents", async () => {
    const { effectiveLibraryAcl, libraryReadsByRole, explorerDocReadable, explorerFolderVisible } = await import("@/lib/libraryAccess");
    const legacy = { readAccess: [] as never, visibleTo: [] as never, acl: null, visibility: "normal" as const };
    expect(libraryReadsByRole(legacy, "Viewer" as never)).toBe(false);
    const eff = effectiveLibraryAcl(legacy);
    expect(eff?.visibility).toBe("private");
    expect(eff?.rules).toEqual([]);
    expect(explorerDocReadable(V, eff, { collectionId: null }, new Map(), null)).toBe(false);   // was true: a zero-rule rung said nothing
    expect(explorerFolderVisible(V, eff, { id: "F", pathIds: [] }, new Map(), null)).toBe(false);
    // a controller and the owner still read; a grant deeper in the tree still merges in
    expect(explorerDocReadable({ ...V, roles: ["DocCtrl" as never] }, eff, { collectionId: null }, new Map(), null)).toBe(true);
    expect(explorerDocReadable(V, eff, { collectionId: null }, new Map(), "u-v")).toBe(true);
    const shared = { id: "S", pathIds: [], acl: { inherit: true, visibility: "normal", rules: [{ effect: "allow", subject: { type: "role", id: "Viewer" }, actions: ["discover", "read"] }] } as AccessControl };
    expect(explorerDocReadable(V, eff, { collectionId: "S" }, new Map([["S", shared]]), null)).toBe(true);
    // a hidden legacy library stays hidden
    expect(effectiveLibraryAcl({ ...legacy, visibility: "hidden" })?.visibility).toBe("hidden");
  });

  it("regression: a restricted list naming roles, \"ALL\", a missing value and a library whose ACL says something are unchanged", async () => {
    const { effectiveLibraryAcl } = await import("@/lib/libraryAccess");
    expect(effectiveLibraryAcl({ readAccess: ["HR"] as never, acl: null, visibility: "normal" })?.visibility).toBe("normal");
    expect(effectiveLibraryAcl({ readAccess: "ALL", acl: null })).toBeUndefined();
    expect(effectiveLibraryAcl({ readAccess: null, acl: null })).toBeUndefined();
    const wizard = { inherit: true, visibility: "normal", rules: [{ effect: "allow", subject: { type: "role", id: "HR" }, actions: ["read"] }] } as AccessControl;
    expect(effectiveLibraryAcl({ readAccess: [] as never, acl: wizard })).toBe(wizard);
  });
});

// ── KACL-12: a folder whose library is missing ─────────────────────────────
describe("KACL-12 — a folder whose library is absent from a fully read landscape", () => {
  const landscape = {
    libraries: new Map(),
    folders: new Map([["F", { name: "F", library_id: "L-gone", parent_id: null, acl: null, visibility: null, owner_user_id: null, path_names: [] }]]),
    trashedFolders: new Map(),
    teamSupervisors: new Map(),
  };
  const viewer = { uid: "u-v", orgId: "o1", role: "Viewer" as never, roles: ["Viewer" as never], isController: false, teamIds: [] };

  it("is never offered to a non-controller (its library's ACL cannot be evaluated) — and a controller is never dropped (DEC-43)", async () => {
    const { containerReadable } = await import("@/lib/knowledgeAccess");
    expect(containerReadable("folder", "F", viewer, landscape as never)).toBe(false);
    expect(containerReadable("folder", "F", { ...viewer, isController: true, roles: ["Manager" as never, "DocCtrl" as never] }, landscape as never)).toBe(true);
  });
});

// ── KACL-9: the AI boundary at the finder and the link proposer ────────────
describe("KACL-9 done-when 3 — aiReadability at the doors that still tested ai_excluded directly", () => {
  it("find_documents judges every row with aiReadability (held back is dropped; a superseded document is still found, named with its status)", () => {
    const tools = src("lib/orchestrator/tools.ts");
    const find = tools.slice(tools.indexOf("const findDocuments: ToolDef"), tools.indexOf("const searchDocuments: ToolDef"));
    expect(find).toMatch(/\.filter\(\(r\) => aiReadability\(\{/);
    expect(find).toMatch(/aiExcluded: r\.ai_excluded === true,\s*\}, true\)\.reason !== "held_back"\)/);
    // review fix: the query keeps its pre-filter (the column is NOT NULL), so
    // held-back rows never fill the LIMIT window; aiReadability is the named check
    expect(find).toMatch(/\.eq\("ai_excluded", false\)/);
    expect(find).toMatch(/\.select\("id, document_number, title, rev, status, library_id, updated_at, ai_excluded, archived_at, current_version_id"\)/);
    // the mirror hop and the mention tool ask the same function through aiReadableControlledIds
    expect(tools).toMatch(/aiReadableControlledIds\(ctx\.orgId, sources\)/);
    expect(src("lib/aiBoundaryServer.ts")).toMatch(/const verdict = aiReadability\(/);
  });

  it("the orchestrator's show-me chips: a mirror chip's source is judged by aiReadableControlledIds (failing closed), a controlled-document chip by aiReadability's held-back reason", () => {
    const r = src("app/api/orchestrator/route.ts");
    expect(r).toMatch(/mirrorSources\.length > 0 \? aiReadableControlledIds\(orgId, mirrorSources\)/);
    expect(r).toMatch(/\(readable\.has\(mirrorSrc\.get\(d\.id\) as string\) && aiOk\.has\(mirrorSrc\.get\(d\.id\) as string\)\)/);
    expect(r).toMatch(/aiExcluded: d\.ai_excluded === true,\s*\}, true\)\.reason !== "held_back"\)\.find\(/);
    // the chips' check still fails closed as a whole
    expect(r).toContain("catch { mentionedDocs = []; }");
  });

  it("the link proposer judges its documents with aiReadability (held back is dropped, as before)", () => {
    const p = src("lib/linkProposerServer.ts");
    expect(p).toMatch(/import \{ aiReadability \} from "@\/lib\/aiBoundary";/);
    expect(p).toMatch(/docRead\.rows\.filter\(\(d\) => aiReadability\(\{[\s\S]*?aiExcluded: d\.ai_excluded === true,\s*\}, true\)\.reason !== "held_back"\)/);
  });

  it("aiReadability names held_back first, whatever else is true of the document (the reason the finder and the proposer bind)", async () => {
    const { aiReadability } = await import("@/lib/aiBoundary");
    expect(aiReadability({ id: "d", status: "Superseded", archivedAt: null, currentVersionId: null, aiExcluded: true }, true).reason).toBe("held_back");
    expect(aiReadability({ id: "d", status: "Superseded", archivedAt: null, currentVersionId: "v", aiExcluded: false }, true).reason).toBe("not_current");
  });
});

// ── VFY-7: the normalized candidate read ───────────────────────────────────
describe("VFY-7 done-when 1 — the second candidate read matches the normalized number itself", () => {
  // PostgreSQL's ~* folds case inside a bracket expression as JavaScript's
  // /i does, so the pattern is checked here with the same semantics (and on
  // PostgreSQL 16 — see the record).
  it("matches exactly the numbers whose normalized form is the one typed", async () => {
    const { normalizeDocNumber, normalizedNumberPattern } = await import("@/lib/docNumberMatch");
    const norm = normalizeDocNumber("2002 D 10001");
    expect(norm).toBe("2002d10001");
    const re = new RegExp(normalizedNumberPattern(norm), "i");
    for (const yes of ["2002-D-10001", "2002_d_10001", "2002.D.10001", " 2002 D 10001 ", "2002D10001", "-2002--D--10001-"]) {
      expect(re.test(yes), yes).toBe(true);
      expect(normalizeDocNumber(yes)).toBe(norm);
    }
    for (const no of ["2002-D-100012", "X2002-D-10001", "2003-D-10001", "2002-D-1000", "SPEC-2002-D-10001-A"]) {
      expect(re.test(no), no).toBe(false);
      expect(normalizeDocNumber(no)).not.toBe(norm);
    }
  });
});
