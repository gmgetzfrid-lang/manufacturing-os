// document-control Round F wave 3 — P15 SURFACE REMAINDERS: TRX-16, the
// issue half. issueTransmittal asks the server whether the portal can stamp
// each PDF BEFORE anything is written; a PDF it cannot mark stops the issue
// with an UnstampableItemsError naming the item and the reason (the ISSUER is
// warned at issue, not the recipient later); the issuer may go ahead
// (`acceptedUnstampable`), recorded on the TRANSMITTAL_ISSUED row. A check
// that cannot run never blocks an issue. No item is marked `stampable` —
// arming the portal's stricter refusal awaits the user's ratification of the
// DEC-61 §5 amendment.

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
  issueTransmittal, describeUnstampable, unstampableItems, UnstampableItemsError, PORTAL_STAMP_MAX_BYTES,
  type ItemStampCheck,
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
  it("the issue writes no `stampable` mark: the update sends status / time only (arming the portal's refusal awaits the DEC-61 §5 ratification)", async () => {
    await issueTransmittal("t1", actor, { acceptedUnstampable: [ENCRYPTED] });
    const upd = updates()[0].ops.find(([n]) => n === "update")![1][0] as Record<string, unknown>;
    expect(Object.keys(upd).sort()).toEqual(["issued_at", "status", "updated_at"]);
    expect(readFileSync(join(process.cwd(), "lib/transmittals.ts"), "utf8")).not.toMatch(/stampable:\s*true/);
  });
});

describe("TRX-16 — the composer asks the issuer", () => {
  const page = readFileSync(join(process.cwd(), "app/(protected)/transmittals/page.tsx"), "utf8");
  it("an UnstampableItemsError opens a confirm naming the files; Issue anyway re-issues with the accepted items; declining leaves a saved draft, not issued", () => {
    expect(page).toContain("UnstampableItemsError,");
    expect(page).toMatch(/if \(!\(e instanceof UnstampableItemsError\)\) throw e;/);
    expect(page).toMatch(/appConfirm\(\{ title: "Files the portal cannot mark", message: <span className="whitespace-pre-line">\{e\.message\}<\/span>, confirmLabel: "Issue anyway" \}\)/);
    expect(page).toContain("outcome = await issueTransmittal(draft.id, actor, { acceptedUnstampable: e.items });");
    expect(page).toContain('await onSaved({ kind: "issue-failed", draft, error: "Not issued — fix the file(s) the portal cannot mark, then issue again." });');
  });
});
