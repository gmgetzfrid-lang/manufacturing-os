// DRLS-16 (CRITICAL): a SECURITY DEFINER function that lets a NULL
// auth.uid() through — the service role, but also anon — must not be
// executable by anon. Supabase's default privileges grant EXECUTE on every
// new function in `public` to anon explicitly, and `REVOKE … FROM PUBLIC`
// does not remove that grant, so the only safe shapes are:
//   (a) the body refuses a NULL uid (`IF <uid> IS NULL THEN RAISE …`), or
//   (b) a migration at or after the function's newest definition revokes
//       EXECUTE from anon on it.
// This test reads the numbered migration sequence (textually — there is no
// live database here; the live sweep is 20261129's final SELECT) and refuses
// any non-trigger SECURITY DEFINER function that tests a uid for NULL and has
// neither shape. It also pins the hotfix itself.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "supabase", "migrations");
const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const text = new Map(files.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
const HOTFIX = "20261129_dc_hotfix_anon_execute.sql";
const M129 = text.get(HOTFIX)!;

const FN = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\)\s*RETURNS\s+(\w+)([\s\S]*?)AS\s+(\$\w*\$)([\s\S]*?)\5/gi;

type Def = { file: string; at: number; returns: string; secdef: boolean; body: string };

/** Each function name's NEWEST definition in migration order. */
function newestDefinitions(): Map<string, Def> {
  const out = new Map<string, Def>();
  for (const f of files) {
    const s = text.get(f)!;
    for (const m of s.matchAll(FN)) {
      const after = m[4] + s.slice(m.index! + m[0].length, m.index! + m[0].length + 200);
      out.set(m[1].toLowerCase(), {
        file: f,
        at: m.index!,
        returns: m[3].toLowerCase(),
        secdef: /SECURITY\s+DEFINER/i.test(after),
        body: m[6],
      });
    }
  }
  return out;
}

/** The uid expressions a body reads: auth.uid() itself, and every variable it is assigned to. */
function uidExprs(body: string): string[] {
  const vars = [
    ...body.matchAll(/(\w+)\s+uuid\s*(?::=|DEFAULT)\s*auth\.uid\(\)/gi),
    ...body.matchAll(/(\w+)\s*:=\s*auth\.uid\(\)/gi),
  ].map((m) => m[1]);
  return ["auth\\.uid\\(\\)", ...new Set(vars)];
}
/** Only expressions that ARE the session uid on every path: auth.uid() itself, or a variable
 *  DECLAREd with it as its initializer. A parameter conditionally set from it (publish_revision's
 *  `p_actor := auth.uid()` inside `IF auth.uid() IS NOT NULL`) is not — refusing a NULL p_actor
 *  still lets a NULL uid through with a named actor. */
function sessionUidExprs(body: string): string[] {
  const declared = [...body.matchAll(/(\w+)\s+uuid\s*(?::=|DEFAULT)\s*auth\.uid\(\)/gi)].map((m) => m[1]);
  return ["auth\\.uid\\(\\)", ...new Set(declared)];
}
const testsUidForNull = (body: string) =>
  uidExprs(body).some((e) => new RegExp(`(?<![\\w.])${e}\\s+IS\\s+(?:NOT\\s+)?NULL`, "i").test(body));
// `\bIF` — an ELSIF branch is reached only after an earlier branch passed, so it is not a refusal.
const refusesNullUid = (body: string) =>
  sessionUidExprs(body).some((e) => new RegExp(`\\bIF\\s+${e}\\s+IS\\s+NULL\\s+THEN\\s+RAISE`, "i").test(body));

/** A REVOKE … anon naming `name` (directly, or in 20261129's pg_proc loop) at or after the newest definition. */
function anonRevokedAfter(name: string, def: Def): string | null {
  const direct = new RegExp(`REVOKE[^;]*\\b${name}\\b[^;]*\\banon\\b`, "gi");
  for (const f of files) {
    if (f < def.file) continue;
    const s = text.get(f)!;
    for (const m of s.matchAll(direct)) {
      if (f > def.file || m.index! > def.at) return f;
    }
    if (f === HOTFIX && new RegExp(`proname IN \\([^)]*'${name}'`).test(s)) return f;
  }
  return null;
}

