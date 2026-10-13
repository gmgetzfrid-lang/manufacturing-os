// drafting-flow Round G, DF-P2 — lib/transitionIn.ts flagCollisionToDrafting
// files its ticket through /api/tickets/create.
//
// REGRESSION: the IntakePanel's "flag to drafting" still returns the ticket
// number it filed and writes the INTAKE_COLLISION_FLAGGED audit row; the
// ticket, its number and the queue's notice are the route's (no browser
// insert, no browser emit — the route test drives those end to end).

import { describe, it, expect, vi, beforeEach } from "vitest";

const s = vi.hoisted(() => ({
  submit: vi.fn(),
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  intakeLink: "link-1" as string | null,
}));

vi.mock("@/lib/supabase", () => {
  const from = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "order"]) q[m] = () => q;
    q.limit = async () => ({ data: table === "document_versions" && s.intakeLink ? [{ intake_link_id: s.intakeLink }] : [], error: null });
    q.insert = (row: Record<string, unknown>) => {
      s.inserts.push({ table, row });
      return { then: (ok: (v: unknown) => unknown) => Promise.resolve(ok({ data: null, error: null })) };
    };
    return q;
  };
  return { supabase: { from } };
});
vi.mock("@/lib/ticketCreateClient", async (orig) => ({
  ...(await orig<typeof import("@/lib/ticketCreateClient")>()),
  submitTicketCreate: (...a: unknown[]) => s.submit(...a),
}));

import { flagCollisionToDrafting, type TransitionCandidate, type TransitionImpact } from "@/lib/transitionIn";
import { MAX_DESCRIPTION } from "@/lib/ticketCreate";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "ffffffff-0000-4000-8000-000000000001";
const candidate = { docId: "doc-new", label: "P-101 (contractor)", number: "P-101", title: "Flare header", rev: "0", status: "Draft", company: "Acme", submittedAt: null } as TransitionCandidate;
const impact = {
  numberCollision: { id: "doc-old", label: "P-101", rev: "4" },
  overlapDocs: [{ id: "doc-2", label: "P-102", rev: "2", sharedTags: ["V-1"] }],
} as unknown as TransitionImpact;

beforeEach(() => {
  s.submit.mockReset();
  s.inserts = [];
  s.intakeLink = "link-1";
});

describe("flagCollisionToDrafting → /api/tickets/create", () => {
  it("posts the collision in the create contract, returns the route's number, and writes the flag's audit row", async () => {
    s.submit.mockResolvedValue({ ok: true, id: "t-9", ticketNumber: "KE-DDRT-26-0009", resumed: false });
    const res = await flagCollisionToDrafting({ orgId: ORG, projectId: PROJECT, candidate, impact, actorId: "u-1", actorEmail: "rita@plant.io", actorRole: null });
    expect(res).toEqual({ ok: true, ticketNumber: "KE-DDRT-26-0009" });
    const body = s.submit.mock.calls[0][0];
    expect(body).toMatchObject({
      orgId: ORG, title: "Intake collision: P-101 (contractor)", requestType: "Revision", priority: 1, unit: null, requesterRole: null,
      sourceDocuments: [{ id: "doc-new", documentNumber: "P-101", title: "Flare header", rev: "0", versionId: null }],
      origin: {
        kind: "intake_collision", projectId: PROJECT, intakeLinkId: "link-1", numberCollisionDocId: "doc-old",
        overlaps: [{ id: "doc-2", label: "P-102", sharedTags: ["V-1"] }], sheetLabel: "P-101 (contractor)",
      },
    });
    expect(body.description).toContain("NUMBER COLLISION — P-101 (Rev 4) already carries this number.");
    expect(body.description).toContain("OVERLAP — P-102 (Rev 2) shares equipment V-1");
    expect(s.inserts.map((i) => i.table)).toEqual(["audit_logs"]);   // no tickets insert, no notifications
    expect(s.inserts[0].row).toMatchObject({
      action: "INTAKE_COLLISION_FLAGGED", resource_id: "doc-new", org_id: ORG, user_id: "u-1",
      details: expect.objectContaining({ ticketNumber: "KE-DDRT-26-0009", ticketRef: "t-9", intakeLinkId: "link-1", projectId: PROJECT }),
    });
  });

  it("EDGE-8: filed but the assignment queue was not told — the flag stands and hands the flagger a warning saying so", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    s.submit.mockResolvedValue({ ok: true, id: "t-9", ticketNumber: "KE-DDRT-26-0009", resumed: false, notified: false, notifyReason: "the notice could not be written" });
    const res = await flagCollisionToDrafting({ orgId: ORG, projectId: PROJECT, candidate, impact, actorId: "u-1", actorEmail: null, actorRole: null });
    expect(res).toEqual({
      ok: true, ticketNumber: "KE-DDRT-26-0009",
      warning: "KE-DDRT-26-0009 is filed, but the assignment queue was not notified (the notice could not be written) — tell your supervisor it is waiting.",
    });
    expect(s.inserts.map((i) => i.table)).toEqual(["audit_logs"]);
  });

  it("a sheet overlapping hundreds of drawings still files: the written description is clipped to the contract's limit, never refused", async () => {
    s.submit.mockResolvedValue({ ok: true, id: "t-9", ticketNumber: "KE-DDRT-26-0009", resumed: false });
    const many = Array.from({ length: 400 }, (_, i) => ({ id: `d-${i}`, label: `P-${1000 + i} (a long drawing label for the register)`, rev: "1", sharedTags: ["V-1", "V-2", "P-3"] }));
    await flagCollisionToDrafting({ orgId: ORG, projectId: PROJECT, candidate, impact: { ...impact, overlapDocs: many } as unknown as TransitionImpact, actorId: "u-1", actorEmail: null, actorRole: null });
    const body = s.submit.mock.calls[0][0];
    expect(body.description.length).toBe(MAX_DESCRIPTION);
    expect(body.description.endsWith("…")).toBe(true);
    // the posted body carries every overlap the scan reported; the route
    // stores them whole (ticketCreateRoute.test.ts, "an intake collision's
    // overlap list is stored whole (or counted and flagged)")
    expect(body.origin.overlaps).toHaveLength(400);
  });

  it("a refusal from the route is the flag's answer, and no audit row claims a flag that was not filed", async () => {
    s.submit.mockResolvedValue({ ok: false, status: 503, error: "Couldn't read the source document — try again in a moment." });
    const res = await flagCollisionToDrafting({ orgId: ORG, projectId: PROJECT, candidate, impact: { ...impact, numberCollision: null } as unknown as TransitionImpact, actorId: "u-1", actorEmail: null, actorRole: null });
    expect(res).toEqual({ ok: false, error: "Couldn't read the source document — try again in a moment." });
    expect(s.inserts).toEqual([]);
    expect(s.submit.mock.calls[0][0]).toMatchObject({ priority: 2, origin: { numberCollisionDocId: null } });
  });
});
