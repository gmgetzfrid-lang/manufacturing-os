// notifications Round G — N5 DISPATCH-AND-WRITE-HOLES, the database half.
//
//   20261160 (migration A) — the write rails: enforce_notification_insert()
//     and the kind allowlist notification_kinds() (OS-1, DELIV-6, DEC-86).
//   20261161 (migration B) — the read scope and the read_at-only write:
//     the three own-row policies gain an active-membership predicate and a
//     tombstone, UPDATE pins every column but read_at, DELETE takes only read
//     non-compliance rows, and revoke_member tombstones on REMOVE (NEDGE-7,
//     DELIV-13).
//
// There is no database in this suite. Three kinds of pin:
//   1. shape — the migration text, comment-stripped where a comment could
//      fake a match; each re-created function and policy is found by
//      SCANNING supabase/migrations for its newest earlier definition and
//      diffed against it (only the named lines / terms may differ);
//   2. parity — notification_kinds()'s VALUES equal lib/notificationKinds.ts
//      KIND_META, kind for kind, compliance flag for compliance flag;
//   3. models — of the insert caps (OS-1: the review's resource_id loop, the
//      org-wide loop, a sustained hour, and the legitimate fan-outs) and of
//      the three policies (removed / suspended / re-added / multi-org), each
//      number and predicate pinned to the SQL text — and a census of the
//      app's own notification writes, so neither rail breaks a client path.
// The SQL itself was exercised on a throwaway PostgreSQL 16 (recorded in the
// NEDGE-7 / OS-1 / DELIV-6 / DELIV-13 resolution blocks).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";
import ts from "typescript";
import { KIND_META } from "@/lib/notificationKinds";

const ROOT = process.cwd();
const DIR = join(ROOT, "supabase", "migrations");
const FILES = readdirSync(DIR).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const A_FILE = "20261160_notif_roundG_write_rails.sql";
const B_FILE = "20261161_notif_roundG_read_scope.sql";
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const A = read(A_FILE);
const B = read(B_FILE);
const strip = (sql: string) => sql.replace(/--[^\n]*/g, "");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b + to.length);
}
function lineDiff(a: string, b: string) {
  const A1 = a.split("\n"), B1 = b.split("\n");
  return { onlyInA: A1.filter((l) => !B1.includes(l)), onlyInB: B1.filter((l) => !A1.includes(l)) };
}
/** Every `CREATE OR REPLACE FUNCTION name(` body in the numbered sequence, in
 *  migration order, as [file, text-from-CREATE-to-its-closing-dollar-quote;]. */
function definitionsOf(name: string, before?: string): Array<[string, string]> {
  return definitionsIn(FILES.filter((f) => !before || f < before).map((f): [string, string] => [f, read(f)]), name);
}
/** The same over any [file, text] list, in the order given. The body ends at the dollar quote that
 *  opened it, whatever its tag (`$$`, `$fn$`), so a re-creation quoted differently is still read whole. */
function definitionsIn(sources: Array<[string, string]>, name: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${name}\\s*\\(`, "g");
  for (const [f, s] of sources) {
    for (const m of s.matchAll(re)) {
      // skip a CREATE inside a -- comment line
      const lineStart = s.lastIndexOf("\n", m.index!) + 1;
      if (/^\s*--/.test(s.slice(lineStart, m.index!))) continue;
      const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/g;
      open.lastIndex = m.index!;
      const tag = open.exec(s)!;
      const end = s.indexOf(tag[0], tag.index + tag[0].length);
      const stop = end + tag[0].length + (s[end + tag[0].length] === ";" ? 1 : 0);
      out.push([f, s.slice(m.index!, stop)]);
    }
  }
  return out;
}

/** Every string a `link` property of an object literal can take, by its
 *  opening characters (TypeScript AST). `link: <expr>` and the shorthand
 *  `{ link }` are both judged. A literal / template must start with one '/';
 *  a conditional, `||` / `??` and `+` are judged branch by branch (the left
 *  side of a `+`); an identifier is resolved to its declaration in scope — a
 *  `const` / `let` initialiser is judged in turn, a parameter or a
 *  destructured name is a pass-through from a typed caller; a member access
 *  ending in `.link` (input.link, n.link, d.link) is a pass-through too; a
 *  member of a `const` object literal in scope (`const L = { a: "/x" } as
 *  const; … L.a`) is that property's initialiser, judged in turn.
 *  Anything else — a call, an unresolved name, another member — is an
 *  offender: the census cannot see what it yields. */
function linkStarts(src: string, file: string): { seen: number; shorthand: number; offenders: string[] } {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = { seen: 0, shorthand: 0, offenders: [] as string[] };
  type Decl = ts.VariableDeclaration | ts.ParameterDeclaration | ts.BindingElement;
  const bindsName = (b: ts.BindingName, name: string): boolean =>
    ts.isIdentifier(b) ? b.text === name : b.elements.some((e) => !ts.isOmittedExpression(e) && bindsName(e.name, name));
  const findBinding = (b: ts.BindingName, name: string): ts.BindingElement | undefined => {
    if (ts.isIdentifier(b)) return undefined;
    for (const e of b.elements) {
      if (ts.isOmittedExpression(e)) continue;
      if (ts.isIdentifier(e.name) && e.name.text === name) return e;
      const inner = findBinding(e.name, name);
      if (inner) return inner;
    }
    return undefined;
  };
  /** The declaration `name` refers to at `at`: the nearest enclosing scope's. */
  const resolve = (name: string, at: ts.Node): Decl | undefined => {
    for (let n: ts.Node | undefined = at.parent; n; n = n.parent) {
      if (ts.isFunctionLike(n)) {
        for (const p of n.parameters) {
          if (ts.isIdentifier(p.name) && p.name.text === name) return p;
          const b = findBinding(p.name, name);
          if (b) return b;
        }
      }
      const statements = ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)
        ? n.statements : undefined;
      const lists: ts.VariableDeclarationList[] = [];
      for (const st of statements ?? []) if (ts.isVariableStatement(st) && st.pos < at.pos) lists.push(st.declarationList);
      if ((ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isForStatement(n)) && n.initializer && ts.isVariableDeclarationList(n.initializer)) lists.push(n.initializer);
      for (const list of lists.reverse()) {
        for (const d of list.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name) return d;
          if (bindsName(d.name, name)) return findBinding(d.name, name);
        }
      }
    }
    return undefined;
  };
  // each value a link can take: a literal's text, "pass" for a typed pass-through, "?" for unseen
  const starts = (e: ts.Expression, acc: string[], depth = 0): void => {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return starts(e.expression, acc, depth);
    if (ts.isConditionalExpression(e)) { starts(e.whenTrue, acc, depth); starts(e.whenFalse, acc, depth); return; }
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind)) {
      starts(e.left, acc, depth); starts(e.right, acc, depth); return;
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return starts(e.left, acc, depth);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) { acc.push(e.text); return; }
    if (ts.isTemplateExpression(e)) { acc.push(e.head.text || "${"); return; }
    if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === "undefined")) return;
    if (ts.isPropertyAccessExpression(e) && e.name.text === "link") { acc.push("pass"); return; }
    if (ts.isIdentifier(e) && depth < 5) {
      const d = resolve(e.text, e);
      if (d && (ts.isParameter(d) || ts.isBindingElement(d))) { acc.push("pass"); return; }
      if (d && ts.isVariableDeclaration(d) && d.initializer) return starts(d.initializer, acc, depth + 1);
    }
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && depth < 5) {
      const d = resolve(e.expression.text, e);
      let init = d && ts.isVariableDeclaration(d) && ts.isVariableDeclarationList(d.parent) && (d.parent.flags & ts.NodeFlags.Const) ? d.initializer : undefined;
      while (init && (ts.isAsExpression(init) || ts.isParenthesizedExpression(init) || ts.isSatisfiesExpression(init))) init = init.expression;
      const prop = init && ts.isObjectLiteralExpression(init)
        ? init.properties.find((q): q is ts.PropertyAssignment => ts.isPropertyAssignment(q) && (ts.isIdentifier(q.name) || ts.isStringLiteral(q.name)) && q.name.text === e.name.text)
        : undefined;
      if (prop) return starts(prop.initializer, acc, depth + 1);
    }
    acc.push("?");
  };
  const judge = (initializer: ts.Expression, shown: string) => {
    const vals: string[] = [];
    starts(initializer, vals);
    out.seen += vals.length;
    for (const l of vals) {
      if (l === "pass" || l === "") continue;
      if (l === "?" || !(l[0] === "/" && l[1] !== "/" && l[1] !== "\\")) out.offenders.push(`${shown.slice(0, 80)}${l === "?" ? " (unresolved)" : ""}`);
    }
  };
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "link" && ts.isObjectLiteralExpression(n.parent)) {
      judge(n.initializer, `link: ${n.initializer.getText(sf)}`);
    } else if (ts.isShorthandPropertyAssignment(n) && n.name.text === "link") {
      out.shorthand++;
      judge(n.name, "{ link } (shorthand)");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ── the shared one-paste shape ──────────────────────────────────────────────
describe.each([[A_FILE, A], [B_FILE, B]])("%s — one paste for the SQL editor (DEC-30)", (_f, sql) => {
  const code = strip(sql);

  it("opens with a header, captures its inventory in a TEMP table BEFORE the transaction, and writes in exactly one BEGIN … COMMIT", () => {
    expect(sql.startsWith("-- ─")).toBe(true);
    expect(code.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(code.match(/^COMMIT;/gm)).toHaveLength(1);
    const temp = code.indexOf("CREATE TEMP TABLE");
    expect(temp).toBeGreaterThan(0);
    expect(temp).toBeLessThan(code.indexOf("BEGIN;"));
  });

  it("ends with ONE statement after COMMIT: a SELECT of (check, ok, n) rows — probes carry ok, inventory rows carry n", () => {
    const tail = code.slice(code.indexOf("COMMIT;") + "COMMIT;".length);
    // probe patterns quote "RETURN NEW;" etc. — split on the semicolons outside string literals
    const statements = tail.replace(/'(?:[^']|'')*'/g, "''").split(";").filter((s) => s.trim());
    expect(statements).toHaveLength(1);
    expect(tail).toMatch(/AS check,[\s\S]*?AS ok,\s*NULL::text AS n/);
    expect(tail).toMatch(/SELECT inventory, NULL::boolean, n FROM/);
  });

  it("the inventory is aggregate counts only — never a customer row", () => {
    const inv = code.slice(code.indexOf("CREATE TEMP TABLE"), code.indexOf("BEGIN;"));
    const branches = inv.split(/UNION ALL/);
    expect(branches.length).toBeGreaterThan(3);
    for (const b of branches) expect(b).toMatch(/SELECT COUNT\(|COUNT\(\*\)|COUNT\(DISTINCT/);
    expect(inv).not.toMatch(/SELECT \*|title|body|actor_name|email/i);
  });

  it("every SECURITY DEFINER function it creates pins search_path and revokes PUBLIC and anon in the same file (DRLS-16)", () => {
    const defs = [...code.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(([^)]*)\)\s*RETURNS[\s\S]*?AS \$\$/g)];
    expect(defs.length).toBeGreaterThan(0);
    for (const d of defs) {
      expect(d[0], d[1]).toMatch(/SET search_path = public/);
      if (/SECURITY DEFINER/.test(d[0])) {
        expect(code, d[1]).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${d[1]}\\([^)]*\\) FROM PUBLIC, anon`));
      }
    }
  });

  it("never touches notifications_org_insert (20261160's trigger is the insert rail; RLS still requires an active caller)", () => {
    expect(code).not.toMatch(/(?:DROP|CREATE|ALTER) POLICY (?:IF EXISTS )?notifications_org_insert/);
  });
});

// ── migration A ─────────────────────────────────────────────────────────────
describe("20261160 — notification_kinds(): the database's copy of the registry, pinned to KIND_META", () => {
  const newest = definitionsOf("notification_kinds").at(-1)!;
  const values = [...newest[1].matchAll(/\('(\w+)',\s*(true|false)\)/g)].map((m) => [m[1], m[2] === "true"] as const);

  it("the newest definition in the sequence is the one parity is checked against", () => {
    expect(newest[0] >= A_FILE).toBe(true);
    expect(newest[1]).toMatch(/RETURNS TABLE \(kind text, compliance boolean\)\s*LANGUAGE sql IMMUTABLE SET search_path = public/);
  });

  it("declares exactly Object.keys(KIND_META), in registry order, each once", () => {
    expect(values.map(([k]) => k), "a kind added to (or removed from) KIND_META needs a migration that re-creates notification_kinds() to match").toEqual(Object.keys(KIND_META));
    expect(new Set(values.map(([k]) => k)).size).toBe(values.length);
  });

  it("each kind's compliance flag is the registry's — the delete rail of 20261161 reads it", () => {
    for (const [k, c] of values) expect(c, k).toBe(KIND_META[k as keyof typeof KIND_META].compliance);
    const compliance = Object.values(KIND_META).filter((m) => m.compliance).length;
    expect(values.filter(([, c]) => c)).toHaveLength(compliance);
    // the paste that holds the newest definition states the same two numbers
    // in its own probe (20261160 for its 51; 20261181, N8, for 55 — each
    // re-create restates them)
    expect(read(newest[0])).toContain(`COUNT(*) = ${values.length} AND COUNT(DISTINCT kind) = ${values.length} AND COUNT(*) FILTER (WHERE compliance) = ${compliance}`);
    expect(A).toContain("COUNT(*) = 51 AND COUNT(DISTINCT kind) = 51 AND COUNT(*) FILTER (WHERE compliance) = 15");
  });

  it("is executable by authenticated and service_role only — never PUBLIC or anon", () => {
    expect(A).toMatch(/REVOKE ALL ON FUNCTION notification_kinds\(\) FROM PUBLIC, anon;/);
    expect(A).toMatch(/GRANT EXECUTE ON FUNCTION notification_kinds\(\) TO authenticated, service_role;/);
  });

  it("is a function, not a table: no CREATE TABLE (a table would need a backup decision in lib/exportTables.ts)", () => {
    expect(strip(A)).not.toMatch(/CREATE\s+TABLE\s+(?:IF NOT EXISTS\s+)?notification_kinds/i);
    expect(strip(B)).not.toMatch(/CREATE\s+TABLE/i);
  });
});

