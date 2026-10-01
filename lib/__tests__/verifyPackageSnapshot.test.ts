// /api/verify-package snapshot verdict (PKG-2), extended by public-surfaces
// Round F PS-VERIFY (VFY-1 / VFY-2 / VFY-5 / VFY-8 / VFY-11 / VFY-12 /
// VFY-13; document-control HLD-3 / PKG-8; PHYS-1 done-when 2).
//
// With a print id, the verdict is computed against the RECORDED versions in
// the print snapshot, not the live pins — so refreshing pins after printing
// cannot flip already-distributed paper back to green. Green additionally
// needs: an open package, at least one sheet, every sheet Issued / Locked,
// hold-free, current, in force, still in the package, and every sheet of the
// package in the pack. A package sheet missing from the paper that could be
// printed now makes the pack red ("in the package but not in this pack" —
// never "added since printing": the snapshot cannot prove that, VFY-19); one
// that cannot be printed now (the print gate's refusals and only those: not
// issued, status not recognised, withdrawn, a document_holds hold, no current
// file, a file that is not a PDF — never a legal hold alone) makes an
// otherwise current pack amber "incomplete", never stale. A legacy QR (no
// print id) is never green.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { presentPackVerdict, notPrintableText, type PackVerifyResult } from "@/lib/verifyPresent";
import { isPdfFile } from "@/lib/verifyVerdict";

const PKG = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PRINT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const DOC = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const DOC2 = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const DOC3 = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

const state = vi.hoisted(() => ({
  pkg: null as Record<string, unknown> | null,
  print: null as Record<string, unknown> | null,
  liveMembers: [] as Array<Record<string, unknown>>,
  docs: [] as Array<Record<string, unknown>>,
  holds: [] as Array<Record<string, unknown>>,
  versions: [] as Array<Record<string, unknown>>,
  errors: {} as Record<string, boolean>,
  /** The Postgres error code a failing table's read carries (e.g. 42703). */
  errorCodes: {} as Record<string, string>,
  /** A read that fails for ONE select only, keyed "table|columns"; the value
   *  is the error code it carries ("" for none). */
  selectErrors: {} as Record<string, string>,
  selects: [] as Array<{ table: string; cols: string }>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));

function chain(table: string) {
  const eqs: Record<string, unknown> = {};
  const ins: Record<string, unknown[]> = {};
  let head = false;
  let cols = "";
  const rowsFor = (): unknown[] => {
    const src =
      table === "work_package_documents" ? state.liveMembers
      : table === "documents" ? state.docs
      : table === "document_holds" ? state.holds.filter((h) => h.released_at == null)
      : table === "document_versions" ? state.versions
      : [];
    return src.filter((r) =>
      Object.entries(ins).every(([k, v]) => v.includes(r[k])) &&
      // a filter on a column the fixture row does not carry is not modelled
      Object.entries(eqs).every(([k, v]) => !(k in r) || r[k] === v));
  };
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, p: string) {
      if (p === "then") {
        return (resolve: (v: unknown) => void) => {
          const key = `${table}|${cols}`;
          if (key in state.selectErrors) return resolve({ data: null, error: { message: `${key} read failed`, code: state.selectErrors[key] || undefined } });
          if (state.errors[table]) return resolve({ data: null, error: { message: `${table} read failed`, code: state.errorCodes[table] } });
          if (head) return resolve({ data: null, error: null, count: 0 });
          // document_versions answers with exactly the columns selected, so a
          // column-less retry cannot see a column it did not ask for
          const rows = rowsFor();
          const pick = table === "document_versions" && /^[\w, ]+$/.test(cols) ? cols.split(",").map((x) => x.trim()) : null;
          resolve({ data: pick ? rows.map((r) => Object.fromEntries(pick.filter((k) => k in (r as object)).map((k) => [k, (r as Record<string, unknown>)[k]]))) : rows, error: null });
        };
      }
      return (...args: unknown[]) => {
        if (p === "select") {
          cols = String(args[0]);
          state.selects.push({ table, cols });
          if ((args[1] as { head?: boolean } | undefined)?.head) head = true;
        }
        if (p === "insert") state.inserts.push({ table, row: args[0] as Record<string, unknown> });
        if (p === "eq") eqs[args[0] as string] = args[1];
        if (p === "in") ins[args[0] as string] = args[1] as unknown[];
        if (p === "maybeSingle") {
          if (state.errors[table]) return Promise.resolve({ data: null, error: { message: `${table} read failed` } });
          if (table === "work_packages") return Promise.resolve({ data: state.pkg, error: null });
          if (table === "work_package_prints") return Promise.resolve({ data: state.print, error: null });
          return Promise.resolve({ data: null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chain(t) }) }));

const docRow = (over: Record<string, unknown> = {}) => ({
  id: DOC, document_number: "P-101", title: "P&ID", name: "P-101", rev: "4", current_version_id: "v2", status: "Issued", legal_hold: false, ...over,
});
const printAt = (sheets: Array<Record<string, unknown>>) => ({ id: PRINT, package_id: PKG, printed_at: "2026-08-20T00:00:00Z", sheets });
const sheetV2 = { documentId: DOC, versionId: "v2", revLabel: "4", label: "P-101" };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  state.pkg = { id: PKG, org_id: "o1", name: "TA-2026", status: "open", closed_at: null };
  state.print = null;
  state.liveMembers = [{ document_id: DOC, pinned_version_id: "v2", pinned_rev_label: "4" }];
  // The document is at v2 (Rev 4).
  state.docs = [docRow()];
  state.holds = [];
  state.versions = [];
  state.errors = {};
  state.errorCodes = {};
  state.selectErrors = {};
  state.selects = [];
  state.inserts = [];
});

async function call(withPrint: boolean) {
  const { GET } = await import("@/app/api/verify-package/route");
  const u = new URL("https://app/api/verify-package");
  u.searchParams.set("p", PKG);
  if (withPrint) u.searchParams.set("print", PRINT);
  return GET(new NextRequest(u));
}
async function verify(withPrint: boolean): Promise<Record<string, unknown>> {
  return (await (await call(withPrint)).json()) as Record<string, unknown>;
}
const states = (r: Record<string, unknown>) => (r.sheets as Array<Record<string, unknown>>).map((s) => s.state);

