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
//     of exportCoverage.test.ts) — and the declared list is exactly that plus
//     the JSON columns that hold a key under another name (JSON_KEY_COLUMNS);
//   * the writer census (fix pass): every call site that writes an object to
//     storage names the column its key is persisted into, and that column is
//     registered — the name census could not see libraries / collections.
//     page_config (a page background's imagePath), which the orphan purge
//     therefore deleted while every backup lacked it;
//   * the two collectors read the same sources and return the same keys
//     (less the one table the export does not carry, `users`, excluded);
//   * the orphan sweep refuses to run on a source list smaller than the
//     schema's key columns (BKP-2 Done-when 3);
//   * keysReferencedOutside — the predicate the document shed needs (ILIFE-5);
//   * findUnregisteredOrgKeys — the export's value scan (BKP-9 Done-when 3).

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => ({})) }, R2_BUCKET: "test-bucket" }));

import { censusSchema } from "./helpers/schemaKeys";
import {
  STORAGE_KEY_SOURCES, STORAGE_KEY_COLUMNS, NOT_STORAGE_KEY_COLUMNS, BINARY_LINK_TABLES, KEY_MENTION_TABLES, JSON_KEY_COLUMNS,
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
  libraries: [{ id: "l1", cover_image_url: k("branding/covers/l1.png"), page_config: { header: { height: "md" }, background: { type: "image", imagePath: k("branding/backgrounds/l1.jpg"), opacity: 0.18 } } }],
  collections: [
    { id: "c1", cover_image_url: "data:image/png;base64,AAAA", page_config: { background: { type: "tint", tint: "brand" } } },
    { id: "c2", cover_image_url: k("branding/covers/c2.png"), page_config: { background: { type: "image", imagePath: k("branding/backgrounds/c2.png") } } },
  ],
  users: [{ id: "u1", avatar_path: `avatars/u1.png` }],
  org_configurations: [{ id: "oc1", key: "branding", data: { logoPath: k("branding/logo-1.svg") } }, { id: "oc2", key: "drafting", data: { logoPath: k("not-a-logo.svg") } }],
  output_templates: [{ id: "ot1", template_file_key: k("output-templates/ds.docx"), example_files: [{ key: k("output-examples/ex1.docx") }, { url: k("output-examples/ex2.docx") }] }],
  cost_documents: [{ id: "cd1", file_url: k("project-costs/p1/quote-1-acme.pdf") }],
};

