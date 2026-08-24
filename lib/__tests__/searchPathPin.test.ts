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

// Comment-stripped censusing: a `--` comment mentioning a rollback DROP, or a
// comment inside an argument list, must not shape the census. (Stripping
// inside dollar-quoted bodies is harmless for the header patterns scanned.)
const stripSqlComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");

// Arity counts TOP-LEVEL commas only, so `numeric(10,2)` or a parenthesized
// DEFAULT expression cannot inflate the count.
const arityOf = (args: string) => {
  const s = args.trim();
  if (!s) return 0;
  let depth = 0;
  let count = 1;
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
};

type FnState = { file: string; order: number; definer: boolean; pinned: boolean; dropped: boolean };

function census(): Map<string, FnState> {
  const final = new Map<string, FnState>();
  // Argument capture allows one level of nested parens (type modifiers,
  // defaults); the header runs to the first dollar-quote opener, tagged
  // ($fn$) or plain ($$).
  const createRe =
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(((?:[^()]|\([^()]*\))*)\)([\s\S]*?)\$\w*\$/gi;
  const dropRe = /DROP\s+FUNCTION\s+IF\s+EXISTS\s+(?:public\.)?(\w+)\s*\(((?:[^()]|\([^()]*\))*)\)/gi;
  migrationFiles().forEach((file, order) => {
    const txt = stripSqlComments(readFileSync(file, "utf8"));
    // CREATE and DROP statements are applied in their TEXTUAL order within
    // the file — SQL executes top to bottom, so the standard
    // `DROP FUNCTION IF EXISTS f(...); CREATE FUNCTION f(...)` re-creation
    // pattern leaves f LIVE, and a trailing drop leaves it dropped.
    type Ev =
      | { at: number; kind: "create"; key: string; header: string }
      | { at: number; kind: "drop"; key: string };
    const events: Ev[] = [];
    for (const m of txt.matchAll(createRe)) {
      events.push({ at: m.index ?? 0, kind: "create", key: `${m[1]}/${arityOf(m[2])}`, header: m[3] });
    }
    for (const d of txt.matchAll(dropRe)) {
      events.push({ at: d.index ?? 0, kind: "drop", key: `${d[1]}/${arityOf(d[2])}` });
    }
    events.sort((a, b) => a.at - b.at);
    for (const ev of events) {
      if (ev.kind === "create") {
        final.set(ev.key, {
          file,
          order,
          definer: /SECURITY\s+DEFINER/i.test(ev.header),
          pinned: /search_path/i.test(ev.header),
          dropped: false,
        });
      } else {
        const prev = final.get(ev.key);
        if (prev) prev.dropped = true;
      }
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

  it("every signature the ALTER migration pins pairs with a censused function", () => {
    // If a 20261020 signature stops matching any censused key, the allowlist
    // and the census have drifted apart — the exemption at line one of test 1
    // would then exempt NOTHING while appearing to, so the drift must be loud.
    const keys = new Set(census().keys());
    const unmatched = [...alterPinned()].filter((k) => !keys.has(k));
    expect(unmatched, `20261020 signatures with no censused counterpart:\n${unmatched.join("\n")}`).toEqual([]);
  });

  it("census parses the standard drop-then-recreate pattern as LIVE", () => {
    // publish_revision is re-created by 20261019 via DROP + CREATE in one
    // file; the census must key its 11 real parameters (the arg list carries
    // a parenthesized comment that a naive parser truncates on) and report it
    // live and pinned.
    const final = census();
    const st = final.get("publish_revision/11");
    expect(st).toBeDefined();
    expect(st!.dropped).toBe(false);
    expect(st!.pinned).toBe(true);
  });
});