describe("/api/verify-package snapshot (PKG-2)", () => {
  it("snapshot printed at v1 reads STALE even after the LIVE pin was refreshed to v2", async () => {
    // The live pin has been refreshed to current (v2) — the old bug would read
    // this as fresh. The print snapshot recorded v1, so it must read stale.
    state.print = printAt([{ documentId: DOC, versionId: "v1", revLabel: "3", label: "P-101" }]);
    const r = await verify(true);
    expect(r.allFresh).toBe(false);
    expect(r.staleCount).toBe(1);
    expect(r.verdict).toBe("stale");
    expect(r.printedAt).toBe("2026-08-20T00:00:00Z");
  });

  it("snapshot printed at the current version, sheet still in the package, reads CURRENT", async () => {
    state.print = printAt([sheetV2]);
    const r = await verify(true);
    expect(r.allFresh).toBe(true);
    expect(r.verdict).toBe("current");
    expect(r.staleCount).toBe(0);
    expect(states(r)).toEqual(["fresh"]);
  });

  it("a print id that resolves to no snapshot never reads green", async () => {
    state.print = null; // unknown print
    const r = await verify(true);
    expect(r.snapshotMissing).toBe(true);
    expect(r.printConfirmed).toBe(false);
    expect(r.verdict).toBe("unverifiable");
    expect(r.allFresh).toBe(false);
  });
});

describe("VFY-2 — the printed manifest, not the live package", () => {
  it("a legacy QR (no print id) is NEVER green — 'cannot confirm which printing', even when the live pin matches current", async () => {
    const r = await verify(false);
    expect(r.verdict).toBe("unconfirmed_print");
    expect(r.allFresh).toBe(false);
    expect(r.printConfirmed).toBe(false);
    expect(r.snapshotMissing).toBe(false);
    expect(states(r)).toEqual(["unconfirmed"]);
    // a live pin is not "what was printed"
    expect((r.sheets as Array<Record<string, unknown>>)[0].printedRev).toBeNull();
  });
  it("a legacy QR still reports what is true of every printing: a held or voided sheet", async () => {
    state.holds = [{ document_id: DOC, reason: "Client Review", released_at: null }];
    expect((await verify(false)).verdict).toBe("held");
    state.holds = [];
    state.docs = [docRow({ status: "Void" })];
    const r = await verify(false);
    expect(r.verdict).toBe("stale");
    expect(states(r)).toEqual(["void"]);
  });
  it("a printable sheet ADDED to the package since printing is reported as 'in the package but not in this pack' and the pack is not green", async () => {
    state.print = printAt([sheetV2]);
    state.liveMembers.push({ document_id: DOC2, pinned_version_id: "w1", pinned_rev_label: "1" });
    state.docs.push(docRow({ id: DOC2, document_number: "P-102", current_version_id: "w1", rev: "1" }));
    state.versions = [{ id: "w1", file_url: "org/lib/P-102__rev1__1.pdf", file_type: "application/pdf" }];
    const r = await verify(true);
    expect(r.notInPack).toEqual([{ label: "P-102" }]);
    expect(r.notPrintable).toEqual([]);
    expect(r).not.toHaveProperty("addedSincePrint");
    expect(r.verdict).toBe("stale");
    expect(r.allFresh).toBe(false);
    expect(states(r)).toEqual(["fresh"]); // the printed sheet itself is fine
    const view = presentPackVerdict(r as unknown as PackVerifyResult);
    expect(view.ok).toBe(false);
    expect(view.headline).toBe("PACK IS MISSING SHEETS");
    expect(view.blurb).toContain("1 sheet in the package is not in this pack");
    // the snapshot cannot prove WHEN it joined — nothing says "added since printing"
    expect(`${view.headline} ${view.blurb} ${view.advice}`).not.toMatch(/added/i);
  });
  it("a sheet REMOVED from the package since printing is marked on the paper's list, not silently dropped", async () => {
    state.print = printAt([sheetV2]);
    state.liveMembers = [];
    const r = await verify(true);
    expect(states(r)).toEqual(["removed"]);
    expect(r.verdict).toBe("stale");
  });
});

