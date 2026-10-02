// notifications Round G — N5 DISPATCH-AND-WRITE-HOLES, the database half.
//
//   20261160 (migration A) — the write rails: enforce_notification_insert()
//     and the kind allowlist notification_kinds() (OS-1, DELIV-6, DEC-44 (N5)).
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
import { join, relative } from "node:path";
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
 *  migration order, as [file, text-from-CREATE-to-closing-$$;]. */
function definitionsOf(name: string, before?: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${name}\\s*\\(`, "g");
  for (const f of FILES) {
    if (before && f >= before) continue;
    const s = read(f);
    for (const m of s.matchAll(re)) {
      // skip a CREATE inside a -- comment line
      const lineStart = s.lastIndexOf("\n", m.index!) + 1;
      if (/^\s*--/.test(s.slice(lineStart, m.index!))) continue;
      const end = s.indexOf("$$;", s.indexOf("$$", m.index!) + 2);
      out.push([f, s.slice(m.index!, end + 3)]);
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
 *  ending in `.link` (input.link, n.link, d.link) is a pass-through too.
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
    // the paste's own probe states the same two numbers
    expect(A).toContain(`COUNT(*) = ${values.length} AND COUNT(DISTINCT kind) = ${values.length} AND COUNT(*) FILTER (WHERE compliance) = ${compliance}`);
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

  it("runs its rules in order: caller's membership → actor + date → kind (declared, not server-only) → link → watermark keys → recipient → resource key → lock → caps", () => {
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
      at("PERFORM pg_advisory_xact_lock("),
      at("IF v_same >= 60 THEN"),
      at("IF v_any >= 600 THEN"),
      at("IF v_hour >= 1200 THEN"),
      at("IF v_actor >= 3000 THEN"),
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

  it("REVIEW (concurrency): one actor's inserts are counted one after another — a transaction-scoped advisory lock keyed on the actor, after the skip and before every count", () => {
    const lock = "PERFORM pg_advisory_xact_lock(hashtextextended('notif-cap:' || v_uid::text, 0));";
    expect(body).toContain(lock);
    const code = strip(body);
    // one lock per row, one key per actor: a transaction holds a single key, so two inserts can
    // never take the same pair of locks in opposite orders; a different actor never waits
    expect(code.match(/pg_advisory/g)).toHaveLength(1);
    expect(code).not.toMatch(/pg_advisory_lock\(|pg_try_advisory/);          // transaction-scoped, never left held
    expect(code.indexOf(lock)).toBeGreaterThan(code.indexOf("RETURN NULL;")); // a skipped row takes no lock
    expect(code.indexOf(lock)).toBeLessThan(code.indexOf("INTO v_same, v_any, v_hour"));
    expect(code.indexOf(lock)).toBeLessThan(code.indexOf("SELECT COUNT(*) INTO v_actor"));
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
 *  from a signed-in writer. `none`: not a dedupe (says why). */
const DEDUPE_READS: Record<string, Array<{ marks: string; keys?: string[]; kinds?: string[]; none?: string }>> = {
  "app/api/cron/maintenance/route.ts": [
    { marks: '.contains("metadata", { staleSessionId: row.id })', keys: ["staleSessionId"] },
    { marks: '.in("kind", COMPLIANCE_KINDS)', none: "the compliance digest composes each recipient's list from their compliance rows: a forged row adds a line to someone's digest, never removes one" },
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
const BELL_READERS = ["components/dashboard/widgets.tsx", "lib/inAppNotifications.ts", "lib/inbox.ts"];
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
      for (const e of entries) {
        if (e.none) { expect(e.keys ?? e.kinds).toBeUndefined(); continue; }
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
// and when (seconds). The service role never reaches the caps. Rows are
// judged one after another — what the actor-keyed advisory lock makes true
// of concurrent requests too (on PostgreSQL 16, 90 concurrent single-row
// inserts of one notice from one actor landed 90 without the lock, 60 with it).
type Sent = { actor: string; to: string; kind: string; res: string | null; resOk: boolean; t: number };
const CAP = { same: 60, anyMinute: 600, anyHour: 1200, actorMinute: 3000 };
function capVerdict(log: Sent[], row: Omit<Sent, "t">, now: number): "ok" | "same" | "any" | "hour" | "actor" {
  const mine = log.filter((r) => r.actor === row.actor);
  const toThemThisHour = mine.filter((r) => r.to === row.to && r.t > now - 3600);
  const toThemThisMinute = toThemThisHour.filter((r) => r.t > now - 60);
  const same = toThemThisMinute.filter((r) => r.kind === row.kind && (!row.resOk || r.res === row.res)).length;
  if (same >= CAP.same) return "same";
  if (toThemThisMinute.length >= CAP.anyMinute) return "any";
  if (toThemThisHour.length >= CAP.anyHour) return "hour";
  if (mine.filter((r) => r.t > now - 60).length >= CAP.actorMinute) return "actor";
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
    expect(examined).toBeGreaterThanOrEqual(10);
    expect(offenders).toEqual([]);
  });

  it("no app path deletes or upserts notification rows (the admin purge is the service role's)", () => {
    expect(writes.filter((w) => w.op === "delete" || w.op === "upsert").map((w) => w.file)).toEqual([]);
  });
});
