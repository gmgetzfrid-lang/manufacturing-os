// The authority-function census (DB-7): what reads what.
//
// The database's authority helpers split into two families — those that read
// the member's ROLE COLLECTION (org_members.roles, or a funnel such as
// is_org_controller / caller_holds_any_role) and those that read only the
// singular headline org_members.role. The headline can be DEMOTED by adding an
// unrelated role (ROLE_RANK puts Manager above DocCtrl), so a headline-only
// ALLOW silently strips authority from a multi-role member while a
// collection-aware DENY still binds. DEC-2 routed the five publish-path sites
// through the collection (20261040 / 20261041); 20261046 swept the rest.
//
// This test replays the whole migration set (schema.sql + numbered files, in
// order, statements in textual order, DO-loop policies included) and:
//   * classifies every function and policy that reads org_members by family;
//   * FAILS if any live definition is headline-only — a headline-only read
//     cannot reappear without failing CI;
//   * pins the collection funnels and the five DEC-2 sites to the additive
//     family, DB-3's backfill ahead of every additive conversion, and
//     ROLE_RANK byte-for-byte (DEC-2: do NOT reorder it).
// Set PRINT_AUTHORITY_CENSUS=<path> to write the census table (Markdown) there.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function migrationFiles(): string[] {
  const dir = join(root, "supabase", "migrations");
  const files = readdirSync(dir)
    .filter((f) => /^\d{8}/.test(f) && f.endsWith(".sql"))
    .sort()
    .map((f) => join(dir, f));
  return [join(root, "supabase", "schema.sql"), ...files];
}

const stripSqlComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
const arityOf = (args: string) => {
  const s = args.trim();
  if (!s) return 0;
  let depth = 0, count = 1;
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
};

// ── the two families ────────────────────────────────────────────────────────
// A bare `role` token (not `roles`, not `v_role`/`p_role`/`author_role`, not
// the JSON key 'role') is a read of the headline column. The collection is
// `roles`, or a call into one of the funnels that read it.
const HEADLINE = /(?<![\w'])role(?![\w'])/;
const COLLECTION_FUNNELS = [
  "is_org_controller", "caller_holds_any_role", "is_org_admin", "is_org_admin_or_manager",
  "org_capability_allows", "org_capability_allows_for", "acl_index_denies",
];
const COLLECTION = new RegExp(`(?<![\\w'])roles(?![\\w'])|\\b(?:${COLLECTION_FUNNELS.join("|")})\\s*\\(`);
const MEMBERSHIP = /\borg_members\b/;

type Family = "additive" | "membership-only" | "headline-only";
type Def = { kind: "function" | "policy"; key: string; file: string; body: string; dropped: boolean; dynamic: boolean };

function familyOf(body: string): Family | null {
  const h = HEADLINE.test(body), c = COLLECTION.test(body), m = MEMBERSHIP.test(body);
  if (!h && !c && !m) return null;
  if (c) return "additive";
  if (h) return "headline-only";
  return "membership-only";
}

type Ev =
  | { at: number; kind: "create"; def: Def }
  | { at: number; kind: "drop"; key: string; defKind: Def["kind"] };

