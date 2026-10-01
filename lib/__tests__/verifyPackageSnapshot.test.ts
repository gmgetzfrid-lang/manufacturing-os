// /api/verify-package snapshot verdict (PKG-2), extended by public-surfaces
// Round F PS-VERIFY (VFY-1 / VFY-2 / VFY-5 / VFY-8 / VFY-11 / VFY-12 /
// VFY-13; document-control HLD-3 / PKG-8; PHYS-1 done-when 2).
//
// With a print id, the verdict is computed against the RECORDED versions in
// the print snapshot, not the live pins — so refreshing pins after printing
// cannot flip already-distributed paper back to green. Green additionally
// needs: an open package, at least one sheet, every sheet Issued / Locked,
// hold-free, current, in force, still in the package, and nothing added to
// the package since printing. A legacy QR (no print id) is never green.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { presentPackVerdict, type PackVerifyResult } from "@/lib/verifyPresent";

const PKG = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PRINT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const DOC = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const DOC2 = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const state = vi.hoisted(() => ({
  pkg: null as Record<string, unknown> | null,
  print: null as Record<string, unknown> | null,
  liveMembers: [] as Array<Record<string, unknown>>,
  docs: [] as Array<Record<string, unknown>>,
  holds: [] as Array<Record<string, unknown>>,
  versions: [] as Array<Record<string, unknown>>,
  errors: {} as Record<string, boolean>,
  /** The Postgres error code a failing table's read carries (e.g. 42703). */
  errorCodes: {} as Record<string, string>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));

function chain(table: string) {
  const eqs: Record<string, unknown> = {};
  const ins: Record<string, unknown[]> = {};
  let head = false;
  const rowsFor = (): unknown[] => {
    const src =
      table === "work_package_documents" ? state.liveMembers
      : table === "documents" ? state.docs
      : table === "document_holds" ? state.holds.filter((h) => h.released_at == null)
      : table === "document_versions" ? state.versions
      : [];
    return src.filter((r) =>
      Object.entries(ins).every(([k, v]) => v.includes(r[k])) &&
      // a filter on a column the fixture row does not carry is not modelled
      Object.entries(eqs).every(([k, v]) => !(k in r) || r[k] === v));
  };
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, p: string) {
      if (p === "then") {
        return (resolve: (v: unknown) => void) => {
          if (state.errors[table]) return resolve({ data: null, error: { message: `${table} read failed`, code: state.errorCodes[table] } });
          if (head) return resolve({ data: null, error: null, count: 0 });
          resolve({ data: rowsFor(), error: null });
        };
      }
      return (...args: unknown[]) => {
        if (p === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (p === "insert") state.inserts.push({ table, row: args[0] as Record<string, unknown> });
        if (p === "eq") eqs[args[0] as string] = args[1];
        if (p === "in") ins[args[0] as string] = args[1] as unknown[];
        if (p === "maybeSingle") {
          if (state.errors[table]) return Promise.resolve({ data: null, error: { message: `${table} read failed` } });
          if (table === "work_packages") return Promise.resolve({ data: state.pkg, error: null });
          if (table === "work_package_prints") return Promise.resolve({ data: state.print, error: null });
          return Promise.resolve({ data: null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chain(t) }) }));

const docRow = (over: Record<string, unknown> = {}) => ({
  id: DOC, document_number: "P-101", title: "P&ID", name: "P-101", rev: "4", current_version_id: "v2", status: "Issued", legal_hold: false, ...over,
});
const printAt = (sheets: Array<Record<string, unknown>>) => ({ id: PRINT, package_id: PKG, printed_at: "2026-08-20T00:00:00Z", sheets });
const sheetV2 = { documentId: DOC, versionId: "v2", revLabel: "4", label: "P-101" };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  state.pkg = { id: PKG, org_id: "o1", name: "TA-2026", status: "open", closed_at: null };
  state.print = null;
  state.liveMembers = [{ document_id: DOC, pinned_version_id: "v2", pinned_rev_label: "4" }];
  // The document is at v2 (Rev 4).
  state.docs = [docRow()];
  state.holds = [];
  state.versions = [];
  state.errors = {};
  state.errorCodes = {};
  state.inserts = [];
});

