// document-control Round F wave 3 — P14 RECORDS & REVIEW REMAINDERS, final
// review: PKG-9's residual, the setAckPolicy half.
//
//   effectiveAckPolicyForDocument now THROWS on an unreadable folder / library
//   policy (P14), so recomputeDocumentAck can reject. setAckPolicy recomputed
//   a library's or folder's issued documents in batches of 20 with
//   Promise.all: the first rejection rejected the batch and every LATER batch
//   never ran, and AckPolicyModal / AckSection awaited it in try/finally with
//   no catch — an unhandled rejection, nothing on screen, while the policy
//   itself had been saved. Now each batch is settled whole, every batch runs,
//   and ONE summarised error (AckRosterRecomputeError) says the policy was
//   saved but N rosters were not recomputed; both editors show it.
//
// The library half is driven against the in-memory PostgREST with the real
// lib/acknowledgments.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  /** collection ids whose ack_policy read answers an error */
  brokenCollections: new Set<string>(),
  /** the documents listing read answers an error */
  failListing: false,
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const base = makeFakeSupabase(state.db);
    return {
      ...base,
      from: (t: string) => {
        const b = base.from(t) as unknown as Record<string, (...a: unknown[]) => unknown>;
        if (t === "documents" && state.failListing) {
          // only the covered-documents listing (select("id")) fails
          let listing = false;
          const p: Record<string, unknown> = new Proxy(b, {
            get(target, prop: string) {
              if (prop === "then") {
                return listing
                  ? (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "statement timeout" } }).then(res)
                  : target.then;
              }
              return (...a: unknown[]) => { if (prop === "select" && a[0] === "id") listing = true; target[prop](...a); return p; };
            },
          });
          return p;
        }
        if (t !== "collections") return b;
        let broken = false;
        const p: Record<string, unknown> = new Proxy(b, {
          get(target, prop: string) {
            if (prop === "then") return target.then;
            if (prop === "maybeSingle") {
              return async () => (broken ? { data: null, error: { message: "statement timeout" } } : target.maybeSingle());
            }
            return (...a: unknown[]) => {
              if (prop === "eq" && a[0] === "id" && state.brokenCollections.has(String(a[1]))) broken = true;
              target[prop](...a);
              return p;
            };
          },
        });
        return p;
      },
    };
  },
}));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => undefined) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ error: null })) }));
vi.mock("@/lib/eSignatures", () => ({ recordSignature: vi.fn() }));
vi.mock("@/lib/ownership", () => ({
  getOrgControllers: vi.fn(async () => []),
  effectiveOwnerForDocument: vi.fn(async () => ({ userId: null, name: null })),
  resolveEffectiveOwner: vi.fn(() => ({ userId: null, name: null })),
  teamSupervisorMap: vi.fn(async () => new Map()),
}));

import { setAckPolicy, AckRosterRecomputeError } from "@/lib/acknowledgments";

const ORG = "o1";
const T = (t: string) => (state.db.tables[t] ??= []);
const POLICY = { enabled: true, assigneeIds: ["u1"], assigneeRoles: [], assigneeTeamIds: [], hardGate: false };

function seedLibrary(n: number, broken: number[] = []) {
  T("libraries").push({ id: "L1", org_id: ORG, ack_policy: null });
  T("org_members").push({ uid: "u1", org_id: ORG, status: "active", display_name: "Ursula", email: "u1@example.com" });
  for (let i = 0; i < n; i++) {
    const id = `d${String(i).padStart(2, "0")}`;
    const isBroken = broken.includes(i);
    T("documents").push({
      id, org_id: ORG, library_id: "L1", collection_id: isBroken ? `broken-${i}` : null, status: "Issued",
      current_version_id: `${id}-v`, document_number: id.toUpperCase(), title: null, name: null, ack_policy: null,
      owner_user_id: null, owner_name: null,
    });
    T("document_versions").push({ id: `${id}-v`, record_id: id, revision_label: "1", file_hash: null });
    if (isBroken) state.brokenCollections.add(`broken-${i}`);
  }
  T("collections");
  T("document_acknowledgments");
}
/** The documents whose roster was recomputed: each got its assignee's row. */
const recomputed = () => new Set(T("document_acknowledgments").map((r: Row) => r.document_id as string));

