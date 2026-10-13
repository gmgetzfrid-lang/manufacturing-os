// drafting-flow Round G, DF-P3 fix pass 3 — EDGE-4's recurring backstop.
//
// A departure (20261195's org_members triggers) hands a member's tickets back
// in the removing Admin's request, so it never waits: a ticket another write
// holds is skipped, a hand-back the database refuses is a WARNING, and one
// call stops at 200. Before this pass, what it left stayed on a uid that
// cannot sign in until someone re-pasted the migration. Now step 5b of the
// maintenance cron lists the (org, uid) pairs still holding open work while
// not active (departed_member_ticket_holders) and hands each back through
// the SAME function (return_departed_member_tickets), bounded by its own
// deadline, idempotent (a moved ticket leaves the list), and never throwing.

import { describe, it, expect } from "vitest";
import { runDepartureBackstop, DEPARTURE_HOLDERS_RPC, DEPARTURE_RETURN_RPC, DEPARTURE_CALL_BOUND } from "@/lib/ticketDepartureBackstop";

type Holder = { org_id: string; uid: string; label: string | null; held: number };
function fakeClient(opts: {
  holders?: Holder[] | null;
  holdersError?: { code?: string; message: string };
  /** What each return call answers, per uid, in order (the last repeats). */
  returns?: Record<string, Array<number | { code?: string; message: string }>>;
  onCall?: () => void;
}) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const seen: Record<string, number> = {};
  return {
    calls,
    client: {
      rpc: async (fn: string, args: Record<string, unknown> = {}) => {
        calls.push({ fn, args });
        opts.onCall?.();
        if (fn === DEPARTURE_HOLDERS_RPC) {
          return opts.holdersError ? { data: null, error: opts.holdersError } : { data: opts.holders ?? [], error: null };
        }
        if (fn === DEPARTURE_RETURN_RPC) {
          const uid = String(args.p_uid);
          const list = opts.returns?.[uid] ?? [0];
          const i = Math.min(seen[uid] ?? 0, list.length - 1);
          seen[uid] = (seen[uid] ?? 0) + 1;
          const v = list[i];
          return typeof v === "number" ? { data: v, error: null } : { data: null, error: v };
        }
        return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } };
      },
    },
  };
}
const FAR = () => Date.now() + 60_000;

describe("EDGE-4 backstop — what a departure left is handed back by the cron, through the same function", () => {
  it("hands back every leftover through return_departed_member_tickets, labelled, repeating a holder while a call hits the bound", async () => {
    const f = fakeClient({
      holders: [{ org_id: "o1", uid: "u-gone", label: "Dana", held: 450 }, { org_id: "o2", uid: "u-susp", label: null, held: 2 }],
      returns: { "u-gone": [DEPARTURE_CALL_BOUND, DEPARTURE_CALL_BOUND, 50], "u-susp": [2] },
    });
    const r = await runDepartureBackstop({ client: f.client, deadlineAt: FAR() });
    expect(r).toMatchObject({ installed: true, holders: 2, handedBack: 452, left: 0, truncated: false, errors: [] });
    const returns = f.calls.filter((c) => c.fn === DEPARTURE_RETURN_RPC);
    expect(returns).toHaveLength(4);
    expect(returns[0].args).toEqual({ p_org: "o1", p_uid: "u-gone", p_label: "Dana" });
    expect(returns[3].args).toEqual({ p_org: "o2", p_uid: "u-susp", p_label: null });
    // the holder list is bounded
    expect(f.calls[0]).toEqual({ fn: DEPARTURE_HOLDERS_RPC, args: { p_limit: 50 } });
  });
  it("a holder whose tickets cannot move this run (row-locked, refused) is counted and said — never a throw — and the next holder is still served", async () => {
    const f = fakeClient({
      holders: [{ org_id: "o1", uid: "u-locked", label: "A", held: 3 }, { org_id: "o1", uid: "u-ok", label: "B", held: 1 }],
      returns: { "u-locked": [1], "u-ok": [1] },
    });
    const r = await runDepartureBackstop({ client: f.client, deadlineAt: FAR() });
    expect(r).toMatchObject({ holders: 2, handedBack: 2, left: 2 });
    expect(r.errors).toEqual([
      "ticket-departure: 2 of 3 open ticket(s) of the departed member u-locked in org o1 were not handed back this run (held by another write, or refused — the database log names each) — the next run tries again",
    ]);
  });
  it("a refused call is a line, not a throw, and the rest are still served", async () => {
    const f = fakeClient({
      holders: [{ org_id: "o1", uid: "u-x", label: "A", held: 1 }, { org_id: "o1", uid: "u-y", label: "B", held: 1 }],
      returns: { "u-x": [{ code: "57014", message: "canceling statement due to statement timeout" }], "u-y": [1] },
    });
    const r = await runDepartureBackstop({ client: f.client, deadlineAt: FAR() });
    expect(r).toMatchObject({ handedBack: 1, left: 1 });
    expect(r.errors[0]).toContain("ticket-departure: the open tickets of the departed member u-x in org o1 could not be handed back: canceling statement due to statement timeout");
  });
  it("idempotent: nothing listed, nothing called", async () => {
    const f = fakeClient({ holders: [] });
    const r = await runDepartureBackstop({ client: f.client, deadlineAt: FAR() });
    expect(r).toMatchObject({ installed: true, holders: 0, handedBack: 0, left: 0, truncated: false, errors: [] });
    expect(f.calls.map((c) => c.fn)).toEqual([DEPARTURE_HOLDERS_RPC]);
  });
  it("before 20261195 is pasted (the function is missing) it does nothing and says it is not installed — not an error", async () => {
    const f = fakeClient({ holdersError: { code: "PGRST202", message: "Could not find the function public.departed_member_ticket_holders" } });
    const r = await runDepartureBackstop({ client: f.client, deadlineAt: FAR() });
    expect(r).toMatchObject({ installed: false, holders: 0, errors: [] });
  });
  it("a holder list that cannot be read is a line", async () => {
    const f = fakeClient({ holdersError: { code: "XX000", message: "boom" } });
    const r = await runDepartureBackstop({ client: f.client, deadlineAt: FAR() });
    expect(r.errors).toEqual(["ticket-departure: the departed members still holding open tickets could not be listed — nothing was handed back: boom"]);
  });
  it("bounded by its deadline: it stops starting calls once the deadline passes, and says the list was not finished", async () => {
    let t = 0;
    const f = fakeClient({
      holders: Array.from({ length: 5 }, (_, i) => ({ org_id: "o1", uid: `u${i}`, label: null, held: 1 })),
      returns: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`u${i}`, [1]])),
      onCall: () => { t += 1; },
    });
    const r = await runDepartureBackstop({ client: f.client, deadlineAt: 0, now: () => (t >= 3 ? 10 : -10) });
    expect(r.truncated).toBe(true);
    expect(f.calls.filter((c) => c.fn === DEPARTURE_RETURN_RPC).length).toBe(2);
    expect(r.handedBack).toBe(2);
  });
  it("a full holder list (the bound) is marked truncated — there may be more for the next run", async () => {
    const f = fakeClient({ holders: Array.from({ length: 3 }, (_, i) => ({ org_id: "o1", uid: `u${i}`, label: null, held: 1 })), returns: { u0: [1], u1: [1], u2: [1] } });
    const r = await runDepartureBackstop({ client: f.client, deadlineAt: FAR(), maxHolders: 3 });
    expect(r).toMatchObject({ holders: 3, handedBack: 3, truncated: true });
  });
});