describe("VFY-2 review fix — a package sheet the print gate could not print is not 'added since printing' and never makes a correct pack stale", () => {
  const member = (id: string, over: Record<string, unknown> = {}) => {
    state.liveMembers.push({ document_id: id, pinned_version_id: "w1", pinned_rev_label: "1" });
    state.docs.push(docRow({ id, document_number: id === DOC2 ? "P-102" : "P-103", current_version_id: "w1", rev: "1", ...over }));
  };
  const view = (r: Record<string, unknown>) => presentPackVerdict(r as unknown as PackVerifyResult);
  const allText = (r: Record<string, unknown>) => { const v = view(r); return `${v.headline} ${v.blurb} ${v.advice ?? ""}`; };

  it("printed Issued sheet + a DRAFT member PKG-4 left out → 'incomplete' (amber), not 'stale', and no 'added since printing'", async () => {
    state.print = printAt([sheetV2]);
    member(DOC2, { status: "Draft" });
    const r = await verify(true);
    expect(r.verdict).toBe("incomplete");
    expect(r.verdict).not.toBe("stale");
    expect(r.staleCount).toBe(0);
    expect(r.notInPack).toEqual([]);
    expect(r.notPrintable).toEqual([{ label: "P-102", reason: "not_issued" }]);
    expect(states(r)).toEqual(["fresh"]);
    expect(r.allFresh).toBe(false);
    const v = view(r);
    expect(v.ok).toBe(false);
    expect(v.bg).toBe("bg-amber-500");
    expect(v.headline).toBe("PACK INCOMPLETE");
    expect(v.blurb).toContain("Every sheet in this pack is current, but 1 sheet in the package is not in it and cannot be printed now (not issued)");
    expect(allText(r)).not.toMatch(/added|stale/i);
  });
  it("the same with a member under an ACTIVE document_holds HOLD → 'incomplete', reason on_hold", async () => {
    state.print = printAt([sheetV2]);
    member(DOC2);
    state.holds = [{ document_id: DOC2, reason: "Client Review", released_at: null }];
    const r = await verify(true);
    expect(r.verdict).toBe("incomplete");
    expect(r.notPrintable).toEqual([{ label: "P-102", reason: "on_hold" }]);
    expect(r.heldCount).toBe(0); // the printed sheet is not held — the pack is not "on hold"
    expect(allText(r)).toContain("(on hold)");
    expect(allText(r)).not.toMatch(/added|stale/i);
  });
  it("integration fix — a LEGAL hold alone is not a print-gate refusal: a legally held member with a PDF is notInPack (red); a document_holds member is on_hold (amber)", async () => {
    state.print = printAt([sheetV2]);
    member(DOC2, { legal_hold: true });
    state.versions = [{ id: "w1", file_url: "org/lib/P-102__rev1__1.pdf", file_type: "application/pdf" }];
    // preservation, not stop-work: filterPackDocs never refuses it, so a re-print carries it
    let r = await verify(true);
    expect(r.notInPack).toEqual([{ label: "P-102" }]);
    expect(r.notPrintable).toEqual([]);
    expect(r.verdict).toBe("stale");
    expect(view(r).headline).toBe("PACK IS MISSING SHEETS");
    expect(view(r).bg).toBe("bg-red-600");
    // its file was read like any other printable member's
    expect(state.selects.filter((x) => x.table === "document_versions" && x.cols.includes("file_url")).length).toBe(1);
    // a document_holds row (stop-work) IS a refusal — with or without the legal hold
    state.holds = [{ document_id: DOC2, reason: "Client Review", released_at: null }];
    r = await verify(true);
    expect(r.notPrintable).toEqual([{ label: "P-102", reason: "on_hold" }]);
    expect(r.notInPack).toEqual([]);
    expect(r.verdict).toBe("incomplete");
    state.docs = state.docs.map((d) => (d.id === DOC2 ? { ...d, legal_hold: false } : d));
    r = await verify(true);
    expect(r.notPrintable).toEqual([{ label: "P-102", reason: "on_hold" }]);
    // a legally held member the gate refuses for ANOTHER reason is listed with that reason
    state.holds = [];
    state.docs = state.docs.map((d) => (d.id === DOC2 ? { ...d, legal_hold: true } : d));
    state.versions = [{ id: "w1", file_url: "org/lib/P-102__rev1__1.dwg", file_type: null }];
    r = await verify(true);
    expect(r.notPrintable).toEqual([{ label: "P-102", reason: "not_pdf" }]);
    // the gate itself: lib/docPack.ts reads no legal hold (if it ever refuses one, this split must follow)
    expect(readFileSync(join(process.cwd(), "lib/docPack.ts"), "utf8")).not.toMatch(/legal_hold|legalHold/);
  });
  it("a PRINTED sheet under a legal hold still reads held — the integration fix changes only the off-paper split", async () => {
    state.print = printAt([sheetV2]);
    state.docs = [docRow({ legal_hold: true })];
    const r = await verify(true);
    expect(states(r)).toEqual(["held"]);
    expect(r.verdict).toBe("held");
  });
  it("each PKG-4 refusal has its reason: withdrawn (Void), no current file, a document that cannot be read, an unknown hold state", async () => {
    state.print = printAt([sheetV2]);
    member(DOC2, { status: "Void" });
    member(DOC3, { current_version_id: null });
    let r = await verify(true);
    expect(r.notPrintable).toEqual([{ label: "P-102", reason: "withdrawn" }, { label: "P-103", reason: "no_file" }]);
    expect(r.verdict).toBe("incomplete");
    // a member whose document row is not readable (gone, another org) is never packed either
    state.docs = state.docs.filter((d) => d.id !== DOC3);
    r = await verify(true);
    expect((r.notPrintable as Array<Record<string, unknown>>)[1]).toEqual({ label: "Document", reason: "unavailable" });
    // an unreadable hold state: the printed sheet is held (fail closed) and the member's hold state is unknown
    state.errors.document_holds = true;
    r = await verify(true);
    expect(r.verdict).toBe("held");
    expect((r.notPrintable as Array<Record<string, unknown>>)[0]).toEqual({ label: "P-102", reason: "hold_unknown" });
  });
  it("a member truly added later (printable now) is still reported — and makes the pack red even beside a not-printable one", async () => {
    state.print = printAt([sheetV2]);
    member(DOC2, { status: "Draft" });
    member(DOC3);
    state.versions = [{ id: "w1", file_url: "org/lib/P-103__rev1__1.pdf", file_type: "application/pdf" }];
    const r = await verify(true);
    expect(r.verdict).toBe("stale");
    expect(r.notInPack).toEqual([{ label: "P-103" }]);
    expect(r.notPrintable).toEqual([{ label: "P-102", reason: "not_issued" }]);
    expect(view(r).headline).toBe("PACK IS MISSING SHEETS");
    expect(allText(r)).not.toMatch(/added/i);
  });
  it("re-printing clears it: once the left-out member is the only difference, a later issue + re-print reads green", async () => {
    // the member was a Draft at print, is Issued now, and the new print carries it
    state.print = printAt([sheetV2, { documentId: DOC2, versionId: "w1", revLabel: "1", label: "P-102" }]);
    member(DOC2);
    const r = await verify(true);
    expect(r.verdict).toBe("current");
    expect(r.notInPack).toEqual([]);
    expect(r.notPrintable).toEqual([]);
  });
  it("a not-yet-effective printed sheet still says so before 'incomplete' (both amber; the sheet in hand comes first)", async () => {
    state.print = printAt([sheetV2]);
    state.versions = [{ id: "v2", effective_date: "2999-01-01" }];
    member(DOC2, { status: "Draft" });
    const r = await verify(true);
    expect(r.verdict).toBe("not_yet_effective");
    expect(r.notPrintable).toEqual([{ label: "P-102", reason: "not_issued" }]);
  });
  it("a legacy QR compares nothing — no off-paper groups, still 'unconfirmed_print'", async () => {
    member(DOC2, { status: "Draft" });
    const r = await verify(false);
    expect(r.notInPack).toEqual([]);
    expect(r.notPrintable).toEqual([]);
    expect(r.verdict).toBe("stale"); // the Draft member IS on a legacy QR's "paper" (the live membership)
  });
  it("the page never says 'added to the package since printing' on its own — only from the route's VFY-19 fields, which an older snapshot never sets", () => {
    const page = readFileSync(join(process.cwd(), "app/verify-package/[packageId]/page.tsx"), "utf8");
    expect(page).not.toMatch(/since printing/i);
    expect(page).not.toContain("addedSincePrint");
    expect(page).toContain("In the package but NOT in this pack:");
    expect(page).toContain("In the package, not in this pack — cannot be printed now:");
    expect(page).toContain("notPrintableText(a.reason)");
    // document-control P8 (VFY-19): the words for WHEN come from
    // lib/packLeftOut.ts, gated on the route's fields
    expect(page).toContain("missingSheetWhen(a)");
    const route = readFileSync(join(process.cwd(), "app/api/verify-package/route.ts"), "utf8");
    expect(route).toContain("const when: WhenMissing = !recordsLeftOut ? {} : atPrint ? { leftOutAtPrint: atPrint } : { addedSincePrint: true };");
  });
});

