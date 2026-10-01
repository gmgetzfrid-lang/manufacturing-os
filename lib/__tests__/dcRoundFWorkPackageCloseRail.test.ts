// document-control Round F wave 2 — P8 FIELD (fix pass): shape pins on
// 20261143, the work-package close rail (DRLS-10 done-when 2).
//
//   · work_packages_org_update / work_packages_org_delete are re-created from
//     their NEWEST definition (20260825 — no later file re-creates them) with
//     every line of that text kept verbatim (lineDiff), and the lines added
//     are exactly the owner-or-controller term 20261032 gave the pin
//     policies (plus UPDATE's WITH CHECK and DELETE's print-snapshot refusal);
//   · SELECT / INSERT are not touched; no function, no trigger;
//   · the DEC-30 one-paste shape: inventory TEMP TABLE before BEGIN, one
//     BEGIN / COMMIT, ONE final SELECT (check, ok, n) of probes + aggregate
//     counts, probes that never put a cast inside a LIKE;
//   · fix pass 2: the MEASURE rows count the population the app's budget
//     (PKG-12) and the portal's stamping bound (TRX-15) actually reach — the
//     print gate's sheets, recorded file sizes against the code's own
//     constants — and the file asks for the paste BEFORE the app deploys.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "supabase", "migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261143_dc_roundF_work_package_close_rail.sql";
const m143 = read(FILE);
const m825 = read("20260825_work_packages_acks.sql");
const m1032 = read("20261032_dc_phase7_ack_and_pin_integrity.sql");
const numbered = readdirSync(dir).filter((f) => /^\d{8}/.test(f) && f.endsWith(".sql")).sort();

/** One policy's DROP + CREATE statement, up to its closing `);`. */
function policy(sql: string, name: string): string {
  const a = sql.indexOf(`DROP POLICY IF EXISTS ${name} ON work_packages;`);
  expect(a, `policy not found: ${name}`).toBeGreaterThanOrEqual(0);
  const b = sql.indexOf("\n);\n", a);
  return sql.slice(a, b + 4);
}
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}
const tailOf = (m: string) => m.slice(m.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);
const codeOnly = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");

/** The authority term, exactly as 20261032 wrote it for the pin policies
 *  (there `work_package_documents`, here `work_packages`). */
const AUTHORITY = [
  "  AND (",
  "    work_packages.owner_user_id = auth.uid()",
  "    OR EXISTS (SELECT 1 FROM org_members m",
  "               WHERE m.org_id = work_packages.org_id",
  "                 AND m.uid = auth.uid() AND m.status = 'active'",
  "                 AND (m.role IN ('Admin','DocCtrl')",
  "                      OR m.roles && ARRAY['Admin','DocCtrl']))",
  "  )",
];