beforeEach(() => {
  state.db = newFakeDb();
  state.brokenCollections = new Set();
  state.failListing = false;
});

describe("PKG-9 (P14 final review) — setAckPolicy recomputes EVERY batch, and says once what it could not", () => {
  it("a rejection in batch 1 still recomputes batches 2 and 3; ONE error names how many were not, and that the policy was saved", async () => {
    seedLibrary(45, [3]); // d03 sits in the first batch of 20
    const err = await setAckPolicy({ level: "library", id: "L1", orgId: ORG, policy: POLICY, actorId: "ctl1" }).catch((e: unknown) => e);
    // the policy itself landed, and every other document — batch 2 and 3 included — was recomputed
    // (Promise.all rejected batch 1 and never started batches 2 and 3: d20..d44 had no roster)
    expect(T("libraries")[0].ack_policy).toEqual(POLICY);
    const done = recomputed();
    for (const id of ["d00", "d19", "d20", "d39", "d40", "d44"]) expect(done.has(id), id).toBe(true);
    expect(done.size).toBe(44);
    expect(done.has("d03")).toBe(false);
    expect(err).toBeInstanceOf(AckRosterRecomputeError);
    expect((err as AckRosterRecomputeError).failedDocumentIds).toEqual(["d03"]);
    expect((err as AckRosterRecomputeError).total).toBe(45);
    expect((err as Error).message).toBe(
      "The read-&-understood policy was saved, but 1 of the 45 issued documents it covers did not have its acknowledgment roster recomputed " +
      "(Couldn't read the folder's read-&-understood policy (statement timeout); the acknowledgment roster was not recomputed.). Save the policy again to retry.",
    );
  });

  it("failures in several batches are all collected (first error named), in order", async () => {
    seedLibrary(45, [1, 25, 44]);
    const err = (await setAckPolicy({ level: "library", id: "L1", orgId: ORG, policy: POLICY }).catch((e: unknown) => e)) as AckRosterRecomputeError;
    expect(err.failedDocumentIds).toEqual(["d01", "d25", "d44"]);
    expect(err.message).toMatch(/^The read-&-understood policy was saved, but 3 of the 45 issued documents it covers did not have their acknowledgment roster recomputed \(first error: Couldn't read the folder's/);
    expect(recomputed().size).toBe(42);
  });

  it("a document-level save whose recompute fails says the policy was saved (this document's roster)", async () => {
    seedLibrary(1, [0]);
    const err = (await setAckPolicy({ level: "document", id: "d00", orgId: ORG, policy: null }).catch((e: unknown) => e)) as AckRosterRecomputeError;
    expect(err).toBeInstanceOf(AckRosterRecomputeError);
    expect(err.message).toMatch(/^The read-&-understood policy was saved, but this document's acknowledgment roster was not recomputed \(Couldn't read the folder's/);
  });

  it("covered documents that cannot be listed are said too — never a silent 'saved' that recomputed nothing", async () => {
    seedLibrary(3);
    state.failListing = true;
    const err = (await setAckPolicy({ level: "library", id: "L1", orgId: ORG, policy: POLICY }).catch((e: unknown) => e)) as AckRosterRecomputeError;
    expect(err).toBeInstanceOf(AckRosterRecomputeError);
    expect(err.message).toBe("The read-&-understood policy was saved, but the documents it covers could not be read, so no acknowledgment roster was recomputed (statement timeout). Save the policy again to retry.");
    expect(recomputed().size).toBe(0);
  });

  it("regression — every roster recomputes: resolves as before; a refused save is still the refusal (nothing recomputed)", async () => {
    seedLibrary(45);
    await expect(setAckPolicy({ level: "library", id: "L1", orgId: ORG, policy: POLICY })).resolves.toBeUndefined();
    expect(recomputed().size).toBe(45);
    state.db = newFakeDb();
    seedLibrary(2);
    state.db.refuseWrites.add("libraries");
    await expect(setAckPolicy({ level: "library", id: "L1", orgId: ORG, policy: POLICY })).rejects.toThrow("Read-&-understood policy was NOT saved");
    expect(recomputed().size).toBe(0);
  });
});
