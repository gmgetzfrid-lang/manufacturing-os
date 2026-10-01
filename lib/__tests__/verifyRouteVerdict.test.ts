// /api/verify verdict per document status (DIST-2), extended by
// public-surfaces Round F PS-VERIFY (VFY-1 / VFY-3 / VFY-4 / VFY-5 / VFY-9 /
// VFY-12 / VFY-13 / VFY-14).
//
// The QR verify endpoint is the only recall channel that reaches paper. Its
// verdict must be honest for EVERY DocumentStatus and for an active hold — a
// new status must never default to green. These pin one verdict per status.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const V = "11111111-1111-1111-1111-111111111111"; // current version id
const V_OLD = "33333333-3333-3333-3333-333333333333"; // an older version of the same document
const DOC = "22222222-2222-2222-2222-222222222222";

const state = vi.hoisted(() => ({
  doc: null as Record<string, unknown> | null,
  docError: false as boolean,
  holdRows: [] as unknown[],
  holdError: false as boolean,
  effectiveDate: null as string | null,
  scanCount: 0 as number,
  scanCountError: false as boolean,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  selects: [] as Array<{ table: string; cols: string }>,
}));

function chain(table: string) {
  const filters: Record<string, unknown> = {};
  let head = false;
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, p: string) {
      if (p === "then") {
        return (resolve: (v: unknown) => void) => {
          if (table === "verify_scans" && head) {
            resolve(state.scanCountError ? { data: null, error: { message: "relation does not exist" }, count: null } : { data: null, error: null, count: state.scanCount });
          } else if (table === "document_holds") {
            resolve(state.holdError ? { data: null, error: { message: "x" } } : { data: state.holdRows, error: null });
          } else resolve({ data: [], error: null });
        };
      }
      return (...args: unknown[]) => {
        if (p === "select") {
          state.selects.push({ table, cols: String(args[0]) });
          if ((args[1] as { head?: boolean } | undefined)?.head) head = true;
        }
        if (p === "insert") state.inserts.push({ table, row: args[0] as Record<string, unknown> });
        if (p === "eq") filters[args[0] as string] = args[1];
        if (p === "maybeSingle") {
          if (table === "documents") return Promise.resolve(state.docError ? { data: null, error: { message: "boom" } } : { data: state.doc, error: null });
          if (table === "document_versions") {
            // current version lookup + printed version lookup both resolve here
            if (filters.id === V) return Promise.resolve({ data: { revision_label: "5", created_at: "2026-01-01", record_id: DOC, effective_date: state.effectiveDate }, error: null });
            if (filters.id === V_OLD) return Promise.resolve({ data: { revision_label: "4", created_at: "2025-06-01", record_id: DOC }, error: null });
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chain(t) }) }));

const OLD_ENV = { ...process.env };
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  state.doc = null;
  state.docError = false;
  state.holdRows = [];
  state.holdError = false;
  state.effectiveDate = null;
  state.scanCount = 0;
  state.scanCountError = false;
  state.inserts = [];
  state.selects = [];
});
afterEach(() => {
  vi.useRealTimers();
  if (OLD_ENV.NEXT_PUBLIC_FACILITY_TIME_ZONE === undefined) delete process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE;
  else process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = OLD_ENV.NEXT_PUBLIC_FACILITY_TIME_ZONE;
});

async function call(opts: { v?: string | null; headers?: Record<string, string> } = {}) {
  const { GET } = await import("@/app/api/verify/route");
  const u = new URL("https://app/api/verify");
  u.searchParams.set("doc", DOC);
  const v = opts.v === undefined ? V : opts.v; // by default the print carries the CURRENT version id
  if (v) u.searchParams.set("v", v);
  return GET(new NextRequest(u, { headers: opts.headers }));
}
async function verify(opts: { v?: string | null } = {}): Promise<Record<string, unknown>> {
  return (await (await call(opts)).json()) as Record<string, unknown>;
}

const docWith = (status: string | null, extra: Record<string, unknown> = {}) => ({
  id: DOC, document_number: "P-101", title: "P&ID", name: "P-101",
  rev: "5", status, current_version_id: V, legal_hold: false, ...extra,
});

