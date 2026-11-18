// projects-joint J15b CHECKED-WRITE SWEEP (SAF-18) — the browser-side
// libraries of the batch (notes, operational scope, plot plans and the
// equipment whiteboard, AI instructions, knowledge libraries, the activity
// thread, notifications, document intents), each over the in-memory
// database (./knowledgeFakeDb) standing in for the signed-in client.
//
// For every converted site: a write that matched no row (what row-level
// security answers: `{ data: [], error: null }`) is reported — the typed
// refusal (CHECKED_WRITE_REFUSED) for a person's own act, with NO audit row
// after it — or, where zero rows is legitimate (class (c)), stays a quiet
// success; a database error keeps the database's own sentence; and the
// success path writes and audits exactly what it did before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { db, resetDb, rowsOf, type Row, type Op } from "./knowledgeFakeDb";

vi.mock("@/lib/supabase", async () => ({ supabase: (await import("./knowledgeFakeDb")).fakeAdmin }));
const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async (a: Record<string, unknown>) => { audit.calls.push(a); }) }));

import { CHECKED_WRITE_REFUSED } from "@/lib/checkedWrite";
import { userFacingError } from "@/lib/userFacingError";
import { saveMarkers, deletePlotPlan } from "@/lib/plotPlans";
import { setEquipmentState } from "@/lib/whiteboard";
import { saveAiInstruction, deleteAiInstruction } from "@/lib/aiInstructions";
import { deleteKnowledgeLibrary, saveLibraryAiInstructions, setLibraryLinks, deleteKnowledgeDocument } from "@/lib/knowledge";
import {
  updatePlant, updateUnit, updateSystem, archivePlant, setUnitCodebookCode, unlinkDocumentFromAsset, unlinkDocumentFromProject,
} from "@/lib/operationalGraph";
import { updateNoteTaskMeta, updateNoteBody, setNoteResolved, deleteNote } from "@/lib/notes";
import { resolveMessage } from "@/lib/activityThread";
import { markAllRead } from "@/lib/inAppNotifications";

const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };
const fail = (table: string, kind: Op["kind"], err: { code: string; message: string } = TIMEOUT) =>
  db.hooks.push((op) => (op.table === table && op.kind === kind ? { error: err } : undefined));
/** The writes a call made, as the database saw them (selects left out). */
const writes = () => db.ops.filter((o) => o.kind !== "select").map((o) => ({ table: o.table, kind: o.kind, payload: o.payload, filters: o.filters }));

