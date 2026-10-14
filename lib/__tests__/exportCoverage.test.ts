// lib/__tests__/exportCoverage.test.ts
//
// THE BACKUP COMPLETENESS TRIPWIRE. A full-org backup is only "complete" if
// every table that exists is either exported or deliberately excluded with a
// written reason. This test diffs the export contract (lib/exportTables.ts)
// against every CREATE TABLE in supabase/schema.sql + supabase/migrations/.
//
// If you just added a table and this test failed: decide its backup fate —
// add it to ORG_SCOPED_TABLES (org data), USER_SCOPED_FOR_ORG_TABLES
// (per-user data joined via membership), or EXPORT_EXCLUDED_TABLES (with the
// reason it must not be copied) — and, unless excluded, give it a restore
// position in RESTORE_TABLE_ORDER or a skip reason in SKIP_TABLES.
//
// This exact failure mode shipped once: compliance tables (acknowledgment
// signatures, review sign-offs) existed for weeks while backups silently
// omitted them, and three phantom `cost_*` tables marked every backup
// INCOMPLETE. Never again.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ORG_SCOPED_TABLES,
  USER_SCOPED_FOR_ORG_TABLES,
  EXPORT_EXCLUDED_TABLES,
  REDACT_COLUMNS,
  EXPORT_KEYED_BY,
  EXPORT_ORDER_KEYS,
  EXPORT_OMITTED_COLUMNS,
  exportOrderKey,
  exportSelectFor,
  omitExportColumns,
  redactRow,
} from "@/lib/exportTables";
import { RESTORE_TABLE_ORDER, CONFLICT_TARGETS, planRestore, isBearerColumn, ORG_LESS_RESTORE_PARENTS } from "@/lib/dataRestore";
import { censusSchema } from "./helpers/schemaKeys";

/** Every table name created anywhere in supabase/ (schema.sql + migrations). */
function discoverCreatedTables(): Set<string> {
  const root = join(process.cwd(), "supabase");
  const sources: string[] = [readFileSync(join(root, "schema.sql"), "utf8")];
  for (const name of readdirSync(join(root, "migrations"))) {
    if (name.endsWith(".sql")) sources.push(readFileSync(join(root, "migrations", name), "utf8"));
  }
  const tables = new Set<string>();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
  for (const src of sources) {
    for (const m of src.matchAll(re)) tables.add(m[1].toLowerCase());
  }
  return tables;
}

/** Every column of every table, from CREATE TABLE bodies and ADD COLUMN
 *  statements across supabase/ (comments stripped). */
function discoverColumns(): Map<string, Set<string>> {
  const root = join(process.cwd(), "supabase");
  const sources: string[] = [readFileSync(join(root, "schema.sql"), "utf8")];
  for (const name of readdirSync(join(root, "migrations"))) {
    if (/^\d{8}.*\.sql$/.test(name)) sources.push(readFileSync(join(root, "migrations", name), "utf8"));
  }
  const cols = new Map<string, Set<string>>();
  const add = (t: string, c: string) => {
    if (!cols.has(t)) cols.set(t, new Set());
    cols.get(t)!.add(c);
  };
  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(([\s\S]*?)\n\);/gi;
  const alterRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
  const keywords = new Set(["constraint", "primary", "unique", "check", "foreign"]);
  for (const raw of sources) {
    const src = raw.replace(/--[^\n]*/g, "");
    for (const m of src.matchAll(createRe)) {
      for (const line of m[2].split("\n")) {
        const c = line.match(/^\s*"?([a-z_][a-z0-9_]*)"?\s+[A-Za-z]/);
        if (c && !keywords.has(c[1].toLowerCase())) add(m[1].toLowerCase(), c[1].toLowerCase());
      }
    }
    for (const m of src.matchAll(alterRe)) add(m[1].toLowerCase(), m[2].toLowerCase());
  }
  return cols;
}

