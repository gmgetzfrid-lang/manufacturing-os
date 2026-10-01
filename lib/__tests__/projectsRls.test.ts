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
//     org-membership read (the private-project leak); company_events (the
//     company profile's event log) gates an event logged against a project
//     on the same visibility, and an unlinked event only while it is not
//     marked as a deleted private project's (the delete keeps it private);
//     turnover_review_events (projects Round G J2's
//     20261091 review history, merged beside this package) reads through
//     it too — replayed here with J2's statement as a fixture;
//   · SEC-17 / PM-8 — project_documents has no FOR ALL policy (the
//     member_all one is DROPPED, not supplemented), SELECT is
//     visibility-gated, an attach or an upsert's update needs a project
//     manager (can_manage_project) or a controller, in a project the caller
//     can see, a detach the owner or a controller, every write in the
//     project's own org (a link never moves — a trigger, not a policy);
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
  "project_documents", "projects", "project_activity", "company_events", "turnover_review_events",
  "audit_logs",
];

/** A migration another package ships, replayed at its number (a merge fixture). */
type Extra = { file: string; sql: string };

function replay(extra: Extra[] = []): Map<string, Map<string, Policy>> {
  const byTable = new Map<string, Map<string, Policy>>(TABLES.map((t) => [t, new Map()]));
  const key = (file: string) => (/\/\d{8}[^/]*$/.test(file) ? file.split("/").pop()! : "");
  const sources = [
    ...files.map((f) => ({ file: f.replace(root + "/", ""), sql: readFileSync(f, "utf8") })),
    ...extra,
  ].sort((a, b) => (key(a.file) < key(b.file) ? -1 : key(a.file) > key(b.file) ? 1 : 0));
  for (const src of sources) {
    const f = src.file;
    const raw = stripComments(src.sql);
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
      byTable.get(table)!.set(name, { file: f, cmd, permissive: !/AS\s+RESTRICTIVE/i.test(rest), body: rest });
    }
  }
  return byTable;
}

const final = replay();
const pol2 = (set: Map<string, Map<string, Policy>>, t: string) => [...set.get(t)!.entries()];
const pol = (t: string) => pol2(final, t);

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