describe("VFY-2 third review fix — a sheet the print gate can NEVER print (no file on its current revision, not a PDF) is amber, never red", () => {
  // P-101 (Issued PDF) is printed; P-102 is Issued, hold-free, in the package,
  // and its current revision is the version below. The print gate
  // (lib/docPack.ts buildAndDownloadDocPack) skips a revision with no file
  // ("no current file") and a file pdf-lib cannot load — every re-print, so
  // the snapshot never carries it.
  const W2 = "w2";
  const withMember = (version: Record<string, unknown> | null) => {
    state.print = printAt([sheetV2]);
    state.liveMembers.push({ document_id: DOC2, pinned_version_id: W2, pinned_rev_label: "1" });
    state.docs.push(docRow({ id: DOC2, document_number: "P-102", current_version_id: W2, rev: "1" }));
    state.versions = version ? [{ id: W2, ...version }] : [];
  };
  const view = (r: Record<string, unknown>) => presentPackVerdict(r as unknown as PackVerifyResult);
  const allText = (r: Record<string, unknown>) => { const v = view(r); return `${v.headline} ${v.blurb} ${v.advice ?? ""}`; };

  it("the review's scenario: P-102's current revision is a .dwg → notPrintable not_pdf, AMBER 'incomplete' — not red 'PACK IS MISSING SHEETS'", async () => {
    withMember({ file_url: "org/lib/P-102__rev1__1700000000000.dwg", file_type: "application/octet-stream" });
    const r = await verify(true);
    expect(r.notPrintable).toEqual([{ label: "P-102", reason: "not_pdf" }]);
    expect(r.notInPack).toEqual([]);
    expect(r.verdict).toBe("incomplete");
    expect(r.staleCount).toBe(0);
    expect(states(r)).toEqual(["fresh"]);
    const v = view(r);
    expect(v.bg).toBe("bg-amber-500");
    expect(v.headline).toBe("PACK INCOMPLETE");
    expect(v.blurb).toContain("1 sheet in the package is not in it and cannot be printed now (not a printable PDF)");
    expect(allText(r)).not.toMatch(/MISSING SHEETS|re-printed pack —|stale|added/i);
  });
  it.each([
    ["a spreadsheet", "org/lib/P-102__rev1__1.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["a Word file", "org/lib/P-102__rev1__1.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["an image", "org/lib/P-102__rev1__1.png", "image/png"],
    ["a DWG with a CAD MIME type", "org/lib/P-102__rev1__1.dwg", "image/vnd.dwg"],
    ["a non-PDF with no type recorded", "org/lib/P-102__rev1__1.dxf", null],
  ])("%s → not_pdf, incomplete", async (_what, file_url, file_type) => {
    withMember({ file_url, file_type });
    const r = await verify(true);
    expect(r.notPrintable).toEqual([{ label: "P-102", reason: "not_pdf" }]);
    expect(r.verdict).toBe("incomplete");
  });
  it("a current revision with NO file on record (file_url null), or no version row at all → no_file, incomplete", async () => {
    withMember({ file_url: null, file_type: "application/pdf" });
    let r = await verify(true);
    expect(r.notPrintable).toEqual([{ label: "P-102", reason: "no_file" }]);
    expect(r.verdict).toBe("incomplete");
    expect(allText(r)).toContain("(no current file)");
    withMember(null);
    r = await verify(true);
    expect(r.notPrintable).toEqual([{ label: "P-102", reason: "no_file" }]);
    expect(r.verdict).toBe("incomplete");
  });
  it("a PDF member a re-print WOULD carry stays notInPack and the pack red — by extension, by MIME type, or behind a signed URL's query string", async () => {
    for (const version of [
      { file_url: "org/lib/P-102__rev1__1.PDF", file_type: "application/octet-stream" },
      { file_url: "org/lib/P-102-no-extension", file_type: "application/pdf" },
      { file_url: "https://x.supabase.co/storage/v1/object/sign/docs/P-102.pdf?token=abc", file_type: null },
    ]) {
      state.liveMembers = [{ document_id: DOC, pinned_version_id: "v2", pinned_rev_label: "4" }];
      state.docs = [docRow()];
      withMember(version);
      const r = await verify(true);
      expect(r.notInPack, version.file_url).toEqual([{ label: "P-102" }]);
      expect(r.notPrintable).toEqual([]);
      expect(r.verdict).toBe("stale");
      expect(view(r).headline).toBe("PACK IS MISSING SHEETS");
      expect(view(r).bg).toBe("bg-red-600");
    }
  });
  it("a re-print that skips the non-PDF again still reads amber — the pack is never stuck on red", async () => {
    withMember({ file_url: "org/lib/P-102.dwg", file_type: null });
    expect((await verify(true)).verdict).toBe("incomplete");
    // a fresh print (new id, same skip) — same answer
    state.print = { ...printAt([sheetV2]), printed_at: "2026-09-30T00:00:00Z" };
    expect((await verify(true)).verdict).toBe("incomplete");
  });
  it("the file is read once, only for the sheets that pass every other refusal", async () => {
    state.print = printAt([sheetV2]);
    state.liveMembers.push({ document_id: DOC2, pinned_version_id: W2, pinned_rev_label: "1" });
    state.docs.push(docRow({ id: DOC2, document_number: "P-102", current_version_id: W2, rev: "1", status: "Draft" }));
    await verify(true);
    // a Draft member is refused before its file matters — no file read
    expect(state.selects.filter((x) => x.table === "document_versions" && x.cols.includes("file_url"))).toEqual([]);
    withMember({ file_url: "org/lib/P-102.pdf", file_type: "application/pdf" });
    state.docs = [docRow(), docRow({ id: DOC2, document_number: "P-102", current_version_id: W2, rev: "1" })];
    state.selects = [];
    await verify(true);
    expect(state.selects.filter((x) => x.table === "document_versions" && x.cols.includes("file_url"))).toEqual([
      { table: "document_versions", cols: "id, file_url, file_type" },
    ]);
  });
  it("a file read that ERRORS leaves the split unknown — 503 with an 'error' scan row, never a guess at red or amber", async () => {
    withMember({ file_url: "org/lib/P-102.dwg", file_type: null });
    state.selectErrors["document_versions|id, file_url, file_type"] = ""; // a transient failure, no code
    const res = await call(true);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.inserts.filter((i) => i.table === "verify_scans").map((i) => i.row.verdict)).toEqual(["error"]);
  });
  it("only a missing column (42703) on the file read retries with the path alone — and the retry is checked", async () => {
    withMember({ file_url: "org/lib/P-102.dwg", file_type: "application/pdf" });
    state.selectErrors["document_versions|id, file_url, file_type"] = "42703";
    const r = await verify(true);
    // file_type unread → judged by the path: a .dwg is not a PDF
    expect(r.notPrintable).toEqual([{ label: "P-102", reason: "not_pdf" }]);
    expect(state.selects.filter((x) => x.table === "document_versions" && x.cols.includes("file_url")).map((x) => x.cols)).toEqual([
      "id, file_url, file_type", "id, file_url",
    ]);
    state.selectErrors["document_versions|id, file_url"] = "";
    expect((await call(true)).status).toBe(503);
  });
  it("isPdfFile — the print gate's file rule (lib/knowledgeSourceSync.ts isPdf, plus a query string on an http URL)", () => {
    expect(isPdfFile("a/b/c.pdf", null)).toBe(true);
    expect(isPdfFile("a/b/C.PDF", "application/octet-stream")).toBe(true);
    expect(isPdfFile("a/b/c", "application/pdf")).toBe(true);
    expect(isPdfFile("https://h/x/c.pdf?token=1#p=2", null)).toBe(true);
    expect(isPdfFile("a/b/P&ID #3__revA__1.pdf", null)).toBe(true); // a '#' in a storage path is not a fragment
    expect(isPdfFile("a/b/c.dwg", null)).toBe(false);
    expect(isPdfFile("a/b/c.pdf.dwg", "application/octet-stream")).toBe(false);
    // a doubtful file leans to "a PDF" — a sheet a re-print would carry (the red side), never amber
    expect(isPdfFile("https://h/x/c.dwg?f=.pdf", null)).toBe(true);
  });
  it("isPdfFile (integration fix) — NOT a PDF only on positive evidence: a known non-PDF extension or a specific non-PDF MIME type", () => {
    // every listed non-PDF extension, untyped or generically typed, in either case, and on an http URL's path
    for (const ext of ["dwg", "dxf", "dgn", "xlsx", "xls", "docx", "doc", "png", "jpg", "jpeg", "tif", "tiff", "gif", "bmp", "zip"]) {
      expect(isPdfFile(`org/lib/P-102__rev1__1.${ext}`, null), ext).toBe(false);
      expect(isPdfFile(`org/lib/P-102__rev1__1.${ext.toUpperCase()}`, "application/octet-stream"), ext).toBe(false);
      expect(isPdfFile(`https://h/x/P-102.${ext}?token=1#p=2`, ""), ext).toBe(false);
    }
    // a specific non-PDF MIME type with no extension to go on
    for (const t of ["image/png", "image/vnd.dwg", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword", "application/zip", "application/x-dwg", "text/plain; charset=utf-8"]) {
      expect(isPdfFile("org/lib/P-102__rev1__1700000000000", t), t).toBe(false);
    }
    // NO positive evidence → a PDF (the red side): no recognisable extension and an empty, generic or absent type
    for (const t of [null, "", "application/octet-stream", "binary/octet-stream", "application/x-download"]) {
      expect(isPdfFile("org/lib/P-102__rev1__1700000000000", t), String(t)).toBe(true);
      expect(isPdfFile("org/lib/P-102__rev1__1.xyz", t), `xyz ${String(t)}`).toBe(true);
      expect(isPdfFile("https://h/x/download?id=1", t), `url ${String(t)}`).toBe(true);
    }
    expect(isPdfFile("org/lib.v2/P-102", null)).toBe(true); // a dot in a folder name is not an extension
    expect(isPdfFile(null, null)).toBe(true); // nothing to go on (the route asks only with a path: no path is "no current file")
    // PDF evidence still wins over a non-PDF signal
    expect(isPdfFile("org/lib/P-102.dwg", "application/pdf; charset=binary")).toBe(true);
    expect(isPdfFile("org/lib/P-102.pdf", "image/png")).toBe(true);
  });
  it("a member whose file has no recognisable extension and an empty or octet-stream type is read as a PDF — notInPack, red, never amber", async () => {
    for (const version of [
      { file_url: "org/lib/P-102__rev1__1700000000000", file_type: "application/octet-stream" },
      { file_url: "org/lib/P-102__rev1__1700000000000", file_type: "" },
      { file_url: "org/lib/P-102__rev1__1700000000000", file_type: null },
    ]) {
      state.liveMembers = [{ document_id: DOC, pinned_version_id: "v2", pinned_rev_label: "4" }];
      state.docs = [docRow()];
      withMember(version);
      const r = await verify(true);
      expect(r.notInPack, String(version.file_type)).toEqual([{ label: "P-102" }]);
      expect(r.notPrintable).toEqual([]);
      expect(r.verdict).toBe("stale");
    }
  });
});

describe("VFY-1 / PKG-8 — the shared allow-list decides every sheet", () => {
  it.each([["Void", "void"], ["Superseded", "superseded"], ["Archived", "archived"], ["Draft", "draft"], [null, "not_issued"], ["In Review", "not_issued"]])(
    "status %j at the printed (current) version → state %s, fresh false, never green", async (status, expected) => {
      state.print = printAt([sheetV2]);
      state.docs = [docRow({ status })];
      const r = await verify(true);
      expect(states(r)).toEqual([expected]);
      expect((r.sheets as Array<Record<string, unknown>>)[0].fresh).toBe(false);
      expect(r.allFresh).toBe(false);
    });
  it("Locked is in force", async () => {
    state.print = printAt([sheetV2]);
    state.docs = [docRow({ status: "Locked" })];
    expect((await verify(true)).verdict).toBe("current");
  });
  it.each(["IFC", "Approved", " Issued"])(
    "integration fix — a status the vocabulary does not know (%j) is 'status_unrecognised' on the pack page too — counted with the not-issued sheets, the verdict and its colour unchanged",
    async (status) => {
      state.print = printAt([sheetV2]);
      state.docs = [docRow({ status })];
      const r = await verify(true);
      expect(states(r)).toEqual(["status_unrecognised"]);
      expect((r.sheets as Array<Record<string, unknown>>)[0].fresh).toBe(false);
      expect(r.verdict).toBe("stale");
      expect(r.staleCount).toBe(1);
      expect(r.notIssuedCount).toBe(1);
      const v = presentPackVerdict(r as unknown as PackVerifyResult);
      expect(v.bg).toBe("bg-red-600");
      expect(v.headline).toBe("PACK HAS UNISSUED SHEETS");
    });
  it("integration fix — a package member left out for an unrecognised status is listed 'status not recognised' (amber, as before)", async () => {
    state.print = printAt([sheetV2]);
    state.liveMembers.push({ document_id: DOC2, pinned_version_id: "w1", pinned_rev_label: "1" });
    state.docs.push(docRow({ id: DOC2, document_number: "P-102", current_version_id: "w1", rev: "1", status: "IFC" }));
    const r = await verify(true);
    expect(r.notPrintable).toEqual([{ label: "P-102", reason: "status_unrecognised" }]);
    expect(r.verdict).toBe("incomplete");
    const v = presentPackVerdict(r as unknown as PackVerifyResult);
    expect(v.bg).toBe("bg-amber-500");
    expect(v.blurb).toContain("(status not recognised)");
    // In Review and an empty status are named by the vocabulary: still "not issued"
    state.docs = [docRow(), docRow({ id: DOC2, document_number: "P-102", current_version_id: "w1", rev: "1", status: "In Review" })];
    expect((await verify(true)).notPrintable).toEqual([{ label: "P-102", reason: "not_issued" }]);
  });
  it("a current revision whose effective date has not arrived → not_yet_effective, not green (PKG-8 done-when 3)", async () => {
    state.print = printAt([sheetV2]);
    state.versions = [{ id: "v2", effective_date: "2999-01-01" }];
    const r = await verify(true);
    expect(r.verdict).toBe("not_yet_effective");
    expect(states(r)).toEqual(["not_yet_effective"]);
  });
  it("an effective-date read that ERRORS is never green: 503, even with a pending date it could not see (VFY-4 / PKG-8 — late, never early)", async () => {
    state.print = printAt([sheetV2]);
    state.versions = [{ id: "v2", effective_date: "2999-01-01" }];
    state.errors.document_versions = true; // a transient PostgREST failure, no code
    const res = await call(true);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.inserts.filter((i) => i.table === "verify_scans").map((i) => i.row.verdict)).toEqual(["error"]);
  });
  it("only a missing COLUMN (42703 — a database with no effective dates at all) reads as 'no date'", async () => {
    state.print = printAt([sheetV2]);
    state.errors.document_versions = true;
    state.errorCodes.document_versions = "42703";
    const r = await verify(true);
    expect(r.verdict).toBe("current");
  });
  it("the route imports the shared decision and never spells a status list", () => {
    const src = readFileSync(join(process.cwd(), "app/api/verify-package/route.ts"), "utf8");
    expect(src).toContain('import { documentStanding, isPdfFile, isRecognisedStatus, isUndefinedColumnError } from "@/lib/verifyVerdict";');
    expect(src).not.toMatch(/status === "Superseded"|status === "Void"|status === "Archived"/);
  });
});

