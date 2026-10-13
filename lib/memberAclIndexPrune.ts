// lib/memberAclIndexPrune.ts — browser or server (takes the client to use).
//
// admin-and-org ORG-7 (Round G, P8 review fix). revoke_member (20261204)
// prunes a removed member's personal ALLOW rules from the nodes that carry
// them, inside its transaction. The descendants that only INHERIT such a
// grant — a library grant indexed into every document under it — are not
// rewritten there: tens of thousands of rows in one statement exceeded the
// statement_timeout, so a removal that works today would have failed. They
// are stripped afterwards, in bounded chunks, by the
// prune_removed_member_acl_index RPC (one statement per chunk). This helper
// loops it until the database says nothing is left, a call budget or a
// deadline runs out, or a call fails.
//
// Fix pass 3 (third review): the walk is keyed on the person's own grant
// rows. revoke_member returns the libraries and folders whose own acl
// carried the grant (`aclIndexScope`) — the only nodes whose descendants
// can have inherited it — and this helper passes them back with a keyset
// cursor (phase + last id), so each call examines at most `chunk` rows
// under them and never re-reads one. With an empty scope (the person held
// no such grant) it makes no call at all: nothing to clear, no alert.
//
// Nothing leaks while it runs: the membership row is already gone, and every
// RLS path refuses a non-member. A run cut short is finished by calling this
// again or by the nightly acl_index rebuild (DEC-10), which drops the uid
// because its rule is no longer in the chain.

/** What revoke_member answers on REMOVE (20261204, fix pass 3): the
 *  libraries and folders whose own acl carried the removed person's grant. */
export interface AclIndexScope {
  libraries: string[];
  collections: string[];
}

/** The scope from revoke_member's answer, or null when it carries none (a
 *  database before 20261204, or an answer of another shape). */
export function aclIndexScopeOf(result: unknown): AclIndexScope | null {
  const raw = (result as { aclIndexScope?: unknown } | null)?.aclIndexScope as { libraries?: unknown; collections?: unknown } | undefined;
  if (!raw || typeof raw !== "object") return null;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);
  const libraries = ids(raw.libraries);
  const collections = ids(raw.collections);
  if (!libraries || !collections) return null;
  return { libraries, collections };
}

/** The minimal client surface used (the browser client or the service client). */
export interface RpcClient {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string | null; message: string } | null }>;
}

export interface AclIndexPruneOutcome {
  /** False only when a call failed (the error says why). */
  ok: boolean;
  /** Nodes whose acl_index lost the person, over every call. */
  pruned: number;
  /** True when the database reported nothing left that names them. */
  done: boolean;
  calls: number;
  /** The RPC is not installed (20261204 not pasted): nothing to do here. */
  unavailable?: boolean;
  error?: string;
}

export const ACL_INDEX_PRUNE_CHUNK = 1000;
export const ACL_INDEX_PRUNE_MAX_CALLS = 500;

/** "This function does not exist yet" only — never a permission error that
 *  names the function (the same rule as lib/intakeRateLimit.ts). */
function isMissingFunction(err: { code?: string | null; message: string }): boolean {
  const code = String(err.code ?? "");
  if (code === "PGRST202") return true;
  if (code === "42883") return /function .* does not exist/i.test(err.message);
  return /Could not find the function/i.test(err.message);
}

export async function pruneRemovedMemberAclIndex(
  sb: RpcClient,
  orgId: string,
  uid: string,
  scope: AclIndexScope,
  opts?: { chunk?: number; maxCalls?: number; deadlineMs?: number; now?: () => number },
): Promise<AclIndexPruneOutcome> {
  // Nothing carried the grant, so nothing inherited it.
  if (scope.libraries.length === 0 && scope.collections.length === 0) return { ok: true, pruned: 0, done: true, calls: 0 };
  const chunk = opts?.chunk ?? ACL_INDEX_PRUNE_CHUNK;
  const maxCalls = opts?.maxCalls ?? ACL_INDEX_PRUNE_MAX_CALLS;
  const now = opts?.now ?? Date.now;
  const stopAt = opts?.deadlineMs !== undefined ? now() + opts.deadlineMs : Infinity;
  let pruned = 0;
  let calls = 0;
  let phase: string = "documents";
  let after: string | null = null;
  while (calls < maxCalls && now() < stopAt) {
    calls++;
    let data: unknown;
    let error: { code?: string | null; message: string } | null;
    try {
      ({ data, error } = await sb.rpc("prune_removed_member_acl_index", {
        p_org_id: orgId, p_uid: uid,
        p_library_ids: scope.libraries, p_collection_ids: scope.collections,
        p_phase: phase, p_after: after, p_limit: chunk,
      }));
    } catch (e) {
      // Never rejects: the caller runs it after the removal, unawaited.
      return { ok: false, pruned, done: false, calls, error: e instanceof Error ? e.message : String(e) };
    }
    if (error) {
      if (isMissingFunction(error)) return { ok: true, pruned, done: true, calls, unavailable: true };
      return { ok: false, pruned, done: false, calls, error: error.message };
    }
    const r = (data ?? null) as { pruned?: unknown; done?: unknown; phase?: unknown; after?: unknown } | null;
    if (!r || typeof r.pruned !== "number" || typeof r.done !== "boolean"
        || (!r.done && (typeof r.phase !== "string" || (r.after !== null && typeof r.after !== "string")))) {
      return { ok: false, pruned, done: false, calls, error: "the database did not confirm the clean-up" };
    }
    pruned += r.pruned;
    if (r.done) return { ok: true, pruned, done: true, calls };
    phase = r.phase as string;
    after = (r.after as string | null) ?? null;
  }
  return { ok: true, pruned, done: false, calls };
}
