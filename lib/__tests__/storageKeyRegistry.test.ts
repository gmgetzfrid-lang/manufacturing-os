// admin-and-org Round G, package P2 — BKP-2 / BKP-9 (intelligence ILIFE-1,
// ILIFE-5): ONE registry of storage-key columns, read by both collectors.
//
// Reproduced on base 2290b94 before the fix: lib/dataExport.ts
// collectFilePaths added keys from 8 sources and lib/storageOrphans.ts
// collectReferencedKeys from 11; cost_documents.file_url was in neither (a
// vendor quote was in no backup AND an "orphan" seven days after upload), and
// the export missed document_versions.source_file_key, knowledge_documents.
// file_key and output_templates' template / example keys (BKP-9).
//
//   * the census: every column in supabase/ whose NAME says "storage key" is
//     registered or declared not-a-key with its reason (the binary analogue
//     of exportCoverage.test.ts) — and the declared list is exactly that;
//   * the two collectors read the same sources and return the same keys
//     (less the one table the export does not carry, `users`, excluded);
//   * the orphan sweep refuses to run on a source list smaller than the
//     schema's key columns (BKP-2 Done-when 3);
//   * keysReferencedOutside — the predicate the document shed needs (ILIFE-5);
//   * findUnregisteredOrgKeys — the export's value scan (BKP-9 Done-when 3).

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => ({})) }, R2_BUCKET: "test-bucket" }));

import { censusSchema } from "./helpers/schemaKeys";
import {
  STORAGE_KEY_SOURCES, STORAGE_KEY_COLUMNS, NOT_STORAGE_KEY_COLUMNS, BINARY_LINK_TABLES, KEY_MENTION_TABLES,
  registryGaps, keysOf, selectFor, isStorageKey, findUnregisteredOrgKeys, keysReferencedOutside, plainKeyColumns,
  type StorageKeySource,
} from "@/lib/storageKeyRegistry";
import { collectFilePaths } from "@/lib/dataExport";
import { collectReferencedKeys } from "@/lib/storageOrphans";
import { ORG_SCOPED_TABLES, USER_SCOPED_FOR_ORG_TABLES, EXPORT_EXCLUDED_TABLES } from "@/lib/exportTables";

type Row = Record<string, unknown>;
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/** A column NAME that says "this may hold a storage key". */
const KEY_NAME_RE = /(^|_)(url|key|path|attachments|files)$/;
const census = censusSchema();
const exported = new Set<string>([...ORG_SCOPED_TABLES, ...USER_SCOPED_FOR_ORG_TABLES]);

/** One row per source carrying every kind of key it can hold. */
const k = (name: string) => `orgs/${ORG}/${name}`;
const ROWS: Record<string, Row[]> = {
  document_versions: [{ id: "v1", file_url: k("libraries/l1/P-101.pdf"), size: 34, source_file_key: k("libraries/l1/P-101.dwg") }],
  knowledge_documents: [{ id: "kd1", file_key: k("knowledge/kl1/manual.pdf"), file_size: 99 }],
  asset_photos: [{ id: "ap1", file_url: k("assets/a1/photos/1.jpg"), file_size: 12 }],
  tickets: [{ id: "t1", attachments: [{ url: k("tickets/t1/redline.pdf"), size: "2.00 MB" }, { url: "https://example.com/x.pdf" }] }],
  markup_requests: [{ id: "m1", shared_markup_url: k("markups/m1.pdf") }],
  plot_plans: [{ id: "pp1", image_path: k("plot-plans/pp1.png") }],
  libraries: [{ id: "l1", cover_image_url: k("branding/covers/l1.png") }],
  collections: [{ id: "c1", cover_image_url: "data:image/png;base64,AAAA" }, { id: "c2", cover_image_url: k("branding/covers/c2.png") }],
  users: [{ id: "u1", avatar_path: `avatars/u1.png` }],
  org_configurations: [{ id: "oc1", key: "branding", data: { logoPath: k("branding/logo-1.svg") } }, { id: "oc2", key: "drafting", data: { logoPath: k("not-a-logo.svg") } }],
  output_templates: [{ id: "ot1", template_file_key: k("output-templates/ds.docx"), example_files: [{ key: k("output-examples/ex1.docx") }, { url: k("output-examples/ex2.docx") }] }],
  cost_documents: [{ id: "cd1", file_url: k("project-costs/p1/quote-1-acme.pdf") }],
};