async function call(withPrint: boolean) {
  const { GET } = await import("@/app/api/verify-package/route");
  const u = new URL("https://app/api/verify-package");
  u.searchParams.set("p", PKG);
  if (withPrint) u.searchParams.set("print", PRINT);
  return GET(new NextRequest(u));
}
async function verify(withPrint: boolean): Promise<Record<string, unknown>> {
  return (await (await call(withPrint)).json()) as Record<string, unknown>;
}
const states = (r: Record<string, unknown>) => (r.sheets as Array<Record<string, unknown>>).map((s) => s.state);

describe("/api/verify-package snapshot (PKG-2)", () => {
  it("snapshot printed at v1 reads STALE even after the LIVE pin was refreshed to v2", async () => {
    // The live pin has been refreshed to current (v2) — the old bug would read
    // this as fresh. The print snapshot recorded v1, so it must read stale.
    state.print = printAt([{ documentId: DOC, versionId: "v1", revLabel: "3", label: "P-101" }]);
    const r = await verify(true);
    expect(r.allFresh).toBe(false);
    expect(r.staleCount).toBe(1);
    expect(r.verdict).toBe("stale");
    expect(r.printedAt).toBe("2026-08-20T00:00:00Z");
  });

  it("snapshot printed at the current version, sheet still in the package, reads CURRENT", async () => {
    state.print = printAt([sheetV2]);
    const r = await verify(true);
    expect(r.allFresh).toBe(true);
    expect(r.verdict).toBe("current");
    expect(r.staleCount).toBe(0);
    expect(states(r)).toEqual(["fresh"]);
  });

  it("a print id that resolves to no snapshot never reads green", async () => {
    state.print = null; // unknown print
    const r = await verify(true);
    expect(r.snapshotMissing).toBe(true);
    expect(r.printConfirmed).toBe(false);
    expect(r.verdict).toBe("unverifiable");
    expect(r.allFresh).toBe(false);
  });
});

describe("VFY-2 — the printed manifest, not the live package", () => {
  it("a legacy QR (no print id) is NEVER green — 'cannot confirm which printing', even when the live pin matches current", async () => {
    const r = await verify(false);
    expect(r.verdict).toBe("unconfirmed_print");
    expect(r.allFresh).toBe(false);
    expect(r.printConfirmed).toBe(false);
    expect(r.snapshotMissing).toBe(false);
    expect(states(r)).toEqual(["unconfirmed"]);
    // a live pin is not "what was printed"
    expect((r.sheets as Array<Record<string, unknown>>)[0].printedRev).toBeNull();
  });
  it("a legacy QR still reports what is true of every printing: a held or voided sheet", async () => {
    state.holds = [{ document_id: DOC, reason: "Client Review", released_at: null }];
    expect((await verify(false)).verdict).toBe("held");
    state.holds = [];
    state.docs = [docRow({ status: "Void" })];
    const r = await verify(false);
    expect(r.verdict).toBe("stale");
    expect(states(r)).toEqual(["void"]);
  });
  it("a sheet ADDED to the package since printing is reported and the pack is not green", async () => {
    state.print = printAt([sheetV2]);
    state.liveMembers.push({ document_id: DOC2, pinned_version_id: "w1", pinned_rev_label: "1" });
    state.docs.push(docRow({ id: DOC2, document_number: "P-102", current_version_id: "w1", rev: "1" }));
    const r = await verify(true);
    expect(r.addedSincePrint).toEqual([{ label: "P-102" }]);
    expect(r.verdict).toBe("stale");
    expect(r.allFresh).toBe(false);
    expect(states(r)).toEqual(["fresh"]); // the printed sheet itself is fine
  });
  it("a sheet REMOVED from the package since printing is marked on the paper's list, not silently dropped", async () => {
    state.print = printAt([sheetV2]);
    state.liveMembers = [];
    const r = await verify(true);
    expect(states(r)).toEqual(["removed"]);
    expect(r.verdict).toBe("stale");
  });
});

