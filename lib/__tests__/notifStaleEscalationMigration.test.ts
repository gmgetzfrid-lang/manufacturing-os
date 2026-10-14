// notifications Round G — N15 RECIPIENT VISIBILITY AND NAMES, the database
// half: supabase/migrations/20261206_notif_roundG_stale_escalation_kind.sql.
//
//   · TAX-17 / PROD-17: notification_kinds() re-created from its NEWEST
//     definition (found by scanning the sequence below this file) with
//     exactly THREE rows added — checkout_stale_escalation,
//     checkout_force_released_fyi and doc_retired, in KIND_META order, with the registry's compliance flags — nothing removed
//     (lineDiff); the escalation's backlog re-filed by its discriminator
//     (staleSessionId) — fix pass 3: only rows whose session is no longer
//     active, so the file is pasted BEFORE the deploy (the old cron's
//     dedupe still finds an active session's row);
//   · the guard stops without 20261160 AND without 20261191 (its kinds);
//   · DELIV-16: notification_i_wrote(...) — SECURITY DEFINER, search_path
//     pinned, EXECUTE to authenticated only (DRLS-16), a boolean about the
//     caller's own rows only;
//   · the DEC-30 one-paste shape.
// Exercised on a throwaway PostgreSQL 16 (records, TAX-17 / DELIV-16).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KIND_META } from "@/lib/notificationKinds";

const DIR = join(process.cwd(), "supabase", "migrations");
const FILE = "20261206_notif_roundG_stale_escalation_kind.sql";
const FILES = readdirSync(DIR).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const SQL = read(FILE);
const strip = (sql: string) => sql.replace(/--[^\n]*/g, "");
const CODE = strip(SQL);

