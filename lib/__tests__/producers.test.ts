// notifications Round G — N8 PRODUCERS-FREE: the census holes whose files no
// other fleet owns (PROD-2, PROD-14, PROD-3, PROD-5, PROD-6, PROD-11,
// projects-tab MON-11) — each producer driven end to end over the in-memory
// PostgREST (helpers/fakeSupabase), the dispatcher's emit() captured so the
// audience, kind and channels each producer hands it are pinned. Where the
// audience is resolved by the real dispatcher (a role pool, a project's
// members), the real resolveRecipients runs over the same fake.
//
// REGRESSION FIRST: every flow these producers sit behind still returns what
// it returned (the branch resolves, the markup request is recorded, the
// change order is proposed / decided, the turnover item is rejected, the
// milestone moves), and a notice that cannot be sent never fails the write.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { newFakeDb, makeFakeSupabase, type FakeDb } from "./helpers/fakeSupabase";

const s = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  emits: [] as Array<Record<string, unknown>>,
  emitThrows: false,
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcError: null as { code?: string; message: string } | null,
  rpcData: 0 as unknown,
  /** A read that fails: (table, selected columns) → true for the one to refuse. */
  failRead: null as ((table: string, cols: string) => boolean) | null,
}));

/** A select whose answer is an error (the chain ends in maybeSingle / then). */
function failingRead(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ["eq", "in", "is", "order", "limit", "range"]) chain[m] = () => chain;
  const res = { data: null, error: { message: "read failed" } };
  chain.maybeSingle = () => Promise.resolve(res);
  chain.single = () => Promise.resolve(res);
  chain.then = (ok: (v: unknown) => unknown) => Promise.resolve(res).then(ok);
  return chain;
}

function fakeClient() {
  const base = makeFakeSupabase(s.db);
  return {
    ...base,
    from: (t: string) => {
      const b = base.from(t) as unknown as Record<string, unknown>;
      if (!s.failRead) return b;
      return new Proxy(b, {
        get(target, prop: string) {
          if (prop !== "select") return target[prop];
          return (cols: string, o?: unknown) =>
            (s.failRead!(t, cols) ? failingRead() : (target.select as (c: string, o?: unknown) => unknown)(cols, o));
        },
      });
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      s.rpc.push({ fn, args });
      return s.rpcError ? { data: null, error: s.rpcError } : { data: s.rpcData, error: null };
    },
  };
}