describe("VFY-1 / PKG-8 — the shared allow-list decides every sheet", () => {
  it.each([["Void", "void"], ["Superseded", "superseded"], ["Archived", "archived"], ["Draft", "draft"], [null, "not_issued"], ["In Review", "not_issued"]])(
    "status %j at the printed (current) version → state %s, fresh false, never green", async (status, expected) => {
      state.print = printAt([sheetV2]);
      state.docs = [docRow({ status })];
      const r = await verify(true);
      expect(states(r)).toEqual([expected]);
      expect((r.sheets as Array<Record<string, unknown>>)[0].fresh).toBe(false);
      expect(r.allFresh).toBe(false);
    });
  it("Locked is in force", async () => {
    state.print = printAt([sheetV2]);
    state.docs = [docRow({ status: "Locked" })];
    expect((await verify(true)).verdict).toBe("current");
  });
  it("a current revision whose effective date has not arrived → not_yet_effective, not green (PKG-8 done-when 3)", async () => {
    state.print = printAt([sheetV2]);
    state.versions = [{ id: "v2", effective_date: "2999-01-01" }];
    const r = await verify(true);
    expect(r.verdict).toBe("not_yet_effective");
    expect(states(r)).toEqual(["not_yet_effective"]);
  });
  it("an effective-date read that ERRORS is never green: 503, even with a pending date it could not see (VFY-4 / PKG-8 — late, never early)", async () => {
    state.print = printAt([sheetV2]);
    state.versions = [{ id: "v2", effective_date: "2999-01-01" }];
    state.errors.document_versions = true; // a transient PostgREST failure, no code
    const res = await call(true);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.inserts.filter((i) => i.table === "verify_scans").map((i) => i.row.verdict)).toEqual(["error"]);
  });
  it("only a missing COLUMN (42703 — a database with no effective dates at all) reads as 'no date'", async () => {
    state.print = printAt([sheetV2]);
    state.errors.document_versions = true;
    state.errorCodes.document_versions = "42703";
    const r = await verify(true);
    expect(r.verdict).toBe("current");
  });
  it("the route imports the shared decision and never spells a status list", () => {
    const src = readFileSync(join(process.cwd(), "app/api/verify-package/route.ts"), "utf8");
    expect(src).toContain('import { documentStanding, isUndefinedColumnError } from "@/lib/verifyVerdict";');
    expect(src).not.toMatch(/status === "Superseded"|status === "Void"|status === "Archived"/);
  });
});

describe("HLD-3 / PHYS-1 / VFY-5 — a held sheet is marked with its own label and the pack is not green", () => {
  it("an active hold on a printed, current sheet → state held with the category, verdict held", async () => {
    state.print = printAt([sheetV2]);
    state.holds = [{ document_id: DOC, reason: "Client Review", released_at: null }, { document_id: DOC, reason: "secret operator words", released_at: null }];
    const r = await verify(true);
    expect(r.verdict).toBe("held");
    expect(r.heldCount).toBe(1);
    const s = (r.sheets as Array<Record<string, unknown>>)[0];
    expect(s.state).toBe("held");
    expect(s.holdReasons).toEqual(["Client Review", "On hold"]);
    expect(JSON.stringify(r)).not.toContain("secret operator words");
  });
  it("a released hold does not count", async () => {
    state.print = printAt([sheetV2]);
    state.holds = [{ document_id: DOC, reason: "Client Review", released_at: "2026-09-01T00:00:00Z" }];
    expect((await verify(true)).verdict).toBe("current");
  });
  it("legal hold on the document → held", async () => {
    state.print = printAt([sheetV2]);
    state.docs = [docRow({ legal_hold: true })];
    expect((await verify(true)).verdict).toBe("held");
  });
  it("an unreadable hold state FAILS CLOSED — every sheet held, never green", async () => {
    state.print = printAt([sheetV2]);
    state.errors.document_holds = true;
    const r = await verify(true);
    expect(r.verdict).toBe("held");
    expect(states(r)).toEqual(["held"]);
  });
});

