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
//
// The ALTER exemption is ORDER-AWARE (admin-and-org ORG-6, Round G): CREATE
// OR REPLACE resets every attribute the new statement does not name, the
// `SET search_path` clause included, so 20261020's ALTER pins only a
// definition that already existed when it ran. A function on its list that a
// LATER migration re-creates without the clause is unpinned live, and fails
// here. (Before this rule the exemption ignored the order, and such a
// re-creation passed.)

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

/** `extra` appends synthetic migration text after the real sequence — the
 *  self-checks below use it to prove the rules catch what they claim. */
function census(extra: Array<{ file: string; sql: string }> = []): Map<string, FnState> {
  const final = new Map<string, FnState>();
  // Argument capture allows one level of nested parens (type modifiers,
  // defaults); the header runs to the first dollar-quote opener, tagged
  // ($fn$) or plain ($$).
  const createRe =
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(((?:[^()]|\([^()]*\))*)\)([\s\S]*?)\$\w*\$/gi;
  const dropRe = /DROP\s+FUNCTION\s+IF\s+EXISTS\s+(?:public\.)?(\w+)\s*\(((?:[^()]|\([^()]*\))*)\)/gi;
  // A static `ALTER FUNCTION f(...) SET search_path ...` pins whatever
  // definition is live when it runs (20261020's dynamic list is alterPinned).
  const alterRe = /ALTER\s+FUNCTION\s+(?:public\.)?(\w+)\s*\(((?:[^()]|\([^()]*\))*)\)\s+SET\s+search_path/gi;
  const sources = [...migrationFiles().map((file) => ({ file, sql: readFileSync(file, "utf8") })), ...extra];
  sources.forEach(({ file, sql }, order) => {
    const txt = stripSqlComments(sql);
    // CREATE and DROP statements are applied in their TEXTUAL order within
    // the file — SQL executes top to bottom, so the standard
    // `DROP FUNCTION IF EXISTS f(...); CREATE FUNCTION f(...)` re-creation
    // pattern leaves f LIVE, and a trailing drop leaves it dropped.
    type Ev =
      | { at: number; kind: "create"; key: string; header: string }
      | { at: number; kind: "drop" | "alter"; key: string };
    const events: Ev[] = [];
    for (const m of txt.matchAll(createRe)) {
      events.push({ at: m.index ?? 0, kind: "create", key: `${m[1]}/${arityOf(m[2])}`, header: m[3] });
    }
    for (const d of txt.matchAll(dropRe)) {
      events.push({ at: d.index ?? 0, kind: "drop", key: `${d[1]}/${arityOf(d[2])}` });
    }
    for (const a of txt.matchAll(alterRe)) {
      events.push({ at: a.index ?? 0, kind: "alter", key: `${a[1]}/${arityOf(a[2])}` });
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
      } else if (ev.kind === "alter") {
        const prev = final.get(ev.key);
        if (prev && !prev.dropped) prev.pinned = true;
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

/** Where 20261020 sits in the replayed sequence: its ALTER pins only the
 *  definitions that precede it. */
function alterOrder(): number {
  return migrationFiles().findIndex((f) => f.endsWith("20261020_pin_search_path.sql"));
}

/** Live SECURITY DEFINER functions with no search_path pin: unpinned at their
 *  final CREATE (and by no later static ALTER), and either missing from
 *  20261020's list or (re-)created after 20261020 ran. */
function unpinnedDefiners(final: Map<string, FnState>): string[] {
  const pinnedByAlter = alterPinned();
  const at = alterOrder();
  const out: string[] = [];
  for (const [key, st] of final) {
    if (st.dropped || !st.definer || st.pinned) continue;
    if (pinnedByAlter.has(key) && st.order < at) continue;
    const reset = pinnedByAlter.has(key) ? " — re-created after 20261020, so its ALTER pin was reset" : "";
    out.push(`${key}  (final definition: ${st.file.replace(root + "/", "")}${reset})`);
  }
  return out;
}

describe("SECURITY DEFINER functions pin search_path (DB-6)", () => {
  it("every live definer function is pinned at creation or by 20261020_pin_search_path.sql", () => {
    const violations = unpinnedDefiners(census());
    expect(violations, `SECURITY DEFINER functions without SET search_path:\n${violations.join("\n")}\nPin it in the CREATE (SET search_path = public), or ALTER FUNCTION ... SET search_path = public in a migration after its final CREATE. 20261020 has already run: adding a signature to its list pins nothing.`).toEqual([]);
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
    // publish_revision is re-created via DROP + CREATE in one file — first by
    // 20261019 (11 real parameters; the arg list carries a parenthesized
    // comment that a naive parser truncates on), then by 20261130 (DCK-8:
    // the 11-argument form dropped, the 12-argument form with
    // p_override_reason created). The census must report the new form live
    // and pinned, and the old one dropped.
    const final = census();
    const st = final.get("publish_revision/12");
    expect(st).toBeDefined();
    expect(st!.dropped).toBe(false);
    expect(st!.pinned).toBe(true);
    expect(final.get("publish_revision/11")?.dropped).toBe(true);
  });
});

describe("the 20261020 exemption is order-aware (admin-and-org ORG-6 done-when 2)", () => {
  const recreate = (pin: boolean) => [{
    file: "zz_synthetic_after_20261020.sql",
    sql: `CREATE OR REPLACE FUNCTION is_org_controller(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER${pin ? " SET search_path = public" : ""} AS $$
  SELECT true;
$$;`,
  }];

  it("20261020 is found in the replayed sequence, so the order rule cannot silently disable itself", () => {
    expect(alterOrder()).toBeGreaterThan(0);
    // The probe below re-creates a function on 20261020's list (on HEAD its
    // final definition, 20260814, precedes 20261020 and the ALTER pins it).
    expect(alterPinned().has("is_org_controller/1")).toBe(true);
  });

  it("re-creating a 20261020-listed function after it ran, without the clause, is a violation", () => {
    expect(unpinnedDefiners(census(recreate(false))).some((v) => v.startsWith("is_org_controller/1 "))).toBe(true);
  });

  it("the same re-creation with SET search_path = public, or followed by a static ALTER, is not", () => {
    expect(unpinnedDefiners(census(recreate(true)))).toEqual([]);
    const altered = [...recreate(false), { file: "zz_synthetic_alter.sql", sql: "ALTER FUNCTION is_org_controller(uuid) SET search_path = public;" }];
    expect(unpinnedDefiners(census(altered))).toEqual([]);
  });
});

describe("ORG-6 done-when 1 — the org-authority helpers it names", () => {
  // The finding lists twelve. Eleven are SECURITY DEFINER (node_visible at
  // both live arities). acl_subject_in_bucket is not (20260708:26, `LANGUAGE
  // sql STABLE AS $$`), so neither 20261020 nor this lint ever covered it.
  const DEFINERS = [
    "my_org_ids/0", "my_team_ids/0", "is_org_admin/1", "is_org_controller/1", "is_org_admin_or_manager/1",
    "node_visible/3", "node_visible/6", "doc_is_visible/1", "my_project_ids/0", "can_manage_node/2",
    "is_org_assign_drafters/1", "next_ticket_number/2",
  ];

  it("every SECURITY DEFINER helper it names is live and pinned — at creation, or by 20261020 over a definition that precedes it", () => {
    const final = census();
    const unpinned = new Set(unpinnedDefiners(final).map((v) => v.split(" ")[0]));
    for (const key of DEFINERS) {
      const st = final.get(key);
      expect(st, key).toBeDefined();
      expect(st!.dropped, key).toBe(false);
      expect(st!.definer, key).toBe(true);
      expect(unpinned.has(key), key).toBe(false);
    }
  });

  // NOT holding at HEAD: the twelfth carries no SET search_path. It is a
  // SECURITY INVOKER function over its own jsonb / text[] arguments (no
  // relation to shadow), reached only from node_visible, whose own pin is in
  // force while it runs, so this is the letter of done-when 1, not an open
  // path. Owner: admin-and-org P8 (one `ALTER FUNCTION
  // acl_subject_in_bucket(jsonb, text, text, text[]) SET search_path = public`
  // in its ORG-13 migration). Flip to `it` when it lands.
  it.fails("acl_subject_in_bucket carries SET search_path = public (ORG-6 residual, owner A&O P8)", () => {
    const st = census().get("acl_subject_in_bucket/4");
    expect(st?.dropped).toBe(false);
    expect(st?.pinned).toBe(true);
  });
});
