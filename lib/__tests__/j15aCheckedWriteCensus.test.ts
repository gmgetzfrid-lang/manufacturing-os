// projects-tab SAF-18 — J15a: the census, widened to writes through a client
// PARAMETER, for this batch's files (the integrator's residual-2 ruling).
//
// lib/__tests__/checkedWrite.test.ts counts an update / delete only when its
// statement says `supabase`, so a write through a client handed in as a
// parameter (`db.from(…)`, `sb.from(…)`, `admin.from(…)`, `client.from(…)`)
// escapes it — lib/checkoutEpisodes.ts had five. This census applies the
// same rule (checkedWrite, or `.select("id")` with a `.length` test after)
// to those statements too, for the 27 files J15a cleared: every one stays
// clean. It is NOT widened to the whole tree here: measured at J15a it finds
// 37 unchecked client-parameter sites in 14 files outside this batch (none
// on a ratchet list), so the shared census would fail at once until each
// file is listed with its count — a census-number change reserved for the
// integrator (SAF-18's J15a Partial names the files and counts).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A receiver that is a supabase client by name: the shared client, or a
 *  client parameter. Array.from, a Map's / Set's delete, a URL's
 *  searchParams.delete never match. */
const CLIENT = /\bsupabase(?:Admin)?\b|(?:^|[^\w.$])(?:db|sb|admin|client)\s*\.\s*from\(/;

function writeSites(text: string): Array<{ line: number; checked: boolean; viaParam: boolean; snippet: string }> {
  const out: Array<{ line: number; checked: boolean; viaParam: boolean; snippet: string }> = [];
  for (const m of text.matchAll(/\.(update|delete)\(/g)) {
    const at = m.index ?? 0;
    const start = Math.max(text.lastIndexOf(";", at), text.lastIndexOf("{", at)) + 1;
    const end = text.indexOf(";", at);
    const stmt = text.slice(start, end < 0 ? text.length : end);
    if (!CLIENT.test(stmt)) continue;
    const after = text.slice(end < 0 ? text.length : end, (end < 0 ? text.length : end) + 400);
    const countChecked = /\.select\("id"\)/.test(stmt + after.slice(0, 200)) && /\.length\b/.test(after);
    out.push({ line: text.slice(0, at).split("\n").length, checked: stmt.includes("checkedWrite(") || countChecked, viaParam: !stmt.includes("supabase"), snippet: stmt.trim().slice(0, 80) });
  }
  return out;
}

const J15A = [
  "lib/acknowledgments.ts", "lib/checkoutEpisodes.ts", "lib/reviewControl.ts", "lib/revisions.ts", "lib/reviewCycles.ts",
  "lib/documentLifecycle/common.ts", "lib/documentLifecycle/renumber.ts", "lib/documentLifecycle/reverse.ts", "lib/documentLifecycle/split.ts",
  "lib/holds.ts", "lib/effectiveDate.ts", "lib/documentOrigin.ts", "lib/documentShares.ts", "lib/docClass.ts", "lib/retention.ts",
  "lib/markups.ts", "lib/markupRequests.ts", "lib/transmittals.ts", "lib/branches.ts", "lib/unitCodeDecode.ts", "lib/collections.ts",
  "lib/libraryCollections.ts", "lib/libraryViews.ts", "lib/favorites.ts", "lib/tableViews.ts", "lib/watches.ts", "lib/assets.ts",
];

describe("SAF-18 (J15a) — the census, widened to client-parameter writes, for this batch's files", () => {
  it("every update / delete in J15a's 27 files — through `supabase` or a client parameter — reads its matched rows", () => {
    for (const f of J15A) {
      const raw = writeSites(readFileSync(join(process.cwd(), f), "utf8")).filter((s) => !s.checked);
      expect(raw, `${f}: unchecked write(s): ${raw.map((s) => `L${s.line} ${s.snippet}`).join(" | ")}`).toEqual([]);
    }
    // lib/checkoutEpisodes.ts's five client-parameter writes are counted (and checked)
    const ce = writeSites(readFileSync(join(process.cwd(), "lib/checkoutEpisodes.ts"), "utf8"));
    expect(ce.filter((s) => s.viaParam).map((s) => s.checked)).toEqual([true, true, true, true, true]);
  });
  it("the widened rule itself: a bare client-parameter write is flagged; a checked one, Array.from and a Map / Set delete are not", () => {
    expect(writeSites('async function a(db) {\n  await db.from("t").update({ x: 1 }).eq("id", id);\n}').map((s) => s.checked)).toEqual([false]);
    expect(writeSites('async function b(sb) {\n  const w = await checkedWrite(sb.from("t").delete().eq("id", id).select("id"));\n}').map((s) => s.checked)).toEqual([true]);
    expect(writeSites('function c() {\n  Array.from(keys).forEach((k) => cache.delete(k));\n  next.delete(id);\n  url.searchParams.delete("q");\n}')).toEqual([]);
    expect(writeSites('function d() {\n  const r = await supabase.from("t").update({ x: 1 }).eq("id", id);\n}').map((s) => s.checked)).toEqual([false]);
  });
});
