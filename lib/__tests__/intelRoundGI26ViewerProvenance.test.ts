// @vitest-environment jsdom
//
// intelligence Round G I-26 — GAP-303's drawing-viewer limb: the viewer's
// equipment-tag overlay (EquipmentTagsStrip, ribbon) tells a tag the
// equipment sweep READ off the drawing from one a person asserted, as the
// asset hub does — "AI-read" (with the model) / "read from drawing", the
// revision and sheet in the tooltip; "tagged · also on drawing" when the
// document's own equipment tags name it too. Read from document_assets under
// the viewer's RLS (lib/drawingTagProvenance.ts).
// REGRESSION: with no document passed (the Inspector), or a relation that
// cannot be read, the overlay renders exactly as before — no read, no mark.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Answer = { data: unknown[] | null; error: { code?: string; message?: string } | null };
const st = vi.hoisted(() => ({ reads: [] as Array<{ table: string; cols: string; filters: Array<[string, unknown]> }>, answer: null as null | ((cols: string) => Answer) }));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string) => {
    const rec = { table, cols: "", filters: [] as Array<[string, unknown]> };
    const p: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") {
          st.reads.push(rec);
          const a = st.answer ? st.answer(rec.cols) : { data: [], error: null };
          return (resolve: (v: unknown) => void) => resolve(a);
        }
        return (...args: unknown[]) => {
          if (prop === "select") rec.cols = String(args[0]);
          if (prop === "eq") rec.filters.push([String(args[0]), args[1]]);
          return new Proxy(p, h);
        };
      },
    };
    return new Proxy(p, h);
  };
  return { supabase: { from: (t: string) => chain(t) } };
});
vi.mock("@/components/assets/AssetTagChip", () => ({
  default: ({ tag }: { tag: string }) => React.createElement("span", { "data-chip": tag }, tag),
}));

import EquipmentTagsStrip from "@/components/assets/EquipmentTagsStrip";
import { provenanceByTag, provenanceMark, readDrawingTagProvenance } from "@/lib/drawingTagProvenance";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROWS = [
  { tag_text: "E-22", source: "drawing", asserted_by: "machine", model: "vision-model-x", source_revision: "B", sheet_label: "2002-D-10001 SHT 4" },
  { tag_text: "V-101", source: "drawing", asserted_by: "machine", model: null, source_revision: "B", sheet_label: "2002-D-10001 SHT 5" },
  { tag_text: "P-7", source: "drawing", asserted_by: "machine", model: null, source_revision: "B", sheet_label: null },
];

