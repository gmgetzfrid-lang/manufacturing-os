// @vitest-environment jsdom
//
// public-surfaces PS-P9 — the integrator's ruling (3) at the PS-P9 merge
// (2026-10-20, DEC-90): the two other printed multi-sheet packs, the linked
// drawings' "Print all" (components/assets/FileReferenceModal.tsx) and the
// collection book's "Print all" (components/viewers/MultiDocViewer.tsx, its
// print and its download), go through mintSheetTokens / settleSheetTokens
// exactly as lib/docPack.ts buildAndDownloadDocPack does — AS RENDERED:
//
//   - minted: each sheet's QR is <origin>/verify/<token>, never its document
//     UUID; the mint names the workspace and each sheet's current version and
//     happens before the first sheet is stamped; once the pack has left (the
//     print tab is open / the download clicked) and its record is written,
//     the print is settled with exactly the sheets in the PDF — fired, never
//     awaited (a settle that never answers holds nothing back);
//   - nothing left (the print tab blocked, a failure): the whole print is
//     voided (an empty list);
//   - REGRESSION / fail-safe: when no token is minted (the table absent, the
//     mint failed — mintSheetTokens null) every sheet carries today's
//     /verify/<document>?v=<version> QR, nothing is settled and the pack
//     prints / downloads and is recorded exactly as before; no public origin
//     → no mint and no QR, as before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  origin: "https://app.example.com",
  log: [] as string[],
  stamps: [] as Array<{ url: string; verifyUrl?: string }>,
  /** the n-th stamp (1-based) of a print fails as an unreadable file */
  failNth: 0,
  stampN: 0,
  mint: "ok" as "ok" | "null",
  settleHangs: false,
  popupBlocked: false,
  mintCalls: [] as Array<{ orgId: string; sheets: Array<{ documentId: string; versionId: string }> }>,
  settleCalls: [] as Array<{ orgId: string; printId: string; printedDocumentIds: string[] }>,
  tokens: new Map<string, string>(),
}));

vi.mock("react-pdf", () => ({ Document: () => null, Page: () => null, pdfjs: { GlobalWorkerOptions: {} } }));
vi.mock("@/lib/pdfjsConfig", () => ({ PDF_DOC_OPTIONS: {} }));
vi.mock("fabric", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("pdf-lib", () => {
  const doc = () => {
    let pages = 0;
    return {
      copyPages: async () => ["page"],
      addPage: () => { pages += 1; },
      insertPage: () => { pages += 1; },
      getPageIndices: () => [0],
      getPageCount: () => pages || 0,
      save: async () => new Uint8Array([1]),
    };
  };
  return { PDFDocument: { create: async () => doc(), load: async () => ({ ...doc(), getPageCount: () => 1 }) } };
});
vi.mock("@/lib/supabase", () => {
  function chain(table: string) {
    const c: Record<string, unknown> = {};
    const result = () => {
      if (table === "document_versions") return { data: { file_url: "https://files/x.pdf" }, error: null };
      return { data: [], error: null };
    };
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result());
        if (prop === "maybeSingle" || prop === "single") return async () => result();
        if (prop === "insert") return () => { s.log.push(`insert:${table}`); return new Proxy(c, handler); };
        return () => new Proxy(c, handler);
      },
    };
    return new Proxy(c, handler);
  }
  return {
    supabase: {
      from: (t: string) => chain(t),
      auth: { getSession: async () => ({ data: { session: { access_token: "jwt", user: { email: "jane@example.com" } } } }) },
    },
  };
});
vi.mock("@/lib/stamping", () => ({
  stampPdf: vi.fn(async (url: string, opts: { verifyUrl?: string }) => {
    s.log.push("stamp");
    s.stamps.push({ url, verifyUrl: opts.verifyUrl });
    s.stampN += 1;
    if (s.stampN === s.failNth) throw new Error("unreadable");
    return { arrayBuffer: async () => new ArrayBuffer(4) };
  }),
}));
vi.mock("@/lib/publicOrigin", () => ({ publicOrigin: () => s.origin }));
vi.mock("@/lib/intents", () => ({ recordIntent: vi.fn(async () => {}) }));
vi.mock("@/lib/storage", () => ({ resolveFileUrl: async (u: string) => u }));
vi.mock("@/lib/printSheetTokensClient", () => ({
  SHEET_TOKEN_FETCH_TIMEOUT_MS: 8000,
  mintSheetTokens: vi.fn(async (input: { orgId: string; sheets: Array<{ documentId: string; versionId: string }> }) => {
    s.log.push("mint");
    s.mintCalls.push(input);
    if (s.mint === "null") return null;
    return { printId: "print-1", tokens: new Map(s.tokens) };
  }),
  settleSheetTokens: vi.fn((input: { orgId: string; printId: string; printedDocumentIds: string[] }) => {
    s.log.push("settle");
    s.settleCalls.push(input);
    return s.settleHangs ? new Promise<boolean>(() => {}) : Promise.resolve(true);
  }),
}));
vi.mock("@/lib/assets", () => ({
  getAssetByTag: vi.fn(async () => ({ id: "a1" })),
  listAssetFiles: vi.fn(async () => LINKED.map((document, i) => ({ id: `f${i}`, document }))),
  createAsset: vi.fn(),
  linkAssetFile: vi.fn(),
  unlinkAssetFile: vi.fn(),
}));
vi.mock("@/components/documents/DocumentLinkPicker", () => ({ default: () => null }));
vi.mock("@/components/documents/BulkCheckoutToProjectModal", () => ({ default: () => null }));
vi.mock("@/components/assets/EquipmentTagsStrip", () => ({ default: () => null }));
vi.mock("@/lib/markupExport", () => ({ bakeMarkupIntoPdf: vi.fn() }));
vi.mock("@/lib/draftHandoff", () => ({ stashDraft: vi.fn() }));
vi.mock("@/components/providers/DialogProvider", () => ({ appAlert: vi.fn(async () => { s.log.push("alert"); }) }));
vi.mock("@/lib/downloads", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/downloads")>();
  return {
    ...actual,
    ackGateDocuments: vi.fn(async () => ({ gated: new Set<string>(), unknown: new Set<string>() })),
    readCopyHoldState: vi.fn(async () => ({ blocked: false, holds: [] })),
    holdFooterLine: () => null,
  };
});

