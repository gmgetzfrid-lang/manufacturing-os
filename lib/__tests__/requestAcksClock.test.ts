// DIST-12 / DIST-13 — the overdue clock is evidence, and a recall is never
// ticket noise.
//
//   · requestAcks must never rewrite requested_at for a recipient who
//     already has an outstanding row: new recipients get a row + request,
//     existing pending ones get a REMINDER with their clock untouched, and
//     confirmed ones are left alone entirely.
//   · The recall notification category must route around the ticket-status
//     email toggle (source pins — the mapping is private to dispatch).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  existing: [] as Array<{ recipient_user_id: string; acknowledged_at: string | null }>,
  upserts: [] as Array<{ rows: Array<Record<string, unknown>>; opts: Record<string, unknown> }>,
  emits: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase", () => {
  function chain() {
    const c: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) =>
            resolve({ data: state.existing, error: null });
        }
        return (...args: unknown[]) => {
          if (prop === "upsert") {
            state.upserts.push({ rows: args[0] as Array<Record<string, unknown>>, opts: args[1] as Record<string, unknown> });
            return Promise.resolve({ data: null, error: null });
          }
          return new Proxy(c, handler);
        };
      },
    };
    return new Proxy(c, handler);
  }
  return { supabase: { from: () => chain() } };
});
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn() }));
vi.mock("@/lib/notify/dispatch", () => ({
  emit: vi.fn(async (p: Record<string, unknown>) => { state.emits.push(p); }),
}));

import { requestAcks } from "@/lib/distributionAcks";

beforeEach(() => {
  state.existing = [];
  state.upserts = [];
  state.emits = [];
});

const base = {
  orgId: "org1", documentId: "d1", docLabel: "P-101",
  versionId: "v5", revLabel: "5",
  actorUserId: "ctrl", actorName: "Document Control",
};

describe("requestAcks clock preservation (DIST-12)", () => {
  it("splits new vs already-asked: rows only for the new, reminder for the pending, clock untouched", async () => {
    state.existing = [{ recipient_user_id: "u-pending", acknowledged_at: null }];
    const res = await requestAcks({
      ...base,
      recipients: [{ uid: "u-new", email: "n@x.co" }, { uid: "u-pending", email: "p@x.co" }],
    });
    expect(res).toEqual({ requested: 1, reminded: 1 });
    // Only the NEW recipient gets a row…
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0].rows.map((r) => r.recipient_user_id)).toEqual(["u-new"]);
    // …and even a race cannot rewrite an existing clock.
    expect(state.upserts[0].opts).toMatchObject({ ignoreDuplicates: true });
    // Two emits: the request to the new, the reminder to the pending.
    expect(state.emits).toHaveLength(2);
    expect((state.emits[0].audience as { involved: string[] }).involved).toEqual(["u-new"]);
    expect(String(state.emits[0].title)).toContain("Please confirm");
    expect((state.emits[1].audience as { involved: string[] }).involved).toEqual(["u-pending"]);
    expect(String(state.emits[1].title)).toContain("Reminder");
  });

  it("leaves an already-confirmed recipient entirely alone", async () => {
    state.existing = [{ recipient_user_id: "u-done", acknowledged_at: "2026-08-20T00:00:00Z" }];
    const res = await requestAcks({ ...base, recipients: [{ uid: "u-done" }] });
    expect(res).toEqual({ requested: 0, reminded: 0 });
    expect(state.upserts).toHaveLength(0);
    expect(state.emits).toHaveLength(0);
  });

  it("notify:false creates the roster silently (the recall path's own notification stands)", async () => {
    const res = await requestAcks({ ...base, recipients: [{ uid: "u-new" }], notify: false });
    expect(res.requested).toBe(1);
    expect(state.upserts).toHaveLength(1);
    expect(state.emits).toHaveLength(0);
  });
});

describe("recall email routing (DIST-13, source pins)", () => {
  it("dispatch maps the recall category around every mutable toggle", () => {
    const src = readFileSync(join(process.cwd(), "lib", "notify", "dispatch.ts"), "utf8");
    expect(src).toMatch(/case "recall": return "safety_recall";/);
    // shouldSendForEvent has no case for safety_recall, so it falls to the
    // always-send default — pin that no one adds a suppression case.
    const prefs = readFileSync(join(process.cwd(), "lib", "notifications.ts"), "utf8");
    expect(prefs).not.toMatch(/safety_recall/);
  });

  it("both recall emitters use the recall category, never ticket-status", () => {
    const src = readFileSync(join(process.cwd(), "lib", "staleCopies.ts"), "utf8");
    const categories = src.match(/category: "(\w+)"/g) ?? [];
    expect(categories).toEqual(['category: "recall"', 'category: "recall"']);
  });
});
