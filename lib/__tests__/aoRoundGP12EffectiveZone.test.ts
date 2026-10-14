// public-surfaces VFY-15 (admin-and-org Round G, P12 — DEC-63 §4 reversal 4).
//
// The effective-date calendar is the document's WORKSPACE zone (an Admin's
// setting, org_configurations key "timezone") before the deployment
// variable. These pin:
//   · two workspaces in different zones decide the same effective date
//     differently at the same instant (done-when 3);
//   · no zone set, a stored value the runtime does not know, and an
//     UNREADABLE setting all fall back to the deployment variable — today's
//     behaviour — never silently to UTC (DEC-90 ruling);
//   · the callers pass the document's org: /api/verify, the suppression
//     watermark (applyEffectiveDate) and the daily scan (scanEffectiveDates)
//     decide in the workspace zone, and the badge / register / pack /
//     transmittal callers hand the zone to effectiveStatusFor (source pins).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

type Op = { m: string; args: unknown[] };
const st = vi.hoisted(() => ({
  /** org id → stored timeZone (undefined = no row) */
  zones: {} as Record<string, unknown>,
  zoneReadError: null as null | { message: string },
  calls: [] as Array<{ table: string; ops: Op[] }>,
  docs: [] as Array<Record<string, unknown>>,
  // verify-route fixtures
  verifyDoc: null as Record<string, unknown> | null,
  versionEffective: null as string | null,
}));

function answer(table: string, ops: Op[]): { data: unknown; error: unknown; count?: number } {
  const eq = (k: string) => ops.find((o) => o.m === "eq" && o.args[0] === k)?.args[1];
  if (table === "org_configurations") {
    if (st.zoneReadError) return { data: null, error: st.zoneReadError };
    const org = String(eq("org_id"));
    return { data: org in st.zones ? { data: { timeZone: st.zones[org] } } : null, error: null };
  }
  if (table === "documents" && ops.some((o) => o.m === "update")) return { data: [{ id: "d1" }], error: null };
  if (table === "document_versions" && ops.some((o) => o.m === "update")) return { data: [{ id: "v1" }], error: null };
  if (table === "documents" && ops.some((o) => o.m === "lte")) {
    const today = String(ops.find((o) => o.m === "lte")!.args[1]);
    return { data: st.docs.filter((d) => String(d.effective_date) <= today), error: null };
  }
  if (table === "documents") return { data: st.verifyDoc, error: null };
  if (table === "document_versions") {
    const id = eq("id");
    if (id === "11111111-1111-1111-1111-111111111111") return { data: { revision_label: "5", created_at: "2026-01-01", record_id: "22222222-2222-2222-2222-222222222222", effective_date: st.versionEffective }, error: null };
    return { data: [], error: null };
  }
  if (table === "verify_scans") return { data: null, error: null, count: 0 };
  return { data: [], error: null };
}

function chainFor(table: string) {
  const ops: Op[] = [];
  st.calls.push({ table, ops });
  const target: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (res: (v: unknown) => void, rej?: (e: unknown) => void) => Promise.resolve().then(() => answer(table, ops)).then(res, rej);
      return (...args: unknown[]) => {
        ops.push({ m: prop, args });
        if (prop === "maybeSingle" || prop === "single") return Promise.resolve(answer(table, ops));
        return new Proxy(target, handler);
      };
    },
  };
  return new Proxy(target, handler);
}

vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chainFor(t) } }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chainFor(t) }) }));
vi.mock("@/lib/complianceNotify", () => ({
  notifyCompliance: vi.fn(async () => true),
  loadScanRetryPlan: vi.fn(async () => ({ only: () => () => true })),
}));
vi.mock("@/lib/ownership", () => ({
  effectiveOwnerForDocument: vi.fn(async () => ({ userId: "own", name: "Olive" })),
  getOrgControllers: vi.fn(async () => ["ctrl"]),
}));

import {
  effectiveStatusFor, effectiveDateTimeZone, workspaceEffectiveDateTimeZone, cachedWorkspaceEffectiveDateTimeZone,
  resetWorkspaceZoneCacheForTests, applyEffectiveDate, scanEffectiveDates, daysUntilEffective, EFFECTIVE_DATE_FALLBACK_TIME_ZONE,
} from "@/lib/effectiveDate";
import { supabase } from "@/lib/supabase";