vi.mock("@/lib/supabase", () => ({ get supabase() { return fakeClient(); } }));
vi.mock("@/lib/notify/dispatch", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emit: vi.fn(async (p: Record<string, unknown>) => {
    if (s.emitThrows) throw new Error("dispatch down");
    s.emits.push(p);
  }),
}));
vi.mock("@/lib/audit", () => ({
  logAuditAction: vi.fn(async () => ({ error: null })),
  logMilestoneEvent: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/lib/projects", () => ({ writeActivity: vi.fn(async () => undefined) }));
vi.mock("@/lib/activityThread", () => ({ postMarkupRef: vi.fn(async () => undefined) }));

import { resolveBranch, clearBranchOpenAlerts } from "@/lib/branches";
import { createMarkupRequest, resolveMarkupRequest } from "@/lib/markupRequests";
import { notifyLibraryDocsAdded } from "@/lib/libraryNotify";
import { proposeChangeOrder, decideChangeOrder, CO_REASON_LABEL, coNoticeMoney, type ChangeOrder } from "@/lib/changeOrders";
import { reviewTurnoverItem, type TurnoverItem } from "@/lib/turnover";
import {
  setMilestoneStatus, applyMilestoneMoves, updateMilestone, rebaseSchedule, slippedPastBaseline, scheduleDateLabel,
} from "@/lib/milestones";
import { resolveRecipients, type EmitInput } from "@/lib/notify/dispatch";
import { postMarkupRef } from "@/lib/activityThread";
import { notifyBatchChecked, notifyBatchWithReason } from "@/lib/inAppNotifications";
import { fmtMoney } from "@/lib/costs";

const ORG = "o1";
const member = (uid: string, roles: string[], status = "active") => ({ id: `m-${uid}`, org_id: ORG, uid, role: roles[0], roles, status, email: `${uid}@acme.test` });

beforeEach(() => {
  s.db = newFakeDb();
  s.emits = [];
  s.emitThrows = false;
  s.rpc = [];
  s.rpcError = null;
  s.rpcData = 0;
  s.failRead = null;
  s.db.tables.org_members = [
    member("brancher", ["Engineer"]),
    member("dc1", ["DocCtrl"]),
    member("dc2", ["Manager", "DocCtrl"]),            // DocCtrl held additively
    member("dc-gone", ["DocCtrl"], "suspended"),
    member("owner", ["Manager"]),
    member("pm", ["Engineer"]),
    member("proposer", ["Engineer"]),
    member("decider", ["Admin"]),
  ];
  s.db.tables.projects = [{ id: "p1", org_id: ORG, owner_user_id: "owner" }];
  s.db.tables.project_members = [
    { project_id: "p1", user_id: "pm" }, { project_id: "p1", user_id: "proposer" }, { project_id: "p1", user_id: "owner" },
  ];
});

const emitsOf = (kind: string) => s.emits.filter((e) => e.kind === kind);
/** The schedule's notices run behind the write (N8's review fix): let them
 *  finish before reading what they emitted. */
const flushNotices = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

// ── PROD-3 ───────────────────────────────────────────────────────────────────
describe("PROD-3 — resolving a branch reaches the DocCtrl pool branch_open alerted, and clears its alerts", () => {
  beforeEach(() => {
    s.db.tables.revision_branches = [{
      id: "b1", org_id: ORG, document_id: "d1", branch_version_id: "v2", reason: "stale base", created_by: "brancher", resolved_at: null,
    }];
  });

  it("dw1: branch_resolved's audience mirrors announceBranchOpened — the brancher AND roles ['DocCtrl']", async () => {
    await resolveBranch({ branchId: "b1", resolution: "withdrawn", note: "abandoned the work", orgId: ORG, actorUserId: "dc1", actorName: "DC One" });
    const [e] = emitsOf("branch_resolved");
    expect(e.audience).toEqual({ involved: ["brancher"], roles: ["DocCtrl"] });
    expect(e.metadata).toEqual({ branchId: "b1" });
    // REGRESSION: the branch is resolved, as before
    expect(s.db.tables.revision_branches[0]).toMatchObject({ resolution: "withdrawn", resolved_by: "dc1" });
  });

  it("dw1: the brancher resolving their own branch still tells the pool (the dispatcher drops only the actor) — active DocCtrls only", async () => {
    await resolveBranch({ branchId: "b1", resolution: "withdrawn", note: "abandoned the work", orgId: ORG, actorUserId: "brancher", actorName: "B" });
    const recipients = await resolveRecipients(emitsOf("branch_resolved")[0] as unknown as EmitInput);
    expect(recipients.sort()).toEqual(["dc1", "dc2"]); // the suspended DocCtrl and the actor are out
  });

  it("dw2: resolving asks the database to mark the branch's branch_open rows read (clear_resolved_branch_alerts, the branch id)", async () => {
    s.rpcData = 2;
    await resolveBranch({ branchId: "b1", resolution: "withdrawn", note: "abandoned the work", orgId: ORG, actorUserId: "dc1", actorName: "DC One" });
    expect(s.rpc).toEqual([{ fn: "clear_resolved_branch_alerts", args: { p_branch: "b1" } }]);
    expect(await clearBranchOpenAlerts("b1")).toBe(2);
  });

  it("before 20261181 is pasted (PGRST202 / 42883) the resolution still succeeds and the miss is logged — today's path", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      s.rpcError = { code: "PGRST202", message: "Could not find the function public.clear_resolved_branch_alerts" };
      await expect(resolveBranch({ branchId: "b1", resolution: "withdrawn", note: "abandoned the work", orgId: ORG, actorUserId: "dc1", actorName: "DC One" })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not deployed \(paste 20261181\)/));
      s.rpcError = { code: "42883", message: "function clear_resolved_branch_alerts(uuid) does not exist" };
      expect(await clearBranchOpenAlerts("b1")).toBeNull();
    } finally { warn.mockRestore(); }
  });

  it("a notice that cannot be sent never fails the resolution", async () => {
    s.emitThrows = true;
    await expect(resolveBranch({ branchId: "b1", resolution: "withdrawn", note: "abandoned the work", orgId: ORG, actorUserId: "dc1", actorName: "DC One" })).resolves.toBeUndefined();
    expect(s.rpc).toHaveLength(1);
  });
});

