// Round D2 — OWN-11 done-when 1: a completed review roster produces the SAME
// outcome regardless of which reviewer signs last. It never auto-publishes;
// it always routes to the named publishing authority (the document's
// effective owner and the org's controllers), who publish from the inspector
// under their own authority. Ownership means being the approval of revision.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  roster: [] as Array<Record<string, unknown>>,
  notified: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  finalizeCalls: 0,
}));
function chain(table: string) {
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => {
          if (table === "document_review_signoffs") return resolve({ data: state.roster, error: null });
          resolve({ data: [{ id: "so1" }], error: null });
        };
      }
      return (..._args: unknown[]) => {
        if (prop === "maybeSingle") {
          if (table === "documents") return Promise.resolve({ data: { owner_user_id: "owner1", owner_name: "Owner", collection_id: null }, error: null });
          if (table === "libraries") return Promise.resolve({ data: { review_control: { requireIndependentReviewer: true } }, error: null });
          return Promise.resolve({ data: null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock("@/lib/eSignatures", () => ({ recordSignature: vi.fn(async () => ({ id: "sig1" })) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async (n: Record<string, unknown>) => { state.notified.push(n); }) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async (a: Record<string, unknown>) => { state.audits.push(a); }) }));
vi.mock("@/lib/effectiveDate", () => ({ applyEffectiveDate: vi.fn(async () => undefined) }));
vi.mock("@/lib/ownership", () => ({
  effectiveOwnerForDocument: vi.fn(async () => ({ userId: "owner1", name: "Owner" })),
  resolveEffectiveOwner: vi.fn(() => ({ userId: "owner1", name: "Owner" })),
  getOrgControllers: vi.fn(async () => ["ctrl1", "ctrl2"]),
}));
import * as reviewControl from "@/lib/reviewControl";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const signed = (uid: string) => ({ id: `so-${uid}`, org_id: "org1", document_id: "doc1", document_version_id: "v1", reviewer_user_id: uid, reviewer_name: uid, slot: "primary", status: "signed", signature_id: `sig-${uid}`, activated: true, revision_label: "2A" });

beforeEach(() => { state.roster = []; state.notified = []; state.audits = []; state.finalizeCalls = 0; });

describe("OWN-11 done-when 1 — the last signature never publishes; it routes to the named authority", () => {
  it("a completed roster notifies the owner and every controller 'Ready to publish', whoever signed last, and writes the routing audit", async () => {
    state.roster = [signed("reviewer1"), signed("reviewer2")];
    const spy = vi.spyOn(reviewControl, "finalizeReviewedRevision");
    await reviewControl.recordReviewSignoff({
      orgId: "org1", documentId: "doc1", libraryId: "lib1", versionId: "v1", revisionLabel: "2A",
      signoffId: "so-reviewer2", signerUserId: "reviewer2", signerName: "Reviewer Two", statement: "Reviewed",
    });
    expect(spy).not.toHaveBeenCalled();
    const ready = state.notified.filter((n) => n.kind === "review_complete");
    expect(ready.map((n) => n.userId).sort()).toEqual(["ctrl1", "ctrl2", "owner1"]);
    for (const n of ready) {
      expect(n.title).toBe("Ready to publish: 2A");
      expect(String(n.body)).toMatch(/publish the revision from the inspector — it stays a draft until you do/);
      expect(String(n.title)).not.toMatch(/Published after review/);
    }
    const audit = state.audits.find((a) => a.action === "REVIEW_COMPLETE_AWAITING_PUBLISH")!;
    expect(audit).toBeTruthy();
    expect((audit.details as { routedTo: string[]; ownerUserId: string }).routedTo.sort()).toEqual(["ctrl1", "ctrl2", "owner1"]);
    expect((audit.details as { ownerUserId: string }).ownerUserId).toBe("owner1");
  });
  it("an incomplete roster tells the same people a reviewer signed, and never claims completion", async () => {
    state.roster = [signed("reviewer1"), { ...signed("reviewer2"), status: "pending", signature_id: null }];
    await reviewControl.recordReviewSignoff({
      orgId: "org1", documentId: "doc1", libraryId: "lib1", versionId: "v1", revisionLabel: "2A",
      signoffId: "so-reviewer1", signerUserId: "reviewer1", signerName: "Reviewer One", statement: "Reviewed",
    });
    expect(state.notified.every((n) => n.kind === "review_signed")).toBe(true);
    expect(state.audits.some((a) => a.action === "REVIEW_COMPLETE_AWAITING_PUBLISH")).toBe(false);
  });
  it("pinned at the source: no automatic publish remains in the sign-off path; the manual publish and intake approval keep finalizeReviewedRevision", () => {
    const rc = src("lib/reviewControl.ts");
    const signoff = rc.slice(rc.indexOf("export async function recordReviewSignoff"), rc.indexOf("// ── Completion + roster reads"));
    expect(signoff).not.toMatch(/finalizeReviewedRevision\(/);
    expect(signoff).not.toMatch(/autoPublished|AUTO-FINALIZE/);
    expect(signoff).toContain('action: "REVIEW_COMPLETE_AWAITING_PUBLISH"');
    expect(rc).toContain("export async function finalizeReviewedRevision(");
    expect(src("components/documents/ReviewGateSection.tsx")).toContain("await finalizeReviewedRevision({ orgId, documentId: doc.id, actorId: uid, actorName: userEmail });");
    expect(src("components/permissions/RoleModelTree.tsx")).toContain("A completed roster never publishes itself");
    expect(src("components/permissions/RoleModelTree.tsx")).not.toContain("triggers auto-finalize");
  });
});
