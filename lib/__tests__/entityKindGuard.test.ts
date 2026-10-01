// knowledge_page_entities holds several unrelated kinds of row under one
// table, and its bulk readers pull a wide slab under a row cap that then
// feeds DETERMINISTIC counts — equipment censuses, reference audits — which
// the answer prompt explicitly tells the model to trust for totals.
//
// A bulk read that does not name its kinds is a live hazard. The moment
// ingestion writes a new kind at volume, those rows compete for the same
// cap, whichever ones Postgres returns first win, and the census silently
// shrinks. Nothing throws. Filtering after the fetch cannot recover rows the
// limit already dropped.
//
// So this greps the repo the way exportCoverage.test.ts does: any bulk read
// must name its kinds, or be exempted here in writing.
//
// intelligence Round G (I-07):
//   * DWG-12 — exemptions are keyed PER READ, never per file. The locate
//     route was exempted as a FILE ("narrowed to one document+page+tag
//     list"), and a library-wide 'where else is this tag' read was later
//     added to it unseen. Every statement in every file is now checked; an
//     exemption names a file AND a snippet of the one statement it covers,
//     and must still match a statement (so it cannot outlive its read).
//     A read with no .limit() is capped by PostgREST's max-rows all the
//     same, so it counts as bulk unless it is narrowed to one document's
//     page; writes (insert / update / delete / upsert) are never reads.
//   * ING-5 — the kind inventory is held to the ingest both ways: every
//     kind lib/knowledgeIngest.ts writes is declared in ENTITY_KINDS, and
//     every declared kind is one it writes.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ENTITY_KINDS, TAG_ENTITY_KINDS } from "@/lib/knowledgeEntityKinds";

const ROOT = join(__dirname, "..", "..");
const TABLE = 'from("knowledge_page_entities")';

/** Per-READ exemptions: "<file> :: <snippet unique to that statement>" →
 *  why that one read cannot be swamped by another kind. Empty today: every
 *  bulk read in the repo names its kinds. A new entry is a deliberate
 *  decision about ONE statement; any other read in the same file is still
 *  checked. */
const EXEMPT: Record<string, string> = {};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".git") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

type Stmt = { file: string; line: number; text: string };

/** Every chained call on the table, up to its terminator. */
function statementsIn(rel: string, src: string): Stmt[] {
  const out: Stmt[] = [];
  let idx = src.indexOf(TABLE);
  while (idx >= 0) {
    const chunk = src.slice(idx, idx + 700);
    out.push({ file: rel, line: src.slice(0, idx).split("\n").length, text: chunk.slice(0, chunk.indexOf(";") + 1 || chunk.length) });
    idx = src.indexOf(TABLE, idx + 1);
  }
  return out;
}

