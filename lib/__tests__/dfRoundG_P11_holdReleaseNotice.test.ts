// drafting-flow Round G, DF-P11 fix pass 2 — HAND-2 done-when 2: "Releasing
// a hold opened by someone else requires a reason recorded on the hold row
// and notifies the opener BEFORE the release commits."
//
//   * releaseHold awaits the opener's notice (the existing hold_released
//     kind, bell row on the retried path) BEFORE the UPDATE — the order is
//     pinned on a shared call log;
//   * a notice that did not land (or a send that threw) refuses the release
//     with a sentence — nothing written;
//   * an UPDATE that fails after the opener was told sends "did not go
//     through" on the same kind;
//   * the opener releasing their own hold sends no pre-notice; an opener who
//     is no longer an active member cannot be told and does not freeze the
//     hold; a membership read that fails refuses (fail closed).

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  user: { id: "dc" } as null | { id: string },
  tables: {} as Record<string, Row[]>,
  readError: {} as Record<string, { message: string } | undefined>,
  updateError: null as null | { message: string },
  log: [] as string[],
  emitResult: { recipients: 1, inapp: { sent: 1, failed: 0 } } as unknown,
  emitThrows: null as null | Error,
  emits: [] as Array<Record<string, unknown>>,
}));

function table(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: { kind: "update"; patch: Row } | null = null;
  const rows = () => (db.tables[name] ??= []);
  const run = () => {
    if (op?.kind === "update") {
      db.log.push(`update:${name}`);
      if (db.updateError) return { data: null, error: db.updateError };
      const hit = rows().filter((r) => filters.every((f) => f(r)));
      for (const r of hit) Object.assign(r, op.patch);
      return { data: hit.map((r) => ({ ...r })), error: null };
    }
    if (db.readError[name]) return { data: null, error: db.readError[name] };
    return { data: rows().filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null };
  };
  const q = {
    select() { return q; },
    eq(k: string, v: unknown) { filters.push((r) => r[k] === v); return q; },
    is(k: string, v: unknown) { filters.push((r) => (r[k] ?? null) === v); return q; },
    in(k: string, vs: unknown[]) { filters.push((r) => vs.includes(r[k])); return q; },
    order() { return q; },
    limit() { return q; },
    update(patch: Row) { op = { kind: "update", patch }; return q; },
    maybeSingle() { const o = run(); return Promise.resolve({ data: (o.data as Row[] | null)?.[0] ?? null, error: o.error }); },
    single() { return q.maybeSingle(); },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) { return Promise.resolve().then(run).then(resolve, reject); },
  };
  return q;
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => table(t),
    auth: { getUser: async () => ({ data: { user: db.user }, error: null }), getSession: async () => ({ data: { session: null } }) },
  },
}));
vi.mock("@/lib/audit", () => ({ logHoldEvent: vi.fn(async () => undefined), logAuditAction: vi.fn(async () => undefined) }));
vi.mock("@/lib/notify/dispatch", () => ({
  emit: vi.fn(async (input: Record<string, unknown>) => {
    db.log.push(`emit:${String((input.metadata as Row | undefined)?.releaseNotice ?? "after")}`);
    db.emits.push(input);
    if (db.emitThrows) throw db.emitThrows;
    return db.emitResult;
  }),
}));

import { releaseHold, noticeOpenerOfRelease } from "@/lib/holds";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";

const hold = (openedBy: string): Row => ({
  id: "h1", org_id: "o1", document_id: "d1", reason: "Field Verification Needed", notes: null,
  opened_by: openedBy, opened_at: "2026-10-01T00:00:00Z", released_at: null, expected_release_at: null,
  release_recorded_at: "2026-10-20T00:00:00Z",
});
const member = (uid: string, role: string, status = "active"): Row => ({ org_id: "o1", uid, role, roles: [role], status });

beforeEach(() => {
  __resetCapabilityPolicyCache();
  db.user = { id: "dc" };
  db.readError = {};
  db.updateError = null;
  db.log = [];
  db.emits = [];
  db.emitThrows = null;
  db.emitResult = { recipients: 1, inapp: { sent: 1, failed: 0 } };
  db.tables = {
    org_configurations: [],
    org_members: [member("dc", "DocCtrl"), member("eng", "Engineer-2")],
    documents: [{ id: "d1", org_id: "o1", document_number: "P-101", library_id: "L1" }],
    document_holds: [hold("eng")],
  };
});

