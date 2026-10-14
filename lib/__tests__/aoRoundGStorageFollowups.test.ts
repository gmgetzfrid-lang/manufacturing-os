// admin-and-org Round G, package P10 — storage follow-ups.
//
//   * BILL-15 (DEC-99 §3; the product call ruled by the integrator under the
//     user's delegation, DEC-90 practice): on a server with exactly ONE
//     workspace, the quota alert (lib/storageAlerts.ts runStorageAlerts, the
//     cron's step 3) states both figures — the workspace's files against the
//     limit an admin set, and the whole bucket against the R2 plan ceiling —
//     and the platform R2 alert (lib/storageUsage.ts runPlatformStorageAlerts,
//     step 9) counts it as its own bell. One storage bell, never two
//     different percentages for the same files on the same day. A shared
//     server keeps both: they reach different people.
//   * ORG-16: a folder's or library's cover image and page background
//     (orgs/<org>/branding/covers/, …/backgrounds/) are signed by
//     /api/storage/upload-url (and the multipart route) only for a member
//     holding the node editor's authority — CustomizeNodeModal is offered
//     only to hasAnyRole(["Admin", "DocCtrl"]) — and only as an image type,
//     signed into the PUT.
//
// The routes sign with the REAL presigner (an S3 client with inert
// credentials — presigning is local), so the assertions read the URL's own
// X-Amz-SignedHeaders: what storage will hold the PUT to.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  // ── the database the watchdogs read (a service-role client double) ──
  rows: {} as Record<string, Row[]>,
  errors: {} as Record<string, { message: string }>,
  objects: [] as Array<{ Key: string; Size: number }>,
  // The Nth whole-bucket walk (no Prefix; 1-based, counted per walk) lists
  // one page and then runs out of time — its deadline passes mid-walk.
  stallWholeWalk: null as number | null,
  // The Nth whole-bucket walk fails outright (a storage error, not a deadline).
  failWholeWalk: null as number | null,
  wholeWalks: 0,
  // ── the routes' world ──
  user: { id: "u1", email: "u1@example.com" } as { id: string; email?: string } | null,
  member: { uid: "u1", role: "Drafter", roles: ["Drafter"] } as Row | null,
  memberSelects: [] as string[],
  r2Sends: [] as Array<{ name: string; input: Row }>,
}));

/** A chainable builder over state.rows: eq / neq / in / gte filter; an insert is
 *  written back (with created_at now), so a later step reads what an earlier
 *  step wrote — the point of the BILL-15 tests. */