/** A thenable stand-in for the service-role client over ROWS (keyset reads, head counts, `.in` filters). */
function fakeDb(rows: Record<string, Row[]>, opts: {
  failRead?: string; reads?: string[];
  /** PostgREST's max-rows: a read returns at most this many rows (silently). */
  maxRows?: number;
  /** A server that answers no count even when one is asked for. */
  countless?: boolean;
} = {}): SupabaseClient {
  return {
    from: (table: string) => {
      let head = false; let counted = false; let after: string | null = null; let cap: number | null = null;
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
              const matched = out.length;
              if (cap !== null) out = out.slice(0, cap);
              if (opts.maxRows !== undefined) out = out.slice(0, opts.maxRows);
              resolve(counted && !opts.countless ? { data: out, count: matched, error: null } : { data: out, error: null });
            };
          }
          return (...args: unknown[]) => {
            if (prop === "select") {
              head = (args[1] as { head?: boolean } | undefined)?.head === true;
              counted = (args[1] as { count?: string } | undefined)?.count === "exact";
            }
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

  it("STORAGE_KEY_COLUMNS is exactly the key-named columns plus the declared JSON key columns — no more, no less", () => {
    const expected = new Set([...candidates.filter((c) => !(c in NOT_STORAGE_KEY_COLUMNS)), ...Object.keys(JSON_KEY_COLUMNS)]);
    expect([...STORAGE_KEY_COLUMNS].sort()).toEqual([...expected].sort());
    expect(new Set(STORAGE_KEY_COLUMNS).size).toBe(STORAGE_KEY_COLUMNS.length);
  });

  it("every JSON key column is registered, says where the key sits, and a registered column the name census cannot see is one", () => {
    for (const [col, where] of Object.entries(JSON_KEY_COLUMNS)) {
      expect(STORAGE_KEY_COLUMNS, col).toContain(col);
      expect(where.trim().length, col).toBeGreaterThan(20);
    }
    const invisible = STORAGE_KEY_COLUMNS.filter((c) => !KEY_NAME_RE.test(c.split(".")[1]));
    for (const c of invisible) expect(Object.keys(JSON_KEY_COLUMNS), `${c} holds a key the name census cannot see`).toContain(c);
    // the fix pass's two: the page backgrounds the purge deleted and no backup carried
    expect(invisible).toEqual(expect.arrayContaining(["libraries.page_config", "collections.page_config", "org_configurations.data"]));
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

  it("every extracted key names one of its source's key columns (the manifest order and the census read that column)", () => {
    for (const s of STORAGE_KEY_SOURCES) {
      for (const r of ROWS[s.table] ?? []) {
        for (const c of s.extract(r)) expect(s.keyColumns, `${s.label}: ${c.column}`).toContain(c.column);
        for (const ref of keysOf(s, r)) expect(STORAGE_KEY_COLUMNS, ref.column).toContain(ref.column);
      }
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

  it("the manifest order is STORAGE_KEY_COLUMNS': what every backup carried before the registry first, the added columns after", () => {
    const order = collectFilePaths(ROWS).map((r) => r.path);
    const rank = (key: string) => order.indexOf(key);
    // a capped server ZIP embeds in this order: the old categories keep their place
    for (const before of [k("libraries/l1/P-101.pdf"), k("tickets/t1/redline.pdf"), k("assets/a1/photos/1.jpg"), k("plot-plans/pp1.png"), k("branding/logo-1.svg")]) {
      for (const after of [k("libraries/l1/P-101.dwg"), k("knowledge/kl1/manual.pdf"), k("project-costs/p1/quote-1-acme.pdf"), k("output-templates/ds.docx"), k("branding/backgrounds/l1.jpg")]) {
        expect(rank(before), `${before} before ${after}`).toBeLessThan(rank(after));
      }
    }
    expect(STORAGE_KEY_COLUMNS.slice(0, 8)).toEqual([
      "document_versions.file_url", "tickets.attachments", "markup_requests.shared_markup_url", "asset_photos.file_url",
      "plot_plans.image_path", "libraries.cover_image_url", "collections.cover_image_url", "org_configurations.data",
    ]);
    // a key two columns name (a knowledge mirror of a revision) keeps the earlier column's place
    const mirrored = collectFilePaths({
      knowledge_documents: [{ id: "kd", file_key: k("libraries/l1/P-101.pdf") }, { id: "kd2", file_key: k("knowledge/x.pdf") }],
      asset_photos: [{ id: "ap", file_url: k("assets/a1/photos/1.jpg") }],
      document_versions: [{ id: "v", file_url: k("libraries/l1/P-101.pdf") }],
    }).map((r) => r.path);
    expect(mirrored).toEqual([k("libraries/l1/P-101.pdf"), k("assets/a1/photos/1.jpg"), k("knowledge/x.pdf")]);
  });

  it("a library's and a folder's page background are in BOTH collectors (the purge no longer deletes them)", async () => {
    const exportKeys = new Set(collectFilePaths(ROWS).map((r) => r.path));
    const sweepKeys = await collectReferencedKeys(fakeDb(ROWS));
    for (const key of [k("branding/backgrounds/l1.jpg"), k("branding/backgrounds/c2.png")]) {
      expect(exportKeys.has(key), `export: ${key}`).toBe(true);
      expect(sweepKeys.has(key), `sweep: ${key}`).toBe(true);
    }
    // on the registry before this fix pass, the export's own value scan named the gap
    const pages = { libraries: ROWS.libraries, collections: ROWS.collections };
    const before = STORAGE_KEY_SOURCES.filter((s) => !s.keyColumns.includes("page_config"));
    const knownBefore = new Set(before.flatMap((s) => (pages[s.table as keyof typeof pages] ?? []).flatMap((r) => keysOf(s, r).map((x) => x.path))));
    expect(findUnregisteredOrgKeys(pages, ORG, knownBefore).map((u) => u.at).sort()).toEqual(["collections.page_config", "libraries.page_config"]);
    expect(findUnregisteredOrgKeys(pages, ORG, new Set(collectFilePaths(pages).map((r) => r.path)))).toEqual([]);
    expect(registryGaps(before).unread).toEqual(["collections.page_config", "libraries.page_config"]);
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
    for (const json of Object.keys(JSON_KEY_COLUMNS)) expect(cols, json).not.toContain(json);
    // without the exclusion, the shed's own column answers too
    expect([...(await keysReferencedOutside(fakeDb(rows), [live, freeable]))].sort()).toEqual([freeable, live].sort());
  });

  it("a read a server row cap cut short refuses (fail closed) — a hit past the cap would otherwise free a referenced object", async () => {
    // 12 knowledge mirrors name the live key; the server returns at most 5 rows per read.
    const many: Record<string, Row[]> = {
      ...rows,
      knowledge_documents: Array.from({ length: 12 }, (_, i) => ({ id: `kd${String(i).padStart(2, "0")}`, file_key: i < 11 ? freeable.replace("P-099", `P-0${i}`) : live })),
    };
    const keys = [...many.knowledge_documents.map((r) => r.file_key as string)];
    await expect(keysReferencedOutside(fakeDb(many, { maxRows: 5 }), keys, ["document_versions.file_url"]))
      .rejects.toThrow(/knowledge_documents\.file_key .*returned 5 of 12 matching rows.*refusing to proceed/);
    // no count in the answer: a page as large as PostgREST's default cap (1000) refuses too
    const full: Record<string, Row[]> = {
      knowledge_documents: Array.from({ length: 1000 }, (_, i) => ({ id: `kd${String(i).padStart(4, "0")}`, file_key: live })),
    };
    await expect(keysReferencedOutside(fakeDb(full, { countless: true }), [live], ["document_versions.file_url"]))
      .rejects.toThrow(/knowledge_documents\.file_key .*an unknown number of matching rows.*refusing to proceed/);
    // under the cap, every hit comes back and nothing refuses
    expect([...(await keysReferencedOutside(fakeDb(many, { maxRows: 50 }), keys, ["document_versions.file_url"]))].sort()).toEqual([...new Set(keys)].sort());
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

// ── The writer census (fix pass) ───────────────────────────────────────────
// The column census reads NAMES, so a key stored inside JSON under another
// name is invisible to it — libraries / collections.page_config (a page
// background's `imagePath`) was, and the purge deleted those images. This
// census works from the other end: every call site in the app that writes an
// object into OUR storage is listed with the column its key is persisted
// into, and that column must be registered. A new upload site, or a new call
// in a listed file, fails until someone says where its key lives.
const WRITE_RE = /\b(uploadToPath|uploadFile|uploadTicketAttachment|uploadUserPrivateFile|putWithXhr|putObject)\s*\(|new\s+(PutObjectCommand|CreateMultipartUploadCommand)\s*\(|["'`]\/api\/storage\/(upload-url|multipart)\b/g;

/** file → how many write sites it has, and where their keys are persisted (or why they are not). */
const STORAGE_WRITERS: Record<string, { calls: number; persists?: string[]; why?: string }> = {
  // the doors themselves: they write the key their caller names; the callers are censused below
  "lib/storage.ts": { calls: 13, why: "the upload door (uploadToPath / putWithXhr / multipart and its wrappers); its connectivity probe writes orgs/<org>/diagnostics/probe-*, which no row names by design" },
  "app/api/storage/upload-url/route.ts": { calls: 1, why: "presigns a PUT for the key its caller names — the callers persist it (uploadToPath and the restore page)" },
  "app/api/storage/multipart/route.ts": { calls: 1, why: "the multipart door for the key its caller names (uploadToPath's big-file path)" },
  // writers into registered columns
  "app/(protected)/admin/branding/page.tsx": { calls: 1, persists: ["org_configurations.data"] },
  "components/branding/LogoUploadModal.tsx": { calls: 1, persists: ["org_configurations.data"] },
  "app/(protected)/documents/[libraryId]/page.tsx": { calls: 1, persists: ["document_versions.file_url"] },
  "lib/documentLifecycle/common.ts": { calls: 1, persists: ["document_versions.file_url"] },
  "lib/revisions.ts": { calls: 5, persists: ["document_versions.file_url", "document_versions.source_file_key"] },
  "lib/knowledge.ts": { calls: 1, persists: ["knowledge_documents.file_key"] },
  "lib/plotPlans.ts": { calls: 1, persists: ["plot_plans.image_path"] },
  "lib/costDocs.ts": { calls: 1, persists: ["cost_documents.file_url"] },
  "lib/userProfiles.ts": { calls: 1, persists: ["users.avatar_path"] },
  "lib/outputTemplates.ts": { calls: 1, persists: ["output_templates.template_file_key", "output_templates.example_files"],
    why: "uploadTemplateFile also stages a generation's source spreadsheet under output-data/, which no row keeps (the sweep reclaims it)" },
  "components/assets/AssetPhotoUploader.tsx": { calls: 1, persists: ["asset_photos.file_url"] },
  "components/documents/CustomizeNodeModal.tsx": { calls: 2, persists: ["libraries.cover_image_url", "collections.cover_image_url", "libraries.page_config", "collections.page_config"] },
  "app/(protected)/requests/new/page.tsx": { calls: 1, persists: ["tickets.attachments"] },
  "app/(protected)/requests/[id]/page.tsx": { calls: 3, persists: ["tickets.attachments"] },
  "components/documents/CheckInPanel.tsx": { calls: 1, persists: ["tickets.attachments"] },
  "app/api/admin/ticket-shed/restore/route.ts": { calls: 1, persists: ["tickets.attachments"] },
  "app/api/intake/upload/route.ts": { calls: 6, persists: ["document_versions.file_url", "tickets.attachments", "cost_documents.file_url"] },
  "app/submit/[token]/page.tsx": { calls: 1, persists: ["document_versions.file_url", "tickets.attachments", "cost_documents.file_url"],
    why: "the vendor portal PUTs to the intake door's staged URL; app/api/intake/upload/route.ts persists the key" },
  "app/(protected)/admin/restore/page.tsx": { calls: 1, persists: [...STORAGE_KEY_COLUMNS.filter((c) => c !== "users.avatar_path")],
    why: "\"Put the files back\" re-uploads a backup's binaries under the keys its restored rows name — every column the backup carries" },
  // not our storage
  "lib/exportRunner.ts": { calls: 2, why: "writes the export archive into the CUSTOMER's own bucket (an export destination), never ours" },
};

describe("the writer census: every storage write names a registered column (fix pass)", () => {
  const root = process.cwd();
  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = join(dir, d.name);
      if (d.isDirectory()) return d.name === "__tests__" || d.name === "node_modules" ? [] : walk(p);
      return /\.(ts|tsx)$/.test(d.name) ? [p] : [];
    });
  }
  const found = new Map<string, number>();
  for (const dir of ["app", "lib", "components", "hooks"]) {
    for (const f of walk(join(root, dir))) {
      const n = [...readFileSync(f, "utf8").matchAll(WRITE_RE)].length;
      if (n > 0) found.set(f.slice(root.length + 1).split("\\").join("/"), n);
    }
  }

  it("sees the writers (not vacuous)", () => {
    expect(found.get("components/documents/CustomizeNodeModal.tsx")).toBe(2);
    expect(found.get("lib/costDocs.ts")).toBe(1);
    expect(found.size).toBeGreaterThan(15);
  });

  it("every file that writes to storage is listed, with its exact number of write sites", () => {
    const listed = Object.fromEntries(Object.entries(STORAGE_WRITERS).map(([f, w]) => [f, w.calls]));
    expect(
      Object.fromEntries([...found].sort()),
      "A storage write site was added, removed or moved. List the file in STORAGE_WRITERS (storageKeyRegistry.test.ts) with the " +
      "column its key is persisted into, and register that column in lib/storageKeyRegistry.ts (JSON_KEY_COLUMNS too when the key sits inside JSON).",
    ).toEqual(Object.fromEntries(Object.entries(listed).sort()));
  });

  it("every column a writer persists into is registered, so both collectors read it", () => {
    for (const [file, w] of Object.entries(STORAGE_WRITERS)) {
      expect((w.persists?.length ?? 0) > 0 || (w.why ?? "").trim().length > 30, `${file} needs persisted columns or a reason`).toBe(true);
      for (const col of w.persists ?? []) expect(STORAGE_KEY_COLUMNS, `${file} persists into ${col}`).toContain(col);
    }
    // the page backgrounds this census exists for
    expect(STORAGE_WRITERS["components/documents/CustomizeNodeModal.tsx"].persists).toEqual(
      expect.arrayContaining(["libraries.page_config", "collections.page_config"]),
    );
  });

  it("the customize modal's background upload really is persisted into page_config.background.imagePath", () => {
    const modal = readFileSync(join(root, "components/documents/CustomizeNodeModal.tsx"), "utf8");
    expect(modal).toMatch(/\/backgrounds\/\$\{rand\}\.\$\{ext\}`;\s*await uploadToPath\(file, path/);
    expect(modal).toMatch(/set\(\{ bgImagePath: path/);
    const page = readFileSync(join(root, "app/(protected)/documents/page.tsx"), "utf8");
    expect(page).toMatch(/imagePath: v\.bgImagePath/);
    expect(page).toMatch(/page_config: pageConfig/);
  });
});
