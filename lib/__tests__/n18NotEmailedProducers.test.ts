// notifications Round G — N18 DELIVERY RECORD, drafting-flow EVID-9 dw2: the
// person still gets exactly the notices they get today, per producer, and a
// person their own preference keeps from an email now leaves a not_emailed
// record. Through the REAL modules — lib/notify/dispatch.ts emit() →
// lib/notifications.ts queueEmail → the shared client (an in-memory
// PostgREST stand-in that answers email_gate() and, before 20261258, refuses
// a not_emailed row with the status CHECK's 23514). Only the bell writer is
// a recorder.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetState, type MemoryState } from "./helpers/memoryDb";

const h = vi.hoisted(() => ({
  state: null as unknown as MemoryState,
  many: [] as Array<{ userIds: string[] }>,
  pasted258: false,
  /** uid → email off */
  off: new Set<string>(),
}));

vi.mock("@/lib/supabase", async () => {
  const mem = await import("./helpers/memoryDb");
  h.state = mem.freshState();
  const base = mem.makeSupabase(h.state);
  return {
    supabase: {
      ...base,
      from: (t: string) => {
        const c = base.from(t) as Record<string, (...a: unknown[]) => unknown>;
        if (t !== "email_notifications") return c;
        return new Proxy(c, {
          get(target, prop: string) {
            if (prop === "insert") {
              return (row: Record<string, unknown>) => (row.status === "not_emailed" && !h.pasted258
                ? Promise.resolve({ data: null, error: { code: "23514", message: 'new row for relation "email_notifications" violates check constraint "email_notifications_status_check"' } })
                : target.insert(row));
            }
            return target[prop];
          },
        });
      },
    },
  };
});
vi.mock("@/lib/inAppNotifications", async (orig) => ({
  ...(await orig<typeof import("@/lib/inAppNotifications")>()),
  notifyMany: vi.fn(async (input: { userIds: string[] }) => { h.many.push(input); return { sent: input.userIds.length, failed: 0 }; }),
}));

import { emit, type EmitInput } from "@/lib/notify/dispatch";

const ORG = "o-1";
const DOC = "3f2b8c14-9d7a-4e11-b0f3-5a6c9e2d4188";
beforeEach(() => {
  resetState(h.state);
  h.many.length = 0;
  h.pasted258 = false;
  h.off = new Set();
  h.state.tables.org_members = ["alice", "bob", "actor"].map((uid) => ({ org_id: ORG, uid, status: "active", role: "Engineer", roles: null, email: `${uid}@x.com` }));
  // email_gate(): the recipient's master switch (no resource → no repeat check)
  h.state.rpc = { email_gate: (args) => ({ data: !h.off.has(String(args.p_to_user)), error: null }) };
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
const ev = (over: Partial<EmitInput> = {}): EmitInput => ({
  orgId: ORG, category: "assignment", kind: "ticket_assigned", title: "Review DWG-1042", body: "b",
  resource: { type: "document", id: DOC }, actorUserId: "actor", actorName: "Pat",
  audience: { involved: ["alice", "bob", "actor"] }, channels: ["inapp", "email"], ...over,
});
const mail = () => h.state.tables.email_notifications ?? [];

describe("EVID-9 dw2 (N18) — emit(): every recipient gets the notices they get today; an opt-out is recorded", () => {
  it("REGRESSION (no opt-outs): both recipients get the bell row and a queued email; nothing else is written", async () => {
    const r = await emit(ev());
    expect(r).toEqual({ recipients: 2, inapp: { sent: 2, failed: 0 } });
    expect(h.many[0].userIds.sort()).toEqual(["alice", "bob"]);
    expect(mail().map((m) => `${m.to_user_id}:${m.status}`).sort()).toEqual(["alice:queued", "bob:queued"]);
  });

  it("after 20261258: Bob turned email off — he still gets the bell row; no email is queued for him; one not_emailed record names him and the item", async () => {
    h.pasted258 = true;
    h.off.add("bob");
    const r = await emit(ev());
    expect(r).toEqual({ recipients: 2, inapp: { sent: 2, failed: 0 } });
    expect(h.many[0].userIds.sort()).toEqual(["alice", "bob"]);
    expect(mail().map((m) => `${m.to_user_id}:${m.status}`).sort()).toEqual(["alice:queued", "bob:not_emailed"]);
    expect(mail().find((m) => m.to_user_id === "bob")).toMatchObject({ resource_id: DOC, resource_type: "document", event_type: "assignment", subject: "Review DWG-1042" });
  });

  it("BEFORE 20261258: the same event — Bob's bell row, Alice's email, and nothing for Bob at all (today's path)", async () => {
    h.off.add("bob");
    await emit(ev());
    expect(h.many[0].userIds.sort()).toEqual(["alice", "bob"]);
    expect(mail().map((m) => `${m.to_user_id}:${m.status}`)).toEqual(["alice:queued"]);
  });

  it("an in-app-only notice (channels: ['inapp']) writes no email row and no record, as before", async () => {
    h.pasted258 = true;
    h.off.add("bob");
    await emit(ev({ channels: ["inapp"] }));
    expect(mail()).toEqual([]);
  });

  it("a member with no address on record is not 'their choice': no record (the email leg skips them, as before)", async () => {
    h.pasted258 = true;
    h.off.add("bob");
    h.state.tables.org_members = h.state.tables.org_members!.map((m) => (m.uid === "bob" ? { ...m, email: null } : m));
    await emit(ev());
    expect(mail().map((m) => `${m.to_user_id}:${m.status}`)).toEqual(["alice:queued"]);
  });
});
