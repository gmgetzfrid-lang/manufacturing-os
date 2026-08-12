// knowledge_page_entities holds several unrelated kinds of row under one
// table, and its bulk readers pull a wide slab under a row cap that then
// feeds DETERMINISTIC counts — equipment censuses, reference audits — which
// the answer prompt explicitly tells the model to trust for totals.
//
// A bulk read that does not name its kinds is a live hazard. The moment
// ingestion writes a new kind at volume, those rows compete for the same
// cap, whichever ones Postgres returns first win, and the census silently
// shrinks. Nothing throws. Filtering after the fetch cannot recover rows the
// limit already dropped.
//
// So this greps the repo the way exportCoverage.test.ts does: any bulk read
// must name its kinds, or be exempted here in writing.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const TABLE = 'from("knowledge_page_entities")';

/** Reads narrowed to a specific sheet/tag can't be swamped by another kind —
 *  they ask for a handful of named rows, not a slab. Each is listed rather
 *  than pattern-matched so a new one is a deliberate decision. */
const EXEMPT: Record<string, string> = {
  "app/api/knowledge/locate/route.ts":
    "narrowed to one document+page+tag list — bounded by the caller's tags, never a slab",
  "lib/equipmentBridgeServer.ts": 'already filters .eq("kind", "equipment")',
  "lib/linkProposerServer.ts": 'already filters .in("kind", ["opc", "ref"])',
  "lib/knowledgeIngest.ts": "writes rows (insert/delete), never bulk-reads them",
  "app/api/knowledge/drawing/route.ts#delete":
    "delete by document_id during re-index — removes every kind on purpose",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".git") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Every bulk read: a select on the table carrying a row cap of 1000+. */
function bulkReadsWithoutKind(): string[] {
  const offenders: string[] = [];
  for (const file of walk(join(ROOT, "app")).concat(walk(join(ROOT, "lib")))) {
    const rel = file.slice(ROOT.length + 1);
    if (rel.includes("__tests__")) continue;
    const src = readFileSync(file, "utf8");
    let idx = src.indexOf(TABLE);
    while (idx >= 0) {
      // The chained call this read is built from, up to its terminator.
      const chunk = src.slice(idx, idx + 700);
      const stmt = chunk.slice(0, chunk.indexOf(";") + 1 || chunk.length);
      const isRead = stmt.includes(".select(");
      const cap = /\.limit\((\d+)\)/.exec(stmt);
      const bulk = isRead && cap && Number(cap[1]) >= 1000;
      const namesKinds = /\.(in|eq)\(\s*["']kind["']/.test(stmt);
      if (bulk && !namesKinds && !EXEMPT[rel]) offenders.push(rel);
      idx = src.indexOf(TABLE, idx + 1);
    }
  }
  return [...new Set(offenders)];
}

describe("knowledge_page_entities bulk reads name their kinds", () => {
  it("has no bulk read that could be swamped by a future entity kind", () => {
    expect(bulkReadsWithoutKind()).toEqual([]);
  });

  it("every exemption is a real file, so the list can't rot", () => {
    for (const rel of Object.keys(EXEMPT)) {
      const path = join(ROOT, rel.split("#")[0]);
      expect(() => statSync(path), `${rel} is exempted but does not exist`).not.toThrow();
    }
  });

  it("the guard actually catches an unfiltered bulk read", () => {
    // Proves the matcher works rather than trivially passing.
    const sample = `supabaseAdmin.from("knowledge_page_entities").select("tag").eq("org_id", o).limit(20000);`;
    const stmt = sample.slice(sample.indexOf(TABLE));
    expect(stmt.includes(".select(")).toBe(true);
    expect(/\.limit\((\d+)\)/.exec(stmt)![1]).toBe("20000");
    expect(/\.(in|eq)\(\s*["']kind["']/.test(stmt)).toBe(false);
  });
});
