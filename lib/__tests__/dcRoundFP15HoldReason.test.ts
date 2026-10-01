// document-control Round F wave 3 — P15 SURFACE REMAINDERS: public-surfaces
// VFY-6 done-when 2, the reversible option — the free-text path into
// document_holds.reason is CLOSED in the app (no column split):
//   * lib/holds.ts openHold writes only a reason CODE (the four predefined
//     reasons or "Other"); an "Other" hold carries its description in the
//     hold's NOTE, which no public surface publishes;
//   * the picker's "Other…" places the "Other" code with the typed
//     description as the note;
//   * migration 20261152 keys an open "Other" hold by its note in the
//     open-reason unique index, so two different custom holds on one
//     document stay placeable (as two free-text reasons were before).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  inserts: [] as Row[],
  insertError: null as { code?: string; message: string } | null,
}));

function chain(table: string) {
  let op: "select" | "insert" = "select";
  let payload: Row = {};
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (res: (v: unknown) => void) => res({ data: [], error: null });
      return (...args: unknown[]) => {
        if (prop === "insert") { op = "insert"; payload = args[0] as Row; }
        if (prop === "single" || prop === "maybeSingle") {
          if (op === "insert" && table === "document_holds") {
            state.inserts.push(payload);
            return Promise.resolve(state.insertError
              ? { data: null, error: state.insertError }
              : { data: { id: "h-new", opened_at: "2026-10-01T00:00:00Z", released_at: null, ...payload }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabase", () => ({
  supabase: {
    // no signed-in user: openHold's capability check is not policy-gated here
    auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
    from: (t: string) => chain(t),
  },
}));
const audit = vi.hoisted(() => ({ logHoldEvent: vi.fn(async (_p: Row) => undefined) }));
vi.mock("@/lib/audit", () => ({ logHoldEvent: audit.logHoldEvent }));
const dispatch = vi.hoisted(() => ({ emit: vi.fn(async (_p: Row) => undefined) }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: dispatch.emit }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => undefined) }));

import {
  openHold, HOLD_REASON_CODES, PREDEFINED_HOLD_REASONS, OTHER_HOLD_REASON, isHoldReasonCode, holdReasonLabel,
  publicHoldReason, PUBLIC_HOLD_REASON_FALLBACK, openHoldKey,
} from "@/lib/holds";

const root = process.cwd();
const src = (p: string) => readFileSync(join(root, p), "utf8");
const base = { orgId: "o1", documentId: "d1", openedBy: "u1", openedByName: "Dana" };

beforeEach(() => {
  state.inserts = [];
  state.insertError = null;
  audit.logHoldEvent.mockClear();
  dispatch.emit.mockClear();
});

