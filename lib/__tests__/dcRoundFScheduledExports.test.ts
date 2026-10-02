// Document-control Round F — P10 EDGES: scheduled exports and the plan gate.
//
//   XEDGE-7  the nightly sweep skips (and RECORDS as a cancelled run) a
//            destination whose configurer is no longer an active member;
//            subscription / plan refusals ride SUBSCRIPTION_ENFORCE (DEC-18)
//            and are logged + recorded as warnings when the flag is off.
//   XEDGE-8  ONE shared plan gate (lib/exportEntitlement.ts) for POST, PATCH
//            and the runner — PATCHing a bucket onto a Starter org's
//            destination is 402.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

type Call = { m: string; args: unknown[] };

const state = vi.hoisted(() => {
  process.env.CRON_SECRET = "cron-secret";
  return {
    log: [] as Array<{ table: string; calls: Array<{ m: string; args: unknown[] }> }>,
    memberActive: true,
    memberError: null as string | null,
    orgError: null as string | null,
    runInsertError: null as string | null,
    subStatus: "active",
    plan: "growth",
    destination: {} as Record<string, unknown>,
    delivered: [] as unknown[],
  };
});

function makeClient() {
  const resolver = (table: string, calls: Call[]): unknown => {
    const has = (m: string) => calls.some((c) => c.m === m);
    switch (table) {
      case "export_destinations":
        if (has("update")) return { data: [{ id: state.destination.id }], error: null };
        return { data: [state.destination], error: null };
      case "org_members":
        if (state.memberError) return { data: null, error: { message: state.memberError } };
        // admin-and-org Round G P3: the sweep also asks whether the configurer
        // still holds the data-export surface's entry role (Admin).
        return { data: state.memberActive ? { uid: "u-1", role: "Admin", roles: ["Admin"] } : null, error: null };
      case "orgs":
        if (state.orgError) return { data: null, error: { message: state.orgError } };
        return { data: { subscription_status: state.subStatus, trial_ends_at: null, subscribed_plan: state.plan }, error: null };
      case "export_runs":
        if (state.runInsertError && has("insert")) return { data: null, error: { message: state.runInsertError } };
        return { data: { id: "run-1" }, error: null };
      default:
        return { data: null, error: null };
    }
  };
  return {
    from(table: string) {
      const calls: Call[] = [];
      const proxy: Record<string, unknown> = new Proxy(function () {} as unknown as Record<string, unknown>, {
        get(_t, p: string) {
          if (p === "then") {
            return (resolve: (v: unknown) => void) => { state.log.push({ table, calls }); resolve(resolver(table, calls)); };
          }
          return (...args: unknown[]) => { calls.push({ m: p, args }); return proxy; };
        },
      });
      return proxy;
    },
  };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeClient() }));
vi.mock("@/lib/serverAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/serverAuth")>()),
  authorizeOrgRole: vi.fn(async (_req: unknown, orgId: string) => ({
    userId: "admin-1", email: "admin@x", orgId, role: "Admin", roles: ["Admin"], admin: makeClient(),
  })),
}));
vi.mock("@/lib/exportRunner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exportRunner")>()),
  buildAndDeliverExport: vi.fn(async (p: unknown) => {
    state.delivered.push(p);
    return { bytes: 10, fileCount: 0, tableCount: 1, totalRows: 1, diagnostics: [{ ts: "t", step: "zip:ready" }] };
  }),
}));

import { cloudBucketAllowed, scheduledRunGate, CLOUD_BUCKET_REFUSAL } from "@/lib/exportEntitlement";
import { POST as runScheduled } from "@/app/api/data-export/run-scheduled/route";
import { PATCH as patchDestination } from "@/app/api/data-export/destinations/[id]/route";
import { POST as createDestination } from "@/app/api/data-export/destinations/route";

const logged = (table: string) => state.log.filter((l) => l.table === table);
const arg = (table: string, m: string, nth = 0) => logged(table).filter((l) => l.calls.some((c) => c.m === m))[nth]?.calls.find((c) => c.m === m)?.args[0] as Record<string, unknown> | undefined;

const DUE = {
  id: "dest-1", org_id: "org-1", destination_type: "webhook", webhook_url: "https://hooks.example/in",
  enabled: true, next_run_at: "2026-09-22T05:00:00.000Z", schedule_kind: "daily", schedule_hour_utc: 5,
  created_by: "u-1", updated_by: "u-1", include_files: false,
};

const sweep = () => runScheduled(new NextRequest("https://app/api/data-export/run-scheduled", {
  method: "POST", headers: { authorization: "Bearer cron-secret" },
}));

const prevEnforce = process.env.SUBSCRIPTION_ENFORCE;
beforeEach(() => {
  state.log = []; state.delivered = [];
  state.memberActive = true; state.memberError = null; state.orgError = null; state.runInsertError = null; state.subStatus = "active"; state.plan = "growth";
  state.destination = { ...DUE };
  delete process.env.SUBSCRIPTION_ENFORCE;
});
afterEach(() => { if (prevEnforce === undefined) delete process.env.SUBSCRIPTION_ENFORCE; else process.env.SUBSCRIPTION_ENFORCE = prevEnforce; });

