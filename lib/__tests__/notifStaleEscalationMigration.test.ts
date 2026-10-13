// notifications Round G — N15 RECIPIENT VISIBILITY AND NAMES, the database
// half: supabase/migrations/20261206_notif_roundG_stale_escalation_kind.sql.
//
//   · TAX-17: notification_kinds() re-created from its NEWEST definition
//     (found by scanning the sequence below this file) with exactly ONE row
//     added — checkout_stale_escalation, in KIND_META order, with the
//     registry's compliance flag — nothing removed (lineDiff); the
//     escalation's backlog re-filed by its discriminator (staleSessionId);
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
    expect(branches).toHaveLength(4);
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

  it("states the paste / deploy order: deploy first, then paste (the old cron's dedupe reads checkout_released only)", () => {
    expect(SQL).toMatch(/DEPLOY the N15 app FIRST, then paste this file/);
  });
});

describe("20261206 — notification_kinds() from its NEWEST definition, plus checkout_stale_escalation (TAX-17)", () => {
  const before = definitionsOf("notification_kinds", FILES.filter((f) => f < FILE)).at(-1)!;
  const mine = definitionsOf("notification_kinds", [FILE]);

  it("the newest earlier definition is found by scanning the sequence (today 20261191), and this file defines it once", () => {
    expect(before[0]).toBe("20261191_notif_roundG_kind_split.sql");
    expect(mine).toHaveLength(1);
  });

  it("removes no line and adds exactly the one row, right after checkout_released, with the registry's flag", () => {
    const d = lineDiff(before[1], mine[0][1]);
    expect(d.onlyInA).toEqual([]);
    expect(d.onlyInB.map((l) => l.trim())).toEqual([`('checkout_stale_escalation',        ${KIND_META.checkout_stale_escalation.compliance}),`]);
    const kinds = valuesOf(mine[0][1]).map(([k]) => k);
    expect(kinds.indexOf("checkout_stale_escalation")).toBe(kinds.indexOf("checkout_released") + 1);
  });

  it("the new kind carries checkout_released's flags (an action, not a compliance kind) — no badge, digest or dismiss rule moves", () => {
    const { section, actionRequired, compliance, icon, tone, group } = KIND_META.checkout_released;
    expect(KIND_META.checkout_stale_escalation).toEqual({ section, actionRequired, compliance, icon, tone, group });
  });

  it("its own probe states its own list's counts", () => {
    const values = valuesOf(mine[0][1]);
    const n = values.length, c = values.filter(([, x]) => x).length;
    expect(n).toBe(valuesOf(before[1]).length + 1);
    expect(SQL).toContain(`COUNT(*) = ${n} AND COUNT(DISTINCT kind) = ${n} AND COUNT(*) FILTER (WHERE compliance) = ${c}`);
  });

  it("re-files ONLY the escalation's rows (staleSessionId) — a pre-N9 force-release row keeps its kind", () => {
    expect(CODE).toMatch(/UPDATE notifications SET kind = 'checkout_stale_escalation'\s+WHERE kind = 'checkout_released' AND metadata \? 'staleSessionId';/);
    expect(CODE.match(/UPDATE notifications/g)).toHaveLength(1);
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
  it("the app asks it with the same argument names", () => {
    const src = readFileSync(join(process.cwd(), "lib/complianceNotify.ts"), "utf8");
    expect(src).toMatch(/rpc\("notification_i_wrote", \{\s*p_org: input\.orgId, p_user: input\.userId, p_kind: input\.kind, p_title: input\.title,\s*p_resource_id: input\.resourceId \?\? null, p_since: sinceIso,\s*\}\)/);
  });
});