const created = discoverCreatedTables();
const exported = new Set<string>([...ORG_SCOPED_TABLES, ...USER_SCOPED_FOR_ORG_TABLES]);
const excluded = new Set<string>(Object.keys(EXPORT_EXCLUDED_TABLES));
/** A table created by a package whose backup decision lands AT MERGE, in a
 *  file another running package owns (lib/exportTables.ts is admin-and-org
 *  AO-P4's in the 2026-10-07 wave). The integrator writes the decision and
 *  removes the table from here in the same merge — the test after the gap
 *  check fails once both say it, so the entry cannot outlive its merge. */
const DECISION_AT_MERGE: Record<string, string> = {
  // admin-and-org P13 (drafting-flow EVID-6, 20261219). Proposed decision:
  // EXPORT_EXCLUDED with this reason.
  audit_dead_letters:
    "the audit dead-letter outbox (an audit row whose insert was refused, kept as its writer sent it; admin-and-org P13, 20261219) — service-role only, a transient queue the daily maintenance cron drains into audit_logs as AUDIT_DEAD_LETTER rows, which are exported; a restored outbox would replay another deployment's recovered rows into this deployment's trail",
};

// EGR-7 / XEDGE-10: a column whose NAME says "credential". `_key` alone is
// not in the pattern — file_key / template_file_key / builtin_key are storage
// and registry keys, not secrets. `auth` / `p256dh` are the Web Push
// subscription secrets (push_subscriptions), excluded from the export whole.
const BEARER_NAME_RE = /(^|_)(token|secret|password)(_|$)|api_key|_encrypted$|^(auth|p256dh)$/;

describe("backup coverage tripwire", () => {
  it("found a plausible number of tables (sanity)", () => {
    expect(created.size).toBeGreaterThan(40);
  });

  it("every exported table actually exists (no phantoms marking backups INCOMPLETE)", () => {
    const phantoms = [...exported].filter((t) => !created.has(t));
    expect(phantoms, `Exported tables with no CREATE TABLE anywhere: ${phantoms.join(", ")}`).toEqual([]);
  });

  it("every existing table is exported or deliberately excluded (no silent gaps)", () => {
    const unaccounted = [...created].filter((t) => !exported.has(t) && !excluded.has(t) && !(t in DECISION_AT_MERGE)).sort();
    expect(
      unaccounted,
      `Tables with NO backup decision (add to exportTables.ts): ${unaccounted.join(", ")}`,
    ).toEqual([]);
  });

  it("a decision awaiting its merge names a created table not yet decided — remove it from DECISION_AT_MERGE when exportTables.ts decides it", () => {
    for (const [t, why] of Object.entries(DECISION_AT_MERGE)) {
      expect(created.has(t), t).toBe(true);
      expect(exported.has(t) || excluded.has(t), `${t} is decided in exportTables.ts — drop it from DECISION_AT_MERGE`).toBe(false);
      expect(why.trim().length, t).toBeGreaterThan(10);
    }
  });

  it("no table is both exported and excluded", () => {
    const both = [...exported].filter((t) => excluded.has(t));
    expect(both).toEqual([]);
  });

  it("every excluded table has a written reason", () => {
    for (const [table, reason] of Object.entries(EXPORT_EXCLUDED_TABLES)) {
      expect(reason.trim().length, `${table} needs a real exclusion reason`).toBeGreaterThan(10);
    }
  });

  it("every org-scoped table has a deliberate restore decision (ordered or skipped)", () => {
    // Ask the planner which tables it would skip — that's the real skip set.
    const plan = planRestore(
      {
        manifest: { orgId: "b" },
        tables: Object.fromEntries([...ORG_SCOPED_TABLES, ...USER_SCOPED_FOR_ORG_TABLES].map((t) => [t, [{}]])),
      },
      { orgId: "c", orgName: "x", members: [] },
    );
    const skipped = new Set(plan.counts.tables.filter((t) => !t.willImport).map((t) => t.name));
    const undecided = [...exported].filter((t) => !skipped.has(t) && !RESTORE_TABLE_ORDER.includes(t)).sort();
    expect(
      undecided,
      `Exported tables with no restore position (add to RESTORE_TABLE_ORDER or SKIP_TABLES): ${undecided.join(", ")}`,
    ).toEqual([]);
  });

  it("conflict targets reference real tables", () => {
    const bad = Object.keys(CONFLICT_TARGETS).filter((t) => !created.has(t));
    expect(bad).toEqual([]);
  });

  it("restore order only contains real tables", () => {
    const bad = RESTORE_TABLE_ORDER.filter((t) => !created.has(t));
    expect(bad, `RESTORE_TABLE_ORDER entries with no CREATE TABLE: ${bad.join(", ")}`).toEqual([]);
  });
});

