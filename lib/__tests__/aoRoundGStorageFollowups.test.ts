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
  let limit = Number.POSITIVE_INFINITY;
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, limit);
  const result = () => {
    const err = state.errors[`${table}.${op}`];
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
      return { Contents: state.objects.filter((o) => o.Key.startsWith(prefix)), IsTruncated: false };
    }
    return { UploadId: "up-1" };
  };
  (real as unknown as { send: typeof send }).send = send;
  return { r2: real, R2_BUCKET: "test-bucket" };
});

import { runStorageAlerts } from "@/lib/storageAlerts";
import { runPlatformStorageAlerts, PLATFORM_OPERATORS_KEY, STORAGE_LIMITS_KEY, r2PlanBand, soleTenantId, isSoleTenant } from "@/lib/storageUsage";
import { POST as uploadUrl } from "@/app/api/storage/upload-url/route";
import { POST as multipart } from "@/app/api/storage/multipart/route";
import {
  isNodeImageKey, isWorkspaceLogoKey, NODE_CUSTOMIZE_ROLES, NODE_IMAGE_CONTENT_TYPES, nodeImageUploadProblem,
  restoreUploadRequest, contentTypeForKey,
} from "@/lib/storageKey";

const O1 = "11111111-1111-4111-8111-111111111111";
const O2 = "22222222-2222-4222-8222-222222222222";
const OP = "99999999-9999-4999-8999-999999999999";
const KB = 1024;

beforeEach(() => {
  state.rows = {}; state.errors = {}; state.objects = [];
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
      expect(b.metadata).toEqual({ r2PlanBand: "warn", r2PlanPct: 72 });
    }
    // one whole-bucket walk measured both figures for the quota step
    const lists = state.r2Sends.filter((c) => c.name === "ListObjectsV2Command").map((c) => c.input.Prefix ?? null);
    expect(lists).toEqual([null, null]); // step 3's whole walk, step 9's whole walk — no prefix walk on a sole server
  });

  it("the record's first scenario (quota 90%, plan 46%): one bell stating both; the R2 step has nothing to say", async () => {
    state.rows.orgs = [{ id: O1 }];
    state.rows.platform_settings = [planCeiling(10_000)];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 5_000 }];
    state.rows.org_members = [{ org_id: O1, uid: "admin", role: "Admin", roles: ["Admin"], status: "active" }];
    state.objects = [{ Key: `orgs/${O1}/a`, Size: 4_500 }, { Key: "root", Size: 100 }];
    await cronStorageSteps();
    expect(bells().map((b) => [b.kind, b.title, b.metadata])).toEqual([
      ["storage_alert", "Storage critical — 90% of the set limit, 46% of plan", { r2PlanBand: "ok", r2PlanPct: 46 }],
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
      metadata: { r2PlanBand: "warn", r2PlanPct: 72 }, created_at: new Date(Date.now() - 86_400_000).toISOString(),
    }];
    state.objects = [{ Key: `orgs/${O1}/a`, Size: 7_100 }, { Key: "root", Size: 100 }];
    await cronStorageSteps();
    expect(bells()).toHaveLength(1); // yesterday's, nothing new today
  });

  it("the shared per-day key, the other way round: an R2 bell sent TODAY (a second cron run the same day) holds the quota bell to the next day, when it states both", async () => {
    state.rows.orgs = [{ id: O1 }];
    state.rows.platform_settings = [planCeiling(10_000)];
    state.rows.archive_settings = [{ org_id: O1, quota_bytes: 5_000 }];
    state.rows.org_members = [{ org_id: O1, uid: "admin", role: "Admin", roles: ["Admin"], status: "active" }];
    state.objects = [{ Key: `orgs/${O1}/a`, Size: 7_100 }, { Key: "root", Size: 100 }];
    // run 1 (quota then under its limit): the R2 bell went out this morning
    state.rows.notifications = [{ org_id: O1, user_id: "admin", kind: "storage_platform_r2", title: "File storage high — 72% of plan", metadata: null, created_at: new Date().toISOString() }];
    await cronStorageSteps(); // run 2, the same day: the quota has crossed
    expect(bells()).toHaveLength(1); // no second percentage today
    // the next day (yesterday's R2 bell): the quota bell goes, naming both; the R2 step stays quiet (its week)
    state.rows.notifications = [{ org_id: O1, user_id: "admin", kind: "storage_platform_r2", title: "File storage high — 72% of plan", metadata: null, created_at: new Date(Date.now() - 86_400_000).toISOString() }];
    await cronStorageSteps();
    expect(bells().slice(1).map((b) => [b.kind, b.title])).toEqual([["storage_alert", "Storage critical — 142% of the set limit, 72% of plan"]]);
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
      metadata: { r2PlanBand: "ok", r2PlanPct: 46 }, created_at: new Date(Date.now() - 86_400_000).toISOString(),
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
    expect(bells().map((b) => [b.kind, b.title, b.metadata])).toEqual([["storage_platform_r2", "File storage critical — 96% of plan", null]]);
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
    // the quota bell is today's (no plan figure, no metadata), measured under the workspace's prefix
    expect(bells()[0].metadata).toBeNull();
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

  it("the R2 step's read of the quota bell is a filter, not a write: lib/storageUsage.ts names storage_alert exactly once, in that read", () => {
    const src = readFileSync(join(process.cwd(), "lib/storageUsage.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
    expect(src.match(/["'`]storage_alert["'`]/g)).toHaveLength(1);
    expect(src).toMatch(/\.from\("notifications"\)\.select\("metadata"\)\s*\.eq\("org_id", t\.orgId\)\.eq\("user_id", t\.uid\)\s*\.eq\("kind", "storage_alert"\)\.gte\("created_at", sevenDaysAgo\);/);
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
      expect((await res.json()).error).toBe("A cover or background image must be a PNG, JPEG, WebP, GIF or AVIF image (SVG is not accepted).");
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
  it("the modal mints exactly the keys the rule covers, and PUTs with the file's type (the type the route signs)", () => {
    const modal = readFileSync(join(process.cwd(), "components/documents/CustomizeNodeModal.tsx"), "utf8");
    expect(modal).toContain('const path = `${storagePrefix.replace(/\\/+$/, "")}/covers/${rand}.${ext}`;');
    expect(modal).toContain('const path = `${storagePrefix.replace(/\\/+$/, "")}/backgrounds/${rand}.${ext}`;');
    expect(modal.match(/await uploadToPath\(file, path, \{ contentType: file\.type \}\);/g)).toHaveLength(2);
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
  it("named residual: a legacy SVG (or an unnamed extension) background is refused with the route's reason, which the restore lists", async () => {
    state.member = ADMIN;
    for (const key of [`orgs/${ORG}/branding/backgrounds/b.svg`, `orgs/${ORG}/branding/backgrounds/b.heic`]) {
      const res = await post(restoreUploadRequest(key, 10).body);
      expect(res.status, key).toBe(415);
    }
    expect(contentTypeForKey("x.heic")).toBe("application/octet-stream");
  });
});