// 2026-03-01T20:00:00Z: 04:00 on 2 March in Perth (UTC+8), 14:00 on 1 March
// in Chicago (UTC-6, before the US switch on 8 March).
const INSTANT = new Date("2026-03-01T20:00:00Z");
const EFFECTIVE = "2026-03-02";

const prevZone = process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE;
beforeEach(() => {
  st.zones = {}; st.zoneReadError = null; st.calls = []; st.docs = [];
  st.verifyDoc = null; st.versionEffective = null;
  resetWorkspaceZoneCacheForTests();
  process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = "America/Chicago";
});
afterEach(() => {
  vi.restoreAllMocks();
  if (prevZone === undefined) delete process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE;
  else process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = prevZone;
});

describe("VFY-15 — the resolver prefers the workspace's zone", () => {
  it("done-when 3: two workspaces in different zones decide the same date differently at the same instant", async () => {
    st.zones = { perth: "Australia/Perth", houston: "America/Chicago" };
    const perth = await workspaceEffectiveDateTimeZone(supabase, "perth");
    const houston = await workspaceEffectiveDateTimeZone(supabase, "houston");
    expect(perth).toBe("Australia/Perth");
    expect(houston).toBe("America/Chicago");
    expect(effectiveStatusFor(EFFECTIVE, INSTANT, perth)).toBe("effective");
    expect(effectiveStatusFor(EFFECTIVE, INSTANT, houston)).toBe("pending");
    expect(daysUntilEffective(EFFECTIVE, INSTANT, perth)).toBe(0);
    expect(daysUntilEffective(EFFECTIVE, INSTANT, houston)).toBe(1);
  });

  it("the mirror case (the unsafe one in the finding): a deployment set to Perth no longer lifts a Houston date early", async () => {
    process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = "Australia/Perth";
    st.zones = { houston: "America/Chicago" };
    // before: the deployment's calendar alone said "in effect"
    expect(effectiveStatusFor(EFFECTIVE, INSTANT)).toBe("effective");
    expect(effectiveStatusFor(EFFECTIVE, INSTANT, await workspaceEffectiveDateTimeZone(supabase, "houston"))).toBe("pending");
  });

  it("no zone set, a stored value the runtime does not know, or no org: the deployment variable decides (today's behaviour)", async () => {
    expect(await workspaceEffectiveDateTimeZone(supabase, "unset")).toBe("America/Chicago");
    st.zones = { bad: "Mars/Olympus_Mons" };
    expect(await workspaceEffectiveDateTimeZone(supabase, "bad")).toBe("America/Chicago");
    expect(await workspaceEffectiveDateTimeZone(supabase, null)).toBe("America/Chicago");
    expect(effectiveDateTimeZone("Mars/Olympus_Mons")).toBe("America/Chicago");
    expect(effectiveDateTimeZone("  ")).toBe("America/Chicago");
  });

  it("an UNREADABLE setting falls back to the deployment variable — never silently to UTC — and is said once per workspace", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    st.zoneReadError = { message: "permission denied for table org_configurations" };
    expect(await workspaceEffectiveDateTimeZone(supabase, "perth")).toBe("America/Chicago");
    expect(await workspaceEffectiveDateTimeZone(supabase, "perth")).toBe("America/Chicago");
    expect(err.mock.calls.filter((c) => String(c[0]).includes("could not be read"))).toHaveLength(1);
    // with no deployment zone either, it is UTC-12 (never early), not UTC
    delete process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE;
    expect(await workspaceEffectiveDateTimeZone(supabase, "perth")).toBe(EFFECTIVE_DATE_FALLBACK_TIME_ZONE);
    expect(await workspaceEffectiveDateTimeZone(supabase, "perth")).not.toBe("UTC");
  });

  it("a client whose read throws still answers (never rejects)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing = { from: () => { throw new Error("offline"); } };
    expect(await workspaceEffectiveDateTimeZone(throwing, "o1")).toBe("America/Chicago");
    expect(await cachedWorkspaceEffectiveDateTimeZone(throwing, "o1")).toBe("America/Chicago");
  });

  it("REGRESSION: with no zone passed, every helper decides exactly as before (the deployment's calendar)", () => {
    expect(effectiveStatusFor(EFFECTIVE, INSTANT)).toBe("pending"); // Chicago
    expect(effectiveStatusFor(EFFECTIVE, INSTANT, undefined)).toBe("pending");
    expect(effectiveStatusFor(null, INSTANT, "Australia/Perth")).toBe("none");
    expect(effectiveDateTimeZone()).toBe("America/Chicago");
  });

  it("the browser cache reads a workspace's setting once per few minutes", async () => {
    st.zones = { perth: "Australia/Perth" };
    const t0 = 1_000_000;
    expect(await cachedWorkspaceEffectiveDateTimeZone(supabase, "perth", t0)).toBe("Australia/Perth");
    expect(await cachedWorkspaceEffectiveDateTimeZone(supabase, "perth", t0 + 60_000)).toBe("Australia/Perth");
    expect(st.calls.filter((c) => c.table === "org_configurations")).toHaveLength(1);
    st.zones = { perth: "America/Chicago" };
    expect(await cachedWorkspaceEffectiveDateTimeZone(supabase, "perth", t0 + 6 * 60_000)).toBe("America/Chicago");
  });
});

