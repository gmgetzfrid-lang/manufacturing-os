// intelligence Round G (I-16 CODEBOOK LIFECYCLE) — the app half of CB-5,
// CB-6 and ASK-8 done-when 2.
//
//   * CB-6 — planRedecode: the server re-decode's plan is the Identity
//     review's code_rederives rows (planIdentityReview, unchanged), never a
//     filing, never a code another asset carries, never a code naming another
//     unit; redecodeDigest is what the preview's token hashes (preview =
//     apply, the route test drives it end to end).
//   * Regression — nothing a controller runs today derives a different code:
//     the codec, the categorizer's plan and the identity review answer
//     exactly what they answered before this package.
//   * CB-5 — the client half of the rename: the preview's counts are what the
//     apply carries back; the confirm says what follows the code.
//   * ASK-8 — a legend id the codebook save or the library toggles save ADDS
//     must be a knowledge document of THIS org (reproduction → fix: before
//     this package saveConfig wrote any string).
//   * The page offers the rename on unit / type rows only and the re-decode
//     panel calls the server route; the WRITER_ROLES constant is unchanged.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeDb } from "./helpers/fakeSupabase";

const db = vi.hoisted(() => ({ ref: null as unknown as FakeDb, rpc: null as null | ((name: string, args: unknown) => { data: unknown; error: unknown }) }));
vi.mock("@/lib/supabase", async () => {
  const { makeFakeSupabase, newFakeDb: fresh } = await import("./helpers/fakeSupabase");
  db.ref = fresh();
  const proxy = new Proxy({}, {
    get: (_t, p: string) => {
      if (p === "rpc") {
        return async (name: string, args: unknown) => {
          db.ref.calls.push({ table: `rpc:${name}`, method: "rpc", args: [args] });
          return db.rpc ? db.rpc(name, args) : { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
        };
      }
      return (makeFakeSupabase(db.ref) as Record<string, unknown>)[p];
    },
  });
  return { supabase: proxy };
});

import {
  EMPTY_CODEBOOK, tagToCode, saveConfig, legendIdsAdded, assertOrgKnowledgeDocIds, KNOWLEDGE_DOC_ID_RE,
  renameExpectedCounts, renameSummary, renameCodebookCode, previewRedecode, applyRedecode, RENAME_COUNT_KEYS,
  type Codebook, type CodebookEntry, type RenamePreview,
} from "@/lib/codebook";
import { planRedecode, redecodeDigest, planIdentityReview, planCategorization, rederivationImpact } from "@/lib/assetCategorize";
import { saveLibraryAiFeatures } from "@/lib/knowledge";
import { newFakeDb } from "./helpers/fakeSupabase";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const entry = (kind: CodebookEntry["kind"], code: string, label: string, tagPrefixes?: string[]): CodebookEntry => ({
  id: `${kind}-${code}`, kind, code, label, meta: tagPrefixes ? { tagPrefixes } : {}, sort: 0, origin: "manual",
});
const book = (padTo = 0): Codebook => ({
  ...EMPTY_CODEBOOK,
  units: [entry("unit", "20", "Crude"), entry("unit", "25", "DHT")],
  equipmentTypes: [entry("equipment_type", "30", "Exchangers", ["E"]), entry("equipment_type", "10", "Pumps", ["P"])],
  iterableRule: { mirrorsTag: true, padTo },
});
const asset = (id: string, tag: string, unit_code: string | null, code: string | null, extra: Record<string, unknown> = {}) =>
  ({ id, tag, unit_code, code, ...extra });

beforeEach(() => {
  Object.assign(db.ref, newFakeDb());
  db.rpc = null;
});

describe("CB-6 — planRedecode: the Identity review's code_rederives rows, as one job", () => {
  it("re-derives a stored code the codebook now derives differently (padTo 0 → 3), from the asset's own tag and filing", () => {
    const assets = [asset("a1", "E-22", "20", "2030.22", { codebook_version: 1 }), asset("a2", "P-5", "25", "2510.5")];
    const p = planRedecode(assets, book(3));
    expect(p.rows).toEqual([
      { assetId: "a1", tag: "E-22", unitCode: "20", from: "2030.22", to: "2030.022", codebookVersion: 1 },
      { assetId: "a2", tag: "P-5", unitCode: "25", from: "2510.5", to: "2510.005", codebookVersion: null },
    ]);
    expect(p.skipped).toEqual([]);
  });
  it("never rewrites a filing: a code naming another unit is listed for a person (AREA-11), not re-derived", () => {
    const p = planRedecode([asset("a1", "E-22", "25", "2030.22")], book());
    expect(p.rows).toEqual([]);
    expect(p.skipped).toEqual([{ assetId: "a1", tag: "E-22", from: "2030.22", to: "2530.22", reason: "names_other_unit" }]);
  });
  it("never writes a code another asset carries — an archived holder counts (CB-10); nor one an earlier row of the plan takes", () => {
    const active = [asset("a1", "E-22", "20", "2030.22"), asset("a2", "E-022", "20", "2030.0220")];
    const holders = [...active, asset("z9", "E-99", null, "2030.022", { archived: true })];
    const p = planRedecode(active, book(3), holders);
    expect(p.rows).toEqual([]);
    expect(p.skipped.map((s) => [s.assetId, s.reason])).toEqual([["a1", "taken"], ["a2", "taken"]]);
    // without the archived holder, the first row takes the code and the second is skipped
    const q = planRedecode(active, book(3));
    expect(q.rows.map((r) => r.assetId)).toEqual(["a1"]);
    expect(q.skipped).toEqual([{ assetId: "a2", tag: "E-022", from: "2030.0220", to: "2030.022", reason: "taken" }]);
  });
  it("a blank code is the categorizer's fill-blank job, not a re-decode; an asset with no filing or a code the book cannot place is left alone", () => {
    const p = planRedecode([
      asset("a1", "E-22", "20", null), asset("a2", "E-23", null, "2030.23"), asset("a3", "X-1", "20", "2099.1"),
    ], book(3));
    expect(p.rows).toEqual([]);
    expect(p.skipped).toEqual([]);
  });
  it("an asset already carrying the derived code is not touched (idempotent: a second run plans nothing)", () => {
    expect(planRedecode([asset("a1", "E-22", "20", "2030.022")], book(3))).toEqual({ rows: [], skipped: [] });
  });
  it("redecodeDigest is exactly the rows an apply writes (version excluded); a different plan is a different digest", () => {
    const rows = planRedecode([asset("a1", "E-22", "20", "2030.22", { codebook_version: 4 })], book(3)).rows;
    expect(redecodeDigest(rows)).toBe(JSON.stringify([["a1", "20", "2030.22", "2030.022"]]));
    expect(redecodeDigest(rows.map((r) => ({ ...r, codebookVersion: 99 })))).toBe(redecodeDigest(rows));
    expect(redecodeDigest(planRedecode([asset("a1", "E-22", "20", "2030.22")], book(2)).rows)).not.toBe(redecodeDigest(rows));
  });
});

describe("REGRESSION — every codebook edit, decode and categorisation produces today's codes and rows", () => {
  it("the codec is unchanged (2030.22 at padTo 0, 2030.022 at padTo 3, letter units decline)", () => {
    expect(tagToCode("E-22", "20", book())).toBe("2030.22");
    expect(tagToCode("E-22", "20", book(3))).toBe("2030.022");
    expect(tagToCode("E-22", "2O", book())).toBeNull();
  });
  it("planIdentityReview and planCategorization answer as before (planRedecode is a reader of the first, nothing more)", () => {
    const assets = [asset("a1", "E-22", "20", "2030.22"), asset("a2", "E-23", "20", null), asset("a3", "E-24", null, "2030.24")] as never[];
    expect(planIdentityReview(assets, book(3)).map((r) => [r.assetId, r.kind, r.derivedCode])).toEqual([["a1", "code_rederives", "2030.022"]]);
    const cat = planCategorization(assets, [], book());
    expect(cat.codeAssignments).toEqual([{ assetId: "a2", tag: "E-23", code: "2030.23" }]);
    expect(cat.unitAssignments).toEqual([{ assetId: "a3", tag: "E-24", unitCode: "20" }]);
    expect(rederivationImpact(assets, book(), book(3))).toEqual({ changed: 1, examples: [{ tag: "E-22", from: "2030.22", to: "2030.022" }] });
  });
});

describe("CB-5 — the rename's client half", () => {
  const preview: RenamePreview = {
    kind: "unit", from: "21", to: "20", label: "Crude", blockers: [],
    assetsFiled: 4, assetsCoded: 4, flows: 2, unitMappings: 1, adopted: 1, adoptedFlows: 0,
  };
  it("the apply carries back exactly the preview's counts (RENAME_COUNT_KEYS); anything else is not a preview", () => {
    expect(RENAME_COUNT_KEYS).toEqual(["assetsFiled", "assetsCoded", "flows", "unitMappings", "adopted", "adoptedFlows"]);
    expect(renameExpectedCounts(preview)).toEqual({ assetsFiled: 4, assetsCoded: 4, flows: 2, unitMappings: 1, adopted: 1, adoptedFlows: 0 });
    expect(renameExpectedCounts({ ...preview, flows: "2" as never })).toBeNull();
    expect(renameExpectedCounts(null)).toBeNull();
  });
  it("the confirm names what follows the code, and what an orphan filing under the new code becomes", () => {
    const msg = renameSummary(preview);
    expect(msg).toContain("21 becomes 20 (Crude)");
    expect(msg).toContain("4 assets filed under it, 4 site codes, 2 process flows, 1 operational-unit mapping");
    expect(msg).toContain("pinned libraries and knowledge binding stay with it");
    expect(msg).toContain("1 asset already filed under 20, which the codebook does not hold today, will belong to this unit.");
    expect(renameSummary({ ...preview, kind: "equipment_type", adopted: 0 })).not.toMatch(/process flow|filed under it/);
  });
  it("calls the server route with the caller's token; a preview never sends counts, an apply always does; a missing migration is said", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
    const answers: Array<{ status: number; json: unknown }> = [
      { status: 200, json: preview },
      { status: 200, json: preview },
      { status: 409, json: { error: "needs migration 20261178", needsMigration: true } },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      const a = answers.shift()!;
      return { ok: a.status < 400, status: a.status, json: async () => a.json };
    }));
    const dry = await renameCodebookCode("o1", { kind: "unit", from: "21", to: "20", dryRun: true });
    expect(dry).toEqual({ ok: true, value: preview });
    const done = await renameCodebookCode("o1", { kind: "unit", from: "21", to: "20", dryRun: false, expected: preview });
    expect(done.ok).toBe(true);
    const missing = await renameCodebookCode("o1", { kind: "unit", from: "21", to: "20", dryRun: true });
    expect(missing).toEqual({ ok: false, error: "needs migration 20261178", needsMigration: true, changed: false });
    expect(calls.map((c) => c.url)).toEqual(["/api/admin/codebook", "/api/admin/codebook", "/api/admin/codebook"]);
    expect(calls[0].body).toEqual({ orgId: "o1", action: "rename-preview", kind: "unit", from: "21", to: "20" });
    expect(calls[1].body).toEqual({ orgId: "o1", action: "rename", kind: "unit", from: "21", to: "20", expected: renameExpectedCounts(preview) });
    expect(calls.every((c) => c.auth === "Bearer t")).toBe(true);
    vi.unstubAllGlobals();
  });
  it("the re-decode's client calls: preview, then apply with the preview's token", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ token: "tok", rows: [], skipped: [], codebookVersion: 3, writtenUnderEarlier: 0 }) };
    }));
    const p = await previewRedecode("o1");
    expect(p.ok && p.value.token).toBe("tok");
    await applyRedecode("o1", "tok");
    expect(bodies).toEqual([{ orgId: "o1", action: "redecode-preview" }, { orgId: "o1", action: "redecode-apply", token: "tok" }]);
    vi.unstubAllGlobals();
  });
});