/** A thenable stand-in for the service-role client over ROWS (keyset reads, head counts, `.in` filters). */
function fakeDb(rows: Record<string, Row[]>, opts: { failRead?: string; reads?: string[] } = {}): SupabaseClient {
  return {
    from: (table: string) => {
      let head = false; let after: string | null = null; let cap: number | null = null;
      let inFilter: { col: string; vals: unknown[] } | null = null;
      const c: Row = {};
      const h: ProxyHandler<Row> = {
        get(_t, prop: string) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void) => {
              opts.reads?.push(table);
              if (opts.failRead === table) return resolve({ data: null, error: { message: "statement timeout" } });
              const src = rows[table] ?? [];
              if (head) return resolve({ data: null, count: src.length, error: null });
              let out = [...src].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
              if (after !== null) out = out.filter((r) => String(r.id) > (after as string));
              if (inFilter) out = out.filter((r) => inFilter!.vals.includes(r[inFilter!.col]));
              if (cap !== null) out = out.slice(0, cap);
              resolve({ data: out, error: null });
            };
          }
          return (...args: unknown[]) => {
            if (prop === "select") head = (args[1] as { head?: boolean } | undefined)?.head === true;
            if (prop === "gt") after = String(args[1]);
            if (prop === "limit") cap = args[0] as number;
            if (prop === "in") inFilter = { col: args[0] as string, vals: args[1] as unknown[] };
            return new Proxy(c, h);
          };
        },
      };
      return new Proxy(c, h);
    },
  } as unknown as SupabaseClient;
}

describe("the storage-key census (BKP-2 Done-when 2: the binary analogue of the export tripwire)", () => {
  const candidates: string[] = [];
  for (const [t, shape] of census) for (const c of shape.columns) if (KEY_NAME_RE.test(c)) candidates.push(`${t}.${c}`);

  it("the census sees the schema (not vacuous)", () => {
    expect(candidates).toContain("cost_documents.file_url");
    expect(candidates).toContain("document_versions.source_file_key");
    expect(candidates.length).toBeGreaterThan(20);
  });

  it("every key-named column in supabase/ is registered or declared not-a-key, with a reason", () => {
    const declared = new Set([...STORAGE_KEY_COLUMNS, ...Object.keys(NOT_STORAGE_KEY_COLUMNS)]);
    const undecided = candidates.filter((c) => !declared.has(c)).sort();
    expect(undecided, `Columns that may hold a storage key with no decision (register in lib/storageKeyRegistry.ts or declare NOT_STORAGE_KEY_COLUMNS): ${undecided.join(", ")}`).toEqual([]);
    for (const [col, reason] of Object.entries(NOT_STORAGE_KEY_COLUMNS)) {
      expect(reason.trim().length, col).toBeGreaterThan(15);
      expect(STORAGE_KEY_COLUMNS.includes(col), `${col} is both a key and not one`).toBe(false);
    }
  });

  it("every registered and every declared column is a real column (no phantoms)", () => {
    for (const col of [...STORAGE_KEY_COLUMNS, ...Object.keys(NOT_STORAGE_KEY_COLUMNS)]) {
      const [t, c] = col.split(".");
      expect(census.get(t)?.columns.has(c), `${col} is not a column in supabase/`).toBe(true);
    }
  });

  it("STORAGE_KEY_COLUMNS is exactly the key-named columns plus the JSON-embedded logo — no more, no less", () => {
    const expected = new Set([...candidates.filter((c) => !(c in NOT_STORAGE_KEY_COLUMNS)), "org_configurations.data"]);
    expect([...STORAGE_KEY_COLUMNS].sort()).toEqual([...expected].sort());
  });

  it("the sources read exactly the declared key columns (no gap either way)", () => {
    expect(registryGaps()).toEqual({ unread: [], undeclared: [] });
    for (const s of STORAGE_KEY_SOURCES) {
      for (const c of [...s.keyColumns, ...(s.readColumns ?? [])]) {
        expect(census.get(s.table)?.columns.has(c), `${s.table}.${c}`).toBe(true);
      }
      expect(census.get(s.table)?.columns.has("id"), `${s.table} needs an id for keyset paging`).toBe(true);
      expect(selectFor(s).split(", ")[0]).toBe("id");
    }
  });

  it("asset_files holds no key of its own: it links a document, whose revisions carry the binaries", () => {
    const shape = census.get("asset_files")!;
    expect([...shape.columns].filter((c) => KEY_NAME_RE.test(c))).toEqual([]);
    expect(shape.fks.some((f) => f.columns.join() === "document_id" && f.parent === "documents")).toBe(true);
    expect(BINARY_LINK_TABLES.asset_files).toMatch(/document_versions/);
    expect(STORAGE_KEY_SOURCES.map((s) => s.table)).toContain("document_versions");
  });

  it("a key-mention table is skipped by the value scan only because its rows record history", () => {
    for (const [t, reason] of Object.entries(KEY_MENTION_TABLES)) {
      expect(census.has(t), t).toBe(true);
      expect(reason.trim().length).toBeGreaterThan(20);
      expect(STORAGE_KEY_SOURCES.some((s) => s.table === t), `${t} is a key source — it cannot be a mention table`).toBe(false);
    }
  });
});

