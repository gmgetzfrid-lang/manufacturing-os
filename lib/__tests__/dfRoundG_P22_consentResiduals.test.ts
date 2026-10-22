// drafting-flow Round G, DF-P22 — the DF-P7 residuals that live outside the
// cron step (its two are pinned in consentWindowScan.test.ts):
//   (a) holdersFor stops naming a running consent window's people as waited
//       on — they are told, not awaited ("may object until …");
//   (c) nudgeStaleTicketHolders takes a recorded SYSTEM actor (no uid), so
//       the PHYS-18 copy recall can run on a consent-completed issue — a
//       person's recall is exactly as before.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { holdersFor, rosterHolderUids, explainNoActions } from "@/lib/ticketAttention";
import type { Ticket, TicketReviewRoster, TicketReviewSlot } from "@/types/schema";

const sent = vi.hoisted(() => ({ emits: [] as Array<Record<string, unknown>>, audits: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: async (input: Record<string, unknown>) => { sent.emits.push(input); return { recipients: 1 }; } }));
vi.mock("@/lib/audit", () => ({
  logAuditAction: async (entry: Record<string, unknown>) => { sent.audits.push(entry); return { ok: true, error: null }; },
  logRevisionEvent: async () => ({ ok: true, error: null }),
}));
import { nudgeStaleTicketHolders } from "@/lib/staleCopies";

const slot = (over: Partial<TicketReviewSlot> & { kind: string }): TicketReviewSlot => ({
  id: `r:${over.kind}`, label: over.kind, mode: "blocking", primaries: [], alternates: [], overriders: [], independentOf: [],
  timeoutDays: null, fallback: false, status: "open", ...over,
});
const roster = (slots: TicketReviewSlot[], window: Partial<NonNullable<TicketReviewRoster["consentWindow"]>> | null): TicketReviewRoster => ({
  v: 1, id: "r1", openedAt: "2026-10-19T09:00:00Z", openedBy: "d-1", level: "library", cycle: "1A", contentHash: "h", files: [], slots,
  ...(window ? { consentWindow: { slot: "ops", openedAt: "2026-10-19T09:00:00Z", warnAt: "2026-10-21T09:00:00Z", closesAt: "2026-10-22T09:00:00Z", recipients: ["o-1", "o-2"], ...window } } : {}),
});
const ticket = (r: TicketReviewRoster): Ticket => ({
  id: "t1", status: "PENDING_REVIEW", requesterId: "req", requesterName: "Rita", assignedDrafterId: "d-1", assignedDrafterName: "Dee",
  metadata: { review_roster: r },
} as unknown as Ticket);
const names = new Map([["o-1", "Olga"], ["o-2", "Omar"], ["q-1", "Quinn"]]);
const ops = (over: Partial<TicketReviewSlot> = {}) => slot({ kind: "ops", label: "Operations", mode: "consent_window", primaries: ["o-1", "o-2"], ...over });

