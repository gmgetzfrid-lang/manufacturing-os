// Phase 7 build 1 / Round C4 — GAP-7 / DEC-24: markup as a durable,
// addressable artifact (LIFE-3; drafting-flow LEAK-5). The viewer's normalized
// per-page fabric JSON is kept server-side, one row per (document, version,
// user), autosaved as the user works and restored on reopen; the register's
// inspector lists every markup on a document; 20261051 adds the store.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, unknown>,
  errors: {} as Record<string, { code?: string; message: string } | null>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));
function chain(table: string) {
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: state.tables[table] ?? null, error: state.errors[table] ?? null });
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "maybeSingle" || prop === "single") return Promise.resolve({ data: state.tables[table] ?? null, error: state.errors[table] ?? null });
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));
import { loadMyMarkup, saveMyMarkup, listMarkupsForDocument, markedPages, isEmptyMarkup, isMissingMarkupSchema, myActiveSessionId, MARKUP_CONFLICT } from "@/lib/markups";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const drawn = { 1: { objects: [{ type: "path" }] }, 2: { objects: [] }, 3: { objects: [{ type: "rect" }, { type: "text" }] } } as Record<number, object>;

beforeEach(() => { state.tables = {}; state.errors = {}; state.calls = []; });

describe("lib/markups — the store", () => {
  it("markedPages / isEmptyMarkup read the fabric shape the viewer produces", () => {
    expect(markedPages(drawn)).toEqual([1, 3]);
    expect(isEmptyMarkup(drawn)).toBe(false);
    expect(isEmptyMarkup({ 1: { objects: [] } })).toBe(true);
    expect(isEmptyMarkup(undefined)).toBe(true);
  });
  it("saveMyMarkup upserts one row per (document, version, user) with the page count and the checkout session as provenance", async () => {
    state.tables.document_markups = { id: "m1", org_id: "o1", document_id: "d1", version_id: "v1", user_id: "u1", checkout_session_id: "s1", page_states: drawn, page_count: 2, created_at: "t", updated_at: "t" };
    const out = await saveMyMarkup({ orgId: "o1", documentId: "d1", versionId: "v1", uid: "u1", checkoutSessionId: "s1", pageStates: drawn });
    const up = state.calls.find((c) => c.table === "document_markups" && c.method === "upsert")!;
    expect(up.args[0]).toMatchObject({ org_id: "o1", document_id: "d1", version_id: "v1", user_id: "u1", checkout_session_id: "s1", page_count: 2, page_states: drawn });
    expect(up.args[1]).toEqual({ onConflict: MARKUP_CONFLICT });
    expect(MARKUP_CONFLICT).toBe("document_id,version_id,user_id");
    expect(out).toMatchObject({ id: "m1", pageCount: 2, checkoutSessionId: "s1" });
  });
  it("a markup with nothing drawn removes the row instead of leaving a ghost; a refused write throws", async () => {
    expect(await saveMyMarkup({ orgId: "o1", documentId: "d1", versionId: "v1", uid: "u1", pageStates: { 1: { objects: [] } } })).toBeNull();
    expect(state.calls.some((c) => c.table === "document_markups" && c.method === "delete")).toBe(true);
    expect(state.calls.some((c) => c.table === "document_markups" && c.method === "upsert")).toBe(false);
    state.errors.document_markups = { code: "42501", message: "permission denied" };
    await expect(saveMyMarkup({ orgId: "o1", documentId: "d1", versionId: "v1", uid: "u1", pageStates: drawn })).rejects.toThrow(/permission denied/);
  });
  it("pre-migration: a missing table reads as empty and a write is reported, not thrown", async () => {
    state.errors.document_markups = { code: "42P01", message: 'relation "document_markups" does not exist' };
    expect(isMissingMarkupSchema(state.errors.document_markups)).toBe(true);
    expect(await loadMyMarkup("d1", "v1", "u1")).toBeNull();
    expect(await listMarkupsForDocument("d1")).toEqual([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await saveMyMarkup({ orgId: "o1", documentId: "d1", versionId: "v1", uid: "u1", pageStates: drawn })).toBeNull();
    expect(warn).toHaveBeenCalled(); warn.mockRestore();
  });
  it("loadMyMarkup maps the row; listMarkupsForDocument attaches author names", async () => {
    state.tables.document_markups = { id: "m1", org_id: "o1", document_id: "d1", version_id: "v1", user_id: "u2", checkout_session_id: null, page_states: drawn, page_count: 2, created_at: "t", updated_at: "t2" };
    expect((await loadMyMarkup("d1", "v1", "u2"))?.pageStates).toEqual(drawn);
    state.tables.document_markups = [state.tables.document_markups];
    state.tables.org_members = [{ uid: "u2", display_name: "Ola Example", email: "ola@x.io" }];
    const list = await listMarkupsForDocument("d1");
    expect(list).toHaveLength(1);
    expect(list[0].userName).toBe("Ola Example");
    state.tables.checkout_sessions = { id: "s9" };
    expect(await myActiveSessionId("d1", "u2")).toBe("s9");
  });
});

describe("pinned at the source — the hooks are wired, nothing new is built", () => {
  it("the register page seeds the viewer from the store, saves on change and on close, and opens a chosen markup", () => {
    const p = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(p).toContain("const mine = await loadMyMarkup(docId, versionId, uid);");
    expect(p).toContain("initialPageStates={markupSeed.states}");
    expect(p).toMatch(/onPageStatesChange=\{markupSeed\.readOnly \? undefined : \(states\) => \{ void persistMarkup\(states\)/);
    expect(p).toMatch(/onCommit=\{markupSeed\.readOnly \? undefined : async \(states\) => \{/);
    expect(p).toContain("await saveMyMarkup({ orgId: activeOrgId, documentId: selectedDoc.id, versionId: selectedVersion.id, uid, checkoutSessionId: sessionId, pageStates: states });");
    expect(p).toContain("readOnly: pendingMarkup.userId !== uid");
    expect(p).toContain("onOpenMarkup={(m) => {");
    expect(p).toContain("{showFullScreen && selectedDoc && selectedVersion && markupSeed && (");
  });
  it("the viewer reports page states as they change (autosave), not only on close", () => {
    const v = src("components/viewers/FullScreenViewer.tsx");
    expect(v).toMatch(/if \(onPageStatesChange && Object\.keys\(pageStates\)\.length > 0\) onPageStatesChange\(pageStates\);/);
    expect(v).toContain("if (onCommit) {");
  });
  it("the inspector lists markups on the document; the draft stash stays non-destructive", () => {
    const i = src("components/documents/InspectorPanel.tsx");
    expect(i).toContain('<CollapsibleSection id="markups" title="Markups" icon={PenLine}>');
    expect(i).toContain("<MarkupsSection documentId={selectedDoc.id}");
    const ms = src("components/documents/MarkupsSection.tsx");
    expect(ms).toContain("listMarkupsForDocument(documentId)");
    expect(ms).toContain('{mine ? "Open & continue" : "View"}');
    expect(src("lib/draftHandoff.ts")).not.toContain("export async function takeDraft");
  });
});

describe("20261051 — the store", () => {
  const m = src("supabase/migrations/20261051_rp_phase7_markup_store.sql");
  it("one row per (document, version, user); reads as visible as the document; writes are the author's; controllers may delete", () => {
    expect(m).toContain("CREATE UNIQUE INDEX IF NOT EXISTS document_markups_one_per_user_version\n  ON document_markups (document_id, version_id, user_id);");
    expect(m).toContain("version_id UUID NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,");
    expect(m).toContain("ALTER TABLE document_markups ENABLE ROW LEVEL SECURITY;");
    expect(m).toMatch(/CREATE POLICY document_markups_select ON document_markups FOR SELECT USING \([\s\S]*FROM documents d WHERE d\.id = document_markups\.document_id/);
    expect(m).toMatch(/CREATE POLICY document_markups_insert ON document_markups FOR INSERT WITH CHECK \(\s*\n\s*user_id = auth\.uid\(\)/);
    expect(m).toMatch(/CREATE POLICY document_markups_update ON document_markups FOR UPDATE\s*\n\s*USING \(user_id = auth\.uid\(\)\)\s*\n\s*WITH CHECK \(user_id = auth\.uid\(\)\);/);
    expect(m).toMatch(/CREATE POLICY document_markups_delete ON document_markups FOR DELETE USING \(\s*\n\s*user_id = auth\.uid\(\) OR is_org_controller\(org_id\)/);
    expect(m).not.toMatch(/SECURITY DEFINER/);
  });
  it("COMMIT before verification; probes carry no bare cast", () => {
    expect(m.indexOf("COMMIT;")).toBeLessThan(m.indexOf("── Verification"));
    const v = m.slice(m.indexOf("── Verification"));
    for (const x of v.matchAll(/(?:qual|with_check) LIKE '((?:[^']|'')*)'/g)) expect(x[1]).not.toMatch(/\w::\w/);
  });
});
