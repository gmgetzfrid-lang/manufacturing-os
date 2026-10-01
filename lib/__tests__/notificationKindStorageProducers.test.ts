// notifications Round G, N2 KIND-REGISTRY — PROD-10 / TAX-11 / NEDGE-13:
// the two storage watchdogs write their bell rows through notify()'s typed
// insert, as the service role they run under, with a kind the registry
// classifies — never a raw insert with a kind no union declares.
//
// Nothing here mocks lib/supabase or lib/inAppNotifications: the shared
// client really is bound to the watchdog's client for the write (if it were
// not, the insert would go to the anonymous client and never reach `sb`).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const GiB = 1024 * 1024 * 1024;
const r2State = vi.hoisted(() => ({ bytes: 0 }));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "test-bucket",
  r2: { send: async () => ({ Contents: [{ Key: "orgs/o1/libraries/l1/a.pdf", Size: r2State.bytes }], IsTruncated: false }) },
}));

import { runStorageAlerts } from "@/lib/storageAlerts";
import { runPlatformStorageAlerts } from "@/lib/storageUsage";
import { supabase, __setServerSupabaseClient, __resetServerSupabaseClient } from "@/lib/supabase";
import { runWithServerClient } from "@/lib/serverClientScope";
import { isNotificationKind, KIND_META } from "@/lib/notificationKinds";

type Call = { table: string; op: string; args: unknown[] };
const world = {
  calls: [] as Call[],
  inserts: [] as Array<Record<string, unknown>>,
  existing: new Set<string>(),     // user ids that already have a recent row
  insertError: null as { message: string } | null,
  tableBytes: 0,
};
beforeEach(() => {
  world.calls = [];
  world.inserts = [];
  world.existing = new Set();
  world.insertError = null;
  world.tableBytes = 0;
  r2State.bytes = 0;
});

/** Marks every builder the double hands out, so a probe can tell whether
 *  the shared client resolved to the double or to the anonymous client. */
const DOUBLE = Symbol("service-role double");

/** A service-role client double: a chainable builder per table. */
function fakeServiceClient(): SupabaseClient {
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let op = "select";
    const q: Record<PropertyKey, unknown> = { [DOUBLE]: true };
    const result = () => {
      if (table === "notifications" && op === "insert") return { data: null, error: world.insertError };
      if (table === "notifications") {
        const uid = filters.find(([c]) => c === "user_id")?.[1] as string;
        return { data: null, error: null, count: world.existing.has(uid) ? 1 : 0 };
      }
      if (table === "archive_settings") return { data: [{ org_id: "o1", quota_bytes: 100 }], error: null };
      if (table === "org_members") return { data: [{ uid: "a1" }, { uid: "a2" }], error: null };
      if (table === "orgs") return { data: [{ id: "o1" }], error: null };
      return { data: null, error: null };
    };
    for (const m of ["select", "not", "or", "gte", "order", "limit"]) q[m] = (...args: unknown[]) => { world.calls.push({ table, op: m, args }); return q; };
    q.eq = (c: string, v: unknown) => { filters.push([c, v]); world.calls.push({ table, op: "eq", args: [c, v] }); return q; };
    q.insert = (row: Record<string, unknown>) => { op = "insert"; world.inserts.push({ table, ...row }); return q; };
    q.maybeSingle = async () => ({ data: null, error: null });
    q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, ko);
    return q;
  };
  const rpc = async (fn: string) => {
    if (fn === "mfg_table_stats") return { data: [{ total_bytes: world.tableBytes }], error: null };
    return { data: [], error: null };
  };
  return { from, rpc } as unknown as SupabaseClient;
}