function definitionsOf(name: string, files: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${name}\\s*\\(`, "g");
  for (const f of files) {
    const s = read(f);
    for (const m of s.matchAll(re)) {
      const lineStart = s.lastIndexOf("\n", m.index!) + 1;
      if (/^\s*--/.test(s.slice(lineStart, m.index!))) continue;
      const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/g;
      open.lastIndex = m.index!;
      const tag = open.exec(s)!;
      const end = s.indexOf(tag[0], tag.index + tag[0].length);
      out.push([f, s.slice(m.index!, end + tag[0].length + 1)]);
    }
  }
  return out;
}
const lineDiff = (a: string, b: string) => {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
};
const valuesOf = (body: string) => [...body.matchAll(/\('(\w+)',\s*(true|false)\)/g)].map((m) => [m[1], m[2] === "true"] as const);

describe("20261206 — one paste for the SQL editor (DEC-30)", () => {
  it("opens with a header; stops first when 20261160 is missing; inventory in a TEMP table BEFORE the one BEGIN … COMMIT", () => {
    expect(SQL.startsWith("-- ─")).toBe(true);
    const guard = CODE.indexOf("RAISE EXCEPTION '20261206 needs 20261160");
    const temp = CODE.indexOf("CREATE TEMP TABLE notif_round_g_206_before");
    expect(guard).toBeGreaterThan(0);
    expect(temp).toBeGreaterThan(guard);
    expect(CODE.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(CODE.match(/^COMMIT;/gm)).toHaveLength(1);
    expect(temp).toBeLessThan(CODE.indexOf("BEGIN;"));
  });

  it("ends with ONE statement after COMMIT: the (check, ok, n) probes, then the inventory rows", () => {
    const tail = CODE.slice(CODE.indexOf("COMMIT;") + "COMMIT;".length);
    const statements = tail.replace(/'(?:[^']|'')*'/g, "''").split(";").filter((x) => x.trim());
    expect(statements).toHaveLength(1);
    expect(tail).toMatch(/AS check,[\s\S]*?AS ok,\s*NULL::text AS n/);
    expect(tail).toMatch(/SELECT inventory, NULL::boolean, n FROM \(SELECT inventory, n FROM notif_round_g_206_before ORDER BY ord\) b;/);
  });

  it("the inventory is aggregate counts only — never a customer row", () => {
    const inv = CODE.slice(CODE.indexOf("CREATE TEMP TABLE"), CODE.indexOf("BEGIN;"));
    const branches = inv.split(/UNION ALL/);
    expect(branches).toHaveLength(5);
    for (const b of branches) expect(b).toMatch(/COUNT\(\*\)/);
    expect(inv).not.toMatch(/SELECT \*|\btitle\b|\bbody\b|actor_name|display_name|\bemail\b/i);
  });

  it("DRLS-16: every function pins search_path and is REVOKEd from PUBLIC and anon; the SECURITY DEFINER read is EXECUTE to authenticated only", () => {
    const defs = [...CODE.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(([\s\S]*?)\)\s*RETURNS[\s\S]*?AS \$\$/g)];
    expect(defs.map((d) => d[1])).toEqual(["notification_kinds", "notification_i_wrote"]);
    for (const d of defs) {
      expect(d[0], d[1]).toMatch(/SET search_path = public/);
      expect(CODE, d[1]).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${d[1]}\\([^)]*\\) FROM PUBLIC, anon;`));
      expect(CODE).not.toMatch(new RegExp(`GRANT[^;]*${d[1]}[^;]*\\b(anon|PUBLIC)\\b`));
    }
    expect(defs.filter((d) => /SECURITY DEFINER/.test(d[0])).map((d) => d[1])).toEqual(["notification_i_wrote"]);
    expect(CODE).toContain("GRANT EXECUTE ON FUNCTION notification_i_wrote(uuid, uuid, text, text, text, timestamptz) TO authenticated;");
  });

  it("never touches a notifications policy or a trigger (20261160 / 20261161 own them)", () => {
    expect(CODE).not.toMatch(/(?:DROP|CREATE|ALTER) POLICY/);
    expect(CODE).not.toMatch(/CREATE OR REPLACE FUNCTION enforce_notification_(insert|update)/);
    expect(CODE).not.toMatch(/DROP TRIGGER|CREATE TRIGGER/);
  });

  it("fix pass 3: states the paste / deploy order the brief asks — paste BEFORE the deploy (safe under the old cron: an active session's row is kept), the REQUIRED re-paste after it (fix pass 4), and what a late paste costs the two watcher FYIs — no bell row and no email", () => {
    expect(SQL).toMatch(/PASTE THIS FILE BEFORE THE DEPLOY of the N15 app/);
    expect(SQL).not.toMatch(/DEPLOY the N15 app FIRST/);
    // fix pass 4 (the integrator's ruling): the second paste is REQUIRED, after
    // the next maintenance run following the deploy — never "optional"
    expect(SQL).toMatch(/REQUIRED, after the\s*\n--\s+next maintenance run following the deploy \(fix pass 4 — the\s*\n--\s+integrator's ruling\): paste this file again/);
    expect(SQL).not.toMatch(/OPTIONAL, after the/);
    expect(SQL).toMatch(/doc_retired from the supersede door,\s*\n--\s+checkout_force_released_fyi from a force-release\) are declared kinds\s*\n--\s+from their first write/);
    expect(SQL).toMatch(/with emailOnlyWithBell, so a watcher whose bell row was refused gets\s*\n--\s+NO email either/);
  });

  it("the guard also stops when 20261191 has not been pasted (its notification_kinds() declares transmittal_issued and doc_recalled)", () => {
    const guard = CODE.slice(0, CODE.indexOf("CREATE TEMP TABLE"));
    expect(guard).toMatch(/IF NOT EXISTS \(SELECT 1 FROM notification_kinds\(\) k WHERE k\.kind = 'transmittal_issued'\)\s+OR NOT EXISTS \(SELECT 1 FROM notification_kinds\(\) k WHERE k\.kind = 'doc_recalled'\) THEN\s+RAISE EXCEPTION '20261206 needs 20261191/);
    // the 20261191 check runs only after the to_regprocedure check has passed (its own IF)
    expect(guard.indexOf("to_regprocedure('public.notification_kinds()')")).toBeLessThan(guard.indexOf("'transmittal_issued'"));
    const v191 = valuesOf(definitionsOf("notification_kinds", ["20261191_notif_roundG_kind_split.sql"])[0][1]).map(([k]) => k);
    const v181 = definitionsOf("notification_kinds", FILES.filter((f) => f < "20261191")).at(-1)!;
    expect(v191).toEqual(expect.arrayContaining(["transmittal_issued", "doc_recalled"]));
    expect(valuesOf(v181[1]).map(([k]) => k)).not.toContain("transmittal_issued");
  });
});