function chain(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op = "select";
  let head = false;
  let kind: unknown = undefined;
  let limit = Number.POSITIVE_INFINITY;
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, limit);
  const result = () => {
    // `${table}.${op}`, or one kind's read alone: `${table}.${op}.${kind}`
    const err = state.errors[`${table}.${op}`] ?? (kind === undefined ? undefined : state.errors[`${table}.${op}.${String(kind)}`]);
    if (err) return { data: null, error: err, count: null };
    if (op !== "select") return { data: null, error: null, count: null };
    return head ? { data: null, error: null, count: rows().length } : { data: rows(), error: null, count: rows().length };
  };
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
      return (...args: unknown[]) => {
        if (prop === "insert") {
          op = "insert";
          const row = args[0] as Row;
          (state.rows[table] ??= []).push({ ...row, created_at: new Date().toISOString() });
        }
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (prop === "eq") filters.push((r) => r[String(args[0])] === args[1]);
        if (prop === "eq" && args[0] === "kind") kind = args[1];
        if (prop === "neq") filters.push((r) => r[String(args[0])] !== args[1]);
        if (prop === "in") filters.push((r) => (args[1] as unknown[]).includes(r[String(args[0])]));
        if (prop === "gte") filters.push((r) => String(r[String(args[0])] ?? "") >= String(args[1]));
        if (prop === "limit") limit = Number(args[0]);
        if (prop === "maybeSingle" || prop === "single") {
          const r = result();
          return Promise.resolve({ data: r.error ? null : (rows()[0] ?? null), error: r.error });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
const sb = {
  from: (t: string) => chain(t),
  rpc: async () => ({ data: [] as Row[], error: null }),
};

// The routes' service-role client: the member read answers state.member and
// records the columns it asked for; the version ledger is clear.
function routeChain(table: string) {
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return undefined;
      return (...args: unknown[]) => {
        if (prop === "select" && table === "org_members") state.memberSelects.push(String(args[0]));
        if (prop === "insert") return Promise.resolve({ data: null, error: null });
        if (prop === "maybeSingle" || prop === "single") {
          return Promise.resolve({ data: table === "org_members" ? state.member : null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: {
      getUser: vi.fn(async () =>
        state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }),
    },
    from: (t: string) => routeChain(t),
  },
}));
vi.mock("@/lib/r2", async () => {
  const { S3Client } = await import("@aws-sdk/client-s3");
  const real = new S3Client({
    region: "auto",
    endpoint: "https://acct.r2.cloudflarestorage.com",
    credentials: { accessKeyId: "AKTEST", secretAccessKey: "SKTEST" },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  // presigning reads the client's config; a SEND is answered here, never sent
  const send = async (cmd: { constructor: { name: string }; input: Row }) => {
    state.r2Sends.push({ name: cmd.constructor.name, input: cmd.input });
    if (cmd.constructor.name === "ListObjectsV2Command") {
      const prefix = String(cmd.input.Prefix ?? "");
      const listed = state.objects.filter((o) => o.Key.startsWith(prefix)).sort((a, b) => (a.Key < b.Key ? -1 : 1));
      if (!cmd.input.Prefix) {
        if (!cmd.input.ContinuationToken) state.wholeWalks++;
        if (state.failWholeWalk === state.wholeWalks) throw new Error("storage unavailable");
        if (state.stallWholeWalk === state.wholeWalks) {
          if (cmd.input.ContinuationToken) throw Object.assign(new Error("the walk's deadline passed"), { name: "TimeoutError" });
          return { Contents: listed.slice(0, 1), IsTruncated: true, NextContinuationToken: "more" };
        }
      }
      return { Contents: listed, IsTruncated: false };
    }
    return { UploadId: "up-1" };
  };
  (real as unknown as { send: typeof send }).send = send;
  return { r2: real, R2_BUCKET: "test-bucket" };
});

import { runStorageAlerts } from "@/lib/storageAlerts";
import {
  runPlatformStorageAlerts, PLATFORM_OPERATORS_KEY, STORAGE_LIMITS_KEY, r2PlanBand, soleTenantId, isSoleTenant, quotaBellCoversR2Bell,
  timestampMs, sameDayBellHolds, statedPlanBand,
} from "@/lib/storageUsage";
import { POST as uploadUrl } from "@/app/api/storage/upload-url/route";
import { POST as multipart } from "@/app/api/storage/multipart/route";
import {
  isNodeImageKey, isWorkspaceLogoKey, NODE_CUSTOMIZE_ROLES, NODE_IMAGE_CONTENT_TYPES, nodeImageUploadProblem,
  restoreUploadRequest, contentTypeForKey, nodeImageTypeFor, nodeImageExtensionForType, sniffNodeImageType,
} from "@/lib/storageKey";

const O1 = "11111111-1111-4111-8111-111111111111";
const O2 = "22222222-2222-4222-8222-222222222222";
const OP = "99999999-9999-4999-8999-999999999999";
const KB = 1024;

beforeEach(() => {
  state.rows = {}; state.errors = {}; state.objects = [];
  state.stallWholeWalk = null; state.failWholeWalk = null; state.wholeWalks = 0;
  state.user = { id: "u1", email: "u1@example.com" };
  state.member = { uid: "u1", role: "Drafter", roles: ["Drafter"] };
  state.memberSelects = []; state.r2Sends = [];
});

const bells = () => (state.rows.notifications ?? []) as Row[];
/** The daily cron's two storage steps, in its order (step 3, then step 9). */
async function cronStorageSteps() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await runStorageAlerts(sb as never);
    await runPlatformStorageAlerts(sb as never);
  } finally {
    warn.mockRestore();
  }
}
/** A plan ceiling of `r2` bytes (and a roomy database), set by an operator. */
const planCeiling = (r2: number) => ({ key: STORAGE_LIMITS_KEY, value: { r2Bytes: r2, dbBytes: 10 * 1024 ** 3 } });

// ── BILL-15 ─────────────────────────────────────────────────────────────────
describe("BILL-15 — one storage bell per day on a single-workspace server", () => {
  it("REPRODUCED → fixed: the record's single-plant server at 7.2 GB (quota 5 GB, plan 10 GB, scaled) — ONE bell per Admin / DocCtrl, naming both limits", async () => {
    // scaled 1 GB → 1 KB: quota 5 KB, plan 10 KB, bucket 7.2 KB of which 7.1 KB is the workspace's
    state.rows.orgs = [{ id: O1 }];
    state.rows.platform_settings = [planCeiling(10 * KB)];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 5 * KB }];
    state.rows.org_members = [
      { org_id: O1, uid: "admin", role: "Admin", roles: ["Admin"], status: "active" },
      { org_id: O1, uid: "dc", role: "DocCtrl", roles: ["DocCtrl"], status: "active" },
    ];
    state.objects = [{ Key: `orgs/${O1}/libraries/l/a.pdf`, Size: Math.round(7.1 * KB) }, { Key: "legacy-root.bin", Size: Math.round(0.1 * KB) }];
    await cronStorageSteps();
    // before the fix: a storage_alert at 142% AND a storage_platform_r2 at 72% to each — two percentages, same day
    expect(bells().map((b) => [b.user_id, b.kind])).toEqual([["admin", "storage_alert"], ["dc", "storage_alert"]]);
    for (const b of bells()) {
      expect(b.title).toBe("Storage critical — 142% of the set limit, 72% of plan");
      // (sizes print in MB / GB: a few KB read "0 MB" at this scale)
      expect(String(b.body)).toContain("This workspace's files are at 142% of the storage limit an admin set (0 MB of 0 MB, measured under this workspace only)");
      expect(String(b.body)).toContain("the server's file storage is at 72% of its Cloudflare R2 plan ceiling");
      expect(String(b.body)).toContain("every file on the server; this is its only workspace");
      expect(String(b.body)).toContain("The limit is advisory: uploads are not blocked when it is reached.");
      expect(String(b.body)).toContain("past it, Cloudflare bills the overage, or refuses writes on an account without billing");
      expect(String(b.body)).toContain("Upgrade the R2 plan, or take a full backup");
      expect(b.metadata).toEqual({ r2PlanBand: "warn", r2PlanPct: 72, r2PlanTruncated: false });
    }
    // the quota figure is the workspace prefix walk's (exact, as on a shared server); the plan figure a second, whole walk
    const lists = state.r2Sends.filter((c) => c.name === "ListObjectsV2Command").map((c) => c.input.Prefix ?? null);
    expect(lists).toEqual([`orgs/${O1}/`, null, null]); // step 3's prefix walk and whole walk, step 9's whole walk
  });

  it("the record's first scenario (quota 90%, plan 46%): one bell stating both; the R2 step has nothing to say", async () => {
    state.rows.orgs = [{ id: O1 }];
    state.rows.platform_settings = [planCeiling(10_000)];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 5_000 }];
    state.rows.org_members = [{ org_id: O1, uid: "admin", role: "Admin", roles: ["Admin"], status: "active" }];
    state.objects = [{ Key: `orgs/${O1}/a`, Size: 4_500 }, { Key: "root", Size: 100 }];
    await cronStorageSteps();
    expect(bells().map((b) => [b.kind, b.title, b.metadata])).toEqual([
      ["storage_alert", "Storage critical — 90% of the set limit, 46% of plan", { r2PlanBand: "ok", r2PlanPct: 46, r2PlanTruncated: false }],
    ]);
    expect(String(bells()[0].body)).toContain("Take a full backup"); // the plan is fine: no "upgrade" line
    expect(String(bells()[0].body)).not.toContain("Upgrade the R2 plan");
  });

  it("the quota bell sent earlier this week covers the R2 bell for its week, as an R2 bell would — no repeat the next day", async () => {
    state.rows.orgs = [{ id: O1 }];
    state.rows.platform_settings = [planCeiling(10_000)];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 5_000 }];
    state.rows.org_members = [{ org_id: O1, uid: "admin", role: "Admin", roles: ["Admin"], status: "active" }];
    state.rows.notifications = [{
      org_id: O1, user_id: "admin", kind: "storage_alert", title: "Storage critical — 142% of the set limit, 72% of plan",
      metadata: { r2PlanBand: "warn", r2PlanPct: 72, r2PlanTruncated: false }, created_at: new Date(Date.now() - 86_400_000).toISOString(),
    }];
    state.objects = [{ Key: `orgs/${O1}/a`, Size: 7_100 }, { Key: "root", Size: 100 }];
    await cronStorageSteps();
    expect(bells()).toHaveLength(1); // yesterday's, nothing new today
  });

  it("the shared per-day key, the other way round: an R2 bell sent TODAY (a second cron run the same day) holds a quota bell that would state no worse band to the next day", async () => {
    state.rows.orgs = [{ id: O1 }];
    state.rows.platform_settings = [planCeiling(10_000)];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 9_000 }]; // 79%: warn
    state.rows.org_members = [{ org_id: O1, uid: "admin", role: "Admin", roles: ["Admin"], status: "active" }];
    state.objects = [{ Key: `orgs/${O1}/a`, Size: 7_100 }, { Key: "root", Size: 100 }];
    // run 1 (quota then under its limit): the R2 bell went out this morning, stating warn
    const r2Bell = { org_id: O1, user_id: "admin", kind: "storage_platform_r2", title: "File storage high — 72% of plan", metadata: { r2PlanBand: "warn" } };
    state.rows.notifications = [{ ...r2Bell, created_at: new Date().toISOString() }];
    await cronStorageSteps(); // run 2, the same day: the quota has crossed into warn, the plan is still warn
    expect(bells()).toHaveLength(1); // a repeat of the band stated today: held
    // the next day (yesterday's R2 bell): the quota bell goes, naming both; the R2 step stays quiet (its week)
    state.rows.notifications = [{ ...r2Bell, created_at: new Date(Date.now() - 86_400_000).toISOString() }];
    await cronStorageSteps();
    expect(bells().slice(1).map((b) => [b.kind, b.title])).toEqual([["storage_alert", "Storage high — 79% of the set limit, 72% of plan"]]);
  });

  it("integrator ruling 2, the other way round: a CRITICAL quota bell is never held behind a same-day R2 bell that stated warn — it goes the same run; one behind an R2 bell that stated crit is held", async () => {
    state.rows.orgs = [{ id: O1 }];
    state.rows.platform_settings = [planCeiling(10_000)];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 5_000 }]; // 142%: crit
    state.rows.org_members = [{ org_id: O1, uid: "admin", role: "Admin", roles: ["Admin"], status: "active" }];
    state.objects = [{ Key: `orgs/${O1}/a`, Size: 7_100 }, { Key: "root", Size: 100 }];
    const r2Bell = (band: string) => ({ org_id: O1, user_id: "admin", kind: "storage_platform_r2", title: "File storage high — 72% of plan", metadata: { r2PlanBand: band }, created_at: new Date().toISOString() });
    state.rows.notifications = [r2Bell("warn")];
    await cronStorageSteps();
    // the critical bell goes; the R2 step then counts it (it stated the plan at warn, complete)
    expect(bells().slice(1).map((b) => [b.kind, b.title])).toEqual([["storage_alert", "Storage critical — 142% of the set limit, 72% of plan"]]);
    state.rows.notifications = [r2Bell("crit")];
    await cronStorageSteps();
    expect(bells()).toHaveLength(1); // a critical bell was already sent today: held to the next day
  });

  it("the storage steps each read the other's kind once — a filter, never a write", () => {
    const strip = (f: string) => readFileSync(join(process.cwd(), f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
    const alerts = strip("lib/storageAlerts.ts");
    expect(alerts.match(/["'`]storage_platform_r2["'`]/g)).toHaveLength(1);
    expect(alerts).toMatch(/\.eq\("kind", "storage_platform_r2"\)\.gte\("created_at", utcDayStart\);/);
  });

  it("a quota bell that found the plan fine does not stand in for an R2 bell (a hot ceiling is never hidden)", async () => {
    state.rows.orgs = [{ id: O1 }];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 5_000 }];
    state.rows.org_members = [{ org_id: O1, uid: "admin", role: "Admin", roles: ["Admin"], status: "active" }];
    state.rows.platform_settings = [planCeiling(10_000)];
    state.rows.notifications = [{
      org_id: O1, user_id: "admin", kind: "storage_alert", title: "Storage critical — 90% of the set limit, 46% of plan",
      metadata: { r2PlanBand: "ok", r2PlanPct: 46, r2PlanTruncated: false }, created_at: new Date(Date.now() - 86_400_000).toISOString(),
    }];
    state.objects = [{ Key: `orgs/${O1}/a`, Size: 7_100 }, { Key: "root", Size: 100 }];
    await cronStorageSteps();
    expect(bells().slice(1).map((b) => [b.kind, b.title])).toEqual([["storage_platform_r2", "File storage high — 72% of plan"]]);
  });

  it("the plan running hot with the quota fine (or none set): the R2 bell alone, as before", async () => {
    state.rows.orgs = [{ id: O1 }];
    state.rows.platform_settings = [planCeiling(10_000)];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 100_000 }];
    state.rows.org_members = [{ org_id: O1, uid: "admin", role: "Admin", roles: ["Admin"], status: "active" }];
    state.objects = [{ Key: `orgs/${O1}/a`, Size: 9_600 }];
    await cronStorageSteps();
    // the sole workspace's R2 bell records the band it stated, for the quota step's same-day read
    expect(bells().map((b) => [b.kind, b.title, b.metadata])).toEqual([["storage_platform_r2", "File storage critical — 96% of plan", { r2PlanBand: "crit" }]]);
  });

  it("a MULTI-workspace server keeps both: the operator who is also this workspace's Admin gets the quota bell AND the R2 bell (different limits, different people in general)", async () => {
    state.rows.orgs = [{ id: O1 }, { id: O2 }];
    state.rows.platform_settings = [planCeiling(10_000), { key: PLATFORM_OPERATORS_KEY, value: { uids: [OP] } }];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 5_000 }];
    state.rows.org_members = [
      { org_id: O1, uid: OP, role: "Admin", roles: ["Admin"], status: "active" },
      { org_id: O1, uid: "tenant-admin", role: "Admin", roles: ["Admin"], status: "active" },
    ];
    state.objects = [{ Key: `orgs/${O1}/a`, Size: 4_500 }, { Key: `orgs/${O2}/b`, Size: 5_100 }];
    await cronStorageSteps();
    expect(bells().map((b) => [b.user_id, b.kind, b.title])).toEqual([
      [OP, "storage_alert", "Storage critical — 90% full"],
      ["tenant-admin", "storage_alert", "Storage critical — 90% full"],
      [OP, "storage_platform_r2", "File storage critical — 96% of plan"],
    ]);
    // the quota bell is today's (no plan figure, no metadata), measured under the workspace's prefix; the operator's R2 bell is as before (no metadata)
    expect(bells()[0].metadata).toBeNull();
    expect(bells()[2].metadata).toBeNull();
    expect(state.r2Sends.filter((c) => c.name === "ListObjectsV2Command")[0].input.Prefix).toBe(`orgs/${O1}/`);
  });

  it("an unreadable orgs table is 'not sole' (fail closed): the prefix walk and the quota bell as before", async () => {
    state.errors["orgs.select"] = { message: "permission denied" };
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 1_000 }];
    state.rows.org_members = [{ org_id: O1, uid: "a1", role: "Admin", roles: ["Admin"], status: "active" }];
    state.objects = [{ Key: `orgs/${O1}/a`, Size: 950 }];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runStorageAlerts(sb as never);
    warn.mockRestore();
    expect(bells().map((b) => [b.title, b.metadata])).toEqual([["Storage critical — 95% full", null]]);
    expect(state.r2Sends[0].input.Prefix).toBe(`orgs/${O1}/`);
  });

  it("the helpers: the sole workspace's id (none / several / unreadable → null), and the plan band never below warn on a partial walk", async () => {
    state.rows.orgs = [{ id: O1 }];
    expect(await soleTenantId(sb as never)).toBe(O1);
    expect(await isSoleTenant(sb as never, O1)).toBe(true);
    expect(await isSoleTenant(sb as never, O2)).toBe(false);
    state.rows.orgs = [{ id: O1 }, { id: O2 }];
    expect(await soleTenantId(sb as never)).toBeNull();
    state.rows.orgs = [];
    expect(await soleTenantId(sb as never)).toBeNull();
    state.errors["orgs.select"] = { message: "x" };
    expect(await soleTenantId(sb as never)).toBeNull();
    expect(r2PlanBand(46, false, 100)).toEqual({ pct: 46, band: "ok" });
    expect(r2PlanBand(46, true, 100)).toEqual({ pct: 46, band: "warn" });
    expect(r2PlanBand(95, true, 100)).toEqual({ pct: 95, band: "crit" });
  });

  it("integrator ruling 2 (the review's minor on fix pass 2): the quota step's plan walk stops early (a floor, banded warn) while the R2 step's walk finishes at crit — the critical R2 bell goes the SAME run (a critical figure is never held), and the floor never hides it", async () => {
    // keys outside the workspace sort before orgs/: the quota step's whole walk lists "a-root" and runs out of time
    state.rows.orgs = [{ id: O1 }];
    state.rows.platform_settings = [planCeiling(10_000)];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 1_000 }];
    state.rows.org_members = [{ org_id: O1, uid: "admin", role: "Admin", roles: ["Admin"], status: "active" }];
    state.objects = [{ Key: "a-root", Size: 3_000 }, { Key: "b-root", Size: 5_600 }, { Key: `orgs/${O1}/a`, Size: 900 }];
    state.stallWholeWalk = 1; // step 3's whole walk; step 9's (the 2nd) finishes
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let quota: Awaited<ReturnType<typeof runStorageAlerts>>;
    try {
      quota = await runStorageAlerts(sb as never);
      await runPlatformStorageAlerts(sb as never);
    } finally {
      warn.mockRestore();
    }
    // the quota figure is the prefix walk's — exact, measured, although the whole walk never reached orgs/
    expect(quota).toEqual({ alerts: 1, orgsChecked: 1, unmeasured: 0 });
    // step 3's bell — the floor: the workspace's 900 plus the 3,000 the whole walk saw outside it — 39%, never banded below warn
    expect(bells().slice(0, 1).map((b) => [b.kind, b.title, b.metadata])).toEqual([
      ["storage_alert", "Storage critical — 90% of the set limit, at least 39% of plan", { r2PlanBand: "warn", r2PlanPct: 39, r2PlanTruncated: true }],
    ]);
    expect(String(bells()[0].body)).toContain("This workspace's files are at 90% of the storage limit an admin set");
    expect(String(bells()[0].body)).toContain("at least 39% of its Cloudflare R2 plan ceiling (at least 0 MB of 0 MB, every file on the server");
    // review fix (issue 2): a floor below 70% (lifted to warn only because the walk stopped) never advises buying a plan
    expect(String(bells()[0].body)).not.toContain("Upgrade the R2 plan");
    expect(String(bells()[0].body)).toContain("Take a full backup");
    // the same run: the floor stated warn, the R2 step measured crit — new, worse information, sent now
    // (before the ruling, fix pass 2 held it to the next day behind a bell implying the plan was under 40%)
    expect(bells().slice(1).map((b) => [b.kind, b.title, b.metadata])).toEqual([["storage_platform_r2", "File storage critical — 95% of plan", { r2PlanBand: "crit" }]]);
  });

  it("review fix (issue 2): the 'upgrade the plan' line follows the MEASURED plan figure — a floor that itself reads 70% or more still says it", async () => {
    state.rows.orgs = [{ id: O1 }];
    state.rows.platform_settings = [planCeiling(10_000)];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 1_000 }];
    state.rows.org_members = [{ org_id: O1, uid: "admin", role: "Admin", roles: ["Admin"], status: "active" }];
    state.objects = [{ Key: "a-root", Size: 7_500 }, { Key: "b-root", Size: 1_000 }, { Key: `orgs/${O1}/a`, Size: 900 }];
    state.stallWholeWalk = 1;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try { await runStorageAlerts(sb as never); } finally { warn.mockRestore(); }
    expect(bells().map((b) => [b.title, b.metadata])).toEqual([
      ["Storage critical — 90% of the set limit, at least 84% of plan", { r2PlanBand: "warn", r2PlanPct: 84, r2PlanTruncated: true }],
    ]);
    expect(String(bells()[0].body)).toContain("Upgrade the R2 plan, or take a full backup");
  });

  it("integrator ruling 2: a complete plan figure stated earlier TODAY below the band the R2 step measures neither covers its week nor holds it — the worse R2 figure goes the same run", async () => {
    state.rows.orgs = [{ id: O1 }];
    state.rows.platform_settings = [planCeiling(10_000)];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 100_000 }]; // the quota step has nothing to say now
    state.rows.org_members = [{ org_id: O1, uid: "admin", role: "Admin", roles: ["Admin"], status: "active" }];
    state.objects = [{ Key: `orgs/${O1}/a`, Size: 7_000 }]; // 70%: warn, uploads since the 69% quota bell
    state.rows.notifications = [{
      org_id: O1, user_id: "admin", kind: "storage_alert", title: "Storage high — 92% of the set limit, 69% of plan",
      metadata: { r2PlanBand: "ok", r2PlanPct: 69, r2PlanTruncated: false }, created_at: new Date().toISOString(),
    }];
    await cronStorageSteps();
    // before the ruling (fix pass 2): held to the next day
    expect(bells().slice(1).map((b) => [b.kind, b.title])).toEqual([["storage_platform_r2", "File storage high — 70% of plan"]]);
  });

  it("integrator ruling 2: a warn R2 figure after a same-day both-figures bell that stated warn is a repeat — held (that bell also covers its week)", async () => {
    state.rows.orgs = [{ id: O1 }];
    state.rows.platform_settings = [planCeiling(10_000)];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 100_000 }];
    state.rows.org_members = [{ org_id: O1, uid: "admin", role: "Admin", roles: ["Admin"], status: "active" }];
    state.objects = [{ Key: `orgs/${O1}/a`, Size: 7_500 }]; // 75%: warn
    state.rows.notifications = [{
      org_id: O1, user_id: "admin", kind: "storage_alert", title: "Storage critical — 142% of the set limit, 72% of plan",
      metadata: { r2PlanBand: "warn", r2PlanPct: 72, r2PlanTruncated: false }, created_at: new Date().toISOString(),
    }];
    await cronStorageSteps();
    expect(bells()).toHaveLength(1);
  });

  it("integrator ruling 2: a crit R2 figure after a same-day bell that already stated crit (a floor at 'at least 91%') is a repeat — held to the next day, which sends it (a floor never covers the week)", async () => {
    state.rows.orgs = [{ id: O1 }];
    state.rows.platform_settings = [planCeiling(10_000)];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 100_000 }];
    state.rows.org_members = [{ org_id: O1, uid: "admin", role: "Admin", roles: ["Admin"], status: "active" }];
    state.objects = [{ Key: `orgs/${O1}/a`, Size: 9_500 }]; // 95%: crit
    state.rows.notifications = [{
      org_id: O1, user_id: "admin", kind: "storage_alert", title: "Storage critical — 95% of the set limit, at least 91% of plan",
      metadata: { r2PlanBand: "crit", r2PlanPct: 91, r2PlanTruncated: true }, created_at: new Date().toISOString(),
    }];
    await cronStorageSteps();
    expect(bells()).toHaveLength(1);
    bells()[0].created_at = new Date(Date.now() - 86_400_000).toISOString();
    await cronStorageSteps();
    expect(bells().slice(1).map((b) => [b.kind, b.title])).toEqual([["storage_platform_r2", "File storage critical — 95% of plan"]]);
  });

  it("fix pass 2, kept by ruling 2: a floor stated earlier today at warn holds a warn R2 bell to the next day (the same band: a repeat); the next day the measured figure goes (a floor never covers the week)", async () => {
    state.rows.orgs = [{ id: O1 }];
    state.rows.platform_settings = [planCeiling(10_000)];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 100_000 }];
    state.rows.org_members = [{ org_id: O1, uid: "admin", role: "Admin", roles: ["Admin"], status: "active" }];
    state.objects = [{ Key: `orgs/${O1}/a`, Size: 7_500 }];
    state.rows.notifications = [{
      org_id: O1, user_id: "admin", kind: "storage_alert", title: "Storage high — 92% of the set limit, at least 31% of plan",
      metadata: { r2PlanBand: "warn", r2PlanPct: 31, r2PlanTruncated: true }, created_at: new Date().toISOString(),
    }];
    await cronStorageSteps();
    expect(bells()).toHaveLength(1); // not "75% of plan" the same day as "at least 31% of plan"
    bells()[0].created_at = new Date(Date.now() - 86_400_000).toISOString();
    await cronStorageSteps();
    expect(bells().slice(1).map((b) => [b.kind, b.title])).toEqual([["storage_platform_r2", "File storage high — 75% of plan"]]);
  });

  it("integrator ruling 2: the plan walk fails outright: the quota-only bell states no plan figure, so the R2 bell is not a repeat — it goes the same run", async () => {
    state.rows.orgs = [{ id: O1 }];
    state.rows.platform_settings = [planCeiling(10_000)];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 5_000 }];
    state.rows.org_members = [{ org_id: O1, uid: "admin", role: "Admin", roles: ["Admin"], status: "active" }];
    state.objects = [{ Key: `orgs/${O1}/a`, Size: 7_100 }, { Key: "root", Size: 100 }];
    state.failWholeWalk = 1;
    await cronStorageSteps();
    // before the ruling (fix pass 2): the R2 bell was held to the next day behind a bell that never stated the plan
    expect(bells().map((b) => [b.kind, b.title, b.metadata])).toEqual([
      ["storage_alert", "Storage critical — 142% full", null],
      ["storage_platform_r2", "File storage high — 72% of plan", { r2PlanBand: "warn" }],
    ]);
  });

  it("fix pass 2, kept by ruling 2: an R2 bell sent earlier today holds a quota-only bell of no worse band even when the plan walk fails; an R2 row that states no band holds nothing", async () => {
    state.rows.orgs = [{ id: O1 }];
    state.rows.platform_settings = [planCeiling(10_000)];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 9_000 }]; // 79%: warn
    state.rows.org_members = [{ org_id: O1, uid: "admin", role: "Admin", roles: ["Admin"], status: "active" }];
    state.objects = [{ Key: `orgs/${O1}/a`, Size: 7_100 }, { Key: "root", Size: 100 }];
    const r2Bell = (metadata: Row | null) => ({ org_id: O1, user_id: "admin", kind: "storage_platform_r2", title: "File storage high — 72% of plan", metadata, created_at: new Date().toISOString() });
    state.rows.notifications = [r2Bell({ r2PlanBand: "warn" })];
    state.failWholeWalk = 1;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runStorageAlerts(sb as never);
      expect(bells()).toHaveLength(1);
      // a row written before the band was recorded (deploy day): nothing to compare against — the bell goes (fails open)
      state.rows.notifications = [r2Bell(null)];
      state.wholeWalks = 0;
      await runStorageAlerts(sb as never);
    } finally {
      warn.mockRestore();
    }
    expect(bells().slice(1).map((b) => [b.kind, b.title])).toEqual([["storage_alert", "Storage high — 79% full"]]);
  });

  it("integrator ruling 1: a failed de-duplicating read fails OPEN — the R2 step's read of the quota bell errors, so both bells go the same run", async () => {
    // the record's 7.2 GB server, which otherwise gives one bell (the first test)
    state.rows.orgs = [{ id: O1 }];
    state.rows.platform_settings = [planCeiling(10 * KB)];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 5 * KB }];
    state.rows.org_members = [{ org_id: O1, uid: "admin", role: "Admin", roles: ["Admin"], status: "active" }];
    state.objects = [{ Key: `orgs/${O1}/libraries/l/a.pdf`, Size: Math.round(7.1 * KB) }, { Key: "legacy-root.bin", Size: Math.round(0.1 * KB) }];
    state.errors["notifications.select.storage_alert"] = { message: "statement timeout" };
    await cronStorageSteps();
    expect(bells().map((b) => [b.kind, b.title])).toEqual([
      ["storage_alert", "Storage critical — 142% of the set limit, 72% of plan"],
      ["storage_platform_r2", "File storage high — 72% of plan"],
    ]);
  });

  it("integrator ruling 1: a failed de-duplicating read fails OPEN — the quota step's read of today's R2 bell errors, so the quota bell goes although an R2 bell stating the same band went this morning", async () => {
    state.rows.orgs = [{ id: O1 }];
    state.rows.platform_settings = [planCeiling(10_000)];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 9_000 }]; // 79%: warn
    state.rows.org_members = [{ org_id: O1, uid: "admin", role: "Admin", roles: ["Admin"], status: "active" }];
    state.objects = [{ Key: `orgs/${O1}/a`, Size: 7_100 }, { Key: "root", Size: 100 }];
    state.rows.notifications = [{ org_id: O1, user_id: "admin", kind: "storage_platform_r2", title: "File storage high — 72% of plan", metadata: { r2PlanBand: "warn" }, created_at: new Date().toISOString() }];
    // the same setup holds the bell when the read succeeds (the per-day key test above)
    state.errors["notifications.select.storage_platform_r2"] = { message: "statement timeout" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try { await runStorageAlerts(sb as never); } finally { warn.mockRestore(); }
    expect(bells().slice(1).map((b) => [b.kind, b.title])).toEqual([["storage_alert", "Storage high — 79% of the set limit, 72% of plan"]]);
  });

  it("quotaBellCoversR2Bell / sameDayBellHolds (ruling 2): a bell today holds only a repeat — a stated band (complete or a floor) at or above the band measured; only a complete plan figure at or above it covers the week", () => {
    const today = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000).toISOString();
    const now = new Date().toISOString();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const row = (band: string, truncated: unknown, at = yesterday) => ({ metadata: { r2PlanBand: band, r2PlanPct: 1, r2PlanTruncated: truncated }, created_at: at });
    // the week
    expect(quotaBellCoversR2Bell([row("warn", false)], "warn", today)).toBe(true);
    expect(quotaBellCoversR2Bell([row("crit", false)], "warn", today)).toBe(true);
    expect(quotaBellCoversR2Bell([row("warn", false)], "crit", today)).toBe(false);
    expect(quotaBellCoversR2Bell([row("crit", true)], "warn", today)).toBe(false); // a floor never covers the week
    expect(quotaBellCoversR2Bell([row("warn", undefined)], "warn", today)).toBe(false); // no flag: not known complete
    expect(quotaBellCoversR2Bell([{ metadata: null, created_at: yesterday }], "warn", today)).toBe(false); // a quota-only bell
    expect(quotaBellCoversR2Bell([row("hot", false)], "warn", today)).toBe(false);
    // today: a worse figure is never held — crit after warn (complete or a floor), warn after ok, anything after a quota-only bell
    expect(quotaBellCoversR2Bell([row("warn", false, now)], "crit", today)).toBe(false);
    expect(quotaBellCoversR2Bell([row("warn", true, now)], "crit", today)).toBe(false);
    expect(quotaBellCoversR2Bell([row("ok", false, now)], "warn", today)).toBe(false);
    expect(quotaBellCoversR2Bell([{ metadata: null, created_at: now }], "warn", today)).toBe(false);
    expect(quotaBellCoversR2Bell([{ metadata: null, created_at: now }], "crit", today)).toBe(false);
    expect(quotaBellCoversR2Bell([row("hot", false, now)], "warn", today)).toBe(false);
    // today: a repeat is held — the same or a lower band than one already stated, a floor included
    expect(quotaBellCoversR2Bell([row("warn", true, now)], "warn", today)).toBe(true);
    expect(quotaBellCoversR2Bell([row("crit", true, now)], "crit", today)).toBe(true);
    expect(quotaBellCoversR2Bell([row("crit", true, now)], "warn", today)).toBe(true);
    // a failed read (null) holds nothing: the bell goes
    expect(quotaBellCoversR2Bell(null, "warn", today)).toBe(false);
    // the shared key, as the quota step uses it on the R2 bell's stated band (no week rule there)
    expect(sameDayBellHolds([{ metadata: { r2PlanBand: "warn" }, created_at: now }], "warn", today)).toBe(true);
    expect(sameDayBellHolds([{ metadata: { r2PlanBand: "warn" }, created_at: now }], "crit", today)).toBe(false);
    expect(sameDayBellHolds([{ metadata: { r2PlanBand: "crit" }, created_at: now }], "crit", today)).toBe(true);
    expect(sameDayBellHolds([{ metadata: { r2PlanBand: "crit" }, created_at: yesterday }], "warn", today)).toBe(false);
    expect(sameDayBellHolds([{ metadata: null, created_at: now }], "warn", today)).toBe(false);
    expect(sameDayBellHolds(null, "warn", today)).toBe(false);
    expect(sameDayBellHolds([{ metadata: { r2PlanBand: "crit" }, created_at: now }], "warn", "not a time")).toBe(false);
    expect(statedPlanBand({ metadata: { r2PlanBand: "crit" } })).toBe("crit");
    expect(statedPlanBand({ metadata: { r2PlanBand: "hot" } })).toBeNull();
    expect(statedPlanBand({ metadata: null })).toBeNull();
  });

  it("review fix (issue 4): 'sent today' compares instants, not strings — a '+00:00' timestamp at midnight, a non-UTC offset, psql's shape", () => {
    const day = "2026-10-13T00:00:00.000Z";
    // a floor stating crit: it holds a crit R2 bell only on its own day (it never covers the week), so the day decides
    const floorAt = (at: string) => [{ metadata: { r2PlanBand: "crit", r2PlanPct: 91, r2PlanTruncated: true }, created_at: at }];
    // midnight with no fraction: '+' sorts before '.' as text, but it is the same instant
    expect(quotaBellCoversR2Bell(floorAt("2026-10-13T00:00:00+00:00"), "crit", day)).toBe(true);
    // a database in America/Chicago: 19:30 -05:00 on the 12th is 00:30 UTC on the 13th — today
    expect(quotaBellCoversR2Bell(floorAt("2026-10-12T19:30:00-05:00"), "crit", day)).toBe(true);
    // and 18:30 -05:00 is 23:30 UTC on the 12th — yesterday
    expect(quotaBellCoversR2Bell(floorAt("2026-10-12T18:30:00-05:00"), "crit", day)).toBe(false);
    expect(quotaBellCoversR2Bell(floorAt("2026-10-13 05:30:00+05"), "crit", day)).toBe(true);
    expect(quotaBellCoversR2Bell(floorAt("2026-10-13T05:29:59.999999+05:30"), "crit", day)).toBe(false);
    // an unreadable timestamp never counts as today (the week rule still applies)
    expect(quotaBellCoversR2Bell(floorAt("yesterday-ish"), "crit", day)).toBe(false);
    expect(timestampMs("2026-10-13T00:00:00+00:00")).toBe(Date.parse(day));
    expect(timestampMs("2026-10-13 00:00:00+00")).toBe(Date.parse(day));
    expect(timestampMs(null)).toBeNaN();
  });

  it("the R2 step's read of the quota bell is a filter, not a write: lib/storageUsage.ts names storage_alert exactly once, in that read", () => {
    const src = readFileSync(join(process.cwd(), "lib/storageUsage.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
    expect(src.match(/["'`]storage_alert["'`]/g)).toHaveLength(1);
    expect(src).toMatch(/\.from\("notifications"\)\.select\("metadata, created_at"\)\s*\.eq\("org_id", t\.orgId\)\.eq\("user_id", t\.uid\)\s*\.eq\("kind", "storage_alert"\)\.gte\("created_at", sevenDaysAgo\);/);
    // and it runs only for the sole workspace's R2 bell
    expect(src).toContain('if (route === "sole-workspace" && alert.kind === "storage_platform_r2") {');
  });
});

// ── ORG-16 ──────────────────────────────────────────────────────────────────
const ORG = "12345678-1234-1234-1234-123456789abc";
const COVER = `orgs/${ORG}/branding/covers/0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b.jpg`;
const BACKGROUND = `orgs/${ORG}/branding/backgrounds/0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c.png`;
const post = (body: Row) => uploadUrl(new NextRequest("https://app/api/storage/upload-url", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const mp = (body: Row) => multipart(new NextRequest("https://app/api/storage/multipart", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const signedHeaders = (url: string) => (new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "").split(";");
const VIEWER = { uid: "u1", role: "Viewer", roles: ["Viewer"] };
const ADMIN = { uid: "u1", role: "Admin", roles: ["Admin"] };

describe("ORG-16 — a node's cover and background are the node editor's to write (upload-url)", () => {
  it("REPRODUCED → fixed: a Viewer posting an existing cover key (read off a library's coverImageUrl) is refused 403 — nothing signed", async () => {
    state.member = VIEWER;
    for (const path of [COVER, BACKGROUND]) {
      const res = await post({ path, contentType: "image/jpeg" });
      expect(res.status, path).toBe(403);
      expect((await res.json()).error).toBe("Only an Admin or a Document Controller can change a folder's or library's cover image or background.");
    }
    // and with an HTML body declared, the same refusal (authority first)
    expect((await post({ path: COVER, contentType: "text/html" })).status).toBe(403);
    expect(state.memberSelects).toEqual(["uid, role, roles", "uid, role, roles", "uid, role, roles"]);
  });

  it("every role outside the node editor's gate is refused; a Drafter, a Manager, a Contractor too", async () => {
    for (const role of ["Drafter", "Manager", "Supervisor", "Engineer", "Contractor", "Auditor", "Viewer"]) {
      state.member = { uid: "u1", role, roles: [role] };
      expect((await post({ path: COVER, contentType: "image/png" })).status, role).toBe(403);
    }
  });

  it("REGRESSION: the node's customizer (Admin, DocCtrl — and either held additively) is signed for an existing cover key, the type SIGNED into the PUT", async () => {
    for (const member of [ADMIN, { uid: "u1", role: "DocCtrl", roles: ["DocCtrl"] }, { uid: "u1", role: "Viewer", roles: ["Viewer", "DocCtrl"] }]) {
      state.member = member;
      for (const [path, type] of [[COVER, "image/jpeg"], [BACKGROUND, "image/png"]]) {
        const res = await post({ path, contentType: type });
        expect(res.status, `${member.roles} ${path}`).toBe(200);
        const body = await res.json();
        expect(body.path).toBe(path);
        expect(signedHeaders(body.url)).toEqual(expect.arrayContaining(["content-type", "host"]));
        expect(signedHeaders(body.url)).not.toContain("content-length"); // no size cap on a cover (a phone photo is fine)
      }
    }
  });

  it("every image type the modal's picker produces and browsers draw is signed; SVG, HTML, octet-stream and a missing type are refused 415", async () => {
    state.member = ADMIN;
    for (const type of NODE_IMAGE_CONTENT_TYPES) expect((await post({ path: COVER, contentType: type })).status, type).toBe(200);
    for (const type of ["image/svg+xml", "text/html", "application/octet-stream", "", undefined]) {
      const res = await post({ path: COVER, contentType: type });
      expect(res.status, String(type)).toBe(415);
      expect((await res.json()).error).toBe("A cover or background image must be a PNG, JPEG, WebP, GIF, AVIF or BMP image (SVG is not accepted).");
    }
  });

  it("a hand-made deeper key under covers/ or backgrounds/ is held to the same rule; a non-member is refused as before", async () => {
    state.member = VIEWER;
    expect((await post({ path: `orgs/${ORG}/branding/covers/x/y.html`, contentType: "image/png" })).status).toBe(403);
    state.member = null;
    expect((await post({ path: COVER, contentType: "image/png" })).status).toBe(403);
  });

  it("REGRESSION: the logo rule and every other key are untouched — a document by a Viewer-free member is signed as before, content-type unsigned", async () => {
    state.member = { uid: "u1", role: "Drafter", roles: ["Drafter"] };
    const res = await post({ path: `orgs/${ORG}/libraries/lib1/${Date.now()}-a.pdf`, contentType: "application/pdf" });
    expect(res.status).toBe(200);
    expect(signedHeaders((await res.json()).url)).toEqual(["host"]);
    expect(state.memberSelects).toEqual(["uid, role, roles"]);
  });
});

describe("ORG-16 — the multipart route is not the way around it", () => {
  it("a Viewer is refused on every action for a cover key, before storage is touched", async () => {
    state.member = VIEWER;
    for (const action of ["create", "sign", "complete", "abort"]) {
      const res = await mp({ action, path: COVER, contentType: "image/jpeg", uploadId: "u", partNumber: 1, parts: [{ partNumber: 1, etag: "e" }] });
      expect(res.status, action).toBe(403);
    }
    expect(state.r2Sends).toEqual([]);
  });
  it("a controller's create needs an image type (415 otherwise); with one it opens the upload carrying that type", async () => {
    state.member = ADMIN;
    expect((await mp({ action: "create", path: COVER, contentType: "text/html" })).status).toBe(415);
    expect(state.r2Sends).toEqual([]);
    const res = await mp({ action: "create", path: COVER, contentType: "image/jpeg" });
    expect(res.status).toBe(200);
    expect(state.r2Sends.map((s) => [s.name, s.input.ContentType])).toEqual([["CreateMultipartUploadCommand", "image/jpeg"]]);
  });
  it("REGRESSION: a big scan under a library key still multiparts for any member (the member read asks only for uid)", async () => {
    state.member = { uid: "u1" };
    const res = await mp({ action: "create", path: `orgs/${ORG}/libraries/l1/scan.e57`, contentType: "application/octet-stream" });
    expect(res.status).toBe(200);
    expect(state.memberSelects).toEqual(["uid"]);
  });
});

describe("ORG-16 — the rule is the node editor's gate, read from the pages that open CustomizeNodeModal", () => {
  const listPage = readFileSync(join(process.cwd(), "app/(protected)/documents/page.tsx"), "utf8");
  const libPage = readFileSync(join(process.cwd(), "app/(protected)/documents/[libraryId]/page.tsx"), "utf8");
  it("both pages offer the editor only to isController = hasAnyRole([\"Admin\", \"DocCtrl\"]) — the list the routes enforce", () => {
    const literal = `hasAnyRole([${NODE_CUSTOMIZE_ROLES.map((r) => `"${r}"`).join(", ")}])`;
    expect(listPage).toContain(`const isController = ${literal};`);
    expect(libPage).toContain(`const isController = ${literal};`);
    // documents list: the customize action lives in LibraryAdminMenu, drawn only under isController
    expect(listPage).toMatch(/\{isController && \(\n\s*<LibraryAdminMenu[\s\S]{0,400}onCustomize=\{\(\) => setCustomizeLib\(lib\)\}/);
    // library page: the folder tree's customize action is wired only for a controller
    expect(libPage).toContain("onCustomize={isController ? (id) => { setCustomizeFolderId(id); } : undefined}");
    // and those are the only two places that hand the modal its upload prefix
    expect(listPage.match(/storagePrefix=\{activeOrgId \? `orgs\/\$\{activeOrgId\}\/branding` : undefined\}/g)).toHaveLength(1);
    expect(libPage.match(/storagePrefix=\{activeOrgId \? `orgs\/\$\{activeOrgId\}\/branding` : undefined\}/g)).toHaveLength(1);
  });
  it("the modal mints exactly the keys the rule covers, named after the allowed type it PUTs with (the type the route signs)", () => {
    const modal = readFileSync(join(process.cwd(), "components/documents/CustomizeNodeModal.tsx"), "utf8");
    expect(modal).toContain('const path = `${storagePrefix.replace(/\\/+$/, "")}/covers/${rand}.${ext}`;');
    expect(modal).toContain('const path = `${storagePrefix.replace(/\\/+$/, "")}/backgrounds/${rand}.${ext}`;');
    // review fix: the type is the browser's when allowed, else the file's bytes' (nodeImageTypeFor); nothing is requested without one
    expect(modal.match(/const contentType = await pickedImageType\(file\);\n\s*if \(!contentType\) return;\n\s*const ext = nodeImageExtensionForType\(contentType\);/g)).toHaveLength(2);
    expect(modal.match(/await uploadToPath\(file, path, \{ contentType \}\);/g)).toHaveLength(2);
    expect(modal).not.toContain("contentType: file.type");
    expect(modal).toContain("type = nodeImageTypeFor(file.type, head);");
    expect(isNodeImageKey(`orgs/${ORG}/branding/covers/abc.jpg`)).toBe(true);
    expect(isNodeImageKey(`orgs/${ORG}/branding/backgrounds/abc.png`)).toBe(true);
  });
  it("the key shapes: covers / backgrounds only, never the logo; the logo key is never a node image", () => {
    expect(isNodeImageKey(`orgs/${ORG}/branding/logo-1.png`)).toBe(false);
    expect(isWorkspaceLogoKey(COVER)).toBe(false);
    expect(isNodeImageKey(`orgs/${ORG}/branding/covers/`)).toBe(false);
    expect(isNodeImageKey(`orgs/${ORG}/libraries/covers/a.png`)).toBe(false);
    expect(isNodeImageKey(`covers/a.png`)).toBe(false);
    expect(nodeImageUploadProblem("image/webp")).toBeNull();
    expect(nodeImageUploadProblem("image/svg+xml")?.status).toBe(415);
  });
});

describe("ORG-16 review fix — a real picture whose browser reports no type, or a legacy one, is still signed", () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  const BMP = new Uint8Array([0x42, 0x4d, 0x36, 0x10, 0, 0, 0, 0, 0, 0, 0x36, 0]);
  const AVIF = new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
  const HTML = new TextEncoder().encode("<html><script>");
  it("the modal's type: the browser's when allowed; image/jpg and image/pjpeg as image/jpeg; an empty or unknown type from the first bytes; otherwise none", () => {
    expect(nodeImageTypeFor("image/png", null)).toBe("image/png");
    expect(nodeImageTypeFor("image/jpg", null)).toBe("image/jpeg");
    expect(nodeImageTypeFor("image/pjpeg", null)).toBe("image/jpeg");
    expect(nodeImageTypeFor("", JPEG)).toBe("image/jpeg");
    expect(nodeImageTypeFor("application/octet-stream", BMP)).toBe("image/bmp");
    expect(nodeImageTypeFor("", AVIF)).toBe("image/avif");
    expect(nodeImageTypeFor("image/bmp", null)).toBe("image/bmp");
    expect(nodeImageTypeFor("", null)).toBeNull();
    expect(nodeImageTypeFor("text/html", HTML)).toBeNull();
    expect(nodeImageTypeFor("image/svg+xml", new TextEncoder().encode("<svg xmlns="))).toBeNull();
    expect(sniffNodeImageType(HTML)).toBeNull();
    expect(nodeImageExtensionForType("image/jpeg")).toBe("jpg");
    expect(nodeImageExtensionForType("image/bmp")).toBe("bmp");
    expect(nodeImageExtensionForType("image/avif")).toBe("avif");
  });
  it("REPRODUCED → fixed: a JPEG the browser typed '' is sent as image/jpeg and signed (it was a 415 after ORG-16); a BMP is signed", async () => {
    state.member = { uid: "u1", role: "DocCtrl", roles: ["DocCtrl"] };
    expect((await post({ path: COVER, contentType: "" })).status).toBe(415); // what the modal used to send
    for (const [bytes, declared] of [[JPEG, ""], [JPEG, "image/pjpeg"], [BMP, ""]] as const) {
      const type = nodeImageTypeFor(declared, bytes)!;
      const res = await post({ path: `orgs/${ORG}/branding/covers/x.${nodeImageExtensionForType(type)}`, contentType: type });
      expect(res.status, `${declared} → ${type}`).toBe(200);
      expect(signedHeaders((await res.json()).url)).toEqual(expect.arrayContaining(["content-type", "host"]));
    }
  });
  it("REPRODUCED → fixed: a cover picked as 'photo' (no extension) sits at '<uuid>.photo'; with its first bytes the restore puts it back as a JPEG", async () => {
    state.member = ADMIN;
    const key = `orgs/${ORG}/branding/covers/0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d.photo`;
    expect((await post(restoreUploadRequest(key, 4096).body)).status).toBe(415); // by extension alone: octet-stream
    const req = restoreUploadRequest(key, 4096, JPEG);
    expect(req.contentType).toBe("image/jpeg");
    expect((await post(req.body)).status).toBe(200);
    // a BMP background by its extension, and by its bytes
    expect(restoreUploadRequest(`orgs/${ORG}/branding/backgrounds/b.bmp`, 10).contentType).toBe("image/bmp");
    expect(restoreUploadRequest(`orgs/${ORG}/branding/backgrounds/b`, 10, BMP).contentType).toBe("image/bmp");
    // bytes that are no image leave the extension to decide (and the route refuses it)
    expect(restoreUploadRequest(`orgs/${ORG}/branding/backgrounds/b.photo`, 10, HTML).contentType).toBe("application/octet-stream");
    // the logo's rule is unchanged: a BMP's bytes do not decide a logo's type
    expect(restoreUploadRequest(`orgs/${ORG}/branding/logo.png`, 10, BMP).contentType).toBe("image/png");
  });
  it("the restore page reads the first bytes of a cover / background as it does a logo's", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/admin/restore/page.tsx"), "utf8");
    expect(page).toContain("const head = isWorkspaceLogoKey(key) || isNodeImageKey(key) ? new Uint8Array(await blob.slice(0, 12).arrayBuffer()) : null;");
  });
});

describe("ORG-16 — a backup restore (Admin) puts covers and backgrounds back as images", () => {
  it("a cover stored as .jpg / .jfif / .png / .gif / .webp / .avif: the restore's request is signed with that image type", async () => {
    state.member = ADMIN;
    for (const [ext, type] of [["jpg", "image/jpeg"], ["jfif", "image/jpeg"], ["png", "image/png"], ["gif", "image/gif"], ["webp", "image/webp"], ["avif", "image/avif"]]) {
      const key = `orgs/${ORG}/branding/covers/c.${ext}`;
      const req = restoreUploadRequest(key, 4096);
      expect(req.contentType, ext).toBe(type);
      expect(req.logoProblem, ext).toBeNull();
      const res = await post(req.body);
      expect(res.status, ext).toBe(200);
      expect(signedHeaders((await res.json()).url), ext).toEqual(expect.arrayContaining(["content-type", "host"]));
    }
  });
  it("review fix (issue 3): a legacy SVG / HEIC / TIFF cover or background is not asked for — the restore names it (nodeImageProblem), as it names a logo it cannot put back", async () => {
    state.member = ADMIN;
    for (const key of [`orgs/${ORG}/branding/backgrounds/b.svg`, `orgs/${ORG}/branding/backgrounds/b.heic`, `orgs/${ORG}/branding/covers/c.tiff`]) {
      const req = restoreUploadRequest(key, 10);
      expect(req.nodeImageProblem, key).toBe(nodeImageUploadProblem(req.contentType)!.error);
      expect(req.logoProblem, key).toBeNull();
      // the route would refuse it: the page does not ask
      expect((await post(req.body)).status, key).toBe(415);
    }
    expect(contentTypeForKey("x.heic")).toBe("application/octet-stream");
    // an allowed cover, a logo and a document carry no node-image problem
    expect(restoreUploadRequest(COVER, 10).nodeImageProblem).toBeNull();
    expect(restoreUploadRequest(`orgs/${ORG}/branding/logo.svg`, 10).nodeImageProblem).toBeNull();
    expect(restoreUploadRequest(`orgs/${ORG}/libraries/l/a.svg`, 10).nodeImageProblem).toBeNull();
  });

  it("review fix (issue 3): the restore page skips such a cover and lists it in a named notice (re-pick under Customize), not among generic failures", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/admin/restore/page.tsx"), "utf8");
    // (ORG-18, P11: the skipped key is also kept, with whether the storage check reported it missing, before the return)
    expect(page).toMatch(/if \(req\.nodeImageProblem\) \{\n\s+nodeImagesNotRestored\.push\(key\.split\("\/"\)\.slice\(-2\)\.join\("\/"\)\);\n\s+skippedNodeImages\.push\(\{ key, reportedMissing: check\.ok && state\?\.missing === true \}\);\n\s+return;\n\s+\}/);
    // the skip comes before the presign request, so nothing is counted as failed
    expect(page.indexOf("if (req.nodeImageProblem)")).toBeLessThan(page.indexOf("const up = await fetch(`/api/storage/upload-url`"));
    expect(page).toContain("nodeImagesNotRestored: [...nodeImagesNotRestored],");
    expect(page).toContain("folder or library cover / background image(s) in this");
    expect(page).toContain("→ Customize and pick the image again;");
  });
});
