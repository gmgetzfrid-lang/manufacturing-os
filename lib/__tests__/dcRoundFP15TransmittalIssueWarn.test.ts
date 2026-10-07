// document-control Round F wave 3 — P15 SURFACE REMAINDERS: TRX-16, the
// issue half. issueTransmittal asks the server whether the portal can stamp
// each PDF BEFORE anything is written; a PDF it cannot mark stops the issue
// with an UnstampableItemsError naming the item and the reason (the ISSUER is
// warned at issue, not the recipient later); the issuer may go ahead
// (`acceptedUnstampable`), recorded on the TRANSMITTAL_ISSUED row. A check
// that cannot run never blocks an issue.
//
// document-control Round F wave 3 — P22 (TRX-15; the DEC-61 §5 amendment,
// ratified DEC-90 A5): the issue ARMS the portal's download-time refusal —
// `stampable: true` on each item the check found stampable, written in the
// issue UPDATE under an `updated_at` match on the draft read (a concurrent
// draft edit is refused and named, never overwritten). An issuer-accepted
// unstampable item, a non-PDF, an unchecked file — and every item when the
// check could not run — carries no mark.
//
// P22 review fix: "Issue anyway" on a draft saved since the check it answers
// is REFUSED (named) — never issued unchecked and unarmed — and every issue
// that relies on a check (the one it ran, or the one the issuer answered) is
// bound to the draft read, whether or not it writes a mark.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Op = [string, unknown[]];
const db = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; ops: Op[] }>,
  handlers: {} as Record<string, (ops: Op[]) => { data: unknown; error: unknown }>,
  audits: [] as Array<Record<string, unknown>>,
}));
function chain(table: string) {
  const ops: Op[] = [];
  db.calls.push({ table, ops });
  const proxy: Record<string, unknown> = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") {
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
          const h = db.handlers[table];
          return Promise.resolve(h ? h(ops) : { data: null, error: null }).then(res, rej);
        };
      }
      return (...args: unknown[]) => { ops.push([prop, args]); return proxy; };
    },
  });
  return proxy;
}
const has = (ops: Op[], name: string) => ops.some(([n]) => n === name);
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => chain(t),
    auth: { getSession: async () => ({ data: { session: { access_token: "jwt" } } }) },
  },
}));
vi.mock("@/lib/audit", () => ({
  logAuditAction: vi.fn(async (e: Record<string, unknown>) => { db.audits.push(e); return { error: null }; }),
}));

import {
  issueTransmittal, describeUnstampable, unstampableItems, UnstampableItemsError, PORTAL_STAMP_MAX_BYTES, armCheckedItems, stampFooterUnprintable,
  checkTransmittalStampability, STAMP_CHECK_TIME_BUDGET_MS, STAMP_CHECK_CLIENT_TIMEOUT_MS,
  type ItemStampCheck, type IssuePhase,
} from "@/lib/transmittals";

const ORG = "org-a";
const actor = { orgId: ORG, actorUserId: "u-dc", actorName: "dc@a", actorRole: "DocCtrl" };
const draftRow = { id: "t1", org_id: ORG, seq: 1, number: "TR-0107", status: "draft", recipient_name: "Acme", items: [{ documentId: "d1", number: "P-101", versionId: "v1" }, { documentId: "d2", number: "VDS-7", versionId: "v2" }] };
const issuedRow = { ...draftRow, status: "issued", issued_at: "2026-10-01T00:00:00Z", portal_token: null };
const ENCRYPTED: ItemStampCheck = { documentId: "d2", number: "VDS-7", verdict: "unloadable", detail: "encrypted (permission-restricted) PDF" };
const BIG: ItemStampCheck = { documentId: "d3", number: "SET-9", verdict: "oversize" };
const OK: ItemStampCheck = { documentId: "d1", number: "P-101", verdict: "stampable" };