describe("DF-P22 (a) — holdersFor: a running window's people are told, not waited on", () => {
  it("the window's slot is the only one open: the review waits on nobody's sign-off, and the line says who may object until when", () => {
    const h = holdersFor(ticket(roster([slot({ kind: "accept", status: "satisfied", satisfiedBy: "req", primaries: ["req"] }), ops()], {})), { memberNames: names });
    expect(h).toEqual([{ kind: "consent_window", uid: null, name: 'nobody\'s sign-off — "Operations" goes ahead unless someone objects', part: "Olga, Omar may object until 2026-10-22 09:00 UTC" }]);
    // DF-P22 fix pass: the line the request page renders reads correctly after its fixed "Waiting on".
    const page = readFileSync(join(process.cwd(), "app/(protected)/requests/[id]/page.tsx"), "utf8");
    expect(page).toContain("Waiting on {holders.map((h) => h.name).join(', ') || 'nobody'}");
    expect(page).toContain("{holders[0] && <span className=\"text-[var(--color-text-muted)]\"> ({holders[0].part})</span>}");
    expect(`Waiting on ${h.map((x) => x.name).join(", ")} (${h[0].part})`)
      .toBe('Waiting on nobody\'s sign-off — "Operations" goes ahead unless someone objects (Olga, Omar may object until 2026-10-22 09:00 UTC)');
    // nobody asked is named as waited on
    expect(h.some((x) => x.uid === "o-1" || x.uid === "o-2")).toBe(false);
  });
  it("another slot is open too: the review waits on THAT slot's people alone; the window's people are not in the line", () => {
    const h = holdersFor(ticket(roster([slot({ kind: "qa", label: "QA", primaries: ["q-1"] }), ops()], {})), { memberNames: names });
    expect(h).toEqual([{ kind: "co_reviewers", uid: "q-1", name: "Quinn", part: "QA" }]);
  });
  it("names the window's people only when every one is known; otherwise 'the people it asked'", () => {
    const h = holdersFor(ticket(roster([ops()], {})), { memberNames: new Map([["o-1", "Olga"]]) });
    expect(h[0].part).toBe("the people it asked may object until 2026-10-22 09:00 UTC");
  });
  it("REGRESSION: no window, an objected window, an expired window — the consent slot's occupants are waited on exactly as before", () => {
    for (const w of [null, { objectedAt: "2026-10-20T10:00:00Z", objectedBy: "o-1" }, { expiredAt: "2026-10-22T09:00:00Z" }]) {
      const h = holdersFor(ticket(roster([ops()], w)), { memberNames: names });
      expect(h, JSON.stringify(w)).toEqual([
        { kind: "co_reviewers", uid: "o-1", name: "Olga", part: "Operations" },
        { kind: "co_reviewers", uid: "o-2", name: "Omar", part: "Operations" },
      ]);
    }
  });
  it("REGRESSION: a roster with no consent slot is answered exactly as before", () => {
    const h = holdersFor(ticket(roster([slot({ kind: "qa", label: "QA", primaries: ["q-1"] })], null)), { memberNames: names });
    expect(h).toEqual([{ kind: "co_reviewers", uid: "q-1", name: "Quinn", part: "QA" }]);
  });
  it("the page still learns the window's people's names (rosterHolderUids), and 'not your turn' reads as a pool", () => {
    const t = ticket(roster([ops()], {}));
    expect(rosterHolderUids(t)).toEqual(["o-1", "o-2"]);
    const holders = holdersFor(t, { memberNames: names });
    const why = explainNoActions(t, { uid: "d-1", roles: ["Drafter"], holders } as never);
    expect(why.text).toMatch(/this step is not yours/);
  });
});

describe("DF-P22 (c) — nudgeStaleTicketHolders: a recorded system actor", () => {
  beforeEach(() => { sent.emits = []; sent.audits = []; });
  const holder = { userId: "u-1", userEmail: "u-1@x.io", lastCopiedAt: "2026-10-01T00:00:00Z", copies: [{ attachmentId: "a1", rev: "A", copiedAt: "2026-10-01T00:00:00Z", source: null, verdict: "superseded" as const, underReview: false }], outdated: true, hasCurrent: false };
  it("system actor: no actor uid on the notice, the audit row's user is the system (no uid), the actor named in details", async () => {
    const n = await nudgeStaleTicketHolders({ orgId: "o1", ticketId: "t1", ticketNumber: "REQ-1", latestIssuedRev: "1", holders: [holder], actorUserId: null, systemActor: "system:consent-window", actorName: "system:consent-window", source: "auto" });
    expect(n).toBe(1);
    expect(sent.emits).toHaveLength(1);
    expect(sent.emits[0].actorUserId).toBeUndefined();
    expect(sent.emits[0]).toMatchObject({ actorName: "System", audience: { involved: ["u-1"] }, kind: "doc_recalled" });
    expect(sent.audits).toHaveLength(1);
    expect(sent.audits[0]).toMatchObject({ action: "DISTRIBUTION_RECALL", userId: "system", userEmail: "system:consent-window", userRole: "system", details: { systemActor: "system:consent-window", source: "auto", recipientCount: 1 } });
  });
  it("REGRESSION: a person's recall is exactly as before (their uid on both, no system fields)", async () => {
    await nudgeStaleTicketHolders({ orgId: "o1", ticketId: "t1", ticketNumber: "REQ-1", latestIssuedRev: "1", holders: [holder], actorUserId: "p-1", actorName: "p@x.io", source: "manual" });
    expect(sent.emits[0]).toMatchObject({ actorUserId: "p-1", actorName: "p@x.io" });
    expect(sent.audits[0]).toMatchObject({ userId: "p-1", userEmail: "p@x.io" });
    expect(sent.audits[0]).not.toHaveProperty("userRole");
    expect(sent.audits[0].details).not.toHaveProperty("systemActor");
  });
  it("an unavailable record tells nobody and records it, for a system actor too", async () => {
    const n = await nudgeStaleTicketHolders({ orgId: "o1", ticketId: "t1", ticketNumber: null, latestIssuedRev: null, holders: [], actorUserId: null, systemActor: "system:consent-window", unavailable: true, source: "auto" });
    expect(n).toBe(0);
    expect(sent.emits).toEqual([]);
    expect(sent.audits[0]).toMatchObject({ userId: "system", details: { unavailable: true, systemActor: "system:consent-window" } });
  });
});