beforeEach(() => {
  audit.calls = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

// ── Plot plans and the equipment whiteboard ──────────────────────────────
describe("plot plans (lib/plotPlans.ts)", () => {
  it("saveMarkers: lands on the plan; a plan RLS hides or that is gone is refused, never 'Saved'; an error keeps its words", async () => {
    resetDb({ plot_plans: [{ id: "pp-1", markers: [] }] });
    await saveMarkers({ id: "pp-1", markers: [{ assetId: "a1", x: 0.5, y: 0.5 }] as never, actorUserId: "u1" });
    expect(rowsOf("plot_plans")[0]).toMatchObject({ markers: [{ assetId: "a1" }], updated_by: "u1" });
    expect(writes()).toEqual([expect.objectContaining({ table: "plot_plans", kind: "update", filters: [{ col: "id", op: "eq", value: "pp-1" }] })]);
    resetDb({ plot_plans: [] });
    await expect(saveMarkers({ id: "pp-1", markers: [], actorUserId: "u1" })).rejects.toThrow(CHECKED_WRITE_REFUSED);
    resetDb({ plot_plans: [{ id: "pp-1" }] });
    fail("plot_plans", "update");
    await expect(saveMarkers({ id: "pp-1", markers: [], actorUserId: "u1" })).rejects.toThrow(TIMEOUT.message);
  });
  it("deletePlotPlan: a delete that matched nothing is refused", async () => {
    resetDb({ plot_plans: [{ id: "pp-1" }] });
    await deletePlotPlan("pp-1");
    expect(rowsOf("plot_plans")).toHaveLength(0);
    await expect(deletePlotPlan("pp-1")).rejects.toThrow(CHECKED_WRITE_REFUSED);
  });
});

describe("the whiteboard flip (lib/whiteboard.ts) — a refused flip writes no audit row", () => {
  const flip = () => setEquipmentState({ assetId: "a1", orgId: "o1", newState: "executing", previousState: "drafting", actorUserId: "u1", reason: "crew on site" });
  it("success: the asset flips and EQUIPMENT_STATE_CHANGED is written, exactly as before", async () => {
    resetDb({ assets: [{ id: "a1", whiteboard_state: "drafting" }] });
    await flip();
    expect(rowsOf("assets")[0]).toMatchObject({ whiteboard_state: "executing", updated_by: "u1" });
    expect(audit.calls).toEqual([{
      orgId: "o1", userId: "u1", userEmail: undefined, userRole: undefined, action: "EQUIPMENT_STATE_CHANGED",
      resourceType: "asset", resourceId: "a1", details: { newState: "executing", previousState: "drafting", reason: "crew on site" },
    }]);
  });
  it("refused (RLS matched nothing): the typed refusal, and no audit row claims the state changed", async () => {
    resetDb({ assets: [] });
    await expect(flip()).rejects.toThrow(CHECKED_WRITE_REFUSED);
    expect(audit.calls).toEqual([]);
  });
});

// ── AI instructions ──────────────────────────────────────────────────────
describe("AI instructions (lib/aiInstructions.ts)", () => {
  const input = { scope: "global" as const, title: "Units", body: "Answer in SI units." };
  it("an edit of an instruction that is gone (or RLS hides) is refused; a new one is inserted as before; a delete that matched nothing is refused", async () => {
    resetDb({ org_ai_instructions: [{ id: "i1", title: "Old" }] });
    await saveAiInstruction("o1", { ...input, id: "i1" }, "u1");
    expect(rowsOf("org_ai_instructions")[0]).toMatchObject({ title: "Units", enabled: true });
    await expect(saveAiInstruction("o1", { ...input, id: "i-gone" }, "u1")).rejects.toThrow(CHECKED_WRITE_REFUSED);
    await saveAiInstruction("o1", input, "u1", "Ann");
    expect(rowsOf("org_ai_instructions")[1]).toMatchObject({ title: "Units", created_by: "u1", created_by_name: "Ann" });
    await deleteAiInstruction("i1");
    await expect(deleteAiInstruction("i1")).rejects.toThrow(CHECKED_WRITE_REFUSED);
  });
});

// ── Knowledge libraries ──────────────────────────────────────────────────
describe("knowledge libraries (lib/knowledge.ts)", () => {
  it("deleting a library or a document RLS filtered to nothing is refused, never 'deleted'", async () => {
    resetDb({ knowledge_libraries: [{ id: "kl-1" }], knowledge_documents: [{ id: "kd-1" }] });
    await deleteKnowledgeDocument("kd-1");
    await expect(deleteKnowledgeDocument("kd-1")).rejects.toThrow(CHECKED_WRITE_REFUSED);
    await deleteKnowledgeLibrary("kl-1");
    await expect(deleteKnowledgeLibrary("kl-1")).rejects.toThrow(CHECKED_WRITE_REFUSED);
  });
  it("saving a library's standing instructions that matched nothing is refused; a save that lands trims as before", async () => {
    resetDb({ knowledge_libraries: [{ id: "kl-1", ai_instructions: null }] });
    await saveLibraryAiInstructions("kl-1", "  cite the sheet  ");
    expect(rowsOf("knowledge_libraries")[0].ai_instructions).toBe("cite the sheet");
    await expect(saveLibraryAiInstructions("kl-gone", "x")).rejects.toThrow(CHECKED_WRITE_REFUSED);
  });
  it("setLibraryLinks (class (c)): a library with no links yet clears nothing and saves; a failed clear keeps the database's words and inserts nothing", async () => {
    resetDb({ knowledge_library_links: [] });
    await setLibraryLinks({ orgId: "o1", libraryId: "kl-1", linkedLibraryIds: ["kl-2"] });
    expect(rowsOf("knowledge_library_links")).toEqual([expect.objectContaining({ library_id: "kl-1", linked_library_id: "kl-2" })]);
    resetDb({ knowledge_library_links: [] });
    fail("knowledge_library_links", "delete");
    await expect(setLibraryLinks({ orgId: "o1", libraryId: "kl-1", linkedLibraryIds: ["kl-2"] })).rejects.toThrow(TIMEOUT.message);
    expect(rowsOf("knowledge_library_links")).toEqual([]);
  });
});

// ── Operational scope ────────────────────────────────────────────────────
describe("operational scope (lib/operationalGraph.ts)", () => {
  it("an edit or archive of a plant / unit / system RLS filtered to nothing is refused; a database error keeps its words; success writes as before", async () => {
    resetDb({ plants: [{ id: "p1", name: "Old" }], units: [{ id: "u1" }], systems: [{ id: "s1" }] });
    await updatePlant("p1", { name: "North" }, "me");
    expect(rowsOf("plants")[0]).toMatchObject({ name: "North", updated_by: "me" });
    await archivePlant("p1", "me");
    expect(rowsOf("plants")[0].archived).toBe(true);
    await expect(updatePlant("p-gone", { name: "x" }, "me")).rejects.toThrow(CHECKED_WRITE_REFUSED);
    await expect(updateUnit("u-gone", { name: "x" }, "me")).rejects.toThrow(CHECKED_WRITE_REFUSED);
    await expect(updateSystem("s-gone", { name: "x" }, "me")).rejects.toThrow(CHECKED_WRITE_REFUSED);
    fail("units", "update");
    await expect(updateUnit("u1", { name: "x" }, "me")).rejects.toThrow(TIMEOUT.message);
  });
  it("setUnitCodebookCode keeps every message it gave: a conflict, a denial, a pending migration, a refusal, an archived unit", async () => {
    resetDb({ units: [{ id: "u1", codebook_code: null }] });
    await setUnitCodebookCode("u1", " 025 ", "me");
    expect(rowsOf("units")[0].codebook_code).toBe("025");
    await expect(setUnitCodebookCode("u-gone", "025", "me")).rejects.toThrow("Not saved — the mapping was refused.");
    const cases: Array<[{ code: string; message: string }, string | RegExp]> = [
      [{ code: "23505", message: "duplicate key value violates unique constraint \"units_org_codebook_code_uniq\"" }, "Site Codebook unit 025 is already mapped to another operational unit — unmap it there first."],
      [{ code: "42501", message: "units_codebook_code_scope_writers" }, "Not saved — only the roles that edit the operational scope can map a unit to the Site Codebook."],
      [{ code: "PGRST204", message: "Could not find the 'codebook_code' column of 'units' in the schema cache" }, "The unit-identity migration (20261138) is not applied yet — the mapping cannot be saved."],
      [TIMEOUT, TIMEOUT.message],
    ];
    for (const [err, said] of cases) {
      resetDb({ units: [{ id: "u1", codebook_code: null }] });
      fail("units", "update", err);
      await expect(setUnitCodebookCode("u1", "025", "me")).rejects.toThrow(said);
    }
    // the guard releases an archived unit's code: the value read back differs
    resetDb({ units: [{ id: "u1", codebook_code: null }] });
    db.hooks.push((op) => { if (op.table === "units" && op.kind === "update") (op.payload as Row).codebook_code = null; });
    await expect(setUnitCodebookCode("u1", "025", "me")).rejects.toThrow("Not saved — an archived unit holds no Site Codebook unit (restore it first).");
  });
  it("an unlink that matched nothing is refused", async () => {
    resetDb({ document_assets: [{ id: "da1", document_id: "d1", asset_id: "a1" }], project_documents: [{ id: "pd1", project_id: "p1", document_id: "d1" }] });
    await unlinkDocumentFromAsset("d1", "a1");
    await unlinkDocumentFromProject("p1", "d1");
    expect(rowsOf("document_assets")).toEqual([]);
    expect(rowsOf("project_documents")).toEqual([]);
    await expect(unlinkDocumentFromAsset("d1", "a1")).rejects.toThrow(CHECKED_WRITE_REFUSED);
    await expect(unlinkDocumentFromProject("p1", "d1")).rejects.toThrow(CHECKED_WRITE_REFUSED);
  });
  it("the /admin/scope page catches a refused edit or archive: a refused save is said INSIDE the open edit dialog (its overlay covers the page line), the typed values kept; an archive on the page's line", () => {
    const page = readFileSync("app/(protected)/admin/scope/page.tsx", "utf8");
    const save = page.slice(page.indexOf("const onSaveEdit = async"), page.indexOf("const labelOf ="));
    expect(save).toMatch(/try \{[\s\S]*updatePlant[\s\S]*updateUnit[\s\S]*updateSystem[\s\S]*\} catch \(e\) \{\s*setEditError\(userFacingError\(e, \{ context: "admin\/scope save" \}\)\);\s*return;\s*\}\s*setEditing\(null\);/);
    expect(save).not.toContain("setError(");
    // the dialog is handed the error, and cancelling clears it
    const mount = page.slice(page.indexOf("<EditScopeRowModal"), page.indexOf("/>", page.indexOf("<EditScopeRowModal")));
    expect(mount).toContain("error={editError}");
    expect(mount).toContain("onCancel={() => { setEditing(null); setEditError(null); }}");
    // …and renders it inside its own form, under the fields, while the typed
    // values stay in the dialog's state (it is not unmounted on a refusal)
    const modal = page.slice(page.indexOf("function EditScopeRowModal("), page.indexOf("function Field("));
    const form = modal.slice(modal.indexOf("<form onSubmit={onSubmit}"), modal.indexOf("</form>"));
    expect(form).toMatch(/\{error && \(\s*<div role="alert" data-edit-error[^>]*>\s*<AlertTriangle[^>]*\/> \{error\}\s*<\/div>\s*\)\}/);
    expect(form.indexOf("{error && (")).toBeGreaterThan(form.indexOf('label="Description"'));
    const archive = page.slice(page.indexOf("const onArchive = async"), page.indexOf("// ─── Render"));
    expect(archive).toMatch(/try \{[\s\S]*archivePlant[\s\S]*archiveUnit[\s\S]*archiveSystem[\s\S]*\} catch \(e\) \{[\s\S]*setError\(userFacingError\(e, \{ context: "admin\/scope archive" \}\)\);\s*return;\s*\}/);
    // the refusal itself passes through as written; raw driver text never does
    expect(userFacingError(new Error(CHECKED_WRITE_REFUSED))).toBe(CHECKED_WRITE_REFUSED);
    expect(userFacingError(new Error(TIMEOUT.message))).not.toContain("canceling statement");
  });
});

// ── Notes ────────────────────────────────────────────────────────────────
const note = (over: Row = {}): Row => ({
  id: "n1", org_id: "o1", body: "- [ ] call vendor", raw_body: null, task_meta: {}, document_id: null, project_id: null, asset_id: null,
  resolved: false, resolved_at: null, resolved_by: null, created_at: "2026-11-01", created_by: "u1", created_by_name: "Ann",
  updated_at: "2026-11-01", updated_by: "u1", ...over,
});
describe("notes (lib/notes.ts) — a refused resolve or delete writes no audit row", () => {
  it("setNoteResolved: success returns the note and audits NOTE_RESOLVED with its org, as before; a note RLS hides is refused with no audit row", async () => {
    resetDb({ notes: [note()] });
    const out = await setNoteResolved({ id: "n1", resolved: true, actorUserId: "u2" });
    expect(out).toMatchObject({ id: "n1", resolved: true, resolvedBy: "u2", orgId: "o1" });
    expect(audit.calls).toEqual([{ action: "NOTE_RESOLVED", resourceId: "n1", resourceType: "note", orgId: "o1", userId: "u2", userEmail: undefined, userRole: undefined }]);
    audit.calls = [];
    await expect(setNoteResolved({ id: "n-gone", resolved: true, actorUserId: "u2" })).rejects.toThrow(CHECKED_WRITE_REFUSED);
    expect(audit.calls).toEqual([]);
    fail("notes", "update");
    await expect(setNoteResolved({ id: "n1", resolved: false, actorUserId: "u2" })).rejects.toThrow(TIMEOUT.message);
    expect(audit.calls).toEqual([]);
  });
  it("deleteNote: success audits NOTE_DELETED; a delete that matched nothing is refused and NOTE_DELETED is never written", async () => {
    resetDb({ notes: [note()] });
    await deleteNote("n1", "u1", "o1");
    expect(audit.calls).toEqual([{ action: "NOTE_DELETED", resourceId: "n1", resourceType: "note", orgId: "o1", userId: "u1" }]);
    audit.calls = [];
    await expect(deleteNote("n1", "u1", "o1")).rejects.toThrow(CHECKED_WRITE_REFUSED);
    expect(audit.calls).toEqual([]);
  });
  it("updateNoteBody: the saved note comes back; a note that is gone is refused in plain words (not PostgREST's single-row text)", async () => {
    resetDb({ notes: [note()] });
    expect(await updateNoteBody({ id: "n1", body: "- [ ] call vendor today", updatedBy: "u2" })).toMatchObject({ id: "n1", body: "- [ ] call vendor today", updatedBy: "u2" });
    await expect(updateNoteBody({ id: "n-gone", body: "x", updatedBy: "u2" })).rejects.toThrow(CHECKED_WRITE_REFUSED);
  });
  it("updateNoteTaskMeta (class (b)): true when it landed, false when it matched nothing or failed — never true for nothing", async () => {
    resetDb({ notes: [note()] });
    expect(await updateNoteTaskMeta("n1", { "call vendor": { snoozes: 1 } as never }, "u1")).toBe(true);
    expect(await updateNoteTaskMeta("n-gone", {}, "u1")).toBe(false);
    fail("notes", "update");
    expect(await updateNoteTaskMeta("n1", {}, "u1")).toBe(false);
  });
});

// ── The activity thread and notifications ────────────────────────────────
describe("resolveMessage (lib/activityThread.ts)", () => {
  it("a message RLS hides, or that is gone, is refused; a database error is thrown as it was; the thread says a refusal in plain words", async () => {
    resetDb({ checkout_messages: [{ id: "m1", resolved_at: null }] });
    await resolveMessage("m1", "u1");
    expect(rowsOf("checkout_messages")[0]).toMatchObject({ resolved_by_user_id: "u1" });
    await expect(resolveMessage("m-gone", "u1")).rejects.toThrow(CHECKED_WRITE_REFUSED);
    fail("checkout_messages", "update");
    await expect(resolveMessage("m1", "u1")).rejects.toEqual(TIMEOUT);
    const thread = readFileSync("components/documents/ActivityThread.tsx", "utf8");
    const mark = thread.slice(thread.indexOf("const markResolved = async"), thread.indexOf("return (", thread.indexOf("const markResolved = async")));
    expect(mark).toContain('showToast({ type: "error", title: "Couldn\'t mark it resolved", message: userFacingError(e, { context: "activity resolve" }) });');
  });
});

describe("markAllRead (lib/inAppNotifications.ts) — class (c)", () => {
  it("nothing unread matches nothing: a quiet success; the workspace filter is kept; an error is refused in the database's words", async () => {
    resetDb({ notifications: [{ id: "x1", org_id: "o1", read_at: null }, { id: "x2", org_id: "o2", read_at: null }] });
    await markAllRead("o1");
    expect(rowsOf("notifications").map((n) => n.read_at === null)).toEqual([false, true]);
    expect(writes()[0].filters).toEqual([{ col: "read_at", op: "is", value: null }, { col: "org_id", op: "eq", value: "o1" }]);
    await expect(markAllRead("o1")).resolves.toBeUndefined();
    fail("notifications", "update");
    await expect(markAllRead()).rejects.toThrow(`Marking read was refused: ${TIMEOUT.message}`);
  });
});

// ── Document intents: the pre-migration latch sees the whole error ───────
describe("intents (lib/intents.ts) — rule 4: the latch reads code AND message", () => {
  const missing = { message: 'relation "document_intents" does not exist' } as unknown as { code: string; message: string };
  const load = async () => { vi.resetModules(); return import("@/lib/intents"); };
  it("recordIntent: a lapsed-row clear answered with no code, only the message, sets the latch — no upsert, nothing logged, no further calls", async () => {
    const { recordIntent } = await load();
    resetDb({ document_intents: [] });
    fail("document_intents", "delete", missing);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const input = { orgId: "o1", documentId: "d1", userId: "u1", kind: "edit", source: "checkout", baseVersionId: null } as never;
    await recordIntent(input);
    expect(db.ops.map((o) => o.kind)).toEqual(["delete"]);
    await recordIntent(input);
    expect(db.ops).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
  it("endMyIntents: the same error sets the latch — nothing logged, no further calls", async () => {
    const { endMyIntents } = await load();
    resetDb({ document_intents: [] });
    fail("document_intents", "delete", missing);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await endMyIntents({ documentId: "d1", userId: "u1" });
    await endMyIntents({ documentId: "d1", userId: "u1" });
    expect(db.ops).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
  it("endMyIntents (class (c)): none to end is a quiet success; the source filter is kept; any other error is logged, never silent", async () => {
    const { endMyIntents } = await load();
    resetDb({ document_intents: [{ id: "i1", document_id: "d1", user_id: "u1", source: "checkout" }, { id: "i2", document_id: "d1", user_id: "u1", source: "review" }] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await endMyIntents({ documentId: "d1", userId: "u1", sources: ["checkout"] as never });
    expect(rowsOf("document_intents").map((r) => r.id)).toEqual(["i2"]);
    await endMyIntents({ documentId: "d1", userId: "u1", sources: ["checkout"] as never });
    expect(warn).not.toHaveBeenCalled();
    fail("document_intents", "delete");
    await endMyIntents({ documentId: "d1", userId: "u1" });
    expect(warn).toHaveBeenCalledWith("[intents] ending intents failed (non-blocking)", TIMEOUT.message);
  });
});
