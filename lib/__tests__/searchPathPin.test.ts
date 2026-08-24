// SECURITY DEFINER search_path lint (DB-6).
//
// A SECURITY DEFINER function that does not pin search_path resolves
// unqualified table names against the CALLER's search_path — the classic
// definer-function shadowing hole. The migration set pins some functions at
// creation and pins the historical remainder via ALTER FUNCTION in
// 20261020_pin_search_path.sql. This test replays the whole migration set and
// fails when any function's FINAL definition is SECURITY DEFINER, unpinned,
// and not covered by the ALTER migration — so a new function cannot ship
// unpinned without failing CI.
//
// Census rules (the two traps DB-6 documents):
//   * later CREATE [OR REPLACE] of the same (name, arity) supersedes earlier;
//   * a changed arity is a NEW function, not a replacement — both live unless
//     the old signature is DROPped explicitly.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function migrationFiles(): string[] {
  const dir = join(root, "supabase", "migrations");
  const files = readdirSync(dir)
    .filter((f) => /^\d{8}/.test(f) && f.endsWith(".sql"))
    .sort()
    .map((f) => join(dir, f));
  // schema.sql is the pre-migration baseline
  return [join(root, "supabase", "schema.sql"), ...files];
}

const arityOf = (args: string) =>
  args.trim() === "" ? 0 : args.split(",").filter((s) => s.trim()).length;

type FnState = { file: string; order: number; definer: boolean; pinned: boolean; dropped: boolean };

function census(): Map<string, FnState> {
  const final = new Map<string, FnState>();
  const createRe =
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(([^)]*)\)([\s\S]*?)\$\$/gi;
  const dropRe = /DROP\s+FUNCTION\s+IF\s+EXISTS\s+(?:public\.)?(\w+)\s*\(([^)]*)\)/gi;
  migrationFiles().forEach((file, order) => {
    const txt = readFileSync(file, "utf8");
    for (const m of txt.matchAll(createRe)) {
      const key = `${m[1]}/${arityOf(m[2])}`;
      const header = m[3];
      final.set(key, {
        file,
        order,
        definer: /SECURITY\s+DEFINER/i.test(header),
        pinned: /search_path/i.test(header),
        dropped: false,
      });
    }
    for (const d of txt.matchAll(dropRe)) {
      const key = `${d[1]}/${arityOf(d[2])}`;
      const prev = final.get(key);
      if (prev && prev.order <= order) prev.dropped = true;
    }
  });
  return final;
}

/** Signatures pinned after the fact by the ALTER migration — parsed from the
 *  migration itself so the allowlist can never drift from what it applies. */
function alterPinned(): Set<string> {
  const txt = readFileSync(
    join(root, "supabase", "migrations", "20261020_pin_search_path.sql"),
    "utf8",
  );
  const out = new Set<string>();
  for (const m of txt.matchAll(/'(\w+)\(([^)]*)\)'/g)) {
    out.add(`${m[1]}/${arityOf(m[2])}`);
  }
  return out;
}

describe("SECURITY DEFINER functions pin search_path (DB-6)", () => {
  it("every live definer function is pinned at creation or by 20261020_pin_search_path.sql", () => {
    const pinnedByAlter = alterPinned();
    const violations: string[] = [];
    for (const [key, st] of census()) {
      if (st.dropped || !st.definer || st.pinned) continue;
      if (!pinnedByAlter.has(key)) {
        violations.push(`${key}  (final definition: ${st.file.replace(root + "/", "")})`);
      }
    }
    expect(violations, `SECURITY DEFINER functions without SET search_path:\n${violations.join("\n")}\nPin it in the CREATE (SET search_path = public) or add the signature to 20261020_pin_search_path.sql.`).toEqual([]);
  });

  it("the ALTER migration's legacy publish_revision entries stay defensive, not load-bearing", () => {
    // The CURRENT publish_revision (created by 20261019) must be pinned at
    // creation — if this fails, someone re-created it without the pin.
    const final = census();
    const current = [...final.entries()].filter(([k, st]) => k.startsWith("publish_revision/") && !st.dropped);
    expect(current.length).toBeGreaterThan(0);
    for (const [, st] of current) expect(st.pinned).toBe(true);
  });
});