describe("VFY-15 — the watermark and the scan decide in the workspace's calendar", () => {
  it("applyEffectiveDate: a date already in force in Perth is pre-stamped (never announced), as the scan would treat it", async () => {
    vi.useFakeTimers(); vi.setSystemTime(INSTANT);
    try {
      st.zones = { perth: "Australia/Perth" };
      await applyEffectiveDate({ documentId: "d1", versionId: "v1", effectiveDate: EFFECTIVE, orgId: "perth" });
      const docUpdate = st.calls.find((c) => c.table === "documents" && c.ops.some((o) => o.m === "update"))!;
      expect((docUpdate.ops.find((o) => o.m === "update")!.args[0] as Record<string, unknown>).effective_notified_at).not.toBeNull();
      // the same date for a Houston document is still ahead: left for the scan
      st.calls = [];
      st.zones = { houston: "America/Chicago" };
      await applyEffectiveDate({ documentId: "d1", versionId: "v1", effectiveDate: EFFECTIVE, orgId: "houston" });
      const docUpdate2 = st.calls.find((c) => c.table === "documents" && c.ops.some((o) => o.m === "update"))!;
      expect((docUpdate2.ops.find((o) => o.m === "update")!.args[0] as Record<string, unknown>).effective_notified_at).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("applyEffectiveDate: no date reads no setting; no org decides in the deployment's calendar (REGRESSION)", async () => {
    await applyEffectiveDate({ documentId: "d1", versionId: "v1", effectiveDate: null, orgId: "perth" });
    expect(st.calls.some((c) => c.table === "org_configurations")).toBe(false);
    await applyEffectiveDate({ documentId: "d1", versionId: "v1", effectiveDate: "2099-01-01" });
    expect(st.calls.some((c) => c.table === "org_configurations")).toBe(false);
  });

  it("scanEffectiveDates reads 'today' in the workspace's zone", async () => {
    vi.useFakeTimers(); vi.setSystemTime(INSTANT);
    try {
      st.zones = { perth: "Australia/Perth" };
      await scanEffectiveDates("perth");
      const lte = st.calls.find((c) => c.table === "documents" && c.ops.some((o) => o.m === "lte"))!;
      expect(lte.ops.find((o) => o.m === "lte")!.args).toEqual(["effective_date", "2026-03-02"]);
      st.calls = [];
      await scanEffectiveDates("houston"); // no zone set → the deployment's (Chicago)
      const lte2 = st.calls.find((c) => c.table === "documents" && c.ops.some((o) => o.m === "lte"))!;
      expect(lte2.ops.find((o) => o.m === "lte")!.args).toEqual(["effective_date", "2026-03-01"]);
    } finally { vi.useRealTimers(); }
  });
});

describe("VFY-15 — /api/verify answers in the document's workspace calendar", () => {
  const DOC = "22222222-2222-2222-2222-222222222222";
  async function verify(): Promise<Record<string, unknown>> {
    const { GET } = await import("@/app/api/verify/route");
    const u = new URL("https://app/api/verify");
    u.searchParams.set("doc", DOC);
    u.searchParams.set("v", "11111111-1111-1111-1111-111111111111");
    return (await (await GET(new NextRequest(u))).json()) as Record<string, unknown>;
  }
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  });
  const doc = (org: string) => ({
    id: DOC, org_id: org, document_number: "P-101", title: "P&ID", name: "P-101", rev: "5", status: "Issued",
    current_version_id: "11111111-1111-1111-1111-111111111111", legal_hold: false,
  });

  it("the same paper, the same instant: green for the Perth workspace, NOT YET IN EFFECT for the Houston one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(INSTANT);
    try {
      // the current-version read is keyed by id; route the fixture through it
      st.versionEffective = EFFECTIVE;
      st.zones = { perth: "Australia/Perth", houston: "America/Chicago" };
      process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = "Australia/Perth";
      st.verifyDoc = doc("houston");
      const h = await verify();
      expect(h.verdict).toBe("not_yet_effective");
      st.verifyDoc = doc("perth");
      process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = "America/Chicago";
      const p = await verify();
      expect(p.verdict).toBe("current");
      // org_id never leaves the server
      expect(p).not.toHaveProperty("org_id");
      expect(JSON.stringify(p)).not.toContain("perth");
    } finally { vi.useRealTimers(); }
  });

  it("an unreadable setting: the deployment's calendar decides, as before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(INSTANT);
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      st.versionEffective = EFFECTIVE;
      st.zoneReadError = { message: "timeout" };
      st.verifyDoc = doc("perth");
      process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = "America/Chicago";
      expect((await verify()).verdict).toBe("not_yet_effective");
    } finally { vi.useRealTimers(); }
  });
});

