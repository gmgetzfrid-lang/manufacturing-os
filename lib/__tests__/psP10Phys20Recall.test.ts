// public-surfaces PHYS-20 (opened by PS-P10; resolved at the PS-P10 merge
// under the integrator's ruling, DEC-90) — what a RECALL changes, and what it
// must not:
//
//   limb 1: a print-keyed cover (?print=) with a sheet code LINKED to it
//           (cover_print_id, 20261240) that was voided 'recalled' answers
//           `recalled` with its date — never green, its would-be-fresh sheets
//           read `recalled`; before 20261240 (42703), before 20261237
//           (PGRST205 / 42P01), with no linked code, or with linked codes
//           none of which was recalled, the cover answers EXACTLY as before;
//           any other read error is a 503 (never a guess at green);
//   limb 2: a recalled sheet's scan is still `print_voided` (red) and says
//           Document Control recalled it, with the date; 'not_printed' /
//           'print_aborted' keep PS-P9's words byte for byte and PS-P9's two
//           sheetPrint keys;
//   limb 3: POST /api/print-sheet-tokens `history` — each print's code state
//           (recalled when / by whom, stopped before its download, linked,
//           unlinked); { available: false } before 20261240; only covers the
//           caller's own session can read in this workspace.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { hashSheetToken, newSheetToken } from "@/lib/printSheetTokensServer";
import { presentDocVerdict, presentPackVerdict, sheetLabel, type DocVerifyResult, type PackVerifyResult } from "@/lib/verifyPresent";

const ORG = "aaaaaaaa-0000-0000-0000-00000000000a";
const PKG = "9a9a9a9a-0000-0000-0000-000000000001";
const COVER = "c1c1c1c1-0000-0000-0000-000000000001";
const COVER_B = "c2c2c2c2-0000-0000-0000-000000000002";
const COVER_C = "c3c3c3c3-0000-0000-0000-000000000003";
const COVER_D = "c4c4c4c4-0000-0000-0000-000000000004";
const COVER_OTHER_ORG = "c9c9c9c9-0000-0000-0000-000000000009";
const DOC = "d1d1d1d1-0000-0000-0000-000000000001";
const V = "e1e1e1e1-0000-0000-0000-000000000001";
const PRINT = "f0f0f0f0-0000-0000-0000-000000000000";
const PRINT_B = "f0f0f0f0-0000-0000-0000-00000000000b";
const PRINT_C = "f0f0f0f0-0000-0000-0000-00000000000c";
const RECALLED_AT = "2026-10-21T09:30:00.000Z";

type Err = { code?: string; message: string };
const st = vi.hoisted(() => ({
  tokens: [] as Array<Record<string, unknown>>,
  tokenListError: null as null | { code?: string; message: string },
  covers: [] as Array<Record<string, unknown>>,
  coverReadError: null as null | { message: string },
  audit: [] as Array<Record<string, unknown>>,
  auditError: null as null | { message: string },
  docStatus: "Issued" as string,
  print: null as null | Record<string, unknown>,
  reads: [] as Array<{ table: string; cols: string }>,
  writes: [] as string[],
}));

