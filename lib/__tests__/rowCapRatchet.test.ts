// The database API returns at most 1,000 rows per request unless the
// project's "Max rows" setting is raised — and says nothing when it stops.
// `.limit(5000)` reads like "up to 5,000" and silently means 1,000: that is
// how a 1,134-document library showed "1000" and drawings past the cut were
// re-read for nothing. Big reads page with fetchAllRows (lib/fetchAllRows).
//
// This is a RATCHET: the existing count may only go down. A new
// `.limit(N)` above 1,000 fails here — page it instead.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["app", "lib", "components"];
const BIG_LIMIT = /\.limit\(\s*(\d+)\s*\)/g;
const BASELINE = 71;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "__tests__") continue;
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("no read silently cut at 1,000 rows", () => {
  it(`reads asking for more than 1,000 rows at once stay at or below ${BASELINE} (page new ones with fetchAllRows)`, () => {
    const hits: string[] = [];
    for (const root of ROOTS) for (const f of files(root)) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(BIG_LIMIT)) if (Number(m[1]) > 1000) hits.push(`${f}: ${m[0]}`);
    }
    expect(hits.length, `New .limit(>1000) reads:\n${hits.join("\n")}`).toBeLessThanOrEqual(BASELINE);
  });
});
