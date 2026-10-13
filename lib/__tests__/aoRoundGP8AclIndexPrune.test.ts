// admin-and-org Round G, P8 review fix — ORG-7's inherited acl_index entries.
//
// revoke_member (20261204) no longer rewrites every descendant whose
// chain-resolved acl_index names the removed person inside its one
// statement (a grant indexed into ~40k+ documents hit the statement_timeout,
// 57014, and a removal that works today failed). lib/memberAclIndexPrune.ts
// loops the chunked prune_removed_member_acl_index RPC instead: one bounded
// statement per call, until the database says nothing is left.
//
// Fix pass 3 (third review): the walk is keyed on the person's own grant
// rows — revoke_member's aclIndexScope (the libraries / folders whose own acl
// carried the grant) — with a keyset cursor (phase + last id), so no call
// scans every document in the workspace, and a removal with an empty scope
// makes no call at all.

import { describe, it, expect } from "vitest";
import { pruneRemovedMemberAclIndex, aclIndexScopeOf, ACL_INDEX_PRUNE_CHUNK, type RpcClient } from "@/lib/memberAclIndexPrune";

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
const page = (pruned: number, phase: string | null, after: string | null): Res =>
  ({ data: { pruned, examined: pruned, phase, after, limit: ACL_INDEX_PRUNE_CHUNK, done: phase === null }, error: null });
const SCOPE = { libraries: ["L1"], collections: ["C1", "C2"] };

describe("pruneRemovedMemberAclIndex", () => {
  it("passes the scope and the cursor the database returned, call by call, until done, summing what was pruned", async () => {
    const { sb, calls } = client([page(1000, "documents", "d-1000"), page(40, "collections", null), page(3, "document_sets", null), page(0, null, null)]);
    const r = await pruneRemovedMemberAclIndex(sb, "o1", "u1", SCOPE);
    expect(r).toEqual({ ok: true, pruned: 1043, done: true, calls: 4 });
    const base = { p_org_id: "o1", p_uid: "u1", p_library_ids: ["L1"], p_collection_ids: ["C1", "C2"], p_limit: ACL_INDEX_PRUNE_CHUNK };
    expect(calls.map((c) => c.fn)).toEqual(Array(4).fill("prune_removed_member_acl_index"));
    expect(calls.map((c) => c.args)).toEqual([
      { ...base, p_phase: "documents", p_after: null },
      { ...base, p_phase: "documents", p_after: "d-1000" },
      { ...base, p_phase: "collections", p_after: null },
      { ...base, p_phase: "document_sets", p_after: null },
    ]);
    expect(ACL_INDEX_PRUNE_CHUNK).toBeLessThanOrEqual(5000); // the RPC clamps at 5000
  });

  it("an empty scope — nothing the person was given could be inherited — makes no call at all", async () => {
    const { sb, calls } = client([new Error("must not be called")]);
    expect(await pruneRemovedMemberAclIndex(sb, "o1", "u1", { libraries: [], collections: [] })).toEqual({ ok: true, pruned: 0, done: true, calls: 0 });
    expect(calls).toHaveLength(0);
  });

  it("aclIndexScopeOf reads revoke_member's answer; an answer without it (a database before 20261204) or of another shape is null", () => {
    expect(aclIndexScopeOf({ mode: "remove", aclIndexScope: { libraries: ["L1"], collections: [] } })).toEqual({ libraries: ["L1"], collections: [] });
    expect(aclIndexScopeOf({ mode: "remove" })).toBeNull();
    expect(aclIndexScopeOf(null)).toBeNull();
    expect(aclIndexScopeOf({ aclIndexScope: { libraries: "L1", collections: [] } })).toBeNull();
    expect(aclIndexScopeOf({ aclIndexScope: { libraries: ["L1", 7], collections: [] } })).toEqual({ libraries: ["L1"], collections: [] });
  });

  it("before 20261204 is pasted (no such function) there is nothing to clear: ok, unavailable", async () => {
    const { sb, calls } = client([{ data: null, error: { code: "PGRST202", message: "Could not find the function public.prune_removed_member_acl_index" } }]);
    expect(await pruneRemovedMemberAclIndex(sb, "o1", "u1", SCOPE)).toEqual({ ok: true, pruned: 0, done: true, calls: 1, unavailable: true });
    expect(calls).toHaveLength(1);
  });

  it("a refusal or a timeout is a failure with the database's words — never read as 'not installed'", async () => {
    const { sb } = client([page(1000, "documents", "d-1000"), { data: null, error: { code: "42501", message: "Only an Admin can clear a removed member's access." } }]);
    expect(await pruneRemovedMemberAclIndex(sb, "o1", "u1", SCOPE)).toEqual({ ok: false, pruned: 1000, done: false, calls: 2, error: "Only an Admin can clear a removed member's access." });
    const perm = client([{ data: null, error: { code: "42501", message: "permission denied for function prune_removed_member_acl_index" } }]);
    expect((await pruneRemovedMemberAclIndex(perm.sb, "o1", "u1", SCOPE)).ok).toBe(false);
  });

  it("an answer that does not confirm the clean-up (no count, or not done without a cursor), or a thrown client, is a failure — the helper never rejects", async () => {
    expect(await pruneRemovedMemberAclIndex(client([{ data: null, error: null }]).sb, "o1", "u1", SCOPE))
      .toEqual({ ok: false, pruned: 0, done: false, calls: 1, error: "the database did not confirm the clean-up" });
    expect(await pruneRemovedMemberAclIndex(client([{ data: { pruned: 5, done: false }, error: null }]).sb, "o1", "u1", SCOPE))
      .toEqual({ ok: false, pruned: 0, done: false, calls: 1, error: "the database did not confirm the clean-up" });
    expect(await pruneRemovedMemberAclIndex(client([new Error("network down")]).sb, "o1", "u1", SCOPE))
      .toEqual({ ok: false, pruned: 0, done: false, calls: 1, error: "network down" });
  });

  it("stops at the call budget or the deadline and says it is not done (the nightly re-index, or the next run, finishes)", async () => {
    const budget = client([page(1000, "documents", "d-x")]);
    expect(await pruneRemovedMemberAclIndex(budget.sb, "o1", "u1", SCOPE, { maxCalls: 4 })).toEqual({ ok: true, pruned: 4000, done: false, calls: 4 });
    let t = 0;
    const timed = client([page(1000, "documents", "d-x")]);
    const r = await pruneRemovedMemberAclIndex(timed.sb, "o1", "u1", SCOPE, { deadlineMs: 2500, now: () => { const v = t; t += 1000; return v; } });
    expect(r.done).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.calls).toBeLessThan(4);
  });
});