describe("HLD-3 / PHYS-1 / VFY-5 — a held sheet is marked with its own label and the pack is not green", () => {
  it("an active hold on a printed, current sheet → state held with the category, verdict held", async () => {
    state.print = printAt([sheetV2]);
    state.holds = [{ document_id: DOC, reason: "Client Review", released_at: null }, { document_id: DOC, reason: "secret operator words", released_at: null }];
    const r = await verify(true);
    expect(r.verdict).toBe("held");
    expect(r.heldCount).toBe(1);
    const s = (r.sheets as Array<Record<string, unknown>>)[0];
    expect(s.state).toBe("held");
    expect(s.holdReasons).toEqual(["Client Review", "On hold"]);
    expect(JSON.stringify(r)).not.toContain("secret operator words");
  });
  it("a released hold does not count", async () => {
    state.print = printAt([sheetV2]);
    state.holds = [{ document_id: DOC, reason: "Client Review", released_at: "2026-09-01T00:00:00Z" }];
    expect((await verify(true)).verdict).toBe("current");
  });
  it("legal hold on the document → held", async () => {
    state.print = printAt([sheetV2]);
    state.docs = [docRow({ legal_hold: true })];
    expect((await verify(true)).verdict).toBe("held");
  });
  it("an unreadable hold state FAILS CLOSED — every sheet held, never green", async () => {
    state.print = printAt([sheetV2]);
    state.errors.document_holds = true;
    const r = await verify(true);
    expect(r.verdict).toBe("held");
    expect(states(r)).toEqual(["held"]);
  });
});

