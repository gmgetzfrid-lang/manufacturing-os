// intelligence Round G (I-11, integrator fix pass) — AREA-2: the registry
// drawer's Unlink says what it found. A delete that matches 0 rows has four
// causes (the sweep's 'drawing' row, a writer role no longer held, a document
// no longer readable, a link already gone); only one of them is "go dismiss
// the tag in the Equipment sweep". lib/assets.ts unlinkDocumentFromAsset reads
// the row first and names the cause; the page shows its sentence and refreshes.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newFakeDb, type FakeDb } from "./helpers/fakeSupabase";

const db = vi.hoisted(() => ({ ref: null as unknown as FakeDb }));
vi.mock("@/lib/supabase", async () => {
  const { makeFakeSupabase, newFakeDb: fresh } = await import("./helpers/fakeSupabase");
  db.ref = fresh();
  const proxy = new Proxy({}, { get: (_t, p: string) => (makeFakeSupabase(db.ref) as Record<string, unknown>)[p] });
  return { supabase: proxy };
});

import { unlinkDocumentFromAsset, UNLINK_DRAWING_MESSAGE, UNLINK_REFUSED_MESSAGE } from "@/lib/assets";

beforeEach(() => {
  Object.assign(db.ref, newFakeDb());
  db.ref.tables = {
    document_assets: [
      { id: "m1", org_id: "o1", document_id: "D-1", asset_id: "a1", source: "manual" },
      { id: "r1", org_id: "o1", document_id: "D-2", asset_id: "a1", source: "drawing" },
      { id: "j1", org_id: "o1", document_id: "D-3", asset_id: "a1", source: "jsonb_sync" },
    ],
  };
});

describe("unlinkDocumentFromAsset — what was found decides what is said", () => {
  it("a manual link is removed, nothing said", async () => {
    expect(await unlinkDocumentFromAsset("D-1", "a1")).toEqual({ found: "removed", message: null });
    expect(db.ref.tables.document_assets.map((r) => r.id)).toEqual(["r1", "j1"]);
  });
  it("a link already gone (another person unlinked it) is 'gone' with nothing to say — never the sweep sentence", async () => {
    db.ref.tables.document_assets = db.ref.tables.document_assets.filter((r) => r.id !== "m1");
    // Reproduction: fix pass 1 deleted first, read 0 rows, and sent the person to dismiss a tag the sweep never proposed.
    expect(await unlinkDocumentFromAsset("D-1", "a1")).toEqual({ found: "gone", message: null });
    expect(db.ref.calls.some((c) => c.table === "document_assets" && c.method === "delete")).toBe(false);
  });
  it("the sweep's 'drawing' row is not deleted from here: the person is sent to the Equipment sweep, and no delete is sent", async () => {
    const res = await unlinkDocumentFromAsset("D-2", "a1");
    expect(res).toEqual({ found: "drawing", message: UNLINK_DRAWING_MESSAGE });
    expect(res.message).toMatch(/dismissing the tag in that library's Equipment sweep/);
    expect(db.ref.calls.some((c) => c.table === "document_assets" && c.method === "delete")).toBe(false);
    expect(db.ref.tables.document_assets).toHaveLength(3);
  });
  it("a delete the policy refuses (the writer role or the document's access is gone) names that — never the sweep", async () => {
    db.ref.refuseWrites.add("document_assets");
    const res = await unlinkDocumentFromAsset("D-1", "a1");
    expect(res).toEqual({ found: "refused", message: UNLINK_REFUSED_MESSAGE });
    expect(res.message).toMatch(/registry writer role or access to this document/);
    expect(res.message).not.toMatch(/Equipment sweep/);
  });
  it("a delete that errors carries the database's message; a read that fails says the link could not be read and deletes nothing", async () => {
    db.ref.deleteErrors = { document_assets: { code: "57014", message: "canceling statement due to statement timeout" } };
    expect(await unlinkDocumentFromAsset("D-1", "a1")).toEqual({ found: "refused", message: "canceling statement due to statement timeout" });
    db.ref.deleteErrors = {};
    db.ref.calls.length = 0;
    db.ref.selectErrors = { document_assets: { code: "57014", message: "canceling statement due to statement timeout" } };
    const res = await unlinkDocumentFromAsset("D-1", "a1");
    expect(res.found).toBe("unreadable");
    expect(res.message).toMatch(/This link could not be read \(canceling statement/);
    expect(db.ref.calls.some((c) => c.table === "document_assets" && c.method === "delete")).toBe(false);
    expect(db.ref.tables.document_assets).toHaveLength(3);
  });
  it("the jsonb_sync row (a person's own tag on the document) is a person's to remove, as before", async () => {
    expect(await unlinkDocumentFromAsset("D-3", "a1")).toEqual({ found: "removed", message: null });
  });
});

describe("the registry drawer uses it", () => {
  it("unlinkDocument confirms, calls unlinkDocumentFromAsset, shows its sentence and refreshes — no delete of its own", () => {
    const page = readFileSync(join(process.cwd(), "app", "(protected)", "admin", "assets", "page.tsx"), "utf8");
    const at = page.indexOf("const unlinkDocument = async");
    const body = page.slice(at, page.indexOf("refreshDocs();", at));
    expect(body).toMatch(/await appConfirm\(\{/);
    expect(body).toMatch(/const res = await unlinkDocumentFromAsset\(documentId, asset\.id\);\s*if \(res\.message\) setError\(res\.message\);/);
    expect(body).not.toMatch(/from\("document_assets"\)/);
    expect(page).toMatch(/unlinkDocumentFromAsset,[\s\S]*?\} from "@\/lib\/assets";/);
  });
});
