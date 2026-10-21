// lib/__tests__/aoRoundGP18RestoreReviewModel.test.ts
//
// admin-and-org Round G, package P18 RESTORE REVIEW-MODEL ROWS — drafting-flow
// TIER-1 and GAP-110 / DEC-34 restore remainders (assigned at the DF-P6
// merge, DEC-31). A ticket restored from a backup keeps the review-model
// meaning it had. Rulings under DEC-90 (fail-safe, no regression):
//   (1) a tickets row with NO review_model_filed key is restored with
//       review_model_filed = false (and, with no engineering_required key,
//       engineering_required = false — the SEED), so today's role-based gate
//       decides for it exactly as for a request filed before 20261250; a row
//       carrying a key keeps its value;
//   (2) a restored declaration whose e-signature does not stand in the target
//       has its four like_in_kind_* columns cleared together and
//       engineering_required set true, reported per request;
//   (3) both only when the TARGET has the columns; without 20261250 nothing is
//       sent for them and the restore behaves as before;
//   (4) the write is ON CONFLICT DO NOTHING — a request already here is never
//       touched;
//   (5) every other table, count, note and outcome is unchanged.
//
// The routes run for real against the in-memory engine (restoreMemoryDb);
// `db.missingColumns.tickets` set is the database without 20261250.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { db, from, type Row } from "./helpers/restoreMemoryDb";

vi.mock("@/lib/serverAuth", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  return {
    authorizeOrgRole: vi.fn(async (_req: unknown, orgId: string) => ({
      userId: "admin-1", email: "admin@x.io", orgId, role: "Admin", roles: ["Admin"], admin: { from: mem.from },
    })),
  };
});

import { POST as applyTable } from "@/app/api/admin/restore/apply-table/route";
import { POST as beginRoute } from "@/app/api/admin/restore/begin/route";
import {
  applyRestoreChunk, planRestore, runChunkedRestore, restoreRefusalLabel,
  filedBeforeReviewModel, asFiledBeforeReviewModel, carriesDeclaration, filedBeforeReviewModelNote,
  declarationNoteRenumbered, reviewModelSchemaCacheMessage,
  RESTORE_REVIEW_MODEL_COLUMNS, LIKE_IN_KIND_COLUMNS, DECLARATION_NOT_RESTORED, TICKET_RENUMBERED,
  type RestorePost, type RestoreEnvelopeLike,
} from "@/lib/dataRestore";
import { reviewModelFieldsFromRow, isDeclaredLikeInKind, reviewModelBinds } from "@/lib/reviewModel";
import { engineeringGateRequired, requesterBindingApplies } from "@/lib/workflow";
import type { Ticket } from "@/types/schema";

const ORG = "org-1";
const OTHER = "other-org";
const REMAP = { orgId: { "backup-org": ORG }, uid: {} };
const SIG = "11111111-2222-4333-8444-555555555555";
const SIG_ELSEWHERE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const STATEMENT = "Replacing the 2in gate valve on line 14 with the identical model and rating.";

/** A request as a backup taken BEFORE 20261250 carries it (none of the new keys). */
const prePaste = (id: string, num: string, extra: Row = {}): Row => ({ id, org_id: "backup-org", ticket_id: num, title: `Request ${num}`, status: "PENDING_REVIEW", requester_role: "Manager", requester_id: "u-req", ...extra });
/** A request as a backup taken AFTER 20261250 carries it. */
const postPaste = (id: string, num: string, extra: Row = {}): Row => ({
  ...prePaste(id, num), review_model_filed: true, engineering_required: true,
  like_in_kind_statement: null, like_in_kind_declared_by: null, like_in_kind_declared_at: null, like_in_kind_signature_id: null,
  work_class: null, code_class: null, ...extra,
});
const declared = (id: string, num: string, sig = SIG, extra: Row = {}): Row => postPaste(id, num, {
  engineering_required: false, like_in_kind_statement: STATEMENT, like_in_kind_declared_by: "u-req",
  like_in_kind_declared_at: "2026-10-01T10:00:00Z", like_in_kind_signature_id: sig, ...extra,
});

const post = (path: string, body: unknown) =>
  new NextRequest(`https://app${path}?orgId=${ORG}`, {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
  });
