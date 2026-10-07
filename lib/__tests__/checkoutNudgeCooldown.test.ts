// OS-6 (notifications Round G, N9): the /checkouts "Nudge to coordinate"
// cooldown lives in what was SENT, not in one card's React state.
//
//   · lib/sentNotices.ts readNoticesISent — the member's own rows of the two
//     nudge kinds, through notifications_i_sent (20261191); before the paste
//     (42883 / PGRST202) it answers `available: false`, never "never sent";
//   · lib/checkoutNudge.ts — one nudge per (sender, recipient, document) per
//     24 h: the card's "Heads-up sent" from that read (nudgeState), the
//     writer's refusal with a sentence that names who and when
//     (sendCheckoutNudge), today's write when the read is unavailable;
//   · the page reads it (source pins): the overlap card's state is derived
//     from the server's answer as well as its own.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  rpc: null as null | { data?: unknown; error?: { code?: string; message?: string } | null },
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  notifyMany: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return state.rpc ?? { data: [], error: null };
    }),
  },
}));
vi.mock("@/lib/inAppNotifications", () => ({
  notifyMany: vi.fn(async (input: Record<string, unknown>) => { state.notifyMany.push(input); }),
}));

import { readNoticesISent, isMissingSentNotices } from "@/lib/sentNotices";
import {
  CHECKOUT_NUDGE_COOLDOWN_HOURS, nudgeKey, nudgeState, nudgeTargets, recentNudges, sendCheckoutNudge,
} from "@/lib/checkoutNudge";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const HOUR = 3_600_000;
const row = (userId: string, resourceId: string, hoursAgo: number) =>
  ({ user_id: userId, resource_type: "document", resource_id: resourceId, created_at: new Date(NOW - hoursAgo * HOUR).toISOString() });

beforeEach(() => {
  state.rpc = null;
  state.rpcCalls = [];
  state.notifyMany = [];
});

describe("readNoticesISent — the member's own nudges, read from the server", () => {
  it("calls notifications_i_sent with the kind, the window and the filters, and maps the rows", async () => {
    state.rpc = { data: [row("bob", "doc-b", 2)], error: null };
    const r = await readNoticesISent({ orgId: "o1", kind: "checkout_conflict", since: "2026-10-06T12:00:00.000Z", resourceType: "document", metadata: { nudge: true } });
    expect(state.rpcCalls).toEqual([{ fn: "notifications_i_sent", args: {
      p_org: "o1", p_kind: "checkout_conflict", p_since: "2026-10-06T12:00:00.000Z",
      p_resource_type: "document", p_resource_id: null, p_metadata: { nudge: true },
    } }]);
    expect(r).toEqual({ available: true, rows: [{ userId: "bob", resourceType: "document", resourceId: "doc-b", at: NOW - 2 * HOUR }] });
  });

  it("before 20261191 (PGRST202 / 42883 naming it) it is unavailable — never read as 'never sent'", async () => {
    state.rpc = { data: null, error: { code: "PGRST202", message: "Could not find the function public.notifications_i_sent" } };
    expect(await readNoticesISent({ orgId: "o1", kind: "overlap_advisory", since: "x" })).toEqual({ available: false, reason: "not_deployed" });
    state.rpc = { data: null, error: { code: "42883", message: "function notifications_i_sent(uuid, text) does not exist" } };
    expect(await readNoticesISent({ orgId: "o1", kind: "overlap_advisory", since: "x" })).toEqual({ available: false, reason: "not_deployed" });
    state.rpc = { data: null, error: { code: "57014", message: "statement timeout" } };
    expect(await readNoticesISent({ orgId: "o1", kind: "overlap_advisory", since: "x" })).toEqual({ available: false, reason: "error", error: "statement timeout" });
    expect(isMissingSentNotices({ code: "42883", message: "function other() does not exist" })).toBe(false);
  });
});

