// notifications Round G — N15, DELIV-16: emit()'s in-app leg writes a
// COMPLIANCE kind's bell rows (and any row the producer asks to be retried —
// `inappRetry`) through lib/complianceNotify.ts notifyCompliance, one per
// recipient, with the scan's retry key; every other kind still goes through
// notifyMany, exactly as before. The producers in lib/distributionAcks.ts,
// lib/postPublish.ts, lib/staleCopies.ts, lib/revisionImpact.ts,
// lib/workPackages.ts and the intake door reach it through emit().

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resetState, type MemoryState } from "./helpers/memoryDb";

const h = vi.hoisted(() => ({
  state: null as unknown as MemoryState,
  compliance: [] as Array<{ input: Record<string, unknown>; opts?: Record<string, unknown> }>,
  many: [] as Array<Record<string, unknown>>,
  failFor: new Set<string>(),
}));

vi.mock("@/lib/supabase", async () => {
  const mem = await import("./helpers/memoryDb");
  h.state = mem.freshState();
  return { supabase: mem.makeSupabase(h.state) };
});
vi.mock("@/lib/notifications", () => ({ queueEmail: vi.fn(async () => undefined) }));
vi.mock("@/lib/complianceNotify", () => ({
  notifyCompliance: vi.fn(async (input: Record<string, unknown>, opts?: Record<string, unknown>) => {
    h.compliance.push({ input, opts });
    return !h.failFor.has(String(input.userId));
  }),
}));
vi.mock("@/lib/inAppNotifications", async (orig) => ({
  ...(await orig<typeof import("@/lib/inAppNotifications")>()),
  notifyMany: vi.fn(async (input: Record<string, unknown>) => { h.many.push(input); return { sent: (input.userIds as string[]).length, failed: 0 }; }),
}));

import { emit, type EmitInput } from "@/lib/notify/dispatch";

const ORG = "o-1";
beforeEach(() => {
  resetState(h.state);
  h.compliance.length = 0; h.many.length = 0; h.failFor.clear();
  h.state.tables.org_members = ["a", "b", "actor"].map((uid) => ({ org_id: ORG, uid, status: "active", role: "Engineer", roles: null, email: `${uid}@x.com` }));
});
const ev = (over: Partial<EmitInput>): EmitInput => ({
  orgId: ORG, category: "assignment", kind: "ack_requested", title: "Confirm P-1 Rev C", body: "b",
  resource: { type: "document", id: "d-1" }, actorUserId: "actor", actorName: "Pat",
  audience: { involved: ["a", "b", "actor"] }, channels: ["inapp"], ...over,
});