describe("20261160 — enforce_notification_insert(): the insert rails", () => {
  const fn = between(A, "CREATE OR REPLACE FUNCTION enforce_notification_insert()", "$$;");
  const body = fn.slice(fn.indexOf("BEGIN"));

  it("is a SECURITY DEFINER trigger function with search_path pinned, callable by no API role directly", () => {
    expect(fn).toMatch(/RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(A).toMatch(/REVOKE ALL ON FUNCTION enforce_notification_insert\(\) FROM PUBLIC, anon, authenticated;/);
    expect(A).not.toMatch(/GRANT EXECUTE ON FUNCTION enforce_notification_insert/);
  });

  it("REGRESSION: its FIRST statement returns NEW untouched for the service role / cron (no uid) — every server producer writes as before", () => {
    expect(fn).toMatch(/v_uid uuid := auth\.uid\(\);/);
    const first = strip(body).replace(/^BEGIN\s*/, "").trim();
    expect(first.startsWith("IF v_uid IS NULL THEN\n    RETURN NEW;\n  END IF;")).toBe(true);
  });

  it("runs its rules in order: caller's membership → actor + date → kind (declared, not server-only) → link → watermark keys → recipient → resource key → caps (counted unlocked, re-counted under the actor's lock near a cap)", () => {
    const at = (s: string) => { const i = body.indexOf(s); expect(i, s).toBeGreaterThan(0); return i; };
    const order = [
      at("m.org_id = NEW.org_id AND m.uid = v_uid AND m.status = 'active'"),
      at("IF NEW.actor_user_id IS NULL THEN"),
      at("NEW.created_at := now();"),
      at("IF NOT EXISTS (SELECT 1 FROM notification_kinds() k WHERE k.kind = NEW.kind) THEN"),
      at("IF NEW.kind IN ("),
      at("IF NEW.link IS NOT NULL AND NEW.link <> ''"),
      at("IF NEW.metadata ?| ARRAY["),
      at("m.org_id = NEW.org_id AND m.uid = NEW.user_id AND m.status = 'active'"),
      at("v_res_ok := CASE NEW.resource_type"),
      at("v_lock := coalesce(current_setting('notif_rail.wrote_row', true), '') = 'y';"),
      at("PERFORM pg_advisory_xact_lock("),
      at("IF v_same >= 60 THEN"),
      at("IF v_any >= 600 THEN"),
      at("IF v_hour >= 1200 THEN"),
      at("IF v_actor >= 3000 THEN"),
      at("EXIT WHEN v_lock"),
    ];
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("REVIEW (cross-tenant oracle): the CALLER must be an active member of the row's org (42501) — checked right after the service role's return, before any definer read of the recipient's membership or of a resource", () => {
    expect(squash(body)).toContain(squash(`IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  -- 0. the writer is an active member of the row's org — before anything
  --    else of that org is read with this function's rights
  IF NOT EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = NEW.org_id AND m.uid = v_uid AND m.status = 'active') THEN
    RAISE EXCEPTION 'notifications: not a member of this workspace' USING ERRCODE = '42501';
  END IF;`));
    // the first definer read after the service role's return — so the outcome of an insert
    // naming another org (a skip, a cap, an RLS refusal) can no longer depend on that org's data
    const code = strip(body);
    const caller = code.indexOf("m.uid = v_uid AND m.status = 'active'");
    const reads = [...code.matchAll(/\bFROM (\w+)/g)].map((m) => ({ table: m[1], at: m.index! }));
    expect(reads[0]).toEqual({ table: "org_members", at: expect.any(Number) });
    expect(reads[0].at).toBeLessThan(caller);
    for (const r of reads.slice(1)) expect(r.at, r.table).toBeGreaterThan(caller);
    expect(code.indexOf("m.uid = NEW.user_id")).toBeGreaterThan(caller);
    for (const t of ["documents", "tickets", "projects", "libraries"]) expect(code.indexOf(`FROM ${t} r`), t).toBeGreaterThan(caller);
    // the same predicate as the insert policy that still runs after the trigger
    const policy = read("20260723_notifications_unify.sql");
    expect(policy).toMatch(/org_members\.org_id = notifications\.org_id\s+AND org_members\.uid = auth\.uid\(\)\s+AND org_members\.status = 'active'/);
  });

  it("DELIV-6 dw1/dw4: the actor is stamped when absent and refused (42501) when it is someone else", () => {
    expect(squash(body)).toContain(squash(`IF NEW.actor_user_id IS NULL THEN
    NEW.actor_user_id := v_uid;
  ELSIF NEW.actor_user_id <> v_uid THEN
    RAISE EXCEPTION 'notifications: a notification''s actor must be the signed-in member' USING ERRCODE = '42501';
  END IF;`));
  });

  it("DELIV-6 dw3: a link is NULL, empty, or one leading '/' — never '//', '/\\', a backslash, a control character or a scheme", () => {
    expect(squash(body)).toContain(squash(`AND NOT (left(NEW.link, 1) = '/' AND substr(NEW.link, 2, 1) NOT IN ('/', E'\\\\') AND strpos(NEW.link, E'\\\\') = 0 AND NEW.link !~ '[[:cntrl:]]') THEN`));
    // the same predicate, as JS, over the cases the PostgreSQL 16 run refused / admitted
    const ok = (l: string | null) => l === null || l === "" ||
      (l[0] === "/" && !["/", "\\"].includes(l[1] ?? "") && !l.includes("\\") && !/[\x00-\x1f\x7f]/.test(l));
    for (const bad of ["https://evil.example/login", "//evil.example", "/\\evil.example", "/\t/evil.example", "javascript:alert(1)", "documents/x"]) expect(ok(bad), bad).toBe(false);
    for (const good of [null, "", "/documents/l-1?doc=d-1", "/requests/7", "/checkouts", "/register?filter=unowned", "/"]) expect(ok(good), String(good)).toBe(true);
  });

  it("every link the app's notification producers write passes that predicate (each string a `link:` can take starts with '/')", () => {
    let seen = 0, shorthand = 0;
    const offenders: string[] = [];
    for (const f of sourceFiles()) {
      const src = readFileSync(f, "utf8");
      if (!/\b(?:notify|notifyMany|notifyChecked|emit)\(|from\(["']notifications["']\)/.test(src)) continue;
      const r = linkStarts(src, f);
      seen += r.seen;
      shorthand += r.shorthand;
      offenders.push(...r.offenders.map((o) => `${relative(ROOT, f)}: ${o}`));
    }
    expect(seen).toBeGreaterThan(20);
    // the producers that pass `{ link }` by shorthand (acknowledgments, reviewControl, accessRecert,
    // distributionAcks, activityThread, the orchestrator's tools) are judged through their `const link`
    expect(shorthand).toBeGreaterThanOrEqual(8);
    expect(offenders).toEqual([]);
    // the scanner is not vacuous: it flags each refused shape and passes the admitted ones
    const probe = linkStarts([
      'notify({ link: "https://evil.example" });',
      'emit({ link: x ? `//evil/${y}` : undefined });',
      'emit({ link: a ?? "javascript:alert(1)" });',
      'notify({ link: `/documents/${id}` });',
      'notify({ link: doc ? `/documents/${doc}?doc=${d}` : "/admin/holds" });',
      'notify({ link: input.link });',
    ].join("\n"), "probe.ts");
    expect(probe.offenders).toEqual([
      'link: "https://evil.example"',
      "link: x ? `//evil/${y}` : undefined",
      'link: a ?? "javascript:alert(1)" (unresolved)',   // `a` names nothing the census can see
      'link: a ?? "javascript:alert(1)"',
    ]);
    expect(probe.seen).toBe(8); // the conditional carries two literals; undefined is no link
    // REVIEW: the shorthand `{ link }` and a non-literal initialiser are judged too
    const byShorthand = linkStarts([
      'function a() { const link = `${publicOrigin()}/documents/x`; notify({ orgId, link, kind }); }',   // off-origin, by shorthand
      'function b() { const link = `/documents/${lib}?doc=${id}`; notify({ link }); }',                  // app-relative, by shorthand
      'function c() { const link = d ? `/documents/${d}` : "https://evil.example"; notify({ link }); }', // one bad branch
      'function d(link: string) { notify({ link }); }',                                                  // a typed parameter
      'function e({ link }: { link: string }) { notify({ link }); }',                                    // destructured
      'function f() { notify({ link }); }',                                                              // resolves to nothing
      'function g() { notify({ link: buildLink(x) }); }',                                                // a call: unseen
      'function h() { const target = "/requests/1"; notify({ link: target }); }',                        // an identifier, resolved
      'function i() { const link = "/x"; { const link = "//evil"; notify({ link }); } }',                // the nearest scope wins
    ].join("\n"), "probe2.ts");
    expect(byShorthand.offenders).toEqual([
      "{ link } (shorthand)",
      "{ link } (shorthand)",
      "{ link } (shorthand) (unresolved)",
      "link: buildLink(x) (unresolved)",
      "{ link } (shorthand)",
    ]);
    expect(byShorthand.seen).toBe(10);
    // a member of a `const` object literal is judged by that property (lib/exportAlerts.ts ALERT_LINKS);
    // a `let` object, a missing property or an unknown object stays unseen
    const byMember = linkStarts([
      'const L = { admin: "/admin/data-export", other: "/admin/audit", bad: "https://evil.example" } as const;',
      'function a(x: boolean) { notify({ link: x ? L.admin : L.other }); }',  // both resolve, both pass
      'function b() { notify({ link: L.bad }); }',                             // resolves to an off-origin literal
      'function c() { notify({ link: L.missing }); }',                         // no such property
      'let M = { a: "/x" };',
      'function d() { notify({ link: M.a }); }',                               // not a const: unseen
      'function e() { notify({ link: N.a }); }',                               // names nothing
    ].join("\n"), "probe3.ts");
    expect(byMember.offenders).toEqual([
      "link: L.bad",
      "link: L.missing (unresolved)",
      "link: M.a (unresolved)",
      "link: N.a (unresolved)",
    ]);
    expect(byMember.seen).toBe(6);
  });

  it("OS-1 dw3 / DELIV-6 dw2: an undeclared kind is refused (22023)", () => {
    expect(squash(body)).toContain(squash(`RAISE EXCEPTION 'notifications: unknown kind %', NEW.kind USING ERRCODE = '22023';`));
  });

  it("NEDGE-3 at the database: a recipient who is not an active member of the org is SKIPPED (RETURN NULL), never refused — one suspended watcher cannot sink a batch", () => {
    expect(squash(body)).toContain(squash(`IF NOT EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = NEW.org_id AND m.uid = NEW.user_id AND m.status = 'active') THEN
    RETURN NULL;
  END IF;`));
  });

  it("OS-1 dw4: per actor and recipient, the last minute (60 of one notice, 600 of anything) and the last hour (1,200); per actor, the last minute across every recipient (3,000)", () => {
    expect(squash(body)).toContain(squash(`SELECT COUNT(*) FILTER (WHERE n.created_at > now() - interval '1 minute' AND n.kind = NEW.kind
                            AND (NOT v_res_ok OR n.resource_id IS NOT DISTINCT FROM NEW.resource_id)),
         COUNT(*) FILTER (WHERE n.created_at > now() - interval '1 minute'),
         COUNT(*)
    INTO v_same, v_any, v_hour
    FROM notifications n
   WHERE n.actor_user_id = v_uid
     AND n.user_id = NEW.user_id
     AND n.created_at > now() - interval '1 hour';`));
    expect(squash(body)).toContain(squash(`SELECT COUNT(*) INTO v_actor
    FROM (SELECT 1 FROM notifications n
           WHERE n.actor_user_id = v_uid
             AND n.created_at > now() - interval '1 minute'
           LIMIT 3000) s;
  IF v_actor >= 3000 THEN`));
    // each cap answers with its own sentence
    for (const m of ["60 of the same notification to one person per minute", "600 notifications to one person per minute",
      "1200 notifications to one person per hour", "3000 notifications per minute from one member"]) {
      expect(body).toContain(`RAISE EXCEPTION 'notifications: rate limit — ${m}';`);
    }
    // and the indexes the counts ride
    expect(A).toMatch(/CREATE INDEX IF NOT EXISTS notifications_actor_recipient_idx\s+ON notifications \(actor_user_id, user_id, created_at DESC\)\s+WHERE actor_user_id IS NOT NULL;/);
    expect(A).toMatch(/CREATE INDEX IF NOT EXISTS notifications_actor_created_idx\s+ON notifications \(actor_user_id, created_at DESC\)\s+WHERE actor_user_id IS NOT NULL;/);
  });

  it("REVIEW (concurrency, fix 3): the counts are taken without a lock; a row near a cap — the same notice again this minute included — or a later row of one transaction, is counted again under the actor's lock", () => {
    const code = strip(body);
    const lock = "PERFORM pg_advisory_xact_lock(hashtextextended('notif-cap:' || v_uid::text, 0));";
    expect(squash(code)).toContain(squash(`v_lock := coalesce(current_setting('notif_rail.wrote_row', true), '') = 'y';
  PERFORM set_config('notif_rail.wrote_row', 'y', true);
  LOOP
    IF v_lock THEN
      ${lock}
    END IF;`));
    expect(squash(code)).toContain(squash(`EXIT WHEN v_lock
           OR (v_same = 0 AND v_any < 600 - 64 AND v_hour < 1200 - 64 AND v_actor < 3000 - 64);
    v_lock := true;
  END LOOP;

  RETURN NEW;`));
    expect(fn).toMatch(/v_lock boolean;/);
    // one lock call, transaction-scoped (never left held on a pooled connection), keyed on the actor alone
    expect(code.match(/pg_advisory/g)).toHaveLength(1);
    expect(code).not.toMatch(/pg_advisory_lock\(|pg_try_advisory|_shared\(/);
    // the "later row" mark is transaction-local: a session-level setting would follow the pooled
    // connection into the next member's request
    expect(code.match(/set_config\(/g)).toHaveLength(1);
    expect(code).toContain("set_config('notif_rail.wrote_row', 'y', true)");
    // a skipped row takes no lock and leaves no mark; the mark is read before it is set
    expect(code.indexOf("v_lock := coalesce(")).toBeGreaterThan(code.indexOf("RETURN NULL;"));
    expect(code.indexOf("v_lock := coalesce(")).toBeLessThan(code.indexOf("PERFORM set_config("));
    // both counts and all four refusals sit inside the loop, before its exit: a count already at its
    // cap is refused on the first, unlocked pass (a refusal never queues); a near one is re-counted
    const loopAt = code.indexOf("\n  LOOP"), exitAt = code.indexOf("EXIT WHEN v_lock"), endAt = code.indexOf("END LOOP;");
    expect(loopAt).toBeGreaterThan(code.indexOf("PERFORM set_config("));
    for (const t of [lock, "INTO v_same, v_any, v_hour", "IF v_same >= 60 THEN", "IF v_any >= 600 THEN", "IF v_hour >= 1200 THEN",
      "SELECT COUNT(*) INTO v_actor", "IF v_actor >= 3000 THEN"]) {
      expect(code.indexOf(t), t).toBeGreaterThan(loopAt);
      expect(code.indexOf(t), t).toBeLessThan(exitAt);
    }
    expect(code.indexOf(lock)).toBeLessThan(code.indexOf("INTO v_same, v_any, v_hour"));
    expect(code.indexOf("v_lock := true;")).toBeGreaterThan(exitAt);
    expect(code.indexOf("v_lock := true;")).toBeLessThan(endAt);
    // the probe the paste reports pins the same shape
    expect(A).toContain("an ordinary row takes no lock");
    expect(A).toContain("%EXIT WHEN v_lock%OR (v_same = 0 AND v_any < 600 - 64 AND v_hour < 1200 - 64 AND v_actor < 3000 - 64);%v_lock := true;%END LOOP;%");
  });

  it("OS-1 (review): resource_id is caller-written, so it keys the same-notice cap only when it names a row of resource_type in the row's org", () => {
    expect(squash(body)).toContain(squash(`IF NEW.resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_res := NEW.resource_id::uuid;
    v_res_ok := CASE NEW.resource_type
      WHEN 'document' THEN EXISTS (SELECT 1 FROM documents r WHERE r.id = v_res AND r.org_id = NEW.org_id)
      WHEN 'ticket'   THEN EXISTS (SELECT 1 FROM tickets r WHERE r.id = v_res AND r.org_id = NEW.org_id)
      WHEN 'project'  THEN EXISTS (SELECT 1 FROM projects r WHERE r.id = v_res AND r.org_id = NEW.org_id)
      WHEN 'library'  THEN EXISTS (SELECT 1 FROM libraries r WHERE r.id = v_res AND r.org_id = NEW.org_id)
      ELSE false
    END;
  END IF;`));
    // the cast runs only behind the uuid test, and the flag starts false
    expect(body.indexOf("NEW.resource_id::uuid")).toBeGreaterThan(body.indexOf("IF NEW.resource_id ~*"));
    expect(fn).toMatch(/v_res_ok boolean := false;/);
    // the verified types are emit()'s resource types (lib/notify/recipients.ts) — every one but 'asset',
    // which has no table here and is keyed on the kind alone
    const union = readFileSync(join(ROOT, "lib", "notify", "recipients.ts"), "utf8").match(/export type ResourceType = ([^;]+);/)![1];
    const emitTypes = [...union.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();
    const verified = [...body.matchAll(/WHEN '(\w+)'\s+THEN EXISTS/g)].map((m) => m[1]).sort();
    expect(verified).toEqual(["document", "library", "project", "ticket"]);
    expect(emitTypes.filter((t) => !verified.includes(t))).toEqual(["asset"]);
  });

  it("DELIV-6 / OS-1 (review): a browser's row is dated when it is written — a back-dated row would slip every cap's window, a future-dated one would pin itself to a bell", () => {
    expect(squash(body)).toContain(squash(`RAISE EXCEPTION 'notifications: a notification''s actor must be the signed-in member' USING ERRCODE = '42501';
  END IF;
  NEW.created_at := now();`));
    // after the service role's early return: a restore or a server producer keeps its own date
    expect(body.indexOf("NEW.created_at := now();")).toBeGreaterThan(body.indexOf("IF v_uid IS NULL THEN"));
  });

  it("is bound BEFORE INSERT FOR EACH ROW (idempotently re-created)", () => {
    expect(A).toMatch(/DROP TRIGGER IF EXISTS trg_notifications_enforce_insert ON notifications;\s*CREATE TRIGGER trg_notifications_enforce_insert\s+BEFORE INSERT ON notifications\s+FOR EACH ROW EXECUTE FUNCTION enforce_notification_insert\(\);/);
  });
});

// ── the server's dedupe watermarks (DELIV-13 dw3; review) ──────────────────
/** Source text with comments removed (a mention in a comment is not a use). */
const stripTs = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
/** [start, end) of a top-level function's text: from `function name(` to the next top-level export. */
function fnRange(src: string, name: string): [number, number] {
  const start = src.search(new RegExp(`(?:export )?(?:async )?function ${name}\\(`));
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\nexport ", start + 1);
  return [start, next < 0 ? src.length : next];
}
/** Every server read of notifications that decides whether to send, by file, in
 *  file order: the text that marks it, and the watermark that keeps a browser
 *  from forging the row it matches — a metadata key or a kind 20261160 refuses
 *  from a signed-in writer, or (`actorNull`, says why) a read that matches only
 *  rows with no actor, which 20261160 never lets a signed-in writer leave (it
 *  stamps the writer as the actor). `none`: not a dedupe (says why). */
const DEDUPE_READS: Record<string, Array<{ marks: string; keys?: string[]; kinds?: string[]; none?: string; actorNull?: string }>> = {
  // N8's review fix (PROD-2): past the per-org cap the request door tells each pool member
  // once that more requests are waiting — the read finds a member's open burst row
  "app/api/auth/request-access/route.ts": [{ marks: '.eq("resource_type", ACCESS_REQUEST_BURST_RESOURCE_TYPE)', actorNull: "the burst notice's dedupe matches only the server's own rows (actor_user_id IS NULL): a member's browser row is stamped with its writer, so it cannot silence the notice" }],
  "app/api/cron/maintenance/route.ts": [
    { marks: '.contains("metadata", { staleSessionId: row.id })', keys: ["staleSessionId"] },
    // not a dedupe, and not safe from forged rows either (third review fix): the read has no org filter
    // and no order and is cut at .limit(2000), so browser-legal compliance rows can push other lines out
    { marks: '.in("kind", COMPLIANCE_KINDS)', none: "not a dedupe: the compliance digest composes each recipient's list from compliance rows. Its read is cross-org, unordered and cut at 2,000 rows, so a member's browser-legal compliance rows (ack_requested, doc_superseded, review_requested), within the caps, can displace other people's and other tenants' lines — NEDGE-17, handed to N6" },
  ],
  "app/api/transmittal/route.ts": [{ marks: '.eq("kind", UNSTAMPABLE_NOTICE_KIND)', kinds: ["transmittal_unstampable"] }],
  // ackRequest (the nag's watermark) is written by browsers by design — a manual request or
  // re-nudge counts as the nag (the scan's own comment); only the escalation's key is server-only
  "lib/distributionAcks.ts": [{ marks: '.in("kind", ["ack_requested", "ack_overdue", "doc_superseded"])', keys: ["ackEscalation"] }],
  "lib/holds.ts": [{ marks: '.contains("metadata", { staleHoldId: h.id, staleFor })', keys: ["staleHoldId"] }],
  "lib/intakeRateLimit.ts": [{ marks: '.contains("metadata", { reviewHealthDay: input.day })', keys: ["reviewHealthDay"] }],
  "lib/storageAlerts.ts": [{ marks: '.eq("kind", "storage_alert")', kinds: ["storage_alert"] }],
  "lib/storageUsage.ts": [{ marks: '.eq("kind", alert.kind)', kinds: ["storage_platform_r2", "storage_platform_db"] }],
};
/** The recipient's own rows, read under RLS — the bell, the inbox count, the dashboard. */
// components/documents/EditOverlapBanner.tsx (notifications N7, TAX-8 — merged after this
// package's base; classified by the integrator at the N5 merge): a browser read of the
// viewer's OWN overlap_advisory rows (user_id = the signed-in member) to show "Heads-up
// sent". Not a server dedupe: 20261160 stamps actor_user_id as the writer, so a row it
// counts names a member of the overlap who did send one.
const BELL_READERS = ["components/dashboard/widgets.tsx", "components/documents/EditOverlapBanner.tsx", "lib/inAppNotifications.ts", "lib/inbox.ts"];
/** Who writes each server-only key / kind, and the function it is written in — called only by
 *  the maintenance cron on the service role (a route file is server-only by itself). */
const SERVER_WRITERS: Record<string, { file: string; fn?: string }> = {
  staleSessionId: { file: "app/api/cron/maintenance/route.ts" },
  staleHoldId: { file: "lib/holds.ts", fn: "scanStaleHolds" },
  reviewHealthDay: { file: "lib/intakeRateLimit.ts", fn: "nudgeReviewHealth" },
  ackEscalation: { file: "lib/distributionAcks.ts", fn: "scanDistributionAcks" },
  transmittal_unstampable: { file: "app/api/transmittal/route.ts" },
  storage_alert: { file: "lib/storageAlerts.ts", fn: "runStorageAlerts" },
  storage_platform_r2: { file: "lib/storageUsage.ts", fn: "runPlatformStorageAlerts" },
  storage_platform_db: { file: "lib/storageUsage.ts", fn: "runPlatformStorageAlerts" },
};

describe("20261160 — the server's dedupe watermarks: a browser can neither write one nor forge the row that silences an escalation (DELIV-13 dw3, review)", () => {
  const fn = between(A, "CREATE OR REPLACE FUNCTION enforce_notification_insert()", "$$;");
  const body = fn.slice(fn.indexOf("BEGIN"));
  const listed = (re: RegExp) => [...body.match(re)![1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  const kindsIn = listed(/IF NEW\.kind IN \(([^)]*)\) THEN/);
  const keysIn = listed(/IF NEW\.metadata \?\| ARRAY\[([^\]]*)\] THEN/);
  const reads = new Map<string, string[]>();   // file → the 400 characters after each .from("notifications").select(
  for (const f of sourceFiles()) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\.from\((["'])notifications\1\)\s*\.select\(/g)) {
      const rel = relative(ROOT, f);
      reads.set(rel, [...(reads.get(rel) ?? []), src.slice(m.index!, m.index! + 400)]);
    }
  }

  it("refuses (22023) a server-only kind and a metadata watermark key from a signed-in writer; the service role passes before either", () => {
    expect(squash(body)).toContain(squash(`IF NEW.kind IN ('transmittal_unstampable', 'storage_alert', 'storage_platform_r2', 'storage_platform_db') THEN
    RAISE EXCEPTION 'notifications: kind % is written only by the server', NEW.kind USING ERRCODE = '22023';
  END IF;`));
    expect(squash(body)).toContain(squash(`IF NEW.metadata ?| ARRAY['staleSessionId', 'staleHoldId', 'reviewHealthDay', 'ackEscalation'] THEN
    RAISE EXCEPTION 'notifications: the metadata carries a dedupe watermark only the server writes' USING ERRCODE = '22023';
  END IF;`));
    expect(body.indexOf("IF NEW.kind IN (")).toBeGreaterThan(body.indexOf("IF v_uid IS NULL THEN"));
    expect(body.indexOf("IF NEW.metadata ?| ARRAY[")).toBeGreaterThan(body.indexOf("IF v_uid IS NULL THEN"));
    // ackRequest and autoReleasedSessionId are written by browsers legitimately and stay allowed
    expect(keysIn).not.toContain("ackRequest");
    expect(keysIn).not.toContain("autoReleasedSessionId");
    // the paste's inventory counts existing rows that carry the same lists and name an actor
    const inv = strip(A).slice(strip(A).indexOf("CREATE TEMP TABLE"), strip(A).indexOf("BEGIN;"));
    expect(inv).toContain(`kind IN (${kindsIn.map((k) => `'${k}'`).join(", ")})`);
    expect(inv).toContain(`metadata ?| ARRAY[${keysIn.map((k) => `'${k}'`).join(", ")}]`);
  });

  it("RATCHET: every app read of notifications is a bell reader or a classified dedupe — a new server dedupe fails here until its watermark is refused from browsers", () => {
    const expected = [...BELL_READERS, ...Object.keys(DEDUPE_READS)].sort();
    expect([...reads.keys()].sort()).toEqual(expected);
    for (const [file, entries] of Object.entries(DEDUPE_READS)) {
      const found = reads.get(file)!;
      expect(found.length, `${file}: one entry per read`).toBe(entries.length);
      entries.forEach((e, i) => expect(found[i], `${file} read #${i + 1}`).toContain(e.marks));
    }
  });

  it("each dedupe keys on a watermark 20261160 refuses from browsers, and the SQL lists nothing no dedupe needs", () => {
    const keys = new Set<string>(), kinds = new Set<string>();
    for (const [file, entries] of Object.entries(DEDUPE_READS)) {
      const src = readFileSync(join(ROOT, file), "utf8");
      for (const [i, e] of entries.entries()) {
        if (e.none) { expect(e.keys ?? e.kinds).toBeUndefined(); continue; }
        if (e.actorNull) {
          expect(e.keys ?? e.kinds).toBeUndefined();
          // the read keys on "no actor", and 20261160 stamps every signed-in writer as the actor
          expect(reads.get(file)![i], `${file} read #${i + 1}`).toContain('.is("actor_user_id", null)');
          expect(squash(body)).toContain(squash("IF NEW.actor_user_id IS NULL THEN NEW.actor_user_id := v_uid;"));
          continue;
        }
        expect((e.keys?.length ?? 0) + (e.kinds?.length ?? 0), file).toBeGreaterThan(0);
        for (const k of e.keys ?? []) { expect(keysIn, `${file}: ${k}`).toContain(k); keys.add(k); }
        for (const k of e.kinds ?? []) { expect(kindsIn, `${file}: ${k}`).toContain(k); kinds.add(k); expect(src, `${file} writes ${k}`).toContain(`"${k}"`); }
      }
    }
    // the escalation dedupe reads its key from the rows it matched
    expect(readFileSync(join(ROOT, "lib/distributionAcks.ts"), "utf8")).toContain("if (meta.ackEscalation) recentlyEscalated.add(key);");
    expect([...keys].sort()).toEqual([...keysIn].sort());
    expect([...kinds].sort()).toEqual([...kindsIn].sort());
  });

  it("no browser path writes a listed key or kind: each is written in one server file, inside a function only the maintenance cron calls", () => {
    expect(Object.keys(SERVER_WRITERS).sort()).toEqual([...keysIn, ...kindsIn].sort());
    const files = sourceFiles().map((f) => [relative(ROOT, f), stripTs(readFileSync(f, "utf8"))] as const);
    for (const [token, w] of Object.entries(SERVER_WRITERS)) {
      const isKind = kindsIn.includes(token);
      // a key is written as an object property (`staleHoldId: h.id`); a kind as a string literal
      const pattern = isKind ? `["'\`]${token}["'\`]` : `\\b${token}\\s*:`;
      const re = new RegExp(pattern, "g");
      const where = files.filter(([, src]) => new RegExp(pattern).test(src)).map(([f]) => f);
      // the union type in lib/inAppNotifications.ts names every kind; it writes nothing
      expect(where.filter((f) => f !== "lib/inAppNotifications.ts"), token).toEqual([w.file]);
      const src = files.find(([f]) => f === w.file)![1];
      if (w.file.startsWith("app/api/")) continue;
      // in a lib file: every occurrence sits inside the named function, and only the cron calls it
      const [a, b] = fnRange(src, w.fn!);
      for (const m of src.matchAll(re)) expect(m.index! >= a && m.index! < b, `${token} outside ${w.fn}`).toBe(true);
      const callers = files.filter(([f, s2]) => f !== w.file && new RegExp(`\\b${w.fn}\\b`).test(s2)).map(([f]) => f);
      expect(callers, `${w.fn}'s callers`).toEqual(["app/api/cron/maintenance/route.ts"]);
    }
  });
});

// ── the caps, as a model (OS-1; each number and key pinned to the SQL) ──────
// A row the trigger has let through: who wrote it, to whom, its kind, its
// resource_id, whether that resource_id named a row of its type in the org,
// and when (seconds). The service role never reaches the caps. `attempt`
// judges rows one after another, as the trigger does for requests that
// arrive one at a time; how concurrent requests are counted (without the
// actor's lock far from a cap, under it near one) is modelled further down.
type Sent = { actor: string; to: string; kind: string; res: string | null; resOk: boolean; t: number };
const CAP = { same: 60, anyMinute: 600, anyHour: 1200, actorMinute: 3000 };
/** The four counts rule 7 takes for `row` at `now`, over the rows already committed. */
function countsFor(log: Sent[], row: Omit<Sent, "t">, now: number) {
  const mine = log.filter((r) => r.actor === row.actor);
  const toThemThisHour = mine.filter((r) => r.to === row.to && r.t > now - 3600);
  const toThemThisMinute = toThemThisHour.filter((r) => r.t > now - 60);
  return {
    same: toThemThisMinute.filter((r) => r.kind === row.kind && (!row.resOk || r.res === row.res)).length,
    any: toThemThisMinute.length,
    hour: toThemThisHour.length,
    actor: mine.filter((r) => r.t > now - 60).length,
  };
}
function capVerdict(log: Sent[], row: Omit<Sent, "t">, now: number): "ok" | "same" | "any" | "hour" | "actor" {
  const c = countsFor(log, row, now);
  if (c.same >= CAP.same) return "same";
  if (c.any >= CAP.anyMinute) return "any";
  if (c.hour >= CAP.anyHour) return "hour";
  if (c.actor >= CAP.actorMinute) return "actor";
  return "ok";
}
/** Try rows in order at time `now`; land the admitted ones. Answers how many landed and the first refusal. */
function attempt(log: Sent[], rows: Array<Omit<Sent, "t">>, now: number, stopAtFirst = true) {
  let landed = 0;
  let refused: string | null = null;
  for (const row of rows) {
    const v = capVerdict(log, row, now);
    if (v === "ok") { log.push({ ...row, t: now }); landed++; }
    else { refused ??= v; if (stopAtFirst) break; }
  }
  return { landed, refused };
}
const KINDS = Object.keys(KIND_META);
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

describe("OS-1 — the caps model: the review's loops are bounded, every legitimate fan-out lands", () => {
  const fn = between(A, "CREATE OR REPLACE FUNCTION enforce_notification_insert()", "$$;");

  it("the model's numbers, windows and keys are the SQL's", () => {
    expect(fn).toContain(`IF v_same >= ${CAP.same} THEN`);
    expect(fn).toContain(`IF v_any >= ${CAP.anyMinute} THEN`);
    expect(fn).toContain(`IF v_hour >= ${CAP.anyHour} THEN`);
    expect(fn).toContain(`IF v_actor >= ${CAP.actorMinute} THEN`);
    expect(fn).toContain(`LIMIT ${CAP.actorMinute}) s;`);
    expect(fn).toContain("AND (NOT v_res_ok OR n.resource_id IS NOT DISTINCT FROM NEW.resource_id)");
    expect(fn).toContain("AND n.created_at > now() - interval '1 hour';");
  });

  it("REVIEW: a loop minting a fresh resource_id per row to one victim lands 60 a minute, not 600", () => {
    const log: Sent[] = [];
    const rows = Array.from({ length: 700 }, (_, i) => ({ actor: "mallory", to: "victim", kind: "checkout_message", res: uuid(i), resOk: false }));
    expect(attempt(log, rows, 0)).toEqual({ landed: 60, refused: "same" });
  });

  it("cycling every declared kind meets the 600-a-minute cap to one person", () => {
    const log: Sent[] = [];
    const rows = Array.from({ length: 2000 }, (_, i) => ({ actor: "mallory", to: "victim", kind: KINDS[i % KINDS.length], res: uuid(i), resOk: false }));
    expect(attempt(log, rows, 0)).toEqual({ landed: 600, refused: "any" });
  });

  it("REVIEW: a loop sustained for an hour reaches one person 1,200 times, not 36,000", () => {
    const log: Sent[] = [];
    let total = 0;
    for (let minute = 0; minute < 60; minute++) {
      const rows = Array.from({ length: 700 }, (_, i) => ({ actor: "mallory", to: "victim", kind: KINDS[i % KINDS.length], res: uuid(minute * 1000 + i), resOk: false }));
      total += attempt(log, rows, minute * 60).landed;
    }
    expect(total).toBe(CAP.anyHour);
    // and the next hour opens a fresh budget, never a burst above the minute cap
    const next = attempt(log, Array.from({ length: 700 }, (_, i) => ({ actor: "mallory", to: "victim", kind: KINDS[i % KINDS.length], res: uuid(90_000 + i), resOk: false })), 3600 + 120);
    expect(next.landed).toBeLessThanOrEqual(CAP.anyMinute);
  });

  it("REVIEW: the same loop run against every member of a 4,000-member org meets the per-actor ceiling", () => {
    const log: Sent[] = [];
    const rows = Array.from({ length: 4000 }, (_, i) => ({ actor: "mallory", to: `m${i}`, kind: "checkout_message", res: null, resOk: false }));
    expect(attempt(log, rows, 0)).toEqual({ landed: 3000, refused: "actor" });
    // a minute later the window has slid
    expect(attempt(log, rows.slice(3000), 61)).toEqual({ landed: 1000, refused: null });
  });

  it("REGRESSION: every legitimate fan-out lands whole", () => {
    // an ack roster — one request per document to one assignee, 300 real documents
    let log: Sent[] = [];
    expect(attempt(log, Array.from({ length: 300 }, (_, i) => ({ actor: "dc", to: "op", kind: "ack_requested", res: uuid(i), resOk: true })), 0))
      .toEqual({ landed: 300, refused: null });
    // a role broadcast to 300 members
    log = [];
    expect(attempt(log, Array.from({ length: 300 }, (_, i) => ({ actor: "dc", to: `m${i}`, kind: "hold_opened", res: uuid(1), resOk: true })), 0))
      .toEqual({ landed: 300, refused: null });
    // the browser's checkout sweep — one statement, one release notice per expired holder
    log = [];
    expect(attempt(log, Array.from({ length: 500 }, (_, i) => ({ actor: "sweeper", to: `m${i}`, kind: "checkout_released", res: uuid(i), resOk: true })), 0))
      .toEqual({ landed: 500, refused: null });
    // a bulk upload under an ack policy — 100 documents x 25 assignees in one minute
    log = [];
    const bulk = Array.from({ length: 100 }, (_, d) => Array.from({ length: 25 }, (_, a) => ({ actor: "dc", to: `op${a}`, kind: "ack_requested", res: uuid(d), resOk: true }))).flat();
    expect(attempt(log, bulk, 0)).toEqual({ landed: 2500, refused: null });
    // one real document pressed 61 times is the poke the same-notice cap exists for
    log = [];
    expect(attempt(log, Array.from({ length: 61 }, () => ({ actor: "x", to: "y", kind: "checkout_message", res: uuid(7), resOk: true })), 0))
      .toEqual({ landed: 60, refused: "same" });
  });
});

// ── which rows take the actor's lock (OS-1, third review fix) ───────────────
// Rule 7 counts without a lock first. A count already at its cap is refused
// there; a row NEAR a cap (the same notice already sent to that person this
// minute, or a count within MARGIN of its cap) and every later row of one
// transaction are counted again under the actor's lock. A count sees
// committed rows only, so requests judged without the lock each see the same
// baseline: a burst is modelled as rows that all count one committed log,
// and the rows that need the lock as landing one after another, each seeing
// every row committed before it.
const MARGIN = 64;
type Counts = ReturnType<typeof countsFor>;
function lockPass(c: Counts, laterRowOfItsTransaction: boolean): "refused" | "lock" | "unlocked" {
  if (c.same >= CAP.same || c.any >= CAP.anyMinute || c.hour >= CAP.anyHour || c.actor >= CAP.actorMinute) return "refused";
  if (laterRowOfItsTransaction) return "lock";
  return c.same === 0 && c.any < CAP.anyMinute - MARGIN && c.hour < CAP.anyHour - MARGIN && c.actor < CAP.actorMinute - MARGIN
    ? "unlocked" : "lock";
}
/** One wave of concurrent single-row requests: each counts the log as it stood before the wave;
 *  the unlocked ones all land; the ones that need the lock then land one after another. */
function wave(log: Sent[], rows: Array<Omit<Sent, "t">>, now: number) {
  const before = [...log];
  const queued: Array<Omit<Sent, "t">> = [];
  let unlocked = 0;
  for (const row of rows) {
    const p = lockPass(countsFor(before, row, now), false);
    if (p === "unlocked") { log.push({ ...row, t: now }); unlocked++; }
    else if (p === "lock") queued.push(row);
  }
  return { unlocked, locked: attempt(log, queued, now, false).landed };
}
/** Concurrent multi-row statements: each one's first row counts the log as it stood before them (and,
 *  near a cap, again under the lock); every later row is judged under the lock, statement after
 *  statement, seeing the committed rows and its own; a refusal aborts its whole statement. */
function statements(log: Sent[], stmts: Array<Array<Omit<Sent, "t">>>, now: number): number {
  const before = [...log];
  let landed = 0;
  for (const st of stmts) {
    const first = lockPass(countsFor(before, st[0], now), false);
    if (first === "refused") continue;
    if (first === "lock" && lockPass(countsFor(log, st[0], now), true) === "refused") continue;   // re-counted under the lock
    const mine: Sent[] = [{ ...st[0], t: now }];
    const ok = st.slice(1).every((row) => {
      if (lockPass(countsFor([...log, ...mine], row, now), true) === "refused") return false;
      mine.push({ ...row, t: now });
      return true;
    });
    if (ok) { log.push(...mine); landed += mine.length; }
  }
  return landed;
}

describe("OS-1 (third review fix) — the actor's lock: only near a cap or for a later row of one transaction", () => {
  const fn = between(A, "CREATE OR REPLACE FUNCTION enforce_notification_insert()", "$$;");
  const poke = { actor: "m", to: "v", kind: "checkout_message", res: uuid(7), resOk: true };

  it("the model's margin and conditions are the SQL's", () => {
    const exit = squash(fn.slice(fn.indexOf("EXIT WHEN v_lock"), fn.indexOf("v_lock := true;")));
    expect(exit).toBe(`EXIT WHEN v_lock OR (v_same = 0 AND v_any < ${CAP.anyMinute} - ${MARGIN} AND v_hour < ${CAP.anyHour} - ${MARGIN} AND v_actor < ${CAP.actorMinute} - ${MARGIN});`);
  });

  it("REGRESSION (the review's pool starvation): a fan-out that sends each person one notice is judged as it stands — none of its requests queues on the lock", () => {
    const passes = (rows: Array<Omit<Sent, "t">>) => {
      const log: Sent[] = [];
      return new Set(rows.map((row) => { const p = lockPass(countsFor(log, row, 0), false); log.push({ ...row, t: 0 }); return p; }));
    };
    // an ack roster: 300 real documents to one assignee
    expect(passes(Array.from({ length: 300 }, (_, i) => ({ actor: "dc", to: "op", kind: "ack_requested", res: uuid(i), resOk: true })))).toEqual(new Set(["unlocked"]));
    // a role broadcast to 300 members
    expect(passes(Array.from({ length: 300 }, (_, i) => ({ actor: "dc", to: `m${i}`, kind: "hold_opened", res: uuid(1), resOk: true })))).toEqual(new Set(["unlocked"]));
    // a bulk upload under an ack policy: 100 documents x 25 assignees, one request each, in one minute
    const bulk = Array.from({ length: 100 }, (_, d) => Array.from({ length: 25 }, (_, a) => ({ actor: "dc", to: `op${a}`, kind: "ack_requested", res: uuid(d), resOk: true }))).flat();
    expect(passes(bulk)).toEqual(new Set(["unlocked"]));
  });

  it("fix pass 4: a browser publish takes the lock for each person who gets both supersede notices — notifySuperseded's and nudgeStaleHolders', one kind about one document — and for no one else", () => {
    // lib/postPublish.ts runPostPublishSideEffects: notifySuperseded emits doc_superseded about the document to its
    // live intent holders and followers; the recall block then emits doc_superseded about the same document to
    // every member holding an older downloaded copy (lib/staleCopies.ts nudgeStaleHolders). A follower who holds
    // an old copy is the same (actor, recipient, kind, resource) twice in the minute: the second is a repeat notice.
    const doc = uuid(42);
    const log: Sent[] = [];
    const followers = Array.from({ length: 300 }, (_, i) => ({ actor: "pub", to: `m${i}`, kind: "doc_superseded", res: doc, resOk: true }));
    expect(wave(log, followers, 0)).toEqual({ unlocked: 300, locked: 0 });
    // 60 holders of an older copy: 40 follow the document, 20 do not
    const holders = [...followers.slice(0, 40), ...Array.from({ length: 20 }, (_, i) => ({ actor: "pub", to: `h${i}`, kind: "doc_superseded", res: doc, resOk: true }))];
    expect(wave(log, holders, 0)).toEqual({ unlocked: 20, locked: 40 });
    // the library notice (library_doc_revised, keyed on the library) is another kind: it never makes a repeat
    expect(lockPass(countsFor(log, { actor: "pub", to: "m0", kind: "library_doc_revised", res: uuid(43), resOk: true }, 0), false)).toBe("unlocked");
    // PostgreSQL 16, 20 connections (N5 fix pass 4): the 300 first notices — no connection ever waited on the lock;
    // the 60 holders' notices — up to 19 connections waited on it, median latency 55.7 ms (14.1 ms for the same 60
    // as first notices), all 60 landed; 300 holders who all follow — up to 20 waited, 1.46 s for the fan-out
    // (0.30 s as first notices), about 5 ms per locked insert one after another.
  });

  it("what takes the lock: a later row of one statement (the sweep), the same notice again this minute, a count within the margin of its cap; a count at its cap is refused without queueing", () => {
    const zero = { same: 0, any: 0, hour: 0, actor: 0 };
    expect(lockPass(zero, false)).toBe("unlocked");
    expect(lockPass(zero, true)).toBe("lock");
    expect(lockPass({ ...zero, same: 1, any: 1, hour: 1, actor: 1 }, false)).toBe("lock");
    expect(lockPass({ ...zero, any: 535, hour: 535, actor: 535 }, false)).toBe("unlocked");
    expect(lockPass({ ...zero, any: 536, hour: 536, actor: 536 }, false)).toBe("lock");
    expect(lockPass({ ...zero, hour: 1136 }, false)).toBe("lock");
    expect(lockPass({ ...zero, actor: 2936 }, false)).toBe("lock");
    expect(lockPass({ ...zero, any: 600, hour: 600, actor: 600 }, false)).toBe("refused");
    expect(lockPass({ ...zero, same: 60, any: 60, hour: 60, actor: 60 }, true)).toBe("refused");
  });

  it("the bound, as the PostgreSQL 16 runs found it: through a 20-connection pool one notice lands 60 of 100; 90 requests counted at the same instant all land — a burst passes a cap only by what it holds beyond the margin", () => {
    let log: Sent[] = [];
    let landed = 0;
    for (let w = 0; w < 5; w++) { const r = wave(log, Array(20).fill(poke), 0); landed += r.unlocked + r.locked; }
    expect(landed).toBe(CAP.same);
    // 90 sessions at once, each counting before any commits: all see no earlier same notice
    log = [];
    expect(wave(log, Array(90).fill(poke), 0)).toEqual({ unlocked: 90, locked: 0 });
    // a burst of up to 60 at one instant never passes a cap: the same-notice cap from nothing ...
    log = [];
    expect(wave(log, Array(60).fill(poke), 0).unlocked).toBe(60);
    expect(countsFor(log, poke, 0).same).toBe(CAP.same);
    // ... and the 600 cap from the last count below its margin: 535 already this minute, 65 at once
    log = Array.from({ length: 535 }, (_, i) => ({ actor: "m", to: "v", kind: KINDS[i % KINDS.length], res: uuid(i), resOk: true, t: 0 }));
    const burst = Array.from({ length: 65 }, (_, i) => ({ actor: "m", to: "v", kind: "checkout_message", res: uuid(10_000 + i), resOk: true }));
    expect(wave(log, burst, 0)).toEqual({ unlocked: 65, locked: 0 });
    expect(countsFor(log, burst[0], 0).any).toBe(CAP.anyMinute);
    // one past the margin, the next request queues on the lock and is refused there
    expect(lockPass(countsFor(log, poke, 0), false)).toBe("refused");
  });

  it("a multi-row statement is judged under the lock from its second row: 20 concurrent 40-row statements to one person land 600, not 800 (PostgreSQL 16: 800 without the later-row rule)", () => {
    const log: Sent[] = [];
    const stmts = Array.from({ length: 20 }, (_, s) => Array.from({ length: 40 }, (_, i) => ({ actor: "m", to: "v", kind: "checkout_message", res: uuid(s * 40 + i), resOk: true })));
    expect(statements(log, stmts, 0)).toBe(CAP.anyMinute);
    // and the browser's sweep — one statement, one row per expired holder — lands whole
    const sweep = [Array.from({ length: 500 }, (_, i) => ({ actor: "sweeper", to: `m${i}`, kind: "checkout_released", res: uuid(i), resOk: true }))];
    expect(statements([], sweep, 0)).toBe(500);
  });
});

// ── migration B ─────────────────────────────────────────────────────────────
const ACTIVE_SQL = "EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = notifications.org_id AND m.uid = auth.uid() AND m.status = 'active')";
function policy(name: string): string {
  return squash(between(strip(B), `CREATE POLICY ${name} ON notifications`, ");"));
}

describe("20261161 — the read scope (NEDGE-7) and the read_at-only write (DELIV-13)", () => {
  it("stops with a message when 20261160 is missing, before anything else runs", () => {
    const guard = strip(B).indexOf("IF to_regprocedure('public.notification_kinds()') IS NULL THEN");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(strip(B).indexOf("CREATE TEMP TABLE"));
  });

  it("adds org_tombstoned_at (nullable, idempotent)", () => {
    expect(B).toMatch(/ALTER TABLE notifications ADD COLUMN IF NOT EXISTS org_tombstoned_at TIMESTAMPTZ;/);
  });

  it("dw1: SELECT is own rows, not tombstoned, in an org where the caller is ACTIVE", () => {
    expect(policy("notifications_own_select")).toBe(squash(`CREATE POLICY notifications_own_select ON notifications FOR SELECT USING (
      user_id = auth.uid() AND org_tombstoned_at IS NULL AND ${ACTIVE_SQL} );`));
  });

  it("dw1 + DELIV-13 dw1: UPDATE has the same scope in USING and in WITH CHECK", () => {
    const p = policy("notifications_own_update");
    const scope = squash(`user_id = auth.uid() AND org_tombstoned_at IS NULL AND ${ACTIVE_SQL}`);
    expect(p.startsWith("CREATE POLICY notifications_own_update ON notifications FOR UPDATE USING (")).toBe(true);
    // between() stops at the first ");", which closes USING; WITH CHECK follows
    expect(p).toContain(scope);
    expect(squash(strip(B))).toContain(squash(`) WITH CHECK ( ${scope} );`));
  });

  it("DELIV-13 dw2: DELETE takes only READ rows of a non-compliance kind (from notification_kinds())", () => {
    const p = squash(between(strip(B), "CREATE POLICY notifications_own_delete ON notifications", "k.compliance)\n);"));
    expect(p).toBe(squash(`CREATE POLICY notifications_own_delete ON notifications FOR DELETE USING (
      user_id = auth.uid() AND org_tombstoned_at IS NULL AND read_at IS NOT NULL AND ${ACTIVE_SQL}
      AND NOT EXISTS (SELECT 1 FROM notification_kinds() k WHERE k.kind = notifications.kind AND k.compliance) );`));
  });

  it("DELIV-13 dw1: when the recipient updates their own row, every column but read_at is pinned (a later column too)", () => {
    const fn = between(B, "CREATE OR REPLACE FUNCTION enforce_notification_update()", "$$;");
    expect(fn).toMatch(/RETURNS trigger LANGUAGE plpgsql SET search_path = public AS \$\$/);
    expect(fn).not.toMatch(/SECURITY DEFINER/);
    expect(squash(fn)).toContain(squash(`IF auth.uid() IS NULL OR OLD.user_id IS DISTINCT FROM auth.uid() THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'read_at') IS DISTINCT FROM (to_jsonb(OLD) - 'read_at') THEN
    RAISE EXCEPTION 'notifications: only read_at may change on your own notification' USING ERRCODE = '42501';`));
    expect(B).toMatch(/CREATE TRIGGER trg_notifications_read_at_only\s+BEFORE UPDATE ON notifications\s+FOR EACH ROW EXECUTE FUNCTION enforce_notification_update\(\);/);
    expect(B).toMatch(/REVOKE ALL ON FUNCTION enforce_notification_update\(\) FROM PUBLIC, anon, authenticated;/);
  });
});

/** Every `CREATE POLICY name ON notifications` in the numbered sequence below
 *  `before`, in migration order, as [file, comment-stripped text to its ';']. */
function policyDefinitionsOf(name: string, before = B_FILE): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = new RegExp(`CREATE\\s+POLICY\\s+"?${name}"?\\s+ON\\s+(?:public\\.)?notifications\\b`, "g");
  for (const f of FILES) {
    if (f >= before) continue;
    const s = strip(read(f));
    for (const m of s.matchAll(re)) out.push([f, s.slice(m.index!, s.indexOf(";", m.index!) + 1)]);
  }
  return out;
}
/** The text inside the parenthesis that opens right after `marker`. */
function clause(text: string, marker: string): string | null {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const open = text.indexOf("(", at + marker.length - 1);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}
/** A predicate's top-level AND terms (an AND inside a parenthesis stays in its term). */
function andTerms(pred: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  const p = squash(pred);
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "(") depth++;
    else if (p[i] === ")") depth--;
    else if (depth === 0 && p.startsWith(" AND ", i)) { out.push(p.slice(start, i).trim()); start = i + 5; i += 4; }
  }
  out.push(p.slice(start).trim());
  return out;
}

describe("20261161 — the three own-row policies re-created from their NEWEST definitions: the old predicate kept verbatim, only the listed terms added", () => {
  const COMPLIANCE_SQL = "NOT EXISTS (SELECT 1 FROM notification_kinds() k WHERE k.kind = notifications.kind AND k.compliance)";
  const cases = [
    { name: "notifications_own_select", cmd: "SELECT", added: ["org_tombstoned_at IS NULL", ACTIVE_SQL], check: false },
    { name: "notifications_own_update", cmd: "UPDATE", added: ["org_tombstoned_at IS NULL", ACTIVE_SQL], check: true },
    { name: "notifications_own_delete", cmd: "DELETE", added: ["org_tombstoned_at IS NULL", "read_at IS NOT NULL", ACTIVE_SQL, COMPLIANCE_SQL], check: false },
  ] as const;

  it.each(cases)("$name: the newest earlier definition is found by scanning the sequence (today 20260723)", ({ name, cmd }) => {
    const earlier = policyDefinitionsOf(name);
    expect(earlier.length, "20260621 and 20260723 both define it").toBeGreaterThanOrEqual(2);
    const [file, text] = earlier.at(-1)!;
    expect(file, `a migration below ${B_FILE} re-created ${name}: re-base 20261161's policy on it`).toBe("20260723_notifications_unify.sql");
    expect(squash(text)).toBe(`CREATE POLICY ${name} ON notifications FOR ${cmd} USING (user_id = auth.uid());`);
  });

  it.each(cases)("$name: keeps its command, its roles and its old predicate first, verbatim, and adds exactly the listed terms", ({ name, cmd, added, check }) => {
    const old = squash(clause(policyDefinitionsOf(name).at(-1)![1], "USING (")!);
    const next = squash(strip(B).slice(strip(B).indexOf(`CREATE POLICY ${name} ON notifications`)));
    const head = next.slice(0, next.indexOf(" USING ("));
    expect(head).toBe(`CREATE POLICY ${name} ON notifications FOR ${cmd}`);   // no TO <role>, no AS RESTRICTIVE
    const using = andTerms(clause(next, "USING (")!);
    expect(using[0]).toBe(old);
    expect(using.slice(1)).toEqual(added.map(squash));
    if (check) {
      // the old policy had no WITH CHECK, so PostgreSQL checked writes with its USING: the new
      // WITH CHECK is that same old predicate plus the same terms
      const withCheck = andTerms(clause(next.slice(next.indexOf(") WITH CHECK (")), "WITH CHECK (")!);
      expect(withCheck).toEqual([old, ...added.map(squash)]);
    } else {
      expect(next.slice(0, next.indexOf(");") + 2)).not.toContain("WITH CHECK");
    }
  });

  it("the scan is not vacuous: it answers the newest definition below its cutoff, so a policy re-created below 20261161 would become the one to diff against", () => {
    expect(policyDefinitionsOf("notifications_own_select", "20260723_notifications_unify.sql").at(-1)![0]).toBe("20260621_in_app_notifications.sql");
    expect(policyDefinitionsOf("notifications_own_select", "99999999").at(-1)![0]).toBe(B_FILE);
  });
});

describe("20261161 — revoke_member re-created from its NEWEST definition, plus the tombstone (DEC-20 lineage)", () => {
  const earlier = definitionsOf("revoke_member", B_FILE);
  const [liveFile, live] = earlier.at(-1)!;
  const next = definitionsOf("revoke_member").find(([f]) => f === B_FILE)![1];

  it("the newest earlier definition is found by scanning the sequence (today 20261043 §0, never 20261042)", () => {
    expect(earlier.length).toBeGreaterThanOrEqual(2);
    expect(liveFile >= "20261043_rp_phase6_legal_hold_and_force_release.sql").toBe(true);
    expect(live).toMatch(/active_collaborators = '\{\}'::text\[\]/);
  });

  it("removes no line, and adds exactly the tombstone statement and its comment", () => {
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual([]);
    expect(onlyInB.map((l) => l.trim())).toEqual([
      "-- NEDGE-7 (notifications Round G, 20261161): the member's notifications in",
      "-- this org are tombstoned, not deleted — the archive stays for",
      "-- investigators; the read policy hides a tombstoned row from its recipient",
      "-- for good, so a re-added member starts with an empty bell.",
      "UPDATE notifications SET org_tombstoned_at = NOW()",
      "WHERE org_id = v_member.org_id AND user_id = v_member.uid AND org_tombstoned_at IS NULL;",
    ]);
  });

  it("the tombstone runs on the REMOVE path, after the roster sweep and before the membership delete — one transaction", () => {
    const at = (s: string) => next.indexOf(s);
    expect(at("IF p_mode = 'suspend' THEN")).toBeLessThan(at("UPDATE notifications SET org_tombstoned_at"));
    expect(at("DELETE FROM subscriptions WHERE org_id = v_member.org_id")).toBeLessThan(at("UPDATE notifications SET org_tombstoned_at"));
    expect(at("UPDATE notifications SET org_tombstoned_at")).toBeLessThan(at("DELETE FROM org_members WHERE id = p_member_id;"));
  });

  // A later migration that re-creates revoke_member must start from its NEWEST definition — 20261161's
  // from N5 on. One started from 20261043 (the body admin-and-org P8's brief named) would drop the
  // tombstone without a word, and a removed member's archive would stop being sealed (NEDGE-7).
  const TOMBSTONE = /UPDATE (?:public\.)?notifications SET org_tombstoned_at = (?:now\(\)|current_timestamp) WHERE org_id = v_member\.org_id AND user_id = v_member\.uid AND org_tombstoned_at IS NULL;/i;
  /** The newest revoke_member among `sources` by file name, and whether its code (comments stripped) keeps the tombstone. */
  const newestKeepsTombstone = (sources: Array<[string, string]>) => {
    const [file, text] = definitionsIn([...sources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), "revoke_member").at(-1)!;
    return { file, keeps: TOMBSTONE.test(squash(strip(text))) };
  };
  const sequence = (): Array<[string, string]> => FILES.map((f): [string, string] => [f, read(f)]);

  it("TRIPWIRE (fix pass 4): the NEWEST revoke_member in the whole sequence — any migration after 20261161 included — still tombstones the removed member's notifications", () => {
    const { file, keeps } = newestKeepsTombstone(sequence());
    expect(file >= B_FILE, `newest revoke_member: ${file}`).toBe(true);
    expect(keeps, `${file} re-creates revoke_member without 20261161's tombstone (NEDGE-7): re-create it from its NEWEST definition, never from 20261043`).toBe(true);
  });

  it("the tripwire is not vacuous: a later re-creation from 20261043's body (under any quote tag), or with the statement only in a comment, fails it; one that keeps the statement passes", () => {
    const all = sequence();
    const later = "99999999_a_later_re_creation.sql";   // after every file the sequence will ever hold
    expect(newestKeepsTombstone([...all, [later, live]])).toEqual({ file: later, keeps: false });
    expect(newestKeepsTombstone([...all, [later, live.replace("AS $$", "AS $fn$").replace(/\$\$;$/, "$fn$;")]])).toEqual({ file: later, keeps: false });
    const commented = next.replace(/^(\s*)(UPDATE notifications SET org_tombstoned_at[^\n]*\n)(\s*)(WHERE org_id = v_member\.org_id[^\n]*)/m, "$1-- $2$3-- $4");
    expect(commented).not.toBe(next);
    expect(newestKeepsTombstone([...all, [later, commented]])).toEqual({ file: later, keeps: false });
    const kept = next.replace("DELETE FROM org_members WHERE id = p_member_id;", "-- ACL rules naming the member are pruned here (ORG-7)\n  DELETE FROM org_members WHERE id = p_member_id;");
    expect(newestKeepsTombstone([...all, [later, kept.replace("AS $$", "AS $body$").replace(/\$\$;$/, "$body$;")]])).toEqual({ file: later, keeps: true });
    // below 20261161 the newest is 20261043's, which never carried it
    expect(newestKeepsTombstone(all.filter(([f]) => f < B_FILE))).toEqual({ file: liveFile, keeps: false });
  });

  it("keeps SECURITY DEFINER + the pinned search_path, refuses a NULL uid, and restates EXECUTE (DRLS-16)", () => {
    expect(next).toMatch(/RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(next).toMatch(/IF v_actor IS NULL THEN\s*RAISE EXCEPTION/);
    expect(B).toMatch(/REVOKE ALL ON FUNCTION revoke_member\(uuid, text\) FROM PUBLIC, anon;\s*GRANT EXECUTE ON FUNCTION revoke_member\(uuid, text\) TO authenticated;/);
  });
});

// ── the policy model (NEDGE-7 dw3, DEC-43, the regression rows) ─────────────
// Each predicate is the SQL above (pinned there). Members are (org, uid,
// status); rows are (org, user, read_at, kind, tombstone).
type Member = { org: string; uid: string; status: string };
type Row = { id: string; org: string; user: string; kind: string; read: boolean; tomb: boolean; title: string };
const COMPLIANCE = new Set(Object.entries(KIND_META).filter(([, m]) => m.compliance).map(([k]) => k));
const active = (ms: Member[], org: string, uid: string) => ms.some((m) => m.org === org && m.uid === uid && m.status === "active");
const canSelect = (r: Row, uid: string, ms: Member[]) => r.user === uid && !r.tomb && active(ms, r.org, uid);
const canUpdate = canSelect;
const canDelete = (r: Row, uid: string, ms: Member[]) => canSelect(r, uid, ms) && r.read && !COMPLIANCE.has(r.kind);
/** revoke_member REMOVE, as far as notifications go (the pinned statement + the membership delete). */
function remove(ms: Member[], rows: Row[], org: string, uid: string) {
  for (const r of rows) if (r.org === org && r.user === uid && !r.tomb) r.tomb = true;
  return ms.filter((m) => !(m.org === org && m.uid === uid));
}

describe("the model of 20261161's policies — removed, suspended, restored, re-added, multi-org", () => {
  const seed = () => ({
    ms: [
      { org: "a", uid: "bob", status: "active" },
      { org: "a", uid: "x", status: "active" }, { org: "b", uid: "x", status: "active" },
      { org: "a", uid: "sus", status: "suspended" },
      { org: "a", uid: "admin", status: "active" },
    ] as Member[],
    rows: [
      { id: "1", org: "a", user: "x", kind: "hold_opened", read: false, tomb: false, title: "HOLD placed on PID-4412 — litigation" },
      { id: "2", org: "a", user: "x", kind: "review_overdue", read: false, tomb: false, title: "sign-off late" },
      { id: "3", org: "b", user: "x", kind: "hold_opened", read: false, tomb: false, title: "org b" },
      { id: "4", org: "a", user: "bob", kind: "library_doc_added", read: true, tomb: false, title: "fyi read" },
      { id: "5", org: "a", user: "bob", kind: "library_doc_added", read: false, tomb: false, title: "fyi unread" },
      { id: "6", org: "a", user: "bob", kind: "ack_requested", read: true, tomb: false, title: "compliance read" },
      { id: "7", org: "a", user: "sus", kind: "hold_opened", read: false, tomb: false, title: "to sus" },
      { id: "8", org: "a", user: "admin", kind: "review_overdue", read: false, tomb: false, title: "admin row" },
    ] as Row[],
  });

  it("NEDGE-7 dw3: after REMOVE, the removed member's token returns zero rows for the org — their rows are kept, tombstoned", () => {
    const fixture = seed();
    const rows = fixture.rows;
    let ms = fixture.ms;
    expect(rows.filter((r) => r.org === "a" && canSelect(r, "x", ms))).toHaveLength(2);
    ms = remove(ms, rows, "a", "x");
    expect(rows.filter((r) => r.org === "a" && canSelect(r, "x", ms))).toHaveLength(0);
    expect(rows.filter((r) => r.org === "a" && (canUpdate(r, "x", ms) || canDelete(r, "x", ms)))).toHaveLength(0);
    expect(rows.filter((r) => r.org === "a" && r.user === "x" && r.tomb)).toHaveLength(2);
    // still an active member of org b: that archive is untouched
    expect(rows.filter((r) => r.org === "b" && canSelect(r, "x", ms)).map((r) => r.id)).toEqual(["3"]);
    // re-added: the tombstoned archive stays hidden; a new row is visible
    ms = [...ms, { org: "a", uid: "x", status: "active" }];
    rows.push({ id: "9", org: "a", user: "x", kind: "project_member", read: false, tomb: false, title: "welcome back" });
    expect(rows.filter((r) => r.org === "a" && canSelect(r, "x", ms)).map((r) => r.id)).toEqual(["9"]);
  });

  it("a member removed with NO revoke (no tombstone) still reads nothing while they are not an active member", () => {
    const { ms, rows } = seed();
    const without = ms.filter((m) => !(m.org === "a" && m.uid === "x"));
    expect(rows.filter((r) => r.org === "a" && canSelect(r, "x", without))).toHaveLength(0);
  });

  it("suspended: reads nothing, marks nothing; restored: reads again (no tombstone on suspend)", () => {
    const { ms, rows } = seed();
    expect(rows.filter((r) => canSelect(r, "sus", ms))).toHaveLength(0);
    const restored = ms.map((m) => (m.uid === "sus" ? { ...m, status: "active" } : m));
    expect(rows.filter((r) => canSelect(r, "sus", restored)).map((r) => r.id)).toEqual(["7"]);
  });

  it("REGRESSION: an active member reads, marks read and clears their own read FYI rows — and only their own", () => {
    const { ms, rows } = seed();
    expect(rows.filter((r) => canSelect(r, "bob", ms)).map((r) => r.id)).toEqual(["4", "5", "6"]);
    expect(rows.filter((r) => canUpdate(r, "bob", ms)).map((r) => r.id)).toEqual(["4", "5", "6"]);
    expect(rows.filter((r) => canDelete(r, "bob", ms)).map((r) => r.id)).toEqual(["4"]);   // read FYI only
    expect(rows.filter((r) => r.user !== "bob" && canSelect(r, "bob", ms))).toHaveLength(0);
  });

  it("DEC-43: an Admin's own rows are read like anyone's — no document-ACL scoping on the bell", () => {
    const { ms, rows } = seed();
    expect(rows.filter((r) => canSelect(r, "admin", ms)).map((r) => r.id)).toEqual(["8"]);
  });

  it("the model's predicates are the SQL's: the active-membership EXISTS, the tombstone, the read and compliance terms", () => {
    expect(policy("notifications_own_select")).toContain(squash(ACTIVE_SQL));
    expect(policy("notifications_own_select")).toContain("org_tombstoned_at IS NULL");
    expect(squash(strip(B))).toContain("read_at IS NOT NULL");
    expect(squash(strip(B))).toContain("k.kind = notifications.kind AND k.compliance");
    expect(squash(between(B, "CREATE OR REPLACE FUNCTION revoke_member", "$$;"))).toContain(
      "UPDATE notifications SET org_tombstoned_at = NOW() WHERE org_id = v_member.org_id AND user_id = v_member.uid AND org_tombstoned_at IS NULL;");
  });
});

// ── the app's own notification writes survive the rails ─────────────────────
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (n !== "node_modules" && n !== "__tests__" && !n.startsWith(".")) walk(p); }
      else if (/\.tsx?$/.test(n) && !n.endsWith(".d.ts")) out.push(p);
    }
  };
  for (const d of ["app", "lib", "components", "hooks"]) walk(join(ROOT, d));
  return out;
}

// ── rule 1's obligation on the producers (third review fix) ────────────────
// 20261160 refuses (42501) a signed-in writer's row whose actor_user_id names
// anyone but the caller. Each notify / notifyMany / notifyChecked / emit call
// with an object literal is judged by where its actorUserId comes from:
// absent (the trigger stamps the caller), the signed-in member, or a
// parameter of the enclosing NAMED function — a pass-through, pinned in
// ACTOR_PASS_THROUGHS. The signed-in member is judged by its declaration,
// never its spelling (fix pass 4): RoleContext's uid (`const { uid } =
// useRole()`, the hook imported from RoleContext, which sets it only from the
// auth session), or a parameter / prop spelled uid, currentUserId or
// currentUser.uid whose every caller — a call or a JSX element — supplies
// that member in turn. A shadowing or differently-sourced `uid` (a callback's
// parameter, a row's field, a name the census cannot resolve) is judged like
// any other value. A stored uid (a document's owner, a ticket's requester,
// a hold's opener), a callback's parameter, a spread row or anything the
// census cannot see is an offender. Then one hop up: every call of a pinned
// pass-through is judged the same way, and the callers that forward their own
// caller's value are pinned in ACTOR_CALLER_PASS_THROUGHS. Deeper callers (the
// pages and panels that call those) carry the obligation as recorded in
// lib/notificationKinds.ts and DEC-86 §2. The route files and the
// orchestrator's tools write on the service role, which the rule never
// reaches.
const ACTOR_SERVER_FILES = ["lib/orchestrator/tools.ts"];
/** Every function that forwards a parameter as a browser row's actor (`file#fn(param.path)`). Its
 *  callers pass the signed-in member today (read at this commit); a caller that passed a stored uid
 *  instead would have every row from that path refused once 20261160 is pasted — the obligation
 *  lib/notificationKinds.ts and DEC-86 §2 record. A new pass-through fails here until listed. */
const ACTOR_PASS_THROUGHS = [
  "lib/acknowledgments.ts#maybeNotifyComplete(actorId)",
  "lib/acknowledgments.ts#recomputeDocumentAck(input.actorId)",
  "lib/activityThread.ts#notifyCheckoutActivity(input.userId)",
  "lib/branches.ts#resolveBranch(input.actorUserId)",
  "lib/changeOrders.ts#notifyApproval(actorId)",
  "lib/changeOrders.ts#notifyChangeOrder(actorId)",               // N8 (PROD-6)
  "lib/checkoutEpisodes.ts#forceReleaseDocument(input.actorUserId)",
  "lib/costDocs.ts#notifyAward(actor.uid)",
  "lib/distributionAcks.ts#renudgeUnacked(input.actorUserId)",
  "lib/distributionAcks.ts#requestAcks(input.actorUserId)",
  "lib/holds.ts#notifyHoldChange(input.actorUserId)",
  "lib/libraryCollections.ts#createLibrary(input.createdBy)",
  "lib/libraryNotify.ts#notifyLibraryDocsAdded(input.actorUserId)", // N8 (PROD-5)
  "lib/markupRequests.ts#createMarkupRequest(input.actorUserId)",   // N8 (PROD-14)
  "lib/markupRequests.ts#resolveMarkupRequest(input.actorUserId)",  // N8 (PROD-14)
  "lib/members.ts#revokeMember(input.actorUserId)",
  "lib/milestones.ts#notifyMilestoneAssigned(actorUserId)",         // N8 (PROD-11)
  "lib/milestones.ts#notifyScheduleChange(input.actorUserId)",      // N8 (PROD-11)
  "lib/milestones.ts#notifySlippedPastBaseline(input.actorUserId)", // N8 (PROD-11)
  "lib/ownership.ts#requestDeletion(input.requesterId)",
  "lib/ownership.ts#setOwner(input.actorId)",
  "lib/postPublish.ts#notifyPackagesOfRetirement(input.actorUserId)",
  "lib/postPublish.ts#notifySuperseded(input.actorUserId)",
  "lib/projects.ts#addMember(input.actorUserId)",
  "lib/projects.ts#notifyProjectAudience(input.actorUserId)",
  "lib/projects.ts#removeMember(input.actorUserId)",
  "lib/projects.ts#transferOwnership(input.actorUserId)",
  "lib/retention.ts#notifyHold(actorId)",
  "lib/reviewControl.ts#activateAlternate(input.actorId)",
  "lib/reviewControl.ts#openReviewRoster(input.actorId)",
  "lib/reviewControl.ts#recordReviewSignoff(input.signerUserId)",
  "lib/revisionImpact.ts#notifyConnectedWork(input.actorUserId)",
  "lib/revisions.ts#noteOverrideOnHolder(opts.actorUserId)",
  "lib/revisions.ts#notifyHolderOfRetirement(opts.actorUserId)",
  "lib/staleCopies.ts#nudgeStaleHolders(input.actorUserId)",
  "lib/staleCopies.ts#recallRetiredDocument(input.actorUserId)",
  "lib/transitionIn.ts#flagCollisionToDrafting(input.actorId)",
  "lib/turnover.ts#notifyTurnoverRejected(actor.uid)",              // N8 (MON-11)
  "lib/workPackages.ts#notifyPackagesOfRevUp(input.actorUserId)",
];
/** A parameter spelled as the signed-in member: `uid`, `currentUserId`, or `currentUser` read at `.uid`.
 *  The spelling is never the proof (fix pass 4): such a parameter is followed to its callers. */
const SESSION_SPELLING = /^(?:uid|currentUserId|currentUser\.uid)$/;
/** Where the signed-in member comes from: RoleContext's `uid`, which it sets only from the auth session
 *  (pinned below). Read as `const { uid } = useRole()` or `useRole().uid`, `useRole` imported from here. */
const ROLE_CONTEXT = "components/providers/RoleContext";
type ActorSite = { rel: string; node: ts.CallExpression | ts.JsxOpeningLikeElement };
type ActorCensus = {
  analyzer: (rel: string) => ReturnType<typeof actorAnalyzer>;
  /** Every call or JSX element naming `name` in the defining file, or in a file that binds `name` from it. */
  sitesOf: (name: string, definedIn: string) => ActorSite[];
  following: Set<string>;
};
/** The census over a set of source files: one analyzer per file, and the sites that call each function. */
function actorCensus(files: string[], read: (rel: string) => string): ActorCensus {
  const texts = new Map<string, string>();
  const text = (rel: string) => texts.get(rel) ?? texts.set(rel, read(rel)).get(rel)!;
  const analyzers = new Map<string, ReturnType<typeof actorAnalyzer>>();
  const sites = new Map<string, ActorSite[]>();
  const census: ActorCensus = {
    analyzer: (rel) => analyzers.get(rel) ?? analyzers.set(rel, actorAnalyzer(text(rel), rel, census)).get(rel)!,
    sitesOf: (name, definedIn) => {
      let all = sites.get(name);
      if (!all) {
        all = [];
        const mentions = new RegExp(`\\b${name}\\b`);
        for (const rel of files) {
          if (!mentions.test(text(rel))) continue;
          const { sf } = census.analyzer(rel);
          const visit = (n: ts.Node) => {
            const callee = ts.isCallExpression(n) && ts.isIdentifier(n.expression) ? n.expression.text
              : ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n) ? n.tagName.getText(sf) : undefined;
            if (callee === name) all!.push({ rel, node: n as ActorSite["node"] });
            ts.forEachChild(n, visit);
          };
          visit(sf);
        }
        sites.set(name, all);
      }
      return all.filter((s) => s.rel === definedIn || census.analyzer(s.rel).bindsFrom(name, definedIn));
    },
    following: new Set(),
  };
  return census;
}
/** Does `spec`, written in `fromRel`, name the module `targetRel` (`@/…`, or relative; extension and /index optional)? */
function specifierNames(spec: string, fromRel: string, targetRel: string): boolean {
  const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? posix.join(posix.dirname(fromRel), spec) : null;
  const stem = targetRel.replace(/\.tsx?$/, "");
  return base !== null && (base === stem || `${base}/index` === stem);
}
/** Judges where an actor value comes from, in one source file of a census. */
function actorAnalyzer(src: string, file: string, census?: ActorCensus) {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const unwrap = (e: ts.Expression): ts.Expression => {
    for (;;) {
      if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) { e = e.expression; continue; }
      // `x ?? undefined`, `x || ""`, `uid ?? "unknown"`: a literal fallback never names another member
      // (taken, it fails as an invalid uuid), so the actor is whatever `x` is
      if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(e.operatorToken.kind)
          && (e.right.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e.right) && e.right.text === "undefined")
            || ts.isStringLiteral(e.right))) { e = e.left; continue; }
      return e;
    }
  };
  const findBinding = (b: ts.BindingName, name: string): ts.BindingElement | undefined => {
    if (ts.isIdentifier(b)) return undefined;
    for (const e of b.elements) {
      if (ts.isOmittedExpression(e)) continue;
      if (ts.isIdentifier(e.name) && e.name.text === name) return e;
      const inner = findBinding(e.name, name);
      if (inner) return inner;
    }
    return undefined;
  };
  /** The keys a caller supplies to reach `name` inside a destructured parameter (`{ currentUser }` → [currentUser]). */
  const bindingPath = (b: ts.BindingName, name: string): string[] | undefined => {
    if (ts.isIdentifier(b)) return b.text === name ? [] : undefined;
    for (const [i, e] of b.elements.entries()) {
      if (ts.isOmittedExpression(e)) continue;
      const inner = bindingPath(e.name, name);
      if (inner) return [ts.isObjectBindingPattern(b) ? (e.propertyName ?? e.name).getText(sf) : String(i), ...inner];
    }
    return undefined;
  };
  /** A named function's name; null for a callback, whose parameters are data, never the session. */
  const fnName = (f: ts.SignatureDeclaration): string | null => {
    if ((ts.isFunctionDeclaration(f) || ts.isMethodDeclaration(f)) && f.name) return f.name.getText(sf);
    if ((ts.isArrowFunction(f) || ts.isFunctionExpression(f)) && ts.isVariableDeclaration(f.parent) && ts.isIdentifier(f.parent.name)) return f.parent.name.text;
    return null;
  };
  /** Does this file bind `name` from the module `targetRel` — an import, or a `dynamic(() => import(…))` const? */
  const bindsFrom = (name: string, targetRel: string): boolean => sf.statements.some((st) => {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && specifierNames(st.moduleSpecifier.text, file, targetRel)) {
      const c = st.importClause;
      return c?.name?.text === name || (!!c?.namedBindings && ts.isNamedImports(c.namedBindings) && c.namedBindings.elements.some((s) => s.name.text === name));
    }
    if (ts.isVariableStatement(st)) {
      return st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name && !!d.initializer
        && [...d.initializer.getText(sf).matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].some((m) => specifierNames(m[1], file, targetRel)));
    }
    return false;
  });
  const roleHook = bindsFrom("useRole", `${ROLE_CONTEXT}.tsx`);
  type Decl = { fn: ts.SignatureDeclaration; param: string; index: number; keys: string[] } | { init: ts.Expression; via: string[] };
  /** What `name` refers to at `at`, nearest scope first: a parameter, or a variable's initialiser. */
  const resolve = (name: string, at: ts.Node): Decl | undefined => {
    for (let n: ts.Node | undefined = at.parent; n; n = n.parent) {
      if (ts.isFunctionLike(n)) {
        for (const [index, p] of n.parameters.entries()) {
          if (ts.isIdentifier(p.name) && p.name.text === name) return { fn: n, param: name, index, keys: [] };
          const b = findBinding(p.name, name);
          if (b) {
            return { fn: n, param: `{ ${(b.propertyName ?? b.name).getText(sf)} }`, index, keys: bindingPath(p.name, name)! };
          }
        }
      }
      const statements = ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n) ? n.statements : undefined;
      for (const st of [...(statements ?? [])].reverse()) {
        if (!ts.isVariableStatement(st) || st.pos >= at.pos) continue;
        for (const d of st.declarationList.declarations) {
          if (!d.initializer) continue;
          if (ts.isIdentifier(d.name) && d.name.text === name) return { init: d.initializer, via: [] };
          const b = findBinding(d.name, name);
          if (b) return { init: d.initializer, via: [(b.propertyName ?? b.name).getText(sf)] };
        }
      }
    }
    return undefined;
  };
  /** "absent" | "session" | "pass:fn(param.path)" | "offender:text" */
  const judge = (e0: ts.Expression | undefined, extra: string[] = [], depth = 0): string => {
    if (!e0) return "absent";
    const e = unwrap(e0);
    const shown = `${e.getText(sf)}${extra.length ? `.${extra.join(".")}` : ""}`;
    if (!extra.length && (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === "undefined"))) return "absent";
    let root: ts.Expression = e;
    const path: string[] = [];
    while (ts.isPropertyAccessExpression(root)) { path.unshift(root.name.text); root = root.expression; }
    const chain = [...path, ...extra];
    // the source: RoleContext's uid (`const { uid } = useRole()`, `useRole().uid`)
    if (roleHook && ts.isCallExpression(root) && ts.isIdentifier(root.expression) && root.expression.text === "useRole"
        && root.arguments.length === 0 && chain.join(".") === "uid") return "session";
    // an object literal read at a key (`currentUser={{ uid, email }}` read as currentUser.uid)
    if (ts.isObjectLiteralExpression(root) && chain.length) return supplied(root, chain[0], chain.slice(1), depth + 1);
    if (ts.isIdentifier(root) && depth < 8) {
      const d = resolve(root.text, root);
      if (d && "fn" in d) {
        const name = fnName(d.fn);
        // the keys a caller supplies: a destructured parameter's, or a component's props object read at a key
        // (`props.currentUserId`); a lib function's whole parameter keeps its own name (`uid`, `actor.uid`)
        const supplies = d.keys.length || (d.index === 0 && /^[A-Z]/.test(name ?? "")) ? [...d.keys, ...chain] : [d.param, ...chain];
        if (name && SESSION_SPELLING.test(supplies.join("."))) return follow(d, name, chain, shown, depth);
        if (name) return `pass:${name}(${[d.param, ...chain].join(".")})`;
      } else if (d) return judge(d.init, [...d.via, ...chain], depth + 1);
    }
    return `offender:${shown}`;
  };
  /** A parameter spelled as the signed-in member is that member only if every caller — a call, or a JSX
   *  element, of the function — supplies the member (or nothing) in turn; with no caller found it is unseen. */
  const follow = (d: Extract<Decl, { fn: unknown }>, name: string, chain: string[], shown: string, depth: number): string => {
    if (!census) return `offender:${shown} (a parameter of ${name}: no census to follow its callers)`;
    const key = `${file}#${name}#${d.index}`;
    if (census.following.has(key)) return "session";   // a cycle adds no source of its own; the other callers decide
    const sites = census.sitesOf(name, file);
    if (!sites.length) return `offender:${shown} (a parameter of ${name}, which nothing calls)`;
    census.following.add(key);
    try {
      for (const s of sites) {
        const a = census.analyzer(s.rel);
        const v = a.suppliedAt(s.node, d.index, [...d.keys, ...chain], depth + 1);
        if (v !== "session" && v !== "absent") return `offender:${shown} ← ${s.rel}:${a.line(s.node)} ${v.replace(/^(offender|pass):/, "")}`;
      }
    } finally { census.following.delete(key); }
    return "session";
  };
  /** What a call or JSX element supplies for parameter `index` read at `keys`. */
  const suppliedAt = (node: ActorSite["node"], index: number, keys: string[], depth = 0): string => {
    if (ts.isCallExpression(node)) {
      const arg = node.arguments[index];
      if (!arg) return "absent";
      return keys.length && ts.isObjectLiteralExpression(unwrap(arg)) ? supplied(unwrap(arg) as ts.ObjectLiteralExpression, keys[0], keys.slice(1), depth) : judge(arg, keys, depth);
    }
    if (index !== 0 || !keys.length) return `offender:${node.tagName.getText(sf)} (props read whole)`;
    const props = node.attributes.properties;
    const own = props.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === keys[0]);
    if (own) {
      const init = own.initializer;
      return init && ts.isJsxExpression(init) && init.expression ? judge(init.expression, keys.slice(1), depth) : `offender:${own.getText(sf)}`;
    }
    const spread = [...props].reverse().find((p): p is ts.JsxSpreadAttribute => ts.isJsxSpreadAttribute(p));
    return spread ? judge(spread.expression, keys, depth) : "absent";
  };
  /** The actor an object-literal argument supplies under `key`: its own property, else what its last
   *  spread carries under that key (`{ ...input }` forwards input.key), else none. */
  const supplied = (obj: ts.ObjectLiteralExpression, key: string, extra: string[] = [], depth = 0): string => {
    const own = obj.properties.find((q) => (ts.isPropertyAssignment(q) || ts.isShorthandPropertyAssignment(q)) && q.name.getText(sf).replace(/["']/g, "") === key);
    if (own) return judge(ts.isShorthandPropertyAssignment(own) ? own.name : (own as ts.PropertyAssignment).initializer, extra, depth);
    const spread = [...obj.properties].reverse().find((q): q is ts.SpreadAssignment => ts.isSpreadAssignment(q));
    return spread ? judge(spread.expression, [key, ...extra], depth) : "absent";
  };
  return { sf, line, judge, supplied, suppliedAt, bindsFrom };
}
/** One hop up: the callers of those functions that forward THEIR caller's value in turn (a lib
 *  function's input, a component's prop). Pinned the same way, so a caller that starts handing a
 *  pass-through a row's field (`{ selectedDoc }.ownerUserId`) fails until someone reads it. */
const ACTOR_CALLER_PASS_THROUGHS = [
  "app/(protected)/projects/[id]/page.tsx#MembersTab({ actorUserId })",
  "components/documents/CsvImportModal.tsx#CsvImportModal({ actorUserId })",          // N8 (PROD-5): the library page passes RoleContext's uid
  "components/documents/DocumentLinkPicker.tsx#DocumentLinkPicker({ userId })",
  "components/documents/MarkupRequestModal.tsx#MarkupRequestModal({ actorUserId })",  // N8 (PROD-14)
  "lib/acknowledgments.ts#onDocumentIssuedAck(input.actorId)",
  "lib/acknowledgments.ts#recordAcknowledgment(input.signerUserId)",
  "lib/acknowledgments.ts#setAckPolicy(input.actorId)",
  "lib/acknowledgments.ts#waiveAcknowledgment(input.actorId)",
  "lib/activityThread.ts#postActivity(input.userId)",
  "lib/changeOrders.ts#decideChangeOrder(input.actorId)",
  "lib/changeOrders.ts#proposeChangeOrder(input.actorId)",            // N8 (PROD-6)
  "lib/costDocs.ts#awardInOneTransaction(input.actor.uid)",   // J12: awardQuote forwards its own input (integrator, J12 merge)
  "lib/costDocs.ts#awardQuote(input.actor.uid)",
  "lib/documentLifecycle/merge.ts#finishMerge(input.actorUserId)",
  "lib/documentLifecycle/split.ts#splitDocument(input.actorUserId)",
  "lib/holds.ts#openHold(input.openedBy)",
  "lib/holds.ts#releaseHold(input.releasedBy)",
  "lib/milestones.ts#notifyMovedBatch(input.actorUserId)",            // N8 (PROD-11): applyMilestoneMoves' own input
  "lib/milestones.ts#rebaseSchedule(input.actorUserId)",              // N8 (PROD-11)
  "lib/milestones.ts#setMilestoneStatus(input.actorUserId)",          // N8 (PROD-11)
  "lib/milestones.ts#updateMilestone(input.updatedBy)",               // N8 (PROD-11)
  "lib/postPublish.ts#runPostPublishSideEffects(input.actorUserId)",
  "lib/projects.ts#convertTicketToProject(input.actorUserId)",
  "lib/projects.ts#postComment(input.actorUserId)",
  "lib/projects.ts#reopenProject(input.actorUserId)",
  "lib/projects.ts#transitionProjectStatus(input.actorUserId)",
  "lib/retention.ts#placeLegalHold(input.actorId)",
  "lib/retention.ts#releaseLegalHold(input.actorId)",
  "lib/revisions.ts#revUpDocument(input.actorUserId)",
  "lib/revisions.ts#revertToVersion(input.actorUserId)",
  "lib/revisions.ts#submitForReview(input.actorUserId)",
  "lib/revisions.ts#supersedeDocument(input.actorUserId)",
  "lib/turnover.ts#reviewTurnoverItem(input.actor.uid)",              // N8 (MON-11)
];
function actorSources(file: string, census: ActorCensus): { calls: number; sessions: number; passThroughs: string[]; offenders: string[] } {
  const { sf, line, supplied } = census.analyzer(file);
  const out = { calls: 0, sessions: 0, passThroughs: [] as string[], offenders: [] as string[] };
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : "";
      const arg = n.arguments[0];
      if (["notify", "notifyMany", "notifyChecked", "emit"].includes(callee) && arg && ts.isObjectLiteralExpression(arg)) {
        out.calls++;
        const v = supplied(arg, "actorUserId");
        if (v === "session") out.sessions++;
        else if (v.startsWith("pass:")) out.passThroughs.push(`${file}#${v.slice(5)}`);
        else if (v.startsWith("offender:")) out.offenders.push(`${file}:${line(n)} actorUserId: ${v.slice(9)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
/** The browser's source files (the route files and the orchestrator's tools write on the service role). */
const browserFiles = () => sourceFiles().map((f) => relative(ROOT, f)).filter((rel) => !rel.startsWith("app/api/") && !ACTOR_SERVER_FILES.includes(rel));
let BROWSER_CENSUS: ActorCensus | undefined;
const browserCensus = (): ActorCensus => {
  if (!BROWSER_CENSUS) BROWSER_CENSUS = actorCensus(browserFiles(), (rel) => readFileSync(join(ROOT, rel), "utf8"));
  return BROWSER_CENSUS;
};
/** A census over fixture sources (file name → text). */
const fixtureCensus = (files: Record<string, string>) => actorCensus(Object.keys(files), (rel) => files[rel]);
const ROLE_IMPORT = 'import { useRole } from "@/components/providers/RoleContext";';

describe("rule 1's obligation on the producers — a browser row names the signed-in member as its actor, or no actor (third review fix)", () => {
  it("every browser producer passes no actor, the signed-in member (traced to its declaration), or a pinned pass-through — never a stored uid", () => {
    const census = browserCensus();
    let calls = 0, sessions = 0;
    const pass = new Set<string>();
    const offenders: string[] = [];
    for (const rel of browserFiles()) {
      if (rel === "lib/notify/dispatch.ts" || rel === "lib/inAppNotifications.ts") continue;
      if (!/\b(?:notify|notifyMany|notifyChecked|emit)\(/.test(readFileSync(join(ROOT, rel), "utf8"))) continue;
      const r = actorSources(rel, census);
      calls += r.calls;
      sessions += r.sessions;
      r.passThroughs.forEach((x) => pass.add(x));
      offenders.push(...r.offenders);
    }
    expect(calls).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
    // each traced to RoleContext's uid: directly, or through a prop / parameter every caller fills with it
    expect(sessions).toBeGreaterThanOrEqual(9);
    expect([...pass].sort()).toEqual([...ACTOR_PASS_THROUGHS].sort());
  }, 60_000); // a whole-repo AST census: given room under a loaded full-suite run (integrator, N5 merge)

  it("one hop up: every call of a pinned pass-through supplies no actor, the signed-in member, or a pinned forward of its own caller's value — never a stored uid", () => {
    const census = browserCensus();
    const files = browserFiles();
    let judged = 0, sessions = 0;
    const offenders: string[] = [];
    const forwarded = new Set<string>();
    for (const key of ACTOR_PASS_THROUGHS) {
      const m = key.match(/^(.+)#(\w+)\((.+)\)$/)!;
      const [, file, fn, chain] = m;
      const [param, ...path] = chain.split(".");
      // the parameter's position in the function's own declaration
      const decl = census.analyzer(file).sf;
      let index = -1;
      const findDecl = (n: ts.Node) => {
        const f = ts.isFunctionDeclaration(n) && n.name?.text === fn ? n
          : ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === fn && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) ? n.initializer : undefined;
        if (f) index = f.parameters.findIndex((p) => p.name.getText(decl) === param);
        ts.forEachChild(n, findDecl);
      };
      findDecl(decl);
      expect(index, `${key}: parameter found`).toBeGreaterThanOrEqual(0);
      for (const rel of files) {
        const src = readFileSync(join(ROOT, rel), "utf8");
        if (!new RegExp(`\\b${fn}\\(`).test(src)) continue;
        const { sf, line, judge, supplied } = census.analyzer(rel);
        const visit = (n: ts.Node) => {
          if (ts.isCallExpression(n) && (ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : "") === fn) {
            const arg = n.arguments[index];
            let v: string;
            if (!path.length || !arg) v = judge(arg);
            else if (ts.isObjectLiteralExpression(arg)) v = supplied(arg, path[0], path.slice(1));
            else v = judge(arg, path);   // the caller forwards its whole argument
            judged++;
            if (v === "session") sessions++;
            if (v.startsWith("pass:")) forwarded.add(`${rel}#${v.slice(5)}`);
            if (v.startsWith("offender:")) offenders.push(`${rel}:${line(n)} ${fn}(… ${path.join(".") || param}: ${v.slice(9)})`);
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
      }
    }
    expect(judged).toBeGreaterThan(40);
    expect(offenders).toEqual([]);
    expect(sessions).toBeGreaterThanOrEqual(17);   // each traced to RoleContext's uid
    expect([...forwarded].sort()).toEqual([...ACTOR_CALLER_PASS_THROUGHS].sort());
  }, 60_000);

  it("the anchor (fix pass 4): RoleContext's uid is the auth session's user — it is set from session.user or cleared, nothing else, and useRole() returns it", () => {
    const { sf } = browserCensus().analyzer(`${ROLE_CONTEXT}.tsx`);
    const sets: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "setUid") {
        const arg = n.arguments[0]?.getText(sf);
        // `u.id` is read with the nearest earlier `const u` in an enclosing block
        let u: string | undefined;
        for (let p: ts.Node | undefined = n.parent; p && u === undefined; p = p.parent) {
          if (!ts.isBlock(p)) continue;
          for (const st of p.statements) {
            if (st.pos >= n.pos || !ts.isVariableStatement(st)) continue;
            for (const d of st.declarationList.declarations) if (d.name.getText(sf) === "u") u = d.initializer?.getText(sf);
          }
        }
        sets.push(arg === "null" ? "null" : `${arg} where u = ${u}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(sets.length).toBeGreaterThanOrEqual(4);
    expect([...new Set(sets)].sort()).toEqual(["null", "u.id where u = session.user"]);
    const text = squash(sf.getText());
    expect(text).toContain("const [uid, setUid] = useState<string | null>(null);");
    expect(text).toMatch(/const value = useMemo<RoleContextValue>\( \(\) => \(\{[^}]* userEmail, uid, activeOrgId,/);
    expect(text).toContain("export function useRole() { const ctx = useContext(RoleContext); if (!ctx) throw new Error(\"useRole must be used within RoleProvider\"); return ctx; }");
  });

  it("the census is not vacuous: a stored uid, a callback's parameter, a spread row and a call are offenders; the session, a named function's parameter (by name or by spread) and no actor are not", () => {
    const census = fixtureCensus({ "probe.ts": [
      ROLE_IMPORT,
      'function a() { const doc = docs[0]; notify({ orgId, userId, kind, title, actorUserId: doc.owner_user_id }); }', // a stored uid
      'function b() { rows.forEach((r) => notifyMany({ userIds, actorUserId: r.requested_by })); }',            // a callback's parameter
      'function c() { emit({ orgId, ...row }); }',                                                              // a stored row, spread
      'function d() { notify({ actorUserId: pickActor() }); }',                                                 // a call
      'function e() { const who = hold.opened_by; notify({ actorUserId: who }); }',                             // a stored uid, by name
      'function f() { const { uid } = useRole(); notify({ actorUserId: uid ?? undefined }); emit({ actorUserId: useRole().uid }); }', // the session
      'function g(input: { requesterId: string }) { notify({ actorUserId: input.requesterId }); }',             // a pass-through
      'const h = async ({ actor }: { actor: string }) => { const { id } = { id: actor }; notifyMany({ actorUserId: actor }); };',
      'function k() { notify({ kind, title }); notify({ actorUserId: null }); }',                               // no actor: stamped
      'function m(input: I) { const { uid } = useRole(); void emit({ ...input, kind }); notify({ actorUserId: uid ?? "unknown" }); }', // forwarded by spread; a literal fallback
      'function n(doc: D) { notify({ actorUserId: doc.owner_user_id }); }',                                     // a NEW pass-through: the ratchet lists it for review
    ].join("\n") });
    const probe = actorSources("probe.ts", census);
    expect(probe.calls).toBe(14);
    expect(probe.sessions).toBe(3);
    expect(probe.offenders).toEqual([
      "probe.ts:2 actorUserId: docs[0].owner_user_id",
      "probe.ts:3 actorUserId: r.requested_by",
      "probe.ts:4 actorUserId: row.actorUserId",
      "probe.ts:5 actorUserId: pickActor()",
      "probe.ts:6 actorUserId: hold.opened_by",
    ]);
    expect(probe.passThroughs).toEqual(["probe.ts#g(input.requesterId)", "probe.ts#h({ actor })", "probe.ts#m(input.actorUserId)", "probe.ts#n(doc.owner_user_id)"]);
    // and one hop up, a caller that hands a pass-through a stored uid is judged an offender
    const caller = fixtureCensus({ "caller.ts": `${ROLE_IMPORT}\nasync function p() { const { uid } = useRole(); const doc = await load(); requestDeletion({ documentId, requesterId: doc.owner_user_id }); requestDeletion({ documentId, requesterId: uid }); }` }).analyzer("caller.ts");
    const calls: ts.CallExpression[] = [];
    const collect = (n: ts.Node) => { if (ts.isCallExpression(n) && n.expression.getText(caller.sf) === "requestDeletion") calls.push(n); ts.forEachChild(n, collect); };
    collect(caller.sf);
    expect(calls.map((c) => caller.supplied(c.arguments[0] as ts.ObjectLiteralExpression, "requesterId"))).toEqual(["offender:await load().owner_user_id", "session"]);
  });

  it("fix pass 4: a uid is the signed-in member by its declaration, never its spelling — a shadowed, stored, callback, unresolved or mis-fed uid is an offender; useRole()'s, and a prop every caller fills with it, are not", () => {
    const census = fixtureCensus({ "probe.tsx": [
      ROLE_IMPORT,
      'function a() { const { uid } = useRole(); docs.forEach((d) => { const uid = d.owner_user_id; notify({ actorUserId: uid }); }); }', // shadowed by a row's field
      'function b() { rows.forEach((uid) => notify({ actorUserId: uid })); }',                     // a callback's parameter named uid
      'function c() { const { uid } = ticket; emit({ actorUserId: uid }); }',                       // destructured from a row
      'function d() { notify({ actorUserId: uid }); emit({ actorUserId: currentUser.uid }); notify({ actorUserId: currentUserId }); }', // spelled right, declared nowhere
      'function e() { const { uid } = useOtherHook(); notify({ actorUserId: uid }); }',             // another source's uid
      'function Panel({ currentUserId }: P) { notify({ actorUserId: currentUserId }); }',            // a prop: its callers decide ...
      'function Page() { const doc = useDoc(); return <Panel currentUserId={doc.owner_user_id} />; }', // ... and one fills it with a stored uid
      'function Card({ currentUser }: C) { emit({ actorUserId: currentUser.uid }); }',
      'function Board() { const { uid } = useRole(); return <><Card currentUser={{ uid, email }} /><Card currentUser={{ uid: ticket.requester_id }} /></>; }',
      'function Orphan({ uid }: O) { notify({ actorUserId: uid }); }',                               // a prop nothing renders
      'function notifyAs(uid: string) { notify({ actorUserId: uid }); }',                            // a positional parameter named uid ...
      'function later() { notifyAs(row.created_by); }',                                             // ... called with a stored uid
      // the signed-in member, by declaration
      'function s1() { const { uid } = useRole(); notify({ actorUserId: uid }); }',
      'function Good({ uid }: G) { notify({ actorUserId: uid }); }',
      'function Host() { const { uid } = useRole(); return <><Good uid={uid || null} /><Good /></>; }', // filled with RoleContext's uid, or not passed (no actor: stamped)
    ].join("\n") });
    const r = actorSources("probe.tsx", census);
    expect(r.calls).toBe(13);
    expect(r.offenders).toEqual([
      "probe.tsx:2 actorUserId: d.owner_user_id",
      "probe.tsx:3 actorUserId: uid",
      "probe.tsx:4 actorUserId: ticket.uid",
      "probe.tsx:5 actorUserId: uid",
      "probe.tsx:5 actorUserId: currentUser.uid",
      "probe.tsx:5 actorUserId: currentUserId",
      "probe.tsx:6 actorUserId: useOtherHook().uid",
      "probe.tsx:7 actorUserId: currentUserId ← probe.tsx:8 useDoc().owner_user_id",
      "probe.tsx:9 actorUserId: currentUser.uid ← probe.tsx:10 ticket.requester_id",
      "probe.tsx:11 actorUserId: uid (a parameter of Orphan, which nothing calls)",
      "probe.tsx:12 actorUserId: uid ← probe.tsx:13 row.created_by",
    ]);
    expect(r.sessions).toBe(2);
    expect(r.passThroughs).toEqual([]);
    // useRole() is the anchor only when it is RoleContext's hook
    const local = fixtureCensus({ "local.ts": 'const useRole = () => ({ uid: stored.owner_user_id });\nfunction f() { const { uid } = useRole(); notify({ actorUserId: uid }); }' });
    expect(actorSources("local.ts", local).offenders).toEqual(["local.ts:2 actorUserId: useRole().uid"]);
    // a component rendered from another file counts only where that file imports it from the defining module
    const across = fixtureCensus({
      "components/Panel.tsx": 'export default function Panel({ currentUserId }: P) { notify({ actorUserId: currentUserId }); }',
      "app/page.tsx": `${ROLE_IMPORT}\nimport Panel from "@/components/Panel";\nexport default function Page() { const { uid } = useRole(); return <Panel currentUserId={uid} />; }`,
      "app/other.tsx": 'import Panel from "@/components/SomeOtherPanel";\nfunction Other() { return <Panel currentUserId={doc.owner_user_id} />; }',
    });
    expect(actorSources("components/Panel.tsx", across)).toEqual({ calls: 1, sessions: 1, passThroughs: [], offenders: [] });
  });
});

describe("REGRESSION census — every app write to notifications fits the read_at-only rail", () => {
  const writes: Array<{ file: string; op: string; text: string }> = [];
  for (const f of sourceFiles()) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\.from\((["'])notifications\1\)([\s\S]{0,160})/g)) {
      const op = m[2].match(/^\s*\.(insert|update|delete|upsert|select)\(/)?.[1] ?? "other";
      writes.push({ file: relative(ROOT, f), op, text: m[2] });
    }
  }

  it("the census sees the app's notification calls (sanity)", () => {
    expect(writes.filter((w) => w.op === "insert").length).toBeGreaterThan(5);
    expect(writes.filter((w) => w.op === "update").length).toBeGreaterThanOrEqual(4);
  });

  it("every UPDATE writes read_at and nothing else (mark one / many / all read, the ticket page's clear)", () => {
    const bad = writes.filter((w) => w.op === "update" && !/^\s*\.update\(\{\s*read_at: new Date\(\)\.toISOString\(\)\s*\}\)/.test(w.text));
    expect(bad.map((w) => `${w.file}: ${w.text.slice(0, 80)}`)).toEqual([]);
  });

  it("no app insert into notifications sets created_at — 20261160's date stamp changes nothing the app writes", () => {
    let examined = 0;
    const offenders: string[] = [];
    for (const f of sourceFiles()) {
      const src = readFileSync(f, "utf8");
      if (!/\.from\((["'])notifications\1\)\s*\.insert\(/.test(src)) continue;
      const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const decls = new Map<string, ts.Node>();
      const collect = (n: ts.Node) => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) decls.set(n.name.text, n.initializer);
        ts.forEachChild(n, collect);
      };
      collect(sf);
      const setsCreatedAt = (n: ts.Node): boolean =>
        (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && n.name.getText(sf).replace(/["']/g, "") === "created_at"
          ? true : ts.forEachChild(n, setsCreatedAt) ?? false;
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "insert"
            && /\.from\((["'])notifications\1\)$/.test(n.expression.expression.getText(sf))) {
          const arg = n.arguments[0];
          const target = arg && ts.isIdentifier(arg) ? decls.get(arg.text) : arg;
          expect(target, `${relative(ROOT, f)}: insert argument resolved`).toBeTruthy();
          examined++;
          if (target && setsCreatedAt(target)) offenders.push(relative(ROOT, f));
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    // N8 (TAX-11 done-when 2): five raw calls moved onto the typed sink
    // (the transmittal portal's two, the checkout sweep's, and — N8's review
    // fix — the export alert's and the folded intake digest's), so six raw
    // calls and the sink's two inserts (notifyWithReason, and
    // notifyBatchWithReason) are examined
    expect(examined).toBeGreaterThanOrEqual(8);
    expect(offenders).toEqual([]);
  });

  it("no app path deletes or upserts notification rows (the admin purge is the service role's)", () => {
    expect(writes.filter((w) => w.op === "delete" || w.op === "upsert").map((w) => w.file)).toEqual([]);
  });
});
