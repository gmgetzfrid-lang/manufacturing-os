// document-control Round G — P37 DOOR B GUARD: DCK-18 (c). A pending
// submission no project's Intake tab lists (a quote link, a link that no
// longer exists, none) gets Document Control's standalone, recorded retire
// through the existing lib/revisions.ts voidPendingDraft path
// (lib/strayPendingSubmission.ts). The Intake tab's own rule decides
// "listed" (components/projects/IntakePanel.tsx: a project's links with
// purpose 'documents'); a submission it lists is never offered, and an
// unreadable row is never offered (fail-safe).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const s = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown> | null>,
  errors: {} as Record<string, { message: string } | undefined>,
  reads: [] as string[],
  voidPendingDraft: vi.fn(),
  log: vi.fn(),
}));

vi.mock("@/lib/supabase", () => {
  const chain = (t: string): unknown => {
    const h: ProxyHandler<object> = {
      get(_x, prop: string) {
        if (prop === "maybeSingle") {
          return () => {
            s.reads.push(t);
            const err = s.errors[t];
            return Promise.resolve(err ? { data: null, error: err } : { data: s.rows[t] ?? null, error: null });
          };
        }
        return () => new Proxy({}, h);
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: (t: string) => chain(t) } };
});
vi.mock("@/lib/revisions", () => ({ voidPendingDraft: (...a: unknown[]) => s.voidPendingDraft(...a) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: (...a: unknown[]) => s.log(...a) }));

import {
  isDoorShapedSubmission, listedOnIntakeTab, strayFromRows, describeStray, readStraySubmission, retireStrayPendingSubmission,
} from "@/lib/strayPendingSubmission";

const door = (over: Record<string, unknown> = {}) => ({
  id: "v2", record_id: "d1", review_state: "in_review", provenance: "external", intake_link_id: "L9",
  created_by: "L9", revision_label: "2A", superseded_at: null, ...over,
});
const input = (over: Record<string, unknown> = {}) => ({
  orgId: "o1", documentId: "d1", expectedVersionId: "v2", reason: "quote link submission, not ours",
  actorIsController: true, actorUserId: "u1", actorEmail: "u1@example.com", actorRole: "DocCtrl", ...over,
});

beforeEach(() => {
  s.rows = { documents: { pending_version_id: "v2" }, document_versions: door(), project_intake_links: { id: "L9", purpose: "quote" } };
  s.errors = {};
  s.reads = [];
  s.voidPendingDraft.mockReset().mockResolvedValue("v2");
  s.log.mockReset().mockResolvedValue({ error: null, ok: true });
});

describe("the shape and the Intake tab's rule (pure)", () => {
  it("door-shaped: in review, 'external', no member creator (NULL or the link's own id), not retired — the shape 20261252 counts and door (b)'s intake limb reads", () => {
    expect(isDoorShapedSubmission(door())).toBe(true);
    expect(isDoorShapedSubmission(door({ created_by: null }))).toBe(true);
    expect(isDoorShapedSubmission(door({ created_by: "member-1" }))).toBe(false);
    expect(isDoorShapedSubmission(door({ provenance: null }))).toBe(false);
    expect(isDoorShapedSubmission(door({ review_state: "approved" }))).toBe(false);
    expect(isDoorShapedSubmission(door({ superseded_at: "2026-10-20T00:00:00Z" }))).toBe(false);
    expect(isDoorShapedSubmission(null)).toBe(false);
  });

  it("listed on an Intake tab: a link that exists with purpose 'documents' (or none — a database before the column); a quote link and a link that is gone are not", () => {
    expect(listedOnIntakeTab({ id: "L", purpose: "documents" })).toBe(true);
    expect(listedOnIntakeTab({ id: "L", purpose: null })).toBe(true);
    expect(listedOnIntakeTab({ id: "L", purpose: "quote" })).toBe(false);
    expect(listedOnIntakeTab(null)).toBe(false);
    // IntakePanel reads exactly that: the project's links with purpose 'documents'
    expect(readFileSync(join(process.cwd(), "components", "projects", "IntakePanel.tsx"), "utf8")).toContain('.eq("purpose", "documents")');
  });

  it("stray: the cause is a quote link, a link gone, or no link; an Intake-tab submission and an ordinary draft are not stray", () => {
    expect(strayFromRows(door(), { id: "L9", purpose: "quote" })).toEqual({ versionId: "v2", revisionLabel: "2A", intakeLinkId: "L9", linkPurpose: "quote", cause: "quote_link" });
    expect(strayFromRows(door(), null)?.cause).toBe("link_gone");
    expect(strayFromRows(door({ intake_link_id: null, created_by: null }), null)?.cause).toBe("no_link");
    expect(strayFromRows(door(), { id: "L9", purpose: "documents" })).toBeNull();
    expect(strayFromRows(door({ provenance: null, created_by: "member-1" }), null)).toBeNull();
  });

  it("the sentence says why no Intake tab can decide it", () => {
    expect(describeStray(strayFromRows(door(), { id: "L9", purpose: "quote" })!)).toBe("The pending submission 2A came through a quote link, so no project's Intake tab lists it — it can't be approved or rejected there.");
    expect(describeStray(strayFromRows(door(), null)!)).toContain("came through an intake link that no longer exists");
    expect(describeStray(strayFromRows(door({ intake_link_id: null, created_by: null, revision_label: null }), null)!)).toBe("The pending submission names no intake link, so no project's Intake tab lists it — it can't be approved or rejected there.");
  });
});

describe("readStraySubmission", () => {
  it("reads the pointer, the pending row and its link: a quote link's submission is stray; a document link's is not", async () => {
    expect(await readStraySubmission("d1")).toEqual({ kind: "stray", stray: { versionId: "v2", revisionLabel: "2A", intakeLinkId: "L9", linkPurpose: "quote", cause: "quote_link" } });
    expect(s.reads).toEqual(["documents", "document_versions", "project_intake_links"]);
    s.rows.project_intake_links = { id: "L9", purpose: "documents" };
    expect(await readStraySubmission("d1")).toEqual({ kind: "none" });
  });

  it("a link row not found (gone) is stray; no pending draft, or an ordinary draft, is none and reads no link", async () => {
    s.rows.project_intake_links = null;
    expect((await readStraySubmission("d1")).kind).toBe("stray");
    s.reads = [];
    s.rows.document_versions = door({ provenance: null, created_by: "member-1" });
    expect(await readStraySubmission("d1")).toEqual({ kind: "none" });
    expect(s.reads).toEqual(["documents", "document_versions"]);
    s.rows.documents = { pending_version_id: null };
    expect(await readStraySubmission("d1")).toEqual({ kind: "none" });
  });

  it("FAIL-SAFE: any read that fails is unknown — never 'nobody lists it'", async () => {
    for (const t of ["documents", "document_versions", "project_intake_links"]) {
      s.errors = { [t]: { message: `${t} unreadable` } };
      expect(await readStraySubmission("d1")).toEqual({ kind: "unknown", reason: `${t} unreadable` });
    }
  });
});

describe("retireStrayPendingSubmission — controller-only, re-read first, through voidPendingDraft, recorded", () => {
  it("retires the submission shown: re-read, voidPendingDraft, then PENDING_SUBMISSION_RETIRED naming the version, the link, why and the reason", async () => {
    const r = await retireStrayPendingSubmission(input());
    expect(r).toEqual({ ok: true, voidedVersionId: "v2", recordError: null });
    expect(s.voidPendingDraft).toHaveBeenCalledWith("d1");
    expect(s.log).toHaveBeenCalledTimes(1);
    expect(s.log.mock.calls[0][0]).toEqual({
      action: "PENDING_SUBMISSION_RETIRED", resourceId: "d1", resourceType: "document", orgId: "o1",
      userId: "u1", userEmail: "u1@example.com", userRole: "DocCtrl",
      details: {
        versionId: "v2", shownVersionId: "v2", sameAsShown: true, revisionLabel: "2A", intakeLinkId: "L9", linkPurpose: "quote",
        cause: "quote_link", reason: "quote link submission, not ours", via: "void_pending_draft",
      },
    });
  });

  it("refuses anyone but Document Control, and a blank reason, before anything is read or written", async () => {
    expect(await retireStrayPendingSubmission(input({ actorIsController: false }))).toEqual({ ok: false, reason: "Only Document Control can retire a pending submission no Intake tab lists." });
    expect(await retireStrayPendingSubmission(input({ reason: "   " }))).toEqual({ ok: false, reason: "Give the reason for retiring the submission." });
    expect(s.reads).toEqual([]);
    expect(s.voidPendingDraft).not.toHaveBeenCalled();
    expect(s.log).not.toHaveBeenCalled();
  });

  it("refuses, changing nothing, when the pending draft changed since it was shown — decided, replaced, now on an Intake tab — or cannot be re-read", async () => {
    s.rows.documents = { pending_version_id: "v3" };
    s.rows.document_versions = door({ id: "v3" });
    expect((await retireStrayPendingSubmission(input())).ok).toBe(false);
    s.rows.documents = { pending_version_id: "v2" };
    s.rows.document_versions = door();
    s.rows.project_intake_links = { id: "L9", purpose: "documents" };
    const onTab = await retireStrayPendingSubmission(input());
    expect(onTab).toEqual({ ok: false, reason: expect.stringContaining("changed since it was shown") });
    s.errors = { document_versions: { message: "down" } };
    expect(await retireStrayPendingSubmission(input())).toEqual({ ok: false, reason: "Couldn't confirm the pending submission is still the one shown (down) — nothing was changed." });
    expect(s.voidPendingDraft).not.toHaveBeenCalled();
    expect(s.log).not.toHaveBeenCalled();
  });

  it("a void the database refuses is said in voidPendingDraft's own words and records nothing; a pointer already gone records nothing", async () => {
    s.voidPendingDraft.mockRejectedValueOnce(new Error("The in-review draft's sign-offs could not be voided (denied) — the draft is still in review."));
    expect(await retireStrayPendingSubmission(input())).toEqual({ ok: false, reason: "The in-review draft's sign-offs could not be voided (denied) — the draft is still in review." });
    s.voidPendingDraft.mockResolvedValueOnce(null);
    expect((await retireStrayPendingSubmission(input())).ok).toBe(false);
    expect(s.log).not.toHaveBeenCalled();
  });

  it("a record that cannot be written is returned (never swallowed); a different draft voided in the instant between is recorded as such and said", async () => {
    s.log.mockResolvedValueOnce({ error: "audit refused", ok: false });
    expect(await retireStrayPendingSubmission(input())).toEqual({ ok: true, voidedVersionId: "v2", recordError: "audit refused" });
    s.voidPendingDraft.mockResolvedValueOnce("v9");
    const r = await retireStrayPendingSubmission(input());
    expect(r.ok).toBe(false);
    expect(s.log.mock.calls.at(-1)![0].details).toMatchObject({ versionId: "v9", shownVersionId: "v2", sameAsShown: false });
  });

  it("the action is registered for the viewers (filterable, counted as destructive — the voided sign-offs never return)", async () => {
    const { auditActionDef, isDestructiveAuditAction } = await import("@/lib/auditActions");
    expect(auditActionDef("PENDING_SUBMISSION_RETIRED")).not.toBeNull();
    expect(isDestructiveAuditAction("PENDING_SUBMISSION_RETIRED")).toBe(true);
  });
});
