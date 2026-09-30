// GAP-402 (narrow) — lib/checkedWrite.ts: a write that cannot silently fail.
//
// The helper: zero matched rows is a typed refusal (no audit row follows),
// a database error is a typed failure with plain language for the two
// codes the Projects area meets, and nothing throws raw Postgres text.
//
// The census (GAP-402 acceptance 3): every `.update(` / `.delete(` on a
// supabase chain in the quality data layers (lib/checklists.ts,
// lib/turnover.ts) must be wrapped in checkedWrite(...). The money files
// (lib/costs.ts, lib/costDocs.ts, lib/changeOrders.ts) are J3's to convert
// (DEC-31: the safety-critical paths first); until they are, the census
// RATCHETS them — the count of unchecked sites may fall, never rise.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkedWrite, describeWriteError, CHECKED_WRITE_REFUSED } from "@/lib/checkedWrite";

describe("checkedWrite", () => {
  it("zero rows ⇒ refused (the RLS shape: { data: [], error: null })", async () => {
    const r = await checkedWrite(Promise.resolve({ data: [], error: null }));
    expect(r).toEqual({ ok: false, code: "refused", error: CHECKED_WRITE_REFUSED });
    const n = await checkedWrite(Promise.resolve({ data: null, error: null }));
    expect(n.ok).toBe(false);
  });
  it("a database error ⇒ db failure, translated, never thrown", async () => {
    const missing = await checkedWrite(Promise.resolve({ data: null, error: { message: 'relation "public.turnover_review_events" does not exist', code: "42P01" } }));
    expect(missing).toMatchObject({ ok: false, code: "db", pgCode: "42P01" });
    expect((missing as { error: string }).error).toMatch(/latest database migration/);
    const rls = await checkedWrite(Promise.resolve({ data: null, error: { message: 'new row violates row-level security policy for table "checklist_items"', code: "42501" } }));
    expect((rls as { error: string }).error).toMatch(/don't have permission/);
    const other = await checkedWrite(Promise.resolve({ data: null, error: { message: "deadlock detected", code: "40P01" } }));
    expect((other as { error: string }).error).toBe("deadlock detected");
    const thrown = await checkedWrite(Promise.reject(new Error("fetch failed")));
    expect(thrown).toMatchObject({ ok: false, code: "db", error: "fetch failed" });
  });
  it("matched rows ⇒ ok with the ids", async () => {
    expect(await checkedWrite(Promise.resolve({ data: [{ id: "a" }, { id: "b" }], error: null }))).toEqual({ ok: true, ids: ["a", "b"] });
    expect(await checkedWrite(Promise.resolve({ data: { id: "one" }, error: null }))).toEqual({ ok: true, ids: ["one"] });
  });
  it("describeWriteError maps by code or by message", () => {
    expect(describeWriteError({ message: "x", code: "42P01" })).toMatch(/migration/);
    expect(describeWriteError({ message: 'relation "public.x" does not exist' })).toMatch(/migration/);
    expect(describeWriteError({ message: "violates row-level security policy" })).toMatch(/permission/);
    expect(describeWriteError({ message: "" })).toMatch(/write failed/);
  });
  it("a pending migration in PostgREST's schema-cache shapes (PGRST204 / PGRST205) and raw 42703 reads as the migration message, never raw text", async () => {
    // What setChecklistStatus (completed_basis), setPunchStatus (closed_by_name…)
    // and the turnover_review_events insert actually meet before 20261091.
    const column = { message: "Could not find the 'completed_basis' column of 'project_checklists' in the schema cache", code: "PGRST204" };
    const table = { message: "Could not find the table 'public.turnover_review_events' in the schema cache", code: "PGRST205" };
    const rawColumn = { message: 'column "closed_by_name" of relation "punch_items" does not exist', code: "42703" };
    for (const e of [column, table, rawColumn]) {
      expect(describeWriteError(e), e.code).toBe("This needs the latest database migration applied — nothing was changed.");
      const r = await checkedWrite(Promise.resolve({ data: null, error: e }));
      expect(r).toMatchObject({ ok: false, code: "db", pgCode: e.code });
      expect((r as { error: string }).error).not.toMatch(/schema cache|does not exist/);
    }
    // …by message alone too (a proxy that strips the code)
    expect(describeWriteError({ message: column.message })).toMatch(/latest database migration/);
    expect(describeWriteError({ message: rawColumn.message })).toMatch(/latest database migration/);
    // …and an unrelated PostgREST error still carries its own message
    expect(describeWriteError({ message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" })).toBe("JSON object requested, multiple (or no) rows returned");
  });
});

// ── the census ───────────────────────────────────────────────────────────

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Statements that carry a supabase update/delete, with whether the
 *  statement routes through checkedWrite. A statement runs from the previous
 *  `;` / `{` boundary to the next `;`. */
function writeSites(text: string): Array<{ line: number; checked: boolean; snippet: string }> {
  const out: Array<{ line: number; checked: boolean; snippet: string }> = [];
  const re = /\.(update|delete)\(/g;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    const start = Math.max(text.lastIndexOf(";", at), text.lastIndexOf("{", at)) + 1;
    const end = text.indexOf(";", at);
    const stmt = text.slice(start, end < 0 ? text.length : end);
    if (!stmt.includes("supabase")) continue;
    out.push({ line: text.slice(0, at).split("\n").length, checked: stmt.includes("checkedWrite("), snippet: stmt.trim().slice(0, 80) });
  }
  return out;
}

describe("census — no raw discarded write result in the quality data layers (GAP-402 acceptance 3)", () => {
  it("lib/checklists.ts and lib/turnover.ts route every update/delete through checkedWrite", () => {
    for (const f of ["lib/checklists.ts", "lib/turnover.ts"]) {
      const sites = writeSites(src(f));
      expect(sites.length, `${f} should have write sites`).toBeGreaterThan(0);
      const raw = sites.filter((s) => !s.checked);
      expect(raw, `${f}: unchecked write(s): ${raw.map((s) => `L${s.line} ${s.snippet}`).join(" | ")}`).toEqual([]);
    }
  });
  it("neither file destructures `{ error }` off a bare update/delete any more (the SAF-3 shape)", () => {
    for (const f of ["lib/checklists.ts", "lib/turnover.ts"]) {
      expect(src(f)).not.toMatch(/const \{ error[^}]*\} = await supabase\.from\("[^"]+"\)\.(update|delete)\(/);
    }
  });
  it("the money files ratchet: unchecked update/delete sites may fall, never rise (J3 converts them)", () => {
    // Baseline at 8276cad: costs 3, costDocs 5, changeOrders 3.
    const baseline: Record<string, number> = { "lib/costs.ts": 3, "lib/costDocs.ts": 5, "lib/changeOrders.ts": 3 };
    for (const [f, max] of Object.entries(baseline)) {
      const raw = writeSites(src(f)).filter((s) => !s.checked);
      expect(raw.length, `${f}: ${raw.map((s) => `L${s.line}`).join(", ")}`).toBeLessThanOrEqual(max);
    }
  });
});