describe("bearer-column redaction tripwire (EGR-7 / XEDGE-10)", () => {
  const columns = discoverColumns();

  it("the column census sees the schema (sanity)", () => {
    expect(columns.get("document_shares")).toContain("token");
    expect(columns.get("push_subscriptions")).toContain("p256dh");
    expect(["auth", "p256dh", "endpoint"].filter((c) => BEARER_NAME_RE.test(c))).toEqual(["auth", "p256dh"]);
    // push_subscriptions carries per-device push credentials: excluded whole,
    // never exported (it was never restored either — SKIP_TABLES).
    expect(exported.has("push_subscriptions")).toBe(false);
    expect(excluded.has("push_subscriptions")).toBe(true);
    expect(columns.get("export_destinations")).toContain("secret_access_key_encrypted");
    expect(columns.get("transmittals")).toContain("portal_token");
  });

  it("every credential-named column of an EXPORTED table is redacted", () => {
    const missing: string[] = [];
    for (const table of exported) {
      for (const col of columns.get(table) ?? []) {
        if (!BEARER_NAME_RE.test(col) && !/^(token)$/.test(col)) continue;
        if (!(REDACT_COLUMNS[table]?.columns ?? []).includes(col)) missing.push(`${table}.${col}`);
      }
    }
    expect(
      missing,
      `Credential-looking columns exported un-redacted (add to REDACT_COLUMNS in lib/exportTables.ts): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every redaction entry names an exported table, a real column and a written reason", () => {
    for (const [table, r] of Object.entries(REDACT_COLUMNS)) {
      expect(exported.has(table), `${table} is redacted but not exported`).toBe(true);
      expect(r.reason.trim().length, `${table} needs a real redaction reason`).toBeGreaterThan(20);
      for (const col of r.columns) {
        expect(columns.get(table)?.has(col), `${table}.${col} does not exist in the schema`).toBe(true);
      }
    }
    // The four tables the findings name are all in (push_subscriptions is
    // excluded whole rather than redacted — nothing of it is org data).
    expect(Object.keys(REDACT_COLUMNS).sort()).toEqual(["document_shares", "export_destinations", "project_intake_links", "transmittals"]);
  });

  it("export and restore agree: every redacted column is a bearer column the restore scrubs", () => {
    for (const r of Object.values(REDACT_COLUMNS)) {
      for (const col of r.columns) expect(isBearerColumn(col), col).toBe(true);
    }
    expect(isBearerColumn("file_url")).toBe(false);
  });

  it("redactRow nulls exactly the declared columns and leaves other tables untouched", () => {
    const share = { id: "s1", token: "live", org_id: "o", note: "n" };
    expect(redactRow("document_shares", share)).toEqual({ id: "s1", token: null, org_id: "o", note: "n" });
    expect(share.token).toBe("live"); // input never mutated
    const dest = { id: "d", access_key_id_encrypted: "x", secret_access_key_encrypted: "y", webhook_secret_encrypted: "z", bucket: "b" };
    expect(redactRow("export_destinations", dest)).toEqual({ id: "d", access_key_id_encrypted: null, secret_access_key_encrypted: null, webhook_secret_encrypted: null, bucket: "b" });
    const doc = { id: "x", token: "not-a-bearer-here" };
    expect(redactRow("documents", doc)).toBe(doc);
  });
});

// admin-and-org BKP-4: the tripwire above diffs table NAMES only, so it stayed
// green while four ORG_SCOPED_TABLES entries had no org_id column — the
// export's `.eq("org_id", …)` failed on each at runtime and EVERY backup was
// stamped INCOMPLETE with project rosters and curated-collection contents
// empty. A table without org_id is now read by its own key
// (EXPORT_KEYED_BY); this block fails when one is listed without it.
describe("export scope tripwire (BKP-4): every org-scoped table is read by a column it has", () => {
  // The statement-ordered census (CREATE bodies, ALTER ADD / DROP COLUMN) —
  // the one the restore tripwires read.
  const census = censusSchema();
  const columns = new Map([...census].map(([t, shape]) => [t, shape.columns]));

  it("the census sees the four tables the finding named", () => {
    expect(columns.get("project_members")?.has("project_id")).toBe(true);
    expect(columns.get("orgs")?.has("id")).toBe(true);
    // access_requests gained org_id in 20261023 — it is org-keyed, not excluded (plan default, DEC-75)
    expect(columns.get("access_requests")?.has("org_id")).toBe(true);
    expect(ORG_SCOPED_TABLES).toContain("access_requests");
  });

  it("every ORG_SCOPED_TABLES entry has an org_id column, or names its own key in EXPORT_KEYED_BY", () => {
    const unscoped = ORG_SCOPED_TABLES.filter((t) => !columns.get(t)?.has("org_id") && !EXPORT_KEYED_BY[t]);
    expect(unscoped, `Org-scoped tables with no org_id column and no EXPORT_KEYED_BY entry: ${unscoped.join(", ")}`).toEqual([]);
  });

  it("an EXPORT_KEYED_BY entry is a listed table WITHOUT org_id, read by a column it has, with a reason", () => {
    expect(Object.keys(EXPORT_KEYED_BY).sort()).toEqual(["curated_collection_items", "orgs", "project_members"]);
    for (const [table, k] of Object.entries(EXPORT_KEYED_BY)) {
      expect((ORG_SCOPED_TABLES as readonly string[]).includes(table), table).toBe(true);
      expect(columns.get(table)?.has("org_id"), `${table} has org_id now — drop its EXPORT_KEYED_BY entry`).toBe(false);
      expect(columns.get(table)?.has(k.column), `${table}.${k.column}`).toBe(true);
      expect(k.reason.trim().length, table).toBeGreaterThan(20);
    }
  });

  it("a parent-keyed table's parent is exported by org_id and dumped BEFORE it", () => {
    const order = ORG_SCOPED_TABLES as readonly string[];
    for (const [table, k] of Object.entries(EXPORT_KEYED_BY)) {
      if (!k.parent) continue;
      expect(order.includes(k.parent), `${table}'s parent ${k.parent}`).toBe(true);
      expect(columns.get(k.parent)?.has("org_id"), `${k.parent} must be org-keyed`).toBe(true);
      expect(EXPORT_KEYED_BY[k.parent], `${k.parent} must not itself be parent-keyed`).toBeUndefined();
      expect(order.indexOf(k.parent), `${k.parent} is dumped before ${table}`).toBeLessThan(order.indexOf(table));
    }
  });

  it("export and restore bound the org-less tables by the same parent (DEC-75)", () => {
    const exportParents = Object.fromEntries(
      Object.entries(EXPORT_KEYED_BY).filter(([, k]) => k.parent).map(([t, k]) => [t, { column: k.column, parent: k.parent }]),
    );
    expect(exportParents).toEqual({ ...ORG_LESS_RESTORE_PARENTS });
  });
});