describe("VFY-1 residual / VFY-11 — a not-issued sheet is not 'changed since printing'", () => {
  it("a just-printed pack with one legacy NO-STATUS sheet: counted as not issued, and the page never says it changed since printing", async () => {
    // PKG-4's print gate admits an empty-status legacy row; the verify allow-list does not.
    state.print = printAt([sheetV2, { documentId: DOC2, versionId: "w1", revLabel: "1", label: "P-102" }]);
    state.liveMembers.push({ document_id: DOC2, pinned_version_id: "w1", pinned_rev_label: "1" });
    state.docs.push(docRow({ id: DOC2, document_number: "P-102", current_version_id: "w1", rev: "1", status: "" }));
    const r = await verify(true);
    expect(r.verdict).toBe("stale");
    expect(states(r)).toEqual(["fresh", "not_issued"]);
    expect(r.staleCount).toBe(1);
    expect(r.notIssuedCount).toBe(1);
    const view = presentPackVerdict(r as unknown as PackVerifyResult);
    expect(view.ok).toBe(false);
    expect(view.headline).toBe("PACK HAS UNISSUED SHEETS");
    expect(view.blurb).toContain("1 of 2 sheets is not an issued, controlled revision");
    expect(view.blurb).not.toMatch(/changed or withdrawn|since this pack was printed/);
  });
  it("a voided sheet is still 'changed or withdrawn' (notIssuedCount 0)", async () => {
    state.print = printAt([sheetV2]);
    state.docs = [docRow({ status: "Void" })];
    const r = await verify(true);
    expect(r.notIssuedCount).toBe(0);
    expect(presentPackVerdict(r as unknown as PackVerifyResult).blurb).toContain("1 of 1 sheet changed or withdrawn since this pack was printed");
  });
});

describe("VFY-8 / VFY-11 — closed and empty packs have their own verdicts", () => {
  it("a CLOSED package whose sheets have not moved is 'closed', not green", async () => {
    state.print = printAt([sheetV2]);
    state.pkg = { ...state.pkg!, status: "closed", closed_at: "2026-09-01T00:00:00Z" };
    const r = await verify(true);
    expect(r.verdict).toBe("closed");
    expect(r.closed).toBe(true);
    expect(r.allFresh).toBe(false);
  });
  it("status 'closed' alone also closes it", async () => {
    state.print = printAt([sheetV2]);
    state.pkg = { ...state.pkg!, status: "closed" };
    expect((await verify(true)).verdict).toBe("closed");
  });
  it("an empty print and an empty legacy package are 'empty' — never the red '0 of 0' stale", async () => {
    state.print = printAt([]);
    state.liveMembers = [];
    let r = await verify(true);
    expect(r.verdict).toBe("empty");
    expect(r.sheetCount).toBe(0);
    r = await verify(false);
    expect(r.verdict).toBe("empty");
  });
});

