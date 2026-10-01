// document-control Round F wave 2 — P12 WAVE-2 RESIDUALS, integration fix
// (DRLS-9): after 20261139, revision_branches_org_update's WITH CHECK admits a
// 'merged' resolution only when a later revision is the document's current
// one. PostgREST answers that refusal as 42501 "new row violates row-level
// security policy for table \"revision_branches\"" — which used to reach the
// Document Control queue verbatim. resolveBranch now says what it means.
//
// Driven against the in-memory PostgREST (helpers/fakeSupabase) with a BEFORE
// UPDATE stand-in for the WITH CHECK's merge tie, transcribed from 20261139.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("@/lib/supabase", () => ({ get supabase() { return makeFakeSupabase(state.db); } }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => {}) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ error: null })) }));

import { resolveBranch, BRANCH_MERGE_REFUSED } from "@/lib/branches";
import { logAuditAction } from "@/lib/audit";

const RLS = { code: "42501", message: 'new row violates row-level security policy for table "revision_branches"' };
const T = (t: string) => (state.db.tables[t] ??= []);
const branch = () => T("revision_branches").find((b) => b.id === "br1")!;

/** 20261139 §2's merge tie: 'withdrawn', or the document's current revision
 *  is not the branch version and was written after it. */
function mergeTie(next: Row): boolean {
  if (next.resolution === "withdrawn") return true;
  const doc = T("documents").find((d) => d.id === next.document_id);
  const cv = T("document_versions").find((v) => v.id === doc?.current_version_id);
  const bv = T("document_versions").find((v) => v.id === next.branch_version_id);
  return !!cv && !!bv && cv.id !== bv.id && String(cv.created_at) > String(bv.created_at);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  T("documents").push({ id: "d1", current_version_id: "v3" });
  T("document_versions").push(
    { id: "v3", record_id: "d1", created_at: "2026-09-01T00:00:00Z" },
    { id: "vB", record_id: "d1", created_at: "2026-09-10T00:00:00Z" }, // the branch, newer than the current revision
  );
  T("revision_branches").push({ id: "br1", org_id: "o1", document_id: "d1", branch_version_id: "vB", resolved_at: null, created_by: "u2" });
  state.db.beforeUpdate!.revision_branches = (next) => { if (!mergeTie(next)) throw RLS; return next; };
});

const resolve = (resolution: "merged" | "withdrawn", note = "reconciled into Rev 4") =>
  resolveBranch({ branchId: "br1", resolution, note, orgId: "o1", actorUserId: "u1", actorName: "Dee" });

describe("DRLS-9 — a refused 'merged' resolution reaches the queue as what it means, not as a raw RLS error", () => {
  it("'merged' while the branch is newer than the current revision: refused with the plain sentence; the branch stays open; nothing is recorded", async () => {
    await expect(resolve("merged")).rejects.toThrow(BRANCH_MERGE_REFUSED);
    expect(BRANCH_MERGE_REFUSED).toBe("A merged resolution needs a later revision to be current — publish it first, or record the branch as withdrawn.");
    expect(branch().resolved_at).toBeNull();
    expect(logAuditAction).not.toHaveBeenCalled();
  });

  it("recording it 'withdrawn' instead resolves it, as before", async () => {
    await expect(resolve("withdrawn", "abandoned")).resolves.toBeUndefined();
    expect(branch()).toMatchObject({ resolution: "withdrawn", resolution_note: "abandoned", resolved_by: "u1" });
    expect(vi.mocked(logAuditAction).mock.calls[0][0]).toMatchObject({ action: "BRANCH_RESOLVED" });
  });

  it("once a later revision is current, 'merged' resolves, as before", async () => {
    T("document_versions").push({ id: "v4", record_id: "d1", created_at: "2026-09-20T00:00:00Z" });
    T("documents")[0].current_version_id = "v4";
    await expect(resolve("merged")).resolves.toBeUndefined();
    expect(branch().resolution).toBe("merged");
  });

  it("only a 42501 on a MERGE claim is translated: a 42501 on a withdrawal, or another error on a merge, keeps the database's own message", async () => {
    state.db.beforeUpdate!.revision_branches = () => { throw RLS; };
    await expect(resolve("withdrawn", "abandoned")).rejects.toThrow(RLS.message);
    state.db.beforeUpdate!.revision_branches = () => { throw { code: "57014", message: "canceling statement due to statement timeout" }; };
    await expect(resolve("merged")).rejects.toThrow("canceling statement due to statement timeout");
  });

  it("a write RLS filtered to zero rows (no authority, or someone else resolved it) keeps its own sentence", async () => {
    state.db.refuseWrites.add("revision_branches");
    await expect(resolve("merged")).rejects.toThrow(/Branch was not resolved — it was already resolved by someone else, or resolving it takes a controller or the document's owner\./);
  });

  it("the Document Control queue shows the error's message, so the sentence reaches it", () => {
    const q = readFileSync(join(process.cwd(), "components/documents/DocControlQueue.tsx"), "utf8");
    const h = q.slice(q.indexOf("const handleResolve = async"), q.indexOf("const handleVerify = async"));
    expect(h).toMatch(/await resolveBranch\(\{/);
    expect(h).toMatch(/\} catch \(e\) \{\s*setError\(\(e as Error\)\.message\);/);
  });
});