describe("SEC-2 dw2 — the company profile shows no private-project event to a non-member", () => {
  it("before 20261102 company_events_member_read was a bare org-membership read (the /companies/[id] leak)", () => {
    const saved = files.splice(0);
    files.push(...saved.filter((f) => !/\/\d{8}/.test(f) || f.split("/").pop()! < "20261102"));
    const before = replay();
    files.splice(0, files.length, ...saved);
    const p = before.get("company_events")!.get("company_events_member_read")!;
    expect(p.file).toBe("supabase/migrations/20261013_project_controls_program.sql");
    expect(p.body).toMatch(/FROM org_members m WHERE m\.org_id = company_events\.org_id/);
    expect(p.body).not.toMatch(/project_visible_to_me/);
  });

  it("after it, every permissive read of company_events gates a project-tied event on project_visible_to_me — or is the controllers' policy", () => {
    const leaks: string[] = [];
    for (const [name, p] of pol("company_events")) {
      if (!p.permissive || (p.cmd !== "SELECT" && p.cmd !== "ALL")) continue;
      const gated = /\(company_events\.project_id IS NULL AND NOT company_events\.deleted_private_project\) OR project_visible_to_me\(company_events\.project_id\)/.test(p.body);
      const controllerOnly = p.cmd === "ALL" && !/org_members/.test(p.body) && /is_org_controller\(/.test(p.body);
      if (!gated && !controllerOnly) leaks.push(`${name} (${p.file})`);
    }
    expect(leaks).toEqual([]);
    const read = final.get("company_events")!.get("company_events_member_read")!;
    expect(read.file).toBe("supabase/migrations/20261102_prj_roundG_project_rails.sql");
    // an event with no project is still an org record — readable by every
    // active member — unless it came from a PRIVATE project since deleted
    expect(read.body).toMatch(/FROM org_members m WHERE m\.org_id = company_events\.org_id AND m\.uid = auth\.uid\(\) AND m\.status = 'active'\)\s+AND \(\(company_events\.project_id IS NULL AND NOT company_events\.deleted_private_project\) OR/);
  });

  it("deleting a private project does not make its events org-readable: they are marked before the FK's ON DELETE SET NULL unlinks them, on every delete path", () => {
    // company_events.project_id is ON DELETE SET NULL (20261013) and no later
    // migration changes that — so an unlinked event is what a delete leaves.
    const m1013 = readFileSync(join(migDir, "20261013_project_controls_program.sql"), "utf8");
    expect(m1013).toMatch(/CREATE TABLE IF NOT EXISTS company_events \([\s\S]*?project_id UUID REFERENCES projects\(id\) ON DELETE SET NULL,/);
    const m02 = stripComments(readFileSync(join(migDir, "20261102_prj_roundG_project_rails.sql"), "utf8"));
    expect(m02).toContain("ALTER TABLE company_events ADD COLUMN IF NOT EXISTS deleted_private_project BOOLEAN NOT NULL DEFAULT false;");
    // The mark is set by a BEFORE DELETE trigger on projects (not in the RPC
    // alone): a raw DELETE under projects_delete_owner, the pre-20261103 app
    // path and the service role all pass through it.
    expect(m02).toMatch(/CREATE TRIGGER trg_projects_private_company_events\s+BEFORE DELETE ON projects\s+FOR EACH ROW\s+EXECUTE FUNCTION keep_private_project_company_events_private\(\);/);
    expect(m02).toMatch(/IF OLD\.visibility = 'private' THEN\s+UPDATE company_events SET deleted_private_project = true\s+WHERE project_id = OLD\.id AND NOT deleted_private_project;/);
    // The events are KEPT (a contractor's safety record); the controllers'
    // FOR ALL policy still reads them.
    const m03 = stripComments(readFileSync(join(migDir, "20261103_prj_roundG_project_closeout_rails.sql"), "utf8"));
    const purge = m03.slice(m03.indexOf("CREATE OR REPLACE FUNCTION delete_project_record("), m03.indexOf("REVOKE ALL ON FUNCTION delete_project_record"));
    expect(purge).toContain("'companyEvents',  COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM company_events x WHERE x.project_id = p_project), '[]'::jsonb)");
    expect(purge).not.toMatch(/DELETE FROM company_events/);
    expect(final.get("company_events")!.get("company_events_controller_write")!.body).toMatch(/USING \(is_org_controller\(org_id\)\)/);
    // No later migration drops the mark or its trigger.
    for (const f of readdirSync(migDir).filter((x) => /^\d{8}.*\.sql$/.test(x) && x.slice(0, 8) > "20261102")) {
      const body = stripComments(readFileSync(join(migDir, f), "utf8"));
      expect(body, f).not.toMatch(/DROP TRIGGER[^;]*trg_projects_private_company_events/);
      expect(body, f).not.toMatch(/DROP COLUMN[^;]*deleted_private_project/);
    }
  });
});

describe("SEC-2 after merge — projects Round G J2's turnover review history (20261091) is private with its project", () => {
  // Verbatim from 20261091:451-453 on the integration branch (J2 is merged
  // there, not in this package's base).
  const J2 = {
    file: "supabase/migrations/20261091_prj_roundG_quality_rails.sql",
    sql: [
      "DROP POLICY IF EXISTS turnover_review_events_member_read ON turnover_review_events;",
      "CREATE POLICY turnover_review_events_member_read ON turnover_review_events FOR SELECT",
      "  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = turnover_review_events.org_id AND m.uid = auth.uid() AND m.status = 'active'));",
    ].join("\n"),
  };

  it("20261091 alone leaves the history readable by every active member — the census sees the leak", () => {
    const saved = files.splice(0);
    files.push(...saved.filter((f) => !/\/\d{8}/.test(f) || f.split("/").pop()! < "20261102"));
    const before = replay([J2]);
    files.splice(0, files.length, ...saved);
    const p = before.get("turnover_review_events")!.get("turnover_review_events_member_read")!;
    expect(p.file).toBe(J2.file);
    expect(p.body).toMatch(/FROM org_members m WHERE m\.org_id = turnover_review_events\.org_id/);
    expect(p.body).not.toMatch(/project_visible_to_me/);
  });

  it("with 20261102 after it, every permissive read of turnover_review_events goes through project_visible_to_me", () => {
    for (const merged of [replay([J2]), final]) {
      const leaks: string[] = [];
      for (const [name, p] of pol2(merged, "turnover_review_events")) {
        if (!p.permissive || (p.cmd !== "SELECT" && p.cmd !== "ALL")) continue;
        if (!/project_visible_to_me\(/.test(p.body)) leaks.push(`${name} (${p.file})`);
      }
      expect(leaks).toEqual([]);
      const read = merged.get("turnover_review_events")!.get("turnover_review_events_member_read")!;
      expect(read.file).toBe("supabase/migrations/20261102_prj_roundG_project_rails.sql");
      expect(read.cmd).toBe("SELECT");
      expect(read.body).toMatch(/USING \(project_visible_to_me\(project_id\)\)/);
    }
  });
});

describe("SEC-17 / PM-8 — project_documents", () => {
  it("has no FOR ALL policy; SELECT is visibility-gated; an attach or an upsert's update needs a project manager or a controller in a project the caller can see; a detach the owner or a controller", () => {
    const ps = final.get("project_documents")!;
    expect([...ps.values()].filter((p) => p.cmd === "ALL")).toEqual([]);
    expect([...ps.keys()].sort()).toEqual(["project_documents_delete", "project_documents_insert", "project_documents_select", "project_documents_update"]);
    expect(ps.get("project_documents_select")!.body).toMatch(/USING \(project_visible_to_me\(project_id\)\)/);
    for (const w of ["project_documents_insert", "project_documents_update"]) {
      expect(ps.get(w)!.body, w).toMatch(/is_org_controller\(org_id\) OR can_manage_project\(project_id\)/);
      expect(ps.get(w)!.body, w).toMatch(/AND org_id = project_org\(project_id\)\s+AND project_visible_to_me\(project_id\)\)/);
      expect(ps.get(w)!.body, w).not.toMatch(/is_project_owner/);
    }
    const del = ps.get("project_documents_delete")!.body;
    expect(del).toMatch(/is_org_controller\(org_id\) OR is_project_owner\(project_id\)/);
    expect(del).not.toMatch(/can_manage_project/);
    // The UPDATE policy can be the plan's because a link cannot move: a
    // BEFORE UPDATE trigger refuses a changed project_id / document_id.
    const m02 = stripComments(readFileSync(join(migDir, "20261102_prj_roundG_project_rails.sql"), "utf8"));
    expect(m02).toMatch(/CREATE TRIGGER trg_project_documents_link_fixed\s+BEFORE UPDATE ON project_documents\s+FOR EACH ROW\s+EXECUTE FUNCTION enforce_project_document_link_fixed\(\);/);
    expect(m02).toMatch(/IF auth\.uid\(\) IS NOT NULL\s+AND \(NEW\.project_id IS DISTINCT FROM OLD\.project_id OR NEW\.document_id IS DISTINCT FROM OLD\.document_id\) THEN\s+RAISE EXCEPTION/);
    for (const f of readdirSync(migDir).filter((x) => /^\d{8}.*\.sql$/.test(x) && x.slice(0, 8) > "20261102")) {
      expect(stripComments(readFileSync(join(migDir, f), "utf8")), f).not.toMatch(/DROP TRIGGER[^;]*trg_project_documents_link_fixed/);
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

// projects Round G (J11) — projects-tab SEC-20: an audit row about a private
// project (resource_type 'project' / 'cost') is readable only by those who can
// read the project, and by the audit roles. 20261142 re-creates the RESTRICTIVE
// overlay from 20261063 with one added clause (the lineDiff is
// prjRoundGJ11Migrations.test.ts's); the census pins the final policy set.
describe("SEC-20 — audit rows about a private project follow the project's visibility", () => {
  it("the final audit_logs set: one permissive member read, one insert, and ONE restrictive overlay that gates project / cost rows on audit_row_project_visible", () => {
    const set = pol("audit_logs");
    const restrictive = set.filter(([, p]) => !p.permissive);
    expect(restrictive.map(([n]) => n)).toEqual(["audit_logs_admin_trail"]);
    const [, trail] = restrictive[0];
    // 20261157 (SEC-21) re-created it from 20261142's body with one more
    // clause — the lineDiff is prjRoundGJ12Migration.test.ts's.
    expect(trail.file).toBe("supabase/migrations/20261157_prj_roundG_server_remainders.sql");
    expect(trail.cmd).toBe("SELECT");
    // the audit roles read every row (admin.audit_view through the evaluator) …
    expect(trail.body).toMatch(/org_capability_allows\(org_id, 'admin\.audit_view', auth\.uid\(\)\)\s*\n\s*OR NOT \(/);
    // … anyone else: not the org-level trail AND the row's project is visible
    expect(trail.body).toMatch(/\)\s*\n\s*AND \(COALESCE\(resource_type, ''\) NOT IN \('project', 'cost', 'project_checklist', 'turnover_item'\)\s*\n\s*OR audit_row_project_visible\(resource_type, resource_id\)\)\s*\n/);
    // … SEC-21: and a row naming a project under another type (an intake
    // link, an INTAKE_ / MILESTONE_ action) follows that project too
    expect(trail.body).toMatch(/AND \(\(COALESCE\(resource_type, ''\) <> 'project_intake_link'\s*\n\s*AND left\(COALESCE\(action, ''\), 10\) <> 'MILESTONE_'\s*\n\s*AND left\(COALESCE\(action, ''\), 7\) <> 'INTAKE_'\)\s*\n\s*OR audit_row_project_ref_visible\(action, resource_type, resource_id, details\)\)\s*\n\s*\)\s*$/);
    const permissiveReads = set.filter(([, p]) => p.permissive && (p.cmd === "SELECT" || p.cmd === "ALL"));
    expect(permissiveReads.map(([n]) => n)).toEqual(["audit_logs_org_access"]);
    expect(set.filter(([, p]) => p.cmd === "INSERT").map(([n]) => n)).toEqual(["audit_logs_insert"]);
  });
  it("before 20261142 the overlay narrowed only the org-level trail — a project / cost row was any member's (the finding, reproduced)", () => {
    const saved = files.splice(0);
    files.push(...saved.filter((f) => !/\/\d{8}/.test(f) || f.split("/").pop()! < "20261142"));
    const before = replay();
    files.splice(0, files.length, ...saved);
    const trail = before.get("audit_logs")!.get("audit_logs_admin_trail")!;
    expect(trail.file).toBe("supabase/migrations/20261063_rp_roundE_audit_view_capability.sql");
    expect(trail.body).not.toMatch(/audit_row_project_visible/);
  });
  it("before 20261157 an intake-link / INTAKE_ / MILESTONE_ row about a private project was any member's (SEC-21, reproduced)", () => {
    const saved = files.splice(0);
    files.push(...saved.filter((f) => !/\/\d{8}/.test(f) || f.split("/").pop()! < "20261157"));
    const before = replay();
    files.splice(0, files.length, ...saved);
    const trail = before.get("audit_logs")!.get("audit_logs_admin_trail")!;
    expect(trail.file).toBe("supabase/migrations/20261142_prj_roundG_project_audit_rows.sql");
    expect(trail.body).not.toMatch(/project_intake_link|MILESTONE_|INTAKE_/);
  });
});

