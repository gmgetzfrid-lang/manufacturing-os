// admin-and-org Round G, P8 review fix — ORG-7's inherited acl_index entries.
//
// revoke_member (20261204) no longer rewrites every descendant whose
// chain-resolved acl_index names the removed person inside its one
// statement (a grant indexed into ~40k+ documents hit the statement_timeout,
// 57014, and a removal that works today failed). lib/memberAclIndexPrune.ts
// loops the chunked prune_removed_member_acl_index RPC instead: one bounded
// statement per call, until the database says nothing is left.

import { describe, it, expect } from "vitest";
import { pruneRemovedMemberAclIndex, ACL_INDEX_PRUNE_CHUNK, type RpcClient } from "@/lib/memberAclIndexPrune";

type Res = { data: unknown; error: { code?: string | null; message: string } | null };
const client = (answers: Array<Res | Error>) => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const sb: RpcClient = {
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      const a = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return { sb, calls };
};
const ok = (pruned: number, done: boolean): Res => ({ data: { pruned, done }, error: null });

describe("pruneRemovedMemberAclIndex", () => {
  it("calls the RPC chunk by chunk with the org, the person and the bounded limit until done, summing what was pruned", async () => {
    const { sb, calls } = client([ok(1000, false), ok(1000, false), ok(50, true)]);
    const r = await pruneRemovedMemberAclIndex(sb, "o1", "u1");
    expect(r).toEqual({ ok: true, pruned: 2050, done: true, calls: 3 });
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c).toEqual({ fn: "prune_removed_member_acl_index", args: { p_org_id: "o1", p_uid: "u1", p_limit: ACL_INDEX_PRUNE_CHUNK } });
    expect(ACL_INDEX_PRUNE_CHUNK).toBeLessThanOrEqual(5000); // the RPC clamps at 5000
  });

  it("before 20261204 is pasted (no such function) there is nothing to clear: ok, unavailable", async () => {
    const { sb, calls } = client([{ data: null, error: { code: "PGRST202", message: "Could not find the function public.prune_removed_member_acl_index" } }]);
    expect(await pruneRemovedMemberAclIndex(sb, "o1", "u1")).toEqual({ ok: true, pruned: 0, done: true, calls: 1, unavailable: true });
    expect(calls).toHaveLength(1);
  });

  it("a refusal or a timeout is a failure with the database's words — never read as 'not installed'", async () => {
    const { sb } = client([ok(1000, false), { data: null, error: { code: "42501", message: "Only an Admin can clear a removed member's access." } }]);
    expect(await pruneRemovedMemberAclIndex(sb, "o1", "u1")).toEqual({ ok: false, pruned: 1000, done: false, calls: 2, error: "Only an Admin can clear a removed member's access." });
    const perm = client([{ data: null, error: { code: "42501", message: "permission denied for function prune_removed_member_acl_index" } }]);
    expect((await pruneRemovedMemberAclIndex(perm.sb, "o1", "u1")).ok).toBe(false);
  });

  it("an answer that does not confirm the clean-up, or a thrown client, is a failure — the helper never rejects", async () => {
    expect(await pruneRemovedMemberAclIndex(client([{ data: null, error: null }]).sb, "o1", "u1"))
      .toEqual({ ok: false, pruned: 0, done: false, calls: 1, error: "the database did not confirm the clean-up" });
    expect(await pruneRemovedMemberAclIndex(client([new Error("network down")]).sb, "o1", "u1"))
      .toEqual({ ok: false, pruned: 0, done: false, calls: 1, error: "network down" });
  });

  it("stops at the call budget or the deadline and says it is not done (the nightly re-index, or the next run, finishes)", async () => {
    const budget = client([ok(1000, false)]);
    expect(await pruneRemovedMemberAclIndex(budget.sb, "o1", "u1", { maxCalls: 4 })).toEqual({ ok: true, pruned: 4000, done: false, calls: 4 });
    let t = 0;
    const timed = client([ok(1000, false)]);
    const r = await pruneRemovedMemberAclIndex(timed.sb, "o1", "u1", { deadlineMs: 2500, now: () => { const v = t; t += 1000; return v; } });
    expect(r.done).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.calls).toBeLessThan(4);
  });
});
