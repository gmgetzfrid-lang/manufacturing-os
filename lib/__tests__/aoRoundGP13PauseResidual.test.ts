// admin-and-org Round G, package P13 — intelligence IEDGE-10 / DACL-7's
// residual (assigned at the A&O P14 merge, DEC-31): two things could leave a
// PAUSED legacy destination (DEC-87 §1 as amended under DEC-90) without the
// pause on its card, so a later night whose grace count could not be read ran
// it, uncounted, pushing the whole workspace to the non-controller's target:
//   1. an Admin's Run Now since the last scheduled run — it rewrote the card
//      and is never the confirming save;
//   2. a refused card write on the night that paused it — the card still
//      said the night before.
// Now (1) Run Now keeps the pause on the card it writes (pauseToKeep /
// withPauseKept — unless an Admin has saved the destination since), and (2)
// run-scheduled also reads the pause from the run rows (pausedInLatestRuns,
// one bounded query) when the count cannot be read. Regression: a confirmed
// or unpaused destination's Run Now card and every readable night are what
// they were; a night on which neither the count nor the newest runs can be
// read still runs uncounted (DEC-87 §1: a backup is never stopped on a guess).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { db, from as memFrom, type Row } from "./helpers/restoreMemoryDb";

const state = vi.hoisted(() => {
  process.env.CRON_SECRET = "cron-secret";
  process.env.EXPORT_ENCRYPTION_KEY = "ab".repeat(32);
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  return {
    roles: ["Admin"] as string[],
    userId: "u-admin",
    delivered: [] as Array<Record<string, unknown>>,
    deliver: null as null | ((p: Record<string, unknown>) => Promise<unknown>),
    s3: (_cmd: string, _input: Record<string, unknown>): unknown => ({}),
  };
});

vi.mock("@supabase/supabase-js", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  return { createClient: () => ({ from: mem.from }) };
});
vi.mock("@/lib/serverAuth", async (importOriginal) => {
  const mem = await import("./helpers/restoreMemoryDb");
  return {
    ...(await importOriginal<typeof import("@/lib/serverAuth")>()),
    authorizeOrgRole: vi.fn(async (_req: unknown, orgId: string, allowed: string[]) => {
      if (!orgId) return { error: "orgId is required", status: 400 };
      if (!state.roles.some((r) => allowed.includes(r))) return { error: "Insufficient role", status: 403 };
      return { userId: state.userId, email: "me@acme.com", orgId, role: state.roles[0], roles: [...state.roles], admin: { from: mem.from } };
    }),
  };
});
vi.mock("@/lib/exportRunner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exportRunner")>()),
  buildAndDeliverExport: vi.fn(async (p: Record<string, unknown>) => {
    state.delivered.push(p);
    if (state.deliver) return state.deliver(p);
    return { bytes: 10, fileCount: 0, tableCount: 1, totalRows: 1, diagnostics: [{ ts: "t", step: "zip:ready" }], zipBytes: new Uint8Array([80, 75]) };
  }),
}));
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const real = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  class FakeS3 {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) { return state.s3(cmd.constructor.name, cmd.input); }
  }
  return { ...real, S3Client: FakeS3 };
});
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => ({ ContentLength: 4, ContentType: "application/pdf" })) }, R2_BUCKET: "test-bucket" }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_c: unknown, cmd: { input: { Key: string } }) => `https://r2.test/${cmd.input.Key}`),
}));

import { pausedAtLastRun, pausedInLatestRuns, PAUSE_KEPT_SENTENCE, PAUSE_RECHECK_ROWS } from "@/lib/exportAlerts";
import { POST as runPOST } from "@/app/api/data-export/run/route";
import { POST as scheduledPOST } from "@/app/api/data-export/run-scheduled/route";
import { PATCH as destinationPATCH } from "@/app/api/data-export/destinations/[id]/route";