let fetchMock: ReturnType<typeof vi.fn>;
let stampAnswer: { status: number; body: unknown } | "throw";
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  db.calls = []; db.audits = [];
  db.handlers = {
    transmittals: (ops) => has(ops, "update") ? { data: issuedRow, error: null } : { data: draftRow, error: null },
    documents: () => ({ data: [{ id: "d1", status: "Issued", archived_at: null, current_version_id: "v1" }, { id: "d2", status: "Issued", archived_at: null, current_version_id: "v2" }], error: null }),
    document_holds: () => ({ data: [], error: null }),
  };
  stampAnswer = { status: 200, body: { items: [OK, { ...OK, documentId: "d2", number: "VDS-7" }] } };
  fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/transmittal/stamp-check") {
      if (stampAnswer === "throw") throw new Error("network down");
      return new Response(JSON.stringify(stampAnswer.body), { status: stampAnswer.status });
    }
    return new Response(JSON.stringify({ ok: true, sent: true }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllGlobals(); warn.mockRestore(); });

const updates = () => db.calls.filter((c) => c.table === "transmittals" && has(c.ops, "update"));
const stampCalls = () => fetchMock.mock.calls.filter(([u]) => u === "/api/transmittal/stamp-check");

describe("TRX-16 — the issuer is warned at issue, before anything is written", () => {
  it("REGRESSION: every PDF stampable → the issue goes through as before (one check, one update, one audit row)", async () => {
    const out = await issueTransmittal("t1", actor);
    expect(out.transmittal.status).toBe("issued");
    expect(stampCalls()).toHaveLength(1);
    expect(JSON.parse(String((stampCalls()[0][1] as RequestInit).body))).toEqual({ transmittalId: "t1" });
    expect((stampCalls()[0][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer jwt" });
    expect(updates()).toHaveLength(1);
    expect(db.audits.map((a) => a.action)).toEqual(["TRANSMITTAL_ISSUED"]);
    expect((db.audits[0].details as Record<string, unknown>).unstampableAccepted).toBeUndefined();
  });
  it("an encrypted PDF stops the issue with the item and the reason — nothing written", async () => {
    stampAnswer = { status: 200, body: { items: [OK, ENCRYPTED] } };
    const err = await issueTransmittal("t1", actor).catch((e) => e);
    expect(err).toBeInstanceOf(UnstampableItemsError);
    expect((err as UnstampableItemsError).items).toEqual([ENCRYPTED]);
    expect((err as Error).message).toMatch(/VDS-7: a PDF the portal cannot mark — most often one saved with security or permission restrictions/);
    expect((err as Error).message).toMatch(/WITHOUT the marking, the as-issued footer or the verify QR/);
    expect(updates()).toEqual([]);
    expect(db.audits).toEqual([]);
  });
  it("a PDF over the bound stops it too, naming the bound", async () => {
    stampAnswer = { status: 200, body: { items: [OK, BIG] } };
    await expect(issueTransmittal("t1", actor)).rejects.toThrow(`SET-9: larger than the portal can mark (${PORTAL_STAMP_MAX_BYTES / 1024 / 1024} MB) — split it into smaller files.`);
    expect(updates()).toEqual([]);
  });
  it("the issuer may go ahead: acceptedUnstampable issues without re-checking and records the acceptance", async () => {
    const out = await issueTransmittal("t1", actor, { acceptedUnstampable: [ENCRYPTED] });
    expect(out.transmittal.status).toBe("issued");
    expect(stampCalls()).toEqual([]);
    expect(db.audits[0]).toMatchObject({ action: "TRANSMITTAL_ISSUED", details: expect.objectContaining({ unstampableAccepted: [{ documentId: "d2", number: "VDS-7", verdict: "unloadable" }] }) });
  });
  it("REGRESSION: a check that cannot run never blocks an issue — logged, and the issue proceeds (DEC-61 §5 still governs the portal)", async () => {
    for (const a of [{ status: 500, body: { error: "boom" } }, { status: 403, body: { error: "no authority" } }, { status: 200, body: {} }, "throw" as const]) {
      db.calls = []; db.audits = [];
      stampAnswer = a;
      warn.mockClear();
      const out = await issueTransmittal("t1", actor);
      expect(out.transmittal.status).toBe("issued");
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/issue-time stamp check could not run for TR-0107/), expect.anything());
    }
  });
  it("not_pdf and unchecked items do not warn (the portal says so up front / nothing is known)", () => {
    const checks: ItemStampCheck[] = [OK, { documentId: "d4", number: "X", verdict: "not_pdf" }, { documentId: "d5", number: "Y", verdict: "unchecked", detail: "x" }];
    expect(unstampableItems(checks)).toEqual([]);
    expect(describeUnstampable(checks)).toBeNull();
    expect(describeUnstampable([ENCRYPTED, BIG])).toMatch(/^The recipient's portal cannot stamp these files as an UNCONTROLLED copy/);
  });
  it("REGRESSION (P22): an issuer-accepted re-issue with nothing to arm (no check to carry) sends status / time only, with no draft-version match", async () => {
    await issueTransmittal("t1", actor, { acceptedUnstampable: [ENCRYPTED] });
    const upd = updates()[0].ops.find(([n]) => n === "update")![1][0] as Record<string, unknown>;
    expect(Object.keys(upd).sort()).toEqual(["issued_at", "status", "updated_at"]);
    expect(updates()[0].ops.some(([n, a]) => n === "eq" && a[0] === "updated_at")).toBe(false);
  });
});

describe("TRX-16 — the composer asks the issuer", () => {
  const page = readFileSync(join(process.cwd(), "app/(protected)/transmittals/page.tsx"), "utf8");
  it("an UnstampableItemsError opens a confirm naming the files; Issue anyway re-issues with the accepted items; declining leaves a saved draft, not issued", () => {
    expect(page).toContain("UnstampableItemsError,");
    expect(page).toMatch(/if \(!\(e instanceof UnstampableItemsError\)\) throw e;/);
    expect(page).toMatch(/appConfirm\(\{ title: "Files the portal cannot mark", message: <span className="whitespace-pre-line">\{e\.message\}<\/span>, confirmLabel: "Issue anyway" \}\)/);
    expect(page).toContain("outcome = await issueTransmittal(draft.id, actor, { acceptedUnstampable: e.items, checked: e.checked, onPhase: setIssuePhase });");
    expect(page).toContain('await onSaved({ kind: "issue-failed", draft, error: "Not issued — fix the file(s) the portal cannot mark, then issue again." });');
  });
  it("P15 review fix: the composer says the files are being checked while the check runs, then that it is issuing; the phase clears when it ends", () => {
    expect(page).toContain("outcome = await issueTransmittal(draft.id, actor, { onPhase: setIssuePhase });");
    expect(page).toMatch(/const footerHint = saving === "issue" && issuePhase === "checking"\s*\n\s*\? "Checking each file the recipient's portal will stamp — large PDFs take a moment…"\s*\n\s*: saving === "issue" && issuePhase === "issuing" \? "Issuing…"/);
    expect(page).toMatch(/setIssuePhase\(null\); \/\/ the check answered; the issuer decides/);
    expect(page).toMatch(/\} finally \{\s*\n\s*setSaving\(null\);\s*\n\s*setIssuePhase\(null\);/);
  });
});

describe("TRX-16 (P15 review fix) — the issuer's wait for the check is bounded and announced", () => {
  it("the client timeout sits above the server's budget (the route's ceiling is 120 s)", () => {
    expect(STAMP_CHECK_TIME_BUDGET_MS).toBe(60_000);
    expect(STAMP_CHECK_CLIENT_TIMEOUT_MS).toBeGreaterThan(STAMP_CHECK_TIME_BUDGET_MS);
    expect(STAMP_CHECK_CLIENT_TIMEOUT_MS).toBeLessThan(120_000);
    // the server check reads the same budget (one constant)
    const server = readFileSync(join(process.cwd(), "lib/transmittalStampCheck.ts"), "utf8");
    expect(server).toMatch(/import \{ PORTAL_STAMP_MAX_BYTES, STAMP_CHECK_TIME_BUDGET_MS, portalKeyAllowed/);
    expect(server).not.toMatch(/STAMP_CHECK_TIME_BUDGET_MS = /);
  });
  it("a check that does not answer in time is aborted and reads as a check that could not run — the issue proceeds, logged", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url !== "/api/transmittal/stamp-check") return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      return new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })));
      });
    });
    const r = await checkTransmittalStampability("t1", { timeoutMs: 5 });
    expect(r).toEqual({ ok: false, error: "the check did not answer within 0 s" });
    expect((stampCalls()[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });
  it("issueTransmittal reports its phases: checking, then issuing — and only issuing when the issuer already accepted", async () => {
    const phases: IssuePhase[] = [];
    await issueTransmittal("t1", actor, { onPhase: (p) => phases.push(p) });
    expect(phases).toEqual(["checking", "issuing"]);
    const again: IssuePhase[] = [];
    await issueTransmittal("t1", actor, { acceptedUnstampable: [ENCRYPTED], onPhase: (p) => again.push(p) });
    expect(again).toEqual(["issuing"]);
    // a stopped issue never reports issuing
    stampAnswer = { status: 200, body: { items: [OK, ENCRYPTED] } };
    const stopped: IssuePhase[] = [];
    await expect(issueTransmittal("t1", actor, { onPhase: (p) => stopped.push(p) })).rejects.toBeInstanceOf(UnstampableItemsError);
    expect(stopped).toEqual(["checking"]);
  });
});

