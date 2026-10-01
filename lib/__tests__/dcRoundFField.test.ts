// document-control Round F wave 2 — P8 FIELD: packs, prints, the download
// footer and the work-package rails.
//
//   PKG-7    a member the reader cannot open is never silently erased: an
//            explicit skip in the pack, "unknown" (never fresh) on the list,
//            its pin never NULLed on refresh, a package refused at create.
//   PKG-9    the hard read-&-understood gate runs per sheet in the pack,
//            through the ONE helper a single download uses.
//   PKG-10   a non-current copy is watermarked SUPERSEDED; a copy with baked
//            markups is never the controlled master.
//   PKG-12   a pack has a sheet / page budget, refused before anything is
//            recorded, with a split; the caller's order is kept; the cover
//            gives each entry its pages.
//   HLD-1    a held document's copy is stamped with the hold (never a raw
//            controlled pass-through); an unreadable hold state is a hold.
//   EGR-6    every download_audits write is checked and a refusal is said.
//   DRLS-10  a re-pin is recorded before it moves anything; a close that
//            matches no row is a refusal, not "closed".
//   VFY-18   a print whose snapshot cannot be written stops before download.
//   VFY-19   the snapshot records what the print left out, with a code.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  /** A read error per table (select). */
  readErrors: {} as Record<string, { message: string; code?: string } | undefined>,
  /** An insert error per table. */
  insertErrors: {} as Record<string, { message: string } | undefined>,
  /** Row ids whose UPDATE matches zero rows (an RLS refusal). */
  updateDenied: new Set<string>(),
  inserts: [] as Array<{ table: string; row: unknown }>,
  updates: [] as Array<{ table: string; patch: Record<string, unknown>; filters: Record<string, unknown> }>,
  events: [] as string[],
  stamps: [] as Array<Record<string, unknown>>,
  stampedDownloads: [] as Array<{ filename: string; options: Record<string, unknown> }>,
  /** Pages of the PDF served at a URL (the mock's ArrayBuffer length). */
  pagesByUrl: {} as Record<string, number>,
  failUrls: new Set<string>(),
  unparseable: new Set<number>(),
  /** Page counts whose parsed document is encrypted / whose page copy throws. */
  encrypted: new Set<number>(),
  copyFails: new Set<number>(),
  /** Page counts whose pdf-lib LOAD runs out of memory (a large valid scan). */
  loadOom: new Set<number>(),
  /** How many times pdf-lib's load ran. */
  loads: 0,
  /** A fetched file's byte length, when it must differ from its page count
   *  (a file over the pack's byte budget, never allocated in the test). */
  byteLengthByUrl: {} as Record<string, number>,
  user: { id: "u1", email: "u1@example.com" } as { id: string; email: string } | null,
  /** Every `.in()` filter, per table (the chunking pins). */
  inCalls: [] as Array<{ table: string; column: string; n: number }>,
  /** PostgREST's max-rows: a read returns at most this many rows, with no
   *  error (lib/assets.ts AREA-9). */
  maxRows: Infinity,
  /** Every `.range()` window, per table (the paging pins). */
  rangeCalls: [] as Array<{ table: string; from: number; to: number }>,
  /** A read error on the Nth `.range()` page of a table (0-based). */
  pageErrorAt: {} as Record<string, number | undefined>,
  /** A response's declared Content-Length, per URL (fix pass 3). */
  declaredLengthByUrl: {} as Record<string, number>,
  /** Every URL whose body was read whole (arrayBuffer). */
  bodyReads: [] as string[],
  /** Every SELECT, per table, with its .eq() filters (the policy-read pins). */
  selects: [] as Array<{ table: string; filters: Record<string, unknown> }>,
}));

function chain(table: string) {
  const filters: Record<string, unknown> = {};
  const ins: Record<string, unknown[]> = {};
  let op: "select" | "insert" | "update" = "select";
  let payload: unknown = null;
  let single = false;
  let range: [number, number] | null = null;
  let withCount = false;
  const resolveIt = () => {
    if (op === "insert") {
      state.inserts.push({ table, row: payload });
      state.events.push(`insert:${table}`);
      const error = state.insertErrors[table] ?? null;
      if (single) return { data: error ? null : { id: `${table}-1` }, error };
      return { data: null, error };
    }
    if (op === "update") {
      state.updates.push({ table, patch: payload as Record<string, unknown>, filters: { ...filters } });
      state.events.push(`update:${table}`);
      const id = String(filters.id ?? "");
      return { data: state.updateDenied.has(id) ? [] : [{ id }], error: null };
    }
    state.selects.push({ table, filters: { ...filters } });
    if (state.readErrors[table]) return { data: null, error: state.readErrors[table] };
    const rows = (state.tables[table] ?? []).filter((r) =>
      Object.entries(ins).every(([k, v]) => v.includes(r[k])) &&
      Object.entries(filters).every(([k, v]) => !(k in r) || r[k] === v));
    if (single) return { data: rows[0] ?? null, error: null };
    if (range) {
      const page = state.rangeCalls.filter((c) => c.table === table).length;
      state.rangeCalls.push({ table, from: range[0], to: range[1] });
      if (state.pageErrorAt[table] === page) return { data: null, error: { message: "page read failed" } };
    }
    const window = range ? rows.slice(range[0], range[1] + 1) : rows;
    const capped = window.slice(0, Number.isFinite(state.maxRows) ? state.maxRows : undefined);
    return { data: capped, error: null, count: withCount ? rows.length : null };
  };
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, p: string) {
      if (p === "then") return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
        try { resolve(resolveIt()); } catch (e) { reject?.(e); }
      };
      return (...args: unknown[]) => {
        if (p === "insert") { op = "insert"; payload = args[0]; }
        if (p === "update") { op = "update"; payload = args[0]; }
        if (p === "eq") filters[String(args[0])] = args[1];
        if (p === "is") filters[String(args[0])] = args[1];
        if (p === "in") { ins[String(args[0])] = args[1] as unknown[]; state.inCalls.push({ table, column: String(args[0]), n: (args[1] as unknown[]).length }); }
        if (p === "single" || p === "maybeSingle") single = true;
        if (p === "range") range = [Number(args[0]), Number(args[1])];
        if (p === "select" && (args[1] as { count?: string } | undefined)?.count === "exact") withCount = true;
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => chain(t),
    auth: {
      getSession: async () => ({ data: { session: { access_token: "tok" } } }),
      getUser: async () => ({ data: { user: state.user } }),
    },
  },
}));
vi.mock("@/lib/acknowledgments", () => {
  // the pure resolver, as lib/acknowledgments.ts has it (most specific DEFINED level wins)
  const resolveEffectiveAckPolicy = (...levels: Array<{ enabled?: boolean } | null | undefined>) => {
    for (const p of levels) if (p) return p.enabled ? p : null;
    return null;
  };
  return {
    resolveEffectiveAckPolicy,
    // As lib/acknowledgments.ts has it: the folder / library reads' `{ error }`
    // is never looked at, so a failed read resolves as "no policy" (it does not
    // throw). P8's fifth fix pass stops the gate calling it; a call is a regression.
    effectiveAckPolicyForDocument: vi.fn(async (d: { ackPolicy?: { enabled?: boolean } | null; collectionId?: string | null; libraryId: string }) => {
      const { supabase } = await import("@/lib/supabase");
      let folder: { enabled?: boolean } | null = null;
      if (d.collectionId) {
        const { data } = await supabase.from("collections").select("ack_policy").eq("id", d.collectionId).maybeSingle();
        folder = (data as { ack_policy?: { enabled?: boolean } | null } | null)?.ack_policy ?? null;
      }
      const { data: lib } = await supabase.from("libraries").select("ack_policy").eq("id", d.libraryId).maybeSingle();
      return resolveEffectiveAckPolicy(d.ackPolicy ?? null, folder, (lib as { ack_policy?: { enabled?: boolean } | null } | null)?.ack_policy ?? null);
    }),
  };
});
vi.mock("@/lib/stamping", () => ({
  applyStampToPdfDoc: vi.fn(async (doc: { isEncrypted?: boolean }, opts: Record<string, unknown>) => {
    if (doc?.isEncrypted) throw new Error("the PDF is encrypted, so it cannot be stamped — it was not issued as a copy");
    state.stamps.push(opts);
  }),
  stampPdf: vi.fn(async (_url: string, opts: Record<string, unknown>) => { state.stamps.push(opts); return new Blob(["%PDF"]); }),
  downloadStampedPdf: vi.fn(async (p: { filename: string; options: Record<string, unknown> }) => {
    state.events.push("download");
    state.stampedDownloads.push({ filename: p.filename, options: p.options });
  }),
}));
vi.mock("@/lib/intents", () => ({ recordIntent: vi.fn(async () => { state.events.push("intent"); }) }));
vi.mock("@/lib/publicOrigin", () => ({ publicOrigin: () => "https://app.example.com" }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => {}) }));
vi.mock("pdf-lib", () => {
  const doc = (pages: number) => ({
    isEncrypted: state.encrypted.has(pages),
    copyPages: async (src: { getPageCount: () => number }, idx: number[]) => {
      if (state.copyFails.has(src.getPageCount())) throw new RangeError("Array buffer allocation failed");
      return idx.map(() => "page");
    },
    addPage: () => {},
    insertPage: (i: number) => { state.events.push(`insert@${i}`); },
    getPageIndices: () => Array.from({ length: pages }, (_, i) => i),
    getPageCount: () => pages,
    save: async () => { state.events.push("save"); return new Uint8Array([1]); },
  });
  return {
    PDFDocument: {
      create: async () => doc(0),
      load: async (bytes: ArrayBuffer) => {
        state.loads += 1;
        if (state.loadOom.has(bytes.byteLength)) throw new RangeError("Array buffer allocation failed");
        if (state.unparseable.has(bytes.byteLength)) throw new Error("Failed to parse PDF document (line:0 col:0 offset=0): No PDF header found");
        return doc(bytes.byteLength);
      },
    },
  };
});

import {
  buildAndDownloadDocPack, assessPackDocs, PackTooLargeError, PACK_MAX_SHEETS, PACK_MAX_PAGES, PACK_MAX_BYTES, packPartsFor, splitPackIds,
  packSheetBudgetRefusal, accountForRequested, packSheetOverBudget, packContentBudgetRefusal, packBuildFailureCode, isOutOfMemoryError,
  packSplitPlan, PackSheetTooLargeError, fieldPackBudgetEnforced, describePackSplit,
} from "@/lib/docPack";
import {
  listWorkPackages, createWorkPackage, refreshWorkPackage, recordPackagePrint, setWorkPackageStatus,
  printSnapshotSheets, coverEntryLabels, mergeLeftOut, memberFreshness, PackagePrintNotRecordedError, resetPackageSchemaFlag,
  readPackageMemberIds,
} from "@/lib/workPackages";
import {
  downloadDocumentPdf, printDocumentPdf, buildFooterNotice, copyControlState, copyWatermark, holdFooterLine,
  logDownloadAudit, DownloadUnrecordedError, AcknowledgmentRequiredError, ackGatedDocumentIds, ackGateDocuments,
} from "@/lib/downloads";
import { packLeftOutText } from "@/lib/packLeftOut";
import type { DocumentRecord } from "@/types/schema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