const ORG = "77777777-7777-4777-8777-777777777777";
const req = (url: string, init: { method?: string; body?: unknown; auth?: string } = {}) => new NextRequest(`https://app${url}`, {
  method: init.method ?? "GET",
  headers: { authorization: init.auth ?? "Bearer t", "content-type": "application/json" },
  ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const rowsOf = (t: string): Row[] => db.rows[t] ?? [];
const bells = () => rowsOf("notifications").filter((n) => n.kind === "security_export");

function seed() {
  db.rows = {
    orgs: [{ id: ORG, name: "Acme", subscription_status: "active", subscribed_plan: "growth" }],
    org_members: [
      { id: "om-1", org_id: ORG, uid: "u-admin", email: "me@acme.com", role: "Admin", roles: ["Admin"], status: "active" },
      { id: "om-2", org_id: ORG, uid: "u-admin2", email: "ann@acme.com", role: "Admin", roles: ["Admin"], status: "active" },
      { id: "om-3", org_id: ORG, uid: "u-dc", email: "dc@acme.com", role: "Manager", roles: ["Manager", "DocCtrl"], status: "active" },
      { id: "om-4", org_id: ORG, uid: "u-viewer", email: "v@acme.com", role: "Viewer", roles: ["Viewer"], status: "active" },
      { id: "om-5", org_id: ORG, uid: "u-gone", email: "gone@acme.com", role: "Admin", roles: ["Admin"], status: "inactive" },
    ],
    audit_logs: [],
    notifications: [],
    export_runs: [],
    export_destinations: [],
  };
}

beforeEach(() => {
  db.keys = {}; db.writeError = null; db.readError = {}; db.writes = []; db.attempts = []; db.countless = false;
  db.fks = {}; db.maxRows = 1000; db.generated = {}; db.authUsers = null;
  // audit_logs.timestamp DEFAULT NOW(): the destination baseline read orders by it
  db.defaults = { audit_logs: () => ({ timestamp: new Date().toISOString() }) };
  state.roles = ["Admin"]; state.userId = "u-admin"; state.delivered = []; state.deliver = null;
  state.s3 = () => ({});
  seed();
});
const prevEnforce = process.env.SUBSCRIPTION_ENFORCE;
afterEach(() => {
  if (prevEnforce === undefined) delete process.env.SUBSCRIPTION_ENFORCE; else process.env.SUBSCRIPTION_ENFORCE = prevEnforce;
});

const sweep = () => scheduledPOST(req("/api/data-export/run-scheduled", { method: "POST", auth: "Bearer cron-secret" }));
const runNow = () => runPOST(req("/api/data-export/run", { method: "POST", body: { orgId: ORG, destinationId: "dest-1" } }));
const editFormBody = (d: Row): Row => JSON.parse(JSON.stringify({
  orgId: ORG, name: d.name, destination_type: d.destination_type, enabled: d.enabled ?? true,
  endpoint: d.endpoint || undefined, region: d.region || "us-east-1", bucket: d.bucket || undefined, prefix: d.prefix || undefined,
  webhook_url: d.webhook_url || undefined, schedule_kind: d.schedule_kind || "manual",
  schedule_hour_utc: d.schedule_kind === "manual" ? null : (d.schedule_hour_utc ?? 5),
  schedule_day_of_week: d.schedule_kind === "weekly" ? (d.schedule_day_of_week ?? 1) : null,
  schedule_day_of_month: d.schedule_kind === "monthly" ? (d.schedule_day_of_month ?? 1) : null,
  include_files: d.include_files ?? true, retention_days: d.retention_days ?? null,
}));
const dueDestination = (extra: Row = {}): Row => ({
  id: "dest-1", org_id: ORG, name: "Nightly hook", destination_type: "webhook", webhook_url: "https://hooks.example.com/in",
  enabled: true, next_run_at: "2026-09-30T05:00:00.000Z", schedule_kind: "daily", schedule_hour_utc: 5,
  created_by: "u-admin2", updated_by: "u-admin2", include_files: false, ...extra,
});
/** Fail only the next `n` reads of `table` (the memory DB reads readError twice per failing read). */
function failNextReads(table: string, n: number, message = "statement timeout") {
  let left = 2 * n;
  Object.defineProperty(db.readError, table, {
    configurable: true, enumerable: true,
    get: () => (left > 0 ? (left--, message) : undefined),
  });
}

describe("IEDGE-10 residual (P13) — a paused destination stays paused after a Run Now or a refused pausing-night card", () => {
  let day = 0;
  beforeEach(() => { day = 0; vi.useFakeTimers({ toFake: ["Date"] }); });
  afterEach(() => { vi.useRealTimers(); });
  const night = async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 1 + day++, 5, 0, 0)));
    if (db.rows.export_destinations[0]) Object.assign(db.rows.export_destinations[0], { next_run_at: new Date(Date.now() - 60_000).toISOString() });
    db.rows.notifications = [];
    return (await (await sweep()).json()) as { results: Array<Record<string, unknown>> };
  };
  const afternoon = () => vi.setSystemTime(Date.now() + 9 * 3_600_000);
  const card = () => String(rowsOf("export_destinations")[0].last_run_error ?? "");
  const pausedLegacy = async () => {
    db.rows.export_destinations = [dueDestination({ created_by: "u-dc", updated_by: "u-dc" })];
    for (let n = 1; n <= 8; n++) await night(); // nights 1-7 pushed; night 8 paused
    expect(state.delivered).toHaveLength(7);
    expect(pausedAtLastRun({ last_run_error: card() })).toBe(true);
  };

  it("reproduced (1): an Admin's Run Now on a paused destination keeps the pause on the card it writes; the next night whose count cannot be read stays paused, nothing pushed", async () => {
    await pausedLegacy();
    afternoon();
    const res = await runNow();
    expect(res.status).toBe(200);
    expect(state.delivered).toHaveLength(8); // the Admin's own push went (Run Now is never refused for the pause)
    expect(rowsOf("export_destinations")[0]).toMatchObject({ last_run_status: "succeeded" });
    expect(card().endsWith(PAUSE_KEPT_SENTENCE)).toBe(true); // before P13: the confirm request only, no pause
    expect(card()).toMatch(/^It was last confirmed by dc@acme\.com, who does not hold Admin/);
    expect(card().length).toBeLessThanOrEqual(500);
    db.readError = { export_runs: "statement timeout" }; // neither the count nor the run rows can be read
    const unread = await night();
    db.readError = {};
    expect(unread.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/^skipped: Paused: .*could not be read tonight \(statement timeout\); its last scheduled run left it paused, so it stays paused/) });
    expect(state.delivered).toHaveLength(8); // nothing more pushed
    expect(bells()).toEqual([]);
  });

  it("(1) a Run Now that FAILS keeps the pause on the card too", async () => {
    await pausedLegacy();
    afternoon();
    state.deliver = async () => { throw new Error("Webhook 503: busy"); };
    const res = await runNow();
    expect(res.status).toBe(500);
    expect(rowsOf("export_destinations")[0]).toMatchObject({ last_run_status: "failed" });
    expect(card()).toMatch(/^Webhook 503: busy/);
    expect(card().endsWith(PAUSE_KEPT_SENTENCE)).toBe(true);
    state.deliver = null;
    db.readError = { export_runs: "statement timeout" };
    const unread = await night();
    db.readError = {};
    expect(unread.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/^skipped: Paused:/) });
    expect(state.delivered).toHaveLength(8); // the failed Run Now's attempt only
  });

  it("(1) regression: an Admin's save since the pause ends it — a Run Now after the save writes the card as before, and the next night pushes", async () => {
    await pausedLegacy();
    afternoon();
    state.userId = "u-admin2";
    expect((await destinationPATCH(req("/api/data-export/destinations/dest-1", { method: "PATCH", body: editFormBody(db.rows.export_destinations[0]) }), params("dest-1"))).status).toBe(200);
    vi.setSystemTime(Date.now() + 60_000);
    expect((await runNow()).status).toBe(200);
    expect(card()).not.toContain("still PAUSED");
    expect(rowsOf("export_destinations")[0].last_run_error ?? null).toBeNull(); // confirmed: nothing to say, as before
    expect((await night()).results[0]).toMatchObject({ ok: true });
  });

  it("(1) regression: a confirmed destination's Run Now, and an unconfirmed one mid-grace, write the card exactly as before", async () => {
    db.rows.export_destinations = [dueDestination()];
    expect((await runNow()).status).toBe(200);
    expect(rowsOf("export_destinations")[0].last_run_error ?? null).toBeNull();
    db.rows.export_destinations = [dueDestination({ created_by: "u-dc", updated_by: "u-dc" })];
    for (let n = 1; n <= 3; n++) await night();
    afternoon();
    expect((await runNow()).status).toBe(200);
    expect(card()).toBe("It was last confirmed by dc@acme.com, who does not hold Admin — which setting up a data export now requires. An Admin should open it and save it to confirm it, or disable it.");
  });

  it("reproduced (2): night 7's card write is refused (the card still says night 6); night 8's count cannot be read — the run rows say paused, so nothing is pushed", async () => {
    db.rows.export_destinations = [dueDestination({ created_by: "u-dc", updated_by: "u-dc" })];
    for (let n = 1; n <= 6; n++) await night();
    // only the card write (the update naming last_run_status) is refused; the schedule claim lands
    db.writeError = (table, op, rows) => (table === "export_destinations" && op === "update" && rows[0]?.last_run_status !== undefined ? { code: "57014", message: "statement timeout" } : null);
    const n7 = await night();
    db.writeError = null;
    expect(n7.results[0]).toMatchObject({ ok: true, warnings: expect.arrayContaining([expect.stringMatching(/last-run status not recorded: statement timeout/)]) });
    expect(state.delivered).toHaveLength(7);
    expect(card()).toContain("This is unconfirmed night 6 of 7"); // the pausing night's card was never written
    expect(pausedAtLastRun({ last_run_error: card() })).toBe(false);
    failNextReads("export_runs", 1); // the count's read fails; the bounded re-read of the newest runs succeeds
    const n8 = await night();
    db.readError = {};
    expect(n8.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/^skipped: Paused: .*could not be read tonight \(statement timeout\)/) });
    expect(state.delivered).toHaveLength(7); // before P13 the night ran, uncounted, and pushed
    expect(bells()).toEqual([]);
    // and the next readable night is paused as before
    expect((await night()).results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/^skipped: Paused:/) });
    expect(state.delivered).toHaveLength(7);
  });

  it("(2) stated residual, pinned: when neither the count nor the newest runs can be read and the card lacks the pause, the night runs uncounted (DEC-87 §1); the next readable night is paused", async () => {
    db.rows.export_destinations = [dueDestination({ created_by: "u-dc", updated_by: "u-dc" })];
    for (let n = 1; n <= 6; n++) await night();
    // only the card write (the update naming last_run_status) is refused; the schedule claim lands
    db.writeError = (table, op, rows) => (table === "export_destinations" && op === "update" && rows[0]?.last_run_status !== undefined ? { code: "57014", message: "statement timeout" } : null);
    await night();
    db.writeError = null;
    db.readError = { export_runs: "statement timeout" };
    const blind = await night();
    db.readError = {};
    expect(blind.results[0]).toMatchObject({ ok: true });
    expect(state.delivered).toHaveLength(8);
    expect((await night()).results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/^skipped: Paused:/) });
    expect(state.delivered).toHaveLength(8);
  });

  it("regression: a mid-grace night whose count cannot be read still runs uncounted (the run rows say night 3, not a pause)", async () => {
    db.rows.export_destinations = [dueDestination({ created_by: "u-dc", updated_by: "u-dc" })];
    for (let n = 1; n <= 3; n++) await night();
    failNextReads("export_runs", 1);
    const unread = await night();
    db.readError = {};
    expect(unread.results[0]).toMatchObject({ ok: true });
    expect(state.delivered).toHaveLength(4);
  });
});