describe("one registry, two collectors (BKP-9 Done-when 1-2; BKP-2 Done-when 1)", () => {
  it("cost_documents, native CAD sources, knowledge PDFs and output templates are in BOTH collectors", async () => {
    const exportKeys = new Set(collectFilePaths(ROWS).map((r) => r.path));
    const sweepKeys = await collectReferencedKeys(fakeDb(ROWS));
    for (const key of [
      k("project-costs/p1/quote-1-acme.pdf"), k("libraries/l1/P-101.dwg"), k("knowledge/kl1/manual.pdf"),
      k("output-templates/ds.docx"), k("output-examples/ex1.docx"), k("output-examples/ex2.docx"),
    ]) {
      expect(exportKeys.has(key), `export: ${key}`).toBe(true);
      expect(sweepKeys.has(key), `sweep: ${key}`).toBe(true);
    }
  });

  it("the two lists are identical, less the sources whose table the export does not carry (each excluded with a reason)", async () => {
    // what runOrgExport hands the export collector: the exported tables only
    const exportedRows = Object.fromEntries(Object.entries(ROWS).filter(([t]) => exported.has(t)));
    const exportKeys = new Set(collectFilePaths(exportedRows).map((r) => r.path));
    const sweepKeys = await collectReferencedKeys(fakeDb(ROWS));
    const notCarried = STORAGE_KEY_SOURCES.filter((s) => !exported.has(s.table));
    expect(notCarried.map((s) => s.table)).toEqual(["users"]);
    for (const s of notCarried) expect(EXPORT_EXCLUDED_TABLES[s.table], s.table).toBeTruthy();
    const notCarriedKeys = new Set(notCarried.flatMap((s) => (ROWS[s.table] ?? []).flatMap((r) => keysOf(s, r).map((x) => x.path))));
    expect([...sweepKeys].filter((x) => !notCarriedKeys.has(x)).sort()).toEqual([...exportKeys].sort());
    // every source contributed at least one key (the fixture is not vacuous)
    for (const s of STORAGE_KEY_SOURCES) {
      expect((ROWS[s.table] ?? []).some((r) => keysOf(s, r).length > 0), s.label).toBe(true);
    }
  });

  it("values that are not our keys never enter either list; a byte size is a number or unknown", () => {
    const refs = collectFilePaths(ROWS);
    expect(refs.find((r) => r.path.startsWith("https:") || r.path.startsWith("data:"))).toBeUndefined();
    expect(refs.find((r) => r.path === k("not-a-logo.svg"))).toBeUndefined(); // only the branding row's logoPath
    expect(refs.find((r) => r.path === k("libraries/l1/P-101.pdf"))?.size).toBe(34);
    expect(refs.find((r) => r.path === k("tickets/t1/redline.pdf"))?.size).toBeNull(); // "2.00 MB" is no byte count
    expect(isStorageKey("orgs/x/a.pdf")).toBe(true);
    expect(isStorageKey("blob:abc")).toBe(false);
    expect(isStorageKey("")).toBe(false);
  });

  it("BKP-2 Done-when 3: the orphan sweep refuses to run when its source list is smaller than the schema's key columns", async () => {
    const reads: string[] = [];
    const short: StorageKeySource[] = STORAGE_KEY_SOURCES.filter((s) => s.table !== "cost_documents");
    expect(registryGaps(short).unread).toEqual(["cost_documents.file_url"]);
    await expect(collectReferencedKeys(fakeDb(ROWS, { reads }), short)).rejects.toThrow(/cost_documents\.file_url are read by no collector source/);
    expect(reads).toEqual([]); // refused before any read
  });

  it("the sweep still fails closed on any read error", async () => {
    await expect(collectReferencedKeys(fakeDb(ROWS, { failRead: "cost_documents" }))).rejects.toThrow(/reference scan failed at cost_documents/);
  });
});