describe("DELIV-16 (N15) — emit()'s in-app leg retries a compliance kind's rows", () => {
  it("a compliance kind: one notifyCompliance per recipient (the actor left out), the same row fields; notifyMany not used", async () => {
    const r = await emit(ev({}));
    expect(h.many).toHaveLength(0);
    expect(h.compliance.map((c) => c.input.userId).sort()).toEqual(["a", "b"]);
    expect(h.compliance[0].input).toMatchObject({ orgId: ORG, kind: "ack_requested", title: "Confirm P-1 Rev C", resourceType: "document", resourceId: "d-1", actorUserId: "actor", actorName: "Pat" });
    expect(h.compliance[0].opts).toBeUndefined();
    expect(r).toEqual({ recipients: 2, inapp: { sent: 2, failed: 0 } });
  });

  it("the answer counts a dead-lettered row as failed", async () => {
    h.failFor.add("b");
    expect((await emit(ev({}))).inapp).toEqual({ sent: 1, failed: 1 });
  });

  it("inappRetry routes a NON-compliance kind (the hold-aging nudge) with its retry key", async () => {
    await emit(ev({ kind: "hold_opened", inappRetry: { retryKey: "hold-aging:h1:age" } }));
    expect(h.many).toHaveLength(0);
    expect(h.compliance.every((c) => c.opts?.retryKey === "hold-aging:h1:age")).toBe(true);
  });

  it("REGRESSION: a non-compliance kind without inappRetry still goes through notifyMany, unchanged", async () => {
    await emit(ev({ kind: "checkout_message" }));
    expect(h.compliance).toHaveLength(0);
    expect(h.many).toHaveLength(1);
    expect((h.many[0].userIds as string[]).sort()).toEqual(["a", "b"]);
  });

  it("the producers: distributionAcks adopts notifyCompliance with one import line and keys its scan notices; package retirement and the hold notice retry", () => {
    const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    expect(read("lib/distributionAcks.ts")).toContain('import { notifyCompliance as notify } from "@/lib/complianceNotify";');
    expect(read("lib/distributionAcks.ts")).not.toMatch(/from "@\/lib\/inAppNotifications"/);
    expect(read("lib/distributionAcks.ts")).toMatch(/retryKey: `distribution-acks:\$\{r\.id as string\}`/);
    expect(read("lib/postPublish.ts")).toMatch(/const \{ notifyCompliance: notify \} = await import\("@\/lib\/complianceNotify"\);[\s\S]*?void notify\(\{\s*orgId: input\.orgId,\s*userId: p\.owner_user_id,/);
    expect(read("lib/postPublish.ts")).not.toMatch(/notifyMany\(|import\("@\/lib\/inAppNotifications"\)/);
    expect(read("lib/holds.ts")).toMatch(/inappRetry: \{\},/);
    expect(read("lib/holds.ts")).toMatch(/inappRetry: \{ retryKey \},/);
    // the other producers write through emit() only — its in-app leg covers them
    for (const f of ["lib/staleCopies.ts", "lib/revisionImpact.ts", "lib/workPackages.ts", "app/api/intake/upload/route.ts"]) {
      expect(read(f), f).not.toMatch(/\bnotifyMany\(|\bnotify\(\{|notifyBatchWithReason\(/);
    }
  });
});

describe("DELIV-7 dw1 (N15) — scanDistributionAcks: a dead-lettered nudge is not marked sent; the next run nudges that recipient again", () => {
  const seedAcks = () => {
    h.state.tables.distribution_acks = [
      { id: "a1", org_id: ORG, document_id: "d-1", version_id: "v-1", rev_label: "C", recipient_user_id: "a", recipient_email: "a@x.com", requested_by: "actor", requested_at: "2026-09-01T00:00:00Z", acknowledged_at: null },
      { id: "a2", org_id: ORG, document_id: "d-1", version_id: "v-1", rev_label: "C", recipient_user_id: "b", recipient_email: "b@x.com", requested_by: "actor", requested_at: "2026-09-01T00:00:00Z", acknowledged_at: null },
    ];
    h.state.tables.documents = [{ id: "d-1", library_id: "lib-1", document_number: "P-1", current_version_id: "v-1", status: "Issued" }];
    h.state.tables.notifications = [];
  };

  it("each nudge goes through notifyCompliance with its row's retry key; the escalation with its own", async () => {
    seedAcks();
    const { scanDistributionAcks } = await import("@/lib/distributionAcks");
    await scanDistributionAcks(ORG);
    const keys = h.compliance.map((c) => [c.input.kind, c.input.userId, c.opts?.retryKey]);
    expect(keys).toEqual(expect.arrayContaining([
      ["ack_requested", "a", "distribution-acks:a1"],
      ["ack_requested", "b", "distribution-acks:a2"],
      ["ack_overdue", "actor", "distribution-acks:escalation:actor:d-1"],
    ]));
  });

  it("b's nudge dead-lettered (no row); a's landed (its row is the watermark): the next run nudges b again and not a", async () => {
    seedAcks();
    const { scanDistributionAcks } = await import("@/lib/distributionAcks");
    // the first run: a's row landed, b's did not — only a's row is in the table
    h.state.tables.notifications = [
      { org_id: ORG, user_id: "a", kind: "ack_requested", resource_id: "d-1", metadata: { ackRequest: true, autoNag: true }, created_at: new Date().toISOString() },
      { org_id: ORG, user_id: "actor", kind: "ack_overdue", resource_id: "d-1", metadata: { ackEscalation: true }, created_at: new Date().toISOString() },
    ];
    // document-control P39 (DIST-20 — declared to notifications): once the
    // document notice record is in place the nag's cooldown reads it ONLY;
    // the landed nudge and escalation are rows there too (P38 writes them
    // beside the bell rows), and b's dead-lettered nudge is in neither
    h.state.tables.document_notice_events = [
      { id: "e-a", org_id: ORG, document_id: "d-1", source: "distribution_ack", kind: "reminded", recipient: "a", noticed_at: new Date().toISOString() },
      { id: "e-x", org_id: ORG, document_id: "d-1", source: "distribution_ack", kind: "escalated", recipient: "actor", noticed_at: new Date().toISOString() },
    ];
    h.compliance.length = 0;
    await scanDistributionAcks(ORG);
    expect(h.compliance.map((c) => `${c.input.kind}:${c.input.userId}`)).toEqual(["ack_requested:b"]);
  });
});