async function chunk(table: string, rows: Row[]) {
  const res = await applyTable(post("/api/admin/restore/apply-table", { table, rows, idRemap: REMAP, manifest: { orgId: "backup-org" } }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const routePost: RestorePost = async (path, body) => {
  const req = new NextRequest(`https://app${path}`, {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const handler = path.startsWith("/api/admin/restore/begin") ? beginRoute : applyTable;
  const res = await handler(req);
  return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};
const ticketHere = (id: string) => (db.rows.tickets ?? []).find((t) => t.id === id && t.org_id === ORG);
const chunkAudits = () => (db.rows.audit_logs ?? []).filter((a) => a.action === "RESTORE_CHUNK");

/** Every read / write the restore runs, `table.op` with its first argument. */
function tracing() {
  const log: string[] = [];
  const sb = { from: (t: string) => {
    const b = from(t) as Record<string, (...a: unknown[]) => unknown>;
    const parts: string[] = [t];
    const p: Record<string, unknown> = {};
    for (const [k, fn] of Object.entries(b)) {
      if (k === "then") { p.then = (res: (v: unknown) => void, rej: (e: unknown) => void) => { log.push(parts.join(".")); return fn(res, rej); }; continue; }
      p[k] = (...a: unknown[]) => { parts.push(`${k}(${JSON.stringify(a)})`); fn(...a); return p; };
    }
    return p;
  } };
  return { sb, log };
}
const PROBE = `tickets.select(${JSON.stringify([RESTORE_REVIEW_MODEL_COLUMNS.join(",")])}).limit([0])`;

beforeEach(() => {
  db.rows = { orgs: [{ id: ORG, name: "Acme", ticket_prefix: "AC" }, { id: OTHER, name: "Other plant" }], org_members: [] };
  db.keys = { ticket_number_counters: [["org_id", "year"]] };
  db.writeError = null; db.readError = {}; db.writes = []; db.attempts = []; db.countless = false; db.fks = {};
  db.maxRows = 1000; db.generated = {}; db.authUsers = null; db.defaults = {};
  db.missingColumns = {};
});

describe("P18 — the transform, pure", () => {
  it("ruling (1): a row with no review_model_filed key is filed before the review model; a row carrying the key keeps it (true or false)", () => {
    expect(filedBeforeReviewModel(prePaste("t-1", "A-1"))).toBe(true);
    expect(asFiledBeforeReviewModel(prePaste("t-1", "A-1"))).toEqual({ ...prePaste("t-1", "A-1"), review_model_filed: false, engineering_required: false });
    for (const v of [true, false]) {
      const row = postPaste("t-2", "A-2", { review_model_filed: v });
      expect(filedBeforeReviewModel(row)).toBe(false);
      expect(asFiledBeforeReviewModel(row)).toBe(row);
    }
    // engineering_required carried without review_model_filed (a hand-made row): kept.
    const hand = prePaste("t-3", "A-3", { engineering_required: true });
    expect(asFiledBeforeReviewModel(hand)).toEqual({ ...hand, review_model_filed: false });
  });

  it("ruling (2): a declaration is any of its four columns set; LIKE_IN_KIND_COLUMNS is 20261250's all-or-none set", () => {
    expect(LIKE_IN_KIND_COLUMNS).toEqual(["like_in_kind_statement", "like_in_kind_declared_by", "like_in_kind_declared_at", "like_in_kind_signature_id"]);
    expect(carriesDeclaration(postPaste("t-1", "A-1"))).toBe(false);
    expect(carriesDeclaration(prePaste("t-1", "A-1"))).toBe(false);
    expect(carriesDeclaration(declared("t-1", "A-1"))).toBe(true);
    expect(carriesDeclaration(postPaste("t-1", "A-1", { like_in_kind_signature_id: SIG }))).toBe(true);
  });

  it("the restored row is gated by today's role-based gate exactly as a request the column cannot speak for — for every requester role (DEC-90 ruling (2) of DF-P6)", () => {
    const restored = asFiledBeforeReviewModel(prePaste("t-1", "A-1"));
    for (const role of ["Manager", "Admin", "Supervisor", "DocCtrl", "Viewer", "Maintenance", "Engineer"]) {
      const base = { id: "t-1", orgId: ORG, requesterRole: role, requesterId: "u-req" } as unknown as Ticket;
      const asRestored = { ...base, ...reviewModelFieldsFromRow({ ...restored, requester_role: role }) } as Ticket;
      const columnAbsent = { ...base, ...reviewModelFieldsFromRow({ ...prePaste("t-1", "A-1"), requester_role: role }) } as Ticket;
      expect(columnAbsent.engineeringRequired).toBeUndefined();
      expect(engineeringGateRequired(asRestored, [role], null)).toBe(engineeringGateRequired(columnAbsent, [role], null));
      expect(requesterBindingApplies(asRestored, [role], null)).toBe(false);
      expect(reviewModelBinds(asRestored)).toBe(false);
    }
    // the reviewer's case: a Manager's pre-paste request — issued by its requester today — still is.
    const mgr = { id: "t-1", orgId: ORG, requesterRole: "Manager", requesterId: "u-req", ...reviewModelFieldsFromRow(restored) } as unknown as Ticket;
    expect(engineeringGateRequired(mgr, ["Manager"], null)).toBe(false);
    // left at the database's defaults (true / true), as before P18, it would not be.
    const defaults = { ...mgr, engineeringRequired: true, reviewModelFiled: true } as Ticket;
    expect(engineeringGateRequired(defaults, ["Manager"], null)).toBe(true);
  });
});

describe("P18 — a database WITH 20261250", () => {
  it("ruling (1): a backup taken before the review model lands filed before it (review_model_filed false, engineering_required false), with ONE line in the restore notes — the answer and its RESTORE_CHUNK row; nothing else about the chunk changes", async () => {
    const r = await chunk("tickets", [prePaste("t-1", "AC-DDRT-26-0001"), prePaste("t-2", "AC-DDRT-26-0002")]);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, inserted: 2, notes: [filedBeforeReviewModelNote(2)] });
    for (const id of ["t-1", "t-2"]) {
      expect(ticketHere(id)).toMatchObject({ review_model_filed: false, engineering_required: false });
      for (const c of LIKE_IN_KIND_COLUMNS) expect(ticketHere(id)).not.toHaveProperty(c);
    }
    const audits = chunkAudits();
    expect(audits).toHaveLength(1);
    expect((audits[0].details as Record<string, unknown>).notes).toEqual([filedBeforeReviewModelNote(2)]);
    expect((audits[0].details as Record<string, unknown>).cleared).toBeUndefined();
    expect(filedBeforeReviewModelNote(2)).toMatch(/^2 request\(s\) restored from this part of the backup were taken before the review model \(they carry no review_model_filed\) and are marked as filed before it/);
    expect(filedBeforeReviewModelNote(2)).toMatch(/today's role-based engineering gate decides for each exactly as it did before/);
  });

  it("ruling (1): a row whose backup carries the keys keeps its values — true, false, a ratcheted requirement — and no note is written", async () => {
    const rows = [
      postPaste("t-1", "AC-DDRT-26-0001"),
      postPaste("t-2", "AC-DDRT-26-0002", { review_model_filed: false, engineering_required: false }),
      postPaste("t-3", "AC-DDRT-26-0003", { review_model_filed: false, engineering_required: true }),
    ];
    const r = await chunk("tickets", rows);
    expect(r.body).toEqual({ ok: true, inserted: 3 });
    expect(ticketHere("t-1")).toMatchObject({ review_model_filed: true, engineering_required: true });
    expect(ticketHere("t-2")).toMatchObject({ review_model_filed: false, engineering_required: false });
    expect(ticketHere("t-3")).toMatchObject({ review_model_filed: false, engineering_required: true });
  });

  it("ruling (5): a backup taken after the paste with no declaration is sent byte for byte as before — no column check, no signature read, no extra call", async () => {
    const rows = [postPaste("t-1", "AC-DDRT-26-0001"), postPaste("t-2", "AC-DDRT-26-0002")];
    const { sb, log } = tracing();
    const r = await applyRestoreChunk(sb as never, { orgId: ORG, table: "tickets", rows, idRemap: REMAP });
    expect(r).toMatchObject({ ok: true, inserted: 2, cleared: [], refused: [] });
    expect(r).not.toHaveProperty("notes");
    expect(log.filter((l) => l === PROBE || l.startsWith("e_signatures."))).toEqual([]);
    expect(log.filter((l) => l.startsWith("tickets.upsert"))).toEqual([
      `tickets.upsert(${JSON.stringify([rows.map((x) => ({ ...x, org_id: ORG })), { onConflict: "id", ignoreDuplicates: true, count: "exact" }])})`,
    ]);
  });

  it("ruling (2): a declaration whose e-signature is not in this workspace is cleared — all four columns together — and engineering is required; one note per request, in a plant admin's words; a request with no declaration in the same chunk is unchanged", async () => {
    const plain = postPaste("t-plain", "AC-DDRT-26-0002", { review_model_filed: true, engineering_required: false });
    const r = await chunk("tickets", [declared("t-1", "AC-DDRT-26-0001"), plain]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, inserted: 2 });
    expect(r.body).not.toHaveProperty("notes");
    const t = ticketHere("t-1")!;
    for (const c of LIKE_IN_KIND_COLUMNS) expect(t[c]).toBeNull();
    expect(t.engineering_required).toBe(true);
    expect(t.review_model_filed).toBe(true);
    expect(ticketHere("t-plain")).toEqual({ ...plain, org_id: ORG });
    const cleared = r.body.cleared as Array<Record<string, unknown>>;
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ id: "t-1", code: DECLARATION_NOT_RESTORED });
    expect(String(cleared[0].message)).toMatch(/^like_in_kind_\* cleared on request AC-DDRT-26-0001: its requester declared the work like-in-kind/);
    expect(String(cleared[0].message)).toMatch(/the signature is not on record in this workspace \(a backup carries no signatures\)/);
    expect(String(cleared[0].message)).toMatch(/now needs an engineer's sign-off \(or a recorded management override\) before it issues/);
    expect(String(cleared[0].message)).toContain(STATEMENT);
    expect(restoreRefusalLabel(DECLARATION_NOT_RESTORED)).toMatch(/like-in-kind declaration has no e-signature on record in this workspace/);
    expect((chunkAudits()[0].details as Record<string, unknown>).cleared).toEqual(cleared);
    // every reader now agrees: the restored row is not declared, and the gate requires an engineer for a Manager requester too.
    const fields = reviewModelFieldsFromRow(t);
    expect(isDeclaredLikeInKind(fields as Ticket)).toBe(false);
    expect(engineeringGateRequired({ id: "t-1", orgId: ORG, requesterRole: "Manager", requesterId: "u-req", ...fields } as unknown as Ticket, ["Manager"], null)).toBe(true);
  });

  it("ruling (2): a signature of the same id held by ANOTHER workspace, or given for another request, or by another person, does not stand — cleared; one on record here for this request by its declarer stands — the declaration is kept as it is", async () => {
    db.rows.e_signatures = [
      { id: SIG, org_id: ORG, resource_type: "ticket", resource_id: "t-kept", signer_user_id: "u-req" },
      { id: SIG_ELSEWHERE, org_id: OTHER, resource_type: "ticket", resource_id: "t-else", signer_user_id: "u-req" },
      { id: "33333333-2222-4333-8444-555555555555", org_id: ORG, resource_type: "ticket", resource_id: "t-someone-else", signer_user_id: "u-req" },
      { id: "44444444-2222-4333-8444-555555555555", org_id: ORG, resource_type: "ticket", resource_id: "t-other-signer", signer_user_id: "u-other" },
    ];
    const kept = declared("t-kept", "AC-DDRT-26-0001", SIG);
    const r = await chunk("tickets", [
      kept,
      declared("t-else", "AC-DDRT-26-0002", SIG_ELSEWHERE),
      declared("t-wrong-request", "AC-DDRT-26-0003", "33333333-2222-4333-8444-555555555555"),
      declared("t-other-signer", "AC-DDRT-26-0004", "44444444-2222-4333-8444-555555555555"),
      declared("t-not-a-uuid", "AC-DDRT-26-0005", "not-a-signature-id"),
    ]);
    expect(r.body).toMatchObject({ ok: true, inserted: 5 });
    expect(ticketHere("t-kept")).toEqual({ ...kept, org_id: ORG });
    for (const id of ["t-else", "t-wrong-request", "t-other-signer", "t-not-a-uuid"]) {
      expect(ticketHere(id)).toMatchObject({ like_in_kind_statement: null, like_in_kind_declared_by: null, like_in_kind_declared_at: null, like_in_kind_signature_id: null, engineering_required: true });
    }
    expect((r.body.cleared as Array<Record<string, unknown>>).map((c) => c.id).sort()).toEqual(["t-else", "t-not-a-uuid", "t-other-signer", "t-wrong-request"]);
  });

  it("rulings (1) and (2) together: a hand-made row carrying a declaration but no review_model_filed lands filed before the review model, undeclared and REQUIRED (fail-safe: the cleared declaration wins over the seed)", async () => {
    const row = prePaste("t-1", "AC-DDRT-26-0001", { like_in_kind_statement: STATEMENT, like_in_kind_declared_by: "u-req", like_in_kind_declared_at: "2026-10-01T10:00:00Z", like_in_kind_signature_id: SIG });
    const r = await chunk("tickets", [row]);
    expect(r.body).toMatchObject({ ok: true, inserted: 1, notes: [filedBeforeReviewModelNote(1)] });
    expect(ticketHere("t-1")).toMatchObject({ review_model_filed: false, engineering_required: true, like_in_kind_statement: null, like_in_kind_signature_id: null });
    expect((r.body.cleared as unknown[]).length).toBe(1);
  });

  it("ruling (4): ON CONFLICT DO NOTHING — a request already here (same id) is never touched: no UPDATE, its declaration and columns kept, counted existing, no note about it", async () => {
    const live = { ...declared("t-1", "AC-DDRT-26-0001"), org_id: ORG, title: "the live request" };
    const liveLegacy = { ...prePaste("t-2", "AC-DDRT-26-0002"), org_id: ORG, review_model_filed: false, engineering_required: true };
    db.rows.tickets = [{ ...live }, { ...liveLegacy }];
    const { sb, log } = tracing();
    const r = await applyRestoreChunk(sb as never, { orgId: ORG, table: "tickets", rows: [declared("t-1", "AC-DDRT-26-0001"), prePaste("t-2", "AC-DDRT-26-0002")], idRemap: REMAP });
    expect(r).toMatchObject({ ok: true, inserted: 0, existing: 2, cleared: [], refused: [] });
    // P18 fix pass 2: t-2 is a pre-paste row, but nothing was written — no line.
    expect(r).not.toHaveProperty("notes");
    expect(log.filter((l) => /\.update\(/.test(l))).toEqual([]);
    expect(db.writes.filter((w) => w.table === "tickets" && w.op === "update")).toEqual([]);
    expect(ticketHere("t-1")).toEqual(live);
    expect(ticketHere("t-2")).toEqual(liveLegacy);
  });

  it("P18 fix pass 2 — the line counts only requests a statement WROTE: re-running a finished restore (every request already here) answers with no line, in the answer, the audit row and the driver's outcome", async () => {
    const rows = [prePaste("t-1", "AC-DDRT-26-0001"), prePaste("t-2", "AC-DDRT-26-0002")];
    const first = await chunk("tickets", rows);
    expect(first.body).toEqual({ ok: true, inserted: 2, notes: [filedBeforeReviewModelNote(2)] });
    const again = await chunk("tickets", rows);
    expect(again.body).toEqual({ ok: true, inserted: 0, existing: 2 });
    const audits = chunkAudits();
    expect(audits).toHaveLength(2);
    expect(audits[1].details).not.toHaveProperty("notes");
    // the page's driver over the same backup again: the tickets outcome carries no line
    const env: RestoreEnvelopeLike = { manifest: { orgId: "backup-org" }, tables: { tickets: rows } };
    const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planRestore(env, { orgId: ORG, orgName: "Acme", members: [] }), orgNameChoice: "current", post: routePost });
    const tickets = run.tables.find((t) => t.name === "tickets")!;
    expect(tickets).toMatchObject({ inserted: 0, existing: 2 });
    expect(tickets).not.toHaveProperty("notes");
  });

  it("P18 fix pass 2 — a statement that skips some rows: the line counts the rows it wrote, never one already here, held by another workspace, or cleared-and-found-here", async () => {
    db.rows.libraries = [{ id: "lib-1", org_id: ORG }];
    db.rows.tickets = [
      { ...prePaste("t-here", "AC-DDRT-26-0001"), org_id: ORG, review_model_filed: false, engineering_required: true },
      { ...prePaste("t-else", "OT-DDRT-26-0001"), org_id: OTHER },
      // a pointer the restore would clear (library not here) on a request already here: settled before the write
      { ...prePaste("t-here-lib", "AC-DDRT-26-0004"), org_id: ORG, library_id: "lib-gone" },
    ];
    const before = JSON.stringify(db.rows.tickets);
    const r = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", idRemap: REMAP, rows: [
      prePaste("t-here", "AC-DDRT-26-0001"),
      prePaste("t-new", "AC-DDRT-26-0002"),
      prePaste("t-else", "AC-DDRT-26-0003"),
      prePaste("t-here-lib", "AC-DDRT-26-0004", { library_id: "lib-gone" }),
      prePaste("t-new-lib", "AC-DDRT-26-0005", { library_id: "lib-1" }),
    ] });
    expect(r).toMatchObject({ ok: true, inserted: 2, existing: 2, heldElsewhere: 1, refused: [] });
    expect(r.notes).toEqual([filedBeforeReviewModelNote(2)]);
    expect(JSON.stringify((db.rows.tickets ?? []).slice(0, 3))).toBe(before);
    expect(ticketHere("t-new")).toMatchObject({ review_model_filed: false, engineering_required: false });
    expect(ticketHere("t-new-lib")).toMatchObject({ review_model_filed: false, engineering_required: false, library_id: "lib-1" });
  });

  it("P18 fix pass 2 — when the key read fails the rows are not placed: counted only from a statement that wrote every row (a partial one claims none), and the restore goes on as before", async () => {
    const keyReadDown = { from: (t: string) => {
      const b = from(t) as Record<string, (...a: unknown[]) => unknown>;
      let down = false;
      const select = b.select; const then = b.then;
      b.select = (cols?: unknown) => { if (t === "tickets" && cols === "id,org_id") down = true; return select(cols); };
      b.then = (res: unknown, rej: unknown) => (down ? (res as (v: unknown) => void)({ data: null, error: { message: "key read down" } }) : then(res, rej));
      return b;
    } };
    db.rows.tickets = [{ ...prePaste("t-here", "AC-DDRT-26-0001"), org_id: ORG }];
    const partial = await applyRestoreChunk(keyReadDown as never, { orgId: ORG, table: "tickets", rows: [prePaste("t-here", "AC-DDRT-26-0001"), prePaste("t-new", "AC-DDRT-26-0002")], idRemap: REMAP });
    // (the skipped row cannot be placed after the write either — uncounted, as before P18)
    expect(partial).toMatchObject({ ok: true, inserted: 1, existing: 0, uncounted: 1 });
    expect(partial).not.toHaveProperty("notes");
    const whole = await applyRestoreChunk(keyReadDown as never, { orgId: ORG, table: "tickets", rows: [prePaste("t-a", "AC-DDRT-26-0003"), prePaste("t-b", "AC-DDRT-26-0004")], idRemap: REMAP });
    expect(whole).toMatchObject({ ok: true, inserted: 2, notes: [filedBeforeReviewModelNote(2)] });
  });

  it("P18 fix pass 2 — a statement with no count writes rows it cannot place: no line (as a cleared pointer is not reported from it)", async () => {
    db.countless = true;
    const r = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", rows: [prePaste("t-1", "AC-DDRT-26-0001")], idRemap: REMAP });
    expect(r).toMatchObject({ ok: true, uncounted: 1, inserted: 0 });
    expect(r).not.toHaveProperty("notes");
  });

  it("P18 fix pass 2 — a chunk that fails: before any write, no line; after a statement wrote some, the line counts exactly those (they are in `inserted`, and a re-run counts them existing)", async () => {
    db.writeError = (table, op) => (table === "tickets" && op === "upsert" ? { code: "57014", message: "canceling statement due to statement timeout" } : null);
    const none = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", rows: [prePaste("t-1", "AC-DDRT-26-0001")], idRemap: REMAP });
    expect(none).toMatchObject({ ok: false, status: 500, inserted: 0 });
    expect(none).not.toHaveProperty("notes");
    const viaRoute = await chunk("tickets", [prePaste("t-1", "AC-DDRT-26-0001")]);
    expect(viaRoute.status).toBe(500);
    expect(viaRoute.body).not.toHaveProperty("notes");
    for (const audit of chunkAudits()) expect(audit.details).not.toHaveProperty("notes");
    // 501 requests: the first statement (500) is written, the second refused
    const rows = Array.from({ length: 501 }, (_, i) => prePaste(`t-${String(i).padStart(4, "0")}`, `AC-DDRT-26-${String(i + 1).padStart(4, "0")}`));
    db.writeError = (table, op, sent) => (table === "tickets" && op === "upsert" && sent.some((x) => x.id === "t-0500") ? { code: "57014", message: "canceling statement due to statement timeout" } : null);
    const some = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", rows, idRemap: REMAP });
    expect(some).toMatchObject({ ok: false, status: 500, inserted: 500 });
    expect(some.notes).toEqual([filedBeforeReviewModelNote(500)]);
  });

  it("a request renumbered on restore (EDGE-5) keeps the transform: filed before the review model, its declaration cleared and reported beside the renumbering", async () => {
    db.rows.tickets = [{ id: "t-live", org_id: ORG, ticket_id: "AC-DDRT-26-0001", title: "live" }];
    db.rows.ticket_number_counters = [{ org_id: ORG, year: 2026, next_seq: 5 }];
    const r = await chunk("tickets", [prePaste("t-1", "AC-DDRT-26-0001"), declared("t-2", "AC-DDRT-26-0001")]);
    expect(r.body).toMatchObject({ ok: true, inserted: 2 });
    // P18 fix pass 2: the renumbered pre-paste row t-1 is counted — written under its fresh number.
    expect(r.body.notes).toEqual([filedBeforeReviewModelNote(1)]);
    expect(ticketHere("t-1")).toMatchObject({ review_model_filed: false, engineering_required: false });
    expect(ticketHere("t-1")!.ticket_id).not.toBe("AC-DDRT-26-0001");
    expect(ticketHere("t-2")).toMatchObject({ review_model_filed: true, engineering_required: true, like_in_kind_statement: null });
    const codes = (r.body.cleared as Array<Record<string, unknown>>).map((c) => `${c.id}:${c.code}`).sort();
    expect(codes).toEqual(["t-1:ticket_renumbered", "t-2:declaration_not_restored", "t-2:ticket_renumbered"].map((x) => x.replace("ticket_renumbered", TICKET_RENUMBERED)).sort());
    // P18 fix pass: the cleared declaration's note names the number t-2 is
    // restored under — "AC-DDRT-26-0001" names the live request t-live here.
    const fresh = String(ticketHere("t-2")!.ticket_id);
    expect(fresh).not.toBe("AC-DDRT-26-0001");
    const note = (r.body.cleared as Array<Record<string, unknown>>).find((c) => c.id === "t-2" && c.code === DECLARATION_NOT_RESTORED)!;
    expect(String(note.message)).toMatch(new RegExp(`^like_in_kind_\\* cleared on request ${fresh} \\(restored under this fresh number; "AC-DDRT-26-0001", the number it carried in the backup, names another request in this workspace\\): its requester declared the work like-in-kind`));
    expect(String(note.message)).not.toContain("cleared on request AC-DDRT-26-0001:");
    expect(String(note.message)).toContain(STATEMENT);
    expect((chunkAudits()[0].details as Record<string, unknown>).cleared).toEqual(r.body.cleared);
  });

  it("declarationNoteRenumbered rewrites only a DECLARATION_NOT_RESTORED note naming the old number; every other note is returned as it is", () => {
    const decl = { id: "t-2", code: DECLARATION_NOT_RESTORED, message: "like_in_kind_* cleared on request A-1: the rest." };
    expect(declarationNoteRenumbered(decl, "A-1", "A-9")).toEqual({ ...decl, message: 'like_in_kind_* cleared on request A-9 (restored under this fresh number; "A-1", the number it carried in the backup, names another request in this workspace): the rest.' });
    const other = { id: "t-2", code: "parent_outside_workspace", message: "like_in_kind_* cleared on request A-1: x" };
    expect(declarationNoteRenumbered(other, "A-1", "A-9")).toBe(other);
    expect(declarationNoteRenumbered(decl, "B-1", "A-9")).toBe(decl);
  });

  it("the schema-cache window: the column check finds 20261250's columns but the API refuses the write PGRST204 naming one — the chunk fails with the remedy (retry in a minute), nothing written", async () => {
    const dbMessage = "Could not find the 'review_model_filed' column of 'tickets' in the schema cache";
    db.writeError = (table, op) => (table === "tickets" && op === "upsert" ? { code: "PGRST204", message: dbMessage } : null);
    const a = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", rows: [prePaste("t-1", "AC-DDRT-26-0001")], idRemap: REMAP });
    expect(a).toMatchObject({ ok: false, status: 500, inserted: 0, code: "PGRST204", error: reviewModelSchemaCacheMessage(dbMessage) });
    expect(a).not.toHaveProperty("notes");
    expect(reviewModelSchemaCacheMessage(dbMessage)).toMatch(/has not reloaded its schema since that migration .* Wait a minute and run the restore again/);
    expect(db.rows.tickets ?? []).toEqual([]);
    // Through the route: the same sentence.
    const r = await chunk("tickets", [prePaste("t-1", "AC-DDRT-26-0001")]);
    expect(r.status).toBe(500);
    expect(String(r.body.error)).toBe(reviewModelSchemaCacheMessage(dbMessage));
    // A refusal naming some other column is the database's own message, as before.
    db.writeError = (table, op) => (table === "tickets" && op === "upsert" ? { code: "PGRST204", message: "Could not find the 'title' column of 'tickets' in the schema cache" } : null);
    const b = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", rows: [prePaste("t-1", "AC-DDRT-26-0001")], idRemap: REMAP });
    expect(b).toMatchObject({ ok: false, error: "Could not find the 'title' column of 'tickets' in the schema cache" });
  });

  it("fail closed: a column check or a signature read that fails stops the chunk before any write — nothing is written on a guess", async () => {
    db.readError.tickets = "connection reset";
    const a = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", rows: [prePaste("t-1", "AC-DDRT-26-0001")], idRemap: REMAP });
    expect(a).toMatchObject({ ok: false, status: 500, inserted: 0, error: "Could not check whether this workspace's database has the review-model columns (20261250): connection reset" });
    db.readError = { e_signatures: "permission denied" };
    const b = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", rows: [declared("t-1", "AC-DDRT-26-0001")], idRemap: REMAP });
    expect(b).toMatchObject({ ok: false, status: 500, inserted: 0, error: "Could not check the e-signatures of the like-in-kind declarations these requests carry: permission denied" });
    expect(db.attempts.filter((x) => x.table === "tickets")).toEqual([]);
    expect(db.rows.tickets ?? []).toEqual([]);
  });

  it("ruling (5): every other table is untouched — no column check, no signature read, rows sent as before, no notes", async () => {
    db.rows.tickets = [{ id: "t-1", org_id: ORG, ticket_id: "AC-DDRT-26-0001" }];
    const { sb, log } = tracing();
    const comments = [{ id: "c-1", org_id: "backup-org", ticket_id: "t-1", body: "a" }];
    const r = await applyRestoreChunk(sb as never, { orgId: ORG, table: "ticket_comments", rows: comments, idRemap: REMAP });
    expect(r).toMatchObject({ ok: true, inserted: 1 });
    expect(r).not.toHaveProperty("notes");
    expect(log.filter((l) => l === PROBE || l.startsWith("e_signatures."))).toEqual([]);
    expect(log.filter((l) => l.includes(".upsert("))).toEqual([
      `ticket_comments.upsert(${JSON.stringify([[{ ...comments[0], org_id: ORG }], { onConflict: "id", ignoreDuplicates: true, count: "exact" }])})`,
    ]);
  });

  it("the page's driver carries the chunk's line onto the tickets outcome only — every other table's outcome is shaped exactly as before", async () => {
    const env: RestoreEnvelopeLike = { manifest: { orgId: "backup-org" }, tables: {
      tickets: [prePaste("t-1", "AC-DDRT-26-0001"), declared("t-2", "AC-DDRT-26-0002")],
      ticket_comments: [{ id: "c-1", org_id: "backup-org", ticket_id: "t-1", body: "a" }],
    } };
    const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan: planRestore(env, { orgId: ORG, orgName: "Acme", members: [] }), orgNameChoice: "current", post: routePost });
    expect(run.stoppedAt).toBeNull();
    const tickets = run.tables.find((t) => t.name === "tickets")!;
    expect(tickets.notes).toEqual([filedBeforeReviewModelNote(1)]);
    expect(tickets.cleared.map((c) => c.code)).toEqual([DECLARATION_NOT_RESTORED]);
    expect(run.totalCleared).toBe(1);
    const comments = run.tables.find((t) => t.name === "ticket_comments")!;
    expect(comments).toEqual({ name: "ticket_comments", rows: 1, inserted: 1, existing: 0, heldElsewhere: 0, uncounted: 0, filtered: 0, refused: [], cleared: [], advanced: 0, notApplied: [], renumbered: [] });
  });
});