describe("VFY-1 residual / VFY-11 — a not-issued sheet is not 'changed since printing'", () => {
  it("a just-printed pack with one legacy NO-STATUS sheet: counted as not issued, and the page never says it changed since printing", async () => {
    // PKG-4's print gate admits an empty-status legacy row; the verify allow-list does not.
    state.print = printAt([sheetV2, { documentId: DOC2, versionId: "w1", revLabel: "1", label: "P-102" }]);
    state.liveMembers.push({ document_id: DOC2, pinned_version_id: "w1", pinned_rev_label: "1" });
    state.docs.push(docRow({ id: DOC2, document_number: "P-102", current_version_id: "w1", rev: "1", status: "" }));
    const r = await verify(true);
    expect(r.verdict).toBe("stale");
    expect(states(r)).toEqual(["fresh", "not_issued"]);
    expect(r.staleCount).toBe(1);
    expect(r.notIssuedCount).toBe(1);
    const view = presentPackVerdict(r as unknown as PackVerifyResult);
    expect(view.ok).toBe(false);
    expect(view.headline).toBe("PACK HAS UNISSUED SHEETS");
    expect(view.blurb).toContain("1 of 2 sheets is not an issued, controlled revision");
    expect(view.blurb).not.toMatch(/changed or withdrawn|since this pack was printed/);
  });
  it("a voided sheet is still 'changed or withdrawn' (notIssuedCount 0)", async () => {
    state.print = printAt([sheetV2]);
    state.docs = [docRow({ status: "Void" })];
    const r = await verify(true);
    expect(r.notIssuedCount).toBe(0);
    expect(presentPackVerdict(r as unknown as PackVerifyResult).blurb).toContain("1 of 1 sheet changed or withdrawn since this pack was printed");
  });
});

describe("VFY-8 / VFY-11 — closed and empty packs have their own verdicts", () => {
  it("a CLOSED package whose sheets have not moved is 'closed', not green", async () => {
    state.print = printAt([sheetV2]);
    state.pkg = { ...state.pkg!, status: "closed", closed_at: "2026-09-01T00:00:00Z" };
    const r = await verify(true);
    expect(r.verdict).toBe("closed");
    expect(r.closed).toBe(true);
    expect(r.allFresh).toBe(false);
  });
  it("status 'closed' alone also closes it", async () => {
    state.print = printAt([sheetV2]);
    state.pkg = { ...state.pkg!, status: "closed" };
    expect((await verify(true)).verdict).toBe("closed");
  });
  it("an empty print and an empty legacy package are 'empty' — never the red '0 of 0' stale", async () => {
    state.print = printAt([]);
    state.liveMembers = [];
    let r = await verify(true);
    expect(r.verdict).toBe("empty");
    expect(r.sheetCount).toBe(0);
    r = await verify(false);
    expect(r.verdict).toBe("empty");
  });
});

describe("fail-closed reads, the scan record and no-store", () => {
  it.each([["documents"], ["work_package_documents"], ["work_package_prints"], ["work_packages"]])("a %s read error answers 503, never a verdict", async (table) => {
    state.print = printAt([sheetV2]);
    state.errors[table] = true;
    const res = await call(true);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("every answered scan writes one verify_scans row with the verdict; the answer is no-store", async () => {
    state.print = printAt([sheetV2]);
    const res = await call(true);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.inserts.filter((i) => i.table === "verify_scans").map((i) => i.row)).toEqual([
      { endpoint: "verify-package", target_id: PKG, printed_ref: PRINT, verdict: "current", ip: "unknown", user_agent: null },
    ]);
  });
  it("VFY-12: the scan row names WHICH printing was scanned (?print=), and a legacy cover QR names none", async () => {
    state.print = printAt([{ documentId: DOC, versionId: "v1", revLabel: "3", label: "P-101" }]);
    await call(true);
    await call(false);
    expect(state.inserts.filter((i) => i.table === "verify_scans").map((i) => [i.row.verdict, i.row.printed_ref])).toEqual([
      ["stale", PRINT],
      ["unconfirmed_print", null],
    ]);
  });
});
