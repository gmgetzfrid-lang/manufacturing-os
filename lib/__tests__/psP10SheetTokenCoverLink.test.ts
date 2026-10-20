// public-surfaces PS-P10 SHEET TOKEN PRINT LINK — what a scan of a recalled
// sheet answers, every earlier QR unchanged, the client's recall call, and
// the shape of 20261240 (PHYS-19 done-when 3; intelligence DACL-8 residual
// (c); rulings under DEC-90).
//
//   - a recalled sheet (voided 'recalled') reads print_voided — red, never
//     green — unless a hold or a retirement says more (the verify route reads
//     voided_at, not the reason: every void reads stale);
//   - REGRESSION (ruling (4)): a doc-only QR, a ?v= QR and every existing
//     token answer exactly as before; the verify route reads neither the
//     link nor the reason;
//   - recallSheetPrint posts { action: "void", orgId, coverPrintId, reason }
//     and says what came back, never throwing;
//   - 20261240: DEC-30 one-paste shape; print_sheet_tokens_guard re-created
//     from its NEWEST definition (found by scanning the folder) with every
//     line kept and only the cover-link limb added; no SECURITY DEFINER; the
//     table stays the service role's alone.
// (Verify harness: the one lib/__tests__/psP9SheetTokens.test.ts uses.)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { hashSheetToken, newSheetToken, isMissingCoverLinkColumn, coverPrintedSheets } from "@/lib/printSheetTokensServer";
import { presentDocVerdict, type DocVerifyResult } from "@/lib/verifyPresent";

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "jwt" } } }) } } }));

const V = "11111111-1111-1111-1111-111111111111"; // current version
const V_OLD = "33333333-3333-3333-3333-333333333333"; // an older version of the same document
const DOC = "22222222-2222-2222-2222-222222222222";
const PRINT_1 = "55555555-5555-5555-5555-555555555555";
const PRINT_2 = "66666666-6666-6666-6666-666666666666";

const state = vi.hoisted(() => ({
  doc: null as Record<string, unknown> | null,
  holdRows: [] as unknown[],
  /** token hash → token row */
  tokens: new Map<string, Record<string, unknown>>(),
  tokenError: null as { code?: string; message: string } | null,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  reads: [] as string[],
}));

