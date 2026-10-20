// public-surfaces PS-P9 PER-PRINT SHEET TOKEN (intelligence DACL-8
// criterion 2; rulings under DEC-90 at the I-12 merge).
//
//   - the token's shape and the scan page's query (a token is sent as `t`
//     alone; a document id exactly as before);
//   - /api/verify?t= resolves (document, version, print) and answers for
//     THAT print: a current sheet reads current; a reprinted pack's OLD sheet
//     reads stale (superseded_version) while the reprint's reads current; a
//     voided print reads `print_voided` (red) unless a hold or a retirement
//     says more; a restricted document is never named through the token
//     (I-12's rule, lib/verifyDisclosure); an unknown token, a missing table
//     (20261237 not pasted) and a mixed code are "Unknown code"; an
//     unreadable token is 503; the scan row names the print;
//   - REGRESSION: a doc-only and a ?v= QR never touch the token table and
//     answer exactly as before (verifyRouteVerdict.test.ts pins the rest);
//   - 20261237's DEC-30 shape: a TEMP counts-only inventory before the
//     transaction, BEGIN / COMMIT, one final SELECT (check, ok, n); nothing
//     earlier in the sequence defines what it creates (scanned at test time);
//     service role only, no policy, no SECURITY DEFINER.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { isSheetToken, sheetTokenVerifyUrl, verifyQueryFor, SHEET_TOKEN_RE } from "@/lib/printSheetTokens";
import { hashSheetToken, isMissingSheetTokenTable, newSheetToken } from "@/lib/printSheetTokensServer";
import { presentDocVerdict, type DocVerifyResult } from "@/lib/verifyPresent";

const V = "11111111-1111-1111-1111-111111111111"; // current version
const V_OLD = "33333333-3333-3333-3333-333333333333"; // an older version of the same document
const DOC = "22222222-2222-2222-2222-222222222222";
const OTHER_DOC = "44444444-4444-4444-4444-444444444444";
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
const scans = () => state.inserts.filter((i) => i.table === "verify_scans").map((i) => i.row);

describe("PS-P9 — the sheet token's shape and the scan page's query", () => {
  it("a token is 32 base64url characters, minted from 24 random bytes, never UUID-shaped; only its SHA-256 is stored", () => {
    const a = newSheetToken();
    const b = newSheetToken();
    expect(a).toMatch(SHEET_TOKEN_RE);
    expect(a).not.toBe(b);
    expect(isSheetToken(a)).toBe(true);
    expect(isSheetToken(DOC)).toBe(false);
    expect(isSheetToken("")).toBe(false);
    expect(isSheetToken(`${a}x`)).toBe(false);
    expect(hashSheetToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSheetToken(a)).toBe(hashSheetToken(a));
    expect(hashSheetToken(a)).not.toBe(hashSheetToken(b));
  });
  it("the QR target is /verify/<token>; the page sends a token as t alone, and a document id (with v) exactly as before", () => {
    const t = newSheetToken();
    expect(sheetTokenVerifyUrl("https://app.example.com", t)).toBe(`https://app.example.com/verify/${t}`);
    expect(verifyQueryFor(t, null).toString()).toBe(`t=${t}`);
    expect(verifyQueryFor(t, V).toString()).toBe(`t=${t}`);
    expect(verifyQueryFor(DOC, V).toString()).toBe(`doc=${DOC}&v=${V}`);
    expect(verifyQueryFor(DOC, null).toString()).toBe(`doc=${DOC}`);
  });
  it("the scan page builds its query through verifyQueryFor and keeps the pinned fetch line; a token answer shows when it was printed", () => {
    const src = readFileSync(join(process.cwd(), "app/verify/[docId]/page.tsx"), "utf8");
    expect(src).toContain('import { verifyQueryFor } from "@/lib/printSheetTokens";');
    expect(src).toContain("const qs = verifyQueryFor(params.docId, versionId);");
    expect(src).toContain('fetch(`/api/verify?${qs.toString()}`, { cache: "no-store" })');
    expect(src).toContain("{result.sheetPrint && (");
  });
  it("a missing table (20261237 not pasted) is told apart from any other error", () => {
    expect(isMissingSheetTokenTable({ code: "42P01", message: "x" })).toBe(true);
    expect(isMissingSheetTokenTable({ code: "PGRST205", message: "x" })).toBe(true);
    expect(isMissingSheetTokenTable({ message: "Could not find the table 'public.print_sheet_tokens' in the schema cache" })).toBe(true);
    expect(isMissingSheetTokenTable({ code: "57014", message: "canceling statement" })).toBe(false);
    expect(isMissingSheetTokenTable(null)).toBe(false);
  });
});

