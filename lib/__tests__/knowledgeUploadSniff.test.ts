// intelligence Round G, I-02b (2026-10-01) — ING-9's browser-side check
// (lib/knowledge.ts pdfUploadRefusal) is the ingest engine's own rule, run
// before upload. The engine's sniffBytes / notPdfMessage live in a
// server-only module the page cannot import, so the browser carries a copy;
// this pins the copy to the engine, byte for byte and word for word, and
// pins what the browser refuses to what the engine refuses BEFORE pdf.js
// (another format's signature) — never a head the engine lets pdf.js try.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }));

import { sniffBytes, notPdfMessage } from "@/lib/knowledgeIngest";
import { sniffUploadHead, notPdfUploadMessage, pdfUploadRefusal } from "@/lib/knowledge";

const enc = (s: string) => new TextEncoder().encode(s);
const pad = (head: number[], n = 64) => new Uint8Array([...head, ...Array.from({ length: n }, (_, i) => (i * 37) % 256)]);
const FIXTURES: Array<[string, Uint8Array]> = [
  ["pdf", enc("%PDF-1.7\n%âãÏÓ\n1 0 obj")],
  ["pdf behind junk in the first KB", enc("﻿junk%PDF-1.4\n")],
  ["xlsx / docx (ZIP)", pad([0x50, 0x4b, 0x03, 0x04])],
  ["xls / doc (OLE)", pad([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
  ["png", pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ["jpeg", pad([0xff, 0xd8, 0xff, 0xe0])],
  ["tiff (little-endian)", pad([0x49, 0x49, 0x2a, 0x00])],
  ["tiff (big-endian)", pad([0x4d, 0x4d, 0x00, 0x2a])],
  ["csv", enc("Tag,Description,Unit\nP-101A,Charge pump,20\n")],
  ["a long preamble (no header in the first KB)", enc("X-Scanner: preamble\n".repeat(80))],
  ["binary noise", new Uint8Array(Array.from({ length: 512 }, (_, i) => (i * 7) % 32))],
  ["empty", new Uint8Array(0)],
];

describe("ING-9 — the browser's copy of the engine's rule", () => {
  it("classifies every fixture exactly as the engine does", () => {
    for (const [what, head] of FIXTURES) expect(sniffUploadHead(head), what).toBe(sniffBytes(head));
  });

  it("words every refusal exactly as the engine does", () => {
    for (const kind of ["office", "text", "image", "unknown", "pdf"] as const) {
      expect(notPdfUploadMessage("equipment-list.pdf", kind)).toBe(notPdfMessage("equipment-list.pdf", kind));
    }
  });

  it("refuses a .pdf before upload only where the engine refuses before pdf.js: another format's signature", () => {
    for (const [what, head] of FIXTURES) {
      const kind = sniffBytes(head);
      const refusal = pdfUploadRefusal("upload.pdf", head);
      if (kind === "office" || kind === "image") expect(refusal, what).toBe(notPdfMessage("upload.pdf", kind));
      else expect(refusal, what).toBeNull();
    }
    expect(pdfUploadRefusal("upload.pdf", null)).toBeNull();
  });

  it("a name without .pdf is refused, as it always was — now naming where the file belongs", () => {
    expect(pdfUploadRefusal("equipment-list.xlsx", null)).toBe(notPdfMessage("equipment-list.xlsx", "office"));
    expect(pdfUploadRefusal("tags.csv", null)).toBe(notPdfMessage("tags.csv", "text"));
    expect(pdfUploadRefusal("photo.JPG", null)).toBe(notPdfMessage("photo.JPG", "image"));
    expect(pdfUploadRefusal("notes.rtf", null)).toBe(notPdfMessage("notes.rtf", "unknown"));
    expect(pdfUploadRefusal("noext", pad([0x50, 0x4b, 0x03, 0x04]))).toBe(notPdfMessage("noext", "office"));
    expect(pdfUploadRefusal("scan.pdf.download", enc("%PDF-1.7\n")))
      .toBe('"scan.pdf.download" is a PDF without the .pdf ending — rename it to end in .pdf, then add it again.');
  });
});