function chain(table: string) {
  const eqs: Array<[string, unknown]> = [];
  const ins: Array<[string, unknown[]]> = [];
  const contains: Array<Record<string, unknown>> = [];
  const orders: Array<{ col: string; ascending: boolean; nullsFirst: boolean }> = [];
  let limit = Infinity;
  let cols = "";
  let head = false;
  const val = (r: Record<string, unknown>, k: string) => {
    if (k.startsWith("details->>")) return (r.details as Record<string, unknown> | null)?.[k.slice("details->>".length)];
    return r[k];
  };
  const list = (): { data: unknown; error: Err | null; count?: number } => {
    if (head) return { data: null, error: null, count: 0 };
    let src: Array<Record<string, unknown>> = [];
    if (table === "print_sheet_tokens") {
      if (st.tokenListError) return { data: null, error: st.tokenListError };
      src = st.tokens;
    } else if (table === "work_package_prints") {
      if (st.coverReadError) return { data: null, error: st.coverReadError };
      src = st.covers;
    } else if (table === "audit_logs") {
      if (st.auditError) return { data: null, error: st.auditError };
      src = st.audit;
    } else if (table === "work_package_documents") {
      src = [{ document_id: DOC, pinned_version_id: V, pinned_rev_label: "5" }];
    } else if (table === "documents") {
      src = [{ id: DOC, document_number: "P-101", title: "P&ID", name: "P-101", rev: "5", current_version_id: V, status: st.docStatus, legal_hold: false, visibility: "normal" }];
    } else if (table === "document_versions") {
      src = [{ id: V, effective_date: null }];
    }
    // a filter on a column the fixture row does not carry is not modelled
    const modelled = (r: Record<string, unknown>, k: string) => k.startsWith("details->>") || k in r;
    let rows = src.filter((r) =>
      eqs.every(([k, v]) => !modelled(r, k) || val(r, k) === v) &&
      ins.every(([k, vs]) => !modelled(r, k) || vs.includes(val(r, k))) &&
      contains.every((c) => ((c.printIds as unknown[]) ?? []).every((p) => (((r.details as Record<string, unknown> | null)?.printIds as unknown[]) ?? []).includes(p))));
    if (orders.length) {
      rows = [...rows].sort((a, b) => {
        for (const o of orders) {
          const x = a[o.col] as string | null | undefined, y = b[o.col] as string | null | undefined;
          if (x == y) continue;
          if (x == null) return o.nullsFirst ? -1 : 1;
          if (y == null) return o.nullsFirst ? 1 : -1;
          return (x < y ? -1 : 1) * (o.ascending ? 1 : -1);
        }
        return 0;
      });
    }
    return { data: rows.slice(0, limit), error: null };
  };
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, p: string) {
      if (p === "then") return (resolve: (v: unknown) => void) => resolve(list());
      return (...args: unknown[]) => {
        if (p === "select") {
          cols = String(args[0]);
          st.reads.push({ table, cols });
          if ((args[1] as { head?: boolean } | undefined)?.head) head = true;
        }
        if (p === "insert" || p === "update" || p === "upsert" || p === "delete") st.writes.push(`${p}:${table}`);
        if (p === "eq") eqs.push([String(args[0]), args[1]]);
        if (p === "in") ins.push([String(args[0]), args[1] as unknown[]]);
        if (p === "contains") contains.push(args[1] as Record<string, unknown>);
        if (p === "order") {
          const o = (args[1] as { ascending?: boolean; nullsFirst?: boolean } | undefined) ?? {};
          const ascending = o.ascending ?? true;
          orders.push({ col: String(args[0]), ascending, nullsFirst: o.nullsFirst ?? !ascending });
        }
        if (p === "limit") limit = Number(args[0]);
        if (p === "maybeSingle") {
          if (table === "print_sheet_tokens") {
            const hash = eqs.find(([k]) => k === "token_hash")?.[1];
            const row = st.tokens.find((t) => t.token_hash === hash) ?? null;
            if (!row) return Promise.resolve({ data: null, error: null });
            // the columns selected, as PostgREST answers them
            const pick = cols.split(",").map((x) => x.trim());
            return Promise.resolve({ data: Object.fromEntries(pick.map((k) => [k, row[k] ?? null])), error: null });
          }
          if (table === "documents") {
            return Promise.resolve({ data: { id: DOC, org_id: ORG, document_number: "P-101", title: "P&ID", name: "P-101", rev: "5", status: st.docStatus, current_version_id: V, legal_hold: false, visibility: "normal" }, error: null });
          }
          if (table === "document_versions") {
            if (cols === "created_at, effective_date" || cols === "created_at") return Promise.resolve({ data: { created_at: "2026-01-01", effective_date: null }, error: null });
            return Promise.resolve({ data: { revision_label: "5", created_at: "2026-01-01", record_id: DOC }, error: null });
          }
          if (table === "work_packages") return Promise.resolve({ data: { id: PKG, org_id: ORG, name: "TA-2026", status: "open", closed_at: null }, error: null });
          if (table === "work_package_prints") return Promise.resolve({ data: st.print, error: null });
          return Promise.resolve({ data: null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chain(t) }) }));
vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: async (_req: Request, orgId: string) => ({
    userId: "u1", email: "u1@x", orgId, role: "Viewer", roles: ["Viewer"], admin: { from: (t: string) => chain(t) },
  }),
  callerScopedClient: () => ({ from: (t: string) => chain(t) }),
}));

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  st.tokens = [];
  st.tokenListError = null;
  st.covers = [];
  st.coverReadError = null;
  st.audit = [];
  st.auditError = null;
  st.docStatus = "Issued";
  st.print = { id: COVER, printed_at: "2026-10-20T08:00:05Z", sheets: [{ documentId: DOC, versionId: V, revLabel: "5", label: "P-101", printed: true }] };
  st.reads = [];
  st.writes = [];
});

