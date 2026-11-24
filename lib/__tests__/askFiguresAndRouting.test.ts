// lib/__tests__/askFiguresAndRouting.test.ts
//
// The case that exposed it (Nov 17): "can I weld a 1-1/2 in. coupling onto
// a 2 in. Class 150 blind flange to make a reducing flange?" The answer
// lived in EP 5-5-1 (Piping Fabrication) Figure 4, p.32. The ask never
// opened EP 5-5-1; when the person then named "EP 5-5-1 figure 4", the
// page images it looked at were a pump test plan, an electrical detail and
// a methanol unit's tables, while the index had recorded that FIGURE 4
// lives on EP 5-5-1 p.32. And the indexer never looked at p.32 as an
// image, because its dimension labels ("1/8 In. Max.") read as sentences.

import { describe, it, expect } from "vitest";
import {
  pickPageTargets, labelsToResolve, refsIn, isFigurePage, normalizeLabel, type Anchor, type PassageLike,
} from "@/lib/ask/pageTargets";
import { routeCandidates, designationMatch, designationOf } from "@/lib/ask/titleRouting";
import { pageNeedsVision, proseSentences } from "@/lib/drawingText";
import { parseFollowupPlan } from "@/lib/knowledgeText";
import { figureNotDescribed, figurePagesToRead } from "@/lib/figurePages";

const EP551 = "ep551", EP552 = "ep552", EP522 = "ep522", PUMP = "pump-itp", ELEC = "elec-details", METH = "methanol";

const Q1 = 'can i weld a 1-1/2" coupling onto a 2" 150 class blind flange to make a 2" x 1-1/2" companion flange. like a reducing flange to threaded connection.';
const Q2 = "you are wrong ep 5-5-1 figure 4 shows exactly what im talking about";

/** EP 5-5-1 p.32 as the index holds it: the caption and the drawing's labels. */
const FIG4_PAGE =
  "P IPING F ABRICATION EP 5-5-1 Revision 0.4 Date: 07/2026 Page: 32 of 35 This document may not be used or " +
  "reproduced without the permission of Kern Energy – Maintained by Equity Figure 4 – Permissible Attachment " +
  "Details for Couplings Type 1 - Set In Type Socket Weld Full Couplings Single Or Double Bevel 1/8 In. Max. " +
  "1/8 In. Max. Type 2 - Set-On Drill-Thru Type Socket Weld Couplings 1/8 In. Min. Rad. 1/8 In. Min. 1/2 Of The " +
  "Bore Size Maximum";
const SEC_11_6 =
  "11.0 BRANCH CONNECTIONS ... branch connections, other than welding tees or those shown in Figure 3, shall not " +
  "be used for severe cyclic conditions. 11.6 Fabrication details for couplings shall be in accordance with " +
  "Figure 4. 11.7 Fabrication details for branch welded-on fittings (weldolets) shall be in accordance with Figure 5A.";
const PROSE_PAGE =
  "The minimum design metal temperature shall be established per UCS-66. Where impact testing is required, the " +
  "procedure of UG-84 applies. Exemptions are permitted under the conditions of UCS-68(c).";

const decoys: PassageLike[] = [
  { document_id: PUMP, page: 5, content: "Inspection and test plan. See Table 1 for hold points. Table 1 lists witness points." },
  { document_id: ELEC, page: 15, content: "Grounding details per Table 1 and Figure 3. Table 1 gives conductor sizes." },
  { document_id: METH, page: 3, content: "Methanol unit materials per Table 1. Table 1 governs. See Figure 4 for the layout." },
  { document_id: EP522, page: 8, content: "Table 1 – Flange Standards. Steel flanges 1/2 through 24 NPS: ASME B16.5." },
  { document_id: EP552, page: 12, content: "9.4.1 All pressure containing welds shall have a minimum of two passes. This includes couplings, sockets, and seal welds." },
];
const anchors: Anchor[] = [
  { tag: "FIGURE 4", document_id: EP551, page: 32 },
  { tag: "FIGURE 3", document_id: EP551, page: 31 },
  { tag: "FIGURE 5A", document_id: EP551, page: 33 },
  { tag: "FIGURE 4", document_id: METH, page: 9 },
  { tag: "TABLE 1", document_id: PUMP, page: 6 },
  { tag: "TABLE 1", document_id: ELEC, page: 2 },
  { tag: "TABLE 1", document_id: METH, page: 4 },
  { tag: "TABLE 1", document_id: EP522, page: 8 },
];

