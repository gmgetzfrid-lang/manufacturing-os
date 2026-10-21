// notifications Round G — N18 DELIVERY RECORD: the purge keeps the facts of
// who was told what (drafting-flow EVID-9 dw3, EVID-13 dw3; DEC-90 rulings
// (3) and (5)).
//
//   * lib/noticeRetention.ts — the workspace's notice-record retention
//     (org_configurations "notice_record_retention", data.days) or the five-
//     year default; an unreadable setting is never guessed at; the record
//     cutoff is the EARLIER of the window and the retention, so no row is
//     kept a shorter time than before.
//   * /api/admin/purge — the record lines (read record notices, sent mail,
//     not_emailed records) purge only past that cutoff; every other line
//     keeps exactly today's window and floor; a retention that cannot be read
//     purges none of the record lines and says so.
//   * EVID-13 remainder (ruling (5)): read_at stays the recipient's own act,
//     and a superseded notice stays a mark — both purge floors require
//     read_at, so an alert the workflow retired unread is never purged; the
//     census of read_at writers names each one.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest } from "next/server";

type Op = [string, ...unknown[]];
type Query = { table: string; kind: "count" | "delete" | "insert" | "read"; ops: Op[]; payload?: unknown };
const db = vi.hoisted(() => ({
  queries: [] as Query[],
  retention: { data: [] as unknown[], error: null as null | { message: string; code?: string } },
}));

function client() {
  return {
    rpc: async () => ({ data: [], error: null }),
    from(table: string) {
      const q: Query = { table, kind: "read", ops: [] };
      const chain: Record<string, unknown> = {};
      for (const m of ["eq", "lt", "gt", "not", "is", "in", "or", "order", "limit"]) {
        chain[m] = (...a: unknown[]) => { q.ops.push([m, ...a]); return chain; };
      }
      chain.select = (_c: string, opts?: { head?: boolean }) => { if (opts?.head) q.kind = "count"; return chain; };
      chain.delete = () => { q.kind = "delete"; return chain; };
      chain.insert = (payload: unknown) => { q.kind = "insert"; q.payload = payload; db.queries.push(q); return Promise.resolve({ error: null }); };
      chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        db.queries.push(q);
        if (table === "org_configurations") return Promise.resolve(db.retention).then(res, rej);
        return Promise.resolve(q.kind === "count" ? { count: 3, error: null } : { data: [], error: null }).then(res, rej);
      };
      return chain;
    },
  };
}

vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: vi.fn(async () => ({ userId: "dc1", email: "dc1@x.io", orgId: "o1", role: "DocCtrl", roles: ["DocCtrl"], admin: client() })),
}));
vi.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: {} }));

import { GET, POST } from "@/app/api/admin/purge/route";
import {
  NOTICE_RECORD_RETENTION_DEFAULT_DAYS, NOTICE_RECORD_RETENTION_KEY, RECORD_NOTICE_KINDS,
  boundedRetentionDays, noticeRecordRetention, recordCutoff,
} from "@/lib/noticeRetention";
import { KIND_META } from "@/lib/notificationKinds";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const iso = (days: number) => new Date(NOW.getTime() - days * 86400 * 1000).toISOString();

beforeEach(() => {
  db.queries = [];
  db.retention = { data: [], error: null };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); });

const purge = (days: number, tables?: string[]) => POST(new NextRequest("http://x/api/admin/purge", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" },
  body: JSON.stringify({ orgId: "o1", days, confirm: true, ...(tables ? { tables } : {}) }),
}));
const deletes = (table: string) => db.queries.filter((q) => q.table === table && q.kind === "delete");
const ltOf = (q: Query) => q.ops.find((o) => o[0] === "lt")?.[2];
const has = (q: Query, ...op: unknown[]) => q.ops.some((o) => JSON.stringify(o) === JSON.stringify(op));