describe("the nudge targets and the card's state", () => {
  it("everyone in the overlap but the sender, once, with the first document (by id) they hold", () => {
    expect(nudgeTargets([
      { userId: "me", documentId: "d1" },
      { userId: "bob", documentId: "d9", userName: "Bob" },
      { userId: "bob", documentId: "d2" },
      { userId: "cy", documentId: null },
      { userId: "dee", documentId: "d3", userName: "Dee" },
    ], "me")).toEqual([
      { userId: "bob", documentId: "d2", name: "Bob" },
      { userId: "dee", documentId: "d3", name: "Dee" },
    ]);
  });

  it("'Heads-up sent' only when EVERY target was nudged in the window; the next nudge is possible 24 h after the earliest", () => {
    const targets = [{ userId: "bob", documentId: "d2" }, { userId: "dee", documentId: "d3" }];
    expect(nudgeState(targets, new Map([[nudgeKey(targets[0]), NOW - 2 * HOUR]]))).toEqual({ allSent: false, nextAt: null });
    expect(nudgeState(targets, new Map([[nudgeKey(targets[0]), NOW - 2 * HOUR], [nudgeKey(targets[1]), NOW - 5 * HOUR]])))
      .toEqual({ allSent: true, nextAt: NOW - 5 * HOUR + CHECKOUT_NUDGE_COOLDOWN_HOURS * HOUR });
    expect(nudgeState([], new Map())).toEqual({ allSent: false, nextAt: null });
  });

  it("recentNudges asks for the nudge rows of the last 24 h, about documents, marked as nudges", async () => {
    state.rpc = { data: [row("bob", "d2", 2), row("bob", "d2", 30)], error: null };
    const r = await recentNudges("o1", NOW);
    expect(state.rpcCalls[0].args).toMatchObject({
      p_kind: "checkout_conflict", p_since: new Date(NOW - 24 * HOUR).toISOString(), p_resource_type: "document", p_metadata: { nudge: true },
    });
    expect(r.known).toBe(true);
    expect([...r.sentAt.entries()]).toEqual([["bob:d2", NOW - 2 * HOUR]]); // the 30-hour-old one is outside the window
  });
});

describe("sendCheckoutNudge — the writer refuses a repeat inside the cooldown, with the reason", () => {
  const base = { orgId: "o1", actorUserId: "me", actorName: "Me", overlapKey: "asset:a1", what: "Pump P-101", names: "Bob, Dee", now: NOW };

  it("nudges only the people not nudged about their document in the last 24 h — each row names that document", async () => {
    state.rpc = { data: [row("bob", "d2", 3)], error: null };
    const out = await sendCheckoutNudge({ ...base, targets: [{ userId: "bob", documentId: "d2", name: "Bob" }, { userId: "dee", documentId: "d3", name: "Dee" }] });
    expect(out).toEqual({ sent: 1, skipped: [{ userId: "bob", documentId: "d2", name: "Bob" }] });
    expect(state.notifyMany).toEqual([expect.objectContaining({
      orgId: "o1", userIds: ["dee"], actorUserId: "me", kind: "checkout_conflict",
      title: "Coordinate — overlapping checkout",
      resourceType: "document", resourceId: "d3", metadata: { nudge: true, overlap: "asset:a1" }, link: "/checkouts",
    })]);
  });

  it("refuses when everyone was nudged — the sentence names who and when the next nudge is possible; nothing is written", async () => {
    state.rpc = { data: [row("bob", "d2", 3), row("dee", "d3", 1)], error: null };
    const out = await sendCheckoutNudge({ ...base, targets: [{ userId: "bob", documentId: "d2", name: "Bob" }, { userId: "dee", documentId: "d3", name: "Dee" }] });
    expect(out.sent).toBe(0);
    expect(out.refused).toMatch(/^You already nudged Bob, Dee about this in the last 24 hours — you can nudge again after .+\.$/);
    expect(out.refused).toContain(new Date(NOW - 3 * HOUR + 24 * HOUR).toLocaleString());
    expect(state.notifyMany).toEqual([]);
  });

  it("a nudge older than the cooldown does not hold the next one", async () => {
    state.rpc = { data: [row("bob", "d2", 25)], error: null };
    const out = await sendCheckoutNudge({ ...base, targets: [{ userId: "bob", documentId: "d2", name: "Bob" }] });
    expect(out).toEqual({ sent: 1, skipped: [] });
  });

  it("before 20261191 the read is unavailable and today's write goes out (the card's own state is the guard, as before)", async () => {
    state.rpc = { data: null, error: { code: "PGRST202", message: "not found" } };
    const out = await sendCheckoutNudge({ ...base, targets: [{ userId: "bob", documentId: "d2", name: "Bob" }] });
    expect(out).toEqual({ sent: 1, skipped: [] });
    expect(state.notifyMany).toHaveLength(1);
  });
});

describe("the /checkouts page reads the cooldown (source pins)", () => {
  const page = readFileSync(join(process.cwd(), "app/(protected)/checkouts/page.tsx"), "utf8");
  it("loads what this member nudged, derives the card's state from it, and toasts the writer's refusal", () => {
    expect(page).toMatch(/import \{[^}]*sendCheckoutNudge[^}]*\} from "@\/lib\/checkoutNudge"/);
    expect(page).toContain("recentNudges(");
    expect(page).toContain("nudgeState(");
    expect(page).toMatch(/refused/);
    expect(page).not.toMatch(/\bnotifyMany\(/); // the page writes through the module only
  });
});