const D1 = "d1d1d1d1-0000-0000-0000-000000000001";
const D2 = "d2d2d2d2-0000-0000-0000-000000000002";
const V1 = "e1e1e1e1-0000-0000-0000-000000000001";
const V2 = "e2e2e2e2-0000-0000-0000-000000000002";
const T1 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1";
const T2 = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2";
const LINKED = [
  { id: D1, document_number: "P-101", title: null, name: null, library_id: null, current_version_id: V1, rev: "3" },
  { id: D2, document_number: "P-102", title: null, name: null, library_id: null, current_version_id: V2, rev: "1" },
];

import FileReferenceModal from "@/components/assets/FileReferenceModal";
import MultiDocViewer from "@/components/viewers/MultiDocViewer";
import type { DocumentRecord } from "@/types/schema";

const BOOK = [
  { id: D1, orgId: "org1", documentNumber: "P-101", title: "Pump", rev: "3", currentVersionId: V1, status: "Issued", metadata: {} },
  { id: D2, orgId: "org1", documentNumber: "P-102", title: "Valve", rev: "1", currentVersionId: V2, status: "Issued", metadata: {} },
] as unknown as DocumentRecord[];

let host: HTMLDivElement;
let root: Root;
const flush = async () => { for (let i = 0; i < 15; i++) await act(async () => { await Promise.resolve(); }); };
const render = async (el: React.ReactElement) => { await act(async () => { root.render(el); }); await flush(); };
const click = async (el: Element | null | undefined) => {
  expect(el, "the control to click").toBeTruthy();
  await act(async () => { (el as HTMLElement).click(); });
  await flush();
};
const buttonByText = (re: RegExp) => [...host.querySelectorAll("button")].find((b) => re.test(b.textContent ?? ""));
const buttonByTitle = (t: string) => host.querySelector(`button[title="${t}"]`);
const todayQr = (d: string, v: string) => `https://app.example.com/verify/${d}?v=${v}`;
const tokenQr = (t: string) => `https://app.example.com/verify/${t}`;