describe("PS-P9 — /api/verify?t= answers for THAT print", () => {
  it("a current sheet reads current, green; the answer says when this print was made", async () => {
    state.doc = docWith("Issued");
    const t = mint(V, PRINT_1);
    const r = await verify({ t });
    expect(r).toMatchObject({ verdict: "current", isCurrent: true, printedRev: "5", currentRev: "5", docNumber: "P-101", title: "P&ID" });
    expect(r.sheetPrint).toEqual({ printedAt: "2026-10-19T08:00:00Z", voided: false });
  });

  it("a reprinted pack's OLD sheet reads stale; the reprint's sheet reads current", async () => {
    state.doc = docWith("Issued");
    const oldSheet = mint(V_OLD, PRINT_1);
    const newSheet = mint(V, PRINT_2);
    const before = await verify({ t: oldSheet });
    expect(before).toMatchObject({ verdict: "superseded_version", isCurrent: false, printedRev: "4", currentRev: "5" });
    const after = await verify({ t: newSheet });
    expect(after).toMatchObject({ verdict: "current", isCurrent: true, printedRev: "5" });
    // each scan row names ITS print, so the two papers stay distinguishable
    expect(scans().map((s) => [s.printed_ref, s.verdict, s.target_id])).toEqual([
      [PRINT_1, "superseded_version", DOC],
      [PRINT_2, "current", DOC],
    ]);
  });

  it("a voided print reads print_voided — red, never green — even when its version is current", async () => {
    state.doc = docWith("Issued");
    const t = mint(V, PRINT_1, { voided_at: "2026-10-19T08:01:00Z" });
    const r = await verify({ t });
    expect(r).toMatchObject({ verdict: "print_voided", isCurrent: false });
    expect(r.sheetPrint).toEqual({ printedAt: "2026-10-19T08:00:00Z", voided: true });
    const view = presentDocVerdict(r as unknown as DocVerifyResult);
    expect(view.ok).toBe(false);
    expect(view.bg).toBe("bg-red-600");
    expect(view.headline).toMatch(/DO NOT USE/);
  });

  it("a voided print under a hold says HOLD; a voided print of a voided document says VOID (the stronger answer first)", async () => {
    state.doc = docWith("Issued");
    state.holdRows = [{ reason: "Client Review" }];
    const t = mint(V, PRINT_1, { voided_at: "2026-10-19T08:01:00Z" });
    expect((await verify({ t })).verdict).toBe("held");
    state.holdRows = [];
    state.doc = docWith("Void");
    expect((await verify({ t })).verdict).toBe("void");
  });

  it("I-12's rule holds through the token: a restricted document is answered without its number or title", async () => {
    for (const visibility of ["private", "hidden", "secret", undefined]) {
      const extra: Record<string, unknown> = { document_number: "INC-7", title: "Incident 7 investigation", name: "inc-7" };
      if (visibility !== undefined) extra.visibility = visibility;
      const row = docWith("Issued", extra);
      if (visibility === undefined) delete (row as Record<string, unknown>).visibility;
      state.doc = row;
      const t = mint(V, PRINT_1);
      const res = await call({ t });
      const r = (await res.json()) as Record<string, unknown>;
      expect(r.docNumber).toBeNull();
      expect(r.title).toBe("Restricted document");
      expect(r.verdict).toBe("current");
      expect(JSON.stringify(r)).not.toMatch(/INC-7|Incident 7|inc-7/);
      // the token answer carries no id at all beyond what was scanned
      expect(JSON.stringify(r)).not.toContain(DOC);
      expect(JSON.stringify(r)).not.toContain(V);
    }
  });

  it("an unknown token is 'Unknown code' (404); so is a token when the table is not there yet (20261237 not pasted)", async () => {
    state.doc = docWith("Issued");
    const res = await call({ t: newSheetToken() });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Unknown code" });
    state.tokenError = { code: "PGRST205", message: "Could not find the table 'public.print_sheet_tokens' in the schema cache" };
    const missing = await call({ t: newSheetToken() });
    expect(missing.status).toBe(404);
    expect(scans().map((s) => [s.verdict, s.target_id])).toEqual([["unknown", null], ["unknown", null]]);
  });

  it("an unreadable token is 503 — never unknown, never green", async () => {
    state.tokenError = { code: "57014", message: "canceling statement due to statement timeout" };
    const res = await call({ t: newSheetToken() });
    expect(res.status).toBe(503);
    expect(scans().map((s) => s.verdict)).toEqual(["error"]);
  });

  it("a malformed token is 'Invalid code' (400) and the token table is never read", async () => {
    const res = await call({ t: "not-a-token" });
    expect(res.status).toBe(400);
    expect(state.reads).not.toContain("print_sheet_tokens");
    expect(scans().map((s) => s.verdict)).toEqual(["invalid"]);
  });

  it("a mixed code — a token beside another document or version — is unknown, never answered for the other one", async () => {
    state.doc = docWith("Issued");
    const t = mint(V, PRINT_1);
    expect((await call({ t, doc: OTHER_DOC })).status).toBe(404);
    expect((await call({ t, doc: DOC, v: V_OLD })).status).toBe(404);
    // naming the token's own document and version is the same answer
    expect((await verify({ t, doc: DOC, v: V })).verdict).toBe("current");
  });
});

