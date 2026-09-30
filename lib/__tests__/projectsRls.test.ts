// projects Round G — J8 PROJECT-MODEL: a policy CENSUS over the project
// tables, replaying schema.sql and every numbered migration in order
// (projects-tab SEC-2 / SEC-9 / SEC-17, projects-and-cost PM-7 / PM-8).
//
// RLS cannot be exercised from vitest without a database, so this replays
// the SQL: every literal CREATE / DROP POLICY, and every policy the
// FOREACH … format('CREATE POLICY %I …') loops generate (20260819, 20260906,
// 20261013 — expanded per table). The FINAL policy set per table is what a
// database built from the sequence holds, and the assertions are on it:
//   · SEC-2 — every permissive SELECT / ALL policy on the nine controls and
//     cost tables either goes through project_visible_to_me or is a write
//     policy gated on the controller / the active owner; none grants a bare
//     org-membership read (the private-project leak);
//   · SEC-17 / PM-8 — project_documents has no FOR ALL policy (the
//     member_all one is DROPPED, not supplemented), SELECT is
//     visibility-gated, writes need the owner or a controller in the
//     project's own org;
//   · SEC-9 — the projects UPDATE / DELETE owner branches need an ACTIVE
//     membership;
//   · PM-7 — project_activity's insert binds the author, the org and the
//     project's visibility; there is no UPDATE policy.
// A later migration that re-creates any of these the old way fails here.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const migDir = join(root, "supabase", "migrations");
const files = [
  join(root, "supabase", "schema.sql"),
  ...readdirSync(migDir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort().map((f) => join(migDir, f)),
];

const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");

/** Split a comma list at depth 0, outside quotes. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, q = false, cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") { q = !q; cur += ch; continue; }
    if (!q && ch === "(") depth++;
    if (!q && ch === ")") depth--;
    if (!q && depth === 0 && ch === ",") { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Evaluate a SQL string expression of literals and `t` joined by || . */
function evalExpr(expr: string, t: string): string {
  return expr.split(/\s*\|\|\s*/).map((part) => {
    const p = part.trim();
    if (p === "t") return t;
    const m = /^'((?:[^']|'')*)'$/.exec(p);
    return m ? m[1].replace(/''/g, "'") : "";
  }).join("");
}

/** Expand every FOREACH t IN ARRAY ARRAY[...] loop's format() calls into
 *  the literal statements they execute. */