describe("20261143 — work_packages UPDATE / DELETE narrowed to the owner or a controller (DRLS-10)", () => {
  it("20260825 is the newest definition of both policies before this file (nothing else re-creates them, schema.sql included)", () => {
    for (const name of ["work_packages_org_update", "work_packages_org_delete", "work_packages_org_select", "work_packages_org_insert"]) {
      const definers = numbered.filter((f) => read(f).includes(`CREATE POLICY ${name} ON`));
      expect(definers, name).toEqual(
        name.endsWith("_update") || name.endsWith("_delete")
          ? ["20260825_work_packages_acks.sql", FILE]
          : ["20260825_work_packages_acks.sql"],
      );
    }
    const schema = readFileSync(join(process.cwd(), "supabase", "schema.sql"), "utf8");
    expect(schema).not.toMatch(/CREATE POLICY work_packages_org_/);
  });

  it("the authority term is 20261032's pin predicate, line for line (its owner arm joins to the package; here the row IS the package)", () => {
    const pin = policy(m1032.replaceAll("work_package_documents", "work_packages"), "work_packages_org_update").split("\n");
    const at = pin.indexOf("  AND (");
    expect(at).toBeGreaterThan(0);
    expect(pin.slice(at, at + 2 + 3)).toEqual([
      "  AND (",
      "    EXISTS (SELECT 1 FROM work_packages p",
      "            WHERE p.id = work_packages.package_id",
      "              AND p.owner_user_id = auth.uid())",
      AUTHORITY[2],
    ]);
    expect(pin.slice(at + 4, at + 4 + 6)).toEqual(AUTHORITY.slice(2));
  });

  it("UPDATE: every line of the 20260825 text survives (lineDiff), and the additions are the authority term on USING and on a new WITH CHECK", () => {
    const base = policy(m825, "work_packages_org_update");
    const next = policy(m143, "work_packages_org_update");
    const { onlyInA, onlyInB } = lineDiff(base, next);
    expect(onlyInA).toEqual([]);
    expect(onlyInB).toEqual([...AUTHORITY, ") WITH CHECK (", ...AUTHORITY]);
    const head = base.slice(0, base.indexOf("\n);\n"));
    expect(next.startsWith(head)).toBe(true);
    // WITH CHECK repeats the membership term verbatim, then the authority term
    const membership = head.slice(head.indexOf("  EXISTS (SELECT 1 FROM org_members WHERE"));
    expect(next).toBe(`${head}\n${AUTHORITY.join("\n")}\n) WITH CHECK (\n${membership}\n${AUTHORITY.join("\n")}\n);\n`);
  });

  it("DELETE: every line of the 20260825 text survives, plus the authority term and the print-snapshot refusal", () => {
    const base = policy(m825, "work_packages_org_delete");
    const next = policy(m143, "work_packages_org_delete");
    const { onlyInA, onlyInB } = lineDiff(base, next);
    expect(onlyInA).toEqual([]);
    expect(onlyInB).toEqual([
      ...AUTHORITY,
      "  AND NOT EXISTS (SELECT 1 FROM work_package_prints pr",
      "                  WHERE pr.package_id = work_packages.id)",
    ]);
    const head = base.slice(0, base.indexOf("\n);\n"));
    expect(next.startsWith(head)).toBe(true);
  });

  it("touches nothing else: no SELECT / INSERT policy, no function, no trigger, no other table", () => {
    const body = m143.slice(m143.indexOf("\nBEGIN;"), m143.indexOf("\nCOMMIT;"));
    expect([...codeOnly(body).matchAll(/CREATE POLICY (\w+)/g)].map((m) => m[1])).toEqual(["work_packages_org_update", "work_packages_org_delete"]);
    expect([...codeOnly(body).matchAll(/DROP POLICY IF EXISTS (\w+) ON (\w+)/g)].map((m) => `${m[1]}@${m[2]}`)).toEqual([
      "work_packages_org_update@work_packages", "work_packages_org_delete@work_packages",
    ]);
    expect(codeOnly(m143)).not.toMatch(/\bFUNCTION\b|\bTRIGGER\b|\bALTER\b|\bGRANT\b|SECURITY DEFINER/);
  });

  it("one paste: inventory TEMP TABLE before BEGIN, one BEGIN/COMMIT, ONE final SELECT (check, ok, n) of probes + aggregate counts", () => {
    expect(m143.indexOf("DROP TABLE IF EXISTS dc_round_f_143_before;")).toBeLessThan(m143.indexOf("CREATE TEMP TABLE dc_round_f_143_before AS"));
    expect(m143.indexOf("CREATE TEMP TABLE dc_round_f_143_before AS")).toBeLessThan(m143.indexOf("\nBEGIN;"));
    expect((m143.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((m143.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    const inventory = m143.slice(m143.indexOf("CREATE TEMP TABLE"), m143.indexOf("\nBEGIN;"));
    // aggregate counts only — never a customer row
    expect((inventory.match(/COUNT\(/g) ?? []).length).toBe(16);
    // the measurements are labelled as such — read-only, changed by nothing here
    expect((inventory.match(/'MEASURE \(PKG-12, not changed by this file\): /g) ?? []).length).toBe(6);
    expect((inventory.match(/'MEASURE \(TRX-15, not changed by this file\): /g) ?? []).length).toBe(2);
    expect(inventory).not.toMatch(/SELECT \*|SELECT p\.(?:id|name)|SELECT m\.(?:uid|email)/);
    const tail = tailOf(m143);
    expect((codeOnly(tail).match(/;/g) ?? []).length).toBe(1);
    expect(codeOnly(tail)).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP|CREATE)\b/);
    expect(tail).toMatch(/AS check,\s*\n[\s\S]*?AS ok,\s*\n\s*NULL::text AS n/);
    expect(tail).toContain("SELECT inventory, NULL::boolean, n FROM dc_round_f_143_before;");
  });

  it("MEASURE rows (fix pass 2): the print gate's population, the code's own budgets, sizes that exist, and the paste ordered before the app", () => {
    const inventory = m143.slice(m143.indexOf("CREATE TEMP TABLE"), m143.indexOf("\nBEGIN;"));
    const rows = inventory.split("\nUNION ALL\n").filter((r) => r.includes("'MEASURE ("));
    expect(rows).toHaveLength(8);
    const pkg12 = rows.filter((r) => r.includes("MEASURE (PKG-12"));
    // every PKG-12 row counts what the gate admits — Issued / Locked — never "not Archived"
    for (const r of pkg12) {
      expect(r).toContain("d.status IN ('Issued', 'Locked')");
      expect(r).not.toMatch(/IS DISTINCT FROM 'Archived'/);
    }
    // the four package / tag rows also drop a sheet under an active document hold, and say they are an upper bound or a sum of sheets that fit alone
    for (const r of pkg12.slice(0, 4)) {
      expect(r).toContain("NOT EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = d.id AND h.released_at IS NULL)");
    }
    expect(pkg12.slice(0, 2).every((r) => r.includes("upper bound"))).toBe(true);
    // sizes are read from document_versions.size (the column exists: schema.sql), against the code's constants
    const schema = readFileSync(join(process.cwd(), "supabase", "schema.sql"), "utf8");
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS document_versions \([\s\S]*?\n  size BIGINT,/);
    const docPack = readFileSync(join(process.cwd(), "lib", "docPack.ts"), "utf8");
    expect(docPack).toContain("export const PACK_MAX_BYTES = 150 * 1024 * 1024;");
    expect(150 * 1024 * 1024).toBe(157286400);
    expect(pkg12.filter((r) => r.includes("157286400"))).toHaveLength(3);
    // the rows within a pack on their own are summed; the over-150 MB singles are the too-large row
    expect(pkg12[2]).toContain("AND v.size <= 157286400");
    expect(pkg12[3]).toContain("AND v.size <= 157286400");
    expect(pkg12[4]).toContain("AND v.size > 157286400");
    expect(pkg12[5]).toMatch(/records no size[\s\S]*page counts are not stored/);
    // TRX-15: the portal's own bound, live links only, the 20261133 columns read through to_jsonb (they may not exist yet)
    const route = readFileSync(join(process.cwd(), "app", "api", "transmittal", "route.ts"), "utf8");
    expect(route).toContain("const PORTAL_STAMP_MAX_BYTES = 64 * 1024 * 1024;");
    const trx = rows.filter((r) => r.includes("MEASURE (TRX-15"));
    expect(trx[0]).toContain("> 67108864");
    expect(64 * 1024 * 1024).toBe(67108864);
    for (const r of trx) {
      expect(r).toContain("t.status IN ('issued', 'acknowledged')");
      expect(r).toContain("to_jsonb(t)->>'portal_revoked_at' IS NULL");
      expect(r).not.toMatch(/\bt\.portal_(revoked|expires)_at\b/);
    }
    // the operator reads the counts BEFORE the app ships
    expect(m143).toMatch(/DEPLOY ORDER \(PKG-12\): paste this file BEFORE the P8 FIELD app deploys and\n-- read the MEASURE rows first/);
  });

  it("probes match the DEPARSED policy text: no cast inside any LIKE pattern, and every pattern the policies would deparse to", () => {
    const tail = tailOf(m143);
    const patterns = [...tail.matchAll(/LIKE '((?:[^']|'')*)'/g)].map((m) => m[1]);
    expect(patterns.length).toBeGreaterThan(0);
    for (const p of patterns) expect(p, p).not.toMatch(/::/);
    expect(patterns).toEqual(expect.arrayContaining([
      "%owner_user_id = auth.uid()%",
      "%m.roles && ARRAY%",
      "%org_members.uid = auth.uid()%",
      "%NOT (EXISTS%work_package_prints pr%pr.package_id = work_packages.id%",
    ]));
    // five probes, each a (check, ok) row with n NULL; the inventory rows carry ok NULL
    expect((tail.match(/NULL::text/g) ?? []).length).toBe(5);
    expect((tail.match(/NULL::boolean/g) ?? []).length).toBe(1);
  });
});