// ── PROD-14 ──────────────────────────────────────────────────────────────────
describe("PROD-14 — a markup request notifies the person asked, and its answer the other side", () => {
  it("dw1/dw2: createMarkupRequest WITHOUT a project emits markup_request (category 'assignment') to requestedFromUserId", async () => {
    const mr = await createMarkupRequest({
      orgId: ORG, documentId: "d1", requestedFromUserId: "holder", message: "Can I see your redlines?", actorUserId: "asker", actorEmail: "asker@acme.test",
    });
    expect(s.db.tables.markup_requests).toHaveLength(1);              // REGRESSION: recorded
    const [e] = emitsOf("markup_request");
    expect(e).toMatchObject({
      category: "assignment", actorUserId: "asker", audience: { involved: ["holder"] },
      resource: { type: "document", id: "d1" }, link: "/inbox", body: "Can I see your redlines?",
    });
    expect(e.metadata).toEqual({ markupRequestId: mr.id, requestStatus: "open" });
    // never a workflow row the hook's ticket reconcile would retire (metadata.status + metadata.action)
    expect(e.metadata).not.toHaveProperty("status");
  });

  it("a failed notice never fails the request", async () => {
    s.emitThrows = true;
    await expect(createMarkupRequest({ orgId: ORG, documentId: "d1", requestedFromUserId: "holder", message: "redlines?", actorUserId: "asker" })).resolves.toBeTruthy();
  });

  it("dw3: sharing / declining notifies the requester; cancelling notifies the person asked (the actor is the dispatcher's to drop)", async () => {
    s.db.tables.documents = [{ id: "d1", org_id: ORG, library_id: "lib1" }];
    s.db.tables.markup_requests = [{ id: "mr1", org_id: ORG, document_id: "d1", requested_by_user_id: "asker", requested_from_user_id: "holder", status: "open" }];
    await resolveMarkupRequest({ markupRequestId: "mr1", status: "declined", response: "busy", orgId: ORG, actorUserId: "holder", actorEmail: "holder@acme.test" });
    const [e] = emitsOf("markup_request");
    expect(e).toMatchObject({ category: "status", actorUserId: "holder", link: "/documents/lib1?doc=d1", body: "busy" });
    expect(e.title).toBe("holder@acme.test declined your markup request");
    expect((e.audience as { involved: string[] }).involved).toEqual(["asker", "holder"]);
    const recipients = await resolveRecipients({ ...(e as unknown as EmitInput), audience: { involved: ["asker", "holder"] } });
    expect(recipients).toEqual([]);   // neither is an org member in this fake: the active-member filter
  });

  it("a share: the thread's markup_ref notice leaves the requester out (notifyExclude) — they get the resolution notice, in the right words, once (N8's review fix)", async () => {
    vi.mocked(postMarkupRef).mockClear();
    s.db.tables.documents = [{ id: "d1", org_id: ORG, library_id: "lib1" }];
    s.db.tables.markup_requests = [{ id: "mr1", org_id: ORG, document_id: "d1", requested_by_user_id: "asker", requested_from_user_id: "holder", status: "open" }];
    await resolveMarkupRequest({ markupRequestId: "mr1", status: "shared", orgId: ORG, actorUserId: "holder", actorEmail: "holder@acme.test" });
    expect(vi.mocked(postMarkupRef)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(postMarkupRef).mock.calls[0][0]).toMatchObject({ documentId: "d1", userId: "holder", notifyExclude: ["asker"] });
    const [e] = emitsOf("markup_request");
    expect(e.title).toBe("holder@acme.test shared their markups");
    expect((e.audience as { involved: string[] }).involved).toContain("asker");
  });
});

// ── PROD-5 ───────────────────────────────────────────────────────────────────
describe("PROD-5 — one helper for every library insert path: library_doc_added to the library's followers, in-app", () => {
  it("emits the staged-upload path's notice verbatim, with channels ['inapp'] (PROD-7 dw3)", async () => {
    await notifyLibraryDocsAdded({ orgId: ORG, libraryId: "lib1", count: 200, firstLabel: "P-101", actorUserId: "dc1", actorName: "dc1@acme.test" });
    expect(s.emits).toEqual([{
      orgId: ORG, category: "watched", kind: "library_doc_added",
      title: "200 new documents added",
      body: "dc1@acme.test added 200 documents to a library you subscribe to.",
      link: "/documents/lib1", resource: { type: "library", id: "lib1" },
      actorUserId: "dc1", actorName: "dc1@acme.test", audience: { followers: true }, channels: ["inapp"],
    }]);
  });

  it("one document: 'New document: <number>'; no count, no org, no library or no actor: nobody is told; a dispatch failure is swallowed", async () => {
    await notifyLibraryDocsAdded({ orgId: ORG, libraryId: "lib1", count: 1, firstLabel: "P-101", actorUserId: "dc1" });
    expect(s.emits[0]).toMatchObject({ title: "New document: P-101", body: "Someone added P-101 to a library you subscribe to." });
    s.emits = [];
    for (const bad of [{ count: 0 }, { orgId: null }, { libraryId: undefined }, { actorUserId: null }]) {
      await notifyLibraryDocsAdded({ orgId: ORG, libraryId: "lib1", count: 3, firstLabel: "x", actorUserId: "dc1", ...bad });
    }
    expect(s.emits).toEqual([]);
    s.emitThrows = true;
    await expect(notifyLibraryDocsAdded({ orgId: ORG, libraryId: "lib1", count: 1, firstLabel: "x", actorUserId: "dc1" })).resolves.toBeUndefined();
  });
});