// Policies created inside DO blocks via EXECUTE format(...). Three idioms in
// this repo: FOREACH t IN ARRAY ARRAY[...] with `t || '_suffix'` or `%I_suffix`
// names, and a VALUES (...) v(tbl, pol, roles) row set. The block's own text
// is the body every policy it creates is classified by.
function dynamicEvents(block: string, at: number, file: string): Ev[] {
  const out: Ev[] = [];
  const listM = block.match(/FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\s*\[([\s\S]*?)\]/i);
  const tables = listM ? [...listM[1].matchAll(/'(\w+)'/g)].map((m) => m[1]) : [];
  const rows = [...block.matchAll(/\(\s*'(\w+)'\s*,\s*'(\w+)'\s*,\s*ARRAY\[/g)].map((m) => ({ tbl: m[1], pol: m[2] }));
  const execRe = /EXECUTE\s+format\(\s*((?:'(?:[^']|'')*'\s*(?:\|\|\s*)?)+)\s*,\s*([^;]*?)\)\s*;/gi;
  for (const m of block.matchAll(execRe)) {
    const template = [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'")).join("");
    const head = template.match(/^\s*(DROP POLICY IF EXISTS|CREATE POLICY)\s+%I(?:_(\w+))?\s+ON\s+%I/i);
    if (!head) continue;
    const kind = /^DROP/i.test(head[1]) ? "drop" : "create";
    const templateSuffix = head[2] ? `_${head[2]}` : "";
    const firstArg = m[2].trim().split(",")[0].trim();
    const concat = firstArg.match(/^\w+\s*\|\|\s*'(\w+)'$/);
    const names: Array<{ tbl: string; pol: string }> = concat
      ? tables.map((t) => ({ tbl: t, pol: `${t}${concat[1]}` }))
      : /\.pol$/.test(firstArg) ? rows
      : tables.map((t) => ({ tbl: t, pol: `${t}${templateSuffix}` }));
    for (const n of names) {
      const key = `${n.tbl}.${n.pol}`;
      if (kind === "drop") out.push({ at: at + (m.index ?? 0), kind: "drop", key, defKind: "policy" });
      else out.push({ at: at + (m.index ?? 0), kind: "create", def: { kind: "policy", key, file, body: block, dropped: false, dynamic: true } });
    }
  }
  return out;
}

function census(): Map<string, Def> {
  const final = new Map<string, Def>();
  const fnRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(((?:[^()]|\([^()]*\))*)\)([\s\S]*?)(\$\w*\$)([\s\S]*?)\4/gi;
  const dropFnRe = /DROP\s+FUNCTION\s+IF\s+EXISTS\s+(?:public\.)?(\w+)\s*\(((?:[^()]|\([^()]*\))*)\)/gi;
  const polRe = /CREATE\s+POLICY\s+"?(\w+)"?\s+ON\s+(?:public\.)?"?(\w+)"?([\s\S]*?);/gi;
  const dropPolRe = /DROP\s+POLICY\s+IF\s+EXISTS\s+"?(\w+)"?\s+ON\s+(?:public\.)?"?(\w+)"?/gi;
  const doRe = /\bDO\s+(\$\w*\$)([\s\S]*?)\1\s*;/gi;
  for (const file of migrationFiles()) {
    const txt = stripSqlComments(readFileSync(file, "utf8"));
    const short = file.replace(root + "/supabase/", "");
    const events: Ev[] = [];
    for (const m of txt.matchAll(fnRe)) {
      events.push({ at: m.index ?? 0, kind: "create", def: { kind: "function", key: `${m[1]}/${arityOf(m[2])}`, file: short, body: m[3] + m[5], dropped: false, dynamic: false } });
    }
    for (const m of txt.matchAll(dropFnRe)) events.push({ at: m.index ?? 0, kind: "drop", key: `${m[1]}/${arityOf(m[2])}`, defKind: "function" });
    for (const m of txt.matchAll(polRe)) {
      events.push({ at: m.index ?? 0, kind: "create", def: { kind: "policy", key: `${m[2]}.${m[1]}`, file: short, body: m[3], dropped: false, dynamic: false } });
    }
    for (const m of txt.matchAll(dropPolRe)) events.push({ at: m.index ?? 0, kind: "drop", key: `${m[2]}.${m[1]}`, defKind: "policy" });
    for (const m of txt.matchAll(doRe)) events.push(...dynamicEvents(m[2], m.index ?? 0, short));
    events.sort((a, b) => a.at - b.at);
    for (const ev of events) {
      if (ev.kind === "create") final.set(`${ev.def.kind} ${ev.def.key}`, ev.def);
      else {
        const prev = final.get(`${ev.defKind} ${ev.key}`);
        if (prev) prev.dropped = true;
      }
    }
  }
  return final;
}

type Row = { kind: Def["kind"]; key: string; family: Family; file: string; dynamic: boolean };
function table(): Row[] {
  const rows: Row[] = [];
  for (const d of census().values()) {
    if (d.dropped) continue;
    const family = familyOf(d.body);
    if (family) rows.push({ kind: d.kind, key: d.key, family, file: d.file, dynamic: d.dynamic });
  }
  return rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
}

const migrationOf = (file: string) => file.replace(/^migrations\//, "").slice(0, 8);

describe("authority-function census (DB-7)", () => {
  const rows = table();
  const byKey = new Map(rows.map((r) => [`${r.kind} ${r.key}`, r]));
  const fam = (kind: Def["kind"], key: string) => byKey.get(`${kind} ${key}`)?.family;

  it("censuses a substantial authority surface, functions and policies alike", () => {
    expect(rows.filter((r) => r.kind === "function").length).toBeGreaterThan(30);
    expect(rows.filter((r) => r.kind === "policy").length).toBeGreaterThan(150);
    if (process.env.PRINT_AUTHORITY_CENSUS) {
      const md = rows.map((r) => `| ${r.kind} | \`${r.key}\` | ${r.family} | \`${r.file}\`${r.dynamic ? " (DO loop)" : ""} |`);
      writeFileSync(process.env.PRINT_AUTHORITY_CENSUS, md.join("\n") + "\n");
    }
  });

  it("NO live function or policy reads the headline role alone — a headline-only read cannot reappear", () => {
    const headline = rows.filter((r) => r.family === "headline-only").map((r) => `${r.kind} ${r.key}  (final definition: ${r.file})`);
    expect(headline, [
      "These definitions read org_members.role (the headline) and nothing collection-shaped.",
      "A headline ALLOW is demoted by adding an unrelated role (DEC-2 / OWN-3 / ADD-1). Read the collection instead:",
      "is_org_controller(org) / caller_holds_any_role(org, ARRAY[...]) in SQL, or COALESCE(roles, ARRAY[role]).",
      ...headline,
    ].join("\n")).toEqual([]);
  });

  it("the collection funnels are live, additive, and read `roles` directly or through an earlier funnel", () => {
    const final = census();
    const direct = /(?<![\w'])roles(?![\w'])/;
    for (const [key, viaFunnel] of [
      ["is_org_controller/1", null],
      ["caller_holds_any_role/2", null],
      ["is_org_admin_or_manager/1", null],
      ["acl_index_denies/4", null],
      ["org_capability_allows_for/4", null],
      ["is_org_admin/1", "caller_holds_any_role"],
      ["org_capability_allows/3", "org_capability_allows_for"],
    ] as Array<[string, string | null]>) {
      const d = final.get(`function ${key}`);
      expect(d, key).toBeDefined();
      expect(d!.dropped, key).toBe(false);
      expect(fam("function", key), key).toBe("additive");
      if (viaFunnel) expect(d!.body, key).toMatch(new RegExp(`\\b${viaFunnel}\\s*\\(`));
      else expect(d!.body, key).toMatch(direct);
    }
    // the primitive everything routes through — byte-shape of the check
    expect(final.get("function is_org_controller/1")!.body).toMatch(/role in \('Admin', 'DocCtrl'\) or roles && array\['Admin', 'DocCtrl'\]::text\[\]/i);
  });

  it("DEC-2: the five publish-path sites evaluate the controller tier through the collection, node_visible last and separately", () => {
    const sites: Array<[Def["kind"], string, string]> = [
      ["function", "enforce_document_publish_guard/0", "is_org_controller"],
      ["function", "user_can_publish_on_library/3", "roles"],
      ["function", "publish_revision/11", "roles"],
      ["policy", "document_review_signoffs.doc_review_signoff_update", "is_org_controller"],
      ["policy", "document_acknowledgments.doc_ack_update", "is_org_controller"],
      ["function", "node_visible/6", "is_org_controller"],
    ];
    const final = census();
    for (const [kind, key, via] of sites) {
      expect(fam(kind, key), key).toBe("additive");
      const d = final.get(`${kind} ${key}`)!;
      expect(d.body, key).toMatch(new RegExp(`(?<![\\w'])${via}(?![\\w'])`));
      expect(migrationOf(d.file) >= "20261040", `${key} final definition predates the DEC-2 conversion: ${d.file}`).toBe(true);
    }
    // node_visible's conversion is its own migration, after the other four
    expect(final.get("function node_visible/6")!.file).toBe("migrations/20261041_rp_phase5_node_visible_additive.sql");
    const others = ["enforce_document_publish_guard/0", "user_can_publish_on_library/3", "publish_revision/11"]
      .map((k) => final.get(`function ${k}`)!.file);
    for (const f of others) expect(f).not.toContain("20261041");
    // the headline-only census the finding recorded is gone from every one of them
    for (const [kind, key] of sites) {
      expect(final.get(`${kind} ${key}`)!.body).not.toMatch(/SELECT role INTO v_role/);
      expect(final.get(`${kind} ${key}`)!.body).not.toMatch(/\bv_role IN \('Admin', ?'DocCtrl'\)/);
    }
  });

  it("DB-3's backfill (20261024) precedes every additive conversion, so 'additive' never meant 'denied'", () => {
    const files = migrationFiles().map((f) => f.replace(root + "/supabase/", ""));
    const backfill = files.find((f) => f.startsWith("migrations/20261024_"));
    expect(backfill).toBe("migrations/20261024_backfill_member_roles.sql");
    const txt = readFileSync(join(root, "supabase", backfill!), "utf8");
    expect(txt).toMatch(/UPDATE org_members\s+SET roles = ARRAY\[role\]/);
    expect(txt).toMatch(/UPDATE org_members\s+SET roles = roles \|\| ARRAY\[role\]/);
    // every additive conversion of a DEC-2 site is a later file
    const converted = rows.filter((r) => r.family === "additive" && r.file >= "migrations/20261040");
    expect(converted.length).toBeGreaterThan(5);
    for (const r of converted) expect(migrationOf(r.file) > "20261024", r.key).toBe(true);
  });

  it("ROLE_RANK is byte-identical (DEC-2: the additive fix, NOT a reorder)", () => {
    const src = readFileSync(join(root, "lib", "roleCapabilities.ts"), "utf8");
    const block = src.slice(src.indexOf("const ROLE_RANK: Record<Role, number> = {"), src.indexOf("};", src.indexOf("const ROLE_RANK")) + 2);
    expect(block).toBe([
      "const ROLE_RANK: Record<Role, number> = {",
      "  Admin: 100,",
      "  Manager: 90,",
      "  Supervisor: 80,",
      "  DraftingSupervisor: 75,",
      "  DocCtrl: 70,",
      '  "Engineer-4": 64,',
      '  "Engineer-3": 63,',
      '  "Engineer-2": 62,',
      '  "Engineer-1": 61,',
      "  Drafter: 50,",
      "  Requester: 40,",
      "  Operations: 35,",
      "  Maintenance: 34,",
      "  Safety: 33,",
      "  HR: 32,",
      "  Accounting: 31,",
      "  Contractor: 30,",
      "  Auditor: 20,",
      "  Viewer: 10,",
      "};",
    ].join("\n"));
  });

  it("the census parser sees DO-loop policies (20261046 rewrote eight side-table policies dynamically)", () => {
    for (const t of ["org_ai_instructions", "document_related_resources", "library_numbering", "proposed_links", "asset_aliases", "codebook_entries", "codebook_config", "entity_mentions"]) {
      const r = byKey.get(`policy ${t}.${t}_write`);
      expect(r, t).toBeDefined();
      expect(r!.dynamic, t).toBe(true);
      expect(r!.family, t).toBe("additive");
      expect(r!.file, t).toBe("migrations/20261046_rp_phase6_sweep_authority_by_collection.sql");
    }
    // and the 20261045 asset-page loop, keyed by the `t || '_suffix'` idiom
    expect(byKey.get("policy assets.assets_write_roles_update")?.family).toBe("additive");
    expect(byKey.get("policy plot_plans.plot_plans_write_roles_delete")?.file).toContain("20261045");
  });

  it("the parser is not fooled by a JSON key or a prefixed identifier called role", () => {
    expect(familyOf("INSERT INTO t (author_role) VALUES (p_comment->>'role')")).toBeNull();
    expect(familyOf("SELECT 1 FROM org_members WHERE uid = auth.uid() AND v_role = 'x'")).toBe("membership-only");
    expect(familyOf("SELECT 1 FROM org_members WHERE role IN ('Admin')")).toBe("headline-only");
    expect(familyOf("SELECT 1 FROM org_members m WHERE m.role IN ('Admin')")).toBe("headline-only");
    expect(familyOf("SELECT role, COALESCE(roles, ARRAY[role]) FROM org_members")).toBe("additive");
    expect(familyOf("USING (is_org_controller(org_id))")).toBe("additive");
    expect(familyOf("USING (caller_holds_any_role(org_id, ARRAY['Admin']::text[]))")).toBe("additive");
  });
});
