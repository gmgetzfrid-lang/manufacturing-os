// document-control Round F wave 3 — P14 RECORDS & REVIEW REMAINDERS: two
// small library limbs.
//
//   HLD-1   disposeDocument's dispose gate reads holds through lib/holdGate.ts
//           (readActiveHolds + decideHoldGate) — THE one hold gate — instead
//           of lib/holds.ts listActiveHoldsForDocument, keeping P9's
//           behaviour: a known hold answers `active_hold` with nothing
//           written; an unreadable hold set THROWS (fail closed), now the
//           gate's own HoldBlockedError.
//   PKG-9   (the residual P8 handed off) effectiveAckPolicyForDocument reads
//           the folder / library ack_policy CHECKED, as lib/downloads.ts
//           readEffectiveAckPolicy does: a failed read threw nothing and
//           resolved as "no policy", and recomputeDocumentAck then voided
//           every pending acknowledgment row.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Op = { m: string; args: unknown[] };
const state = vi.hoisted(() => ({
  resolve: ((_t: string, _o: Array<{ m: string; args: unknown[] }>) => ({ data: [], error: null })) as
    (table: string, ops: Array<{ m: string; args: unknown[] }>) => { data?: unknown; error?: unknown },
  reads: [] as string[],
  writes: [] as Array<{ table: string; op: string; payload: unknown }>,
}));
const argOf = (ops: Op[], m: string) => ops.find((o) => o.m === m)?.args;

