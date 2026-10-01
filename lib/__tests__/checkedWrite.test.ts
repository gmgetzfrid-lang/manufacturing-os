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
import { checkedWrite, describeWriteError, isMissingSchemaError, CHECKED_WRITE_REFUSED } from "@/lib/checkedWrite";

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
    // REL-3 (J10): raw driver text is translated too — never shown as written
    expect((other as { error: string }).error).toBe("Someone else changed this at the same moment — nothing was changed. Try again.");
    const thrown = await checkedWrite(Promise.reject(new Error("fetch failed")));
    // REL-3 (J10): a dropped connection is said in words too
    expect(thrown).toMatchObject({ ok: false, code: "db", error: "Couldn't reach the server — check your connection and try again." });
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
    // 20261091: an item write gives way to a checklist delete after 500 ms instead of deadlocking
    expect(describeWriteError({ message: "canceling statement due to lock timeout", code: "55P03" })).toBe("Someone is changing or deleting this checklist right now — nothing was changed. Try again.");
  });
  it("a pending migration in PostgREST's schema-cache shapes (PGRST204 / PGRST205) and raw 42703 reads as the migration message, never raw text", async () => {
    // What setPunchStatus (closed_by_name…), a punch add with a location or
    // details, and a history read actually meet before 20261091.
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
    // REL-3 (J10): PostgREST's single-row text is translated, not passed through
    expect(describeWriteError({ message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" })).toBe("That record wasn't found — it may have been removed, or you can't see it.");
  });
  it("isMissingSchemaError is true for the pending-migration shapes only — a denial or an outage is never 'not there yet'", () => {
    for (const e of [
      { message: "x", code: "42P01" }, { message: "x", code: "42703" }, { message: "x", code: "PGRST204" }, { message: "x", code: "PGRST205" },
      { message: 'relation "public.turnover_review_events" does not exist' },
      { message: "Could not find the table 'public.turnover_review_events' in the schema cache" },
    ]) expect(isMissingSchemaError(e), JSON.stringify(e)).toBe(true);
    for (const e of [
      { message: "permission denied for table turnover_review_events", code: "42501" },
      { message: "upstream request timeout", code: "PGRST000" },
      { message: "fetch failed" },
    ]) expect(isMissingSchemaError(e), JSON.stringify(e)).toBe(false);
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
    // Checked = routed through checkedWrite, or J3 MONEY-LEDGER's shape: the
    // statement returns the matched rows (`.select("id")`) and the code right
    // after it tests their count (a zero-row match is a refusal, never success).
    const after = text.slice(end < 0 ? text.length : end, (end < 0 ? text.length : end) + 400);
    // (A builder assigned in one statement and awaited with its .select("id")
    // in the next — the change-order decision claim — counts the same way.)
    const countChecked = /\.select\("id"\)/.test(stmt + after.slice(0, 200)) && /\.length\b/.test(after);
    out.push({ line: text.slice(0, at).split("\n").length, checked: stmt.includes("checkedWrite(") || countChecked, snippet: stmt.trim().slice(0, 80) });
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
  it("the census itself: a bare update whose result is discarded is flagged; the count-checked and checkedWrite shapes are not", () => {
    const bare = 'async function a() {\n  const { error } = await supabase.from("t").update({ x: 1 }).eq("id", id);\n  if (error) throw error;\n  return rows.length;\n}';
    const counted = 'async function b() {\n  const { data: hit, error } = await supabase.from("t").update({ x: 1 }).eq("id", id).select("id");\n  if (!hit || hit.length === 0) return NO_ROW;\n}';
    const helper = 'async function c() {\n  const r = await checkedWrite(supabase.from("t").update({ x: 1 }).eq("id", id).select("id"));\n}';
    expect(writeSites(bare).map((w) => w.checked)).toEqual([false]);
    expect(writeSites(counted).map((w) => w.checked)).toEqual([true]);
    expect(writeSites(helper).map((w) => w.checked)).toEqual([true]);
  });
  it("the money files check every update/delete's matched rows (J3 converted them; the ratchet is at zero)", () => {
    // Baseline at 8276cad was costs 3, costDocs 5, changeOrders 3 unchecked
    // sites; J3 MONEY-LEDGER converted every one (SAF-3's money half).
    for (const f of ["lib/costs.ts", "lib/costDocs.ts", "lib/changeOrders.ts"]) {
      const sites = writeSites(src(f));
      expect(sites.length, `${f} should have write sites`).toBeGreaterThan(0);
      const raw = sites.filter((s) => !s.checked);
      expect(raw, `${f}: unchecked write(s): ${raw.map((s) => `L${s.line} ${s.snippet}`).join(" | ")}`).toEqual([]);
    }
  });
});