describe("ASK-8 done-when 2 — legend ids are validated on write", () => {
  const OWN = "44444444-0000-0000-0000-000000000001";
  const FOREIGN = "44444444-0000-0000-0000-000000000002";
  beforeEach(() => {
    db.ref.tables.knowledge_documents = [{ id: OWN, org_id: "o1" }, { id: FOREIGN, org_id: "o2" }];
    db.ref.tables.codebook_config = [{ org_id: "o1", legend_doc_ids: [] }];
  });
  it("legendIdsAdded: only what a save adds; a stored id (even a stale one) is kept as it is", () => {
    expect(legendIdsAdded([OWN, "stale"], ["stale"])).toEqual([OWN]);
    expect(legendIdsAdded(["stale"], ["stale", OWN])).toEqual([]);
    expect(KNOWLEDGE_DOC_ID_RE.test(OWN)).toBe(true);
    expect(KNOWLEDGE_DOC_ID_RE.test("not-a-uuid")).toBe(false);
  });
  it("reproduction → fix: the codebook save refuses another org's document and a non-id, BEFORE anything is written", async () => {
    await expect(saveConfig("o1", { legendDocIds: [FOREIGN] }, "u1")).rejects.toThrow(/is not a knowledge document of this workspace/);
    await expect(saveConfig("o1", { legendDocIds: ["not-a-uuid"] }, "u1")).rejects.toThrow(/is not a knowledge document id/);
    expect(db.ref.calls.some((c) => c.table === "codebook_config" && c.method === "upsert")).toBe(false);
    expect(db.ref.tables.codebook_config[0].legend_doc_ids).toEqual([]);
    // the org predicate is in the query, never assumed from the caller
    const q = db.ref.calls.filter((c) => c.table === "knowledge_documents");
    expect(q.some((c) => c.method === "eq" && c.args[0] === "org_id" && c.args[1] === "o1")).toBe(true);
  });
  it("the org's own document saves; detaching a sheet beside a stale stored id still saves (only added ids are checked)", async () => {
    await saveConfig("o1", { legendDocIds: [OWN] }, "u1");
    expect(db.ref.tables.codebook_config[0].legend_doc_ids).toEqual([OWN]);
    db.ref.tables.codebook_config[0].legend_doc_ids = [OWN, "deadbeef-0000-0000-0000-000000000000"];
    await saveConfig("o1", { legendDocIds: ["deadbeef-0000-0000-0000-000000000000"] }, "u1");
    expect(db.ref.tables.codebook_config[0].legend_doc_ids).toEqual(["deadbeef-0000-0000-0000-000000000000"]);
    // an empty list (detach all) reads nothing and writes as before
    db.ref.calls.length = 0;
    await saveConfig("o1", { legendDocIds: [] }, "u1");
    expect(db.ref.calls.some((c) => c.table === "knowledge_documents")).toBe(false);
  });
  it("a code-rule save (no legend in the patch) reads and checks nothing new — today's write, byte for byte", async () => {
    await saveConfig("o1", { iterableRule: { mirrorsTag: true, padTo: 2 } }, "u1");
    expect(db.ref.calls.map((c) => `${c.table}.${c.method}`)).toEqual(["codebook_config.upsert", "codebook_config.select"]);
  });
  it("the database's refusal (20261178) reads as a refusal", async () => {
    // the page's save is an upsert: 20261178's BEFORE INSERT arm checks it ahead of ON CONFLICT
    db.ref.beforeInsert = { codebook_config: () => { throw { code: "23503", message: `legend_doc_ids_invalid: ${FOREIGN} is not a knowledge document of this workspace` }; } };
    db.ref.tables.knowledge_documents.push({ id: FOREIGN, org_id: "o1" }); // the app's read is stale; the database decides
    await expect(saveConfig("o1", { legendDocIds: [FOREIGN] }, "u1")).rejects.toThrow(/Not saved — a legend sheet must be a document indexed in this workspace's knowledge libraries \(44444444-0000-0000-0000-000000000002 is not a knowledge document of this workspace\)/);
  });
  it("assertOrgKnowledgeDocIds: an own id passes, a non-string is refused, and nothing is read for an empty list", async () => {
    await expect(assertOrgKnowledgeDocIds("o1", [OWN.toUpperCase()])).resolves.toBeUndefined();
    await expect(assertOrgKnowledgeDocIds("o1", [42])).rejects.toThrow(/42 is not a knowledge document id/);
    db.ref.calls.length = 0;
    await assertOrgKnowledgeDocIds("o1", []);
    expect(db.ref.calls).toEqual([]);
  });
  it("the library toggles save: the RPC's refusal is said; before 20261178 / 20261121 the app checks added ids itself", async () => {
    db.ref.tables.knowledge_libraries = [{ id: "lib-1", org_id: "o1", ai_features: { legendDocIds: ["stale"], embedBuild: { userId: "x" } } }];
    // with the RPC (20261178): the database's refusal
    db.rpc = () => ({ data: null, error: { code: "23503", message: `legend_doc_ids_invalid: ${FOREIGN} is not a knowledge document of this workspace` } });
    await expect(saveLibraryAiFeatures("lib-1", { legendDocIds: [FOREIGN] })).rejects.toThrow(/Library AI setup was not saved — a legend sheet must be a document indexed in this workspace/);
    // without it (PGRST202): the fallback refuses a foreign id before its update…
    db.rpc = null;
    await expect(saveLibraryAiFeatures("lib-1", { legendDocIds: ["stale", FOREIGN] })).rejects.toThrow(/is not a knowledge document of this workspace/);
    expect(db.ref.calls.some((c) => c.table === "knowledge_libraries" && c.method === "update")).toBe(false);
    // …and saves the org's own document beside the stale stored id, keeping the marker
    await saveLibraryAiFeatures("lib-1", { legendDocIds: ["stale", OWN], visionPages: true });
    expect(db.ref.tables.knowledge_libraries[0].ai_features).toEqual({ legendDocIds: ["stale", OWN], visionPages: true, embedBuild: { userId: "x" } });
  });
});

describe("the codebook page — rename in place, the server re-decode, today's authority", () => {
  const page = repo("app/(protected)/admin/codebook/page.tsx");
  it("the WRITER_ROLES constant (pinned to ADMIN_SURFACES) is unchanged", () => {
    expect(page).toContain('const WRITER_ROLES = new Set(["Admin", "DocCtrl"]);');
  });
  it("the rename: unit / type rows only, previewed (dry run), blockers shown, the apply carries the preview, a missing migration says today's way", () => {
    expect(page).toContain('{entry.kind !== "drawing_type" && (');
    expect(page).toContain("const preview = await renameCodebookCode(orgId, { kind, from: entry.code, to, dryRun: true });");
    expect(page).toContain('if (preview.needsMigration) await appAlert({ title: "Renaming in place is not available yet", message: preview.error });');
    expect(page).toContain("if (p.blockers.length > 0) {");
    expect(page).toContain("message: renameSummary(p), confirmLabel: \"Rename\"");
    expect(page).toContain("const done = await renameCodebookCode(orgId, { kind, from: entry.code, to, dryRun: false, expected: p });");
  });
  it("the re-decode panel previews on the server and applies with the preview's token; a moved plan re-previews", () => {
    expect(page).toContain("const r = await previewRedecode(orgId);");
    expect(page).toContain("const r = await applyRedecode(orgId, preview.token);");
    expect(page).toContain("if (r.changed) void load();");
    expect(page).toContain("Codebook versions start once migration 20261178 is applied; the re-decode itself works now.");
    expect(page).toContain("{canWrite && activeOrgId && <RedecodePanel orgId={activeOrgId} onError={setError} />}");
  });
  it("the removal refusal points at the rename as well as refiling", () => {
    expect(page).toContain("or, if the code itself is wrong, rename it in place (the pencil beside it): everything that references it follows.");
  });
});