describe("DRLS-16: no SECURITY DEFINER function with a NULL-uid branch is executable by anon", () => {
  const defs = newestDefinitions();
  const exposed = [...defs.entries()]
    .filter(([, d]) => d.secdef && d.returns !== "trigger" && testsUidForNull(d.body))
    .filter(([n, d]) => !refusesNullUid(d.body) && !anonRevokedAfter(n, d))
    .map(([n, d]) => `${n} (newest definition ${d.file})`);

  it("every non-trigger SECURITY DEFINER function that tests a uid for NULL refuses it or revokes anon", () => {
    expect(exposed).toEqual([]);
  });

  it("the scan sees the functions it is about (a parser that matched nothing would pass vacuously)", () => {
    for (const n of ["publish_revision", "post_ticket_comment", "force_release_document", "revoke_member"]) {
      const d = defs.get(n);
      expect(d, n).toBeDefined();
      expect(d!.secdef, `${n} is SECURITY DEFINER`).toBe(true);
      expect(testsUidForNull(d!.body), `${n} tests a uid for NULL`).toBe(true);
    }
    // the two that refuse a NULL uid need no revoke; the two that let it through do
    expect(refusesNullUid(defs.get("force_release_document")!.body)).toBe(true);
    expect(refusesNullUid(defs.get("revoke_member")!.body)).toBe(true);
    expect(refusesNullUid(defs.get("post_ticket_comment")!.body)).toBe(false);
    // publish_revision lets a NULL uid name its actor (the service-role path), so it is NOT a
    // refuser — its `ELSIF p_actor IS NULL THEN RAISE` must not read as one — and it passes only
    // because 20261130 revokes anon after re-creating it.
    expect(refusesNullUid(defs.get("publish_revision")!.body)).toBe(false);
    expect(anonRevokedAfter("publish_revision", defs.get("publish_revision")!)).toBe(
      "20261130_dc_roundF_publish_override_reason.sql",
    );
  });

  it("post_ticket_comment's only anon revoke is the hotfix (its newest body, 20260810, never revoked anon)", () => {
    expect(anonRevokedAfter("post_ticket_comment", defs.get("post_ticket_comment")!)).toBe(HOTFIX);
  });
});

describe("20261129 hotfix shape", () => {
  const code = M129.replace(/--[^\n]*/g, "");

  it("loops over every overload of both functions by name, so whatever signature is live is covered", () => {
    expect(code).toMatch(/p\.proname IN \('publish_revision', 'post_ticket_comment'\)/);
    expect(code).toMatch(/n\.nspname = 'public'/);
  });

  it("restates the legitimate grants before it revokes anon and PUBLIC", () => {
    const grant = code.indexOf("GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role");
    const anon = code.indexOf("REVOKE EXECUTE ON FUNCTION %s FROM anon");
    const pub = code.indexOf("REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC");
    expect(grant).toBeGreaterThan(0);
    expect(anon).toBeGreaterThan(grant);
    expect(pub).toBeGreaterThan(grant);
  });

  it("writes in one transaction and ends with a single result set", () => {
    expect(code.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(code.match(/^COMMIT;/gm)).toHaveLength(1);
    const tail = code.slice(code.indexOf("COMMIT;"));
    // one statement after COMMIT: the SELECT … UNION ALL … sweep
    expect(tail.slice("COMMIT;".length).split(";").filter((s) => s.trim()).length).toBe(1);
  });

  it("probes anon refused, the legitimate roles kept, and lists the live sweep", () => {
    expect(code).toMatch(/has_function_privilege\('anon', p\.oid, 'EXECUTE'\)\) AS ok/);
    expect(code).toMatch(/NOT has_function_privilege\('authenticated', p\.oid, 'EXECUTE'\)/);
    expect(code).toMatch(/NOT has_function_privilege\('service_role', p\.oid, 'EXECUTE'\)/);
    expect(code).toMatch(/p\.prosecdef\s+AND has_function_privilege\('anon', p\.oid, 'EXECUTE'\)/);
  });

  it("sorts before 20261130, which re-creates publish_revision under a new signature with its own anon revoke", () => {
    expect(HOTFIX < "20261130_dc_roundF_publish_override_reason.sql").toBe(true);
    expect(text.get("20261130_dc_roundF_publish_override_reason.sql")).toMatch(
      /REVOKE ALL ON FUNCTION publish_revision\([^)]*\) FROM PUBLIC, anon;/,
    );
  });
});