function chain(table: string) {
  const filters: Record<string, unknown> = {};
  let head = false;
  let cols = "";
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, p: string) {
      if (p === "then") {
        return (resolve: (v: unknown) => void) => {
          if (table === "verify_scans" && head) resolve({ data: null, error: null, count: 0 });
          else if (table === "document_holds") resolve({ data: state.holdRows, error: null });
          else resolve({ data: [], error: null });
        };
      }
      return (...args: unknown[]) => {
        if (p === "select") {
          cols = String(args[0]);
          state.reads.push(table);
          if ((args[1] as { head?: boolean } | undefined)?.head) head = true;
        }
        if (p === "insert") state.inserts.push({ table, row: args[0] as Record<string, unknown> });
        if (p === "eq") filters[args[0] as string] = args[1];
        if (p === "maybeSingle") {
          if (table === "print_sheet_tokens") {
            if (state.tokenError) return Promise.resolve({ data: null, error: state.tokenError });
            return Promise.resolve({ data: state.tokens.get(String(filters.token_hash)) ?? null, error: null });
          }
          if (table === "documents") return Promise.resolve({ data: state.doc, error: null });
          if (table === "document_versions") {
            if (cols === "created_at, effective_date" || cols === "created_at") {
              return Promise.resolve({ data: filters.id === V ? { created_at: "2026-01-01", effective_date: null } : null, error: null });
            }
            if (filters.id === V) return Promise.resolve({ data: { revision_label: "5", created_at: "2026-01-01", record_id: DOC }, error: null });
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

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  state.doc = null;
  state.holdRows = [];
  state.tokens = new Map();
  state.tokenError = null;
  state.inserts = [];
  state.reads = [];
});

const docWith = (status: string | null, extra: Record<string, unknown> = {}) => ({
  id: DOC, org_id: "org-1", document_number: "P-101", title: "P&ID", name: "P-101",
  rev: "5", status, current_version_id: V, legal_hold: false, visibility: "normal", ...extra,
});

/** A token row for (DOC, version) in print `printId`; returns the token. */
function mint(version: string, printId: string, extra: Record<string, unknown> = {}): string {
  const token = newSheetToken();
  state.tokens.set(hashSheetToken(token), {
    print_id: printId, document_id: DOC, version_id: version, minted_at: "2026-10-19T08:00:00Z", voided_at: null, ...extra,
  });
  return token;
}

async function call(params: Record<string, string>) {
  const { GET } = await import("@/app/api/verify/route");
  const u = new URL("https://app/api/verify");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return GET(new NextRequest(u));
}
async function verify(params: Record<string, string>): Promise<Record<string, unknown>> {
  return (await (await call(params)).json()) as Record<string, unknown>;
}


describe("PS-P10 — a recalled sheet's scan reads stale, never green", () => {
  it("a token voided 'recalled' on a current, in-force revision reads print_voided — red, DO NOT USE", async () => {
    state.doc = docWith("Issued");
    const t = mint(V, PRINT_1, { voided_at: "2026-10-20T09:00:00Z", void_reason: "recalled", settled_at: "2026-10-20T08:01:00Z", cover_print_id: PRINT_2 });
    const r = await verify({ t });
    expect(r).toMatchObject({ verdict: "print_voided", isCurrent: false });
    expect(r.sheetPrint).toEqual({ printedAt: "2026-10-19T08:00:00Z", voided: true });
    const view = presentDocVerdict(r as unknown as DocVerifyResult);
    expect(view.ok).toBe(false);
    expect(view.bg).toBe("bg-red-600");
  });

  it("a hold or a retirement still says more than the recall", async () => {
    state.doc = docWith("Issued");
    state.holdRows = [{ reason: "Client Review" }];
    const t = mint(V, PRINT_1, { voided_at: "2026-10-20T09:00:00Z", void_reason: "recalled" });
    expect((await verify({ t })).verdict).toBe("held");
    state.holdRows = [];
    state.doc = docWith("Superseded");
    expect((await verify({ t })).verdict).toBe("superseded");
  });
});

describe("PS-P10 REGRESSION — every QR printed before answers exactly as today (ruling (4))", () => {
  it("a doc-only QR, a ?v= QR and an existing (unlinked, live) token answer as before; the token answer adds nothing", async () => {
    state.doc = docWith("Issued");
    expect(await verify({ doc: DOC, v: V })).toMatchObject({ verdict: "current", isCurrent: true, printedRev: "5" });
    expect((await verify({ doc: DOC, v: V_OLD })).verdict).toBe("superseded_version");
    expect(await verify({ doc: DOC })).toMatchObject({ verdict: "unverifiable", isCurrent: false });
    expect(state.reads).not.toContain("print_sheet_tokens");
    const t = mint(V, PRINT_1);
    const r = await verify({ t });
    expect(r).toMatchObject({ verdict: "current", isCurrent: true });
    expect(r.sheetPrint).toEqual({ printedAt: "2026-10-19T08:00:00Z", voided: false });
    expect(JSON.stringify(r)).not.toMatch(/cover|recall/i);
  });

  it("the verify route reads neither the cover link nor the void reason (pinned on its token select)", () => {
    const src = readFileSync(join(process.cwd(), "app/api/verify/route.ts"), "utf8");
    expect(src).toContain('.select("print_id, document_id, version_id, minted_at, voided_at")');
    expect(src).not.toContain("cover_print_id");
    expect(src).not.toContain("void_reason");
  });
});

describe("PS-P10 — the server's small rules", () => {
  it("a missing link column (20261240 not pasted) is told apart from any other error", () => {
    expect(isMissingCoverLinkColumn({ code: "42703", message: "x" })).toBe(true);
    expect(isMissingCoverLinkColumn({ code: "PGRST204", message: "x" })).toBe(true);
    expect(isMissingCoverLinkColumn({ message: "column print_sheet_tokens.cover_print_id does not exist" })).toBe(true);
    expect(isMissingCoverLinkColumn({ code: "57014", message: "canceling statement" })).toBe(false);
    expect(isMissingCoverLinkColumn({ code: "42P01", message: "relation does not exist" })).toBe(false);
    expect(isMissingCoverLinkColumn(null)).toBe(false);
  });

  it("a cover snapshot's printed sheets: printed:false is left out; an entry with no `printed` key (before VFY-19) counts; ids lowercased", () => {
    const m = coverPrintedSheets([
      { documentId: "D1", versionId: "V1", printed: true },
      { documentId: "d2", versionId: null, printed: false },
      { documentId: "d3", versionId: "v3" },
      { versionId: "x" },
      null,
    ]);
    expect([...m.entries()]).toEqual([["d1", "v1"], ["d3", "v3"]]);
    expect(coverPrintedSheets(null).size).toBe(0);
  });
});

describe("PS-P10 — recallSheetPrint (the browser's half of the recall)", () => {
  const calls: Array<Record<string, unknown>> = [];
  let answer: { ok: boolean; status: number; body: unknown } | "throw" = { ok: true, status: 200, body: {} };
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body?: string }) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (answer === "throw") throw new Error("network down");
      const a = answer;
      return { ok: a.ok, status: a.status, json: async () => a.body };
    }));
  });
  it("posts the void with the cover's print id and the reason; a recall reports how many sheets", async () => {
    const { recallSheetPrint } = await import("@/lib/printSheetTokensClient");
    answer = { ok: true, status: 200, body: { recalled: true, voided: 4, alreadyVoid: 1 } };
    expect(await recallSheetPrint({ orgId: "org1", coverPrintId: PRINT_2, reason: "Wrong revision" })).toEqual({ ok: true, voided: 4, alreadyVoid: 1 });
    expect(calls).toEqual([{ action: "void", orgId: "org1", coverPrintId: PRINT_2, reason: "Wrong revision" }]);
  });
  it("a refusal, the pre-paste answer and a network failure each come back said — never thrown, never a success", async () => {
    const { recallSheetPrint } = await import("@/lib/printSheetTokensClient");
    answer = { ok: false, status: 403, body: { error: "Only Document Control or an Admin can recall a printed pack" } };
    expect(await recallSheetPrint({ orgId: "o", coverPrintId: PRINT_2, reason: "abc" })).toEqual({ ok: false, unavailable: false, status: 403, error: "Only Document Control or an Admin can recall a printed pack" });
    answer = { ok: true, status: 200, body: { available: false, recalled: false, error: "Recalling a printed pack needs database update 20261240 — nothing was changed." } };
    expect(await recallSheetPrint({ orgId: "o", coverPrintId: PRINT_2, reason: "abc" })).toMatchObject({ ok: false, unavailable: true });
    answer = "throw";
    const r = await recallSheetPrint({ orgId: "o", coverPrintId: PRINT_2, reason: "abc" });
    expect(r).toMatchObject({ ok: false, unavailable: false, status: 0 });
    expect(r.ok ? "" : r.error).toMatch(/nothing was changed/);
  });
});