describe("/api/verify verdict per status (DIST-2)", () => {
  it("Issued current version → current / isCurrent true", async () => {
    state.doc = docWith("Issued");
    const r = await verify();
    expect(r.verdict).toBe("current");
    expect(r.isCurrent).toBe(true);
  });

  it("Void → void, never green", async () => {
    state.doc = docWith("Void");
    const r = await verify();
    expect(r.verdict).toBe("void");
    expect(r.isCurrent).toBe(false);
  });

  it("Superseded → superseded", async () => {
    state.doc = docWith("Superseded");
    const r = await verify();
    expect(r.verdict).toBe("superseded");
    expect(r.isCurrent).toBe(false);
  });

  it("Archived → archived", async () => {
    state.doc = docWith("Archived");
    const r = await verify();
    expect(r.verdict).toBe("archived");
    expect(r.isCurrent).toBe(false);
  });

  it("Draft → draft, not green", async () => {
    state.doc = docWith("Draft");
    const r = await verify();
    expect(r.verdict).toBe("draft");
    expect(r.isCurrent).toBe(false);
  });

  it("an active hold overrides even a current Issued version → held", async () => {
    state.doc = docWith("Issued");
    state.holdRows = [{ id: "h1" }];
    const r = await verify();
    expect(r.verdict).toBe("held");
    expect(r.isCurrent).toBe(false);
    expect(r.onHold).toBe(true);
  });

  it("legal_hold flag alone → held", async () => {
    state.doc = docWith("Issued", { legal_hold: true });
    const r = await verify();
    expect(r.verdict).toBe("held");
  });

  it("a hold-lookup error fails SAFE to held, never green", async () => {
    state.doc = docWith("Issued");
    state.holdError = true;
    const r = await verify();
    expect(r.verdict).toBe("held");
    expect(r.isCurrent).toBe(false);
    expect(r.activeHolds).toBeNull();
  });
});

describe("VFY-1 / VFY-9 — green is an ALLOW-list (Issued, Locked); everything else is not in force", () => {
  it("Locked current version → current", async () => {
    state.doc = docWith("Locked");
    expect((await verify()).verdict).toBe("current");
  });
  it.each([[null], [""], ["In Review"], ["Pending"], ["SomeFutureStatus"]])("status %j → not_issued, never green", async (status) => {
    state.doc = docWith(status as string | null);
    const r = await verify();
    expect(r.verdict).toBe("not_issued");
    expect(r.isCurrent).toBe(false);
    expect(r.docStatus).toBe(status);
  });
  it("Void with the printed version === current_version_id → isCurrent false (VFY-1 done-when 3)", async () => {
    state.doc = docWith("Void");
    const r = await verify();
    expect(r.isCurrent).toBe(false);
    expect(r.verdict).toBe("void");
  });
  it("an older printed version of an Issued document → superseded_version", async () => {
    state.doc = docWith("Issued");
    const r = await verify({ v: V_OLD });
    expect(r.verdict).toBe("superseded_version");
    expect(r.printedRev).toBe("4");
  });
  it("the route reads retirement from the shared set through lib/verifyVerdict — no inline status list", () => {
    const src = readFileSync(join(process.cwd(), "app/api/verify/route.ts"), "utf8");
    expect(src).toContain('import { documentStanding } from "@/lib/verifyVerdict";');
    expect(src).not.toMatch(/=== "Superseded" \|\||status === "Archived"/);
  });
});

describe("VFY-3 — a code with no ?v= never reads green", () => {
  it("Issued document, doc-only QR → unverifiable, isCurrent false", async () => {
    state.doc = docWith("Issued");
    const r = await verify({ v: null });
    expect(r.verdict).toBe("unverifiable");
    expect(r.isCurrent).toBe(false);
    expect(r.printedRev).toBeNull();
  });
  it("a retired or held document still says so without ?v= (those are true of every print)", async () => {
    state.doc = docWith("Void");
    expect((await verify({ v: null })).verdict).toBe("void");
    state.doc = docWith("Issued");
    state.holdRows = [{ reason: "Client Review" }];
    expect((await verify({ v: null })).verdict).toBe("held");
  });
  it("a document with no current revision cannot be confirmed either", async () => {
    state.doc = docWith("Issued", { current_version_id: null });
    expect((await verify()).verdict).toBe("unverifiable");
  });
});

describe("VFY-5 — the hold's public categories are named; operator text never is", () => {
  it("two holds → activeHolds 2 and the categories (custom text becomes 'On hold')", async () => {
    state.doc = docWith("Issued");
    state.holdRows = [{ reason: "Client Review" }, { reason: "waiting on legal re: the Fuller incident" }];
    const res = await call();
    const r = (await res.json()) as Record<string, unknown>;
    expect(r.verdict).toBe("held");
    expect(r.activeHolds).toBe(2);
    expect(r.holdReasons).toEqual(["Client Review", "On hold"]);
    expect(JSON.stringify(r)).not.toContain("Fuller");
  });
});