describe("20261206 — notification_kinds() from its NEWEST definition, plus checkout_stale_escalation (TAX-17), checkout_force_released_fyi and doc_retired (PROD-17)", () => {
  const before = definitionsOf("notification_kinds", FILES.filter((f) => f < FILE)).at(-1)!;
  const mine = definitionsOf("notification_kinds", [FILE]);

  it("the newest earlier definition is found by scanning the sequence (today 20261191), and this file defines it once", () => {
    expect(before[0]).toBe("20261191_notif_roundG_kind_split.sql");
    expect(mine).toHaveLength(1);
  });

  it("removes no line and adds exactly the three rows, each right after its neighbour in KIND_META, with the registry's flags", () => {
    const d = lineDiff(before[1], mine[0][1]);
    expect(d.onlyInA).toEqual([]);
    expect(d.onlyInB.map((l) => l.trim())).toEqual([
      `('checkout_stale_escalation',        ${KIND_META.checkout_stale_escalation.compliance}),`,
      `('checkout_force_released_fyi',      ${KIND_META.checkout_force_released_fyi.compliance}),`,
      `('doc_retired',                      ${KIND_META.doc_retired.compliance}),`,
    ]);
    const kinds = valuesOf(mine[0][1]).map(([k]) => k);
    expect(kinds.indexOf("checkout_stale_escalation")).toBe(kinds.indexOf("checkout_released") + 1);
    expect(kinds.indexOf("checkout_force_released_fyi")).toBe(kinds.indexOf("checkout_force_released") + 1);
    expect(kinds.indexOf("doc_retired")).toBe(kinds.indexOf("doc_recalled") + 1);
  });

  it("checkout_force_released_fyi is a lock notice under Locks — checkout_handoff's flags (an FYI, not an action, not compliance), never the thread's chat kind (fix pass)", () => {
    const { section, actionRequired, compliance, icon, tone, group, category } = KIND_META.checkout_handoff;
    // N4's toast category (merge, fix pass 4): watched_activity — its emit's 'watched', as checkout_handoff's
    expect(category).toBe("watched_activity");
    expect(KIND_META.checkout_force_released_fyi).toEqual({ section, actionRequired, compliance, icon, tone, group, category });
    expect(KIND_META.checkout_force_released_fyi.group).toBe("locks");
    expect(KIND_META.checkout_force_released_fyi.icon).toBe("Lock");
    expect(valuesOf(mine[0][1]).find(([k]) => k === "checkout_force_released_fyi")).toEqual(["checkout_force_released_fyi", false]);
  });

  it("doc_retired is doc_recalled's badge, icon and group but NOT a compliance kind (PROD-17: a watcher's FYI stays out of the digest and is deletable)", () => {
    const { section, actionRequired, icon, tone, group } = KIND_META.doc_recalled;
    expect(KIND_META.doc_recalled.compliance).toBe(true);
    // N4's toast category (merge, fix pass 4): the watcher's own — its emit's 'watched' (doc_recalled's is status_change)
    expect(KIND_META.doc_retired).toEqual({ section, actionRequired, compliance: false, icon, tone, group, category: "watched_activity" });
    expect(valuesOf(mine[0][1]).find(([k]) => k === "doc_retired")).toEqual(["doc_retired", false]);
  });

  it("the new kind carries checkout_released's flags (an action, not a compliance kind) — no badge, digest or dismiss rule moves", () => {
    const { section, actionRequired, compliance, icon, tone, group, category } = KIND_META.checkout_released;
    // N4's toast category too (merge, fix pass 4): sla_warning, as checkout_released
    expect(KIND_META.checkout_stale_escalation).toEqual({ section, actionRequired, compliance, icon, tone, group, category });
  });

  it("its own probe states its own list's counts", () => {
    const values = valuesOf(mine[0][1]);
    const n = values.length, c = values.filter(([, x]) => x).length;
    expect(n).toBe(valuesOf(before[1]).length + 3);
    expect(SQL).toContain(`COUNT(*) = ${n} AND COUNT(DISTINCT kind) = ${n} AND COUNT(*) FILTER (WHERE compliance) = ${c}`);
  });

  it("re-files ONLY the escalation's rows (staleSessionId) of a session no longer ACTIVE (fix pass 3) — a pre-N9 force-release row keeps its kind, and an active session's row stays where the old cron's dedupe reads it", () => {
    expect(CODE).toMatch(/UPDATE notifications n SET kind = 'checkout_stale_escalation'\s+WHERE n\.kind = 'checkout_released' AND n\.metadata \? 'staleSessionId'\s+AND NOT EXISTS \(SELECT 1 FROM checkout_sessions s\s+WHERE s\.id::text = n\.metadata->>'staleSessionId' AND s\.status = 'active'\);/);
    expect(CODE.match(/UPDATE notifications/g)).toHaveLength(1);
    // the old cron (app/api/cron/maintenance/route.ts on the base) scans only ACTIVE sessions — the rows it dedupes on are the ones kept
    expect(readFileSync(join(process.cwd(), "app/api/cron/maintenance/route.ts"), "utf8")).toMatch(/\.from\("checkout_sessions"\)\s*\.select\([^)]*\)\s*\.eq\("status", "active"\)/);
  });
});

