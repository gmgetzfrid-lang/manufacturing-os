// Folding layers is where "drawn on sheet 7" has to beat "named a bit like
// it", and where a request for drawings hides the inspection reports with a
// count instead of silently. Pure, so it is pinned here.

import { describe, it, expect } from "vitest";
import { entryFromDocument, type IndexEntry } from "@/lib/fileFinder/fileIndex";
import { parseQuery } from "@/lib/fileFinder/queryParse";
import { rankEntries } from "@/lib/fileFinder/rank";
import { foldLayers, hideOtherTypes, groupResults, snippetAround, REL_WEIGHT } from "@/lib/find/merge";

const folders = new Map([["f", { id: "f", libraryId: "L", parentId: null, name: "20 - Crude" }]]);
const libraries = new Map([["L", { id: "L", name: "Drawings" }]]);
const mk = (id: string, name: string): IndexEntry => entryFromDocument({ id, library_id: "L", collection_id: "f", name }, { folders, libraries });

describe("foldLayers", () => {
  it("makes a sheet the tag is drawn on a strong result even when its name says nothing", () => {
    const pid = mk("pid", "2002-D-2001_SHT07.pdf");
    const named = mk("named", "X-35 notes.txt");
    const q = parseQuery("X-35");
    const l0 = rankEntries([pid, named], q, {});
    const out = foldLayers([pid, named], l0, [
      { entryId: "doc:pid", evidence: [{ kind: "identifier", label: "X-35 is drawn on sheet 7, upper left", delta: REL_WEIGHT.drawn_on, layer: "L1" }],
        relations: [{ rel: "drawn_on", node: "asset:a", label: "X-35", detail: "sheet 7, upper left", page: 7 }], pages: [] },
    ], () => 0);
    const pid7 = out.find((r) => r.id === "doc:pid")!;
    expect(out.slice(0, 2).map((r) => r.id)).toContain("doc:pid");
    expect(pid7.verdict).toBe("strong");
    expect(pid7.evidence.map((e) => e.layer)).toContain("L1");
    expect(out.find((r) => r.id === "doc:named")?.evidence[0].layer).toBe("L0");
  });
});

describe("hideOtherTypes", () => {
  it("hides other known types with a count, but never a sheet the asset is drawn on", () => {
    const iso = mk("iso", "Crude ISO-2001-05.pdf");
    const pid = mk("pid", "2002-D-2001_SHT07 PID.pdf");
    const rep = mk("rep", "X-35 inspection report 2023.pdf");
    const q = parseQuery("X-35 P&ID");
    const l0 = rankEntries([iso, pid, rep], q, {});
    const out = foldLayers([iso, pid, rep], l0, [
      { entryId: "doc:iso", evidence: [{ kind: "identifier", label: "drawn", delta: 45, layer: "L1" }], relations: [{ rel: "drawn_on", node: "asset:a", label: "X-35", detail: "sheet 2", page: 2 }], pages: [] },
    ], () => 0);
    const { kept, hidden } = hideOtherTypes(out, q);
    expect(kept.map((r) => r.id)).toEqual(expect.arrayContaining(["doc:iso", "doc:pid"]));
    expect(kept.map((r) => r.id)).not.toContain("doc:rep");
    expect(hidden).toEqual({ count: 1, byType: { Report: 1 } });
  });
});

describe("groupResults", () => {
  it("groups by relationship first, then by type by name", () => {
    const a = mk("a", "sheet.pdf"), b = mk("b", "x35 datasheet.pdf"), c = mk("c", "X-35 spec.pdf");
    const q = parseQuery("X-35");
    const out = foldLayers([a, b, c], rankEntries([a, b, c], q, {}), [
      { entryId: "doc:a", evidence: [{ kind: "identifier", label: "d", delta: 45, layer: "L1" }], relations: [{ rel: "drawn_on", node: "asset:a", label: "X-35", detail: "sheet 1", page: 1 }], pages: [] },
      { entryId: "doc:b", evidence: [{ kind: "identifier", label: "t", delta: 30, layer: "L1" }], relations: [{ rel: "tagged_to", node: "asset:a", label: "X-35", detail: "by hand" }], pages: [] },
    ], () => 0);
    const groups = groupResults(out);
    expect(groups.map((g) => g.key)).toEqual(["drawn_on", "tagged_to", "type:spec"]);
  });
});

describe("snippetAround", () => {
  it("centres on the first term and trims", () => {
    const s = snippetAround("a".repeat(200) + " X-35 shell side " + "b".repeat(200), ["x-35"], 20);
    expect(s).toMatch(/^…a+ X-35 shell side b+…$/);
  });
});