// ── 20261240: the migration's shape ──────────────────────────────────────
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const FILE = "20261240_ps_roundG_sheet_token_cover_link.sql";
const mig = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");
const sql = mig(FILE);
const code = sql.replace(/--[^\n]*/g, "");
const numbered = () => readdirSync(MIGRATIONS).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const definesGuard = (f: string) => /CREATE (OR REPLACE )?FUNCTION print_sheet_tokens_guard\(\)/.test(mig(f));
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}
const guardOf = (text: string) => {
  const a = text.indexOf("CREATE OR REPLACE FUNCTION print_sheet_tokens_guard()");
  const b = text.indexOf("\n$$;", a);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return text.slice(a, b + 4);
};
const LIMB = [
  "  IF NEW.cover_print_id IS DISTINCT FROM OLD.cover_print_id THEN",
  "    IF OLD.cover_print_id IS NOT NULL THEN",
  "      IF NEW.cover_print_id IS NOT NULL",
  "         OR EXISTS (SELECT 1 FROM work_package_prints w WHERE w.id = OLD.cover_print_id) THEN",
  "        RAISE EXCEPTION 'print_sheet_tokens: a sheet''s link to its cover''s print never changes'",
  "          USING ERRCODE = '42501';",
  "      END IF;",
  "    ELSIF NOT (OLD.settled_at IS NULL AND NEW.settled_at IS NOT NULL)",
  "          OR NOT EXISTS (SELECT 1 FROM work_package_prints w WHERE w.id = NEW.cover_print_id AND w.org_id = NEW.org_id) THEN",
  "      RAISE EXCEPTION 'print_sheet_tokens: a sheet is linked to its cover''s print only when it settles, and only to a cover of its own workspace'",
  "        USING ERRCODE = '42501';",
  "    END IF;",
  "  END IF;",
];