// ── PROD-6 ───────────────────────────────────────────────────────────────────
describe("PROD-6 dw1 — a change order proposed / approved / rejected reaches the project's members and its owner", () => {
  const coRow = (over: Record<string, unknown> = {}) => ({
    id: "co1", org_id: ORG, project_id: "p1", cost_account_id: "a1", party_id: null, co_number: "CO-001", title: "Extra pipe",
    description: null, amount: 500, reason_code: "field_condition", status: "proposed", created_by: "proposer", created_by_name: "proposer", ...over,
  });
  const asCo = (r: Record<string, unknown>): ChangeOrder => ({
    id: String(r.id), orgId: ORG, projectId: "p1", costAccountId: (r.cost_account_id as string) ?? null, partyId: null, coNumber: String(r.co_number),
    title: String(r.title), description: null, amount: Number(r.amount), reasonCode: "field_condition", status: "proposed",
    decidedAt: null, decidedBy: null, decidedByName: null, decisionNote: null, createdBy: "proposer", createdByName: "proposer",
    createdAt: null, postedEntryId: null, selfDecided: false,
  });

  it("proposing: change_order_status to every project member and the owner — never the proposer themself", async () => {
    const co = await proposeChangeOrder({ orgId: ORG, projectId: "p1", title: "Extra pipe", amount: 500, reasonCode: "field_condition", actorId: "proposer", actorName: "proposer" });
    expect(co.coNumber).toBe("CO-001");                                  // REGRESSION: proposed
    const [e] = emitsOf("change_order_status");
    expect(e).toMatchObject({ category: "status", actorUserId: "proposer", link: "/projects/p1?tab=costs", resource: { type: "project", id: "p1" } });
    expect((e.audience as { involved: string[] }).involved.sort()).toEqual(["owner", "pm"]);
    expect((e.metadata as { event: string }).event).toBe("proposed");
  });

  it("rejecting: the proposer hears it here, with the members and the owner; the decider does not", async () => {
    s.db.tables.change_orders = [coRow()];
    await decideChangeOrder({ co: asCo(coRow()), decision: "rejected", shownAmount: 500, shownAccountId: "a1", note: "not in scope", actorId: "decider", actorName: "decider" });
    const [e] = emitsOf("change_order_status");
    expect((e.audience as { involved: string[] }).involved.sort()).toEqual(["owner", "pm", "proposer"]);
    expect(e.body).toBe(`decider rejected the change order for ${coNoticeMoney(500, "USD")}: "not in scope"`);   // no line currency on file: USD
    expect(emitsOf("project_status")).toEqual([]);                       // no approval notice on a rejection
  });

  it("approving: the proposer keeps their own approval notice (MON-11, unchanged); the members and the owner get change_order_status — the proposer not twice", async () => {
    s.db.tables.change_orders = [coRow()];
    s.db.tables.cost_accounts = [{ id: "a1", org_id: ORG, project_id: "p1", budget: 1000, currency: "USD" }];
    const out = await decideChangeOrder({ co: asCo(coRow()), decision: "approved", shownAmount: 500, shownAccountId: "a1", actorId: "decider", actorName: "decider" });
    expect(out).toBeTruthy();
    const approval = emitsOf("project_status");
    expect(approval).toHaveLength(1);
    expect(approval[0]).toMatchObject({ audience: { involved: ["proposer"] }, title: "CO-001 approved — Extra pipe" });
    const [e] = emitsOf("change_order_status");
    expect((e.audience as { involved: string[] }).involved.sort()).toEqual(["owner", "pm"]);
  });

  it("the amount carries its budget line's currency — a CAD line never reads as dollars — and is the EXACT figure posted, never rounded to whole units at 10,000 and over (N8's review fixes); the proposer's own approval notice too", async () => {
    const AMT = 12345.67;
    s.db.tables.change_orders = [coRow({ amount: AMT })];
    s.db.tables.cost_accounts = [{ id: "a1", org_id: ORG, project_id: "p1", budget: 100000, currency: "cad" }];
    await proposeChangeOrder({ orgId: ORG, projectId: "p1", costAccountId: "a1", title: "Extra pipe", amount: AMT, reasonCode: "field_condition", actorId: "proposer", actorName: "proposer" });
    const exact = coNoticeMoney(AMT, "CAD");
    expect(exact).toBe(new Intl.NumberFormat(undefined, { style: "currency", currency: "CAD" }).format(AMT));
    expect(exact).toContain("12,345.67");
    expect(exact).not.toBe(fmtMoney(AMT, "CAD"));                          // the tab's column rounds it to 12,346
    expect(exact).not.toBe(coNoticeMoney(AMT, "USD"));
    const [proposed] = emitsOf("change_order_status");
    expect(proposed.body).toBe(`proposer proposed a change order for ${exact} (${CO_REASON_LABEL.field_condition}). It waits for a decision on the Costs tab.`);
    s.emits = [];
    await decideChangeOrder({ co: asCo(coRow({ amount: AMT })), decision: "approved", shownAmount: AMT, shownAccountId: "a1", actorId: "decider", actorName: "decider" });
    expect(String(emitsOf("change_order_status")[0].body)).toContain(exact);
    expect(emitsOf("project_status")[0].body).toBe(`Your change order for ${exact} was approved and posted to the budget line.`);
    expect(coNoticeMoney(Number.NaN)).toBe("—");
  });

  it("the budget line's control account manager (cost_accounts.cam_user_id), when it names one, hears every change-order event too — once; unset, nothing changes (N8's review fix)", async () => {
    s.db.tables.org_members.push(member("cam", ["Engineer"]), member("cam-gone", ["Engineer"], "suspended"));
    s.db.tables.cost_accounts = [{ id: "a1", org_id: ORG, project_id: "p1", budget: 1000, currency: "USD", cam_user_id: "cam" }];
    await proposeChangeOrder({ orgId: ORG, projectId: "p1", costAccountId: "a1", title: "Extra pipe", amount: 500, reasonCode: "field_condition", actorId: "proposer", actorName: "proposer" });
    const [proposed] = emitsOf("change_order_status");
    expect((proposed.audience as { involved: string[] }).involved.sort()).toEqual(["cam", "owner", "pm"]);
    s.emits = [];
    s.db.tables.change_orders = [coRow()];
    await decideChangeOrder({ co: asCo(coRow()), decision: "rejected", shownAmount: 500, shownAccountId: "a1", note: "no", actorId: "decider", actorName: "decider" });
    expect((emitsOf("change_order_status")[0].audience as { involved: string[] }).involved.sort()).toEqual(["cam", "owner", "pm", "proposer"]);
    // the CAM deciding is not told about their own act; a CAM who is also a member is told once
    s.emits = [];
    s.db.tables.change_orders = [coRow()];
    await decideChangeOrder({ co: asCo(coRow()), decision: "rejected", shownAmount: 500, shownAccountId: "a1", note: "no", actorId: "cam", actorName: "cam" });
    expect((emitsOf("change_order_status")[0].audience as { involved: string[] }).involved.sort()).toEqual(["owner", "pm", "proposer"]);
    // a suspended CAM is named in the audience but the dispatcher keeps active members only
    s.emits = [];
    s.db.tables.cost_accounts[0].cam_user_id = "cam-gone";
    s.db.tables.change_orders = [coRow()];
    await decideChangeOrder({ co: asCo(coRow()), decision: "rejected", shownAmount: 500, shownAccountId: "a1", note: "no", actorId: "decider", actorName: "decider" });
    expect((await resolveRecipients(emitsOf("change_order_status")[0] as unknown as EmitInput)).sort()).toEqual(["owner", "pm", "proposer"]);
  });

  it("voiding stays silent (DEC-44 (N8) item 2)", async () => {
    s.db.tables.change_orders = [coRow()];
    await decideChangeOrder({ co: asCo(coRow()), decision: "void", shownAmount: 500, shownAccountId: "a1", actorId: "decider", actorName: "decider" });
    expect(s.emits).toEqual([]);
  });

  it("a failed notice never fails the proposal", async () => {
    s.emitThrows = true;
    await expect(proposeChangeOrder({ orgId: ORG, projectId: "p1", title: "Extra pipe", amount: 500, reasonCode: "field_condition", actorId: "proposer" })).resolves.toMatchObject({ coNumber: "CO-001" });
  });
});