describe("runStorageAlerts — the quota watermark (lib/storageAlerts.ts)", () => {
  it("writes through notify() as the service role, with the declared kind storage_alert", async () => {
    world.tableBytes = 95; // 95% of a 100-byte quota: critical
    const sb = fakeServiceClient();
    const r = await runStorageAlerts(sb);
    expect(r.alerts).toBe(2);
    const rows = world.inserts.filter((i) => i.table === "notifications");
    expect(rows).toHaveLength(2);
    for (const [i, uid] of ["a1", "a2"].entries()) {
      // notify()'s full column set (a raw insert wrote only six of them)
      expect(rows[i]).toEqual({
        table: "notifications", org_id: "o1", user_id: uid, kind: "storage_alert",
        title: "Storage critical — 95% full",
        body: "This workspace is at 95% of its storage limit. Take a full backup and free up space (archive superseded revisions, purge disposable rows).",
        link: "/admin/storage", resource_type: null, resource_id: null, actor_user_id: null, actor_name: null, metadata: null,
      });
    }
    expect(isNotificationKind("storage_alert")).toBe(true);
    expect(KIND_META.storage_alert.section).toBeNull(); // bell-only: the header bell owns it, as before
  });

  it("the 7-day dedupe read stays: an admin with a recent storage_alert is skipped", async () => {
    world.tableBytes = 80;
    world.existing.add("a1");
    const r = await runStorageAlerts(fakeServiceClient());
    expect(r.alerts).toBe(1);
    expect(world.inserts.map((i) => i.user_id)).toEqual(["a2"]);
    expect(world.calls).toContainEqual({ table: "notifications", op: "eq", args: ["kind", "storage_alert"] });
    expect(world.calls.some((c) => c.table === "notifications" && c.op === "gte")).toBe(true);
  });

  it("a refused write is not counted as an alert, and does not throw", async () => {
    world.tableBytes = 95;
    world.insertError = { message: "new row violates row-level security policy" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await runStorageAlerts(fakeServiceClient());
    expect(r.alerts).toBe(0);
    expect(warn).toHaveBeenCalledWith("[notify] insert failed", "new row violates row-level security policy");
    warn.mockRestore();
  });

  it("the binding is for the write only: afterwards the shared client resolves to the anonymous client, not the watchdog's", async () => {
    const resolvesToDouble = () => (supabase.from("notifications") as unknown as Record<PropertyKey, unknown>)[DOUBLE] === true;
    world.tableBytes = 95;
    const sb = fakeServiceClient();
    // the probe can see a binding: inside the scope, and under a module-wide
    // swap (the shape that WOULD outlive the write), it resolves to the double
    expect(await runWithServerClient(sb, async () => resolvesToDouble())).toBe(true);
    __setServerSupabaseClient(sb);
    try { expect(resolvesToDouble()).toBe(true); } finally { __resetServerSupabaseClient(); }
    expect(resolvesToDouble()).toBe(false);
    // the watchdog binds for its writes (the rows reached the double through
    // the SHARED client notify() uses) …
    const r = await runStorageAlerts(sb);
    expect(r.alerts).toBe(2);
    expect(world.inserts.filter((i) => i.table === "notifications")).toHaveLength(2);
    // … and leaves nothing bound once it returns
    expect(resolvesToDouble()).toBe(false);
  });
});

describe("runPlatformStorageAlerts — the plan ceilings (lib/storageUsage.ts)", () => {
  it("file storage over its ceiling: storage_platform_r2, through notify() as the service role", async () => {
    r2State.bytes = Math.round(9.6 * GiB); // 96% of the 10 GB default
    world.tableBytes = 1024;               // the database is fine
    const { alerts } = await runPlatformStorageAlerts(fakeServiceClient());
    expect(alerts).toBe(2);
    const rows = world.inserts.filter((i) => i.table === "notifications");
    expect(rows.map((r) => r.kind)).toEqual(["storage_platform_r2", "storage_platform_r2"]);
    expect(rows[0]).toMatchObject({ org_id: "o1", user_id: "a1", link: "/admin/storage", title: "File storage critical — 96% of plan", metadata: null });
    expect(world.calls).toContainEqual({ table: "notifications", op: "eq", args: ["kind", "storage_platform_r2"] });
  });

  it("the database over its ceiling: storage_platform_db — the finite set, never a template string", async () => {
    world.tableBytes = 480 * 1024 * 1024; // 96% of the 500 MB default
    const { alerts } = await runPlatformStorageAlerts(fakeServiceClient());
    expect(alerts).toBe(2);
    expect(world.inserts.map((r) => r.kind)).toEqual(["storage_platform_db", "storage_platform_db"]);
    for (const k of ["storage_platform_r2", "storage_platform_db"]) expect(isNotificationKind(k), k).toBe(true);
  });
});
