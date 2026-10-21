// document-control Round G — P37 DOOR B GUARD, fix pass: the stray retire's
// void is bound to the draft shown. lib/strayPendingSubmission.ts re-reads
// the pending submission, then calls lib/revisions.ts voidPendingDraft —
// which re-reads the pointer itself. A genuine submission filed in between
// (the contractor door displacing the stray one) used to be the draft voided:
// its sign-offs voided (never to return, 20261070) and the draft retired,
// the mismatch said only afterwards. voidPendingDraft now takes an optional
// expectedDraftId and refuses, before any write, when the pointer names
// another draft; existing callers omit it and are unchanged.
//
// Real lib/revisions.ts and lib/strayPendingSubmission.ts over the in-memory
// supabase stand-in (lib/__tests__/helpers/fakeSupabase.ts).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  /** runs once, right after the stray module's last re-read (the link row) resolves */
  afterLinkRead: null as null | (() => void),
  log: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const base = makeFakeSupabase(h.db);
    return {
      ...base,
      from: (t: string) => {
        const inner = base.from(t) as unknown as Record<string, (...a: unknown[]) => unknown>;
        if (t !== "project_intake_links") return inner;
        const wrap: unknown = new Proxy({}, {
          get(_x, prop: string) {
            return (...args: unknown[]) => {
              const out = inner[prop](...args);
              if (prop === "maybeSingle") {
                return (out as Promise<unknown>).then((v) => { const f = h.afterLinkRead; h.afterLinkRead = null; f?.(); return v; });
              }
              return wrap;
            };
          },
        });
        return wrap;
      },
    };
  },
}));
vi.mock("@/lib/audit", () => ({ logAuditAction: (...a: unknown[]) => h.log(...a) }));

import { voidPendingDraft, PendingDraftVoidError } from "@/lib/revisions";
import { retireStrayPendingSubmission } from "@/lib/strayPendingSubmission";

const T = (name: string): Row[] => (h.db.tables[name] ??= []);
const doc = () => T("documents").find((r) => r.id === "d1")!;
const version = (id: string) => T("document_versions").find((r) => r.id === id)!;
const signoff = (id: string) => T("document_review_signoffs").find((r) => r.id === id)!;

beforeEach(() => {
  h.db = newFakeDb();
  h.afterLinkRead = null;
  h.log.mockReset().mockResolvedValue({ error: null, ok: true });
  T("documents").push({ id: "d1", org_id: "o1", pending_version_id: "x2A", current_version_id: "xA" });
  T("document_versions").push(
    { id: "xA", record_id: "d1", review_state: "approved", superseded_at: null },
    // the stray submission: through a quote link, no member creator
    { id: "x2A", record_id: "d1", review_state: "in_review", provenance: "external", intake_link_id: "Q1", created_by: "Q1", revision_label: "2A", superseded_at: null },
  );
  T("project_intake_links").push({ id: "Q1", purpose: "quote" });
  T("document_review_signoffs").push({ id: "sx", document_version_id: "x2A", status: "pending" });
});

/** The contractor door files a genuine submission y, displacing x2A (what the intake route's displace does). */
const fileGenuine = () => {
  T("document_versions").push({ id: "y2B", record_id: "d1", review_state: "in_review", provenance: "external", intake_link_id: "D1", created_by: "D1", revision_label: "2B", superseded_at: null });
  T("document_review_signoffs").push({ id: "sy", document_version_id: "y2B", status: "signed" });
  doc().pending_version_id = "y2B";
};

describe("voidPendingDraft(documentId, expectedDraftId) — P37 fix pass", () => {
  it("THE DEFECT, closed: a genuine submission filed between the stray retire's re-read and its void is refused before any write — its sign-offs, its draft and the pointer untouched; nothing recorded", async () => {
    h.afterLinkRead = fileGenuine;
    const r = await retireStrayPendingSubmission({
      orgId: "o1", documentId: "d1", expectedVersionId: "x2A", reason: "quote link submission",
      actorIsController: true, actorUserId: "u1",
    });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("pending draft changed since it was shown") });
    expect(signoff("sy").status).toBe("signed");
    expect(version("y2B").superseded_at).toBeNull();
    expect(doc().pending_version_id).toBe("y2B");
    // the stray one is not touched either (the refusal is before any write)
    expect(signoff("sx").status).toBe("pending");
    expect(version("x2A").superseded_at).toBeNull();
    expect(h.db.calls.filter((c) => c.method === "update")).toHaveLength(0);
    // P37 final fix pass (ruling (3)): only the intent row, written before the void; no outcome recorded
    expect(h.log.mock.calls.map((c) => c[0].action)).toEqual(["PENDING_SUBMISSION_RETIRE_REQUESTED"]);
  });

  it("the refusal names itself (draftChanged) — another draft pointed at, or none any more", async () => {
    fileGenuine();
    const e1 = await voidPendingDraft("d1", "x2A").catch((e) => e);
    expect(e1).toBeInstanceOf(PendingDraftVoidError);
    expect((e1 as PendingDraftVoidError).draftChanged).toBe(true);
    expect((e1 as Error).message).toMatch(/another draft is now in review\) — nothing was changed/);
    doc().pending_version_id = null;
    const e2 = await voidPendingDraft("d1", "x2A").catch((e) => e);
    expect((e2 as PendingDraftVoidError).draftChanged).toBe(true);
    expect((e2 as Error).message).toMatch(/no longer has the pending draft that was shown — nothing was changed/);
    expect(h.db.calls.filter((c) => c.method === "update")).toHaveLength(0);
  });

  it("the draft shown is still pointed at — voided as before: sign-offs void, draft superseded, pointer released; recorded as the one shown", async () => {
    const r = await retireStrayPendingSubmission({
      orgId: "o1", documentId: "d1", expectedVersionId: "x2A", reason: "quote link submission",
      actorIsController: true, actorUserId: "u1",
    });
    expect(r).toEqual({ ok: true, voidedVersionId: "x2A", recordError: null });
    expect(signoff("sx").status).toBe("void");
    expect(version("x2A").superseded_at).not.toBeNull();
    expect(doc().pending_version_id).toBeNull();
    // P37 final fix pass (ruling (3)): the intent first, then the outcome
    expect(h.log.mock.calls.map((c) => c[0].action)).toEqual(["PENDING_SUBMISSION_RETIRE_REQUESTED", "PENDING_SUBMISSION_RETIRED"]);
    expect(h.log.mock.calls[0][0].details).toMatchObject({ versionId: "x2A", reason: "quote link submission" });
    expect(h.log.mock.calls[1][0].details).toMatchObject({ versionId: "x2A", shownVersionId: "x2A", sameAsShown: true });
  });

  it("REGRESSION: a caller that names no draft (every caller before P37 — the rev-up, revert, archive, supersede, split, merge, park) voids whatever is pending, as before", async () => {
    fileGenuine();
    expect(await voidPendingDraft("d1")).toBe("y2B");
    expect(signoff("sy").status).toBe("void");
    expect(doc().pending_version_id).toBeNull();
    expect(await voidPendingDraft("d1")).toBeNull();
    expect(await voidPendingDraft("d1", null)).toBeNull();
  });
});