// intelligence ILIFE-6 (the export half): the export pages every table in a
// stable, unique order — by `id`, or by the declared key of a table without
// one. Ordering an id-less table by `id` fails the read (42703) and the
// backup goes INCOMPLETE; ordering by a column set that is not unique can
// still hand a row to two pages. This block pins both.
describe("export paging order tripwire (ILIFE-6): every exported table pages by a unique key it has", () => {
  const census = censusSchema();
  const exported = [...ORG_SCOPED_TABLES, ...USER_SCOPED_FOR_ORG_TABLES] as readonly string[];

  it("every exported table has an id column or an EXPORT_ORDER_KEYS entry", () => {
    const unordered = exported.filter((t) => !census.get(t)?.columns.has("id") && !EXPORT_ORDER_KEYS[t]);
    expect(unordered, `Exported tables with no id column and no EXPORT_ORDER_KEYS entry: ${unordered.join(", ")}`).toEqual([]);
  });

  it("an EXPORT_ORDER_KEYS entry is an exported, id-less table, and its columns are exactly one of the table's PRIMARY KEY / UNIQUE keys", () => {
    for (const [table, cols] of Object.entries(EXPORT_ORDER_KEYS)) {
      expect(exported.includes(table), `${table} is not exported`).toBe(true);
      expect(census.get(table)?.columns.has("id"), `${table} has an id now — drop its entry`).toBe(false);
      const keys = (census.get(table)?.keys ?? []).map((k) => [...k].sort().join(","));
      expect(keys, `${table}: ${cols.join(",")} is not a key`).toContain([...cols].sort().join(","));
    }
  });

  it("the export orders an id-keyed table by id, and an id-less table by its declared key", () => {
    expect(exportOrderKey("documents")).toEqual(["id"]);
    expect(exportOrderKey("curated_collection_items")).toEqual(["collection_id", "document_id"]);
    expect(exportOrderKey("notification_preferences")).toEqual(["user_id"]);
  });
});