describe("VFY-15 — every caller passes the document's org (source pins)", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("the public pack, the transmittal portal, the register and the badge hand the workspace zone to effectiveStatusFor", () => {
    expect(src("app/api/verify-package/route.ts")).toMatch(/await workspaceEffectiveDateTimeZone\(sb, pkgOrgId \|\| null\)/);
    expect(src("app/api/verify-package/route.ts")).toContain("effectiveStatusFor(d.current_version_id ? effectiveByVersion.get(d.current_version_id) : null, new Date(), effectiveZone)");
    expect(src("app/api/transmittal/route.ts")).toMatch(/await workspaceEffectiveDateTimeZone\(supabaseAdmin, orgId\)/);
    expect(src("app/api/transmittal/route.ts")).toMatch(/effectiveStatusFor\(i\.effectiveDate \?\? null, new Date\(\), effectiveZone\)/);
    expect(src("lib/docControlRegister.ts")).toMatch(/await cachedWorkspaceEffectiveDateTimeZone\(supabase, orgId\)/);
    expect(src("components/documents/EffectivePill.tsx")).toMatch(/effectiveStatusFor\(effectiveDate, now, zone\)/);
    expect(src("app/(protected)/documents/[libraryId]/page.tsx")).toMatch(/<EffectivePill effectiveDate=\{docRecord\.effectiveDate\} orgId=\{docRecord\.orgId \?\? activeOrgId\} compact \/>/);
    expect(src("components/documents/InspectorPanel.tsx")).toMatch(/<EffectivePill effectiveDate=\{selectedDoc\.effectiveDate\} orgId=\{selectedDoc\.orgId \?\? orgId \?\? null\} \/>/);
    expect(src("app/(protected)/register/page.tsx")).toMatch(/<EffectivePill effectiveDate=\{r\.effectiveDate\} orgId=\{activeOrgId\} compact \/>/);
  });
  it("the watermark's callers pass the document's org (the revert passes no date, so no calendar)", () => {
    expect(src("lib/revisions.ts")).toMatch(/applyEffectiveDate\(\{ documentId: doc\.id, versionId: newVersion\.id \?\? "", effectiveDate: input\.effectiveDate \?\? null, orgId \}\)/);
    expect(src("lib/reviewControl.ts")).toMatch(/applyEffectiveDate\(\{ documentId: input\.documentId, versionId: pendingId, effectiveDate, orgId: input\.orgId \}\)/);
  });
});