// ─── P22 (TRX-15): the issue arms the portal's download-time refusal ───────
describe("TRX-15 (P22, DEC-90 A5) — the issue writes `stampable: true` on each item the check found stampable, under an updated_at match", () => {
  const READ_AT = "2026-10-07T09:15:02.123456+00:00";
  // the draft's items as stored, with keys the mapper drops (they must survive the write untouched)
  const rawItems = [
    { documentId: "d1", number: "P-101", versionId: "v1", title: "Plot plan", rev: "C", note: "kept as stored" },
    { documentId: "d2", number: "VDS-7", versionId: "v2" },
  ];
  const stored = { ...draftRow, updated_at: READ_AT, items: rawItems };
  let readRow: Record<string, unknown>;
  let updateAnswer: { data: unknown; error: unknown };
  beforeEach(() => {
    readRow = stored;
    updateAnswer = { data: issuedRow, error: null };
    db.handlers.transmittals = (ops) => has(ops, "update") ? updateAnswer : { data: readRow, error: null };
  });
  const lastUpdate = () => {
    const u = updates();
    expect(u).toHaveLength(1);
    return { patch: u[0].ops.find(([n]) => n === "update")![1][0] as Record<string, unknown>, ops: u[0].ops };
  };
  const eqs = (ops: Op[]) => ops.filter(([n]) => n === "eq").map(([, a]) => a);

  it("every PDF checked stampable → each item marked, in the issue UPDATE itself, under the draft read's updated_at (and still only on a draft)", async () => {
    const out = await issueTransmittal("t1", actor);
    expect(out.transmittal.status).toBe("issued");
    const { patch, ops } = lastUpdate();
    expect(patch).toMatchObject({ status: "issued" });
    expect(patch.items).toEqual([{ ...rawItems[0], stampable: true }, { ...rawItems[1], stampable: true }]);
    expect(eqs(ops)).toEqual([["id", "t1"], ["status", "draft"], ["updated_at", READ_AT]]);
    expect(db.audits.map((a) => a.action)).toEqual(["TRANSMITTAL_ISSUED"]);
  });

  it("only the items found stampable are marked: a non-PDF and an unchecked file carry no mark (they keep DEC-61 §5's release)", async () => {
    readRow = { ...stored, items: [...rawItems, { documentId: "d3", number: "M-3", versionId: "v3" }] };
    db.handlers.documents = () => ({ data: ["d1", "d2", "d3"].map((d, i) => ({ id: d, status: "Issued", archived_at: null, current_version_id: `v${i + 1}` })), error: null });
    stampAnswer = { status: 200, body: { items: [OK, { documentId: "d2", number: "VDS-7", verdict: "not_pdf" }, { documentId: "d3", number: "M-3", verdict: "unchecked", detail: "not checked — the check ran out of time" }] } };
    await issueTransmittal("t1", actor);
    const { patch } = lastUpdate();
    expect(patch.items).toEqual([{ ...rawItems[0], stampable: true }, rawItems[1], { documentId: "d3", number: "M-3", versionId: "v3" }]);
  });

  it("a document listed twice is marked on both items (the check answers once per document)", async () => {
    readRow = { ...stored, items: [rawItems[0], { ...rawItems[0], number: "P-101 (copy)" }] };
    stampAnswer = { status: 200, body: { items: [OK] } };
    await issueTransmittal("t1", actor);
    expect((lastUpdate().patch.items as Array<Record<string, unknown>>).map((i) => i.stampable)).toEqual([true, true]);
  });

  it("nothing to mark (every file a non-PDF) → no items written, status / time only — but the UPDATE is still bound to the draft the check ran on (P22 review fix)", async () => {
    stampAnswer = { status: 200, body: { items: [{ documentId: "d1", number: "P-101", verdict: "not_pdf" }, { documentId: "d2", number: "VDS-7", verdict: "not_pdf" }] } };
    await issueTransmittal("t1", actor);
    const { patch, ops } = lastUpdate();
    expect(Object.keys(patch).sort()).toEqual(["issued_at", "status", "updated_at"]);
    expect(eqs(ops)).toEqual([["id", "t1"], ["status", "draft"], ["updated_at", READ_AT]]);
  });

  it("P22 review fix: a check with nothing to mark, then a draft saved before the UPDATE → REFUSED and named; nothing issued, audited or emailed", async () => {
    stampAnswer = { status: 200, body: { items: [{ documentId: "d1", number: "P-101", verdict: "not_pdf" }, { documentId: "d2", number: "VDS-7", verdict: "unchecked", detail: "not checked — the check ran out of time" }] } };
    updateAnswer = { data: null, error: null }; // the updated_at match found no row
    let reads = 0;
    db.handlers.transmittals = (ops) => has(ops, "update") ? updateAnswer : { data: ++reads === 1 ? readRow : { ...readRow, updated_at: "2026-10-07T09:15:40.5+00:00" }, error: null };
    await expect(issueTransmittal("t1", actor)).rejects.toThrow("TR-0107 was not issued — the draft was changed while it was being issued (saved meanwhile, here or by someone else), and an issue never overwrites a draft edit. Nothing was sent: open the draft, check it and issue again.");
    const { patch, ops } = lastUpdate();
    expect(patch).not.toHaveProperty("items");
    expect(eqs(ops)).toContainEqual(["updated_at", READ_AT]);
    expect(db.audits).toEqual([]);
    expect(fetchMock.mock.calls.filter(([u]) => u !== "/api/transmittal/stamp-check")).toEqual([]); // no email
  });

  it("REGRESSION: a check that cannot run arms nothing — the issue proceeds as before, status / time only", async () => {
    stampAnswer = { status: 500, body: { error: "boom" } };
    const out = await issueTransmittal("t1", actor);
    expect(out.transmittal.status).toBe("issued");
    const { patch, ops } = lastUpdate();
    expect(Object.keys(patch).sort()).toEqual(["issued_at", "status", "updated_at"]);
    expect(eqs(ops)).toEqual([["id", "t1"], ["status", "draft"]]);
  });

  it("the stopped issue carries the WHOLE check, bound to the draft read; Issue anyway arms the stampable item and leaves the accepted one unmarked — no second check", async () => {
    stampAnswer = { status: 200, body: { items: [OK, ENCRYPTED] } };
    const err = await issueTransmittal("t1", actor).catch((e) => e) as UnstampableItemsError;
    expect(err).toBeInstanceOf(UnstampableItemsError);
    expect(err.items).toEqual([ENCRYPTED]);
    expect(err.checked).toEqual({ draftUpdatedAt: READ_AT, items: [OK, ENCRYPTED] });
    expect(updates()).toEqual([]);
    fetchMock.mockClear();
    await issueTransmittal("t1", actor, { acceptedUnstampable: err.items, checked: err.checked });
    expect(stampCalls()).toEqual([]);
    const { patch, ops } = lastUpdate();
    expect(patch.items).toEqual([{ ...rawItems[0], stampable: true }, rawItems[1]]);
    expect((patch.items as Array<Record<string, unknown>>)[1]).not.toHaveProperty("stampable");
    expect(eqs(ops)).toContainEqual(["updated_at", READ_AT]);
    expect(db.audits[0]).toMatchObject({ action: "TRANSMITTAL_ISSUED", details: expect.objectContaining({ unstampableAccepted: [{ documentId: "d2", number: "VDS-7", verdict: "unloadable" }] }) });
  });

  it("P22 review fix: Issue anyway on a draft saved since the check it answers is REFUSED and named — nothing issued, armed, audited or emailed, and no second check", async () => {
    // the check ran on the draft as it was (U0); a colleague then saved it (U1 = READ_AT) — another item, another recipient
    const checked = { draftUpdatedAt: "2026-10-07T09:00:00+00:00", items: [OK, ENCRYPTED] };
    const phases: IssuePhase[] = [];
    await expect(issueTransmittal("t1", actor, { acceptedUnstampable: [ENCRYPTED], checked, onPhase: (p) => phases.push(p) })).rejects.toThrow("TR-0107 was not issued — the draft was changed while it was being issued (saved meanwhile, here or by someone else), and an issue never overwrites a draft edit. Nothing was sent: open the draft, check it and issue again.");
    expect(updates()).toEqual([]);
    expect(db.audits).toEqual([]);
    expect(fetchMock.mock.calls).toEqual([]); // no stamp check, no email
    expect(phases).toEqual([]);
  });

  it("P22 review fix: Issue anyway with nothing to arm (every checked PDF accepted) writes no items but is bound to the draft the issuer answered; a save in between is refused and named", async () => {
    const checked = { draftUpdatedAt: READ_AT, items: [{ ...ENCRYPTED, documentId: "d1", number: "P-101" }, ENCRYPTED] };
    const accepted = checked.items;
    await issueTransmittal("t1", actor, { acceptedUnstampable: accepted, checked });
    const first = lastUpdate();
    expect(first.patch).not.toHaveProperty("items");
    expect(eqs(first.ops)).toEqual([["id", "t1"], ["status", "draft"], ["updated_at", READ_AT]]);
    expect(db.audits[0]).toMatchObject({ action: "TRANSMITTAL_ISSUED", details: expect.objectContaining({ unstampableAccepted: [{ documentId: "d1", number: "P-101", verdict: "unloadable" }, { documentId: "d2", number: "VDS-7", verdict: "unloadable" }] }) });
    // the same yes, but the draft is saved between this read and the UPDATE
    db.calls = []; db.audits = []; fetchMock.mockClear();
    updateAnswer = { data: null, error: null };
    let reads = 0;
    db.handlers.transmittals = (ops) => has(ops, "update") ? updateAnswer : { data: ++reads === 1 ? readRow : { ...readRow, updated_at: "2026-10-07T09:16:10+00:00" }, error: null };
    await expect(issueTransmittal("t1", actor, { acceptedUnstampable: accepted, checked })).rejects.toThrow(/TR-0107 was not issued — the draft was changed while it was being issued/);
    expect(db.audits).toEqual([]);
    expect(fetchMock.mock.calls).toEqual([]);
  });

  it("REGRESSION: a caller with no check to carry (acceptedUnstampable alone) on a draft with an updated_at sends status / time only, with no draft-version match, as before P22", async () => {
    await issueTransmittal("t1", actor, { acceptedUnstampable: [ENCRYPTED] });
    const { patch, ops } = lastUpdate();
    expect(Object.keys(patch).sort()).toEqual(["issued_at", "status", "updated_at"]);
    expect(eqs(ops)).toEqual([["id", "t1"], ["status", "draft"]]);
    expect(stampCalls()).toEqual([]);
  });

  it("an issuer-accepted item never carries a mark, even one already on the draft item (only this issue's check arms)", async () => {
    readRow = { ...stored, items: [rawItems[0], { ...rawItems[1], stampable: true }] };
    await issueTransmittal("t1", actor, { acceptedUnstampable: [ENCRYPTED], checked: { draftUpdatedAt: READ_AT, items: [OK, ENCRYPTED] } });
    const items = lastUpdate().patch.items as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({ ...rawItems[0], stampable: true });
    expect(items[1]).toEqual(rawItems[1]);
    expect(items[1]).not.toHaveProperty("stampable");
  });

  it("a draft edited while it was being issued is REFUSED and named — never overwritten; nothing issued, nothing audited", async () => {
    updateAnswer = { data: null, error: null }; // the updated_at match found no row
    const reads: number[] = [];
    db.handlers.transmittals = (ops) => {
      if (has(ops, "update")) return updateAnswer;
      reads.push(1);
      // first read: the draft as it was; the re-read after the refused write: someone saved it meanwhile
      return { data: reads.length === 1 ? readRow : { ...readRow, updated_at: "2026-10-07T09:15:40.5+00:00" }, error: null };
    };
    await expect(issueTransmittal("t1", actor)).rejects.toThrow("TR-0107 was not issued — the draft was changed while it was being issued (saved meanwhile, here or by someone else), and an issue never overwrites a draft edit. Nothing was sent: open the draft, check it and issue again.");
    expect(updates()).toHaveLength(1);
    expect(db.audits).toEqual([]);
    expect(fetchMock.mock.calls.filter(([u]) => u !== "/api/transmittal/stamp-check")).toEqual([]); // no email
  });

  it("a refused write that is NOT a draft edit keeps the existing reason (no longer a draft, or no transmit authority)", async () => {
    updateAnswer = { data: null, error: null };
    // the re-read shows the draft unchanged (RLS / authority refused the write)
    await expect(issueTransmittal("t1", actor)).rejects.toThrow(/TR-0107 was not issued — it is no longer a draft, or you do not hold transmit authority/);
    // the re-read shows it already issued (someone else issued it meanwhile)
    let reads = 0;
    db.handlers.transmittals = (ops) => has(ops, "update") ? updateAnswer : { data: ++reads === 1 ? stored : { ...stored, status: "issued", updated_at: "2026-10-07T09:16:00+00:00" }, error: null };
    await expect(issueTransmittal("t1", actor)).rejects.toThrow(/TR-0107 was not issued — it is no longer a draft, or you do not hold transmit authority/);
    expect(db.audits).toEqual([]);
  });

  // P22 review fix: the check stamped a fixed text with no revision, so a
  // number or revision label the stamp's font cannot print (a Greek delta,
  // a Unicode hyphen pasted from Word) passed it and the item was armed —
  // then refused at every download, for good.
  it("P22 review fix: a check that finds the item's label unprintable stops the issue naming the characters; Issue anyway leaves that item unarmed (released recorded-unstamped, as before P22)", async () => {
    const LABEL: ItemStampCheck = { documentId: "d2", number: "VDS-7", verdict: "unloadable", detail: "its number or revision label has a character the portal's stamp cannot print (‐)", unprintable: "‐" };
    stampAnswer = { status: 200, body: { items: [OK, LABEL] } };
    const err = await issueTransmittal("t1", actor).catch((e) => e) as UnstampableItemsError;
    expect(err).toBeInstanceOf(UnstampableItemsError);
    expect(err.message).toContain("VDS-7: its number or revision label contains “‐” (U+2010), which the portal's stamp cannot print — change it to plain characters (letters, digits, an ordinary hyphen).");
    expect(err.message).not.toMatch(/VDS-7: a PDF the portal cannot mark/);
    expect(updates()).toEqual([]);
    await issueTransmittal("t1", actor, { acceptedUnstampable: err.items, checked: err.checked });
    const items = lastUpdate().patch.items as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({ ...rawItems[0], stampable: true });
    expect(items[1]).toEqual(rawItems[1]);
    expect(db.audits[0]).toMatchObject({ details: expect.objectContaining({ unstampableAccepted: [{ documentId: "d2", number: "VDS-7", verdict: "unloadable" }] }) });
  });

  it("P22 review fix: an item whose own number or revision the stamp cannot print is never armed, even when its check said stampable (a check that did not stamp the label) — and a mark already on it is stripped", async () => {
    readRow = { ...stored, items: [{ ...rawItems[0], rev: "Δ1", stampable: true }, { ...rawItems[1], number: "VDS‐7" }, { documentId: "d3", number: "P-103", rev: "Rév B" }] };
    db.handlers.documents = () => ({ data: ["d1", "d2", "d3"].map((d, i) => ({ id: d, status: "Issued", archived_at: null, current_version_id: `v${i + 1}` })), error: null });
    stampAnswer = { status: 200, body: { items: [OK, { ...OK, documentId: "d2", number: "VDS‐7" }, { ...OK, documentId: "d3", number: "P-103" }] } };
    await issueTransmittal("t1", actor);
    const items = lastUpdate().patch.items as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({ ...rawItems[0], rev: "Δ1" });
    expect(items[1]).toEqual({ ...rawItems[1], number: "VDS‐7" });
    // REGRESSION: Latin-1 (é) prints — armed as before
    expect(items[2]).toEqual({ documentId: "d3", number: "P-103", rev: "Rév B", stampable: true });
  });

  it("armCheckedItems — the pure rule", () => {
    const raw = [{ documentId: "d1", number: "A" }, { documentId: "d2", number: "B", stampable: true }, "junk", { number: "no id", stampable: false }];
    const none = armCheckedItems(raw, null);
    expect(none.items).toEqual([{ documentId: "d1", number: "A" }, { documentId: "d2", number: "B" }, "junk", { number: "no id" }]);
    expect(none).toMatchObject({ changed: true, armed: 0 });
    const clean = armCheckedItems([{ documentId: "d1", number: "A" }], [{ documentId: "d1", number: "A", verdict: "not_pdf" }]);
    expect(clean).toEqual({ items: [{ documentId: "d1", number: "A" }], changed: false, armed: 0 });
    const already = armCheckedItems([{ documentId: "d1", stampable: true }], [OK]);
    expect(already).toEqual({ items: [{ documentId: "d1", stampable: true }], changed: false, armed: 1 });
    // a document with a stampable and a non-stampable verdict is not armed
    expect(armCheckedItems([{ documentId: "d1" }], [OK, { ...OK, verdict: "unchecked" }]).armed).toBe(0);
    expect(armCheckedItems("not an array", [OK])).toEqual({ items: [], changed: false, armed: 0 });
    // P22 review fix: a number or revision the stamp cannot print is never armed
    for (const bad of [{ rev: "Δ1" }, { rev: "P‐01" }, { rev: "A→B" }, { number: "P‐101" }, { number: "Ω-1" }]) {
      expect(armCheckedItems([{ documentId: "d1", number: "P-101", ...bad }], [OK]).armed).toBe(0);
    }
    for (const ok of [{ rev: "A" }, { rev: "1.2" }, { rev: " C " }, { rev: null }, { rev: "Rév B" }, { number: "P–101" }]) {
      expect(armCheckedItems([{ documentId: "d1", number: "P-101", ...ok }], [OK]).armed).toBe(1);
    }
    expect(stampFooterUnprintable("P‐01 Δ1 Δ2")).toBe("‐Δ");
    expect(stampFooterUnprintable("Rev A — 1.2 (é, €, “x”)")).toBe("");
    const lib = readFileSync(join(process.cwd(), "lib/transmittals.ts"), "utf8");
    expect(lib).toMatch(/const bound = readAt !== null && \(marked \|\| checks !== null\);/);
    expect(lib).toMatch(/if \(bound && readAt\) write = write\.eq\("updated_at", readAt\);/);
    expect(lib).toMatch(/if \(opts\.checked\.draftUpdatedAt !== readAt\) throw new Error\(draftChangedRefusal\(draft\.number\)\);/);
  });
});