describe("cloudBucketAllowed — the one plan rule", () => {
  it("growth / enterprise, or a trial, may hold a bucket; starter / null may not", () => {
    expect(cloudBucketAllowed("growth", "active")).toBe(true);
    expect(cloudBucketAllowed("enterprise", "past_due")).toBe(true);
    expect(cloudBucketAllowed("starter", "trialing")).toBe(true);
    expect(cloudBucketAllowed("starter", "active")).toBe(false);
    expect(cloudBucketAllowed(null, "active")).toBe(false);
    expect(cloudBucketAllowed(undefined, undefined)).toBe(false);
  });
});

describe("scheduledRunGate (XEDGE-7)", () => {
  it("skips when the last configurer is no longer an active member, whatever the flag", async () => {
    state.memberActive = false;
    const v = await scheduledRunGate(makeClient() as never, DUE, false);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/no longer active in this workspace/);
    const q = logged("org_members")[0].calls;
    expect(q.find((c) => c.m === "eq" && c.args[0] === "uid")?.args[1]).toBe("u-1");
    expect(q.find((c) => c.m === "eq" && c.args[0] === "status")?.args[1]).toBe("active");
  });
  it("fails CLOSED: a membership lookup error is a skip (retried next cycle), never a push", async () => {
    state.memberError = "permission denied for table org_members";
    const v = await scheduledRunGate(makeClient() as never, DUE, false);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/could not be verified \(permission denied for table org_members\); retried next cycle/);
    expect(v.notices).toEqual([]);
    // the sweep records it like any other skip and delivers nothing
    state.log = [];
    const res = await sweep();
    expect(res.status).toBe(200);
    expect(state.delivered).toEqual([]);
    expect(arg("export_runs", "insert")).toMatchObject({ status: "cancelled" });
    expect(String((arg("export_runs", "insert") as { error_message?: string }).error_message)).toMatch(/could not be verified/);
  });
  it("a destination with no recorded configurer is skipped until an Admin re-saves it", async () => {
    const v = await scheduledRunGate(makeClient() as never, { ...DUE, created_by: null, updated_by: null }, false);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/no recorded configurer/);
  });
  it("subscription and plan refusals are notices with the flag off and skips with it on (DEC-18)", async () => {
    state.subStatus = "canceled"; state.plan = "starter";
    const off = await scheduledRunGate(makeClient() as never, { ...DUE, bucket: "b" }, false);
    expect(off.ok).toBe(true);
    expect(off.notices.join("\n")).toMatch(/subscription gate would skip this run \(SUBSCRIPTION_ENFORCE off\)/);
    expect(off.notices.join("\n")).toMatch(/plan gate would skip this run/);
    const on = await scheduledRunGate(makeClient() as never, { ...DUE, bucket: "b" }, true);
    expect(on.ok).toBe(false);
    if (!on.ok) expect(on.reason).toMatch(/workspace subscription inactive/);
    state.subStatus = "active";
    const planOnly = await scheduledRunGate(makeClient() as never, { ...DUE, bucket: "b" }, true);
    expect(planOnly.ok).toBe(false);
    if (!planOnly.ok) expect(planOnly.reason).toContain(CLOUD_BUCKET_REFUSAL);
    // a webhook destination (no bucket) is not plan-gated
    const hook = await scheduledRunGate(makeClient() as never, DUE, true);
    expect(hook.ok).toBe(true);
  });
  it("reads the org row ONCE for both billing limbs, with one error rule: unverifiable → skip under the flag, notice without it", async () => {
    state.log = [];
    const both = await scheduledRunGate(makeClient() as never, { ...DUE, bucket: "b" }, true);
    expect(both.ok).toBe(true);
    expect(logged("orgs")).toHaveLength(1);
    expect(logged("orgs")[0].calls.find((c) => c.m === "select")?.args[0]).toBe("subscription_status, subscribed_plan, trial_ends_at");
    // a lookup error is NOT the interactive helper's fail-open: under the flag it is a skip like a lapsed workspace
    state.orgError = "connection reset";
    const on = await scheduledRunGate(makeClient() as never, { ...DUE, bucket: "b" }, true);
    expect(on.ok).toBe(false);
    if (!on.ok) expect(on.reason).toBe("the workspace's subscription could not be verified (connection reset); retried next cycle");
    const off = await scheduledRunGate(makeClient() as never, { ...DUE, bucket: "b" }, false);
    expect(off.ok).toBe(true);
    expect(off.notices).toEqual(["billing gate would skip this run (SUBSCRIPTION_ENFORCE off): the workspace's subscription could not be verified (connection reset); retried next cycle"]);
    // the sweep records the flag-on skip as a cancelled run and delivers nothing
    process.env.SUBSCRIPTION_ENFORCE = "true";
    state.log = [];
    const res = await sweep();
    expect(res.status).toBe(200);
    expect(state.delivered).toEqual([]);
    expect(arg("export_runs", "insert")).toMatchObject({ status: "cancelled" });
    expect(String((arg("export_runs", "insert") as { error_message?: string }).error_message)).toMatch(/^skipped: the workspace's subscription could not be verified/);
  });
});