const tokenRow = (extra: Record<string, unknown> = {}) => ({
  id: `t${st.tokens.length}`, token_hash: "", print_id: PRINT, org_id: ORG, document_id: DOC, version_id: V,
  minted_at: "2026-10-20T08:00:00Z", settled_at: "2026-10-20T08:01:00Z", voided_at: null, void_reason: null, cover_print_id: null, ...extra,
});
function mint(extra: Record<string, unknown> = {}): string {
  const token = newSheetToken();
  st.tokens.push(tokenRow({ token_hash: hashSheetToken(token), ...extra }));
  return token;
}

async function scanSheet(t: string) {
  const { GET } = await import("@/app/api/verify/route");
  const u = new URL("https://app/api/verify");
  u.searchParams.set("t", t);
  const res = await GET(new NextRequest(u));
  return (await res.json()) as Record<string, unknown>;
}
async function scanCover(withPrint = true) {
  const { GET } = await import("@/app/api/verify-package/route");
  const u = new URL("https://app/api/verify-package");
  u.searchParams.set("p", PKG);
  if (withPrint) u.searchParams.set("print", COVER);
  const res = await GET(new NextRequest(u));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const sansClock = (b: Record<string, unknown>) => {
  const { checkedAt: _c, ...rest } = b;
  void _c;
  return rest;
};

// ── limb 2: the sheet ────────────────────────────────────────────────────
describe("PHYS-20 limb 2 — a recalled sheet says Document Control recalled it, with the date; still red", () => {
  it("void_reason 'recalled': print_voided (the same verdict and scan row), sheetPrint.recalled / recalledAt, worded 'recalled' with the date — never green", async () => {
    const t = mint({ voided_at: RECALLED_AT, void_reason: "recalled", cover_print_id: COVER });
    const r = await scanSheet(t);
    expect(r).toMatchObject({ verdict: "print_voided", isCurrent: false });
    expect(r.sheetPrint).toEqual({ printedAt: "2026-10-20T08:00:00Z", voided: true, recalled: true, recalledAt: RECALLED_AT });
    const view = presentDocVerdict(r as unknown as DocVerifyResult);
    expect(view.ok).toBe(false);
    expect(view.bg).toBe("bg-red-600");
    expect(view.headline).toBe("PRINT RECALLED — DO NOT USE");
    expect(view.blurb).toMatch(/^Document Control recalled this sheet's print on .+2026 — this paper was withdrawn after it was issued\./);
    expect(view.blurb).not.toMatch(/cancelled when it was made|no record that this paper was issued/);
    // the token read names the void reason (a column since 20261237) and never the link
    const tokenRead = st.reads.find((x) => x.table === "print_sheet_tokens");
    expect(tokenRead?.cols).toBe("print_id, document_id, version_id, minted_at, voided_at, void_reason");
  });

  it("PIN: 'not_printed' and 'print_aborted' keep PS-P9's answer and words byte for byte (two sheetPrint keys, PRINT CANCELLED)", async () => {
    for (const reason of ["not_printed", "print_aborted"]) {
      st.tokens = [];
      const t = mint({ voided_at: "2026-10-20T08:01:00Z", void_reason: reason });
      const r = await scanSheet(t);
      expect(r).toMatchObject({ verdict: "print_voided", isCurrent: false });
      expect(r.sheetPrint).toEqual({ printedAt: "2026-10-20T08:00:00Z", voided: true });
      expect(JSON.stringify(r)).not.toMatch(/recall/i);
      const view = presentDocVerdict(r as unknown as DocVerifyResult);
      expect(view).toEqual({
        bg: "bg-red-600", icon: "x", ok: false, headline: "PRINT CANCELLED — DO NOT USE",
        advice: "Get the current revision from Document Control before performing any work from this drawing. Mark this print “SUPERSEDED” or destroy it.",
        blurb: "This sheet's print was cancelled when it was made — the system has no record that this paper was issued. Do not work from it; get a current print from Document Control.",
      });
    }
  });

  it("PIN: a live token (no void) answers as before — current, two sheetPrint keys, nothing about a recall", async () => {
    const t = mint();
    const r = await scanSheet(t);
    expect(r).toMatchObject({ verdict: "current", isCurrent: true });
    expect(r.sheetPrint).toEqual({ printedAt: "2026-10-20T08:00:00Z", voided: false });
    expect(JSON.stringify(r)).not.toMatch(/recall/i);
  });

  it("a stray 'recalled' flag can never make a sheet green: presentDocVerdict words only print_voided as recalled", () => {
    const base = { docNumber: "P-101", title: "x", printedRev: "5", printedAt: null, currentRev: "5", currentIssuedAt: null, effectiveDate: null, notYetEffective: false, docStatus: "Issued", checkedAt: "" };
    const green = presentDocVerdict({ ...base, verdict: "current", isCurrent: true, sheetPrint: { printedAt: null, voided: false, recalled: true, recalledAt: RECALLED_AT } });
    // the verdict decides the colour; the server never sends this pair (recalled implies voided → print_voided)
    expect(green.headline).toBe("CURRENT");
    const r = presentDocVerdict({ ...base, verdict: "print_voided", isCurrent: false, sheetPrint: { printedAt: null, voided: true, recalled: true, recalledAt: null } });
    expect(r).toMatchObject({ ok: false, headline: "PRINT RECALLED — DO NOT USE" });
    expect(r.blurb).toMatch(/^Document Control recalled this sheet's print — /);
  });
});

// ── limb 1: the cover ────────────────────────────────────────────────────
describe("PHYS-20 limb 1 — a recalled print's cover is never green", () => {
  it("a linked code voided 'recalled': verdict recalled with recalledAt; the sheet reads recalled, not fresh; the page says PACK RECALLED with the date", async () => {
    st.tokens = [
      tokenRow({ cover_print_id: COVER, voided_at: RECALLED_AT, void_reason: "recalled" }),
      tokenRow({ cover_print_id: COVER, voided_at: "2026-10-20T08:01:00Z", void_reason: "not_printed" }),
    ];
    const { status, body } = await scanCover();
    expect(status).toBe(200);
    expect(body).toMatchObject({ verdict: "recalled", allFresh: false, recalledAt: RECALLED_AT, printConfirmed: true });
    const sheets = body.sheets as Array<Record<string, unknown>>;
    expect(sheets.map((s) => s.state)).toEqual(["recalled"]);
    expect(sheets.every((s) => s.fresh === false)).toBe(true);
    expect(sheetLabel(sheets[0] as never)).toEqual({ text: "Rev 5 · RECALLED", ok: false });
    expect(body.staleCount).toBe(1);
    const view = presentPackVerdict(body as unknown as PackVerifyResult);
    expect(view).toMatchObject({ ok: false, bg: "bg-red-600", headline: "PACK RECALLED — DO NOT USE" });
    expect(view.blurb).toMatch(/^Document Control recalled this printed pack on .+2026\./);
    // the recall read: this cover's linked codes, this workspace, the reason 'recalled'
    const read = st.reads.filter((x) => x.table === "print_sheet_tokens");
    expect(read).toEqual([{ table: "print_sheet_tokens", cols: "voided_at" }]);
    expect(st.writes.filter((w) => !w.endsWith(":verify_scans"))).toEqual([]);
  });

  it("a recall says more than a hold or a stale sheet (the whole pack is withdrawn); a held sheet keeps its held state", async () => {
    st.tokens = [tokenRow({ cover_print_id: COVER, voided_at: RECALLED_AT, void_reason: "recalled" })];
    st.docStatus = "Superseded";
    const { body } = await scanCover();
    expect(body.verdict).toBe("recalled");
    expect((body.sheets as Array<Record<string, unknown>>)[0].state).toBe("superseded");
  });

  it("PIN: before 20261240 (42703), before 20261237 (PGRST205 / 42P01), with no linked code, or with linked codes none recalled — the cover answers EXACTLY as today", async () => {
    // the baseline: nothing in the token table at all
    const baseline = sansClock((await scanCover()).body);
    expect(baseline).toMatchObject({ verdict: "current", allFresh: true });
    expect("recalledAt" in baseline).toBe(false);
    for (const setup of [
      () => { st.tokenListError = { code: "42703", message: "column print_sheet_tokens.cover_print_id does not exist" }; },
      () => { st.tokenListError = { code: "PGRST205", message: "Could not find the table 'public.print_sheet_tokens' in the schema cache" }; },
      () => { st.tokenListError = { code: "42P01", message: 'relation "print_sheet_tokens" does not exist' }; },
      // codes of this print, NOT linked to the cover (printed before the link), recalled by token print id
      () => { st.tokens = [tokenRow({ voided_at: RECALLED_AT, void_reason: "recalled" })]; },
      // linked codes, none recalled (a sheet left out, a live sheet)
      () => { st.tokens = [tokenRow({ cover_print_id: COVER }), tokenRow({ cover_print_id: COVER, voided_at: "2026-10-20T08:01:00Z", void_reason: "not_printed" })]; },
      // another cover's recall
      () => { st.tokens = [tokenRow({ cover_print_id: COVER_B, voided_at: RECALLED_AT, void_reason: "recalled" })]; },
      // another workspace's row naming this cover id
      () => { st.tokens = [tokenRow({ org_id: "bbbbbbbb-0000-0000-0000-00000000000b", cover_print_id: COVER, voided_at: RECALLED_AT, void_reason: "recalled" })]; },
    ]) {
      st.tokens = [];
      st.tokenListError = null;
      setup();
      const { status, body } = await scanCover();
      expect(status).toBe(200);
      expect(sansClock(body)).toEqual(baseline);
    }
  });

  it("PIN: a legacy cover QR (no ?print=) never reads the token table and answers as today", async () => {
    st.tokens = [tokenRow({ cover_print_id: COVER, voided_at: RECALLED_AT, void_reason: "recalled" })];
    const { body } = await scanCover(false);
    expect(body.verdict).toBe("unconfirmed_print");
    expect(st.reads.some((x) => x.table === "print_sheet_tokens")).toBe(false);
  });

  it("an unreadable recall state is a 503 — never a guess at green", async () => {
    st.tokenListError = { code: "57014", message: "canceling statement due to statement timeout" };
    const { status, body } = await scanCover();
    expect(status).toBe(503);
    expect(body.verdict).toBeUndefined();
  });

  it("a print id the route cannot find stays 'unverifiable' and never reads the token table", async () => {
    st.print = null;
    const { body } = await scanCover();
    expect(body.verdict).toBe("unverifiable");
    expect(st.reads.some((x) => x.table === "print_sheet_tokens")).toBe(false);
  });

  it("an older page build that does not know 'recalled' still never shows green (falls to CAN'T VERIFY)", () => {
    const view = presentPackVerdict({ verdict: "no_such_verdict" as never, name: "x", packageStatus: null, closed: false, sheetCount: 1, staleCount: 1, allFresh: false, sheets: [], checkedAt: "" });
    expect(view.ok).toBe(false);
  });
});

// ── limb 3: the history's server read ────────────────────────────────────
async function history(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/print-sheet-tokens/route");
  const res = await POST(new NextRequest("https://app/api/print-sheet-tokens", { method: "POST", body: JSON.stringify({ action: "history", orgId: ORG, ...body }), headers: { authorization: "Bearer x" } }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("PHYS-20 limb 3 — the print history's read of each print's code state", () => {
  beforeEach(() => {
    st.covers = [
      { id: COVER, org_id: ORG }, { id: COVER_B, org_id: ORG }, { id: COVER_C, org_id: ORG }, { id: COVER_D, org_id: ORG },
      { id: COVER_OTHER_ORG, org_id: "bbbbbbbb-0000-0000-0000-00000000000b" },
    ];
    st.tokens = [
      // COVER: recalled (one sheet already left out, the rest recalled)
      tokenRow({ cover_print_id: COVER, print_id: PRINT, voided_at: "2026-10-20T08:01:00Z", void_reason: "not_printed" }),
      tokenRow({ cover_print_id: COVER, print_id: PRINT, voided_at: RECALLED_AT, void_reason: "recalled" }),
      // COVER_B: stopped before its download — every code 'print_aborted'
      tokenRow({ cover_print_id: COVER_B, print_id: PRINT_B, voided_at: "2026-10-20T08:01:00Z", void_reason: "print_aborted" }),
      tokenRow({ cover_print_id: COVER_B, print_id: PRINT_B, voided_at: "2026-10-20T08:01:00Z", void_reason: "print_aborted" }),
      // COVER_C: linked, live
      tokenRow({ cover_print_id: COVER_C, print_id: PRINT_C }),
      tokenRow({ cover_print_id: COVER_C, print_id: PRINT_C, voided_at: "2026-10-20T08:01:00Z", void_reason: "not_printed" }),
      // COVER_D: nothing linked
    ];
    st.audit = [
      { user_email: "dc.lee@plant.example", action: "DISTRIBUTION_RECALL", org_id: ORG, details: { kind: "sheet_print_recall", coverPrintId: COVER, printIds: [PRINT], recordedBeforeApply: true } },
    ];
  });

  it("recalled (when, by whom — the email's local part, the history's own convention), stopped, linked, unlinked; a cover of another workspace is not answered; nothing written", async () => {
    const { status, body } = await history({ coverPrintIds: [COVER, COVER_B, COVER_C, COVER_D, COVER_OTHER_ORG] });
    expect(status).toBe(200);
    expect(body).toEqual({
      available: true,
      prints: {
        [COVER]: { state: "recalled", recalledAt: RECALLED_AT, recalledBy: "dc.lee" },
        [COVER_B]: { state: "stopped" },
        [COVER_C]: { state: "linked" },
        [COVER_D]: { state: "unlinked" },
      },
    });
    expect(st.writes).toEqual([]);
  });

  it("a print stopped in part is never 'stopped': one live or left-out code keeps it 'linked' (a downloaded pack is never said to have no paper)", async () => {
    st.tokens.push(tokenRow({ cover_print_id: COVER_B, print_id: PRINT_B }));
    expect(((await history({ coverPrintIds: [COVER_B] })).body.prints as Record<string, unknown>)[COVER_B]).toEqual({ state: "linked" });
    st.tokens = st.tokens.filter((t) => t.void_reason !== null || t.cover_print_id !== COVER_B);
    st.tokens.push(tokenRow({ cover_print_id: COVER_B, print_id: PRINT_B, voided_at: "2026-10-20T08:01:00Z", void_reason: "not_printed" }));
    expect(((await history({ coverPrintIds: [COVER_B] })).body.prints as Record<string, unknown>)[COVER_B]).toEqual({ state: "linked" });
  });

  it("a recall made by the token print id (no cover in its audit row) is still named; an unreadable audit leaves the recall unnamed, never unsaid", async () => {
    st.audit = [{ user_email: "ana@plant.example", action: "DISTRIBUTION_RECALL", org_id: ORG, details: { kind: "sheet_print_recall", coverPrintId: null, printIds: [PRINT], recordedBeforeApply: true } }];
    expect(((await history({ coverPrintIds: [COVER] })).body.prints as Record<string, unknown>)[COVER]).toEqual({ state: "recalled", recalledAt: RECALLED_AT, recalledBy: "ana" });
    st.auditError = { message: "boom" };
    expect(((await history({ coverPrintIds: [COVER] })).body.prints as Record<string, unknown>)[COVER]).toEqual({ state: "recalled", recalledAt: RECALLED_AT, recalledBy: null });
  });

  it("before 20261240 (42703 / PGRST204) or 20261237 (PGRST205): { available: false }; any other token-read error, or an unreadable cover read, is a 503", async () => {
    for (const e of [{ code: "42703", message: "column print_sheet_tokens.cover_print_id does not exist" }, { code: "PGRST204", message: "x" }, { code: "PGRST205", message: "x" }]) {
      st.tokenListError = e;
      expect(await history({ coverPrintIds: [COVER] })).toEqual({ status: 200, body: { available: false } });
    }
    st.tokenListError = { code: "57014", message: "timeout" };
    expect((await history({ coverPrintIds: [COVER] })).status).toBe(503);
    st.tokenListError = null;
    st.coverReadError = { message: "boom" };
    expect((await history({ coverPrintIds: [COVER] })).status).toBe(503);
    expect(st.writes).toEqual([]);
  });

  it("a malformed request is 400 before anything is read", async () => {
    for (const b of [{}, { coverPrintIds: [] }, { coverPrintIds: ["nope"] }, { coverPrintIds: Array.from({ length: 26 }, (_, i) => `c1c1c1c1-0000-0000-0000-${String(i).padStart(12, "0")}`) }]) {
      expect((await history(b)).status).toBe(400);
    }
    expect(st.reads).toEqual([]);
  });
});