describe("ILIFE-5 — keysReferencedOutside: the predicate a step freeing a revision's bytes must consult", () => {
  const live = k("libraries/l1/P-101-revA.pdf");
  const freeable = k("libraries/l1/P-099-revA.pdf");
  const rows: Record<string, Row[]> = {
    document_versions: [{ id: "v1", file_url: live }, { id: "v2", file_url: freeable }],
    // the knowledge mirror of revision A names the SAME object (knowledgeSourceSync: file_key = version.file_url)
    knowledge_documents: [{ id: "kd1", file_key: live, source_version_id: "v1" }],
  };

  it("a key a knowledge mirror still names is kept; a key nothing else names is not", async () => {
    const kept = await keysReferencedOutside(fakeDb(rows), [live, freeable], ["document_versions.file_url"]);
    expect([...kept]).toEqual([live]);
  });

  it("checks every plain key column except the ones the caller already judged", async () => {
    const cols = plainKeyColumns().map((c) => `${c.table}.${c.column}`);
    expect(cols).toContain("knowledge_documents.file_key");
    expect(cols).toContain("cost_documents.file_url");
    expect(cols).toContain("document_versions.source_file_key");
    expect(cols).not.toContain("tickets.attachments"); // JSON — no .in() match
    // without the exclusion, the shed's own column answers too
    expect([...(await keysReferencedOutside(fakeDb(rows), [live, freeable]))].sort()).toEqual([freeable, live].sort());
  });

  it("an unreadable column refuses (fail closed), and nothing to check reads nothing", async () => {
    await expect(keysReferencedOutside(fakeDb(rows, { failRead: "knowledge_documents" }), [live], ["document_versions.file_url"]))
      .rejects.toThrow(/knowledge_documents\.file_key .*refusing to proceed/);
    const reads: string[] = [];
    expect((await keysReferencedOutside(fakeDb(rows, { reads }), ["https://x/y.pdf", ""])).size).toBe(0);
    expect(reads).toEqual([]);
  });
});

describe("BKP-9 Done-when 3 — the export's value scan for keys no registered column names", () => {
  const known = new Set([k("libraries/l1/P-101.pdf")]);
  const tables: Record<string, unknown[]> = {
    document_versions: [{ id: "v1", file_url: k("libraries/l1/P-101.pdf") }],
    // a future column the registry does not know, inside JSON
    notes: [{ id: "n1", task_meta: { evidence: [{ path: k("notes/n1/photo.jpg") }] } }],
    checkout_messages: [{ id: "cm1", metadata: { file: k("notes/n1/photo.jpg") } }],
    // history, not a reference: a deleted file's key in an audit row
    audit_logs: [{ id: "a1", details: { path: k("deleted/old.pdf") } }],
    // another workspace's key is never this backup's business
    milestones: [{ id: "ms1", attributes: { doc: `orgs/${OTHER}/x.pdf` } }],
  };

  it("finds each unregistered key once, with the first table.column that names it", () => {
    expect(findUnregisteredOrgKeys(tables, ORG, known)).toEqual([{ path: k("notes/n1/photo.jpg"), at: "notes.task_meta" }]);
  });

  it("finds nothing without an org, and nothing the registry already collected", () => {
    expect(findUnregisteredOrgKeys(tables, "", known)).toEqual([]);
    expect(findUnregisteredOrgKeys({ document_versions: tables.document_versions }, ORG, known)).toEqual([]);
  });
});