describe("lib/noticeRetention", () => {
  it("the default is five years; a configured value is a whole number of days 1–36,500, anything else is the default", async () => {
    expect(NOTICE_RECORD_RETENTION_DEFAULT_DAYS).toBe(1825);
    for (const ok of [1, 30, 3650, "400", 36500]) expect(boundedRetentionDays(ok), String(ok)).toBe(Number(ok));
    for (const bad of [0, -5, 1.5, 36501, "x", "", null, undefined, true, {}]) expect(boundedRetentionDays(bad), String(bad)).toBeNull();
  });

  it("reads org_configurations key notice_record_retention (data.days): configured, default, unreadable — never a guess", async () => {
    const c = client();
    db.retention = { data: [{ data: { days: 3650 } }], error: null };
    expect(await noticeRecordRetention(c, "o1")).toEqual({ days: 3650, source: "configured" });
    const read = db.queries.find((q) => q.table === "org_configurations")!;
    expect(has(read, "eq", "key", NOTICE_RECORD_RETENTION_KEY)).toBe(true);
    expect(has(read, "eq", "org_id", "o1")).toBe(true);
    db.retention = { data: [], error: null };
    expect(await noticeRecordRetention(c, "o1")).toEqual({ days: 1825, source: "default" });
    db.retention = { data: [{ data: { days: "forever" } }], error: null };
    expect(await noticeRecordRetention(c, "o1")).toEqual({ days: 1825, source: "default" });
    db.retention = { data: null as unknown as unknown[], error: { message: "permission denied", code: "42501" } };
    expect(await noticeRecordRetention(c, "o1")).toEqual({ days: null, source: "unreadable", error: "permission denied" });
    expect(await noticeRecordRetention({ from: () => { throw new Error("boom"); } }, "o1")).toMatchObject({ days: null, source: "unreadable" });
  });

  it("the record cutoff is the EARLIER of the window and the retention — never shorter than today's window", () => {
    expect(recordCutoff(iso(90), 1825, NOW.getTime())).toBe(iso(1825));
    expect(recordCutoff(iso(90), 30, NOW.getTime())).toBe(iso(90));
    expect(recordCutoff(iso(7), 7, NOW.getTime())).toBe(iso(7));
  });

  it("the record kinds are exactly KIND_META's compliance kinds (acknowledgments, reviews, recalls, …)", () => {
    const compliance = (Object.keys(KIND_META) as Array<keyof typeof KIND_META>).filter((k) => KIND_META[k].compliance).map(String).sort();
    expect([...RECORD_NOTICE_KINDS]).toEqual(compliance);
    expect(RECORD_NOTICE_KINDS).toEqual(expect.arrayContaining(["ack_requested", "review_requested"]));
    expect(RECORD_NOTICE_KINDS).not.toContain("ticket_comment");
  });
});