describe("which pages the answer looks at", () => {
  it("looks first at the figure the person named, in the document they named", () => {
    const t = pickPageTargets({
      asked: [Q2, Q1], passages: decoys, anchors,
      namedDocIds: [EP551], conversationDocIds: [EP522], max: 6,
    });
    expect(t[0]).toMatchObject({ documentId: EP551, page: 32, why: "named", label: "FIGURE 4" });
    // Not the methanol unit's namesake Figure 4.
    expect(t.some((x) => x.documentId === METH && x.page === 9)).toBe(false);
  });

  it("finds Figure 4 on its own when the fabrication practice is read, without being told", () => {
    const passages: PassageLike[] = [
      ...decoys,
      { document_id: EP551, page: 10, content: SEC_11_6 },
      { document_id: EP551, page: 32, content: FIG4_PAGE },
    ];
    const t = pickPageTargets({ asked: [Q1], passages, anchors, namedDocIds: [], conversationDocIds: [], max: 6 });
    expect(t.some((x) => x.documentId === EP551 && x.page === 32)).toBe(true);
  });

  it("never guesses another document's namesake table", () => {
    const passages: PassageLike[] = [{ document_id: "doc-a", page: 3, content: "Couplings: see Table 1 for weld sizes of each coupling." }];
    const t = pickPageTargets({
      asked: ["what weld size for a coupling"], passages,
      anchors: [{ tag: "TABLE 1", document_id: "doc-b", page: 7 }],
      namedDocIds: [], conversationDocIds: [], max: 6,
    });
    expect(t.some((x) => x.documentId === "doc-b")).toBe(false);
  });

  it("asks for the named labels and what the relevant passages point to", () => {
    const labels = labelsToResolve([Q2, Q1], [...decoys, { document_id: EP551, page: 10, content: SEC_11_6 }]);
    expect(labels[0]).toBe("FIGURE 4");
    expect(labels).toContain("FIGURE 5A");
  });

  it("reads labels the way people write them", () => {
    expect(refsIn("see fig. 4 and Table 2B.")).toEqual(["FIGURE 4", "TABLE 2B"]);
    expect(normalizeLabel("Figure 5A.")).toBe("FIGURE 5A");
  });

  it("knows a figure page from a prose page", () => {
    expect(isFigurePage(FIG4_PAGE)).toBe(true);
    expect(isFigurePage(SEC_11_6)).toBe(false);
    expect(isFigurePage(PROSE_PAGE)).toBe(false);
  });
});

describe("the indexer looks at figure pages", () => {
  it("reads EP 5-5-1 Figure 4 as an image", () => {
    expect(pageNeedsVision(FIG4_PAGE, 0)).toBe(true);
  });
  it("doesn't take dimension labels for sentences", () => {
    expect(proseSentences("1/8 In. Max. 1/8 In. Min. Rad. Typ.")).toBe(0);
    expect(proseSentences(PROSE_PAGE)).toBe(3);
  });
  it("still leaves prose alone", () => {
    expect(pageNeedsVision(PROSE_PAGE, 0)).toBe(false);
  });
});