describe("P18 — a database WITHOUT 20261250 (ruling (3): nothing is sent for these columns; the restore behaves as before)", () => {
  beforeEach(() => { db.missingColumns = { tickets: [...RESTORE_REVIEW_MODEL_COLUMNS] }; });

  it("a backup taken before the review model is written byte for byte as before: one column check (answered 'not there'), then exactly today's calls — no review-model key, no note, no cleared line", async () => {
    const rows = [prePaste("t-1", "AC-DDRT-26-0001"), prePaste("t-2", "AC-DDRT-26-0002")];
    const { sb, log } = tracing();
    const r = await applyRestoreChunk(sb as never, { orgId: ORG, table: "tickets", rows, idRemap: REMAP });
    expect(r).toMatchObject({ ok: true, inserted: 2, cleared: [], refused: [] });
    expect(r).not.toHaveProperty("notes");
    expect(log.filter((l) => l === PROBE)).toHaveLength(1);
    expect(log.filter((l) => l.startsWith("e_signatures."))).toEqual([]);
    expect(log.filter((l) => l.startsWith("tickets.upsert"))).toEqual([
      `tickets.upsert(${JSON.stringify([rows.map((x) => ({ ...x, org_id: ORG })), { onConflict: "id", ignoreDuplicates: true, count: "exact" }])})`,
    ]);
    for (const id of ["t-1", "t-2"]) for (const c of RESTORE_REVIEW_MODEL_COLUMNS) expect(ticketHere(id)).not.toHaveProperty(c);
  });

  it("a backup taken after the paste, restored here, is refused by the database exactly as before — the database's own PGRST204 message, not the schema-cache sentence (no column check ran)", async () => {
    const r = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", rows: [postPaste("t-1", "AC-DDRT-26-0001")], idRemap: REMAP });
    expect(r).toMatchObject({ ok: false, status: 500, code: "PGRST204" });
    expect(String((r as { error: string }).error)).toMatch(/^Could not find the '\w+' column of 'tickets' in the schema cache$/);
  });

  it("through the route: the same answer and audit row as before (no notes key)", async () => {
    const r = await chunk("tickets", [prePaste("t-1", "AC-DDRT-26-0001")]);
    expect(r.body).toEqual({ ok: true, inserted: 1 });
    expect(chunkAudits()[0].details).not.toHaveProperty("notes");
  });

  it("a row carrying a declaration is not judged (no signature read) — the transform adds nothing and the row goes to the database as the backup carries it", async () => {
    const { sb, log } = tracing();
    const row = declared("t-1", "AC-DDRT-26-0001");
    const r = await applyRestoreChunk(sb as never, { orgId: ORG, table: "tickets", rows: [row], idRemap: REMAP });
    expect(log.filter((l) => l.startsWith("e_signatures."))).toEqual([]);
    expect(log.filter((l) => l.startsWith("tickets.upsert"))).toEqual([
      `tickets.upsert(${JSON.stringify([[{ ...row, org_id: ORG }], { onConflict: "id", ignoreDuplicates: true, count: "exact" }])})`,
    ]);
    // the database without the columns answers as it always has (PostgREST's schema-cache refusal).
    expect(r).toMatchObject({ ok: false, status: 500, code: "PGRST204", inserted: 0 });
  });
});