describe("VFY-6 — the hold reason is a code; free text lives in the note", () => {
  it("the codes are the four predefined reasons and Other (the schema's HoldReason)", () => {
    expect(HOLD_REASON_CODES).toEqual([...PREDEFINED_HOLD_REASONS, "Other"]);
    expect(OTHER_HOLD_REASON).toBe("Other");
    expect(src("types/schema.ts")).toMatch(/export type HoldReason =\s*\n\s*\| "Awaiting Engineering"\s*\n\s*\| "Field Verification Needed"\s*\n\s*\| "Missing Vendor Data"\s*\n\s*\| "Client Review"\s*\n\s*\| "Other";/);
    for (const r of HOLD_REASON_CODES) expect(isHoldReasonCode(r)).toBe(true);
    expect(isHoldReasonCode(" Client Review ")).toBe(true);
    expect(isHoldReasonCode("Hold pending OSHA 1910.119 finding")).toBe(false);
    expect(isHoldReasonCode("")).toBe(false);
  });
  it("openHold refuses free text in `reason` — nothing is written", async () => {
    await expect(openHold({ ...base, reason: "Hold pending OSHA 1910.119 finding — Fuller incident" }))
      .rejects.toThrow(/A hold's reason is one of: Awaiting Engineering, Field Verification Needed, Missing Vendor Data, Client Review, Other\. For anything else choose "Other" and describe it in the hold's note\./);
    expect(state.inserts).toEqual([]);
    expect(audit.logHoldEvent).not.toHaveBeenCalled();
  });
  it("an Other hold needs its description", async () => {
    await expect(openHold({ ...base, reason: "Other" })).rejects.toThrow(/"Other" hold needs a description/);
    await expect(openHold({ ...base, reason: "Other", notes: "   " })).rejects.toThrow(/"Other" hold needs a description/);
    expect(state.inserts).toEqual([]);
  });
  it("REGRESSION: a custom hold is still placed — as Other, the description in the note; the members are told the description", async () => {
    const out = await openHold({ ...base, reason: "Other", notes: "Waiting on legal re: incident" });
    expect(state.inserts).toEqual([expect.objectContaining({ reason: "Other", notes: "Waiting on legal re: incident", org_id: "o1", document_id: "d1" })]);
    expect(out.reason).toBe("Other");
    expect(out.notes).toBe("Waiting on legal re: incident");
    expect(audit.logHoldEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "HOLD_OPENED", reason: "Other", details: expect.objectContaining({ notes: "Waiting on legal re: incident" }) }));
    await vi.waitFor(() => expect(dispatch.emit).toHaveBeenCalled());
    expect(dispatch.emit.mock.calls[0][0]).toMatchObject({ title: expect.stringMatching(/— Other: Waiting on legal re: incident$/) });
  });
  it("REGRESSION: a predefined hold is placed exactly as before (the check-in's Field Verification Needed with its note included)", async () => {
    await openHold({ ...base, reason: "Client Review" });
    await openHold({ ...base, reason: "Field Verification Needed", notes: "walk down unit 200" });
    expect(state.inserts.map((r) => [r.reason, r.notes])).toEqual([["Client Review", null], ["Field Verification Needed", "walk down unit 200"]]);
  });
  it("a second open Other hold the index refuses says why (one at a time until 20261152; same description after)", async () => {
    state.insertError = { code: "23505", message: "duplicate key value violates unique constraint \"document_holds_open_reason_uniq\"" };
    await expect(openHold({ ...base, reason: "Other", notes: "x" })).rejects.toThrow(/An "Other" hold is already open on this document — with this description, or \(until database update 20261152 is applied\) with any description\./);
    await expect(openHold({ ...base, reason: "Client Review" })).rejects.toThrow('A "Client Review" hold is already open on this document.');
  });
  it("holdReasonLabel names an Other hold by its note (members only); every other hold by its reason", () => {
    expect(holdReasonLabel({ reason: "Other", notes: " Waiting on legal " })).toBe("Other: Waiting on legal");
    expect(holdReasonLabel({ reason: "Other", notes: null })).toBe("Other");
    expect(holdReasonLabel({ reason: "Client Review", notes: "x" })).toBe("Client Review");
    expect(holdReasonLabel({ reason: "Other", notes: "y".repeat(300) })).toHaveLength(127); // "Other: " + 119 + "…"
  });
  it("openHoldKey is the 20261152 index's key: an Other hold by its btrim'd note, every other reason by the reason alone (P15 review fix)", () => {
    expect(openHoldKey({ reason: "Other", notes: "Awaiting legal" })).not.toBe(openHoldKey({ reason: "Other", notes: "Pending survey" }));
    expect(openHoldKey({ reason: "Other", notes: "  Awaiting legal  " })).toBe(openHoldKey({ reason: "Other", notes: "Awaiting legal" }));
    expect(openHoldKey({ reason: "Other", notes: null })).toBe(openHoldKey({ reason: "Other", notes: "" }));
    expect(openHoldKey({ reason: "Client Review", notes: "a" })).toBe(openHoldKey({ reason: "Client Review", notes: "b" }));
    expect(openHoldKey({ reason: "Awaiting legal", notes: "a" })).toBe("Awaiting legal"); // a legacy free-text reason: by reason, as before
    // the index the key mirrors (keep the two in step)
    expect(src("supabase/migrations/20261152_dc_roundF_hold_other_reason.sql")).toContain("(document_id, reason, (CASE WHEN reason = 'Other' THEN COALESCE(btrim(notes), '') ELSE '' END))");
  });
  it("the public surfaces still say only the category — an Other hold and a legacy free-text one alike", () => {
    expect(publicHoldReason("Other")).toBe(PUBLIC_HOLD_REASON_FALLBACK);
    expect(publicHoldReason("Waiting on legal")).toBe(PUBLIC_HOLD_REASON_FALLBACK);
    for (const r of PREDEFINED_HOLD_REASONS) expect(publicHoldReason(r)).toBe(r);
    // no public hold read selects the note (VFY-6 / HLD-7, unchanged)
    for (const f of ["app/api/verify-hold/route.ts", "app/api/verify/route.ts", "app/api/verify-package/route.ts"]) {
      const route = src(f);
      for (const sel of route.match(/from\("document_holds"\)[\s\S]{0,200}?\.select\("([^"]*)"\)/g) ?? []) expect(sel, f).not.toMatch(/notes/);
    }
  });
});

