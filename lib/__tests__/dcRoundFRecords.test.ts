// Document-control Round F (P9) — the records-management libs:
//   RET-5   recomputeRetention, scanRetention's flag write and logEvent are
//           CHECKED (the three writes SURF-3 / OWN-14 left unchecked);
//   HLD-1   disposeDocument refuses under an open operational hold (the
//           dispose-gate limb; the DB limb is 20261077);
//   RET-11  RetentionPolicy.action is finally READ: the scan names it, the
//           panel describes it, disposeDocument records it;
//   RET-3   the recertification attests the EFFECTIVE population, expired
//           rules are split out, and an unresolvable population refuses;
//   DRLS-4  the review-certification inserts are checked.

import { describe, it, expect, vi, beforeEach } from "vitest";

type Op = { m: string; args: unknown[] };
const state = vi.hoisted(() => ({
  resolve: ((_t: string, _o: Array<{ m: string; args: unknown[] }>) => ({ data: [], error: null })) as
    (table: string, ops: Array<{ m: string; args: unknown[] }>) => { data?: unknown; error?: unknown },
  notifies: [] as Array<Record<string, unknown>>,
}));
const argOf = (ops: Op[], m: string) => ops.find((o) => o.m === m)?.args;

vi.mock("@/lib/supabase", () => {
  function chain(table: string) {
    const ops: Op[] = [];
    const run = () => state.resolve(table, ops);
    const c: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (res: (v: unknown) => void, rej?: (e: unknown) => void) => Promise.resolve().then(run).then(res, rej);
        }
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
vi.mock("@/lib/audit", () => ({
  logAuditAction: vi.fn(async () => undefined),
  logHoldEvent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/inAppNotifications", () => ({
  notify: vi.fn(async (p: Record<string, unknown>) => { state.notifies.push(p); }),
}));
vi.mock("@/lib/ownership", () => ({
  getOrgControllers: vi.fn(async () => ["ctrl1"]),
  effectiveOwnerForDocument: vi.fn(async () => ({ userId: "owner1", name: "Owner" })),
  isEffectiveOwnerOfDocument: vi.fn(async () => false),
  resolveEffectiveOwner: vi.fn(() => ({ userId: null, name: null })),
  teamSupervisorMap: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/documentGuards", () => ({ resolveCanControlLibrary: vi.fn(async () => false) }));

import {
  scheduledActionFor, scheduledActionLabel, disposeActionFor, describeRetentionPolicy,
} from "@/lib/retentionPolicy";
import { recomputeRetention, disposeDocument, scanRetention, placeLegalHold } from "@/lib/retention";
import { markReviewed } from "@/lib/reviewCycles";
import { listAccessGrantsDetailed, listAccessGrants, recertifyAccess } from "@/lib/accessRecert";
import type { RetentionPolicy } from "@/types/schema";

const P = (p: Partial<RetentionPolicy> = {}): RetentionPolicy => ({ enabled: true, years: 7, basis: "created", ...p });

beforeEach(() => {
  state.resolve = () => ({ data: [], error: null });
  state.notifies = [];
});

describe("RET-11 — the scheduled action is read (pure)", () => {
  it("resolves the action, its label and the disposition default", () => {
    expect(scheduledActionFor(P())).toBe("review");
    expect(scheduledActionFor(P({ action: "destroy" }))).toBe("destroy");
    expect(scheduledActionFor(null)).toBe("review");
    expect(scheduledActionLabel(P({ action: "destroy" }))).toBe("destroy");
    expect(scheduledActionLabel(P({ action: "archive" }))).toBe("archive");
    expect(scheduledActionLabel(P())).toBe("flag for review");
    expect(disposeActionFor(P({ action: "destroy" }))).toBe("destroy");
    expect(disposeActionFor(P({ action: "archive" }))).toBe("archive");
    expect(disposeActionFor(P({ action: "review" }))).toBe("archive");
    expect(disposeActionFor(null)).toBe("archive");
  });
  it("describes the policy WITH its end-of-life action", () => {
    expect(describeRetentionPolicy(P({ years: 30, basis: "issued", action: "destroy" }))).toBe("Retain 30 years from issued, then destroy");
    expect(describeRetentionPolicy(P({ years: 1 }))).toBe("Retain 1 year from created, then flag for review");
    expect(describeRetentionPolicy(null)).toBe("No retention policy");
    expect(describeRetentionPolicy(P({ enabled: false }))).toBe("No retention policy");
  });
});

describe("RET-5 — checked writes in lib/retention.ts", () => {
  it("recomputeRetention throws when the clock write is refused", async () => {
    state.resolve = (table, ops) => {
      if (table === "documents" && argOf(ops, "update")) return { data: null, error: { message: "refused" } };
      if (table === "documents") return { data: { id: "d1", retention_policy: P(), collection_id: null, library_id: "l1", created_at: "2020-01-01T00:00:00Z", updated_at: null, effective_date: null, disposition_state: null }, error: null };
      if (table === "libraries") return { data: { retention_policy: null }, error: null };
      return { data: [], error: null };
    };
    await expect(recomputeRetention("d1")).rejects.toThrow(/Retention clock was NOT updated: refused/);
  });
  it("recomputeRetention throws when clearing the clock is refused", async () => {
    state.resolve = (table, ops) => {
      if (table === "documents" && argOf(ops, "update")) return { data: null, error: { message: "nope" } };
      if (table === "documents") return { data: { id: "d1", retention_policy: null, collection_id: null, library_id: "l1", created_at: "2020-01-01T00:00:00Z", updated_at: null, effective_date: null, disposition_state: null }, error: null };
      if (table === "libraries") return { data: { retention_policy: null }, error: null };
      return { data: [], error: null };
    };
    await expect(recomputeRetention("d1")).rejects.toThrow(/Retention clock was NOT cleared: nope/);
  });
  it("logEvent surfaces a refused disposition-event insert (the hold was applied; the trail was not)", async () => {
    state.resolve = (table, ops) => {
      if (table === "documents" && argOf(ops, "update")) return { data: [{ id: "d1" }], error: null };
      if (table === "documents") return { data: [{ id: "d1" }], error: null };
      if (table === "document_disposition_events") return { data: null, error: { message: "new row violates row-level security policy" } };
      return { data: [], error: null };
    };
    await expect(placeLegalHold({ scope: "document", id: "d1", orgId: "org1", matter: "M", actorId: "u1" }))
      .rejects.toThrow(/hold placed was applied but its records-management event could NOT be written/);
    expect(state.notifies).toEqual([]); // nothing announced on a broken trail
  });
  it("scanRetention names the scheduled action, skips a refused flag write and reports it", async () => {
    state.resolve = (table, ops) => {
      if (table === "documents" && argOf(ops, "update")) {
        const id = ops.find((o) => o.m === "eq" && o.args[0] === "id")?.args[1];
        return id === "bad" ? { data: null, error: { message: "refused" } } : { data: null, error: null };
      }
      if (table === "documents") return { data: [
        { id: "ok", library_id: "l1", collection_id: "c1", document_number: "P-101", retention_until: "2020-01-01", retention_policy: null, owner_user_id: null, owner_name: null },
        { id: "bad", library_id: "l1", collection_id: null, document_number: "P-102", retention_until: "2020-01-01", retention_policy: null, owner_user_id: null, owner_name: null },
      ], error: null };
      if (table === "libraries") return { data: [{ id: "l1", retention_policy: P({ action: "archive" }) }], error: null };
      if (table === "collections") return { data: [{ id: "c1", retention_policy: P({ action: "destroy" }) }], error: null };
      return { data: [], error: null };
    };
    await expect(scanRetention("org1")).rejects.toThrow(/flagged 1 record\(s\) but 1 flag write\(s\) were refused — bad: refused/);
    // The folder's "destroy" (more specific than the library's "archive") is named.
    const titles = state.notifies.map((n) => n.title as string);
    expect(titles.every((t) => t === "Retention reached: P-101 — scheduled to destroy")).toBe(true);
    expect(state.notifies.every((n) => /retention schedule calls for: destroy/.test(n.body as string))).toBe(true);
    expect(state.notifies.some((n) => /P-102/.test(n.title as string))).toBe(false);
  });
});

describe("HLD-1 (dispose gate) + RET-11 — disposeDocument", () => {
  const disposeResolver = (opts: { holds: Array<Record<string, unknown>>; policy?: RetentionPolicy | null; writes: unknown[] }) =>
    (table: string, ops: Op[]) => {
      if (table === "document_holds") return { data: opts.holds, error: null };
      if (table === "documents" && argOf(ops, "update")) { opts.writes.push(argOf(ops, "update")![0]); return { data: [{ id: "d1" }], error: null }; }
      if (table === "documents" && argOf(ops, "select")?.[0] === "legal_hold") return { data: { legal_hold: false }, error: null };
      if (table === "documents") return { data: { retention_policy: opts.policy ?? null, collection_id: null, library_id: "l1" }, error: null };
      if (table === "libraries") return { data: { retention_policy: null }, error: null };
      if (table === "document_disposition_events") { opts.writes.push({ event: argOf(ops, "insert")![0] }); return { data: null, error: null }; }
      return { data: [], error: null };
    };

  it("refuses under an open hold — nothing written, nothing logged", async () => {
    const writes: unknown[] = [];
    state.resolve = disposeResolver({ holds: [{ id: "h1", released_at: null, org_id: "org1", document_id: "d1", reason: "Client Review", opened_by: "u", opened_at: "2026-01-01" }], writes });
    const res = await disposeDocument({ documentId: "d1", orgId: "org1", actorId: "u1" });
    expect(res).toEqual({ ok: false, reason: "active_hold" });
    expect(writes).toEqual([]);
  });
  it("fails CLOSED when the hold read errors", async () => {
    state.resolve = (table) => table === "document_holds" ? { data: null, error: { message: "db down" } }
      : table === "documents" ? { data: { legal_hold: false }, error: null } : { data: [], error: null };
    await expect(disposeDocument({ documentId: "d1", orgId: "org1", actorId: "u1" })).rejects.toThrow(/db down/);
  });
  it("records the SCHEDULE's action when the caller names none", async () => {
    const writes: unknown[] = [];
    state.resolve = disposeResolver({ holds: [], policy: P({ action: "destroy" }), writes });
    const res = await disposeDocument({ documentId: "d1", orgId: "org1", actorId: "u1" });
    expect(res).toEqual({ ok: true, action: "destroy" });
    expect(writes[0]).toMatchObject({ disposition_state: "disposed", status: "Archived" });
    expect((writes[1] as { event: { detail: unknown } }).event.detail).toEqual({ action: "destroy" });
  });
  it("an explicit action still wins", async () => {
    const writes: unknown[] = [];
    state.resolve = disposeResolver({ holds: [], policy: P({ action: "destroy" }), writes });
    const res = await disposeDocument({ documentId: "d1", orgId: "org1", actorId: "u1", action: "archive" });
    expect(res).toEqual({ ok: true, action: "archive" });
  });
});

describe("DRLS-4 — the review-certification insert is checked", () => {
  it("markReviewed throws when the event insert is refused", async () => {
    state.resolve = (table, ops) => {
      if (table === "document_review_events") return { data: null, error: { message: "null value in column \"org_id\"" } };
      if (table === "documents" && argOf(ops, "update")) return { data: null, error: null };
      if (table === "documents") return { data: { id: "d1", library_id: "l1", collection_id: null, review_policy: null, last_reviewed_at: null, updated_at: null, created_at: "2026-01-01T00:00:00Z" }, error: null };
      if (table === "libraries") return { data: { review_policy: null }, error: null };
      return { data: [], error: null };
    };
    await expect(markReviewed({ orgId: null, documentId: "d1", userId: "u1" }))
      .rejects.toThrow(/certification event could NOT be written \(null value in column "org_id"\)/);
  });
});

describe("RET-3 — the recertification attests the EFFECTIVE population", () => {
  const members = [
    { uid: "admin", display_name: "Ada", email: "ada@x", role: "Admin", roles: ["Admin"] },
    { uid: "docctrl-add", display_name: "Dee", email: "dee@x", role: "Manager", roles: ["Manager", "DocCtrl"] },
    { uid: "eng", display_name: "Eng", email: "eng@x", role: "Engineer-2", roles: ["Engineer-2"] },
    { uid: "viewer", display_name: "Vic", email: "vic@x", role: "Viewer", roles: ["Viewer"] },
    { uid: "owner", display_name: "Own", email: "own@x", role: "Drafter", roles: ["Drafter"] },
    { uid: "teamie", display_name: "Tee", email: "tee@x", role: "Drafter", roles: ["Drafter"] },
  ];
  const resolver = (lib: Record<string, unknown> | null, opts: { memberError?: string; teams?: Array<{ team_id: string; uid: string }> } = {}) =>
    (table: string) => {
      if (table === "libraries") return { data: lib, error: null };
      if (table === "org_members") return opts.memberError ? { data: null, error: { message: opts.memberError } } : { data: members, error: null };
      if (table === "team_members") return { data: opts.teams ?? [], error: null };
      return { data: [], error: null };
    };
  const now = Date.parse("2026-09-23T00:00:00Z");

  it("default visibility: every active member is attested, controllers and the owner attributed", async () => {
    state.resolve = resolver({ visibility: null, acl: null, acl_index: null, owner_user_id: "owner" });
    const eff = await listAccessGrantsDetailed("org1", "l1", now);
    expect(eff.complete).toBe(true);
    expect(eff.live.map((g) => g.subjectId).sort()).toEqual(["admin", "docctrl-add", "eng", "owner", "teamie", "viewer"]);
    expect(eff.live.find((g) => g.subjectId === "docctrl-add")?.source).toBe("controller");
    expect(eff.live.find((g) => g.subjectId === "owner")?.source).toBe("owner");
    expect(eff.live.find((g) => g.subjectId === "viewer")?.via).toEqual(["default visibility (open to every active member)"]);
  });
  it("private library: controllers, the owner, and the acl_index grants expanded to people; a deny removes a member", async () => {
    const past = "2020-01-01T00:00:00Z";
    state.resolve = resolver({
      visibility: "private", owner_user_id: "owner",
      acl: { rules: [
        { effect: "allow", subject: { type: "role", id: "Engineer-2" }, actions: ["read"] },
        { effect: "allow", subject: { type: "team", id: "t1" }, actions: ["read"] },
        { effect: "allow", subject: { type: "user", id: "viewer" }, actions: ["read"], expiresAt: past }, // expired
        { effect: "deny", subject: { type: "user", id: "teamie" }, actions: ["read"] },
      ] },
      // The index still lists the expired viewer grant (nightly rebuild pending) — exactly the residual.
      acl_index: { allow: { users: { read: ["viewer"] }, roles: { read: ["Engineer-2"] }, teams: { read: ["t1"] } }, deny: { users: { read: ["teamie"] } } },
    }, { teams: [{ team_id: "t1", uid: "teamie" }] });
    const eff = await listAccessGrantsDetailed("org1", "l1", now);
    expect(eff.live.map((g) => g.subjectId).sort()).toEqual(["admin", "docctrl-add", "eng", "owner"]);
    expect(eff.live.find((g) => g.subjectId === "eng")?.via).toEqual(["role rule: Engineer-2"]);
    expect(eff.expired).toHaveLength(1);
    expect(eff.expired[0]).toMatchObject({ subjectId: "viewer", status: "expired", expiresAt: past });
    // The plain list is the live list — an expired grant is never counted as current.
    expect((await listAccessGrants("org1", "l1")).map((g) => g.subjectId)).not.toContain("viewer");
  });
  it("an unresolvable population refuses to attest", async () => {
    state.resolve = resolver({ visibility: null, acl: null, acl_index: null, owner_user_id: null }, { memberError: "timeout" });
    const eff = await listAccessGrantsDetailed("org1", "l1", now);
    expect(eff.complete).toBe(false);
    expect(eff.issues).toEqual(["members: timeout"]);
    await expect(recertifyAccess({ libraryId: "l1", orgId: "org1", actorId: "admin" }))
      .rejects.toThrow(/Recertification refused: the library's effective access list could not be resolved \(members: timeout\)/);
  });
});