vi.mock("@/lib/supabase", () => {
  function chain(table: string) {
    const ops: Op[] = [];
    const run = () => {
      const w = ops.find((o) => o.m === "update" || o.m === "insert" || o.m === "upsert" || o.m === "delete");
      if (w) state.writes.push({ table, op: w.m, payload: w.args[0] });
      else state.reads.push(table);
      return state.resolve(table, ops);
    };
    const c: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (res: (v: unknown) => void, rej?: (e: unknown) => void) => Promise.resolve().then(run).then(res, rej);
        return (...args: unknown[]) => {
          ops.push({ m: prop, args });
          if (prop === "maybeSingle") return Promise.resolve(run());
          if (prop === "select" && ops.some((o) => o.m === "update" || o.m === "insert")) return Promise.resolve(run());
          return new Proxy(c, handler);
        };
      },
    };
    return new Proxy(c, handler);
  }
  return { supabase: { from: (t: string) => chain(t), auth: { getUser: async () => ({ data: { user: null } }) } } };
});
vi.mock("@/lib/principal", () => ({
  resolveActorPrincipal: vi.fn(async (i: { uid: string }) => ({ uid: i.uid, role: "Admin", roles: ["Admin"], orgId: "org1", teamIds: [], isActiveMember: true })),
}));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ error: null })), logHoldEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => undefined) }));
vi.mock("@/lib/eSignatures", () => ({ recordSignature: vi.fn() }));
vi.mock("@/lib/ownership", () => ({
  getOrgControllers: vi.fn(async () => ["ctrl1"]),
  effectiveOwnerForDocument: vi.fn(async () => ({ userId: "owner1", name: "Owner" })),
  isEffectiveOwnerOfDocument: vi.fn(async () => false),
  resolveEffectiveOwner: vi.fn(() => ({ userId: null, name: null })),
  teamSupervisorMap: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/documentGuards", () => ({ resolveCanControlLibrary: vi.fn(async () => false) }));

import { disposeDocument } from "@/lib/retention";
import { isHoldBlockedError, HoldBlockedError } from "@/lib/holdGate";
import { effectiveAckPolicyForDocument, recomputeDocumentAck, onDocumentIssuedAck } from "@/lib/acknowledgments";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

beforeEach(() => {
  state.reads = [];
  state.writes = [];
  state.resolve = () => ({ data: [], error: null });
});

describe("HLD-1 (the dispose limb) — disposeDocument asks lib/holdGate.ts, keeping P9's dispose gate", () => {
  const resolver = (holds: unknown, holdErr: unknown = null) => (table: string, ops: Op[]) => {
    if (table === "document_holds") return { data: holds, error: holdErr };
    if (table === "documents" && argOf(ops, "update")) return { data: [{ id: "d1" }], error: null };
    if (table === "documents" && argOf(ops, "select")?.[0] === "legal_hold") return { data: { legal_hold: false }, error: null };
    if (table === "documents") return { data: { retention_policy: null, collection_id: null, library_id: "l1" }, error: null };
    if (table === "libraries") return { data: { retention_policy: null }, error: null };
    return { data: null, error: null };
  };

  it("the gate is lib/holdGate.ts (readActiveHolds + decideHoldGate) — lib/holds.ts's listActiveHoldsForDocument is no longer read here", () => {
    const r = src("lib/retention.ts");
    expect(r).toContain('import { readActiveHolds, decideHoldGate, HoldBlockedError } from "@/lib/holdGate";');
    expect(r).not.toMatch(/listActiveHoldsForDocument/);
    const fn = r.slice(r.indexOf("export async function disposeDocument("), r.indexOf("// ── Daily scan: flag newly-eligible records"));
    expect(fn).toContain('const holdGate = decideHoldGate(await readActiveHolds(input.documentId), "disposing it");');
    // before anything is read or written for the disposal itself
    expect(fn.indexOf("decideHoldGate(")).toBeLessThan(fn.indexOf('.update({ disposition_state: "disposed"'));
  });

  it("a known hold: `active_hold`, nothing written (P9's answer, unchanged)", async () => {
    state.resolve = resolver([{ id: "h1", reason: "Client Review", opened_at: "2026-01-01", opened_by_name: "QA" }]);
    expect(await disposeDocument({ documentId: "d1", orgId: "org1", actorId: "u1" })).toEqual({ ok: false, reason: "active_hold" });
    expect(state.writes).toEqual([]);
  });

  it("an unreadable hold set throws the gate's HoldBlockedError (fail closed) — naming the read error, nothing written", async () => {
    state.resolve = resolver(null, { message: "db down" });
    const err = await disposeDocument({ documentId: "d1", orgId: "org1", actorId: "u1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HoldBlockedError);
    expect(isHoldBlockedError(err)).toBe(true);
    expect((err as HoldBlockedError).unreadable).toBe(true);
    expect((err as Error).message).toMatch(/db down/);
    expect((err as Error).message).toMatch(/disposing it/);
    expect(state.writes).toEqual([]);
  });

  it("regression — a clear document is disposed as before", async () => {
    state.resolve = resolver([]);
    expect(await disposeDocument({ documentId: "d1", orgId: "org1", actorId: "u1" })).toEqual({ ok: true, action: "archive" });
    expect(state.writes.find((w) => w.table === "documents")?.payload).toMatchObject({ disposition_state: "disposed", status: "Archived" });
  });
});

describe("PKG-9's residual — the inherited ack policy is read CHECKED", () => {
  const POLICY = { enabled: true, assigneeIds: ["a1"] };

  it("a folder or library read error throws — never resolves as 'no policy'", async () => {
    state.resolve = (t) => (t === "collections" ? { data: null, error: { message: "timeout" } } : { data: { ack_policy: POLICY }, error: null });
    await expect(effectiveAckPolicyForDocument({ collectionId: "c1", libraryId: "l1" })).rejects.toThrow(/folder's read-&-understood policy \(timeout\)/);
    state.resolve = (t) => (t === "libraries" ? { data: null, error: { message: "connection reset" } } : { data: { ack_policy: null }, error: null });
    await expect(effectiveAckPolicyForDocument({ collectionId: "c1", libraryId: "l1" })).rejects.toThrow(/library's read-&-understood policy \(connection reset\)/);
  });

  it("the most specific DEFINED level wins, and a level is read only while every more specific one is undefined (downloads.ts's rule)", async () => {
    state.resolve = () => ({ data: { ack_policy: null }, error: { message: "should not be read" } });
    expect(await effectiveAckPolicyForDocument({ ackPolicy: POLICY as never, collectionId: "c1", libraryId: "l1" })).toEqual(POLICY);
    expect(state.reads).toEqual([]);
    expect(await effectiveAckPolicyForDocument({ ackPolicy: { enabled: false } as never, collectionId: "c1", libraryId: "l1" })).toBeNull();
    state.resolve = (t) => (t === "collections" ? { data: { ack_policy: POLICY }, error: null } : { data: null, error: { message: "should not be read" } });
    state.reads = [];
    expect(await effectiveAckPolicyForDocument({ collectionId: "c1", libraryId: "l1" })).toEqual(POLICY);
    expect(state.reads).toEqual(["collections"]);
    state.resolve = (t) => (t === "libraries" ? { data: { ack_policy: POLICY }, error: null } : { data: { ack_policy: null }, error: null });
    expect(await effectiveAckPolicyForDocument({ collectionId: "c1", libraryId: "l1" })).toEqual(POLICY);
    expect(await effectiveAckPolicyForDocument({ libraryId: "l1" })).toEqual(POLICY);
  });

  it("recomputeDocumentAck no longer VOIDS a live roster when the policy cannot be read — it throws before the 'no policy' void; onDocumentIssuedAck records it as a roster error", async () => {
    const doc = { id: "d1", org_id: "org1", library_id: "l1", collection_id: null, status: "Issued", current_version_id: "v2", document_number: "P-101", title: null, name: null, ack_policy: null, owner_user_id: null, owner_name: null };
    state.resolve = (t, ops) => {
      if (t === "documents") return { data: doc, error: null };
      if (t === "libraries") return { data: null, error: { message: "timeout" } };
      if (t === "document_acknowledgments" && argOf(ops, "update")) return { data: null, error: null };
      return { data: [], error: null };
    };
    await expect(recomputeDocumentAck({ orgId: "org1", documentId: "d1" })).rejects.toThrow(/library's read-&-understood policy \(timeout\)/);
    const voids = state.writes.filter((w) => w.table === "document_acknowledgments");
    // only the stale-REVISION void ran (it precedes the policy read, as before) — never the "no policy" void of every pending row
    expect(voids).toHaveLength(1);
    const staleVoid = src("lib/acknowledgments.ts");
    expect(staleVoid).toContain('.eq("document_id", doc.id).eq("status", "pending").not("document_version_id", "eq", versionId);');
    const writeErrors: string[] = [];
    state.writes = [];
    await onDocumentIssuedAck({ orgId: "org1", documentId: "d1", writeErrors });
    expect(writeErrors).toEqual([expect.stringMatching(/opening the acknowledgment roster stopped on an error \(Couldn't read the library's read-&-understood policy \(timeout\)/)]);
  });
});
