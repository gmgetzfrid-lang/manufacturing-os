// public-surfaces Round G, PS-P7 STAMP TEXT ENCODING (PHYS-15) — the
// regression harness: what the stamp DRAWS for text in characters its font
// prints as typed (plain ASCII, Latin-1, and cp1252's dashes, curly quotes,
// bullet and ellipsis), on every caller's text, captured draw call by draw
// call and as the saved PDF's bytes.
//
// `psP7StampPlain.golden.json` was recorded by this harness on b154823 — the
// stamp before PS-P7 — and lib/__tests__/psP7StampText.test.ts compares the
// stamp of today against it: a plain-text stamp is byte-identical.
// (Re-record only on purpose: PS_P7_WRITE_GOLDEN=1 npx vitest run psP7StampText.)

import { createHash } from "node:crypto";
import { vi } from "vitest";
import { PDFDocument, PDFPage, degrees } from "pdf-lib";
import { applyStampToPdfDoc, type StampOptions } from "@/lib/stamping";
import { shareFooterNotice } from "@/lib/shareServe";
import { buildFooterNotice, copyWatermark, holdFooterLine } from "@/lib/downloads";
import { portalStampText } from "@/lib/transmittals";
import type { DocumentRecord } from "@/types/schema";

const VERIFY = "https://app.example.com/verify/d1?v=v1";
const doc = (over: Partial<DocumentRecord> = {}): DocumentRecord =>
  ({ id: "d1", orgId: "o1", libraryId: "l1", documentNumber: "P-101", rev: "B", currentVersionId: "v1", ...over } as DocumentRecord);
const held = { blocked: true, holds: [{ reason: "Safety" }, { reason: "Engineering" }] };

/** Each caller's stamp, as it builds it, with text the font prints as typed. */
export const PLAIN_CASES: Array<{ name: string; page: [number, number]; rotate?: number; opts: StampOptions }> = [
  {
    name: "share link (app/api/share/file/route.ts)",
    page: [1224, 792],
    opts: {
      userLabel: "shared-link", timestamp: new Date(0), watermarkText: "UNCONTROLLED — SHARED COPY",
      footerNotice: shareFooterNotice({ label: "P-101", rev: "B", status: "Issued", verifyUrl: VERIFY }), verifyUrl: VERIFY,
    },
  },
  {
    name: "in-app download (lib/downloads.ts), current revision",
    page: [595, 842],
    opts: {
      userLabel: "Jane Doe", email: "jane@example.com", timestamp: new Date(0), expiresAt: new Date(86_400_000),
      watermarkText: copyWatermark({ versionIsCurrent: true }, null),
      footerNotice: buildFooterNotice({ doc: doc({ checkedOutBy: "u2", checkedOutByName: "José Núñez" }), fileUrl: "x", userId: "u1", versionIsCurrent: true }),
      verifyUrl: VERIFY,
    },
  },
  {
    name: "in-app download (lib/downloads.ts), older revision of a held document",
    page: [1224, 792],
    rotate: 90,
    opts: {
      userLabel: "Jane Doe", email: "jane@example.com", timestamp: new Date(0), expiresAt: new Date(86_400_000),
      watermarkText: copyWatermark({ versionIsCurrent: false }, held),
      footerNotice: buildFooterNotice({ doc: doc(), fileUrl: "x", userId: "u1", versionIsCurrent: false, versionRev: "A" }, held),
      verifyUrl: VERIFY,
    },
  },
  {
    name: "field pack (lib/docPack.ts)",
    page: [2384, 1684],
    opts: {
      userLabel: "jane", email: "jane@example.com", timestamp: new Date(0), watermarkText: "UNCONTROLLED — FIELD PACK",
      footerNotice: "P–101 Rev “A” at time of issue — verify current revision before use. ACTIVE CHANGE IN PROGRESS: checked out by Zoë at time of issue.",
      verifyUrl: VERIFY,
    },
  },
  {
    name: "book (components/viewers/MultiDocViewer.tsx), a held sheet",
    page: [1224, 792],
    opts: {
      userLabel: "jane@example.com", email: "jane@example.com", timestamp: new Date(0), expiresAt: new Date(86_400_000),
      watermarkText: copyWatermark({ versionIsCurrent: true }, held),
      footerNotice: `${holdFooterLine(held)} P-101 Rev B at time of issue — verify current revision before use.`,
      verifyUrl: VERIFY,
    },
  },
  {
    name: "linked drawings (components/assets/FileReferenceModal.tsx), no public origin",
    page: [842, 595],
    opts: {
      userLabel: "jane@example.com", email: "jane@example.com", timestamp: new Date(0), expiresAt: new Date(86_400_000),
      watermarkText: "UNCONTROLLED — P-101 Rev B",
      footerNotice: "P-101 Rev B at time of issue — verify current revision before use.",
    },
  },
  {
    name: "transmittal portal (portalStampText), with a QR",
    page: [1224, 792],
    opts: { ...portalStampText({ docNumber: "VDS-7 ‘GA’", rev: "Rév 2", transmittalNumber: "TR-0042", issuedOn: "2026-10-07", verifyUrl: VERIFY }), timestamp: new Date(0) },
  },
  {
    name: "transmittal portal (portalStampText), no configured origin",
    page: [1224, 792],
    opts: { ...portalStampText({ docNumber: "P-101", rev: "3", transmittalNumber: "TR-0042", issuedOn: null }), timestamp: new Date(0) },
  },
  {
    name: "review copy, no watermark text; NBSP, euro, ellipsis, bullet and a long wrapping notice",
    page: [612, 792],
    opts: {
      controlState: "review", timestamp: new Date(0), userLabel: "A B € … • ‰ ™",
      footerNotice: `${"Very long plain notice text that wraps across several lines of the footer band — ".repeat(6)}end.`,
      verifyUrl: VERIFY,
    },
  },
  {
    name: "a watermark too long for the page (truncated with an ellipsis)",
    page: [300, 400],
    opts: { watermarkText: "UNCONTROLLED — ".repeat(12), timestamp: new Date(0), footerNotice: "Rev 4 at time of issue — verify current revision before use." },
  },
];

type Call = { op: string; args: unknown[] };

function plain(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const ctor = (v as { constructor?: { name?: string } }).constructor?.name ?? "";
  if (/Font$/.test(ctor)) return "<font>";
  if (/Image$/.test(ctor)) return "<image>";
  if (Array.isArray(v)) return v.map(plain);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = plain((v as Record<string, unknown>)[k]);
  return out;
}

/** Stamp one case: every draw call (text, rectangle, image — with its
 *  position, size, rotation, colour, opacity) and the saved bytes' digest. */
export async function stampCase(c: (typeof PLAIN_CASES)[number]): Promise<{ calls: Call[]; sha256: string }> {
  const calls: Call[] = [];
  const proto = PDFPage.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const spies = (["drawText", "drawRectangle", "drawImage"] as const).map((op) => {
    const orig = proto[op];
    return vi.spyOn(proto, op).mockImplementation(function (this: PDFPage, ...a: unknown[]) {
      calls.push({ op, args: a.map(plain) });
      return orig.apply(this, a);
    });
  });
  try {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const page = pdf.addPage(c.page);
    if (c.rotate) page.setRotation(degrees(c.rotate));
    await applyStampToPdfDoc(pdf, c.opts);
    const bytes = await pdf.save();
    return { calls, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    for (const s of spies) s.mockRestore();
  }
}
