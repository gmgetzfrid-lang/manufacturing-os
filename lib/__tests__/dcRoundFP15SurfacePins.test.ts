// document-control Round F wave 3 — P15 SURFACE REMAINDERS:
//   * DIST-9 done-when 3, the last consumer: the inspector's stale-holder
//     banner reads getDocumentRecall's `unavailable` as a GAP ("distribution
//     record unavailable"), never as "nobody is working from a superseded
//     copy";
//   * HLD-1 limb 2: FullScreenViewer's markup export goes through the
//     lib/downloads.ts hold stamp — the gate's read when the copy is taken,
//     the ON HOLD watermark and the hold line leading the footer — as the
//     plain download and print do; an export of a document that is not held
//     is stamped exactly as before.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  holds: { data: [] as Array<Record<string, unknown>>, error: null as { message: string } | null },
  holdReads: 0,
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const c: Record<string, unknown> = {};
      const h: ProxyHandler<Record<string, unknown>> = {
        get(_t, prop: string) {
          if (prop === "then") {
            return (res: (v: unknown) => void) => { if (table === "document_holds") state.holdReads++; res(table === "document_holds" ? state.holds : { data: [], error: null }); };
          }
          return () => new Proxy(c, h);
        },
      };
      return new Proxy(c, h);
    },
  },
}));
vi.mock("@/lib/stamping", () => ({ downloadStampedPdf: vi.fn(), stampPdf: vi.fn() }));
vi.mock("@/lib/intents", () => ({ recordIntent: vi.fn() }));
vi.mock("@/lib/publicOrigin", () => ({ publicOrigin: () => "" }));

import { readCopyHoldState, holdFooterLine, copyWatermark } from "@/lib/downloads";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

beforeEach(() => {
  state.holds = { data: [], error: null };
  state.holdReads = 0;
});

