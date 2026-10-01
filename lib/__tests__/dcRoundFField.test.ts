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

import { describe, it, expect, vi, beforeEach } from "vitest";
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
  ackPolicies: {} as Record<string, unknown>,
  stamps: [] as Array<Record<string, unknown>>,
  stampedDownloads: [] as Array<{ filename: string; options: Record<string, unknown> }>,
  /** Pages of the PDF served at a URL (the mock's ArrayBuffer length). */
  pagesByUrl: {} as Record<string, number>,
  failUrls: new Set<string>(),
  unparseable: new Set<number>(),
  user: { id: "u1", email: "u1@example.com" } as { id: string; email: string } | null,
}));

function chain(table: string) {
  const filters: Record<string, unknown> = {};
  const ins: Record<string, unknown[]> = {};
  let op: "select" | "insert" | "update" = "select";
  let payload: unknown = null;
  let single = false;
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
    if (state.readErrors[table]) return { data: null, error: state.readErrors[table] };
    const rows = (state.tables[table] ?? []).filter((r) =>
      Object.entries(ins).every(([k, v]) => v.includes(r[k])) &&
      Object.entries(filters).every(([k, v]) => !(k in r) || r[k] === v));
    if (single) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
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
        if (p === "in") ins[String(args[0])] = args[1] as unknown[];
        if (p === "single" || p === "maybeSingle") single = true;
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
vi.mock("@/lib/acknowledgments", () => ({
  effectiveAckPolicyForDocument: vi.fn(async (d: { libraryId: string }) => state.ackPolicies[d.libraryId] ?? null),
}));
vi.mock("@/lib/stamping", () => ({
  applyStampToPdfDoc: vi.fn(async (_doc: unknown, opts: Record<string, unknown>) => { state.stamps.push(opts); }),
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
    copyPages: async (_src: unknown, idx: number[]) => idx.map(() => "page"),
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
        if (state.unparseable.has(bytes.byteLength)) throw new Error("Failed to parse PDF document");
        return doc(bytes.byteLength);
      },
    },
  };
});

import { buildAndDownloadDocPack, assessPackDocs, PackTooLargeError, PACK_MAX_SHEETS, PACK_MAX_PAGES, packPartsFor, splitPackIds, packSheetBudgetRefusal, accountForRequested } from "@/lib/docPack";
import {
  listWorkPackages, createWorkPackage, refreshWorkPackage, recordPackagePrint, setWorkPackageStatus,
  printSnapshotSheets, coverEntryLabels, mergeLeftOut, memberFreshness, PackagePrintNotRecordedError, resetPackageSchemaFlag,
} from "@/lib/workPackages";
import {
  downloadDocumentPdf, printDocumentPdf, buildFooterNotice, copyControlState, copyWatermark, holdFooterLine,
  logDownloadAudit, DownloadUnrecordedError, AcknowledgmentRequiredError, ackGatedDocumentIds,
} from "@/lib/downloads";
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
  state.ackPolicies = {};
  state.stamps = [];
  state.stampedDownloads = [];
  state.pagesByUrl = {};
  state.failUrls = new Set();
  state.unparseable = new Set();
  state.user = { id: "u1", email: "u1@example.com" };
  resetPackageSchemaFlag();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    if (state.failUrls.has(u)) return { ok: false, status: 503 };
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(state.pagesByUrl[u] ?? 1),
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
    expect(pkg.unknownCount).toBe(1);
    expect(pkg.staleCount).toBe(0);
    expect(memberFreshness("v1", { current_version_id: "v2" })).toBe("drifted");
    expect(memberFreshness("v1", null)).toBe("unknown");
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
});

// ─── PKG-9 ──────────────────────────────────────────────────────────────────

describe("PKG-9 — the hard read-&-understood gate binds every pack button", () => {
  beforeEach(() => {
    state.ackPolicies.libGated = { enabled: true, hardGate: true };
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

  it("ONE helper: the single download (assertAckGate), the pack and the book all call ackGatedDocumentIds", async () => {
    const downloads = src("lib/downloads.ts");
    expect(downloads).toMatch(/async function assertAckGate[\s\S]{0,200}?ackGatedDocumentIds\(\[ctx\.doc\], ctx\.userId\)/);
    expect(src("lib/docPack.ts")).toContain('import { ackGatedDocumentIds } from "@/lib/downloads";');
    expect(src("components/viewers/MultiDocViewer.tsx")).toMatch(/const gated = await ackGatedDocumentIds\(scope\.map\(\(e\) => e\.doc\), currentUserId\);/);
    // and the single download still refuses through it
    const doc = { id: "g", orgId: "org1", libraryId: "libGated", documentNumber: "G-1" } as DocumentRecord;
    await expect(downloadDocumentPdf({ doc, fileUrl: "https://files/g.pdf", userId: "u1" })).rejects.toBeInstanceOf(AcknowledgmentRequiredError);
    expect(state.stampedDownloads).toHaveLength(0);
  });

  it("fails OPEN on a broken policy read (unchanged rule) — a lookup error gates nothing", async () => {
    const { effectiveAckPolicyForDocument } = await import("@/lib/acknowledgments");
    vi.mocked(effectiveAckPolicyForDocument).mockRejectedValueOnce(new Error("boom"));
    const gated = await ackGatedDocumentIds([{ id: "g", libraryId: "libBroken" }], "u1");
    expect(gated.size).toBe(0);
  });
});

// ─── PKG-12 ─────────────────────────────────────────────────────────────────

describe("PKG-12 — a pack has a budget, keeps its order, and the cover gives each entry its pages", () => {
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

  it("a single sheet over the budget says so (download it on its own)", async () => {
    state.tables.documents = [docRow("a")];
    state.tables.document_versions = [versionFor("a", PACK_MAX_PAGES + 1)];
    await expect(buildAndDownloadDocPack(packInput(["a"]) as never)).rejects.toThrow(/A alone is over a field pack's/);
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

  it("the work-package member query orders deterministically; the page builds the cover with page numbers", () => {
    expect(src("lib/workPackages.ts")).toMatch(/\.in\("package_id", pkgRows\.map\(\(p\) => String\(p\.id\)\)\)\s*\n\s*\.order\("added_at", \{ ascending: true \}\)\s*\n\s*\.order\("id", \{ ascending: true \}\);/);
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
    expect(r.skipped).toEqual([expect.objectContaining({ documentId: "b", code: "unreadable_pdf", versionId: "v-b", reason: "Failed to parse PDF document" })]);
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
    expect(v).toMatch(/if \(book\.unrecorded > 0\) \{ setActionError\(unrecordedBookMessage\(book\.unrecorded\)\); return; \}/);
    // HLD-1 in the book
    expect(v).toMatch(/const hold = await readCopyHoldState\(entry\.doc\.id\);/);
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
    expect(page).toContain("const assessment = await assessPackDocs(pkg.docs.map((d) => d.documentId), { userId: uid });");
  });
});