// ── projects-tab MON-11 dw3 ──────────────────────────────────────────────────
describe("MON-11 dw3 — a turnover rejection notifies whoever is responsible for the item on our side", () => {
  const item: TurnoverItem = {
    id: "t1", orgId: ORG, projectId: "p1", partyId: null, name: "Weld map & weld log", description: null, required: true,
    status: "received", documentId: null, reviewedAt: null, reviewedByName: null, reviewNote: null, createdAt: null, createdBy: "pm",
  };
  beforeEach(() => { s.db.tables.turnover_items = [{ id: "t1", org_id: ORG, project_id: "p1", status: "received", created_by: "pm" }]; });

  it("rejected: project_status to the item's creator and the project owner, the reviewer dropped by the dispatcher", async () => {
    const res = await reviewTurnoverItem({ item, status: "rejected", note: "missing weld numbers on sheet 3", actor: { uid: "decider", email: "qa@acme.test" } });
    expect(res.ok).toBe(true);                                              // REGRESSION: the decision stands
    expect(s.db.tables.turnover_items[0].status).toBe("rejected");
    const [e] = s.emits;
    expect(e).toMatchObject({
      kind: "project_status", category: "status", actorUserId: "decider", link: "/projects/p1?tab=quality",
      title: "Turnover item rejected — Weld map & weld log", audience: { involved: ["pm", "owner"] },
    });
    expect(e.body).toContain('"missing weld numbers on sheet 3"');
  });

  it("received (no decision) notifies nobody; a failed notice never fails the rejection", async () => {
    expect((await reviewTurnoverItem({ item: { ...item, status: "open" }, status: "received", actor: { uid: "decider", email: null } })).ok).toBe(true);
    expect(s.emits).toEqual([]);
    s.emitThrows = true;
    expect((await reviewTurnoverItem({ item, status: "rejected", note: "missing weld numbers on sheet 3", actor: { uid: "decider", email: null } })).ok).toBe(true);
  });
});