describe("PS-P10 — 20261240 (DEC-30 one-paste shape; the guard from its newest definition; DRLS-16)", () => {
  it("the guard's newest earlier definition is found by scanning the folder (today 20261237), and nothing after this file re-defines it", () => {
    const defs = numbered().filter(definesGuard);
    const earlier = defs.filter((f) => f < FILE);
    expect(earlier[earlier.length - 1]).toBe("20261237_ps_roundG_print_sheet_tokens.sql");
    expect(defs.filter((f) => f > FILE)).toEqual([]);
  });

  it("lineDiff against the newest earlier body: nothing lost; only the cover-link limb (and its comment) added", () => {
    const earlier = numbered().filter((f) => f < FILE && definesGuard(f));
    const { onlyInA, onlyInB } = lineDiff(guardOf(mig(earlier[earlier.length - 1])), guardOf(sql));
    expect(onlyInA).toEqual([]);
    expect(onlyInB.filter((l) => /^\s*--/.test(l)).length).toBeGreaterThan(0);
    // byte for byte: the earlier body with the limb inserted before RETURN NEW
    const before = guardOf(mig(earlier[earlier.length - 1])).split("\n");
    const at = before.indexOf("  RETURN NEW;");
    expect(at).toBeGreaterThan(0);
    const expected = [...before.slice(0, at), ...LIMB, ...before.slice(at)];
    expect(guardOf(sql).split("\n").filter((l) => !/^\s*--/.test(l))).toEqual(expected);
  });

  it("DEC-30: a counts-only TEMP inventory before ONE BEGIN / COMMIT, the floor first, and ONE final SELECT (check, ok, n)", () => {
    const begin = code.indexOf("\nBEGIN;");
    expect(code.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(code.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(code.indexOf("CREATE TEMP TABLE _ps_p10_before")).toBeGreaterThanOrEqual(0);
    expect(code.indexOf("CREATE TEMP TABLE _ps_p10_before")).toBeLessThan(begin);
    expect(code.indexOf("Apply 20261237_ps_roundG_print_sheet_tokens.sql first")).toBeGreaterThan(begin);
    expect(code.indexOf("Apply 20261237_ps_roundG_print_sheet_tokens.sql first")).toBeLessThan(code.indexOf("ALTER TABLE print_sheet_tokens"));
    const after = code.slice(code.indexOf("\nCOMMIT;"));
    // after COMMIT: exactly one statement, the final SELECT
    expect(after.split(";").map((x) => x.trim()).filter(Boolean)).toHaveLength(2);
    expect(after.match(/^SELECT r\.check/gm)).toHaveLength(1);
    expect(after).toContain("SELECT r.check, r.ok, r.n FROM (");
    // the inventory is aggregate counts only — never a row of customer data
    const inv = code.slice(0, begin);
    expect(inv).not.toMatch(/SELECT\s+\*/i);
    expect(inv.match(/COUNT\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it("the column: nullable uuid, FK to work_package_prints ON DELETE SET NULL, a partial index; the CHECK keeps both earlier reasons and adds 'recalled'", () => {
    expect(code).toContain("ADD COLUMN IF NOT EXISTS cover_print_id UUID REFERENCES work_package_prints(id) ON DELETE SET NULL;");
    expect(code).not.toMatch(/cover_print_id UUID NOT NULL/);
    expect(code).toContain("ON print_sheet_tokens (cover_print_id) WHERE cover_print_id IS NOT NULL;");
    expect(code).toContain("CHECK (void_reason IS NULL OR void_reason IN ('not_printed', 'print_aborted', 'recalled'));");
    // print_id keeps its meaning — never altered
    expect(code).not.toMatch(/ALTER COLUMN print_id|DROP COLUMN/);
  });

  it("DRLS-16: no SECURITY DEFINER; the guard is INVOKER with search_path pinned and EXECUTE revoked; no policy, no grant to anon / authenticated", () => {
    expect(code).not.toMatch(/SECURITY DEFINER/i);
    expect(guardOf(sql)).toContain("LANGUAGE plpgsql SET search_path = public AS $$");
    expect(code).toContain("REVOKE ALL ON FUNCTION print_sheet_tokens_guard() FROM PUBLIC, anon, authenticated;");
    expect(code).not.toMatch(/CREATE POLICY/i);
    expect(code).not.toMatch(/GRANT [^;]* TO (anon|authenticated)/i);
    expect(code).toContain("BEFORE UPDATE ON print_sheet_tokens");
  });

  it("probe 5 matches the stored body: a doubled apostrophe in the function's literal is written as four inside the LIKE", () => {
    expect(code).toContain("p.prosrc LIKE '%link to its cover''''s print never changes%'");
  });
});