describe("IEDGE-10 residual (P13) — pausedInLatestRuns reads the pause from the newest scheduled runs, once", () => {
  const run = (i: number, extra: Row): Row => ({ id: `r-${String(i).padStart(3, "0")}`, org_id: ORG, destination_id: "dest-1", trigger_type: "scheduled", started_at: new Date(Date.UTC(2026, 9, 1) + i * 86_400_000).toISOString(), ...extra });
  const night = (i: number, n: number, status = "succeeded") => run(i, { status, diagnostics: [{ ts: "t", step: "grace:unconfirmed-night", detail: `night=${n}/7` }] });
  const sb = { from: memFrom } as unknown as Parameters<typeof pausedInLatestRuns>[0];

  it("a paused night, or the night that paused it, is a pause; a counted night before the last is not", async () => {
    db.rows.export_runs = [night(1, 6), run(2, { status: "cancelled", diagnostics: [{ ts: "t", step: "grace:paused" }] })];
    expect(await pausedInLatestRuns(sb, "dest-1")).toEqual({ paused: true });
    db.rows.export_runs = [night(1, 6), night(2, 7, "running")];
    expect(await pausedInLatestRuns(sb, "dest-1")).toEqual({ paused: true });
    db.rows.export_runs = [night(1, 2), night(2, 3)];
    expect(await pausedInLatestRuns(sb, "dest-1")).toEqual({ paused: false });
  });

  it("neutral rows (a gate skip, an unread count, an unverified night, a manual run) are read past; a confirmed push or a pre-rule run ends it", async () => {
    db.rows.export_runs = [
      night(1, 7),
      run(2, { status: "cancelled", diagnostics: [{ ts: "t", step: "gate:skipped" }] }),
      run(3, { status: "succeeded", diagnostics: [{ ts: "t", step: "grace:unconfirmed-night", detail: "night=?/7" }] }),
      run(4, { status: "succeeded", diagnostics: [{ ts: "t", step: "grace:unverified" }] }),
      { ...run(5, { status: "succeeded", diagnostics: [] }), trigger_type: "manual" },
    ];
    expect(await pausedInLatestRuns(sb, "dest-1")).toEqual({ paused: true });
    db.rows.export_runs = [night(1, 7), run(2, { status: "succeeded", diagnostics: [{ ts: "t", step: "zip:ready" }] })];
    expect(await pausedInLatestRuns(sb, "dest-1")).toEqual({ paused: false });
    db.rows.export_runs = [];
    expect(await pausedInLatestRuns(sb, "dest-1")).toEqual({ paused: false });
  });

  it("a read error, or a full window with no deciding row, answers an error (the caller keeps today's path)", async () => {
    db.readError = { export_runs: "connection reset" };
    expect(await pausedInLatestRuns(sb, "dest-1")).toEqual({ error: "connection reset" });
    db.readError = {};
    db.rows.export_runs = Array.from({ length: PAUSE_RECHECK_ROWS }, (_, i) => run(10 + i, { status: "cancelled", diagnostics: [{ ts: "t", step: "gate:skipped" }] }));
    expect(await pausedInLatestRuns(sb, "dest-1")).toEqual({ error: `no deciding run in the newest ${PAUSE_RECHECK_ROWS} scheduled runs` });
  });
});