// ── PROD-11 ──────────────────────────────────────────────────────────────────
describe("PROD-11 — the schedule speaks: status and moves to the project, a new assignee, a slip past baseline to the owner", () => {
  const ms = (over: Record<string, unknown> = {}) => ({
    id: "m1", org_id: ORG, project_id: "p1", document_id: null, parent_id: null, name: "Mechanical completion", weight: 1,
    planned_at: "2026-11-01T00:00:00Z", planned_start_at: "2026-10-25T00:00:00Z", status: "planned", source: "manual",
    updated_at: "2026-10-01T00:00:00Z", baseline_finish_at: "2026-11-05T00:00:00Z", responsible_user_id: null, ...over,
  });

  it("slippedPastBaseline: later than the baseline AND later than before; an earlier or within-baseline move is no slip", () => {
    expect(slippedPastBaseline("2026-11-01", "2026-11-10", "2026-11-05")).toBe(true);
    expect(slippedPastBaseline("2026-11-08", "2026-11-10", "2026-11-05")).toBe(true);   // already late, later still
    expect(slippedPastBaseline("2026-11-10", "2026-11-08", "2026-11-05")).toBe(false);  // pulled in
    expect(slippedPastBaseline("2026-11-01", "2026-11-04", "2026-11-05")).toBe(false);  // inside the baseline
    expect(slippedPastBaseline("2026-11-01", "2026-11-10", null)).toBe(false);          // no baseline
  });

  afterEach(flushNotices);   // nothing a test started lands in the next one

  it("dw1: setMilestoneStatus emits to audience { projectId } — the dispatcher branch nothing took — in-app only", async () => {
    s.db.tables.milestones = [ms()];
    const m = await setMilestoneStatus({ id: "m1", status: "blocked", statusReason: "waiting on parts", actorUserId: "pm", actorUserName: "pm" });
    expect(m.status).toBe("blocked");                                        // REGRESSION
    await flushNotices();
    const [e] = s.emits;
    expect(e).toMatchObject({
      kind: "project_status", audience: { projectId: "p1" }, channels: ["inapp"], actorUserId: "pm",
      link: "/projects/p1?tab=schedule", title: "Task blocked: Mechanical completion",
    });
    // the project's members resolve through the dispatcher — the actor out
    expect((await resolveRecipients(e as unknown as EmitInput)).sort()).toEqual(["owner", "proposer"]);
  });

  it("dw1 + dw3: one batch of moves → ONE notice to the project, and ONE to the owner listing the tasks it pushed past their baseline", async () => {
    s.db.tables.milestones = [
      ms({ id: "m1", name: "A" }),
      ms({ id: "m2", name: "B", planned_at: "2026-11-02T00:00:00Z" }),
      ms({ id: "m3", name: "C", baseline_finish_at: null }),
    ];
    // the RPC (20261098) answers which rows moved
    s.rpcData = { matched: ["m1", "m2", "m3"], unmatched: [], count: 3 };
    await applyMilestoneMoves({
      orgId: ORG, projectId: "p1", actorUserId: "pm", actorUserName: "pm",
      moves: [
        { id: "m1", plannedStartAt: "2026-11-03T00:00:00Z", plannedAt: "2026-11-09T00:00:00Z" },   // past its baseline
        { id: "m2", plannedStartAt: "2026-10-27T00:00:00Z", plannedAt: "2026-11-04T00:00:00Z" },   // still inside
        { id: "m3", plannedStartAt: "2026-11-03T00:00:00Z", plannedAt: "2026-11-20T00:00:00Z" },   // no baseline
      ],
    });
    expect(s.rpc[0].fn).toBe("apply_milestone_moves");
    await flushNotices();
    const moved = s.emits.filter((e) => e.kind === "project_status");
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ title: "3 tasks rescheduled", audience: { projectId: "p1" }, channels: ["inapp"] });
    const slips = emitsOf("milestone_slipped");
    expect(slips).toHaveLength(1);
    expect(slips[0]).toMatchObject({ audience: { involved: ["owner"] }, title: "A task slipped past its baseline: A", category: "status" });
    expect(slips[0].channels).toBeUndefined();                              // the owner's slip notice is bell + email
  });

  it("dw2: a NEW responsible person gets milestone_assigned (bell + email); the same person again, or a clear, notifies nobody", async () => {
    s.db.tables.milestones = [ms()];
    await updateMilestone({ id: "m1", patch: { responsibleUserId: "proposer", responsibleUserName: "proposer" }, updatedBy: "pm", updatedByName: "pm" });
    await flushNotices();
    const [e] = emitsOf("milestone_assigned");
    expect(e).toMatchObject({ category: "assignment", audience: { involved: ["proposer"] }, actorUserId: "pm", link: "/projects/p1?tab=schedule" });
    expect(e.title).toBe("You're responsible for “Mechanical completion”");
    s.emits = [];
    await updateMilestone({ id: "m1", patch: { responsibleUserId: "proposer" }, updatedBy: "pm" });
    await updateMilestone({ id: "m1", patch: { responsibleUserId: null }, updatedBy: "pm" });
    await flushNotices();
    expect(emitsOf("milestone_assigned")).toEqual([]);
  });

  it("the assignment's finish date is the BOARD's day (schedule time, wall-clock-as-UTC), in a form no locale misreads — whatever zone the assigner's browser is in (N8's review fix: blocker)", async () => {
    const tz = process.env.TZ;
    try {
      for (const zone of ["America/Los_Angeles", "Asia/Tokyo", "UTC"]) {
        process.env.TZ = zone;
        // a date-only finish (fromWallClock(date, null)) and a 17:00 finish — both 7 October on the board
        for (const finish of ["2026-10-07T00:00:00.000Z", "2026-10-07T17:00:00.000Z"]) {
          s.emits = [];
          s.db.tables.milestones = [ms({ planned_at: finish, responsible_user_id: null })];
          await updateMilestone({ id: "m1", patch: { responsibleUserId: "proposer" }, updatedBy: "pm", updatedByName: "pm" });
          await flushNotices();
          const [e] = emitsOf("milestone_assigned");
          expect(e.body, `${zone} ${finish}`).toBe("pm made you responsible for this task (finish 7 Oct 2026).");
        }
      }
      // the label itself: schedule time, every month, nothing for an instant that does not read
      process.env.TZ = "America/Los_Angeles";
      expect(scheduleDateLabel("2026-10-07T00:00:00Z")).toBe("7 Oct 2026");
      expect(scheduleDateLabel("2026-01-31T23:59:00Z")).toBe("31 Jan 2026");
      expect(scheduleDateLabel("2026-12-01T00:00:00Z")).toBe("1 Dec 2026");
      expect(scheduleDateLabel(null)).toBe("");
      expect(scheduleDateLabel("not a date")).toBe("");
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
  });

  it("a reschedule note carries the board's day too, in every zone (the same local-parse mistake, fixed with the same helper)", async () => {
    const tz = process.env.TZ;
    try {
      for (const zone of ["America/Los_Angeles", "Asia/Tokyo"]) {
        process.env.TZ = zone;
        s.db.tables.milestones = [ms({ planned_at: "2026-11-01T00:00:00Z" })];
        s.db.tables.milestone_notes = [];
        // a single edit
        await updateMilestone({ id: "m1", patch: { plannedAt: "2026-11-04T00:00:00Z" }, updatedBy: "pm", updatedByName: "pm" });
        // a batch of moves (the RPC answers which rows moved)
        s.rpcData = { matched: ["m1"], unmatched: [], count: 1 };
        s.db.tables.milestones[0].planned_at = "2026-11-04T00:00:00Z";
        await applyMilestoneMoves({
          orgId: ORG, projectId: "p1", actorUserId: "pm", actorUserName: "pm",
          moves: [{ id: "m1", plannedStartAt: "2026-10-30T00:00:00Z", plannedAt: "2026-11-07T00:00:00Z" }],
        });
        await flushNotices();
        expect(s.db.tables.milestone_notes.map((n) => n.body), zone).toEqual(["Finish +3 days → 4 Nov 2026", "Finish +3 days → 7 Nov 2026"]);
      }
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
  });

  it("when who was responsible cannot be read, nobody is told — a re-save of the same person is never a new assignment (N8's review fix); the edit stands", async () => {
    s.db.tables.milestones = [ms({ responsible_user_id: "proposer" })];
    s.failRead = (t, cols) => t === "milestones" && cols === "responsible_user_id";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const m = await updateMilestone({ id: "m1", patch: { responsibleUserId: "proposer" }, updatedBy: "pm", updatedByName: "pm" });
      expect(m.responsibleUserId).toBe("proposer");                         // REGRESSION: the save went through
      await flushNotices();
      expect(emitsOf("milestone_assigned")).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/who was responsible could not be read — no assignment notice: read failed/));
    } finally { warn.mockRestore(); }
  });

  it("the schedule does not WAIT for its notices (N8's review fix): the mutation returns before the notice's reads and inserts run", async () => {
    s.db.tables.milestones = [ms()];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { emit } = await import("@/lib/notify/dispatch");
    vi.mocked(emit).mockImplementationOnce(async (p: unknown) => { await gate; s.emits.push(p as Record<string, unknown>); });
    const m = await setMilestoneStatus({ id: "m1", status: "completed", actorUserId: "pm", actorUserName: "pm" });
    expect(m.status).toBe("completed");                                      // returned while the notice is still held
    expect(s.emits).toEqual([]);
    release();
    await flushNotices();
    expect(s.emits.map((e) => e.title)).toEqual(["Task completed: Mechanical completion"]);
  });

  it("the assignee learns WHO made them responsible when the caller passes only a uid (the task panel does): the actor's display name, else email, from org_members (N8's review fix)", async () => {
    s.db.tables.milestones = [ms()];
    // TaskDetailPanel.assign's call: updatedBy alone
    await updateMilestone({ id: "m1", patch: { responsibleUserId: "proposer", responsibleUserName: "proposer" }, updatedBy: "pm" });
    await flushNotices();
    const [byEmail] = emitsOf("milestone_assigned");
    expect(byEmail.body).toMatch(/^pm@acme\.test made you responsible for this task/);
    expect(byEmail.actorName).toBe("pm@acme.test");
    s.emits = [];
    s.db.tables.org_members.find((m) => m.uid === "pm")!.display_name = "Pat Morgan";
    await updateMilestone({ id: "m1", patch: { responsibleUserId: "owner" }, updatedBy: "pm" });
    await flushNotices();
    expect(emitsOf("milestone_assigned")[0].body).toMatch(/^Pat Morgan made you responsible/);
    s.emits = [];
    // a passed name wins; an actor nobody knows is "Someone", never a failure
    await updateMilestone({ id: "m1", patch: { responsibleUserId: "proposer" }, updatedBy: "pm", updatedByName: "PM (passed)" });
    await flushNotices();
    expect(emitsOf("milestone_assigned")[0].body).toMatch(/^PM \(passed\) made you responsible/);
    s.emits = [];
    await updateMilestone({ id: "m1", patch: { responsibleUserId: "owner" }, updatedBy: "stranger" });
    await flushNotices();
    expect(emitsOf("milestone_assigned")[0].body).toMatch(/^Someone made you responsible/);
  });

  it("dw3: a single edit that pushes a baselined task past its baseline tells the owner once", async () => {
    s.db.tables.milestones = [ms()];
    await updateMilestone({ id: "m1", patch: { plannedAt: "2026-11-12T00:00:00Z" }, updatedBy: "pm", updatedByName: "pm" });
    await flushNotices();
    expect(emitsOf("milestone_slipped")).toHaveLength(1);
    s.emits = [];
    await updateMilestone({ id: "m1", patch: { plannedAt: "2026-11-02T00:00:00Z" }, updatedBy: "pm" });   // pulled back in
    await flushNotices();
    expect(emitsOf("milestone_slipped")).toEqual([]);
  });

  it("dw3: a rebase notifies the project once and the owner once, however many tasks it pushed past their baselines", async () => {
    s.db.tables.milestones = [
      ms({ id: "m1", name: "A" }), ms({ id: "m2", name: "B" }), ms({ id: "m3", name: "C", baseline_finish_at: null }),
    ];
    const res = await rebaseSchedule({ orgId: ORG, projectId: "p1", newStartIso: "2026-11-08T00:00:00Z", actorUserId: "pm", actorUserName: "pm" });
    expect(res.shiftedCount).toBe(3);                                        // REGRESSION
    await flushNotices();
    expect(s.emits.filter((e) => e.kind === "project_status")).toHaveLength(1);
    const slips = emitsOf("milestone_slipped");
    expect(slips).toHaveLength(1);
    expect(slips[0].title).toBe("2 tasks slipped past their baseline");
  });

  it("the owner moving their own schedule is not told about it (the dispatcher drops the actor); no owner, no slip notice", async () => {
    s.db.tables.milestones = [ms()];
    await updateMilestone({ id: "m1", patch: { plannedAt: "2026-11-12T00:00:00Z" }, updatedBy: "owner" });
    await flushNotices();
    const [slip] = emitsOf("milestone_slipped");
    expect(await resolveRecipients(slip as unknown as EmitInput)).toEqual([]);
    s.emits = [];
    s.db.tables.projects = [{ id: "p1", org_id: ORG, owner_user_id: null }];
    await updateMilestone({ id: "m1", patch: { plannedAt: "2026-11-14T00:00:00Z" }, updatedBy: "pm" });
    await flushNotices();
    expect(emitsOf("milestone_slipped")).toEqual([]);
  });

  it("a failed notice never fails the schedule change", async () => {
    s.db.tables.milestones = [ms()];
    s.emitThrows = true;
    await expect(setMilestoneStatus({ id: "m1", status: "completed", actorUserId: "pm" })).resolves.toMatchObject({ status: "completed" });
  });
});