beforeEach(() => {
  s.origin = "https://app.example.com";
  s.log = [];
  s.stamps = [];
  s.failNth = 0;
  s.stampN = 0;
  s.mint = "ok";
  s.settleHangs = false;
  s.popupBlocked = false;
  s.mintCalls = [];
  s.settleCalls = [];
  s.tokens = new Map([[D1, T1], [D2, T2]]);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: () => { s.log.push("blob"); return "blob:pack"; } });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: () => {} });
  vi.spyOn(window, "open").mockImplementation(() => {
    s.log.push("open");
    return s.popupBlocked ? null : ({ addEventListener: () => {}, print: () => {} } as unknown as Window);
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => { s.log.push("click"); });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const printLinked = async () => {
  await render(React.createElement(FileReferenceModal, { tag: "CKT-1", orgId: "org1", userId: "u1", onClose: () => {} }));
  await click(buttonByText(/Print all \(2\)/));
};

describe("PS-P9 — the linked drawings' 'Print all' (FileReferenceModal) names each sheet by its per-print token", () => {
  it("one mint before the first stamp, each sheet's QR its token, settled with the sheets in the PDF after the tab opened and the record was written", async () => {
    await printLinked();
    expect(s.mintCalls).toEqual([{ orgId: "org1", sheets: [{ documentId: D1, versionId: V1 }, { documentId: D2, versionId: V2 }] }]);
    expect(s.stamps.map((x) => x.verifyUrl)).toEqual([tokenQr(T1), tokenQr(T2)]);
    for (const x of s.stamps) expect(x.verifyUrl).not.toContain(D1);
    expect(s.settleCalls).toEqual([{ orgId: "org1", printId: "print-1", printedDocumentIds: [D1, D2] }]);
    expect(s.log).toEqual(["mint", "stamp", "stamp", "blob", "open", "insert:download_audits", "settle"]);
  });

  it("a sheet the server did not mint keeps today's QR; a sheet that failed to stamp is not reported printed (its token is voided)", async () => {
    s.tokens = new Map([[D1, T1]]);
    await printLinked();
    expect(s.stamps.map((x) => x.verifyUrl)).toEqual([tokenQr(T1), todayQr(D2, V2)]);
    s.log = []; s.stamps = []; s.settleCalls = []; s.mintCalls = [];
    s.tokens = new Map([[D1, T1], [D2, T2]]);
    s.stampN = 0;
    s.failNth = 2;
    await click(buttonByText(/Print all \(2\)/));
    expect(s.settleCalls.map((c) => c.printedDocumentIds)).toEqual([[D1]]);
  });

  it("the print tab blocked: nothing left — the whole print is voided (an empty list), the person is told as before", async () => {
    s.popupBlocked = true;
    await printLinked();
    expect(s.settleCalls.map((c) => c.printedDocumentIds)).toEqual([[]]);
    expect(s.log).toContain("alert");
    expect(s.log).not.toContain("insert:download_audits");
  });

  it("a settle that never answers holds nothing back: the record is written and the button is free again", async () => {
    s.settleHangs = true;
    await printLinked();
    expect(s.log).toEqual(["mint", "stamp", "stamp", "blob", "open", "insert:download_audits", "settle"]);
    expect((buttonByText(/Print all \(2\)/) as HTMLButtonElement).disabled).toBe(false);
  });

  it("REGRESSION — no token minted (the table absent, the mint failed): every sheet carries today's QR, nothing is settled, the pack prints and is recorded as before", async () => {
    s.mint = "null";
    await printLinked();
    expect(s.stamps.map((x) => x.verifyUrl)).toEqual([todayQr(D1, V1), todayQr(D2, V2)]);
    expect(s.settleCalls).toEqual([]);
    expect(s.log).toEqual(["mint", "stamp", "stamp", "blob", "open", "insert:download_audits"]);
  });

  it("REGRESSION — no public origin: no mint, no QR, as before", async () => {
    s.origin = "";
    await printLinked();
    expect(s.mintCalls).toEqual([]);
    expect(s.stamps.map((x) => x.verifyUrl)).toEqual([undefined, undefined]);
    expect(s.settleCalls).toEqual([]);
  });
});

const bookAction = async (kind: "print" | "download") => {
  await render(React.createElement(MultiDocViewer, { docs: BOOK, onClose: () => {}, currentUserId: "u1", currentUserEmail: "jane@example.com", orgId: "org1" }));
  await click(buttonByTitle(kind === "print" ? "Print an uncontrolled (stamped) copy" : "Download an uncontrolled (stamped) copy"));
  await click(buttonByTitle(kind === "print"
    ? "Merge the whole collection into one stamped, uncontrolled PDF and print"
    : "Merge the whole collection into one stamped, uncontrolled PDF"));
  await click(buttonByText(kind === "print" ? /Print stamped book/ : /Download stamped book/));
};

describe("PS-P9 — the collection book's 'Print all' (MultiDocViewer) names each sheet by its per-print token", () => {
  for (const kind of ["print", "download"] as const) {
    it(`${kind}: one mint for the book's workspace before the first stamp, each sheet's QR its token, settled with the sheets in the PDF once the book left (after its record)`, async () => {
      await bookAction(kind);
      expect(s.mintCalls).toEqual([{ orgId: "org1", sheets: [{ documentId: D1, versionId: V1 }, { documentId: D2, versionId: V2 }] }]);
      expect(s.stamps.map((x) => x.verifyUrl)).toEqual([tokenQr(T1), tokenQr(T2)]);
      expect(s.settleCalls).toEqual([{ orgId: "org1", printId: "print-1", printedDocumentIds: [D1, D2] }]);
      const left = kind === "print" ? "open" : "click";
      expect(s.log.filter((x) => ["mint", "stamp", "insert:download_audits", left, "settle"].includes(x)))
        .toEqual(["mint", "stamp", "stamp", "insert:download_audits", left, "settle"]);
    });

    it(`${kind} REGRESSION — no token minted: today's QR on every sheet, nothing settled, the book ${kind === "print" ? "prints" : "downloads"} and is recorded as before`, async () => {
      s.mint = "null";
      await bookAction(kind);
      expect(s.stamps.map((x) => x.verifyUrl)).toEqual([todayQr(D1, V1), todayQr(D2, V2)]);
      expect(s.settleCalls).toEqual([]);
      expect(s.log).toContain("insert:download_audits");
      expect(s.log).toContain(kind === "print" ? "open" : "click");
    });
  }

  it("the print tab blocked: the book never left — the whole print is voided (an empty list)", async () => {
    s.popupBlocked = true;
    await bookAction("print");
    expect(s.settleCalls.map((c) => c.printedDocumentIds)).toEqual([[]]);
  });

  it("a settle that never answers holds nothing back: the book is delivered and its busy state clears", async () => {
    s.settleHangs = true;
    await bookAction("download");
    expect(s.log).toContain("click");
    expect(s.settleCalls).toHaveLength(1);
    // the confirm dialog closed (a delivered book), and the menu is usable again
    expect(buttonByText(/Download stamped book/)).toBeUndefined();
    await click(buttonByTitle("Download an uncontrolled (stamped) copy"));
    expect((buttonByTitle("Merge the whole collection into one stamped, uncontrolled PDF") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a book spanning two workspaces mints nothing (today's QR on every sheet) — the print is never refused", async () => {
    const mixed = [BOOK[0], { ...BOOK[1], orgId: "org2" }] as unknown as DocumentRecord[];
    await render(React.createElement(MultiDocViewer, { docs: mixed, onClose: () => {}, currentUserId: "u1", currentUserEmail: "jane@example.com", orgId: "org1" }));
    await click(buttonByTitle("Download an uncontrolled (stamped) copy"));
    await click(buttonByTitle("Merge the whole collection into one stamped, uncontrolled PDF"));
    await click(buttonByText(/Download stamped book/));
    expect(s.mintCalls).toEqual([]);
    expect(s.stamps.map((x) => x.verifyUrl)).toEqual([todayQr(D1, V1), todayQr(D2, V2)]);
    expect(s.log).toContain("click");
  });

  it("REGRESSION — no public origin: no mint, no QR, as before", async () => {
    s.origin = "";
    await bookAction("download");
    expect(s.mintCalls).toEqual([]);
    expect(s.stamps.map((x) => x.verifyUrl)).toEqual([undefined, undefined]);
  });
});