describe("20261206 — notification_i_wrote(): a member confirms only their OWN notice landed (DELIV-16)", () => {
  const def = definitionsOf("notification_i_wrote", FILES);
  it("is defined once in the sequence, here, returns boolean, STABLE SECURITY DEFINER", () => {
    expect(def.map(([f]) => f)).toEqual([FILE]);
    expect(def[0][1]).toMatch(/RETURNS boolean\s*LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public/);
  });
  it("answers only for the caller (actor = auth.uid()), an active member of the org, a declared kind, at most an hour back", () => {
    const b = def[0][1];
    expect(b).toMatch(/auth\.uid\(\) IS NOT NULL/);
    expect(b).toMatch(/m\.org_id = p_org AND m\.uid = auth\.uid\(\) AND m\.status = 'active'/);
    expect(b).toMatch(/FROM notification_kinds\(\) k WHERE k\.kind = p_kind/);
    expect(b).toMatch(/n\.actor_user_id = auth\.uid\(\)/);
    expect(b).toMatch(/n\.title = p_title/);
    expect(b).toMatch(/n\.resource_id IS NOT DISTINCT FROM p_resource_id/);
    expect(b).toMatch(/GREATEST\(COALESCE\(p_since, now\(\)\), now\(\) - interval '1 hour'\)/);
    expect(b).not.toMatch(/SELECT\s+n\.\w+\s*,/); // never returns a row's columns
  });
  it("the schema-health probe is the INTEGRATOR's to add (fix pass 3: the brief keeps lib/schemaExpectations.ts out of this package; the probe's facts are in the report) — once added, it matches this function", async () => {
    const { EXPECTED_FUNCTIONS } = await import("@/lib/schemaExpectations");
    const f = EXPECTED_FUNCTIONS.find((x) => x.fn === "notification_i_wrote");
    if (!f) return; // not added on this branch, by design
    expect(f).toMatchObject({ signature: "notification_i_wrote(uuid, uuid, text, text, text, timestamptz)", migration: FILE });
    expect(f.probeArgs.p_org).toBe("schema-health-probe");
    expect(Object.keys(f.probeArgs).sort()).toEqual(["p_kind", "p_org", "p_resource_id", "p_since", "p_title", "p_user"]);
  });
  it("the app asks it with the same argument names", () => {
    const src = readFileSync(join(process.cwd(), "lib/complianceNotify.ts"), "utf8");
    expect(src).toMatch(/rpc\("notification_i_wrote", \{\s*p_org: input\.orgId, p_user: input\.userId, p_kind: input\.kind, p_title: input\.title,\s*p_resource_id: input\.resourceId \?\? null, p_since: sinceIso,\s*\}\)/);
  });
});