describe("DIST-9 dw3 — the inspector's stale-holder banner reads an unreadable record as a gap", () => {
  const panel = src("components/documents/InspectorPanel.tsx");
  const effect = panel.slice(panel.indexOf("const [staleHolderCount, setStaleHolderCount] = useState(0);"), panel.indexOf("// TRX-9: the transmittal read throws on a real error."));
  it("destructures `unavailable` with the holders and keeps it as its own state", () => {
    expect(effect).toContain("const [staleUnknown, setStaleUnknown] = useState(false);");
    expect(effect).toContain("const { holders, unavailable } = await getDocumentRecall(selectedDoc.id, selectedDoc.currentVersionId ?? null);");
    expect(effect).toMatch(/if \(alive\) \{\s*\n\s*setStaleHolderCount\(holders\.filter\(\(h\) => !h\.hasCurrent\)\.length\);\s*\n\s*setStaleUnknown\(unavailable\);\s*\n\s*\}/);
    // the old shape — holders alone, a throw read as zero — is gone
    expect(panel).not.toContain("const { holders } = await getDocumentRecall(");
    expect(panel).not.toContain("} catch { if (alive) setStaleHolderCount(0); }");
  });
  it("a recall that could not run at all is unknown too, and switching documents clears it synchronously", () => {
    expect(effect).toMatch(/\} catch \{\s*\n\s*\/\/ DIST-9 dw3: a recall that could not run is unknown, not zero\.\s*\n\s*if \(alive\) \{ setStaleHolderCount\(0\); setStaleUnknown\(true\); \}\s*\n\s*\}/);
    expect(effect).toMatch(/setStaleHolderCount\(0\);\s*\n\s*setStaleUnknown\(false\);\s*\n\s*setDistSummary\(null\);\s*\n\s*\(async \(\) => \{/);
  });
  it("renders the gap as an amber 'Distribution record unavailable' line beside the count banner (which is unchanged)", () => {
    expect(panel).toMatch(/\{staleUnknown && \([\s\S]{0,300}?data-testid="stale-holders-unknown"[\s\S]{0,400}?<b>Distribution record unavailable<\/b> — who holds a copy of this document could not be read, so whether anyone is working from a superseded copy is unknown\./);
    expect(panel).toMatch(/\{staleHolderCount > 0 && \(\s*\n\s*<div className="rounded-xl border border-amber-300 bg-amber-50/);
    expect(panel).toContain("may be working from a superseded copy</b>");
  });
  it("the reader's contract the banner relies on: an unreadable record is `unavailable: true` with no holders (lib/staleCopies.ts)", () => {
    const reader = src("lib/staleCopies.ts");
    expect(reader).toContain("const unavailable: DocumentRecall = { holders: [], capped: false, unavailable: true };");
    expect(reader).toMatch(/if \(error\) return unavailable;/);
  });
});

describe("HLD-1 limb 2 — the markup export carries the hold stamp the plain download and print carry", () => {
  const v = src("components/viewers/FullScreenViewer.tsx");
  const fn = v.slice(v.indexOf("const downloadWithMarkup = async () => {"), v.indexOf("const requestMarkupDownload = () => {"));
  it("reads the hold through lib/downloads.ts when the copy is taken, BEFORE the stamp, and stamps with its watermark and footer line", () => {
    expect(v).toMatch(/readCopyHoldState,\s*\n\s*holdFooterLine,\s*\n\s*copyWatermark,\s*\n\} from "@\/lib\/downloads";/);
    const read = fn.indexOf("const hold = await readCopyHoldState(docRecord?.id);");
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(fn.indexOf("await applyStampToPdfDoc(pdfDoc, {"));
    expect(fn).toContain('watermarkText: hold.blocked ? copyWatermark({ versionIsCurrent: viewingIsCurrent }, hold) : "UNCONTROLLED — FOR REVIEW ONLY",');
    expect(fn).toContain('footerNotice: [holdFooterLine(hold), markupFooter].filter(Boolean).join(" "),');
    expect(fn).toContain("const markupFooter = `${docNumber || title || \"Document\"} Rev ${rev ?? \"?\"} WITH MARKUPS at time of export — markups are not part of the controlled revision.`;");
    // the stamp still runs unconditionally and the record is still an uncontrolled copy (PHYS-5, unchanged)
    expect(fn).toMatch(/\n {6}await applyStampToPdfDoc\(pdfDoc, \{\n {8}sourceBytes: pdfBytes \?\? undefined,/);
    expect(fn).toMatch(/state: "uncontrolled",/);
  });

  // The composition the viewer performs, run on the real lib/downloads.ts helpers.
  const compose = async (documentId: string | undefined, viewingIsCurrent = true) => {
    const hold = await readCopyHoldState(documentId);
    const markupFooter = "P-101 Rev C WITH MARKUPS at time of export — markups are not part of the controlled revision.";
    return {
      watermark: hold.blocked ? copyWatermark({ versionIsCurrent: viewingIsCurrent }, hold) : "UNCONTROLLED — FOR REVIEW ONLY",
      footer: [holdFooterLine(hold), markupFooter].filter(Boolean).join(" "),
    };
  };
  it("a held document's redlined export says ON HOLD — watermark and the footer's lead line", async () => {
    state.holds = { data: [{ id: "h1", reason: "Client Review", opened_at: null, opened_by_name: null }], error: null };
    const out = await compose("doc-1");
    expect(out.watermark).toBe("ON HOLD — DO NOT USE");
    expect(out.footer).toBe("ON HOLD at time of issue (Client Review) — work from this document is stopped until Document Control releases the hold. P-101 Rev C WITH MARKUPS at time of export — markups are not part of the controlled revision.");
  });
  it("an unreadable hold state is a hold (fail closed)", async () => {
    state.holds = { data: [], error: { message: "permission denied" } };
    const out = await compose("doc-1");
    expect(out.watermark).toBe("UNCONTROLLED — HOLD STATUS UNKNOWN");
    expect(out.footer).toMatch(/^HOLD STATUS UNKNOWN at time of issue — treat this document as ON HOLD/);
  });
  it("REGRESSION: an export of a document that is not held is stamped exactly as before (review watermark, the markup footer alone)", async () => {
    const out = await compose("doc-1");
    expect(out).toEqual({
      watermark: "UNCONTROLLED — FOR REVIEW ONLY",
      footer: "P-101 Rev C WITH MARKUPS at time of export — markups are not part of the controlled revision.",
    });
    // an old revision's export keeps the review watermark too (its footer already names the revision)
    expect((await compose("doc-1", false)).watermark).toBe("UNCONTROLLED — FOR REVIEW ONLY");
  });
  it("the ad-hoc viewer (no document record) reads no hold and is stamped as before", async () => {
    const out = await compose(undefined);
    expect(state.holdReads).toBe(0);
    expect(out.watermark).toBe("UNCONTROLLED — FOR REVIEW ONLY");
  });
});