describe("GAP-303 — provenanceByTag / provenanceMark (pure)", () => {
  it("a machine row is 'AI-read' with a model, 'read from drawing' without; a person's tag read too is 'tagged · also on drawing'", () => {
    const m = provenanceByTag(ROWS, [{ tag: "P-7" }]);
    expect(provenanceMark(m.get("e22")!)).toEqual({
      label: "AI-read",
      title: "Read off the drawing by the equipment sweep from an AI transcription (vision-model-x) — check it against the sheet, on 2002-D-10001 SHT 4 (AI-read, unconfirmed), Rev B. Not typed by a person.",
    });
    expect(provenanceMark(m.get("v101")!).label).toBe("read from drawing");
    expect(provenanceMark(m.get("v101")!).title).toMatch(/from the drawing's own text, on 2002-D-10001 SHT 5, Rev B\. Not typed by a person\./);
    expect(m.get("p7")!.kind).toBe("person_also");
    expect(provenanceMark(m.get("p7")!).label).toBe("tagged · also on drawing");
  });
  it("a person's row (jsonb_sync / manual) gives no mark — an unmarked chip is a person's, as it always read", () => {
    const m = provenanceByTag([{ tag_text: "E-22", source: "manual", asserted_by: "human" }, { tag_text: "E-23", source: "jsonb_sync" }]);
    expect(m.size).toBe(0);
  });
});

describe("GAP-303 — readDrawingTagProvenance (the viewer's own RLS)", () => {
  beforeEach(() => { st.reads = []; st.answer = null; });
  it("reads only the document's 'drawing' rows; a missing provenance column is dropped one step at a time", async () => {
    st.answer = (cols) => (cols.includes("asserted_by") ? { data: null, error: { code: "42703", message: "column document_assets.asserted_by does not exist" } } : { data: [{ tag_text: "E-22", source: "drawing", sheet_label: "SHT 4" }], error: null });
    const m = await readDrawingTagProvenance("d1");
    expect(st.reads.map((r) => r.cols)).toEqual(["tag_text, source, asserted_by, model, source_revision, sheet_label", "tag_text, source, sheet_label"]);
    expect(st.reads[0].filters).toEqual([["document_id", "d1"], ["source", "drawing"]]);
    expect(m!.get("e22")).toEqual({ kind: "machine", model: null, revision: null, sheet: "SHT 4" });
  });
  it("any other read failure is null — nothing is claimed", async () => {
    st.answer = () => ({ data: null, error: { code: "57014", message: "timeout" } });
    expect(await readDrawingTagProvenance("d1")).toBeNull();
  });
});

describe("GAP-303 — the drawing viewer's ribbon, rendered", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { st.reads = []; st.answer = () => ({ data: ROWS, error: null }); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  const metadata = { equipment: ["E-22", "V-101", "P-7", "K-9"] };
  const columns = [{ key: "equipment", label: "Equipment", type: "tags" }];
  const render = async (props: Record<string, unknown>) => {
    await act(async () => {
      root.render(React.createElement(EquipmentTagsStrip, { metadata, customColumns: columns, orgId: "o1", variant: "ribbon", ...props }));
    });
    await act(async () => { await Promise.resolve(); });
  };
  const markOf = (tag: string) => host.querySelector(`[data-chip='${tag}']`)!.parentElement!.querySelector("[data-tag-provenance]");

  it("each chip the sweep read is marked; a person's tag read too says so; a tag no reading names is unmarked", async () => {
    await render({ documentId: "d1", assetTags: [{ tag: "P-7" }] });
    expect(markOf("E-22")?.textContent).toBe("AI-read");
    expect(markOf("E-22")?.getAttribute("title")).toMatch(/vision-model-x.*Rev B/);
    expect(markOf("V-101")?.textContent).toBe("read from drawing");
    expect(markOf("P-7")?.textContent).toBe("tagged · also on drawing");
    expect(markOf("P-7")?.getAttribute("data-tag-provenance")).toBe("person_also");
    expect(markOf("K-9")).toBeNull();
  });

  it("REGRESSION — no document passed (the Inspector, every other mount): no read and no mark; the chips are as before", async () => {
    await render({});
    expect(st.reads).toHaveLength(0);
    expect(host.querySelectorAll("[data-tag-provenance]")).toHaveLength(0);
    expect([...host.querySelectorAll("[data-chip]")].map((c) => c.textContent)).toEqual(["E-22", "V-101", "P-7", "K-9"]);
  });

  it("a relation that cannot be read marks nothing — the overlay reads as it did", async () => {
    st.answer = () => ({ data: null, error: { code: "42501", message: "permission denied" } });
    await render({ documentId: "d1" });
    expect(host.querySelectorAll("[data-tag-provenance]")).toHaveLength(0);
    expect(host.querySelectorAll("[data-chip]")).toHaveLength(4);
  });
});

describe("GAP-303 — both drawing viewers pass the document to the overlay", () => {
  it("FullScreenViewer and MultiDocViewer hand the strip the document and its own equipment tags", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("components/viewers/FullScreenViewer.tsx", "utf8")).toMatch(/variant="ribbon"\s*\n\s*documentId=\{docRecord\.id \?\? null\}\s*\n\s*assetTags=\{docRecord\.assetTags\}/);
    expect(readFileSync("components/viewers/MultiDocViewer.tsx", "utf8")).toContain('variant="ribbon" documentId={activeEntry.doc.id ?? null} assetTags={activeEntry.doc.assetTags} />');
  });
});
