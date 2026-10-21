// document-control Round G — P28 STATUS-DOOR REMAINDERS: a retention
// disposal is a retirement (notifications PROD-17, open door (4)).
//
//   disposeDocument archives the record; once the disposal has landed, one
//   lib/revisions.ts recallOnRetirement goes, fired and never awaited, with
//   the archive's rules, decided from the status read fresh BEFORE the write:
//   a record already Superseded or Archived gets nothing again; the copy
//   holders are recalled only when it took away a controlled issue (DEC-90
//   R1); the watchers are told either way. REGRESSION: every answer the
//   disposal gave, it gives; a refused, held or legally-held disposal recalls
//   nothing.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Op = { m: string; args: unknown[] };
const state = vi.hoisted(() => ({
  resolve: ((_t: string, _o: Array<{ m: string; args: unknown[] }>) => ({ data: [], error: null })) as
    (table: string, ops: Array<{ m: string; args: unknown[] }>) => { data?: unknown; error?: unknown },
  writes: [] as Array<{ table: string; op: string; payload: unknown }>,
}));
const argOf = (ops: Op[], m: string) => ops.find((o) => o.m === m)?.args;

vi.mock("@/lib/supabase", () => {
  function chain(table: string) {
    const ops: Op[] = [];
    const run = () => {
      const w = ops.find((o) => o.m === "update" || o.m === "insert" || o.m === "upsert" || o.m === "delete");
      if (w) state.writes.push({ table, op: w.m, payload: w.args[0] });
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
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ error: null, ok: true })), logHoldEvent: vi.fn(async () => undefined), logRevisionEvent: vi.fn(async () => ({ error: null, ok: true })) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => undefined) }));
vi.mock("@/lib/ownership", () => ({
  getOrgControllers: vi.fn(async () => ["ctrl1"]),
  effectiveOwnerForDocument: vi.fn(async () => ({ userId: "owner1", name: "Owner" })),
  isEffectiveOwnerOfDocument: vi.fn(async () => false),
  resolveEffectiveOwner: vi.fn(() => ({ userId: null, name: null })),
  teamSupervisorMap: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/documentGuards", () => ({ resolveCanControlLibrary: vi.fn(async () => false) }));
vi.mock("@/lib/revisions", async () => {
  const issue = await import("@/lib/issueStatus");
  return {
    recallOnRetirement: vi.fn(),
    // the real one-liners (lib/revisions.ts skipsRetirementRecall / recallsCopyHolders)
    skipsRetirementRecall: (s: string | null | undefined) => issue.isRetiredStatus(s) && (s ?? "").trim() !== "Void",
    recallsCopyHolders: (s: string | null | undefined) => issue.isControlledIssueStatus(s),
  };
});

import { disposeDocument } from "@/lib/retention";
import { recallOnRetirement } from "@/lib/revisions";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const recall = vi.mocked(recallOnRetirement);
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1)); };

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  state.writes = [];
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

/** The database: `status` is the record's status before the disposal; `statusReadFails` fails the separate status read. */
const db = (o: { status?: string | null; holds?: unknown[]; legalHold?: boolean; refuse?: boolean; statusReadFails?: boolean } = {}) => (table: string, ops: Op[]) => {
  const cols = String(argOf(ops, "select")?.[0] ?? "");
  if (table === "document_holds") return { data: o.holds ?? [], error: null };
  if (table === "documents" && argOf(ops, "update")) return { data: o.refuse ? [] : [{ id: "d1" }], error: null };
  if (table === "documents" && cols === "legal_hold") return { data: { legal_hold: o.legalHold === true }, error: null };
  if (table === "documents" && cols === "status") return o.statusReadFails ? { data: null, error: { message: "503" } } : { data: { status: o.status ?? "Issued" }, error: null };
  if (table === "documents") return { data: { retention_policy: null, collection_id: null, library_id: "l1", status: o.status ?? "Issued" }, error: null };
  if (table === "libraries") return { data: { retention_policy: null }, error: null };
  return { data: null, error: null };
};