describe("fail-closed reads, the scan record and no-store", () => {
  it.each([["documents"], ["work_package_documents"], ["work_package_prints"], ["work_packages"]])("a %s read error answers 503, never a verdict", async (table) => {
    state.print = printAt([sheetV2]);
    state.errors[table] = true;
    const res = await call(true);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("every answered scan writes one verify_scans row with the verdict; the answer is no-store", async () => {
    state.print = printAt([sheetV2]);
    const res = await call(true);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.inserts.filter((i) => i.table === "verify_scans").map((i) => i.row)).toEqual([
      { endpoint: "verify-package", target_id: PKG, printed_ref: PRINT, verdict: "current", ip: "unknown", user_agent: null },
    ]);
  });
  it("VFY-12: the scan row names WHICH printing was scanned (?print=), and a legacy cover QR names none", async () => {
    state.print = printAt([{ documentId: DOC, versionId: "v1", revLabel: "3", label: "P-101" }]);
    await call(true);
    await call(false);
    expect(state.inserts.filter((i) => i.table === "verify_scans").map((i) => [i.row.verdict, i.row.printed_ref])).toEqual([
      ["stale", PRINT],
      ["unconfirmed_print", null],
    ]);
  });
});

// ─── document-control Round F wave 2, P8 FIELD ─────────────────────────────

describe("VFY-17 — the pack print gate and the verify allow-list agree on an EMPTY status", () => {
  it("an empty-status document is refused at print (lib/docPack.ts filterPackDocs) and reads not_issued at verify (lib/verifyVerdict.ts documentStanding)", async () => {
    const { documentStanding } = await import("@/lib/verifyVerdict");
    vi.doMock("@/lib/supabase", () => ({ supabase: {} }));
    vi.doMock("@/lib/stamping", () => ({ applyStampToPdfDoc: vi.fn() }));
    vi.doMock("@/lib/intents", () => ({ recordIntent: vi.fn() }));
    const { filterPackDocs } = await import("@/lib/docPack");
    for (const status of ["", null, undefined]) {
      expect(documentStanding(status as string | null | undefined)).toBe("not_issued");
      const { docs, skipped } = filterPackDocs([{ id: DOC, document_number: "P-101", status }], new Set(), false);
      expect(docs).toEqual([]);
      expect(skipped).toEqual([{ documentId: DOC, label: "P-101", reason: "no status — not an issued, controlled revision", code: "not_issued" }]);
    }
    // and an in-force status passes both
    expect(documentStanding("Issued")).toBe("in_force");
    expect(filterPackDocs([{ id: DOC, status: "Issued" }], new Set(), false).docs).toHaveLength(1);
    // no parallel status list in the gate
    expect(readFileSync(join(process.cwd(), "lib/docPack.ts"), "utf8")).not.toMatch(/status !== "Issued"|status !== "Locked"/);
  });
  it("so a just-printed pack of a legacy empty-status sheet can no longer exist: the verify page reads it 'not issued' at the paper, and the gate never printed it", async () => {
    // the pre-VFY-17 world, for contrast: an empty-status sheet on paper reads not_issued (red)
    state.print = printAt([sheetV2]);
    state.docs = [docRow({ status: "" })];
    const r = await verify(true);
    expect(states(r)).toEqual(["not_issued"]);
    // from now on the gate refuses it, so a print records it as LEFT OUT, not as paper (VFY-19 below)
  });
});

describe("VFY-19 — the snapshot records what the print LEFT OUT, so a missing sheet says when it went missing", () => {
  const leftOut = (documentId: string, code: string, versionId: string | null = null) =>
    ({ documentId, versionId, revLabel: null, label: "x", printed: false, leftOutCode: code, leftOutReason: "free text the printer saw" });
  const printed = { ...sheetV2, printed: true };
  const member = (id: string, label: string, over: Record<string, unknown> = {}) => {
    state.liveMembers.push({ document_id: id, pinned_version_id: "w1", pinned_rev_label: "1" });
    state.docs.push(docRow({ id, document_number: label, current_version_id: "w1", rev: "1", ...over }));
  };
  const view = (r: Record<string, unknown>) => presentPackVerdict(r as unknown as PackVerifyResult);

  it("SKIPPED AT PRINT: a member the snapshot lists as left out (its file could not be fetched) is 'left out of this printing — <code>'; printable now, so the pack is red (a re-print carries it)", async () => {
    member(DOC2, "P-102");
    state.versions = [{ id: "w1", file_url: "org/lib/P-102.pdf", file_type: "application/pdf" }];
    state.print = printAt([printed, leftOut(DOC2, "fetch_failed", "w1")]);
    const r = await verify(true);
    expect(r.notInPack).toEqual([{ label: "P-102", leftOutAtPrint: "fetch_failed" }]);
    expect(r.verdict).toBe("stale");
    expect(states(r)).toEqual(["fresh"]); // the left-out entry is NOT treated as paper
    // the printer's free text is never published
    expect(JSON.stringify(r)).not.toContain("free text the printer saw");
  });

  it("SKIPPED AT PRINT for a reason that still holds (on hold) → amber 'incomplete' with the reason AND when", async () => {
    member(DOC2, "P-102");
    state.holds = [{ document_id: DOC2, reason: "Client Review", released_at: null }];
    state.print = printAt([printed, leftOut(DOC2, "on_hold")]);
    const r = await verify(true);
    expect(r.notPrintable).toEqual([{ label: "P-102", reason: "on_hold", leftOutAtPrint: "on_hold" }]);
    expect(r.verdict).toBe("incomplete");
  });

  it("a 'PDF' the print could not read keeps the route's own verdict — RED 'not in this pack', now saying when (fix pass 4: P8's amber rule is withdrawn; whether such a sheet may read amber is PS-VERIFY's verdict to make)", async () => {
    member(DOC2, "P-102");
    state.versions = [{ id: "w1", file_url: "org/lib/P-102.pdf", file_type: "application/pdf" }];
    state.print = printAt([printed, leftOut(DOC2, "unreadable_pdf", "w1")]);
    const r = await verify(true);
    expect(r.notPrintable).toEqual([]);
    expect(r.notInPack).toEqual([{ label: "P-102", leftOutAtPrint: "unreadable_pdf" }]);
    expect(r.verdict).toBe("stale");
    const { missingSheetWhen } = await import("@/lib/packLeftOut");
    expect(missingSheetWhen((r.notInPack as Array<{ leftOutAtPrint?: string }>)[0])).toBe("left out of this printing — its file could not be read as a PDF when printed");
    // P8 adds no verdict rule to this route: the snapshot only adds WHEN
    const route = readFileSync(join(process.cwd(), "app/api/verify-package/route.ts"), "utf8");
    expect(route).not.toMatch(/sameRevision/);
    expect(route).not.toMatch(/atPrint\?\.code === "(unreadable_pdf|too_large)"/);
    expect(route).not.toMatch(/reason = "too_large"/);
  });

  it("a sheet the print could not ADD (build_failed — e.g. a tablet out of memory merging a valid PDF) stays RED 'not in this pack': a re-print may carry it", async () => {
    member(DOC2, "P-102");
    state.versions = [{ id: "w1", file_url: "org/lib/P-102.pdf", file_type: "application/pdf" }];
    state.print = printAt([printed, leftOut(DOC2, "build_failed", "w1")]);
    const r = await verify(true);
    expect(r.notPrintable).toEqual([]);
    expect(r.notInPack).toEqual([{ label: "P-102", leftOutAtPrint: "build_failed" }]);
    expect(r.verdict).toBe("stale");
  });

  it("OUT OF MEMORY IN pdf-lib's LOAD (a large valid 300-page scan on a tablet) is build_failed at print, so the still-current sheet stays RED — never the amber 'a re-print would leave it out too' (fix pass 2)", async () => {
    vi.doMock("@/lib/supabase", () => ({ supabase: {} }));
    vi.doMock("@/lib/stamping", () => ({ applyStampToPdfDoc: vi.fn() }));
    vi.doMock("@/lib/intents", () => ({ recordIntent: vi.fn() }));
    const { packBuildFailureCode } = await import("@/lib/docPack");
    // the builder's classification of the two failures pdf-lib's load can raise
    const oom = packBuildFailureCode(new RangeError("Array buffer allocation failed"), { loaded: false, encrypted: false });
    expect(oom).toBe("build_failed");
    // a file that is not a PDF at all, refused by the REAL pdf-lib with its own parse error
    const { PDFDocument } = await import("pdf-lib");
    const parseErr = await PDFDocument.load(new TextEncoder().encode("PK\u0003\u0004 a zip, not a pdf")).then(() => null, (e: unknown) => e);
    expect(parseErr).not.toBeNull();
    expect(packBuildFailureCode(parseErr, { loaded: false, encrypted: false })).toBe("unreadable_pdf");
    // the out-of-memory sheet, still the current revision, scans RED (a desktop re-print carries it)
    member(DOC2, "P-102");
    state.versions = [{ id: "w1", file_url: "org/lib/P-102.pdf", file_type: "application/pdf" }];
    state.print = printAt([printed, leftOut(DOC2, oom, "w1")]);
    const r = await verify(true);
    expect(r.notPrintable).toEqual([]);
    expect(r.notInPack).toEqual([{ label: "P-102", leftOutAtPrint: "build_failed" }]);
    expect(r.verdict).toBe("stale");
  });

  it("too_large never reaches a print snapshot now (a work package's pack over the budget is REFUSED, naming the sheet — fix pass 4); its public words say 'get it separately', never that a copy rides along", async () => {
    // the only writer of `too_large` is a pack with no snapshot (the asset hub);
    // a work package's print throws PackSheetTooLargeError instead
    const docPack = readFileSync(join(process.cwd(), "lib/docPack.ts"), "utf8");
    expect(docPack).toContain('const leaveOutTooLarge = input.sheetTooLarge === "leave_out" && !input.buildCoverAfter;');
    expect(docPack).toContain("if (!leaveOutTooLarge) throw new PackSheetTooLargeError(documentId, label, why);");
    // an entry carrying it (none is written) reads as any other left-out sheet: red, with when — no verdict rule
    member(DOC2, "P-102");
    state.versions = [{ id: "w1", file_url: "org/lib/P-102.pdf", file_type: "application/pdf" }];
    state.print = printAt([printed, leftOut(DOC2, "too_large", "w1")]);
    const r = await verify(true);
    expect(r.notPrintable).toEqual([]);
    expect(r.notInPack).toEqual([{ label: "P-102", leftOutAtPrint: "too_large" }]);
    expect(r.verdict).toBe("stale");
    // the words the pack page appends (minor 3: "it is printed on its own" was untrue — nothing prints it)
    const { missingSheetWhen, packLeftOutText } = await import("@/lib/packLeftOut");
    expect(packLeftOutText("too_large")).toBe("too large for a field pack when printed — get it separately");
    expect(missingSheetWhen({ leftOutAtPrint: "too_large" })).toBe("left out of this printing — too large for a field pack when printed — get it separately");
    expect(missingSheetWhen({ leftOutAtPrint: "too_large" })).not.toMatch(/printed on its own/);
    // the presenter has no too_large reason (P8's fix-pass-3 addition is withdrawn with the route rule)
    expect(readFileSync(join(process.cwd(), "lib/verifyPresent.ts"), "utf8")).not.toContain("too_large");
    expect(notPrintableText("not_pdf")).toBe("not a printable PDF");
  });

  it("ADDED SINCE: a member the snapshot neither printed nor left out joined after this printing", async () => {
    member(DOC3, "P-103");
    state.versions = [{ id: "w1", file_url: "org/lib/P-103.pdf", file_type: "application/pdf" }];
    state.print = printAt([printed]); // a VFY-19 snapshot (marker present) with nothing left out
    const r = await verify(true);
    expect(r.notInPack).toEqual([{ label: "P-103", addedSincePrint: true }]);
    expect(r.verdict).toBe("stale");
    // a not-printable member added since says so too
    state.liveMembers = [{ document_id: DOC, pinned_version_id: "v2", pinned_rev_label: "4" }];
    state.docs = [docRow()];
    member(DOC3, "P-103", { status: "Draft" });
    const r2 = await verify(true);
    expect(r2.notPrintable).toEqual([{ label: "P-103", reason: "not_issued", addedSincePrint: true }]);
  });

  it("PRE-CHANGE snapshot (no marker): the present-tense split alone — no 'when' field, nothing says 'added since'", async () => {
    member(DOC2, "P-102", { status: "Draft" });
    member(DOC3, "P-103");
    state.versions = [{ id: "w1", file_url: "org/lib/P-103.pdf", file_type: "application/pdf" }];
    state.print = printAt([sheetV2]); // no `printed` key anywhere
    const r = await verify(true);
    expect(r.notInPack).toEqual([{ label: "P-103" }]);
    expect(r.notPrintable).toEqual([{ label: "P-102", reason: "not_issued" }]);
    for (const x of [...(r.notInPack as Array<Record<string, unknown>>), ...(r.notPrintable as Array<Record<string, unknown>>)]) {
      expect(x).not.toHaveProperty("addedSincePrint");
      expect(x).not.toHaveProperty("leftOutAtPrint");
    }
    const v = view(r);
    expect(`${v.headline} ${v.blurb} ${v.advice ?? ""}`).not.toMatch(/added/i);
  });

  it("the pack page's words for WHEN (lib/packLeftOut.ts missingSheetWhen)", async () => {
    const { missingSheetWhen, packLeftOutText } = await import("@/lib/packLeftOut");
    expect(missingSheetWhen({})).toBeNull();
    expect(missingSheetWhen({ addedSincePrint: true })).toBe("added since this pack was printed");
    expect(missingSheetWhen({ leftOutAtPrint: "fetch_failed" })).toBe("left out of this printing — its file could not be fetched when printed");
    expect(missingSheetWhen({ leftOutAtPrint: "left_out" })).toBe("left out of this printing");
    expect(packLeftOutText("nonsense")).toBe("left out of this printing");
  });
});