function docRow(id: string, over: Row = {}): Row {
  return {
    id, org_id: "org1", document_number: id.toUpperCase(), title: null, name: null, rev: "1", status: "Issued",
    library_id: "lib1", collection_id: null, ack_policy: null, current_version_id: `v-${id}`,
    checked_out_by: null, checked_out_by_name: null, checkout_note: null, ...over,
  };
}
function versionFor(id: string, pages = 2): Row {
  state.pagesByUrl[`https://files/${id}.pdf`] = pages;
  return { id: `v-${id}`, file_url: `https://files/${id}.pdf` };
}

beforeEach(() => {
  state.tables = {};
  state.readErrors = {};
  state.insertErrors = {};
  state.updateDenied = new Set();
  state.inserts = [];
  state.updates = [];
  state.events = [];
  state.selects = [];
  state.stamps = [];
  state.stampedDownloads = [];
  state.pagesByUrl = {};
  state.failUrls = new Set();
  state.unparseable = new Set();
  state.encrypted = new Set();
  state.copyFails = new Set();
  state.loadOom = new Set();
  state.loads = 0;
  state.byteLengthByUrl = {};
  state.user = { id: "u1", email: "u1@example.com" };
  state.inCalls = [];
  state.maxRows = Infinity;
  state.rangeCalls = [];
  state.pageErrorAt = {};
  state.declaredLengthByUrl = {};
  state.bodyReads = [];
  resetPackageSchemaFlag();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    if (state.failUrls.has(u)) return { ok: false, status: 503 };
    return {
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" && state.declaredLengthByUrl[u] !== undefined ? String(state.declaredLengthByUrl[u]) : null) },
      body: { cancel: async () => { state.events.push(`cancel:${u}`); } },
      arrayBuffer: async () => {
        state.bodyReads.push(u);
        return state.byteLengthByUrl[u]
          ? ({ byteLength: state.byteLengthByUrl[u] } as unknown as ArrayBuffer)
          : new ArrayBuffer(state.pagesByUrl[u] ?? 1);
      },
      blob: async () => new Blob(["raw"]),
    };
  }));
  vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
  vi.stubGlobal("document", {
    createElement: () => ({ click: () => { state.events.push("download"); }, set href(_: string) {}, set download(_: string) {} }),
    body: { appendChild: () => {}, removeChild: () => {} },
  });
  vi.stubGlobal("window", { open: () => null });
});

const packInput = (documentIds: string[], extra: Row = {}) => ({
  orgId: "org1", packLabel: "pack", documentIds, userId: "u1", userEmail: "u1@example.com", ...extra,
});

// ─── PKG-7 ──────────────────────────────────────────────────────────────────

describe("PKG-7 — a member the reader cannot open is never silently erased", () => {
  it("docPack: a requested id RLS did not return is an explicit 'unreadable' skip, and the cover is built from the merged sheets only", async () => {
    state.tables.documents = [docRow("a"), docRow("c")]; // "b" is ACL-hidden from this reader
    state.tables.document_versions = [versionFor("a"), versionFor("c")];
    const covered: string[] = [];
    let coverSkipped: string[] = [];
    const result = await buildAndDownloadDocPack(packInput(["a", "b", "c"], {
      buildCoverAfter: async (included: Array<{ documentId: string }>, skipped: Array<{ documentId?: string; code?: string }>) => {
        covered.push(...included.map((s) => s.documentId));
        coverSkipped = skipped.map((s) => `${s.documentId}:${s.code}`);
        return null;
      },
    }) as never);
    expect(result.included).toBe(2);
    expect(covered).toEqual(["a", "c"]);
    expect(result.skipped).toEqual([expect.objectContaining({ documentId: "b", label: "Restricted document", code: "unreadable" })]);
    expect(coverSkipped).toEqual(["b:unreadable"]);
  });

  it("accountForRequested keeps the caller's order, de-duplicates, and names every missing id", () => {
    const { rows, skipped } = accountForRequested(["z", "x", "y", "x"], [{ id: "x" }, { id: "z" }]);
    expect(rows.map((r) => r.id)).toEqual(["z", "x"]);
    expect(skipped.map((s) => s.documentId)).toEqual(["y"]);
  });

  it("a documents read that FAILS is not an empty pack — it throws, nothing printed", async () => {
    state.readErrors.documents = { message: "timeout" };
    await expect(assessPackDocs(["a"])).rejects.toThrow(/Couldn't read the pack's documents \(timeout\)/);
  });

  it("listWorkPackages: an unreadable member is 'unknown' (never fresh), named Restricted document, and counted", async () => {
    state.tables.work_packages = [{ id: "p1", org_id: "org1", name: "Pump swap", status: "open", owner_user_id: "owner", created_at: "2026-09-01" }];
    state.tables.work_package_documents = [
      { id: "m1", package_id: "p1", document_id: "a", pinned_version_id: "v-a", pinned_rev_label: "1" },
      { id: "m2", package_id: "p1", document_id: "hidden", pinned_version_id: "v-old", pinned_rev_label: "4" },
    ];
    state.tables.documents = [docRow("a")];
    const [pkg] = await listWorkPackages("org1");
    expect(pkg.docs.map((d) => [d.documentId, d.freshness, d.readable, d.drifted])).toEqual([
      ["a", "fresh", true, false],
      ["hidden", "unknown", false, false],
    ]);
    expect(pkg.docs[1].docLabel).toBe("Restricted document");
    expect(pkg.docs[1].unknownReason).toBe("restricted");
    expect(pkg.docs[0].unknownReason).toBeNull();
    expect(pkg.unknownCount).toBe(1);
    expect(pkg.staleCount).toBe(0);
    expect(pkg.membersUnread).toBe(false);
    expect(memberFreshness("v1", { current_version_id: "v2" })).toBe("drifted");
    expect(memberFreshness("v1", null)).toBe("unknown");
  });

  it("listWorkPackages: a member read that FAILS is never '0 docs, Fresh' — the package's sheets are unknown, and the page says 'not read'", async () => {
    state.tables.work_packages = [{ id: "p1", org_id: "org1", name: "Pump swap", status: "open", owner_user_id: "owner", created_at: "2026-09-01" }];
    state.readErrors.work_package_documents = { message: "upstream timeout" };
    const [pkg] = await listWorkPackages("org1");
    expect(pkg.membersUnread).toBe(true);
    expect(pkg.docs).toEqual([]);
    const page = src("app/(protected)/packages/page.tsx");
    expect(page).toContain("const unknown = !stale && (pkg.unknownCount > 0 || pkg.membersUnread);");
    expect(page).toContain('{stale ? `Stale · ${pkg.staleCount}` : unknown ? (pkg.membersUnread ? "Unknown · not read" : `Unknown · ${pkg.unknownCount}`) : "Fresh"}');
    expect(page).toContain("disabled={printing === pkg.id || pkg.membersUnread}");
  });

  it("listWorkPackages: a documents read that FAILS says 'not read just now', never 'restricted' (a permission it did not learn)", async () => {
    state.tables.work_packages = [{ id: "p1", org_id: "org1", name: "Pump swap", status: "open", owner_user_id: "owner", created_at: "2026-09-01" }];
    state.tables.work_package_documents = [{ id: "m1", package_id: "p1", document_id: "a", pinned_version_id: "v-a", pinned_rev_label: "1" }];
    state.readErrors.documents = { message: "URI too long" };
    const [pkg] = await listWorkPackages("org1");
    expect(pkg.docs[0]).toMatchObject({ freshness: "unknown", unknownReason: "unread", docLabel: "Document (not read just now)", readable: false });
    expect(pkg.unknownCount).toBe(1);
    const page = src("app/(protected)/packages/page.tsx");
    expect(page).toContain('{d.freshness === "unknown" && d.unknownReason === "unread" ? (');
    expect(page).toMatch(/not read just now\n/);
  });

  it("listWorkPackages chunks its .in() reads (150 ids per read) — ~30 open packages of ~20 sheets is not one 600-id GET", async () => {
    state.tables.work_packages = Array.from({ length: 160 }, (_, i) => ({ id: `p${i}`, org_id: "org1", name: `P${i}`, status: "open", owner_user_id: "owner", created_at: "2026-09-01" }));
    state.tables.work_package_documents = Array.from({ length: 320 }, (_, i) => ({ id: `m${i}`, package_id: `p${i % 160}`, document_id: `d${i}`, pinned_version_id: `v-d${i}`, pinned_rev_label: "1" }));
    state.tables.documents = Array.from({ length: 320 }, (_, i) => docRow(`d${i}`));
    const pkgs = await listWorkPackages("org1");
    expect(pkgs).toHaveLength(160);
    expect(pkgs.every((p) => p.docs.length === 2 && p.unknownCount === 0 && !p.membersUnread)).toBe(true);
    expect(state.inCalls.filter((c) => c.table === "work_package_documents").map((c) => c.n)).toEqual([150, 10]);
    expect(state.inCalls.filter((c) => c.table === "documents").map((c) => c.n)).toEqual([150, 150, 20]);
  });

  it("listWorkPackages PAGES each member read past PostgREST's max-rows — 50 open packages of 25 sheets (1250 rows) never lose their newest members to a silent 1000-row cap (fix pass 3)", async () => {
    state.maxRows = 1000;
    state.tables.work_packages = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, org_id: "org1", name: `P${i}`, status: "open", owner_user_id: "owner", created_at: "2026-09-01" }));
    // in added_at order: the LAST 250 rows are the members a 1000-row cap used to drop
    state.tables.work_package_documents = Array.from({ length: 1250 }, (_, i) => ({
      id: `m${String(i).padStart(4, "0")}`, package_id: `p${i % 50}`, document_id: `d${i}`, pinned_version_id: `v-d${i}`, pinned_rev_label: "1",
    }));
    state.tables.documents = Array.from({ length: 1250 }, (_, i) => docRow(`d${i}`));
    const pkgs = await listWorkPackages("org1");
    expect(pkgs).toHaveLength(50);
    expect(pkgs.every((p) => p.docs.length === 25 && !p.membersUnread && p.unknownCount === 0)).toBe(true);
    // the newest member of the last package is there
    expect(pkgs.find((p) => p.id === "p49")!.docs.map((d) => d.documentId)).toContain("d1249");
    // two windows, the second starting where the first's rows ended
    expect(state.rangeCalls.filter((c) => c.table === "work_package_documents")).toEqual([
      { table: "work_package_documents", from: 0, to: 999 },
      { table: "work_package_documents", from: 1000, to: 1999 },
    ]);
  });

  it("a member page that FAILS mid-read marks that chunk's packages unread — never a 'Fresh' package missing the members the failed page held", async () => {
    state.maxRows = 1000;
    state.pageErrorAt.work_package_documents = 1;
    state.tables.work_packages = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, org_id: "org1", name: `P${i}`, status: "open", owner_user_id: "owner", created_at: "2026-09-01" }));
    state.tables.work_package_documents = Array.from({ length: 1250 }, (_, i) => ({ id: `m${i}`, package_id: `p${i % 50}`, document_id: `d${i}`, pinned_version_id: `v-d${i}`, pinned_rev_label: "1" }));
    state.tables.documents = Array.from({ length: 1250 }, (_, i) => docRow(`d${i}`));
    const pkgs = await listWorkPackages("org1");
    expect(pkgs.every((p) => p.membersUnread)).toBe(true);
  });

  it("readPackageMemberIds reads ONE package's members fresh by package id, paged and in order; a failed page throws (nothing printed)", async () => {
    state.maxRows = 1000;
    state.tables.work_package_documents = Array.from({ length: 1100 }, (_, i) => ({ id: `m${i}`, package_id: "p1", document_id: `d${i}` }))
      .concat([{ id: "x", package_id: "p2", document_id: "other" }]);
    const ids = await readPackageMemberIds("p1");
    expect(ids).toHaveLength(1100);
    expect(ids[1099]).toBe("d1099");
    expect(ids).not.toContain("other");
    state.rangeCalls = [];
    state.pageErrorAt.work_package_documents = 1;
    await expect(readPackageMemberIds("p1")).rejects.toThrow(/Couldn't read the package's sheets \(page read failed\) — nothing was printed\./);
    expect(src("lib/workPackages.ts")).toMatch(/export async function readPackageMemberIds[\s\S]{0,400}?\.eq\("package_id", packageId\)\s*\n\s*\.order\("added_at", \{ ascending: true \}\)\s*\n\s*\.order\("id", \{ ascending: true \}\)\s*\n\s*\.range\(from, to\)\);/);
  });

  it("refreshWorkPackage NEVER writes a pin for a document the reader cannot open — the others move, then the refresh fails naming them", async () => {
    state.tables.work_package_documents = [
      { id: "m1", package_id: "p1", org_id: "org1", document_id: "a", pinned_version_id: "v-a", pinned_rev_label: "1" },
      { id: "m2", package_id: "p1", org_id: "org1", document_id: "hidden", pinned_version_id: "v-old", pinned_rev_label: "4" },
    ];
    state.tables.documents = [docRow("a")];
    await expect(refreshWorkPackage("p1", { actor: { userId: "u1" } })).rejects.toThrow(/1 of 2 pins were NOT moved: you cannot open that document/);
    const pinWrites = state.updates.filter((u) => u.table === "work_package_documents");
    expect(pinWrites.map((u) => u.filters.id)).toEqual(["m1"]);
    expect(pinWrites.every((u) => u.patch.pinned_version_id !== null)).toBe(true);
  });

  it("createWorkPackage refuses (nothing created) when a chosen document cannot be read", async () => {
    state.tables.documents = [docRow("a")];
    await expect(createWorkPackage({
      orgId: "org1", name: "Job", documentIds: ["a", "hidden"], actorUserId: "u1", actorName: "u1",
    })).rejects.toThrow(/1 of the 2 chosen documents could not be read with your access, so the package was not created/);
    expect(state.inserts).toEqual([]);
  });

  it("refresh and create chunk their documents read (150 ids per read) — a ~400-sheet package is not one 400-id GET (fix pass 2)", async () => {
    const ids = Array.from({ length: 400 }, (_, i) => `d${i}`);
    state.tables.documents = ids.map((id) => docRow(id));
    state.tables.work_package_documents = ids.map((id, i) => ({ id: `m${i}`, package_id: "p1", org_id: "org1", document_id: id, pinned_version_id: `v-${id}`, pinned_rev_label: "1" }));
    await refreshWorkPackage("p1", { actor: { userId: "u1" } });
    expect(state.inCalls.filter((c) => c.table === "documents").map((c) => c.n)).toEqual([150, 150, 100]);
    state.inCalls = [];
    await createWorkPackage({ orgId: "org1", name: "Big job", documentIds: ids, actorUserId: "u1", actorName: "u1" });
    expect(state.inCalls.filter((c) => c.table === "documents").map((c) => c.n)).toEqual([150, 150, 100]);
    const members = state.inserts.find((i) => i.table === "work_package_documents")!.row as Row[];
    expect(members).toHaveLength(400);
    // one chunk that fails still refuses the whole create — nothing half-read is pinned
    state.inserts = [];
    state.readErrors.documents = { message: "URI too long" };
    await expect(createWorkPackage({ orgId: "org1", name: "Big job", documentIds: ids, actorUserId: "u1", actorName: "u1" }))
      .rejects.toThrow(/Couldn't read the chosen documents \(URI too long\) — the package was not created/);
    expect(state.inserts).toEqual([]);
  });

  it("the pack's gate reads (documents, holds) are chunked too — a large asset tag's print is not one oversized GET", async () => {
    const ids = Array.from({ length: 400 }, (_, i) => `d${i}`);
    state.tables.documents = ids.map((id) => docRow(id));
    state.tables.document_holds = [{ document_id: "d399", released_at: null }];
    const a = await assessPackDocs(ids, { userId: "u1" });
    expect(state.inCalls.filter((c) => c.table === "documents").map((c) => c.n)).toEqual([150, 150, 100]);
    expect(state.inCalls.filter((c) => c.table === "document_holds").map((c) => c.n)).toEqual([150, 150, 100]);
    // the hold on the LAST chunk is still seen (never lost to a chunk boundary)
    expect(a.packable).toHaveLength(399);
    expect(a.skipped).toEqual([expect.objectContaining({ documentId: "d399", code: "on_hold" })]);
    // a hold read that fails fails CLOSED for every sheet
    state.readErrors.document_holds = { message: "timeout" };
    const b = await assessPackDocs(ids.slice(0, 3), { userId: "u1" });
    expect(b.packable).toEqual([]);
    expect(b.skipped.map((x) => x.code)).toEqual(["hold_unknown", "hold_unknown", "hold_unknown"]);
    expect(src("lib/docPack.ts")).not.toMatch(/\.in\("id", documentIds\)|\.in\("document_id", documentIds\)|\.in\("id", versionIds\)/);
  });
});