describe("PROD-17 (P28) — a retention disposal recalls and tells, once, with the archive's rules", () => {
  it("an Issued record disposed (no action named): one recall — Archived, the disposal named, neither personal notice sent elsewhere, the copy holders recalled; the answer unchanged", async () => {
    state.resolve = db({ status: "Issued" });
    expect(await disposeDocument({ documentId: "d1", orgId: "org1", actorId: "u1", actorName: "dana@x" })).toEqual({ ok: true, action: "archive" });
    await settle();
    expect(recall).toHaveBeenCalledTimes(1);
    expect(recall.mock.calls[0][0]).toEqual({
      orgId: "org1", documentId: "d1", newStatus: "Archived", replacementNote: "Disposed under its retention schedule.",
      actorUserId: "u1", actorName: "dana@x",
      personallyToldElsewhere: { checkoutHolder: false, packageOwners: false },
      recallCopyHolders: true,
    });
    expect(state.writes.find((w) => w.table === "documents")?.payload).toMatchObject({ disposition_state: "disposed", status: "Archived" });
  });

  it("an action named: the status is read before the write as well; a Draft record tells its watchers only (DEC-90 R1)", async () => {
    state.resolve = db({ status: "Draft" });
    expect(await disposeDocument({ documentId: "d1", orgId: "org1", action: "destroy", actorId: "u1" })).toEqual({ ok: true, action: "destroy" });
    await settle();
    expect(recall.mock.calls[0][0]).toMatchObject({ recallCopyHolders: false, actorName: "u1" });
  });

  it("a status read that fails leaves the prior unknown, which recalls (a second recall over none)", async () => {
    state.resolve = db({ statusReadFails: true });
    await disposeDocument({ documentId: "d1", orgId: "org1", actorId: "u1" });
    await settle();
    expect(recall.mock.calls[0][0]).toMatchObject({ recallCopyHolders: true });
  });

  it("a record already Archived or Superseded gets nothing again; a Void one tells its watchers only", async () => {
    for (const s of ["Archived", "Superseded"]) {
      state.resolve = db({ status: s });
      await disposeDocument({ documentId: "d1", orgId: "org1", actorId: "u1" });
    }
    await settle();
    expect(recall).not.toHaveBeenCalled();
    state.resolve = db({ status: "Void" });
    await disposeDocument({ documentId: "d1", orgId: "org1", actorId: "u1" });
    await settle();
    expect(recall.mock.calls.map((c) => c[0].recallCopyHolders)).toEqual([false]);
  });

  it("REGRESSION: a refused, held or legally-held disposal answers as before and recalls nothing", async () => {
    state.resolve = db({ refuse: true });
    expect(await disposeDocument({ documentId: "d1", orgId: "org1", actorId: "u1" })).toEqual({ ok: false, reason: "refused" });
    state.resolve = db({ holds: [{ id: "h1", reason: "Client Review", opened_at: "2026-01-01" }] });
    expect(await disposeDocument({ documentId: "d1", orgId: "org1", actorId: "u1" })).toEqual({ ok: false, reason: "active_hold" });
    state.resolve = db({ legalHold: true });
    expect(await disposeDocument({ documentId: "d1", orgId: "org1", actorId: "u1" })).toEqual({ ok: false, reason: "legal_hold" });
    await settle();
    expect(recall).not.toHaveBeenCalled();
  });

  it("REGRESSION: a disposal with no actor named is refused before anything is written (assertRetentionAuthority), as before — no recall", async () => {
    state.resolve = db({ status: "Issued" });
    await expect(disposeDocument({ documentId: "d1", orgId: "org1", actorId: null })).rejects.toThrow(/Retention settings can only be changed/);
    await settle();
    expect(state.writes).toEqual([]);
    expect(recall).not.toHaveBeenCalled();
  });

  it("the recall goes AFTER the disposal's write and its record (source order), loaded on demand (lib/revisions.ts imports this file)", () => {
    const r = readFileSync(join(process.cwd(), "lib/retention.ts"), "utf8");
    const fn = r.slice(r.indexOf("export async function disposeDocument("), r.indexOf("// ── Daily scan: flag newly-eligible records"));
    expect(fn.indexOf('void import("@/lib/revisions")')).toBeGreaterThan(fn.indexOf('action: "disposed"'));
    // the schedule's read is byte-for-byte what it was; the status read is its own, just before the write
    expect(fn).toContain('.select("retention_policy, collection_id, library_id").eq("id", input.documentId).maybeSingle();');
    expect(fn.indexOf('.select("status").eq("id", input.documentId).maybeSingle()')).toBeLessThan(fn.indexOf('.update({ disposition_state: "disposed"'));
    expect(r).not.toMatch(/^import .* from "@\/lib\/revisions";$/m);
  });
});