function expandLoops(sql: string): string {
  let out = "";
  const loopRe = /FOREACH\s+t\s+IN\s+ARRAY\s+ARRAY\[([^\]]*)\]\s+LOOP([\s\S]*?)END\s+LOOP;/gi;
  for (const m of sql.matchAll(loopRe)) {
    const tables = (m[1].match(/'(\w+)'/g) ?? []).map((x) => x.replace(/'/g, ""));
    const body = m[2];
    const calls: string[] = [];
    let i = 0;
    while ((i = body.indexOf("format(", i)) !== -1) {
      let depth = 0, q = false, j = i + "format".length;
      for (; j < body.length; j++) {
        const ch = body[j];
        if (ch === "'") q = !q;
        if (q) continue;
        if (ch === "(") depth++;
        if (ch === ")") { depth--; if (depth === 0) break; }
      }
      calls.push(body.slice(i + "format(".length, j));
      i = j;
    }
    for (const t of tables) {
      for (const call of calls) {
        const [fmt, ...args] = splitTop(call);
        let s = evalExpr(fmt, t);
        for (const a of args) s = s.replace("%I", evalExpr(a, t));
        out += `\n${s};`;
      }
    }
  }
  return out;
}

type Policy = { file: string; cmd: string; permissive: boolean; body: string };
const TABLES = [
  "change_orders", "project_checklists", "checklist_items", "turnover_items", "punch_items",
  "project_parties", "cost_accounts", "cost_documents", "cost_entries",
  "project_documents", "projects", "project_activity",
];

function replay(): Map<string, Map<string, Policy>> {
  const byTable = new Map<string, Map<string, Policy>>(TABLES.map((t) => [t, new Map()]));
  for (const f of files) {
    const raw = stripComments(readFileSync(f, "utf8"));
    const sql = raw + expandLoops(raw);
    // Statements in file order: literal DROP / CREATE, then the loops' (appended, in loop order).
    const stmtRe = /(DROP\s+POLICY\s+IF\s+EXISTS\s+"?(\w+)"?\s+ON\s+(?:public\.)?"?(\w+)"?)|(CREATE\s+POLICY\s+"?(\w+)"?\s+ON\s+(?:public\.)?"?(\w+)"?([\s\S]*?);)/gi;
    for (const m of sql.matchAll(stmtRe)) {
      if (m[1]) {
        byTable.get(m[3])?.delete(m[2]);
        continue;
      }
      const name = m[5], table = m[6], rest = m[7];
      if (!byTable.has(table) || /%I/.test(name) || /%I/.test(table)) continue;
      const cmd = (/\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i.exec(rest)?.[1] ?? "ALL").toUpperCase();
      byTable.get(table)!.set(name, { file: f.replace(root + "/", ""), cmd, permissive: !/AS\s+RESTRICTIVE/i.test(rest), body: rest });
    }
  }
  return byTable;
}

const final = replay();
const pol = (t: string) => [...final.get(t)!.entries()];

describe("the census replays the loops, not only the literal statements", () => {
  it("sees the policies the 20261013 and 20260906 loops generated before 20261102 replaced them", () => {
    const upTo = (stop: string) => {
      const saved = files.splice(0);
      files.push(...saved.filter((f) => !/\/\d{8}/.test(f) || f.split("/").pop()! < stop));
      const r = replay();
      files.splice(0, files.length, ...saved);
      return r;
    };
    const before = upTo("20261102");
    expect(before.get("punch_items")!.get("punch_items_member_read")?.body).toMatch(/FROM org_members m WHERE m\.org_id = punch_items\.org_id/);
    expect(before.get("cost_entries")!.get("cost_entries_select")?.body).toMatch(/FROM org_members WHERE org_id = cost_entries\.org_id/);
    expect(before.get("cost_entries")!.has("cost_entries_member_all")).toBe(false); // 20260819's, dropped by 20260906
    expect(before.get("project_documents")!.get("project_documents_member_all")?.cmd).toBe("ALL");
  });
});

describe("SEC-2 — private projects are private for money and quality data", () => {
  const nine = ["change_orders", "project_checklists", "checklist_items", "turnover_items", "punch_items", "project_parties", "cost_accounts", "cost_documents", "cost_entries"];

  it("every permissive read of the nine tables goes through project_visible_to_me — or is a controller / active-owner write policy", () => {
    const leaks: string[] = [];
    for (const t of nine) {
      for (const [name, p] of pol(t)) {
        if (!p.permissive || (p.cmd !== "SELECT" && p.cmd !== "ALL")) continue;
        const ok = /project_visible_to_me\(/.test(p.body)
          || (p.cmd === "ALL" && !/org_members/.test(p.body) && /(is_org_controller|user_owns_project)\(/.test(p.body));
        if (!ok) leaks.push(`${t}.${name} (${p.file})`);
      }
    }
    expect(leaks, `a policy still grants a bare org-membership read:\n${leaks.join("\n")}`).toEqual([]);
  });

  it("each table's member read is the 20261102 policy, and checklist_items reads through its checklist", () => {
    for (const t of nine) {
      const reads = pol(t).filter(([, p]) => p.cmd === "SELECT");
      expect(reads.length, t).toBeGreaterThanOrEqual(1);
      for (const [, p] of reads) {
        expect(p.file, t).toBe("supabase/migrations/20261102_prj_roundG_project_rails.sql");
        expect(p.body, t).toMatch(/project_visible_to_me\(/);
      }
    }
    expect(final.get("checklist_items")!.get("checklist_items_member_read")!.body)
      .toMatch(/FROM project_checklists c\s+WHERE c\.id = checklist_items\.checklist_id AND project_visible_to_me\(c\.project_id\)/);
  });
});

describe("SEC-17 / PM-8 — project_documents", () => {
  it("has no FOR ALL policy; SELECT is visibility-gated; each write needs the owner or a controller", () => {
    const ps = final.get("project_documents")!;
    expect([...ps.values()].filter((p) => p.cmd === "ALL")).toEqual([]);
    expect([...ps.keys()].sort()).toEqual(["project_documents_delete", "project_documents_insert", "project_documents_select", "project_documents_update"]);
    expect(ps.get("project_documents_select")!.body).toMatch(/USING \(project_visible_to_me\(project_id\)\)/);
    for (const w of ["project_documents_insert", "project_documents_update", "project_documents_delete"]) {
      expect(ps.get(w)!.body, w).toMatch(/is_org_controller\(org_id\) OR is_project_owner\(project_id\)/);
    }
    for (const w of ["project_documents_insert", "project_documents_update"]) {
      expect(ps.get(w)!.body, w).toMatch(/AND org_id = project_org\(project_id\)/);
    }
  });

  it("no migration after 20261102 re-creates project_documents_member_all", () => {
    const offenders = readdirSync(migDir).filter((f) => /^\d{8}.*\.sql$/.test(f) && f > "20261102")
      .filter((f) => /CREATE\s+POLICY\s+"?project_documents_member_all/i.test(stripComments(readFileSync(join(migDir, f), "utf8"))));
    expect(offenders).toEqual([]);
  });
});

describe("SEC-9 — an offboarded owner acts on nothing", () => {
  it("the projects UPDATE and DELETE owner branches require an active org membership", () => {
    for (const name of ["projects_update_owner", "projects_delete_owner"]) {
      const p = final.get("projects")!.get(name)!;
      expect(p.file, name).toBe("supabase/migrations/20261102_prj_roundG_project_rails.sql");
      expect(p.body, name).toMatch(/owner_user_id::text = auth\.uid\(\)::text\s*\n\s*AND EXISTS \(SELECT 1 FROM org_members m WHERE m\.org_id = projects\.org_id AND m\.uid = auth\.uid\(\) AND m\.status = 'active'\)/);
    }
    expect([...final.get("projects")!.values()].filter((p) => p.cmd === "DELETE")).toHaveLength(1);
  });
});

describe("PM-7 — the project feed", () => {
  it("the insert binds the author, the project's org and its visibility; no UPDATE policy exists", () => {
    const ins = final.get("project_activity")!.get("project_activity_insert")!;
    expect(ins.body).toMatch(/user_id = auth\.uid\(\)/);
    expect(ins.body).toMatch(/org_id = project_org\(project_id\)/);
    expect(ins.body).toMatch(/project_visible_to_me\(project_id\)/);
    expect(ins.body).toMatch(/type <> 'comment' OR is_org_controller\(org_id\) OR can_manage_project\(project_id\)/);
    expect([...final.get("project_activity")!.values()].filter((p) => p.cmd === "UPDATE" || p.cmd === "ALL")).toEqual([]);
  });
});