describe("routing a question to the practice that governs it", () => {
  const docs = [
    "EP 5-5-2 - Welding Requirements for Piping Constructed to ASME B31.3",
    "EP 5-5-1 - Piping Fabrication",
    "EP 5-5-1C - Piping Fabrication Inspection Checklist",
    "EP 5-5-3 - Pipe Erection and Testing",
    "EP 5-2-2 - Flanges, Gaskets, and Bolting",
    "EP 5-2-3 - Kern Engineering Piping Standards",
    "EP 13-6-2 - Motor Control Centers 600 Volt Class",
    "EP 13-2-4D402 - 12-60 HP Motor Connection",
    ...Array.from({ length: 60 }, (_, i) => `EP 9-${i}-1 - Unrelated Practice Number ${i}`),
  ].map((name, i) => ({ id: `d${i}`, name }));

  it("puts EP 5-5-1 Piping Fabrication on the list for the coupling-in-a-blind question", () => {
    const list = routeCandidates({ docs, question: Q1, queries: ["coupling welding to flange"], retrievedDocIds: [] }).map((d) => d.name);
    expect(list).toContain("EP 5-5-1 - Piping Fabrication");
    expect(list).toContain("EP 5-2-3 - Kern Engineering Piping Standards");
    // Base practices before their checklists.
    expect(list.indexOf("EP 5-5-1 - Piping Fabrication")).toBeLessThan(
      list.indexOf("EP 5-5-1C - Piping Fabrication Inspection Checklist") === -1 ? Infinity : list.indexOf("EP 5-5-1C - Piping Fabrication Inspection Checklist"));
  });

  it("reads a designation off a title", () => {
    expect(designationOf("EP 5-5-1C - Piping Fabrication Inspection Checklist")).toEqual({ family: "EP 5-5", base: "EP 5-5-1", variant: "C" });
    expect(designationOf("EP 5-5-1 - Piping Fabrication")).toEqual({ family: "EP 5-5", base: "EP 5-5-1", variant: "" });
  });

  it("matches a designation to the document itself, not its namesakes", () => {
    expect(designationMatch("EP 5-5-1", "EP 5-5-1 - Piping Fabrication")).toBe(3);
    expect(designationMatch("EP 5-5-1", "EP 5-5-1C - Piping Fabrication Inspection Checklist")).toBe(2);
    expect(designationMatch("EP 5-5-1", "EP 5-5-10 - Something Else")).toBe(0);
    // A title that mentions B31.3 doesn't make B31.3 present.
    expect(designationMatch("ASME B31.3", "EP 5-5-2 - Welding Requirements for Piping Constructed to ASME B31.3")).toBe(1);
  });

  it("parses the documents the plan chose to open", () => {
    const plan = parseFollowupPlan('{"queries": [], "missing_documents": ["ASME B16.5"], "open_documents": ["EP 5-5-1", "EP 5-2-3"]}');
    expect(plan.open).toEqual(["EP 5-5-1", "EP 5-2-3"]);
    expect(plan.missingDocs).toEqual(["ASME B16.5"]);
  });
});

describe("finding figure pages that were never looked at", () => {
  const FIG3_DESCRIBED =
    "DRAWING NO: EP 5-5-1 SHEET: 31 OF 35 Figure 3 – Acceptable Details for Branch Attachment Suitable for 100% " +
    "Radiography Type 1 - Contour Outlet Fitting [Two technical drawings showing branch attachment configurations " +
    "with contoured outlet fittings - left showing side view with branch connection, right showing angled view]";
  it("flags Figure 4 (labels only) and passes Figure 3 (described)", () => {
    expect(figureNotDescribed(FIG4_PAGE)).toBe(true);
    expect(figureNotDescribed(FIG3_DESCRIBED)).toBe(false);
    expect(figureNotDescribed(PROSE_PAGE)).toBe(false);
  });
  it("a figure described in sentences is done", () => {
    expect(figureNotDescribed(FIG4_PAGE + " Type 1 shows a full coupling set into a hole in the run pipe and fillet welded. " +
      "Type 2 shows a coupling set on the outside of the run, through-drilled, and fillet welded. " +
      "The root gap is limited to one eighth of an inch.")).toBe(false);
  });
  it("groups pages by document, joining a page's passages", () => {
    const out = figurePagesToRead([
      { document_id: EP551, page: 32, content: FIG4_PAGE.slice(0, 200) },
      { document_id: EP551, page: 32, content: FIG4_PAGE.slice(200) },
      { document_id: EP551, page: 31, content: FIG3_DESCRIBED },
      { document_id: EP552, page: 12, content: PROSE_PAGE },
    ]);
    expect([...out.entries()]).toEqual([[EP551, [32]]]);
  });
});