describe("PS-P9 REGRESSION — every QR printed before this package is answered exactly as today", () => {
  it("a ?v= QR and a doc-only QR never read the token table; their verdicts and bodies are unchanged (no sheetPrint)", async () => {
    state.doc = docWith("Issued");
    const withV = await verify({ doc: DOC, v: V });
    expect(withV).toMatchObject({ verdict: "current", isCurrent: true, printedRev: "5" });
    expect("sheetPrint" in withV).toBe(false);
    const stale = await verify({ doc: DOC, v: V_OLD });
    expect(stale.verdict).toBe("superseded_version");
    const docOnly = await verify({ doc: DOC });
    expect(docOnly).toMatchObject({ verdict: "unverifiable", isCurrent: false, printedRev: null });
    expect(state.reads).not.toContain("print_sheet_tokens");
    // the scan rows keep the ?v= version as the printed ref, as before
    expect(scans().map((s) => s.printed_ref)).toEqual([V, V_OLD, null]);
  });
});

// ── 20261237: the migration's shape ──────────────────────────────────────
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const FILE = "20261237_ps_roundG_print_sheet_tokens.sql";
const sql = readFileSync(join(MIGRATIONS, FILE), "utf8");
const code = sql.replace(/--[^\n]*/g, "");

describe("PS-P9 — 20261237 (DEC-30 one-paste shape; service role only; DRLS-16)", () => {
  it("a TEMP counts-only inventory BEFORE the transaction, one BEGIN / COMMIT, and ONE final SELECT of (check, ok, n)", () => {
    const temp = code.indexOf("CREATE TEMP TABLE _ps_p9_before");
    const begin = code.indexOf("\nBEGIN;");
    const commit = code.indexOf("\nCOMMIT;");
    expect(temp).toBeGreaterThan(-1);
    expect(begin).toBeGreaterThan(temp);
    expect(commit).toBeGreaterThan(begin);
    expect(code.match(/\nBEGIN;/g)).toHaveLength(1);
    expect(code.match(/\nCOMMIT;/g)).toHaveLength(1);
    // counts only — every inventory row is a COUNT or an existence flag
    const inventory = code.slice(temp, begin);
    expect(inventory).not.toMatch(/SELECT\s+\*|token_hash|document_id/);
    const tail = code.slice(commit + "\nCOMMIT;".length).trim();
    expect(tail.startsWith("SELECT r.check, r.ok, r.n FROM (")).toBe(true);
    expect(tail.endsWith(") r ORDER BY r.ord;")).toBe(true);
    expect(tail.match(/;\s*$/gm)).toHaveLength(1); // one statement
    expect(tail).toContain("AS check");
    expect(tail).toContain("AS ok");
    expect(tail).toContain("NULL::text AS n");
  });

  it("creates the table and its guard — and nothing earlier in the sequence defines either (nothing is re-created)", () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS print_sheet_tokens \(/);
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION print_sheet_tokens_guard\(\) RETURNS trigger/);
    expect(code).toMatch(/CREATE TRIGGER print_sheet_tokens_guard\s+BEFORE UPDATE ON print_sheet_tokens\s+FOR EACH ROW EXECUTE FUNCTION print_sheet_tokens_guard\(\);/);
    const earlier = readdirSync(MIGRATIONS).filter((f) => /^\d{8}.*\.sql$/.test(f) && f < FILE);
    for (const f of earlier) {
      const src = readFileSync(join(MIGRATIONS, f), "utf8");
      expect(src, f).not.toMatch(/print_sheet_tokens/);
    }
  });

  it("service role only: RLS on, no policy, every privilege revoked from anon and authenticated; only the token's hash is stored", () => {
    expect(code).toContain("ALTER TABLE print_sheet_tokens ENABLE ROW LEVEL SECURITY;");
    expect(code).not.toMatch(/CREATE POLICY/i);
    expect(code).toContain("REVOKE ALL ON TABLE print_sheet_tokens FROM PUBLIC, anon, authenticated;");
    expect(code).toContain("GRANT SELECT, INSERT, UPDATE ON TABLE print_sheet_tokens TO service_role;");
    expect(code).not.toMatch(/GRANT[^;]*print_sheet_tokens[^;]*TO (anon|authenticated)/);
    expect(code).toContain("token_hash  TEXT NOT NULL");
    expect(code).toContain("CHECK (token_hash ~ '^[0-9a-f]{64}$')");
    expect(code).not.toMatch(/\btoken\s+TEXT\b/);
  });

  it("DRLS-16: no SECURITY DEFINER; the guard pins search_path and is revoked from PUBLIC, anon and authenticated", () => {
    expect(code).not.toMatch(/SECURITY DEFINER/i);
    expect(code).toMatch(/print_sheet_tokens_guard\(\) RETURNS trigger\s+LANGUAGE plpgsql SET search_path = public AS \$\$/);
    expect(code).toContain("REVOKE ALL ON FUNCTION print_sheet_tokens_guard() FROM PUBLIC, anon, authenticated;");
  });

  it("the void reasons the route writes are exactly the ones the CHECK allows", () => {
    expect(code).toContain("void_reason IN ('not_printed', 'print_aborted')");
    const route = readFileSync(join(process.cwd(), "app/api/print-sheet-tokens/route.ts"), "utf8");
    expect(route).toContain('printed.size === 0 ? "print_aborted" : "not_printed"');
  });
});