// ─── PKG-9 ──────────────────────────────────────────────────────────────────

describe("PKG-9 — the hard read-&-understood gate binds every pack button", () => {
  beforeEach(() => {
    state.tables.libraries = [{ id: "libGated", ack_policy: { enabled: true, hardGate: true } }];
    state.tables.documents = [docRow("a"), docRow("g", { library_id: "libGated" })];
    state.tables.document_versions = [versionFor("a"), versionFor("g")];
    state.tables.document_acknowledgments = [{ id: "ack1", document_id: "g", assignee_user_id: "u1", status: "pending" }];
  });

  it("a hard-gated sheet with the printer's sign-off outstanding is left out with the reason — never merged, never stamped", async () => {
    const result = await buildAndDownloadDocPack(packInput(["a", "g"]) as never);
    expect(result.included).toBe(1);
    expect(result.skipped).toEqual([expect.objectContaining({ documentId: "g", code: "ack_required", reason: expect.stringMatching(/read-&-understood sign-off outstanding/) })]);
    expect(state.stamps).toHaveLength(1);
  });

  it("assessPackDocs applies it BEFORE any side-effect when given the printer", async () => {
    const a = await assessPackDocs(["a", "g"], { userId: "u1" });
    expect(a.packable.map((p) => p.id)).toEqual(["a"]);
    expect(a.skipped.map((s) => s.code)).toEqual(["ack_required"]);
    // once signed, the sheet packs
    state.tables.document_acknowledgments = [];
    expect((await assessPackDocs(["a", "g"], { userId: "u1" })).packable.map((p) => p.id)).toEqual(["a", "g"]);
  });

  it("ONE helper: the single download (assertAckGate), the pack and the book all go through ackGateDocuments", async () => {
    const downloads = src("lib/downloads.ts");
    expect(downloads).toMatch(/async function assertAckGate[\s\S]{0,200}?ackGatedDocumentIds\(\[ctx\.doc\], ctx\.userId\)/);
    // the single download's wrapper is the same gate, its `gated` half alone (fail open)
    expect(downloads).toMatch(/export async function ackGatedDocumentIds\(docs: AckGateDoc\[\], userId: string\): Promise<Set<string>> \{\s*\n\s*return \(await ackGateDocuments\(docs, userId\)\)\.gated;/);
    expect(src("lib/docPack.ts")).toContain('import { ackGateDocuments } from "@/lib/downloads";');
    expect(src("components/viewers/MultiDocViewer.tsx")).toMatch(/const gate = await ackGateDocuments\(scope\.map\(\(e\) => e\.doc\), currentUserId\);/);
    // and the single download still refuses through it
    const doc = { id: "g", orgId: "org1", libraryId: "libGated", documentNumber: "G-1" } as DocumentRecord;
    await expect(downloadDocumentPdf({ doc, fileUrl: "https://files/g.pdf", userId: "u1" })).rejects.toBeInstanceOf(AcknowledgmentRequiredError);
    expect(state.stampedDownloads).toHaveLength(0);
  });

  it("reads the printer's PENDING acknowledgments first (chunked), and resolves a policy only for a sheet with one — none pending, no policy round trip at all", async () => {
    const policyReads = () => state.selects.filter((c) => c.table === "collections" || c.table === "libraries");
    const many = Array.from({ length: 200 }, (_, i) => ({ id: `x${i}`, libraryId: `lib${i % 40}`, collectionId: `col${i}` }));
    state.tables.document_acknowledgments = [];
    expect((await ackGatedDocumentIds(many, "u1")).size).toBe(0);
    expect(policyReads()).toEqual([]);
    expect(state.inCalls.filter((c) => c.table === "document_acknowledgments").map((c) => c.n)).toEqual([150, 50]);
    // one pending → one policy resolved, for that sheet only: its folder, then its library
    state.inCalls = [];
    state.selects = [];
    state.tables.document_acknowledgments = [{ id: "k", document_id: "x7", assignee_user_id: "u1", status: "pending" }];
    state.tables.libraries = [{ id: "lib7", ack_policy: { enabled: true, hardGate: true } }];
    expect([...await ackGatedDocumentIds(many, "u1")]).toEqual(["x7"]);
    expect(policyReads()).toEqual([
      { table: "collections", filters: { id: "col7" } },
      { table: "libraries", filters: { id: "lib7" } },
    ]);
  });

  it("the gate reads the folder and library policies ITSELF, checked — never through effectiveAckPolicyForDocument, which swallows a read error as 'no policy' (fix pass 5)", async () => {
    const downloads = src("lib/downloads.ts");
    expect(downloads).not.toMatch(/await effectiveAckPolicyForDocument\(/);
    expect(downloads).toMatch(/const \{ data, error \} = await supabase\.from\("collections"\)\.select\("ack_policy"\)\.eq\("id", d\.collectionId\)\.maybeSingle\(\);\s*\n\s*if \(error\) return \{ ok: false \};/);
    expect(downloads).toMatch(/const \{ data: lib, error: libError \} = await supabase\.from\("libraries"\)\.select\("ack_policy"\)\.eq\("id", d\.libraryId\)\.maybeSingle\(\);\s*\n\s*if \(libError\) return \{ ok: false \};/);
    // an errored resolution is never memoized
    expect(downloads).toMatch(/if \(!read\.ok\) \{ unknown\.add\(d\.id\); continue; \}[^\n]*\n\s*policy = read\.policy;\s*\n\s*ackPolicyMemo\.set\(/);
    const { effectiveAckPolicyForDocument } = await import("@/lib/acknowledgments");
    vi.mocked(effectiveAckPolicyForDocument).mockClear();
    await ackGateDocuments([{ id: "g", libraryId: "libGated", collectionId: "colAny" }], "u1");
    expect(effectiveAckPolicyForDocument).not.toHaveBeenCalled();
  });

  it("the single download still fails OPEN on a LIBRARY policy read that returns { error } (unchanged rule) — the gate reports it UNKNOWN, never gated, and never memoizes it", async () => {
    state.readErrors.libraries = { message: "upstream request timeout" };
    const gated = await ackGatedDocumentIds([{ id: "g", libraryId: "libBroken" }], "u1");
    expect(gated.size).toBe(0);
    const gate = await ackGateDocuments([{ id: "g", libraryId: "libBroken" }], "u1");
    expect([...gate.gated]).toEqual([]);
    expect([...gate.unknown]).toEqual(["g"]);
    // the failed read was not remembered as "no policy": once the library reads,
    // its hard gate holds on the very next print (no 60-second fail-open window)
    delete state.readErrors.libraries;
    state.tables.libraries.push({ id: "libBroken", ack_policy: { enabled: true, hardGate: true } });
    const again = await ackGateDocuments([{ id: "g", libraryId: "libBroken" }], "u1");
    expect([...again.gated]).toEqual(["g"]);
    expect(again.unknown.size).toBe(0);
  });

  it("a FOLDER policy read that returns { error } leaves the sheet unknown even when its library is hard-gated (the folder might say otherwise); a document's own policy needs no read at all", async () => {
    state.readErrors.collections = { message: "permission denied for table collections", code: "42501" };
    const gate = await ackGateDocuments([{ id: "g", libraryId: "libGated", collectionId: "colBroken" }], "u1");
    expect([...gate.unknown]).toEqual(["g"]);
    expect(gate.gated.size).toBe(0);
    expect(state.selects.filter((c) => c.table === "libraries")).toEqual([]); // the library is never asked once the folder is undecided
    // the document's own hard gate decides it without a folder or library read — both broken here
    state.readErrors.libraries = { message: "upstream request timeout" };
    state.selects = [];
    const own = await ackGateDocuments([{ id: "g", libraryId: "libBroken2", collectionId: "colBroken", ackPolicy: { enabled: true, hardGate: true } }], "u1");
    expect([...own.gated]).toEqual(["g"]);
    expect(own.unknown.size).toBe(0);
    expect(state.selects.filter((c) => c.table === "collections" || c.table === "libraries")).toEqual([]);
    // and a folder policy that is defined decides it without the library read
    delete state.readErrors.collections;
    state.tables.collections = [{ id: "colOff", ack_policy: { enabled: false } }];
    const folderOff = await ackGateDocuments([{ id: "g", libraryId: "libGated", collectionId: "colOff" }], "u1");
    expect(folderOff.gated.size).toBe(0);
    expect(folderOff.unknown.size).toBe(0);
  });

  it("the PACK fails CLOSED (fix pass 4): a pending-acknowledgment read that errors leaves the sheet out as ack_unknown — never merged — while the desk download stays open", async () => {
    state.readErrors.document_acknowledgments = { message: "PostgREST hiccup" };
    const gate = await ackGateDocuments([{ id: "a", libraryId: "lib1" }, { id: "g", libraryId: "libGated" }], "u1");
    expect([...gate.unknown].sort()).toEqual(["a", "g"]);
    expect(gate.gated.size).toBe(0);
    // the pack: both sheets undecided → both left out, named, nothing stamped
    const a = await assessPackDocs(["a", "g"], { userId: "u1" });
    expect(a.packable).toEqual([]);
    expect(a.skipped).toEqual([
      expect.objectContaining({ documentId: "a", code: "ack_unknown", reason: "read-&-understood sign-off status could not be checked just now — try the print again" }),
      expect.objectContaining({ documentId: "g", code: "ack_unknown" }),
    ]);
    await expect(buildAndDownloadDocPack(packInput(["a", "g"]) as never)).rejects.toThrow(/No documents could be packed \(A: read-&-understood sign-off status could not be checked/);
    expect(state.stamps).toHaveLength(0);
    // the single desk download keeps its posture: an undecided gate does not block it
    expect((await ackGatedDocumentIds([{ id: "g", libraryId: "libGated" }], "u1")).size).toBe(0);
    // the print record and the scan say why (lib/packLeftOut.ts)
    expect(packLeftOutText("ack_unknown")).toBe("its acknowledgment status could not be checked when printed");
  });

  it("PKG-9's own scenario (fix pass 5): a LIBRARY-level hard gate whose library read returns { error } — the pack leaves the pending sheet out as ack_unknown, twice in a row; the book's gate reports it unknown", async () => {
    // a library no earlier test resolved (the policy memo holds a resolved policy for a minute)
    state.tables.documents.push(docRow("p", { library_id: "libFlaky" }));
    state.tables.document_versions.push(versionFor("p"));
    state.tables.document_acknowledgments = [{ id: "ack2", document_id: "p", assignee_user_id: "u1", status: "pending" }];
    state.tables.libraries.push({ id: "libFlaky", ack_policy: { enabled: true, hardGate: true } });
    state.readErrors.libraries = { message: "upstream request timeout" };
    for (let attempt = 0; attempt < 2; attempt++) {
      state.stamps = [];
      const result = await buildAndDownloadDocPack(packInput(["a", "p"]) as never);
      expect(result.included).toBe(1);
      expect(result.skipped).toEqual([expect.objectContaining({ documentId: "p", code: "ack_unknown" })]);
      expect(state.stamps).toHaveLength(1); // "a" only — P-101 is never stamped into the pack
    }
    // the book viewer reads the same gate and refuses on `unknown` (pinned below)
    const book = await ackGateDocuments([{ id: "a", libraryId: "lib1" }, { id: "p", libraryId: "libFlaky" }], "u1");
    expect([...book.unknown]).toEqual(["p"]);
    expect(book.gated.size).toBe(0);
    // a FOLDER read that errors does the same in the pack
    delete state.readErrors.libraries;
    state.tables.documents.push(docRow("q", { library_id: "libGated", collection_id: "colFlaky" }));
    state.tables.document_versions.push(versionFor("q"));
    state.tables.document_acknowledgments.push({ id: "ack3", document_id: "q", assignee_user_id: "u1", status: "pending" });
    state.readErrors.collections = { message: "upstream request timeout" };
    const assessed = await assessPackDocs(["a", "q"], { userId: "u1" });
    expect(assessed.packable.map((x) => x.id)).toEqual(["a"]);
    expect(assessed.skipped).toEqual([expect.objectContaining({ documentId: "q", code: "ack_unknown" })]);
  });

  it("the book viewer refuses a book holding a sheet whose sign-off status could not be checked, naming it (fail closed)", () => {
    const v = src("components/viewers/MultiDocViewer.tsx");
    expect(v).toMatch(/if \(gate\.unknown\.size > 0\) \{\s*\n\s*const names = namesOf\(gate\.unknown\);\s*\n\s*throw new Error\(\s*\n\s*`The read-&-understood sign-off status of \$\{names\.join\(", "\)\} could not be checked just now — nothing was downloaded\. `/);
  });
});

// ─── PKG-12 ─────────────────────────────────────────────────────────────────

describe("PKG-12 — the budget is OFF until the deployment switches it on (DEC-70 §2 awaits ratification — fix pass 4)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("fieldPackBudgetEnforced: unset (the shipped default) or anything but on / true / 1 is OFF", () => {
    vi.stubEnv("NEXT_PUBLIC_FIELD_PACK_BUDGET", "");
    expect(fieldPackBudgetEnforced()).toBe(false);
    for (const off of ["off", "0", "false", "yes please"]) {
      vi.stubEnv("NEXT_PUBLIC_FIELD_PACK_BUDGET", off);
      expect(fieldPackBudgetEnforced()).toBe(false);
    }
    for (const on of ["on", "ON", " true ", "1"]) {
      vi.stubEnv("NEXT_PUBLIC_FIELD_PACK_BUDGET", on);
      expect(fieldPackBudgetEnforced()).toBe(true);
    }
    // the literal reference Next inlines into the browser bundle
    expect(src("lib/docPack.ts")).toContain('const raw = (process.env.NEXT_PUBLIC_FIELD_PACK_BUDGET ?? "").trim().toLowerCase();');
  });

  it("the switch reaches a self-hosted Docker build (fix pass 5): a build arg in the Dockerfile and compose, documented, shipped off", () => {
    // .env is excluded from the image, so a build arg is the only route into the bundle
    const dockerfile = src("Dockerfile");
    const build = dockerfile.slice(0, dockerfile.indexOf("RUN npm run build"));
    expect(build).toMatch(/\nARG NEXT_PUBLIC_FIELD_PACK_BUDGET\n/);
    expect(build).toContain("    NEXT_PUBLIC_FIELD_PACK_BUDGET=${NEXT_PUBLIC_FIELD_PACK_BUDGET} \\\n");
    const compose = src("docker-compose.yml");
    const args = compose.slice(compose.indexOf("      args:"), compose.indexOf("    image:"));
    expect(args).toContain("        NEXT_PUBLIC_FIELD_PACK_BUDGET: ${NEXT_PUBLIC_FIELD_PACK_BUDGET:-}");
    // shipped OFF: the example leaves it commented out, and the docs say when to set it
    const env = src(".env.example");
    expect(env).toContain("\n# NEXT_PUBLIC_FIELD_PACK_BUDGET=on\n");
    expect(env).not.toMatch(/\nNEXT_PUBLIC_FIELD_PACK_BUDGET=/);
    const doc = src("docs/SELF_HOST_DOCKER.md");
    expect(doc).toMatch(/\| `NEXT_PUBLIC_FIELD_PACK_BUDGET` \| build \(optional\) — `on` switches on the field-pack budget[^\n]*Leave it unset \(off\) until Document Control has ratified the budget[^\n]*--build-arg NEXT_PUBLIC_FIELD_PACK_BUDGET=on/);
  });

  it("OFF: a 200-sheet work package prints as ONE pack, as it did before P8 — no refusal, no split", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIELD_PACK_BUDGET", "");
    const ids = Array.from({ length: 200 }, (_, i) => `d${i}`);
    state.tables.documents = ids.map((id) => docRow(id));
    state.tables.document_versions = ids.map((id) => versionFor(id, 1));
    const r = await buildAndDownloadDocPack(packInput(ids) as never);
    expect(r.included).toBe(200);
    expect(r.skipped).toEqual([]);
    expect(state.events).toContain("download");
  });

  it("OFF: a file recorded (and declared) over 150 MB, and a pack over 1000 pages, are fetched and merged as before — nothing refused or left out for its size", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIELD_PACK_BUDGET", "");
    state.tables.documents = [docRow("a"), docRow("big")];
    state.tables.document_versions = [versionFor("a", 900), { ...versionFor("big", 300), size: 600 * 1024 * 1024 }];
    state.declaredLengthByUrl["https://files/big.pdf"] = 600 * 1024 * 1024;
    const r = await buildAndDownloadDocPack(packInput(["a", "big"], { buildCoverAfter: async () => null }) as never);
    expect(r.included).toBe(2);
    expect(r.skipped).toEqual([]);
    expect(state.bodyReads).toEqual(["https://files/a.pdf", "https://files/big.pdf"]);
    expect(state.events).not.toContain("cancel:https://files/big.pdf");
  });
});

describe("PKG-12 — (budget ON) a pack has a budget, keeps its order, and the cover gives each entry its pages", () => {
  beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_FIELD_PACK_BUDGET", "on"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("over the sheet budget: refused before a single fetch, nothing recorded, with a split", async () => {
    const ids = Array.from({ length: PACK_MAX_SHEETS + 30 }, (_, i) => `d${i}`);
    state.tables.documents = ids.map((id) => docRow(id));
    const cover = vi.fn();
    const err = await buildAndDownloadDocPack(packInput(ids, { buildCoverAfter: cover }) as never).catch((e) => e);
    expect(err).toBeInstanceOf(PackTooLargeError);
    expect(err.parts).toBe(2);
    expect(String(err.message)).toMatch(new RegExp(`has ${PACK_MAX_SHEETS + 30} sheets — a field pack holds at most ${PACK_MAX_SHEETS}.*Split it into 2 packs`));
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(cover).not.toHaveBeenCalled();
    expect(state.inserts).toEqual([]);
    expect(packSheetBudgetRefusal(PACK_MAX_SHEETS)).toBeNull();
    expect(splitPackIds(ids).map((c) => c.length)).toEqual([PACK_MAX_SHEETS, 30]);
    expect(packPartsFor(301, 150)).toBe(3);
  });

  it("over the page budget mid-assembly: the whole pack is refused — no cover, no snapshot, no download, no record, no pins", async () => {
    state.tables.documents = [docRow("a"), docRow("b"), docRow("c")];
    state.tables.document_versions = [versionFor("a", 600), versionFor("b", 600), versionFor("c", 10)];
    const cover = vi.fn();
    const after = vi.fn();
    const err = await buildAndDownloadDocPack(packInput(["a", "b", "c"], { buildCoverAfter: cover, afterDownload: after }) as never).catch((e) => e);
    expect(err).toBeInstanceOf(PackTooLargeError);
    expect(String(err.message)).toMatch(new RegExp(`${PACK_MAX_PAGES}-page budget \\(1200 pages\\) at B \\(sheet 2 of 3\\)`));
    expect(cover).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expect(state.events).not.toContain("download");
    expect(state.inserts).toEqual([]);
  });

  it("a sheet over the PAGE budget on its own REFUSES a work package's pack, naming it — no cover, no snapshot, no download, no record (fix pass 4: left out, it read red at the cover scan for as long as it is current)", async () => {
    state.tables.documents = [docRow("a"), docRow("b"), docRow("c")];
    state.tables.document_versions = [versionFor("a", 3), versionFor("b", PACK_MAX_PAGES + 1), versionFor("c", 2)];
    const cover = vi.fn();
    const after = vi.fn();
    // a caller with a print snapshot cannot opt into leaving it out
    const err = await buildAndDownloadDocPack(packInput(["a", "b", "c"], { buildCoverAfter: cover, afterDownload: after, sheetTooLarge: "leave_out" }) as never).catch((e) => e);
    expect(err).toBeInstanceOf(PackSheetTooLargeError);
    expect(err.code).toBe("pack_sheet_too_large");
    expect(err.documentId).toBe("b");
    expect(String(err.message)).toBe(
      `B is ${PACK_MAX_PAGES + 1} pages on its own — over a field pack's ${PACK_MAX_PAGES}-page budget, so no field pack can carry it — ` +
      "this pack was not built and nothing was printed. Download B on its own (from its document page), take it out of this pack, and print the rest.",
    );
    expect(cover).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expect(state.events).not.toContain("download");
    expect(state.inserts).toEqual([]);
  });

  it("a pack with NO print snapshot (the asset hub, sheetTooLarge: 'leave_out') leaves that sheet out, named, and builds the rest", async () => {
    state.tables.documents = [docRow("a"), docRow("b"), docRow("c")];
    state.tables.document_versions = [versionFor("a", 3), versionFor("b", PACK_MAX_PAGES + 1), versionFor("c", 2)];
    const r = await buildAndDownloadDocPack(packInput(["a", "b", "c"], { sheetTooLarge: "leave_out" }) as never);
    expect(r.included).toBe(2);
    expect(r.skipped).toEqual([expect.objectContaining({
      documentId: "b", code: "too_large", versionId: "v-b",
      reason: `${PACK_MAX_PAGES + 1} pages on its own — over a field pack's ${PACK_MAX_PAGES}-page budget, so it was left out; download it on its own`,
    })]);
    expect(state.events).toContain("download");
    // the public words never claim a copy rides along (fix pass 4)
    expect(packLeftOutText("too_large")).toBe("too large for a field pack when printed — get it separately");
    expect(src("app/(protected)/assets/[tag]/page.tsx")).toContain('sheetTooLarge: "leave_out",');
    expect(src("lib/docPack.ts")).toContain('const leaveOutTooLarge = input.sheetTooLarge === "leave_out" && !input.buildCoverAfter;');
  });

  it("a file over the BYTE budget on its own is caught BEFORE pdf-lib parses it (parsing it is what would exhaust the tablet) — refused, or left out by the hub", async () => {
    state.tables.documents = [docRow("a"), docRow("big")];
    state.tables.document_versions = [versionFor("a", 2), versionFor("big", 4)];
    state.byteLengthByUrl["https://files/big.pdf"] = 180 * 1024 * 1024;
    const err = await buildAndDownloadDocPack(packInput(["a", "big"]) as never).catch((e) => e);
    expect(err).toBeInstanceOf(PackSheetTooLargeError);
    expect(String(err.message)).toMatch(/^BIG is 180 MB on its own — over a field pack's 150 MB budget, so no field pack can carry it/);
    expect(state.loads).toBe(1); // only "a" was ever parsed
    expect(state.events).not.toContain("download");
    state.loads = 0;
    const r = await buildAndDownloadDocPack(packInput(["a", "big"], { sheetTooLarge: "leave_out" }) as never);
    expect(r.included).toBe(1);
    expect(r.skipped).toEqual([expect.objectContaining({
      documentId: "big", code: "too_large",
      reason: "180 MB on its own — over a field pack's 150 MB budget, so it was left out; download it on its own",
    })]);
    expect(state.loads).toBe(1);
    expect(packSheetOverBudget({ bytes: PACK_MAX_BYTES })).toBeNull();
    expect(packSheetOverBudget({ pages: PACK_MAX_PAGES })).toBeNull();
  });

  it("a file whose RECORDED size (document_versions.size) is over the byte budget refuses the pack before a single fetch; the hub leaves it out unfetched (fix pass 3)", async () => {
    state.tables.documents = [docRow("a"), docRow("big")];
    state.tables.document_versions = [versionFor("a", 2), { ...versionFor("big", 4), size: 600 * 1024 * 1024 }];
    const err = await buildAndDownloadDocPack(packInput(["a", "big"]) as never).catch((e) => e);
    expect(err).toBeInstanceOf(PackSheetTooLargeError);
    expect(err.documentId).toBe("big");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    const r = await buildAndDownloadDocPack(packInput(["a", "big"], { sheetTooLarge: "leave_out" }) as never);
    expect(r.included).toBe(1);
    expect(r.skipped).toEqual([expect.objectContaining({
      documentId: "big", code: "too_large", versionId: "v-big",
      reason: "600 MB on its own — over a field pack's 150 MB budget, so it was left out; download it on its own",
    })]);
    expect(vi.mocked(fetch).mock.calls.map((c) => String(c[0]))).toEqual(["https://files/a.pdf"]);
    expect(state.bodyReads).toEqual(["https://files/a.pdf"]);
  });

  it("a file with no recorded size whose response DECLARES over the byte budget (Content-Length) is caught before its body is read", async () => {
    state.tables.documents = [docRow("a"), docRow("big")];
    state.tables.document_versions = [versionFor("a", 2), versionFor("big", 4)];
    state.declaredLengthByUrl["https://files/big.pdf"] = 600 * 1024 * 1024;
    const err = await buildAndDownloadDocPack(packInput(["a", "big"]) as never).catch((e) => e);
    expect(err).toBeInstanceOf(PackSheetTooLargeError);
    expect(state.events).toContain("cancel:https://files/big.pdf"); // the body is released
    state.events = [];
    const r = await buildAndDownloadDocPack(packInput(["a", "big"], { sheetTooLarge: "leave_out" }) as never);
    expect(r.skipped).toEqual([expect.objectContaining({ documentId: "big", code: "too_large" })]);
    expect(state.bodyReads).toEqual(["https://files/a.pdf", "https://files/a.pdf"]); // big never read whole
    expect(state.events).toContain("cancel:https://files/big.pdf");
    expect(state.loads).toBe(2); // "a", once per build
    // a database without document_versions.size (42703) still builds from the path alone
    expect(src("lib/docPack.ts")).toMatch(/if \(versionErr && isUndefinedColumnError\(versionErr\)\) \{\s*\n\s*const retry = await supabase\.from\("document_versions"\)\.select\("id, file_url"\)/);
  });

  it("ONE large early sheet no longer collapses the split to one sheet per pack: the running-total refusal's parts are filled from the sizes (fix pass 3)", async () => {
    // a: 600 pages, b: 600 pages — the overflow is at b with ONE sheet merged; c..f are small
    const ids = ["a", "b", "c", "d", "e", "f"];
    state.tables.documents = ids.map((id) => docRow(id));
    state.tables.document_versions = [
      { ...versionFor("a", 600), size: 600 }, { ...versionFor("b", 600), size: 600 },
      ...["c", "d", "e", "f"].map((id) => ({ ...versionFor(id, 10), size: 10 })),
    ];
    const err = await buildAndDownloadDocPack(packInput(ids) as never).catch((e) => e);
    expect(err).toBeInstanceOf(PackTooLargeError);
    // before: perPack 1 → 6 one-sheet packs; now: [a] then [b, c, d, e, f]
    expect(err.split).toEqual([["a"], ["b", "c", "d", "e", "f"]]);
    expect(err.parts).toBe(2);
    expect(err.perPack).toBe(5);
    // fix pass 4: a size-filled split is never described as "of at most M sheets"
    expect(String(err.message)).toMatch(/Split it into 2 packs — filled by the sheets' sizes, so the parts hold different numbers of sheets — and print them separately\.$/);
    expect(String(err.message)).not.toMatch(/of at most/);
    // …and /packages names its parts by sheet, in order
    expect(describePackSplit(err.split, (id) => id.toUpperCase())).toBe("part 1: A on its own; part 2: B … F (5 sheets)");
    expect(state.events).not.toContain("download");
  });

  it("the sheet-count refusal fills its parts from the RECORDED sizes: 300 sheets, the first 140 MB and the second 20 MB, split into 3 packs, not 300 (fix pass 3)", async () => {
    const MBy = 1024 * 1024;
    const ids = Array.from({ length: 300 }, (_, i) => `s${i}`);
    state.tables.documents = ids.map((id) => docRow(id));
    state.tables.document_versions = ids.map((id, i) => ({ ...versionFor(id, 1), size: i === 0 ? 140 * MBy : i === 1 ? 20 * MBy : 100 * 1024 }));
    const err = await buildAndDownloadDocPack(packInput(ids) as never).catch((e) => e);
    expect(err).toBeInstanceOf(PackTooLargeError);
    expect((err.split as string[][]).map((p) => p.length)).toEqual([1, 150, 149]);
    expect(err.parts).toBe(3);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    // the gate's refusals ride weightless with their part, so each part's print names its own
    expect(packSplitPlan([
      { id: "x", bytes: null, pages: null, weightless: true },
      { id: "a", bytes: 100 * MBy, pages: null },
      { id: "held", bytes: null, pages: null, weightless: true },
      { id: "b", bytes: 100 * MBy, pages: null },
      { id: "c", bytes: null, pages: null }, // unknown: the mean of the known (100 MB)
    ])).toEqual([["x", "a", "held"], ["b"], ["c"]]);
    // an unknown page count follows the measured pages-per-byte (1 here):
    // m 400 + n ~500 = 900 pages fit; o's ~200 more would pass 1000
    expect(packSplitPlan([
      { id: "m", bytes: 400, pages: 400 },
      { id: "n", bytes: 500, pages: null },
      { id: "o", bytes: 200, pages: null },
    ])).toEqual([["m", "n"], ["o"]]);
  });

  it("the RUNNING total is the only refusal, and its split always helps: packs of at most the sheets that fitted (one, when the first sheet alone nearly fills a pack)", async () => {
    state.tables.documents = [docRow("a"), docRow("b")];
    state.tables.document_versions = [versionFor("a", 900), versionFor("b", 200)];
    const err = await buildAndDownloadDocPack(packInput(["a", "b"]) as never).catch((e) => e);
    expect(err).toBeInstanceOf(PackTooLargeError);
    expect(err.perPack).toBe(1);
    expect(err.parts).toBe(2);
    expect(String(err.message)).toMatch(/at B \(sheet 2 of 2\).*Split it into 2 packs — filled by the sheets' sizes/);
    expect(state.events).not.toContain("download");
    expect(packContentBudgetRefusal({ label: "X", merged: 4, total: 9, pages: PACK_MAX_PAGES, bytes: PACK_MAX_BYTES })).toBeNull();
    // with no split, the uniform count still reads "of at most M sheet(s)"
    expect(String(packContentBudgetRefusal({ label: "X", merged: 1, total: 3, pages: PACK_MAX_PAGES + 1, bytes: 0 })!.message))
      .toMatch(/Split it into 3 packs of at most 1 sheet each/);
    // the hub takes a split of one sheet a part too (each part then fits)
    expect(src("app/(protected)/assets/[tag]/page.tsx")).toMatch(/if \(e instanceof PackTooLargeError && e\.perPack >= 1\) \{/);
    // /packages states the split in work packages (its remedy): a size-filled split part by part, by sheet label
    // (fix pass 4 — a count alone cannot be followed); a uniform split by its numbers; a sheet too large for any pack by name
    const page = src("app/(protected)/packages/page.tsx");
    expect(page).toContain('if (refusal.code === "pack_too_large") {');
    expect(page).toContain("${describePackSplit(parts, (id) => labelById.get(id) ?? \"Document\")} — create them from this one's drawings, then print each.");
    expect(page).toContain("for (const s of assessment.packable) labelById.set(s.id, s.label);");
    expect(page).toMatch(/: `For a work package that means \$\{refusal\.parts \?\? 2\} work packages of at most `/);
    expect(page).toContain('} else if (refusal.code === "pack_sheet_too_large") {');
    expect(err.code).toBe("pack_too_large");
    // describePackSplit: one sheet named alone, two listed, more as first … last (n)
    expect(describePackSplit([["x"], ["y", "z"], ["p", "q", "r"]], (id) => `S-${id}`))
      .toBe("part 1: S-x on its own; part 2: S-y, S-z; part 3: S-p … S-r (3 sheets)");
  });

  it("the merged order is the CALLER's order, not the database's, and each included sheet carries its page count", async () => {
    state.tables.documents = [docRow("a"), docRow("b"), docRow("c")]; // the read returns a, b, c
    state.tables.document_versions = [versionFor("a", 1), versionFor("b", 3), versionFor("c", 2)];
    let sheets: Array<{ documentId: string; pageCount: number }> = [];
    await buildAndDownloadDocPack(packInput(["c", "a", "b"], {
      buildCoverAfter: async (included: typeof sheets) => { sheets = included; return null; },
    }) as never);
    expect(sheets.map((s) => [s.documentId, s.pageCount])).toEqual([["c", 2], ["a", 1], ["b", 3]]);
    // the cover's page numbers: two cover pages, then the sheets in pack order
    expect(coverEntryLabels([{ label: "C", pageCount: 2 }, { label: "A", pageCount: 1 }, { label: "B", pageCount: 3 }], 2))
      .toEqual(["C · pp. 3–4", "A · p. 5", "B · pp. 6–8"]);
    expect(coverEntryLabels([{ label: "X".repeat(60), pageCount: 1 }], 1)[0]).toMatch(/^X{43}… · p\. 2$/);
  });

  it("the asset hub turns a refused pack into the parts it names — 'Print part 1 of N' (fix pass: splitPackIds is no longer unused)", () => {
    const hub = src("app/(protected)/assets/[tag]/page.tsx");
    expect(hub).toContain('const { buildAndDownloadDocPack, PackTooLargeError, splitPackIds } = await import("@/lib/docPack");');
    // fix pass 3: the builder's size-filled split when it has one, uniform parts otherwise;
    // a refused PART is replaced by its own finer split
    expect(hub).toMatch(/if \(e instanceof PackTooLargeError && e\.perPack >= 1\) \{\s*\n\s*const split = e\.split && e\.split\.length > 1 \? e\.split : splitPackIds\(ids, e\.perPack\);/);
    expect(hub).toContain("? [...prev.slice(0, part.n - 1), ...split, ...prev.slice(part.n)]");
    expect(hub).toContain("onClick={() => void runPack(ids, { n: i + 1, of: packParts.length })}>");
    expect(hub).toContain("Print part {i + 1} of {packParts.length} ({ids.length})");
    // the split the refusal names is the split the page offers
    const ids = Array.from({ length: 320 }, (_, i) => `d${i}`);
    const refusal = packSheetBudgetRefusal(ids.length)!;
    expect(splitPackIds(ids, refusal.perPack).map((p) => p.length)).toEqual([150, 150, 20]);
    expect(refusal.parts).toBe(3);
  });

  it("the work-package member query orders deterministically; the page builds the cover with page numbers", () => {
    expect(src("lib/workPackages.ts")).toMatch(/\.in\("package_id", ids\)\s*\n\s*\.order\("added_at", \{ ascending: true \}\)\s*\n\s*\.order\("id", \{ ascending: true \}\)\s*\n\s*\.range\(from, to\)\);/);
    const page = src("app/(protected)/packages/page.tsx");
    expect(page).toContain("const labels = coverEntryLabels(includedSheets, coverContentsChunks(includedSheets.length).length);");
    expect(page).toContain("label: labels[i],");
  });
});

// ─── VFY-17 (the builder half) ──────────────────────────────────────────────

describe("VFY-17 — the builder refuses an empty-status sheet with the print gate", () => {
  it("a legacy empty-status document never rides into a pack", async () => {
    state.tables.documents = [docRow("a"), docRow("legacy", { status: null })];
    state.tables.document_versions = [versionFor("a"), versionFor("legacy")];
    const r = await buildAndDownloadDocPack(packInput(["a", "legacy"]) as never);
    expect(r.included).toBe(1);
    expect(r.skipped).toEqual([expect.objectContaining({ documentId: "legacy", code: "not_issued", reason: "no status — not an issued, controlled revision" })]);
  });
});

// ─── EGR-6 (the pack) ───────────────────────────────────────────────────────

describe("EGR-6 — the pack's distribution record is written after the download, checked, for the merged sheets only", () => {
  beforeEach(() => {
    state.tables.documents = [docRow("a"), docRow("b")];
    state.tables.document_versions = [versionFor("a"), versionFor("b")];
  });

  it("one insert, after the download, naming only the sheets in the pack", async () => {
    state.failUrls.add("https://files/b.pdf");
    const r = await buildAndDownloadDocPack(packInput(["a", "b"]) as never);
    expect(r.unrecorded).toEqual([]);
    const audits = state.inserts.filter((i) => i.table === "download_audits");
    expect(audits).toHaveLength(1);
    expect((audits[0].row as Row[]).map((x) => x.document_id)).toEqual(["a"]);
    expect(state.events.indexOf("download")).toBeLessThan(state.events.indexOf("insert:download_audits"));
    // the fetch failure is told apart from an unreadable PDF (VFY-19)
    expect(r.skipped).toEqual([expect.objectContaining({ documentId: "b", code: "fetch_failed", versionId: "v-b" })]);
  });

  it("a refused record never blocks the pack, but is reported per sheet (never silent)", async () => {
    state.insertErrors.download_audits = { message: "new row violates row-level security policy" };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await buildAndDownloadDocPack(packInput(["a", "b"]) as never);
    expect(r.included).toBe(2);
    expect(r.unrecorded).toEqual(["A", "B"]);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/REFUSED — this pack is missing from the distribution record/), expect.anything());
    err.mockRestore();
    expect(src("lib/docPack.ts")).not.toMatch(/\.then\(\(\) => \{\}, \(\) => \{\}\)/);
    // both pack buttons say it
    expect(src("app/(protected)/packages/page.tsx")).toContain("const unrecordedNote = result.unrecorded.length > 0");
    expect(src("app/(protected)/assets/[tag]/page.tsx")).toContain("(result.unrecorded.length > 0");
  });

  it("a build that fails records nothing", async () => {
    state.failUrls.add("https://files/a.pdf");
    state.failUrls.add("https://files/b.pdf");
    await expect(buildAndDownloadDocPack(packInput(["a", "b"]) as never)).rejects.toThrow(/No documents could be packed/);
    expect(state.inserts).toEqual([]);
  });

  it("an unparseable file is 'unreadable_pdf' with the revision tried", async () => {
    state.pagesByUrl["https://files/b.pdf"] = 7;
    state.unparseable.add(7);
    const r = await buildAndDownloadDocPack(packInput(["a", "b"]) as never);
    expect(r.skipped).toEqual([expect.objectContaining({ documentId: "b", code: "unreadable_pdf", versionId: "v-b", reason: expect.stringMatching(/^Failed to parse PDF document/) })]);
  });

  it("an encrypted file (the stamper's refusal) is 'unreadable_pdf' too", async () => {
    state.pagesByUrl["https://files/b.pdf"] = 5;
    state.encrypted.add(5);
    const r = await buildAndDownloadDocPack(packInput(["a", "b"]) as never);
    expect(r.skipped).toEqual([expect.objectContaining({ documentId: "b", code: "unreadable_pdf", reason: expect.stringMatching(/encrypted/) })]);
  });

  it("a failure AFTER a clean load (out of memory at copyPages) is 'build_failed' — never 'could not be read as a PDF', so the verify door keeps it red", async () => {
    state.pagesByUrl["https://files/b.pdf"] = 9;
    state.copyFails.add(9);
    const r = await buildAndDownloadDocPack(packInput(["a", "b"]) as never);
    expect(r.included).toBe(1);
    expect(r.skipped).toEqual([expect.objectContaining({ documentId: "b", code: "build_failed", versionId: "v-b", reason: "Array buffer allocation failed" })]);
    expect(packLeftOutText("build_failed")).toBe("its file could not be added to the pack when printed");
  });

  it("OUT OF MEMORY IN pdf-lib's LOAD (a large valid scan — pdf-lib parses the whole file there) is 'build_failed' too, never 'unreadable_pdf' (fix pass 2)", async () => {
    state.pagesByUrl["https://files/b.pdf"] = 11;
    state.loadOom.add(11);
    const r = await buildAndDownloadDocPack(packInput(["a", "b"]) as never);
    expect(r.included).toBe(1);
    expect(r.skipped).toEqual([expect.objectContaining({ documentId: "b", code: "build_failed", versionId: "v-b", reason: "Array buffer allocation failed" })]);
  });

  it("packBuildFailureCode: unreadable_pdf ONLY for pdf-lib's own parse / format refusal at load, or an encrypted file; out of memory at any stage, and anything else, is build_failed", () => {
    const notLoaded = { loaded: false, encrypted: false };
    for (const msg of [
      "Failed to parse PDF document (line:0 col:24 offset=12): No PDF header found",
      "Failed to parse PDF object starting with the following byte: 0",
      "Failed to parse number (line:1 col:2 offset=3): \"x\"",
      "Parser stalled",
      "Expected next byte to be 10 but it was actually 13",
      "Did not find expected keyword 'endobj'",
    ]) expect(packBuildFailureCode(new Error(msg), notLoaded), msg).toBe("unreadable_pdf");
    expect(packBuildFailureCode(new RangeError("Array buffer allocation failed"), notLoaded)).toBe("build_failed");
    expect(packBuildFailureCode(new RangeError("Invalid array length"), notLoaded)).toBe("build_failed");
    expect(packBuildFailureCode(new Error("Out of memory"), notLoaded)).toBe("build_failed");
    expect(packBuildFailureCode(new TypeError("Cannot read properties of undefined (reading 'Pages')"), notLoaded)).toBe("build_failed");
    expect(packBuildFailureCode(new Error("the PDF is encrypted, so it cannot be stamped"), { loaded: true, encrypted: true })).toBe("unreadable_pdf");
    expect(packBuildFailureCode(new RangeError("Array buffer allocation failed"), { loaded: true, encrypted: true })).toBe("build_failed");
    expect(packBuildFailureCode(new Error("copy failed"), { loaded: true, encrypted: false })).toBe("build_failed");
    expect(isOutOfMemoryError("JavaScript heap out of memory")).toBe(true);
    expect(isOutOfMemoryError(new Error("Failed to parse PDF document"))).toBe(false);
  });
});

// ─── HLD-1 / PKG-10 / EGR-6 (lib/downloads.ts) ─────────────────────────────

describe("HLD-1 / PKG-10 / EGR-6 — the single-document copy", () => {
  const holder = { id: "d1", orgId: "org1", libraryId: "lib1", documentNumber: "P-101", rev: "5", checkedOutBy: "u1", currentVersionId: "v5" } as DocumentRecord;

  it("HLD-1: a held document's copy is STAMPED with the hold — even for the checkout holder (never a raw controlled pass-through)", async () => {
    state.tables.document_holds = [{ id: "h1", document_id: "d1", reason: "Client Review", released_at: null }];
    const st = await downloadDocumentPdf({ doc: holder, fileUrl: "https://files/d1.pdf", userId: "u1", userEmail: "u1@example.com" });
    expect(st).toBe("uncontrolled");
    expect(state.stampedDownloads).toHaveLength(1);
    const o = state.stampedDownloads[0].options;
    expect(o.watermarkText).toBe("ON HOLD — DO NOT USE");
    expect(String(o.footerNotice)).toMatch(/^ON HOLD at time of issue \(Client Review\) — work from this document is stopped/);
  });

  it("HLD-1: an UNREADABLE hold state is a hold (fail closed)", async () => {
    state.readErrors.document_holds = { message: "timeout" };
    await printDocumentPdf({ doc: holder, fileUrl: "https://files/d1.pdf", userId: "u1" });
    const o = state.stamps[0];
    expect(o.watermarkText).toBe("UNCONTROLLED — HOLD STATUS UNKNOWN");
    expect(String(o.footerNotice)).toMatch(/^HOLD STATUS UNKNOWN at time of issue/);
  });

  it("an unheld holder still gets the controlled pass-through (unchanged)", async () => {
    state.tables.document_holds = [];
    const st = await downloadDocumentPdf({ doc: holder, fileUrl: "https://files/d1.pdf", userId: "u1" });
    expect(st).toBe("controlled");
    expect(state.stampedDownloads).toHaveLength(0);
  });

  it("PKG-10: a copy with baked markups is never the controlled master; a non-current copy is watermarked SUPERSEDED", async () => {
    const st = await downloadDocumentPdf({ doc: holder, fileUrl: "blob:baked", markedUp: true, userId: "u1" });
    expect(st).toBe("uncontrolled");
    expect(state.stampedDownloads[0].options.watermarkText).toBe("UNCONTROLLED — FOR REVIEW ONLY");
    expect(copyControlState({ doc: holder, userId: "u1", markedUp: true })).toBe("uncontrolled");
    expect(copyControlState({ doc: holder, userId: "u1" })).toBe("controlled");
    expect(copyControlState({ doc: holder, userId: "u1" }, { blocked: true })).toBe("uncontrolled");
    expect(copyWatermark({ versionIsCurrent: false })).toBe("SUPERSEDED — NOT CURRENT");
    await downloadDocumentPdf({ doc: holder, versionId: "v2", versionRev: "2", versionIsCurrent: false, fileUrl: "https://files/old.pdf", userId: "u1" });
    const o = state.stampedDownloads[1];
    expect(o.options.watermarkText).toBe("SUPERSEDED — NOT CURRENT");
    expect(o.filename).toBe("P-101_Rev2_UNCONTROLLED.pdf");
    expect(String(o.options.footerNotice)).toMatch(/^SUPERSEDED REVISION — Rev 2/);
    // the book viewer passes the flag when it bakes markups
    expect(src("components/viewers/MultiDocViewer.tsx")).toMatch(/const ctx = \{ doc: activeEntry\.doc, fileUrl, markedUp,/);
  });

  it("buildFooterNotice leads with the hold line; without a hold it is unchanged", () => {
    const ctx = { doc: holder, fileUrl: "x", userId: "someone" };
    expect(buildFooterNotice(ctx)).toBe("Rev 5 at time of issue — verify current revision before use. ACTIVE CHANGE IN PROGRESS: checked out by another user at time of issue.");
    expect(buildFooterNotice(ctx, { blocked: true, holds: [{ reason: "MOC" }, { reason: "MOC" }] })).toMatch(/^ON HOLD at time of issue \(MOC\) — /);
    expect(holdFooterLine({ blocked: false })).toBeNull();
  });

  it("EGR-6: a refused download_audits write is reported AFTER the copy is delivered (DownloadUnrecordedError), never swallowed", async () => {
    const doc = { ...holder, checkedOutBy: undefined } as DocumentRecord;
    state.insertErrors.download_audits = { message: "permission denied" };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const e = await downloadDocumentPdf({ doc, fileUrl: "https://files/d1.pdf", userId: "u1" }).catch((x) => x);
    err.mockRestore();
    expect(e).toBeInstanceOf(DownloadUnrecordedError);
    expect(String(e.message)).toMatch(/delivered, but it could NOT be recorded on the distribution record \(permission denied\)/);
    expect(state.stampedDownloads).toHaveLength(1); // the copy was still delivered
  });

  it("EGR-6: logDownloadAudit returns its outcome; a row with no organization is never sent", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await logDownloadAudit({ doc: { id: "d1", libraryId: "l" } as DocumentRecord, userId: "u1", state: "uncontrolled" }))
      .toEqual({ recorded: false, error: "the document has no organization or id on record" });
    expect(state.inserts).toEqual([]);
    expect(await logDownloadAudit({ doc: holder, userId: "u1", state: "controlled" })).toEqual({ recorded: true });
    err.mockRestore();
    expect(src("lib/downloads.ts")).not.toMatch(/try \{\s*\n\s*await supabase\.from\("download_audits"\)\.insert/);
  });

  it("the book viewer: rows with no organization are not sent, only merged sheets are recorded, a refused write is said", () => {
    const v = src("components/viewers/MultiDocViewer.tsx");
    expect(v).toContain("const recordable = bound.filter((e) => !!e.doc.orgId && !!e.doc.id);");
    expect(v).toMatch(/const \{ error \} = await supabase\.from\("download_audits"\)\.insert\(rows\);/);
    expect(v).not.toMatch(/try \{ await supabase\.from\("download_audits"\)\.insert\(rows\); \} catch/);
    // integration (2026-10-01): the merged book's download and print close the dialog and alert too
    expect(v.match(/setDownloadConfirm\(null\);\s*\n\s*if \(book\.unrecorded > 0\) void appAlert\(unrecordedBookMessage\(book\.unrecorded\)\);/g)).toHaveLength(2);
    expect(v).not.toMatch(/setActionError\(unrecordedBookMessage/);
    // HLD-1 in the book
    expect(v).toMatch(/const hold = await readCopyHoldState\(entry\.doc\.id\);/);
  });

  it("every caller SAYS a delivered-but-unrecorded copy where the person can see it (fix pass)", () => {
    // MultiDocViewer: the holder's direct action opens no dialog → an alert
    expect(src("components/viewers/MultiDocViewer.tsx")).toContain("if (!downloadConfirm) void appAlert(message);");
    // FullScreenViewer: actionError renders only inside the `pending` dialog → an alert when there is none
    const fsv = src("components/viewers/FullScreenViewer.tsx");
    expect(fsv).toContain('import { appAlert } from "@/components/providers/DialogProvider";');
    expect(fsv).toMatch(/setActionError\(message\);[\s\S]{0,400}?if \(!pending\) void appAlert\(message\);/);
    // fix pass 4: the markup export no longer drops logDownloadAudit's outcome — a refused record is said, after delivery
    expect(fsv).toMatch(/const audit = await logDownloadAudit\(\{[\s\S]{0,300}?\}\);\s*\n\s*if \(!audit\.recorded\) void appAlert\(new DownloadUnrecordedError\(audit\.error\)\.message\);/);
    expect(fsv).not.toMatch(/\n\s*await logDownloadAudit\(/);
    // VersionHistoryPanel: an inline line above the list — never the load-error state that replaces the panel
    const vh = src("components/documents/VersionHistoryPanel.tsx");
    expect(vh).toContain('setDownloadError((e as Error).message || "Download failed");');
    expect(vh).not.toContain('setError((e as Error).message || "Download failed");');
    expect(vh).toMatch(/\{downloadError && \(\s*\n\s*<div role="alert"/);
  });

  it("a delivered-but-unrecorded copy CLOSES the confirmation dialog and alerts — its download button never invites a second copy (fix pass 5)", () => {
    const fsv = src("components/viewers/FullScreenViewer.tsx");
    expect(fsv).toMatch(/if \(e instanceof DownloadUnrecordedError\) \{\s*\n\s*setPending\(null\);\s*\n\s*void appAlert\(message\);\s*\n\s*return;\s*\n\s*\}\s*\n\s*setActionError\(message\);/);
    const mdv = src("components/viewers/MultiDocViewer.tsx");
    expect(mdv).toMatch(/copyWatermark, DownloadUnrecordedError,\s*\n\} from "@\/lib\/downloads";/);
    expect(mdv).toMatch(/if \(e instanceof DownloadUnrecordedError\) \{\s*\n\s*setDownloadConfirm\(null\);\s*\n\s*void appAlert\(message\);\s*\n\s*return;\s*\n\s*\}\s*\n\s*setActionError\(message\);/);
    // the error is thrown only AFTER delivery, so closing the dialog loses nothing: the copy is in hand
    const downloads = src("lib/downloads.ts");
    expect(downloads).toMatch(/triggerBlobDownload\([\s\S]*?if \(!audit\.recorded\) throw new DownloadUnrecordedError\(audit\.error\);/);
  });
});

// ─── DRLS-10 ────────────────────────────────────────────────────────────────

describe("DRLS-10 — a re-pin records the stale signal it resolves; a refused close is said", () => {
  beforeEach(() => {
    state.tables.work_package_documents = [
      { id: "m1", package_id: "p1", org_id: "org1", document_id: "a", pinned_version_id: "v-old", pinned_rev_label: "4" },
      { id: "m2", package_id: "p1", org_id: "org1", document_id: "b", pinned_version_id: "v-b", pinned_rev_label: "1" },
    ];
    state.tables.documents = [docRow("a", { rev: "5" }), docRow("b")];
  });

  it("WORK_PACKAGE_REPINNED (from → to, only the drifted members) is written BEFORE any pin moves", async () => {
    await refreshWorkPackage("p1", { actor: { userId: "owner", email: "o@x" }, reason: "refresh" });
    const audit = state.inserts.find((i) => i.table === "audit_logs")!.row as Row;
    expect(audit.action).toBe("WORK_PACKAGE_REPINNED");
    expect(audit.resource_id).toBe("p1");
    expect(audit.user_id).toBe("owner");
    expect(audit.org_id).toBe("org1");
    expect(audit.details).toEqual({
      reason: "refresh", staleCount: 1,
      moved: [{ documentId: "a", fromVersionId: "v-old", fromRev: "4", toVersionId: "v-a", toRev: "5" }],
    });
    expect(state.events.indexOf("insert:audit_logs")).toBeLessThan(state.events.indexOf("update:work_package_documents"));
  });

  it("if the record cannot be written, NO pin moves", async () => {
    state.insertErrors.audit_logs = { message: "denied" };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(refreshWorkPackage("p1", { actor: { userId: "owner" } })).rejects.toThrow(/could not be recorded \(denied\), so no pin moved/);
    err.mockRestore();
    expect(state.updates).toEqual([]);
  });

  it("a fresh package re-checked writes no stale record (nothing was erased)", async () => {
    state.tables.work_package_documents = [state.tables.work_package_documents[1]];
    await refreshWorkPackage("p1", { actor: { userId: "owner" } });
    expect(state.inserts.filter((i) => i.table === "audit_logs")).toEqual([]);
  });

  it("a Viewer's re-pin of another member's package is refused (the PKG-5 policy matches zero rows) — and said, never 'refreshed'", async () => {
    state.updateDenied = new Set(["m1", "m2"]);
    await expect(refreshWorkPackage("p1", { actor: { userId: "viewer" } })).rejects.toThrow(/the pins did NOT move\. Moving pins requires being the package's owner or Document Control/);
    // The trail stays truthful: the intent row is followed by a compensating
    // row naming the drifted member that did NOT move — no unqualified
    // WORK_PACKAGE_REPINNED is left standing alone.
    const audits = state.inserts.filter((i) => i.table === "audit_logs").map((i) => i.row as Row);
    expect(audits.map((a) => a.action)).toEqual(["WORK_PACKAGE_REPINNED", "WORK_PACKAGE_REPIN_REFUSED"]);
    expect(audits[1].resource_id).toBe("p1");
    expect(audits[1].user_id).toBe("viewer");
    expect(audits[1].details).toEqual({
      reason: "refresh", corrects: "WORK_PACKAGE_REPINNED", notMovedCount: 1, movedCount: 0,
      notMoved: [{ documentId: "a", fromVersionId: "v-old", fromRev: "4", toVersionId: "v-a", toRev: "5", cause: "refused" }],
    });
    expect(state.events.lastIndexOf("insert:audit_logs")).toBeGreaterThan(state.events.lastIndexOf("update:work_package_documents"));
  });

  it("a partial re-pin names only the members that did not move (a refused no-op on a fresh member is not a correction)", async () => {
    state.tables.work_package_documents.push({ id: "m3", package_id: "p1", org_id: "org1", document_id: "c", pinned_version_id: "v-c0", pinned_rev_label: "0" });
    state.tables.documents.push(docRow("c", { rev: "1" }));
    state.updateDenied = new Set(["m2", "m3"]);
    await expect(refreshWorkPackage("p1", { actor: { userId: "owner" }, reason: "print" })).rejects.toThrow(/matched 0 rows for 2 of 3 pins/);
    const audits = state.inserts.filter((i) => i.table === "audit_logs").map((i) => i.row as Row);
    expect(audits.map((a) => a.action)).toEqual(["WORK_PACKAGE_REPINNED", "WORK_PACKAGE_REPIN_REFUSED"]);
    expect((audits[0].details as Row).staleCount).toBe(2);
    const d = audits[1].details as Row;
    expect(d.reason).toBe("print");
    expect(d.movedCount).toBe(1);
    expect((d.notMoved as Row[]).map((m) => [m.documentId, m.cause])).toEqual([["c", "refused"]]);
  });

  it("only a fresh member refused (every drifted pin moved): no correction is written", async () => {
    state.updateDenied = new Set(["m2"]);
    await expect(refreshWorkPackage("p1", { actor: { userId: "owner" } })).rejects.toThrow(/matched 0 rows for 1 of 2 pins/);
    expect(state.inserts.filter((i) => i.table === "audit_logs").map((i) => (i.row as Row).action)).toEqual(["WORK_PACKAGE_REPINNED"]);
  });

  it("a correction that cannot be written is said in the refusal", async () => {
    state.updateDenied = new Set(["m1"]);
    let n = 0;
    const realInsertErrors = state.insertErrors;
    state.insertErrors = new Proxy(realInsertErrors, {
      get: (t, k) => (k === "audit_logs" ? (n++ === 0 ? undefined : { message: "denied" }) : (t as Record<string, unknown>)[k as string]),
    }) as typeof state.insertErrors;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(refreshWorkPackage("p1", { actor: { userId: "owner" } })).rejects.toThrow(
      /The correction to the re-pin record could not be written either \(denied\): the audit trail names 1 pin as moved that did not move/,
    );
    err.mockRestore();
    state.insertErrors = {};
  });

  it("a close that matches no row is a refusal, not 'closed'", async () => {
    state.updateDenied = new Set(["p1"]);
    await expect(setWorkPackageStatus("p1", "closed", "viewer")).rejects.toThrow(/only its owner or Document Control can close it/);
  });

  it("the live pin policies (newest definitions in the migration sequence) bar non-owners: UPDATE and DELETE need the package owner or a controller", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const newest: Record<string, string> = {};
    for (const f of files) {
      const sql = readFileSync(join(dir, f), "utf8");
      const re = /CREATE POLICY (work_package_documents_org_(?:update|delete)) ON work_package_documents[\s\S]*?;\n/g;
      for (const m of sql.matchAll(re)) newest[m[1]] = `${f}\n${m[0]}`;
    }
    for (const name of ["work_package_documents_org_update", "work_package_documents_org_delete"]) {
      expect(newest[name]).toBeTruthy();
      expect(newest[name]).toContain("p.owner_user_id = auth.uid()");
      expect(newest[name]).toMatch(/m\.role IN \('Admin','DocCtrl'\)\s*\n\s*OR m\.roles && ARRAY\['Admin','DocCtrl'\]/);
    }
  });

  it("the packages page offers Refresh pins and Close only to the owner or a controller (the collection-aware tier)", () => {
    const page = src("app/(protected)/packages/page.tsx");
    expect(page).toContain("const isController = isControllerPrincipal({ role: activeRole, roles });");
    expect(page).toContain("const canManage = (pkg: WorkPackage) => pkg.ownerUserId === uid || isController;");
    expect(page).toContain("{stale && manage && (");
    expect(page).toContain("{manage && (");
    expect(page).not.toMatch(/hasAnyRole\(\["Admin", "DocCtrl"\]\)/);
  });
});

// ─── VFY-18 / VFY-19 (the record) ───────────────────────────────────────────

describe("VFY-18 — a print whose snapshot cannot be written stops before anything is downloaded", () => {
  const sheets = [{ documentId: "a", versionId: "v-a", revLabel: "1", label: "A" }];

  it("recordPackagePrint throws PackagePrintNotRecordedError on a refused insert (it used to return null and ship a bare-package QR)", async () => {
    state.insertErrors.work_package_prints = { message: "new row violates row-level security policy" };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const e = await recordPackagePrint({ orgId: "org1", packageId: "p1", sheets }).catch((x) => x);
    err.mockRestore();
    expect(e).toBeInstanceOf(PackagePrintNotRecordedError);
    expect(String(e.message)).toMatch(/The pack was NOT printed: its print record could not be written \(new row violates/);
    // a written snapshot returns its id
    state.insertErrors = {};
    expect(await recordPackagePrint({ orgId: "org1", packageId: "p2", sheets })).toBe("work_package_prints-1");
  });

  it("thrown from the cover step, it aborts the pack: no download, no record, no pins", async () => {
    state.tables.documents = [docRow("a")];
    state.tables.document_versions = [versionFor("a")];
    state.insertErrors.work_package_prints = { message: "denied" };
    const after = vi.fn();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(buildAndDownloadDocPack(packInput(["a"], {
      buildCoverAfter: async () => { await recordPackagePrint({ orgId: "org1", packageId: "p1", sheets }); return null; },
      afterDownload: after,
    }) as never)).rejects.toBeInstanceOf(PackagePrintNotRecordedError);
    err.mockRestore();
    expect(state.events).not.toContain("download");
    expect(state.inserts.filter((i) => i.table === "download_audits")).toEqual([]);
    expect(after).not.toHaveBeenCalled();
  });

  it("the packages page no longer calls the snapshot best-effort", () => {
    const page = src("app/(protected)/packages/page.tsx");
    expect(page).not.toMatch(/Best-effort inside recordPackagePrint/);
    expect(page).toMatch(/A snapshot that cannot be\s*\n\s*\/\/ written STOPS the print here/);
  });
});

describe("VFY-19 — the snapshot records the sheets the print left out, with a code", () => {
  it("printed sheets carry printed:true; left-out ones printed:false with their code, reason and the revision tried", () => {
    const out = printSnapshotSheets(
      [{ documentId: "a", versionId: "v-a", revLabel: "1", label: "A" }],
      [
        { documentId: "b", label: "B", code: "fetch_failed", reason: "the file could not be fetched (HTTP 503)", versionId: "v-b" },
        { documentId: "a", label: "A", code: "on_hold", reason: "dup of a printed sheet" },
        { documentId: "b", label: "B", code: "on_hold", reason: "dup" },
      ],
    );
    expect(out).toEqual([
      { documentId: "a", versionId: "v-a", revLabel: "1", label: "A", printed: true },
      { documentId: "b", versionId: "v-b", revLabel: null, label: "B", printed: false, leftOutCode: "fetch_failed", leftOutReason: "the file could not be fetched (HTTP 503)" },
    ]);
  });

  it("recordPackagePrint writes that shape", async () => {
    await recordPackagePrint({
      orgId: "org1", packageId: "p1",
      sheets: [{ documentId: "a", versionId: "v-a", revLabel: "1", label: "A" }],
      leftOut: [{ documentId: "h", label: "H", code: "on_hold", reason: "under an active hold" }],
    });
    const row = state.inserts.find((i) => i.table === "work_package_prints")!.row as Row;
    expect((row.sheets as Row[]).map((s) => [s.documentId, s.printed, s.leftOutCode ?? null])).toEqual([["a", true, null], ["h", false, "on_hold"]]);
  });

  it("mergeLeftOut: the gate's refusals and the builder's, once per document", () => {
    expect(mergeLeftOut(
      [{ documentId: "x", label: "X", reason: "r", code: "on_hold" }],
      [{ documentId: "x", label: "X", reason: "r2", code: "on_hold" }, { documentId: "y", label: "Y", reason: "r", code: "fetch_failed" }],
    ).map((s) => s.documentId)).toEqual(["x", "y"]);
  });

  it("the packages page records the gate's and the builder's left-out sheets on the print", () => {
    const page = src("app/(protected)/packages/page.tsx");
    expect(page).toContain("buildCoverAfter: async (includedSheets, builderSkipped) => {");
    expect(page).toContain("leftOut: mergeLeftOut(assessment.skipped, builderSkipped).flatMap((s) =>");
    // the members are read FRESH by package id right before the gate (PKG-7 /
    // VFY-19 — never the list loaded earlier, which may be stale or short)
    expect(page).toMatch(/const memberIds = await readPackageMemberIds\(pkg\.id\);[\s\S]{0,400}?const assessment = await assessPackDocs\(memberIds, \{ userId: uid \}\);/);
    expect(page).not.toContain("assessPackDocs(pkg.docs.map(");
  });
});