// intelligence ILIFE-11: a table the export reads by an explicit column list
// (to leave a derived column out) is a DECLARED exception, never a silent
// one. The list must be exactly the table's columns in the census less the
// omitted ones: a column a later migration adds fails here until it is
// listed, so the explicit list can never drop a column nobody decided on.
describe("export column-list exception (ILIFE-11): an omitted column is declared, and the list is every other column", () => {
  const census = censusSchema();
  const exported = [...ORG_SCOPED_TABLES, ...USER_SCOPED_FOR_ORG_TABLES] as readonly string[];

  it("knowledge_chunks is exported WITHOUT its embedding, for a written reason that says what a restore leaves", () => {
    expect(Object.keys(EXPORT_OMITTED_COLUMNS)).toEqual(["knowledge_chunks"]);
    expect(EXPORT_OMITTED_COLUMNS.knowledge_chunks.omit).toEqual(["embedding"]);
    expect(census.get("knowledge_chunks")?.columns.has("embedding")).toBe(true); // 20260930_semantic_layer.sql
    // The meaning index does not rebuild by itself after a restore (the
    // embed drain spends only on a stamped consent): the reason says that a
    // person must start a Build on their own key, and promises no drain.
    const reason = EXPORT_OMITTED_COLUMNS.knowledge_chunks.reason;
    expect(reason).toMatch(/keyword search works at once/);
    expect(reason).toMatch(/meaning-index Build on each library/);
    expect(reason).toMatch(/own embedding key/);
    expect(reason).toMatch(/Nothing re-embeds them automatically/);
    expect(reason).not.toMatch(/drain/);
  });

  it("every entry names an exported table; each omitted column is real; the select list is exactly the census columns less the omitted ones", () => {
    for (const [table, o] of Object.entries(EXPORT_OMITTED_COLUMNS)) {
      expect(exported.includes(table), `${table} is not exported`).toBe(true);
      const cols = census.get(table)?.columns ?? new Set<string>();
      for (const c of o.omit) expect(cols.has(c), `${table}.${c} is not a column`).toBe(true);
      expect(new Set(o.select).size, `${table}: duplicate in select`).toBe(o.select.length);
      expect(o.select.filter((c) => o.omit.includes(c)), `${table}: an omitted column is selected`).toEqual([]);
      const expected = [...cols].filter((c) => !o.omit.includes(c)).sort();
      expect([...o.select].sort(), `${table}: the explicit column list must be every column but the omitted ones (a new column? list it)`).toEqual(expected);
      for (const k of exportOrderKey(table)) expect(o.select, `${table}: the paging key ${k} must be read`).toContain(k);
      for (const c of Object.keys(o.reset)) {
        expect(o.select, `${table}.${c}: a reset column must be one the export reads`).toContain(c);
        expect(o.omit.includes(c), `${table}.${c}: a reset column is not an omitted one`).toBe(false);
      }
      if (Object.keys(o.reset).length > 0) expect(o.resetWhenAny.length, `${table}: a reset needs the columns that say the row carried the omitted value`).toBeGreaterThan(0);
      for (const c of o.resetWhenAny) expect(cols.has(c), `${table}.${c} (resetWhenAny) is not a column`).toBe(true);
      expect(o.reason.length, `${table}: write the reason`).toBeGreaterThan(20);
    }
  });

  it("the read list: explicit for knowledge_chunks, \"*\" for every other table", () => {
    expect(exportSelectFor("knowledge_chunks")).toBe(EXPORT_OMITTED_COLUMNS.knowledge_chunks.select.join(", "));
    expect(exportSelectFor("knowledge_chunks")).not.toMatch(/\bembedding\b(?!_)/);
    for (const t of exported.filter((x) => x !== "knowledge_chunks")) expect(exportSelectFor(t), t).toBe("*");
  });

  it("knowledge_chunks' embed-drain state is exported at the column defaults, and the reason says so", () => {
    // Defaults from 20261121_intel_roundG_semantic_layer.sql: embed_attempts
    // INTEGER NOT NULL DEFAULT 0; the other three are nullable with no default.
    expect(EXPORT_OMITTED_COLUMNS.knowledge_chunks.reset).toEqual({
      embed_attempts: 0, embed_error: null, embed_claimed_until: null, embed_retry_after: null,
    });
    expect(EXPORT_OMITTED_COLUMNS.knowledge_chunks.reason).toMatch(/retry state .* is exported reset to its default/);
    // Only on a row that carried a vector: the writer sets embedding and
    // embedding_model together, and the Rebuild clears them together.
    expect(EXPORT_OMITTED_COLUMNS.knowledge_chunks.resetWhenAny).toEqual(["embedding_model", "embedding"]);
    expect(EXPORT_OMITTED_COLUMNS.knowledge_chunks.reason).toMatch(/never had a vector keeps its state/);
  });

  it("omitExportColumns drops exactly the omitted columns, and leaves other tables' rows byte-identical", () => {
    const chunk = { id: "c1", content: "Pump P-101A", embedding: "[0.1,0.2]", embedding_model: "m" };
    expect(omitExportColumns("knowledge_chunks", chunk)).toEqual({ id: "c1", content: "Pump P-101A", embedding_model: "m" });
    expect(chunk.embedding).toBe("[0.1,0.2]"); // pure
    // the drain state the dropped vector left behind is reset; a column the
    // row does not have is not added
    const spent = { id: "c2", embedding: "[0.3]", embed_attempts: 4, embed_error: "provider 503", embed_claimed_until: "2099-01-01T00:00:00Z", embed_retry_after: "2099-01-01T00:00:00Z" };
    expect(omitExportColumns("knowledge_chunks", spent)).toEqual({ id: "c2", embed_attempts: 0, embed_error: null, embed_claimed_until: null, embed_retry_after: null });
    expect(spent.embed_attempts).toBe(4); // pure
    // read by the explicit list (no embedding column): embedding_model says it carried one
    expect(omitExportColumns("knowledge_chunks", { id: "c4", embedding_model: "m", embed_attempts: 4, embed_error: "x" }))
      .toEqual({ id: "c4", embedding_model: "m", embed_attempts: 0, embed_error: null });
    // never embedded (both NULL), at the attempt cap: kept as it is, refusal and reason
    const refused = { id: "c5", embedding: null, embedding_model: null, embed_attempts: 5, embed_error: "input too long", embed_claimed_until: null, embed_retry_after: null };
    expect(omitExportColumns("knowledge_chunks", refused)).toEqual({ id: "c5", embedding_model: null, embed_attempts: 5, embed_error: "input too long", embed_claimed_until: null, embed_retry_after: null });
    expect(omitExportColumns("knowledge_chunks", { id: "c6", embedding_model: null, embed_attempts: 2 })).toEqual({ id: "c6", embedding_model: null, embed_attempts: 2 });
    expect(omitExportColumns("knowledge_chunks", { id: "c3", embedding: null })).toEqual({ id: "c3" });
    const doc = { id: "d1", embedding: "kept" };
    expect(omitExportColumns("documents", doc)).toBe(doc);
  });
});
