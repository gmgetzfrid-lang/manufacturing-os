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
  // VFY-15 re-review: who set the zone. org id → WORKSPACE_TIMEZONE_CHANGED
  // rows, newest first; undefined = one row by the Admin "adm" naming the
  // stored zone (the legitimate save on /admin/settings).
  zoneAudit: {} as Record<string, Array<Record<string, unknown>>>,
  auditReadError: null as null | { message: string; code?: string },
  missingActorKind: false,
  members: [] as Array<Record<string, unknown>>,
  caller: "adm" as string | null,
}));

const ADMIN = { uid: "adm", role: "Admin", roles: ["Admin"], status: "active" };
const VIEWER = { uid: "vw", role: "Viewer", roles: ["Viewer"], status: "active" };

function answer(table: string, ops: Op[]): { data: unknown; error: unknown; count?: number } {
  const eq = (k: string) => ops.find((o) => o.m === "eq" && o.args[0] === k)?.args[1];
  if (table === "org_configurations") {
    if (st.zoneReadError) return { data: null, error: st.zoneReadError };
    const org = String(eq("org_id"));
    return { data: org in st.zones ? { data: { timeZone: st.zones[org] } } : null, error: null };
  }
  if (table === "audit_logs" && ops.some((o) => o.m === "select")) {
    if (st.auditReadError) return { data: null, error: st.auditReadError };
    const cols = String(ops.find((o) => o.m === "select")!.args[0] ?? "");
    if (st.missingActorKind && cols.includes("actor_kind")) return { data: null, error: { code: "42703", message: "column audit_logs.actor_kind does not exist" } };
    const org = String(eq("org_id"));
    const rows = st.zoneAudit[org] ?? (org in st.zones ? [{ user_id: "adm", actor_kind: "member", details: { before: null, after: st.zones[org] } }] : []);
    return { data: st.missingActorKind ? rows.map(({ actor_kind: _gone, ...r }) => r) : rows, error: null };
  }
  if (table === "org_members" && ops.some((o) => o.m === "select")) {
    if (eq("uid") !== undefined) return { data: st.members.find((m) => m.uid === eq("uid")) ?? null, error: null };
    const uids = (ops.find((o) => o.m === "in" && o.args[0] === "uid")?.args[1] ?? []) as string[];
    return { data: st.members.filter((m) => uids.includes(String(m.uid)) && m.status === eq("status")), error: null };
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
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({
  from: (t: string) => chainFor(t),
  auth: { getUser: async () => (st.caller ? { data: { user: { id: st.caller, email: `${st.caller}@x.io` } }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
}) }));
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
  workspaceEffectiveZoneHonoured, WORKSPACE_EFFECTIVE_ZONE_PREREQUISITE, decideWorkspaceEffectiveZone,
} from "@/lib/effectiveDate";
import { supabase } from "@/lib/supabase";

// 2026-03-01T20:00:00Z: 04:00 on 2 March in Perth (UTC+8), 14:00 on 1 March
// in Chicago (UTC-6, before the US switch on 8 March).
const INSTANT = new Date("2026-03-01T20:00:00Z");
const EFFECTIVE = "2026-03-02";

const prevZone = process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE;
const prevGate = process.env.NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE;
beforeEach(() => {
  st.zones = {}; st.zoneReadError = null; st.calls = []; st.docs = [];
  st.verifyDoc = null; st.versionEffective = null;
  st.zoneAudit = {}; st.auditReadError = null; st.missingActorKind = false; st.members = [ADMIN, VIEWER]; st.caller = "adm";
  resetWorkspaceZoneCacheForTests();
  process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = "America/Chicago";
  // These suites describe the deployment AFTER 20261203 is pasted and
  // recorded (the review-fix gate); the gate's own suite below unsets it.
  process.env.NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE = "20261203";
});
afterEach(() => {
  vi.restoreAllMocks();
  if (prevZone === undefined) delete process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE;
  else process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = prevZone;
  if (prevGate === undefined) delete process.env.NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE;
  else process.env.NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE = prevGate;
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

// Review fix (blocker): until 20261203 is pasted the 'timezone' key is any
// active member's to write (the permissive org policy; 20260818's
// restrictive policies end ELSE true), so the stored zone decides nothing
// until the deployment records the paste.
describe("VFY-15 review fix — the workspace zone decides nothing until 20261203 is recorded live", () => {
  const DOC = "22222222-2222-2222-2222-222222222222";
  const verifyDoc = (org: string) => ({
    id: DOC, org_id: org, document_number: "P-101", title: "P&ID", name: "P-101", rev: "5", status: "Issued",
    current_version_id: "11111111-1111-1111-1111-111111111111", legal_hold: false,
  });

  it("the flag must name the migration exactly: unset, 'on', 'true' or another number honour nothing", () => {
    expect(WORKSPACE_EFFECTIVE_ZONE_PREREQUISITE).toBe("20261203");
    for (const v of [undefined, "", "on", "true", "1", "20261204"]) {
      if (v === undefined) delete process.env.NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE;
      else process.env.NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE = v;
      expect(workspaceEffectiveZoneHonoured()).toBe(false);
    }
    process.env.NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE = " 20261203 ";
    expect(workspaceEffectiveZoneHonoured()).toBe(true);
  });

  it("before the paste is recorded: a member-written Pacific/Kiritimati is not read, every helper decides in the deployment's calendar", async () => {
    delete process.env.NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE;
    st.zones = { w: "Pacific/Kiritimati" };
    expect(await workspaceEffectiveDateTimeZone(supabase, "w")).toBe("America/Chicago");
    expect(await cachedWorkspaceEffectiveDateTimeZone(supabase, "w")).toBe("America/Chicago");
    expect(st.calls.some((c) => c.table === "org_configurations")).toBe(false);
    // the scan and the watermark too
    vi.useFakeTimers(); vi.setSystemTime(INSTANT);
    try {
      await scanEffectiveDates("w");
      const lte = st.calls.find((c) => c.table === "documents" && c.ops.some((o) => o.m === "lte"))!;
      expect(lte.ops.find((o) => o.m === "lte")!.args).toEqual(["effective_date", "2026-03-01"]);
      st.calls = [];
      await applyEffectiveDate({ documentId: "d1", versionId: "v1", effectiveDate: EFFECTIVE, orgId: "w" });
      const upd = st.calls.find((c) => c.table === "documents" && c.ops.some((o) => o.m === "update"))!;
      expect((upd.ops.find((o) => o.m === "update")!.args[0] as Record<string, unknown>).effective_notified_at).toBeNull();
      expect(st.calls.some((c) => c.table === "org_configurations")).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("the finding's scenario at /api/verify: a Viewer's Kiritimati does not turn tomorrow's revision green before the paste; after it, the Admin's zone decides", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(INSTANT);
    try {
      const { GET } = await import("@/app/api/verify/route");
      const ask = async () => {
        const u = new URL("https://app/api/verify");
        u.searchParams.set("doc", DOC);
        u.searchParams.set("v", "11111111-1111-1111-1111-111111111111");
        return ((await (await GET(new NextRequest(u))).json()) as Record<string, unknown>).verdict;
      };
      st.versionEffective = EFFECTIVE;
      st.zones = { w: "Pacific/Kiritimati" };
      st.verifyDoc = verifyDoc("w");
      delete process.env.NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE;
      expect(await ask()).toBe("not_yet_effective"); // Chicago: 1 March
      resetWorkspaceZoneCacheForTests();
      process.env.NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE = "20261203";
      expect(await ask()).toBe("current"); // the (now Admin-only) zone: 2 March
    } finally { vi.useRealTimers(); }
  });

  it("the settings card says which calendar decides effective dates, by the same gate", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/admin/settings/page.tsx"), "utf8");
    expect(page).toMatch(/import \{ workspaceEffectiveZoneHonoured, [^}]*\} from "@\/lib\/effectiveDate";/);
    expect(page).toMatch(/\{workspaceEffectiveZoneHonoured\(\)\s*\? <>Effective dates and whether a revision is &ldquo;in effect&rdquo; are decided in this zone too/);
    expect(page).toContain("still follow the deployment&apos;s facility time zone, not this setting, until the deployment enables it.");
    expect(page).not.toContain("until that change lands");
  });

  it("the operator's switch is documented beside the deployment zone", () => {
    const env = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    expect(env).toMatch(/^NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE=$/m);
    expect(env).toMatch(/AFTER 20261203 is pasted/);
  });
});

// Re-review (DEC-90, fail safe): with the switch set, the stored zone decides
// only when its writer is shown to be an Admin — the row has no writer
// column and 20261203 stamps no marker, so the writer is read from the
// newest trustworthy WORKSPACE_TIMEZONE_CHANGED row (an Admin at read time,
// or actor_kind server / system). Otherwise the deployment's calendar
// decides and the Admin is asked to re-confirm.
describe("VFY-15 re-review — the workspace zone is honoured only when an Admin is shown to have set it", () => {
  const audit = (user_id: string | null, after: unknown, extra: Record<string, unknown> = {}) =>
    ({ user_id, actor_kind: user_id ? "member" : "system", details: { before: null, after }, ...extra });

  it("REGRESSION: the Admin's save (the legitimate path) is honoured exactly as before", async () => {
    st.zones = { perth: "Australia/Perth" };
    expect(await decideWorkspaceEffectiveZone(supabase, "perth")).toEqual({ zone: "Australia/Perth", honoured: true, reconfirm: false, stored: "Australia/Perth" });
  });

  it("a legacy row a non-Admin wrote before 20261203 (their own audit row, or none at all): the deployment's calendar, and the Admin is asked to re-confirm", async () => {
    st.zones = { w: "Pacific/Kiritimati" };
    st.zoneAudit = { w: [audit("vw", "Pacific/Kiritimati")] };
    expect(await decideWorkspaceEffectiveZone(supabase, "w")).toEqual({ zone: "America/Chicago", honoured: false, reconfirm: true, stored: "Pacific/Kiritimati" });
    expect(await workspaceEffectiveDateTimeZone(supabase, "w")).toBe("America/Chicago");
    st.zoneAudit = { w: [] };
    expect(await decideWorkspaceEffectiveZone(supabase, "w")).toMatchObject({ zone: "America/Chicago", honoured: false, reconfirm: true });
    // a row with no writer and no server actor_kind is not evidence either
    st.zoneAudit = { w: [{ user_id: null, details: { after: "Pacific/Kiritimati" } }] };
    expect(await decideWorkspaceEffectiveZone(supabase, "w")).toMatchObject({ honoured: false, reconfirm: true });
  });

  it("the row was changed after the Admin's save (the newest trusted record names another zone): not honoured", async () => {
    st.zones = { w: "Pacific/Kiritimati" };
    st.zoneAudit = { w: [audit("adm", "America/Chicago")] };
    expect(await decideWorkspaceEffectiveZone(supabase, "w")).toMatchObject({ zone: "America/Chicago", honoured: false, reconfirm: true });
    // an OLDER Admin record naming the stored zone does not count
    st.zoneAudit = { w: [audit("adm", "Europe/London"), audit("adm", "Pacific/Kiritimati")] };
    expect(await decideWorkspaceEffectiveZone(supabase, "w")).toMatchObject({ honoured: false, reconfirm: true });
  });

  it("a member's forged record is ignored both ways: it neither vouches for its zone nor hides the Admin's", async () => {
    st.zones = { w: "Pacific/Kiritimati" };
    st.zoneAudit = { w: [audit("vw", "Pacific/Kiritimati"), audit("adm", "America/Denver")] };
    expect(await decideWorkspaceEffectiveZone(supabase, "w")).toMatchObject({ honoured: false });
    st.zones = { w: "America/Denver" };
    expect(await decideWorkspaceEffectiveZone(supabase, "w")).toMatchObject({ zone: "America/Denver", honoured: true, reconfirm: false });
  });

  it("the writer is checked against the CURRENT role: an Admin since demoted (or suspended) no longer vouches", async () => {
    st.zones = { w: "Australia/Perth" };
    st.members = [{ ...ADMIN, role: "Manager", roles: ["Manager"] }];
    expect(await decideWorkspaceEffectiveZone(supabase, "w")).toMatchObject({ honoured: false, reconfirm: true });
    st.members = [{ ...ADMIN, status: "suspended" }];
    expect(await decideWorkspaceEffectiveZone(supabase, "w")).toMatchObject({ honoured: false, reconfirm: true });
    // an additive Admin (collection, not headline) vouches
    st.members = [{ ...ADMIN, role: "Manager", roles: ["Manager", "Admin"] }];
    expect(await decideWorkspaceEffectiveZone(supabase, "w")).toMatchObject({ honoured: true });
  });

  it("a server / system record vouches (a restore or a database function's write)", async () => {
    for (const kind of ["server", "system"]) {
      st.zones = { w: "Australia/Perth" };
      st.zoneAudit = { w: [{ user_id: null, actor_kind: kind, details: { after: "Australia/Perth" } }] };
      expect(await decideWorkspaceEffectiveZone(supabase, "w")).toMatchObject({ zone: "Australia/Perth", honoured: true });
    }
  });

  it("before 20261201 (no actor_kind column, 42703): the read is repeated without it and only the Admin-writer rule applies", async () => {
    st.missingActorKind = true;
    st.zones = { w: "Australia/Perth" };
    expect(await decideWorkspaceEffectiveZone(supabase, "w")).toMatchObject({ honoured: true });
    st.zoneAudit = { w: [{ user_id: null, actor_kind: "system", details: { after: "Australia/Perth" } }] };
    expect(await decideWorkspaceEffectiveZone(supabase, "w")).toMatchObject({ honoured: false, reconfirm: true });
    const auditReads = st.calls.filter((c) => c.table === "audit_logs").map((c) => String(c.ops.find((o) => o.m === "select")!.args[0]));
    expect(auditReads).toContain("details, timestamp, user_id, actor_kind");
    expect(auditReads).toContain("details, timestamp, user_id");
  });

  it("the audit trail or the writers' roles cannot be read: the deployment's calendar, said once, no re-confirm notice", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    st.zones = { w: "Australia/Perth" };
    st.auditReadError = { message: "timeout" };
    expect(await decideWorkspaceEffectiveZone(supabase, "w")).toEqual({ zone: "America/Chicago", honoured: false, reconfirm: false, stored: "Australia/Perth" });
    expect(await workspaceEffectiveDateTimeZone(supabase, "w")).toBe("America/Chicago");
    expect(err.mock.calls.filter((c) => String(c[0]).includes("could not be read"))).toHaveLength(1);
  });

  it("no zone stored, or one this runtime does not know: the deployment's calendar and no notice (as before)", async () => {
    expect(await decideWorkspaceEffectiveZone(supabase, "unset")).toEqual({ zone: "America/Chicago", honoured: false, reconfirm: false, stored: null });
    st.zones = { bad: "Mars/Olympus_Mons" };
    expect(await decideWorkspaceEffectiveZone(supabase, "bad")).toMatchObject({ honoured: false, reconfirm: false });
  });

  it("switch unset: nothing is read at all, whoever wrote the row (REGRESSION)", async () => {
    delete process.env.NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE;
    st.zones = { perth: "Australia/Perth" };
    expect(await decideWorkspaceEffectiveZone(supabase, "perth")).toEqual({ zone: "America/Chicago", honoured: false, reconfirm: false, stored: null });
    expect(st.calls).toEqual([]);
  });

  it("/api/verify: a legacy non-Admin Kiritimati does not turn tomorrow's revision green even with the switch set", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(INSTANT);
    try {
      const { GET } = await import("@/app/api/verify/route");
      const DOC = "22222222-2222-2222-2222-222222222222";
      const u = new URL("https://app/api/verify");
      u.searchParams.set("doc", DOC);
      u.searchParams.set("v", "11111111-1111-1111-1111-111111111111");
      st.versionEffective = EFFECTIVE;
      st.zones = { w: "Pacific/Kiritimati" };
      st.zoneAudit = { w: [audit("vw", "Pacific/Kiritimati")] };
      st.verifyDoc = { id: DOC, org_id: "w", document_number: "P-101", title: "P&ID", name: "P-101", rev: "5", status: "Issued", current_version_id: "11111111-1111-1111-1111-111111111111", legal_hold: false };
      expect(((await (await GET(new NextRequest(u))).json()) as Record<string, unknown>).verdict).toBe("not_yet_effective");
    } finally { vi.useRealTimers(); }
  });

  it("the scan and the watermark follow the same decision (legacy non-Admin row → the deployment's calendar)", async () => {
    vi.useFakeTimers(); vi.setSystemTime(INSTANT);
    try {
      st.zones = { w: "Australia/Perth" };
      st.zoneAudit = { w: [audit("vw", "Australia/Perth")] };
      await scanEffectiveDates("w");
      const lte = st.calls.find((c) => c.table === "documents" && c.ops.some((o) => o.m === "lte"))!;
      expect(lte.ops.find((o) => o.m === "lte")!.args).toEqual(["effective_date", "2026-03-01"]);
    } finally { vi.useRealTimers(); }
  });
});

describe("VFY-15 re-review — /api/workspace-effective-zone answers the browser", () => {
  const ask = async (orgId = "w") => {
    const { GET } = await import("@/app/api/workspace-effective-zone/route");
    const res = await GET(new NextRequest(`https://app/api/workspace-effective-zone?orgId=${orgId}`, { headers: { authorization: "Bearer t" } }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  });

  it("switch unset: the deployment's calendar, nothing read, no sign-in needed", async () => {
    delete process.env.NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE;
    expect(await ask()).toEqual({ status: 200, body: { zone: "America/Chicago", honoured: false, reconfirm: false, stored: null } });
  });

  it("switch set: the Admin hears the decision with the re-confirm notice; a Viewer the same calendar without it; a non-member is refused", async () => {
    st.zones = { w: "Pacific/Kiritimati" };
    st.zoneAudit = { w: [{ user_id: "vw", actor_kind: "member", details: { after: "Pacific/Kiritimati" } }] };
    expect(await ask()).toEqual({ status: 200, body: { zone: "America/Chicago", honoured: false, reconfirm: true, stored: "Pacific/Kiritimati" } });
    st.caller = "vw";
    expect(await ask()).toEqual({ status: 200, body: { zone: "America/Chicago", honoured: false, reconfirm: false, stored: null } });
    st.caller = "stranger";
    expect((await ask()).status).toBe(403);
    st.caller = null;
    expect((await ask()).status).toBe(401);
    // REGRESSION: the Admin's own save is honoured for every member
    st.caller = "vw";
    st.zones = { w: "Australia/Perth" }; st.zoneAudit = {};
    expect(await ask()).toEqual({ status: 200, body: { zone: "Australia/Perth", honoured: true, reconfirm: false, stored: null } });
  });

  it("source pins: any active member may ask; the re-confirm notice and the stored value are said only to an Admin; the browser helper calls it", () => {
    const route = readFileSync(join(process.cwd(), "app/api/workspace-effective-zone/route.ts"), "utf8");
    expect(route).toMatch(/authorizeOrgRole\(req, orgId, \[\.\.\.ALL_ROLES\]\)/);
    expect(route).toMatch(/decideWorkspaceEffectiveZone\(actor\.admin, orgId\)/);
    expect(route).toMatch(/reconfirm: isAdmin \? d\.reconfirm : false/);
    const lib = readFileSync(join(process.cwd(), "lib/effectiveDate.ts"), "utf8");
    expect(lib).toMatch(/if \(inBrowser\(\)\) \{\s*const d = await fetchWorkspaceZoneDecision\(orgId\);/);
  });
});
