// @vitest-environment jsdom
//
// intelligence Round G, I-29 — the integrator's DEC-90 ruling (2) at the I-29
// merge (2026-10-20), driven as rendered: inside ONE CitedPageViewer mount a
// source-linked mirror's signed URL is remembered by (documentId, revision)
// for at most the granted window, so a carousel step back does not re-sign
// (and does not re-record a controller's DEC-43 bypass read), a re-pointed
// mirror (a new revision) always re-signs, and a fresh mount re-signs. A
// direct upload opens through getSignedUrlForPath exactly as before.
//
// The PDF renderer and the data layer are mocked; the memory itself
// (lib/knowledgeMirrorUrlMemo) runs for real, and its behaviour against the
// real /api/knowledge/mirror-url is pinned in intelRoundGMirrorViewerKeys.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  /** documentId → the revision the route would sign now. */
  current: {} as Record<string, string>,
  mirrorCalls: [] as string[],
  uploadCalls: [] as Array<[string, unknown, unknown]>,
}));

vi.mock("react-pdf", () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("react-pdf/dist/Page/AnnotationLayer.css", () => ({}));
vi.mock("react-pdf/dist/Page/TextLayer.css", () => ({}));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/storage", () => ({
  getSignedUrlForPath: vi.fn(async (key: string, a: unknown, b: unknown) => { s.uploadCalls.push([key, a, b]); return `https://signed.example/${key}`; }),
}));
vi.mock("@/lib/knowledge", () => ({
  locateTagsOnPage: vi.fn(async () => ({ positions: [], notOnPage: [], elsewhere: [] })),
  requestKnowledgeMirrorUrl: vi.fn(async (id: string) => {
    s.mirrorCalls.push(id);
    return { url: `https://signed.example/${id}/${s.current[id]}`, expiresIn: 3600, sourceVersionId: s.current[id], sourceRev: null };
  }),
}));

import CitedPageViewer, { type CitedSource } from "@/components/knowledge/CitedPageViewer";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no ResizeObserver (the viewer's fit-to-width measure).
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function render(sources: CitedSource[]) {
  if (!host) { host = document.createElement("div"); document.body.appendChild(host); }
  if (!root) root = createRoot(host);
  const first = sources[0];
  await act(async () => {
    root!.render(React.createElement(CitedPageViewer, {
      fileKey: first.fileKey, page: first.page, quote: first.quote, title: first.title, documentId: first.documentId,
      sources, initialIndex: 0, onClose: () => undefined,
    }));
  });
  await flush();
}
async function unmount() {
  await act(async () => { root?.unmount(); });
  root = null;
}
async function click(label: string) {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
  if (!btn) throw new Error(`no button ${label}`);
  await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const src = (documentId: string, sourceVersionId: string | null, n: number): CitedSource => ({
  fileKey: null, page: 1, quote: null, title: `Doc ${n}.pdf`, documentId, sourceVersionId, sourceRev: null, n,
});
const UPLOAD: CitedSource = { fileKey: "orgs/o1/knowledge/kl/manual.pdf", page: 2, quote: null, title: "manual.pdf", documentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", n: 3 };

beforeEach(() => {
  s.current = { [A]: "vA1", [B]: "vB1" };
  s.mirrorCalls = [];
  s.uploadCalls = [];
});
afterEach(async () => { await unmount(); });

describe("I-29 merge, DEC-90 ruling (2) — the viewer's mirror URL memory is per mount and per revision", () => {
  it("reproduction → fix: stepping the carousel to another source and back does not re-sign the first (the fix pass re-signed on every step)", async () => {
    await render([src(A, "vA1", 1), src(B, "vB1", 2)]);
    expect(s.mirrorCalls).toEqual([A]);
    await click("Next source");
    expect(s.mirrorCalls).toEqual([A, B]);
    await click("Previous source");
    await click("Next source");
    expect(s.mirrorCalls).toEqual([A, B]);
  });
  it("a changed revision re-signs within the same mount (the page re-listed a re-pointed mirror)", async () => {
    await render([src(A, "vA1", 1), src(B, "vB1", 2)]);
    s.current[A] = "vA2";
    await render([src(A, "vA2", 1), src(B, "vB1", 2)]);
    expect(s.mirrorCalls).toEqual([A, A]);
    // and the new revision's URL is the one shown (open in a new tab)
    const link = [...document.querySelectorAll("a")].find((a) => a.getAttribute("href")?.includes(A));
    expect(link?.getAttribute("href")).toBe(`https://signed.example/${A}/vA2#page=1`);
  });
  it("a fresh mount re-signs", async () => {
    await render([src(A, "vA1", 1), src(B, "vB1", 2)]);
    await unmount();
    await render([src(A, "vA1", 1), src(B, "vB1", 2)]);
    expect(s.mirrorCalls).toEqual([A, A]);
  });
  it("no revision known: every open asks (never remembered by document id alone)", async () => {
    await render([src(A, null, 1), src(B, null, 2)]);
    await click("Next source");
    await click("Previous source");
    expect(s.mirrorCalls).toEqual([A, B, A]);
  });
  it("regression: a direct upload opens through getSignedUrlForPath(key, undefined, { inline: true }) exactly as before", async () => {
    await render([src(A, "vA1", 1), UPLOAD]);
    await click("Next source");
    expect(s.uploadCalls).toEqual([[UPLOAD.fileKey, undefined, { inline: true }]]);
    expect(s.mirrorCalls).toEqual([A]);
  });
});