describe("POST /api/data-export/run-scheduled (XEDGE-7 / XEDGE-8 runner half)", () => {
  it("records a cancelled run and a failed last-run on the destination instead of pushing to a departed member's endpoint", async () => {
    state.memberActive = false;
    const res = await sweep();
    const body = await res.json();
    expect(state.delivered).toEqual([]);
    expect(body.results[0]).toMatchObject({ destinationId: "dest-1", ok: false });
    expect(body.results[0].error).toMatch(/^skipped: the member who last configured this destination is no longer active/);
    const run = arg("export_runs", "insert");
    expect(run).toMatchObject({ org_id: "org-1", destination_id: "dest-1", trigger_type: "scheduled", status: "cancelled", duration_ms: 0 });
    expect(String(run?.error_message)).toMatch(/^skipped:/);
    const dest = arg("export_destinations", "update", 1);
    expect(dest).toMatchObject({ last_run_status: "failed" });
    expect(String(dest?.last_run_error)).toMatch(/^skipped:/);
  });

  it("a skip whose record writes fail is logged and named on the sweep result — never a silent gap", async () => {
    state.memberActive = false;
    state.runInsertError = "new row violates check constraint export_runs_status_check";
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await sweep();
    const body = await res.json();
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/\[run-scheduled\] destination dest-1: run row not recorded: new row violates/));
    err.mockRestore();
    expect(state.delivered).toEqual([]);
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error).toMatch(/^skipped: the member who last configured this destination is no longer active/);
    expect(body.results[0].error).toMatch(/; run row not recorded: new row violates check constraint export_runs_status_check$/);
    // the destination's last-run status was still attempted after the failed insert
    expect(arg("export_destinations", "update", 1)).toMatchObject({ last_run_status: "failed" });
  });

  it("with SUBSCRIPTION_ENFORCE off a canceled workspace still exports, and the would-be skip is recorded on the run", async () => {
    state.subStatus = "canceled";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await sweep();
    const body = await res.json();
    warn.mockRestore();
    expect(state.delivered).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ ok: true, bytes: 10 });
    expect(body.results[0].warnings.join("\n")).toMatch(/subscription gate would skip this run/);
    const runUpdate = arg("export_runs", "update");
    expect((runUpdate?.diagnostics as Array<{ step: string }>).map((d) => d.step)).toEqual(["gate:notice", "zip:ready"]);
  });

  it("with SUBSCRIPTION_ENFORCE on a canceled workspace is skipped and recorded", async () => {
    process.env.SUBSCRIPTION_ENFORCE = "true";
    state.subStatus = "canceled";
    const res = await sweep();
    const body = await res.json();
    expect(state.delivered).toEqual([]);
    expect(body.results[0].error).toMatch(/^skipped: workspace subscription inactive/);
    expect(arg("export_runs", "insert")).toMatchObject({ status: "cancelled" });
  });

  it("an entitled destination with an active configurer runs exactly as before", async () => {
    const res = await sweep();
    const body = await res.json();
    expect(state.delivered).toHaveLength(1);
    expect(body.results[0]).toEqual({ destinationId: "dest-1", ok: true, bytes: 10 });
    expect(arg("export_runs", "insert")).toMatchObject({ status: "running" });
  });
});

describe("the plan gate on PATCH and POST (XEDGE-8)", () => {
  const patch = (body: Record<string, unknown>) => patchDestination(
    new NextRequest("https://app/api/data-export/destinations/dest-1", {
      method: "PATCH", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ orgId: "org-1", ...body }),
    }),
    { params: Promise.resolve({ id: "dest-1" }) },
  );

  it("PATCHing a bucket onto a Starter org's destination is 402 and writes nothing", async () => {
    state.plan = "starter";
    const res = await patch({ bucket: "their-bucket", endpoint: "https://s3.example", access_key_id: "AK", secret_access_key: "SK", schedule_kind: "daily" });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe(CLOUD_BUCKET_REFUSAL);
    expect(logged("export_destinations")).toEqual([]);
    expect(logged("audit_logs")).toEqual([]);
  });

  it("a Growth org may PATCH a bucket; a PATCH that does not touch the bucket is not plan-gated", async () => {
    state.plan = "growth";
    expect((await patch({ bucket: "b" })).status).toBe(200);
    state.plan = "starter";
    state.log = [];
    expect((await patch({ name: "renamed" })).status).toBe(200);
    expect(logged("orgs")).toEqual([]);
  });

  it("POST still refuses a bucket for a Starter org through the same helper", async () => {
    state.plan = "starter";
    const res = await createDestination(new NextRequest("https://app/api/data-export/destinations", {
      method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ orgId: "org-1", name: "n", destination_type: "s3", bucket: "b" }),
    }));
    expect(res.status).toBe(402);
    expect(logged("export_destinations")).toEqual([]);
  });
});