describe("/api/admin/purge — the record lines keep the notice-record retention (EVID-9 dw3, EVID-13 dw3)", () => {
  it("days=90, retention the default: the plain read line and the abandoned line purge to 90 days; read record notices, sent mail and not_emailed records only to five years", async () => {
    const res = await purge(90);
    expect(res.status).toBe(200);
    const [plain, record] = deletes("notifications");
    expect(ltOf(plain)).toBe(iso(90));
    expect(ltOf(record)).toBe(iso(1825));
    // the plain line: today's floor, minus the record notices
    expect(has(plain, "not", "read_at", "is", null)).toBe(true);
    expect(has(plain, "not", "kind", "in", `(${RECORD_NOTICE_KINDS.join(",")})`)).toBe(true);
    expect(has(plain, "is", "metadata->>action", null)).toBe(true);
    // the record line: the same read-rows floor, only the record notices
    expect(has(record, "not", "read_at", "is", null)).toBe(true);
    expect(has(record, "or", `kind.in.(${RECORD_NOTICE_KINDS.join(",")}),metadata->>action.not.is.null`)).toBe(true);
    const mail = deletes("email_notifications");
    const byStatus = new Map(mail.map((q) => [q.ops.find((o) => o[0] === "eq" && o[1] === "status")?.[2], ltOf(q)]));
    expect(byStatus).toEqual(new Map([["sent", iso(1825)], ["suppressed", iso(90)], ["not_emailed", iso(1825)]]));
    // the DATA_PURGE row names the retention it kept
    const audit = db.queries.find((q) => q.kind === "insert" && (q.payload as { action?: string }).action === "DATA_PURGE")!;
    expect((audit.payload as { details: { noticeRecordRetentionDays: number } }).details.noticeRecordRetentionDays).toBe(1825);
  });

  it("a workspace that set a SHORTER retention than the window keeps today's window (never shorter than before for any row)", async () => {
    db.retention = { data: [{ data: { days: 30 } }], error: null };
    await purge(90);
    expect(deletes("notifications").map(ltOf)).toEqual([iso(90), iso(90)]);
    expect(deletes("email_notifications").map(ltOf)).toEqual([iso(90), iso(90), iso(90)]);
  });

  it("a configured longer retention (ten years) is honoured", async () => {
    db.retention = { data: [{ data: { days: 3650 } }], error: null };
    await purge(7);
    expect(deletes("notifications").map(ltOf)).toEqual([iso(7), iso(3650)]);
  });

  it("a retention that cannot be read: the record lines purge NOTHING and say why; the other lines purge as today", async () => {
    db.retention = { data: null as unknown as unknown[], error: { message: "permission denied for table org_configurations", code: "42501" } };
    const out = await (await purge(30)).json() as { deleted: Array<{ table: string; rows: number; error?: string }> };
    expect(deletes("notifications").map(ltOf)).toEqual([iso(30)]);
    expect(deletes("email_notifications").map((q) => q.ops.find((o) => o[1] === "status")?.[2])).toEqual(["suppressed"]);
    for (const k of ["notifications_record", "email_notifications_sent", "email_notifications_not_emailed"]) {
      expect(out.deleted.find((d) => d.table === k)).toMatchObject({ rows: 0, error: expect.stringMatching(/not purged — the workspace's notice-record retention could not be read: permission denied/) });
    }
  });

  it("the preview lists the record lines with the retention they keep, and the plan carries it", async () => {
    const res = await GET(new NextRequest("http://x/api/admin/purge?orgId=o1&days=90", { headers: { authorization: "Bearer t" } }));
    const json = await res.json() as { noticeRecordRetention: unknown; targets: Array<{ table: string; label: string; reason: string; cutoffIso: string }> };
    expect(json.noticeRecordRetention).toEqual({ days: 1825, source: "default" });
    const by = new Map(json.targets.map((t) => [t.table, t]));
    expect([...by.keys()]).toEqual(["notifications", "notifications_record", "email_notifications_sent", "email_notifications_suppressed", "email_notifications_not_emailed", "ai_usage_events"]);
    for (const k of ["notifications_record", "email_notifications_sent", "email_notifications_not_emailed"]) {
      expect(by.get(k)!.cutoffIso, k).toBe(iso(1825));
      expect(by.get(k)!.reason, k).toContain("Notice-record retention: 1825 days (the default).");
    }
    expect(by.get("notifications")!.cutoffIso).toBe(iso(90));
    expect(by.get("notifications")!.label).toBe("Read in-app notifications");
    expect(db.queries.some((q) => q.kind === "delete")).toBe(false);
  });

  it("REGRESSION: a subset names one line each, as before; the older bare name still selects the delivered line alone", async () => {
    await purge(30, ["email_notifications"]);
    expect(deletes("email_notifications").map((q) => q.ops.find((o) => o[1] === "status")?.[2])).toEqual(["sent"]);
    expect(deletes("notifications")).toEqual([]);
    db.queries = [];
    await purge(30, ["notifications"]);
    expect(deletes("notifications")).toHaveLength(1);
    expect(ltOf(deletes("notifications")[0])).toBe(iso(30));
  });
});

describe("EVID-13 remainder (DEC-90 ruling (5)) — read_at stays the recipient's own act; a superseded notice stays a mark", () => {
  const ROOT = process.cwd();
  const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

  it("both notification purge floors require read_at: an alert the workflow retired unread (metadata.superseded_at, read_at NULL) is never purged", () => {
    const route = src("app/api/admin/purge/route.ts");
    const floor = route.slice(route.indexOf("function floorOf"), route.indexOf("/** What purging the abandoned-email line drops"));
    expect(floor.match(/let n = q\.not\("read_at", "is", null\)/g)?.length).toBe(2);
    expect(floor).not.toMatch(/superseded_at/);
  });

  it("the workflow route retires a stale alert with a mark (superseded_at / superseded_by), never with read_at", () => {
    const wf = src("app/api/tickets/workflow-action/route.ts");
    expect(wf).toMatch(/superseded_at/);
    expect(wf).toMatch(/superseded_by/);
    expect(wf).not.toMatch(/\.update\(\{\s*read_at/);
  });

  it("census: every write of notifications.read_at in the app is the recipient's own session on their own rows — one named exception (NEDGE-23)", () => {
    const walk = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((f) => {
      const rel = join(dir, f);
      if (f === "node_modules" || f === "__tests__" || f.startsWith(".")) return [];
      return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : /\.tsx?$/.test(f) ? [rel] : [];
    });
    const writers = ["app", "lib", "hooks", "components"].flatMap(walk)
      .filter((f) => /\.update\(\{\s*read_at:/.test(src(f)))
      .map((f) => relative(ROOT, join(ROOT, f)))
      .sort();
    // each: the recipient's own browser session (own-row RLS — 20261161 lets a
    // member change only read_at, only on their own rows), named by the screen
    // the person opened; the access-request clear is a service-role stamp on
    // the pool's rows — opened as NEDGE-23 (its owner moves it to a mark)
    expect(writers).toEqual([
      "app/(protected)/requests/[id]/page.tsx",   // opening the request (.eq('user_id', uid))
      "components/notifications/NotificationCenter.tsx", // "Mark these read" in the person's center
      "lib/accessRequestOutcome.ts",              // NEDGE-23 — service role, every pool member's row
      "lib/inAppNotifications.ts",                // the bell's mark read / mark all read (own rows)
      "lib/notificationTrail.ts",                 // opening a document / project (.eq("user_id", uid))
    ]);
    expect(src("app/(protected)/requests/[id]/page.tsx")).toMatch(/\.update\(\{ read_at: new Date\(\)\.toISOString\(\) \}\)\s*\n\s*\.eq\('user_id', uid\)/);
    expect(src("lib/notificationTrail.ts")).toMatch(/\.update\(\{ read_at: new Date\(\)\.toISOString\(\) \}\)\s*\n\s*\.eq\("user_id", input\.uid\)/);
  });
});