/** A bulk read that names no kind. */
function isUnfilteredBulkRead(stmt: string): boolean {
  if (/\.(insert|update|delete|upsert)\(/.test(stmt)) return false;        // a write
  if (!stmt.includes(".select(")) return false;
  if (/\.(maybeSingle|single)\(|head:\s*true/.test(stmt)) return false;   // one row / a count
  const cap = /\.limit\((\d+)\)/.exec(stmt);
  // No .limit(): PostgREST's max-rows caps it anyway — bulk, unless it is
  // narrowed to one document's page (a page holds far fewer rows).
  const narrowedToPage = /\.eq\(\s*["']document_id["']/.test(stmt) && /\.eq\(\s*["']page["']/.test(stmt);
  const bulk = cap ? Number(cap[1]) >= 1000 : !narrowedToPage;
  return bulk && !/\.(in|eq)\(\s*["']kind["']/.test(stmt);
}

const exemptionFor = (s: Stmt): string | undefined =>
  Object.keys(EXEMPT).find((k) => {
    const [file, snippet] = k.split(" :: ");
    return file === s.file && !!snippet && s.text.includes(snippet);
  });

function allStatements(): Stmt[] {
  const out: Stmt[] = [];
  for (const file of walk(join(ROOT, "app")).concat(walk(join(ROOT, "lib")))) {
    const rel = file.slice(ROOT.length + 1);
    if (rel.includes("__tests__")) continue;
    out.push(...statementsIn(rel, readFileSync(file, "utf8")));
  }
  return out;
}

describe("knowledge_page_entities bulk reads name their kinds", () => {
  const stmts = allStatements();

  it("has no bulk read that could be swamped by a future entity kind", () => {
    const offenders = stmts.filter((s) => isUnfilteredBulkRead(s.text) && !exemptionFor(s))
      .map((s) => `${s.file}:${s.line}`);
    expect(offenders).toEqual([]);
  });

  it("every exemption still matches exactly one read, so the list can't rot (DWG-12)", () => {
    for (const key of Object.keys(EXEMPT)) {
      const [file, snippet] = key.split(" :: ");
      expect(snippet, `${key} must name the statement it exempts`).toBeTruthy();
      expect(() => statSync(join(ROOT, file)), `${key}: file does not exist`).not.toThrow();
      expect(stmts.filter((s) => s.file === file && s.text.includes(snippet)), key).toHaveLength(1);
    }
  });

  it("the guard actually catches an unfiltered bulk read", () => {
    // Proves the matcher works rather than trivially passing.
    const sample = `supabaseAdmin.from("knowledge_page_entities").select("tag").eq("org_id", o).limit(20000);`;
    expect(isUnfilteredBulkRead(sample.slice(sample.indexOf(TABLE)))).toBe(true);
    // No limit is still bulk: PostgREST's max-rows caps it silently.
    expect(isUnfilteredBulkRead(`from("knowledge_page_entities").select("tag").eq("library_id", l);`)).toBe(true);
    // One document's page is narrow; a write is not a read; a named kind passes.
    expect(isUnfilteredBulkRead(`from("knowledge_page_entities").select("tag").eq("document_id", d).eq("page", p).in("tag", t);`)).toBe(false);
    expect(isUnfilteredBulkRead(`from("knowledge_page_entities").insert(rows).select("id");`)).toBe(false);
    expect(isUnfilteredBulkRead(`from("knowledge_page_entities").select("tag").in("kind", ["equipment"]).limit(5000);`)).toBe(false);
  });

  it("an exemption covers ONE read: a new slab read in the same file is still caught (DWG-12)", () => {
    // The locate route's failure, replayed: the file held a narrow read, an
    // exemption was written for it, and a library-wide read was added later.
    const file = "app/api/knowledge/locate/route.ts";
    const src = [
      `const a = await supabaseAdmin.from("knowledge_page_entities").select("tag").eq("library_id", l).in("tag", t).limit(1000);`,
      `const b = await supabaseAdmin.from("knowledge_page_entities").select("document_id, page, tag").eq("library_id", l).in("tag", missingHere).limit(1000);`,
    ].join("\n");
    const local = statementsIn(file, src);
    const key = `${file} :: .in("tag", t)`;
    const exempted = (s: Stmt) => s.file === file && s.text.includes(key.split(" :: ")[1]);
    const caught = local.filter((s) => isUnfilteredBulkRead(s.text) && !exempted(s));
    expect(caught.map((s) => s.line)).toEqual([2]);
  });

  it("a read that feeds a number the prompt tells the model to trust is COMPLETE: paged to the end or to a stated ceiling, never one capped slab (ASK-2 / ING-10)", () => {
    // Naming the kinds keeps other kinds from eating the cap; it does not
    // stop the cap itself from cutting the census. The ask route's DRAWING
    // FACTS slab — the one the answer prompt marks "TRUST these for counts" —
    // must page (.range) under readAll with its ceiling, and must not carry
    // a fixed .limit() that a big library silently overflows.
    const src = readFileSync(join(ROOT, "app/api/knowledge/ask/route.ts"), "utf8");
    const slab = statementsIn("ask", src).find((s) => s.text.includes('.select("document_id, page, kind, tag, raw")'));
    expect(slab, "the census slab is still there").toBeTruthy();
    expect(slab!.text).toMatch(/\.in\("kind", TAG_ENTITY_KINDS/);
    expect(slab!.text).toMatch(/\.range\(from, to\), DRAWING_FACTS_ROW_CEILING\)/);
    expect(slab!.text).not.toMatch(/\.limit\(/);
    const before = src.slice(Math.max(0, src.indexOf('.select("document_id, page, kind, tag, raw")') - 400), src.indexOf('.select("document_id, page, kind, tag, raw")'));
    expect(before).toMatch(/await readAll<EntRow>\(/);
  });

  it("the locate route's 'where else' read names its kinds (DWG-12)", () => {
    const src = readFileSync(join(ROOT, "app/api/knowledge/locate/route.ts"), "utf8");
    const elsewhere = statementsIn("locate", src).find((s) => s.text.includes(".eq(\"library_id\""));
    expect(elsewhere, "the library-wide read is still there").toBeTruthy();
    expect(elsewhere!.text).toMatch(/\.in\(\s*"kind",\s*ELSEWHERE_KINDS/);
  });
});

describe("the entity-kind inventory is the ingest's, both ways (ING-5)", () => {
  const ingest = readFileSync(join(ROOT, "lib/knowledgeIngest.ts"), "utf8");
  // An entity row is pushed as `page: p, kind: "<kind>"` — the lease's own
  // `kind:` union ("claimed", "busy"…) is not an entity.
  const written = [...new Set([...ingest.matchAll(/page:\s*p,\s*kind:\s*"(\w+)"/g)].map((m) => m[1]))].sort();

  it("every kind the ingest writes is declared in ENTITY_KINDS", () => {
    expect(written.length).toBeGreaterThanOrEqual(5);
    for (const k of written) expect(ENTITY_KINDS as readonly string[], k).toContain(k);
  });

  it("every declared kind is one the ingest writes — nothing declared ahead of its writer", () => {
    expect([...ENTITY_KINDS].sort()).toEqual(written);
  });

  it("anchor is declared but kept out of the tag kinds every census reads", () => {
    expect(ENTITY_KINDS).toContain("anchor");
    expect(TAG_ENTITY_KINDS as readonly string[]).not.toContain("anchor");
  });

  it("the CHECK fallback keeps exactly the kinds the pre-20260925 CHECK admits (CORE_KINDS re-decided)", () => {
    // On a database that never ran 20260925 the column CHECK admits only
    // these two; the fallback strips every other kind so the insert lands.
    // Widening CORE_KINDS would make that insert fail again, so the choice
    // stays — pinned to the migration that defines the CHECK.
    const core = /CORE_KINDS = new Set\(\[([^\]]*)\]\)/.exec(ingest)?.[1] ?? "";
    const coreKinds = [...core.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();
    const mig = readFileSync(join(ROOT, "supabase/migrations/20260921_drawing_entities.sql"), "utf8");
    const check = /kind TEXT NOT NULL CHECK \(kind IN \(([^)]*)\)\)/.exec(mig)?.[1] ?? "";
    expect(coreKinds).toEqual([...check.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort());
    expect(readFileSync(join(ROOT, "supabase/migrations/20260925_entity_kinds.sql"), "utf8"))
      .toMatch(/DROP CONSTRAINT IF EXISTS knowledge_page_entities_kind_check/);
  });
});