// ── TAX-11 — the typed batch insert the checkout sweep writes through ───────
describe("TAX-11 (N8's review fix) — notifyBatchChecked: many rows, ONE statement, on the given client", () => {
  const row = (userId: string) => ({ orgId: ORG, userId, kind: "checkout_released" as const, title: "Released", actorName: "System", resourceType: "document", resourceId: "d1", metadata: { autoReleasedSessionId: `s-${userId}` } });

  it("all rows in one insert call, the typed row shape; answers how many landed", async () => {
    const client = makeFakeSupabase(s.db);
    expect(await notifyBatchChecked([row("u1"), row("u2"), row("u3")], client)).toBe(3);
    const inserts = s.db.calls.filter((c) => c.table === "notifications" && c.method === "insert");
    expect(inserts).toHaveLength(1);
    expect(s.db.tables.notifications.map((n) => n.user_id)).toEqual(["u1", "u2", "u3"]);
    expect(s.db.tables.notifications[0]).toMatchObject({
      org_id: ORG, kind: "checkout_released", title: "Released", body: null, link: null, resource_type: "document", resource_id: "d1",
      actor_user_id: null, actor_name: "System", metadata: { autoReleasedSessionId: "s-u1" },
    });
  });

  it("answers the rows that LANDED, not the rows sent: a row the insert rail skips (a recipient who is no longer an active member — 20261160 rule 5, RETURN NULL) is not counted, and no read-back runs (N8's review fix)", async () => {
    // the rail, transcribed: a row for a non-member is dropped, the statement succeeds
    s.db.beforeInsert = { notifications: (r) => (r.user_id === "dc-gone" ? null : r) };
    const client = makeFakeSupabase(s.db);
    expect(await notifyBatchChecked([row("dc1"), row("dc-gone")], client)).toBe(1);
    expect(s.db.tables.notifications.map((n) => n.user_id)).toEqual(["dc1"]);
    // ONE statement, the count asked of the insert itself — never .select() (a RETURNING the
    // own-rows read policy refuses for another person's row, failing the whole browser sweep)
    const calls = s.db.calls.filter((c) => c.table === "notifications");
    expect(calls.map((c) => c.method)).toEqual(["insert"]);
    expect(calls[0].args[1]).toEqual({ count: "exact" });
    // the reason variant answers the refusal's text too
    s.db.refuseWrites.add("notifications");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await notifyBatchWithReason([row("dc1")], client)).toEqual({ landed: 0, error: "new row violates row-level security policy" });
    } finally { warn.mockRestore(); }
  });

  it("a refusal lands none and answers 0 (logged, never thrown); nothing to send sends nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      s.db.refuseWrites.add("notifications");
      expect(await notifyBatchChecked([row("u1"), row("u2")], makeFakeSupabase(s.db))).toBe(0);
      expect(s.db.tables.notifications ?? []).toEqual([]);
      expect(warn).toHaveBeenCalledWith("[notify] batch insert failed", expect.any(String));
      s.db.calls.length = 0;
      expect(await notifyBatchChecked([], makeFakeSupabase(s.db))).toBe(0);
      expect(s.db.calls).toEqual([]);
    } finally { warn.mockRestore(); }
  });
});