describe("VFY-4 / REV-9 — 'not yet in effect' is decided in the facility's calendar, never the server's UTC date", () => {
  it("19:30 local (America/Chicago) on the day before the effective date → not_yet_effective; just after local midnight → current", async () => {
    process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE = "America/Chicago";
    state.doc = docWith("Issued");
    state.effectiveDate = "2026-03-02";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-02T01:30:00Z")); // 19:30 CST, 1 March — UTC is already 2 March
    let r = await verify();
    expect(r.verdict).toBe("not_yet_effective");
    expect(r.notYetEffective).toBe(true);
    expect(r.isCurrent).toBe(false);
    vi.setSystemTime(new Date("2026-03-02T06:30:00Z")); // 00:30 CST, 2 March
    r = await verify();
    expect(r.verdict).toBe("current");
  });
  it("with NO facility zone configured the answer is late (UTC-12), never early", async () => {
    delete process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE;
    state.doc = docWith("Issued");
    state.effectiveDate = "2026-03-02";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-02T01:30:00Z"));
    expect((await verify()).verdict).toBe("not_yet_effective");
  });
  it("the route no longer spells its own UTC 'today' — it asks lib/effectiveDate", () => {
    const src = readFileSync(join(process.cwd(), "app/api/verify/route.ts"), "utf8");
    expect(src).not.toMatch(/toISOString\(\)\.slice\(0, 10\)/);
    expect(src).toContain('import { effectiveStatusFor } from "@/lib/effectiveDate";');
    expect(src).toContain('effectiveStatusFor(effectiveDate) === "pending"');
  });
});

describe("VFY-12 / VFY-13 — every scan is recorded, capped per IP, and answered no-store", () => {
  it("an answered scan writes one verify_scans row (endpoint, target, verdict, ip, user agent) and the answer is no-store", async () => {
    state.doc = docWith("Issued");
    const res = await call({ headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1", "user-agent": "FieldPhone/1.0" } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const rows = state.inserts.filter((i) => i.table === "verify_scans").map((i) => i.row);
    expect(rows).toEqual([{ endpoint: "verify", target_id: DOC, verdict: "current", ip: "203.0.113.7", user_agent: "FieldPhone/1.0" }]);
  });
  it("an invalid code and an unknown document are recorded too (enumeration is visible)", async () => {
    const { GET } = await import("@/app/api/verify/route");
    const res = await GET(new NextRequest(new URL("https://app/api/verify?doc=nope")));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    state.doc = null;
    const res2 = await call();
    expect(res2.status).toBe(404);
    expect(state.inserts.map((i) => i.row.verdict)).toEqual(["invalid", "unknown"]);
    expect(state.inserts[0].row.target_id).toBeNull();
  });
  it("over the per-IP cap → 429 no-store with Retry-After, and NO row is written", async () => {
    state.doc = docWith("Issued");
    state.scanCount = 1200;
    const res = await call({ headers: { "x-forwarded-for": "198.51.100.9" } });
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBe("300");
    expect(state.inserts).toEqual([]);
  });
  it("the limiter fails OPEN: a window read that errors (20261134 unapplied) still answers the scan", async () => {
    state.doc = docWith("Issued");
    state.scanCountError = true;
    state.scanCount = 99999;
    const res = await call({ headers: { "x-forwarded-for": "198.51.100.9" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).verdict).toBe("current");
  });
  it("a document read that errors is 503 (never 'unknown', never green)", async () => {
    state.docError = true;
    const res = await call();
    expect(res.status).toBe(503);
    expect(state.inserts.map((i) => i.row.verdict)).toEqual(["error"]);
  });
});

describe("VFY-14 — the route selects only what it uses", () => {
  it("superseded_at is no longer selected from documents or the printed version", async () => {
    state.doc = docWith("Issued");
    await verify();
    const docSel = state.selects.find((s) => s.table === "documents")!.cols;
    expect(docSel).toBe("id, document_number, title, name, rev, status, current_version_id, legal_hold");
    for (const s of state.selects) expect(s.cols).not.toContain("superseded_at");
    expect(state.selects.find((s) => s.table === "document_holds")!.cols).toBe("reason");
  });
});

Object.assign(process.env, OLD_ENV);