describe("VFY-6 — the picker's Other… places the Other code with the description as the note", () => {
  const strip = src("components/documents/HoldStrip.tsx");
  it("Add sends OTHER_HOLD_REASON and the typed text as the note; no free-text reason", () => {
    expect(strip).toContain("onClick={() => otherDraft?.trim() && onOpen(OTHER_HOLD_REASON, expectedDraft, otherDraft)}");
    expect(strip).not.toMatch(/onOpen\(otherDraft/);
    expect(strip).not.toContain('placeholder="Custom hold reason"');
    expect(strip).toContain(`placeholder="What is it held for? (kept in the hold's note)"`);
    const onOpenFn = strip.slice(strip.indexOf("const onOpen = async (reason: string, expectedDate?: string, notes?: string) => {"), strip.indexOf("const onRelease = async"));
    expect(onOpenFn).toContain("...(notes?.trim() ? { notes: notes.trim() } : {}),");
  });
  it("the predefined buttons are unchanged (one click, then the optional date)", () => {
    expect(strip).toContain("onClick={() => onOpen(pendingReason, expectedDraft)}");
    expect(strip).toMatch(/PREDEFINED_HOLD_REASONS\.map\(\(r\) => \(/);
  });
});

describe("20261152 — an open Other hold is keyed by its note (one paste, DEC-30)", () => {
  const sql = src("supabase/migrations/20261152_dc_roundF_hold_other_reason.sql");
  const code = sql.replace(/--[^\n]*/g, "");
  it("inventory in a TEMP table BEFORE the transaction, aggregate counts only", () => {
    const tempAt = code.indexOf("CREATE TEMP TABLE dc_round_f_152_before AS");
    expect(code.indexOf("DROP TABLE IF EXISTS dc_round_f_152_before;")).toBeLessThan(tempAt);
    expect(tempAt).toBeGreaterThan(-1);
    expect(tempAt).toBeLessThan(code.indexOf("BEGIN;"));
    const inventory = code.slice(tempAt, code.indexOf("BEGIN;"));
    // every inventory row is a COUNT — no customer row, no reason text leaves
    const rows = inventory.split(/\nUNION ALL\n/);
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r).toMatch(/COUNT\(\*\)::text/);
    expect(inventory).not.toMatch(/SELECT\s+(reason|notes|document_id)\s*,/);
  });
  it("the inventory's code list is HOLD_REASON_CODES, and the index's Other literal is OTHER_HOLD_REASON", () => {
    const lists = code.match(/reason NOT IN \(([^)]*)\)/g) ?? [];
    expect(lists.length).toBe(3);
    for (const l of lists) {
      const codes = [...l.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      expect(codes).toEqual([...HOLD_REASON_CODES]);
    }
    expect(code).toContain(`CASE WHEN reason = '${OTHER_HOLD_REASON}' THEN COALESCE(btrim(notes), '') ELSE '' END`);
  });
  it("the DDL: the 20260612 index dropped and re-created, partial on open holds, inside BEGIN / COMMIT — nothing else", () => {
    const ddl = code.slice(code.indexOf("BEGIN;"), code.indexOf("COMMIT;"));
    expect(ddl).toContain("DROP INDEX IF EXISTS document_holds_open_reason_uniq;");
    expect(ddl).toMatch(/CREATE UNIQUE INDEX document_holds_open_reason_uniq\s*\n\s*ON document_holds \(document_id, reason, \(CASE WHEN reason = 'Other' THEN COALESCE\(btrim\(notes\), ''\) ELSE '' END\)\)\s*\n\s*WHERE released_at IS NULL;/);
    expect(ddl).not.toMatch(/CREATE (OR REPLACE )?(FUNCTION|POLICY|TRIGGER)|ALTER TABLE|UPDATE |DELETE FROM|INSERT INTO/i);
    // the index it replaces is the 20260612 one, and no later migration re-creates it
    expect(src("supabase/migrations/20260612_phase5_holds.sql")).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS document_holds_open_reason_uniq\s*\n\s*ON document_holds\(document_id, reason\) WHERE released_at IS NULL;/);
  });
  it("one final SELECT with the (check, ok, n) shape: probes carry ok, inventory rows carry n", () => {
    const tail = code.slice(code.indexOf("COMMIT;") + "COMMIT;".length);
    expect((tail.match(/^SELECT /gm) ?? []).length).toBe(1 + (tail.match(/^UNION ALL\nSELECT /gm) ?? []).length);
    expect(tail).toMatch(/^SELECT '[^']+' AS check,\s*\n[\s\S]*?AS ok,\s*\n\s*NULL::text AS n/m);
    expect(tail).toContain("SELECT inventory, NULL::boolean, n FROM dc_round_f_152_before;");
    // deparsed index text is matched with % across the CASE's own lines; no bare cast in a LIKE pattern
    expect(tail).toContain("indexdef LIKE '%(document_id, reason, (%CASE%WHEN%Other%THEN%COALESCE(btrim(notes)%ELSE%END)) WHERE%'");
    expect(tail).not.toMatch(/LIKE '[^']*::/);
    expect(tail.trim().endsWith(";")).toBe(true);
    expect((tail.match(/;/g) ?? []).length).toBe(1);
  });
});