describe("HAND-2 done-when 2 — the opener of a hold someone else releases is told BEFORE the release commits", () => {
  it("DocCtrl releases an Engineer's hold: the opener's notice is sent and landed BEFORE the UPDATE, names the releaser and the reason, on the existing hold_released kind", async () => {
    await releaseHold({ holdId: "h1", releasedBy: "dc", releasedByName: "Dana (DocCtrl)", releasedReason: "field walk done" });
    expect(db.log.indexOf("emit:pending")).toBeGreaterThanOrEqual(0);
    expect(db.log.indexOf("emit:pending")).toBeLessThan(db.log.indexOf("update:document_holds"));
    const pre = db.emits.find((e) => (e.metadata as Row).releaseNotice === "pending")!;
    expect(pre.kind).toBe("hold_released");
    expect(pre.audience).toEqual({ involved: ["eng"] });
    expect(pre.inappRetry).toEqual({});
    expect(pre.title).toBe("Your hold on P-101 is being released");
    expect(pre.body).toBe('Dana (DocCtrl) is releasing the "Field Verification Needed" hold you placed: field walk done');
    expect(pre.link).toBe("/documents/L1?doc=d1");
    expect(db.tables.document_holds[0].released_at).toBeTruthy();
  });

  it("a notice that did not land refuses the release — nothing written, a stated error", async () => {
    db.emitResult = { recipients: 1, inapp: { sent: 0, failed: 1 } };
    await expect(releaseHold({ holdId: "h1", releasedBy: "dc", releasedReason: "field walk done" }))
      .rejects.toThrow(/^The hold was not released: the person who placed it could not be told first \(their notice did not land\)\. A hold placed by someone else is released only once they have been notified/);
    expect(db.log).not.toContain("update:document_holds");
    expect(db.tables.document_holds[0].released_at).toBeNull();
  });

  it("a send that throws, or reaches nobody, refuses the same way", async () => {
    db.emitThrows = new Error("network down");
    await expect(releaseHold({ holdId: "h1", releasedBy: "dc", releasedReason: "x" })).rejects.toThrow(/could not be told first \(network down\)/);
    db.emitThrows = null;
    db.emitResult = { recipients: 0 };
    await expect(releaseHold({ holdId: "h1", releasedBy: "dc", releasedReason: "x" })).rejects.toThrow(/could not be told first \(the notice reached nobody\)/);
    expect(db.log).not.toContain("update:document_holds");
  });

  it("the UPDATE fails after the opener was told: they are told it did not go through, on the same kind, and the error stands", async () => {
    db.updateError = { message: "new row violates row-level security policy" };
    await expect(releaseHold({ holdId: "h1", releasedBy: "dc", releasedByName: "Dana", releasedReason: "x" }))
      .rejects.toThrow(/^new row violates row-level security policy$/);
    expect(db.log).toEqual(["emit:pending", "update:document_holds", "emit:failed"]);
    const post = db.emits.find((e) => (e.metadata as Row).releaseNotice === "failed")!;
    expect(post.kind).toBe("hold_released");
    expect(post.audience).toEqual({ involved: ["eng"] });
    expect(post.title).toBe("The release of your hold on P-101 did not go through");
    expect(String(post.body)).toContain("The hold is still in place.");
  });

  it("the opener releasing their OWN hold sends no pre-notice (nobody else to tell first)", async () => {
    db.user = { id: "eng" };
    await releaseHold({ holdId: "h1", releasedBy: "eng", releasedReason: "verified" });
    expect(db.log.filter((l) => l === "emit:pending")).toEqual([]);
    expect(db.tables.document_holds[0].released_at).toBeTruthy();
  });

  it("an opener who is no longer an active member cannot be told: the release goes ahead (the stop is not frozen by a departed person); a membership read that fails refuses", async () => {
    db.tables.org_members = [member("dc", "DocCtrl"), member("eng", "Engineer-2", "suspended")];
    await releaseHold({ holdId: "h1", releasedBy: "dc", releasedReason: "owner left" });
    expect(db.log.filter((l) => l === "emit:pending")).toEqual([]);
    expect(db.tables.document_holds[0].released_at).toBeTruthy();

    // the opener lookup itself fails: refused before anything is sent
    db.readError.org_members = { message: "timeout" };
    await expect(noticeOpenerOfRelease({
      phase: "pending", orgId: "o1", holdId: "h1", documentId: "d1", openedBy: "eng", holdLabel: "x",
      releasedReason: "y", actorUserId: "dc",
    })).rejects.toThrow(/could not be told first \(their membership could not be read: timeout\)/);
    expect(db.emits).toEqual([]);
  });

  it("REGRESSION: the post-commit notice to the whole hold audience still fires after the release", async () => {
    await releaseHold({ holdId: "h1", releasedBy: "dc", releasedReason: "field walk done" });
    await vi.waitFor(() => expect(db.log).toContain("emit:after"));
    expect(db.log.indexOf("emit:after")).toBeGreaterThan(db.log.indexOf("update:document_holds"));
  });
});
