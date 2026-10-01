// intelligence Round G (I-09) — the PFD reader's decisions, pure
// (lib/flowsRead.ts): the roster (FLOW-4 / AREA-5 / WIRE-6), the reply
// (PR-8), the settled set and the revision rule (FLOW-5 / IEDGE-8 / AREA-3),
// confidence (PR-7) and the sentence that names every reason a read came
// back short (FLOW-11 / FLOW-12).

import { describe, it, expect } from "vitest";
import {
  buildRoster, rosterPrompt, parseFlowReply, planFlowProposals, readNote, reproposable, pageList,
  ROSTER_ASSET_BUDGET, MAX_PROPOSALS_PER_READ, LOW_CONFIDENCE, type PriorFlow, type ReadOutcome,
  namesFlowDrawing, flowReadCoverage,
} from "@/lib/flowsRead";

const asset = (i: number, unit: string | null, tag?: string) => ({
  id: `a-${String(i).padStart(4, "0")}`, tag: tag ?? `T-${String(i).padStart(4, "0")}`, unit_code: unit,
});
const units = [{ code: "20", label: "Crude" }, { code: "25", label: "DHT" }];

describe("buildRoster — the launching unit's equipment first, then the drawing's unit, then the rest; the count left off is said", () => {
  // 3,200 tags; the crude unit's 40 sort LAST alphabetically (Z-…), so the old
  // `assets.slice(0, 300)` of an unordered read could not be counted on to hold them.
  const plant = [
    ...Array.from({ length: 3160 }, (_, i) => asset(i, i % 2 ? "25" : null)),
    ...Array.from({ length: 40 }, (_, i) => asset(5000 + i, "20", `Z-${i}`)),
  ];

  it("a 3,200-asset plant read from the Crude Unit: every Crude tag is on the roster, and 2,900 left off are counted", () => {
    const r = buildRoster(plant, units, { unitCode: "20" });
    const listed = r.roster.filter((e) => e.kind === "asset");
    expect(listed).toHaveLength(ROSTER_ASSET_BUDGET);
    expect(listed.slice(0, 40).map((e) => e.label)).toEqual(Array.from({ length: 40 }, (_, i) => `Z-${i}`).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
    expect(r.assetsTotal).toBe(3200);
    expect(r.assetsOmitted).toBe(2900);
    expect(r.launchingUnitListed).toBe(40);
    expect(r.launchingUnitOmitted).toBe(0);
    // every codebook unit stays on the roster, after the equipment
    expect(r.roster.filter((e) => e.kind === "unit").map((e) => e.id)).toEqual(["20", "25"]);
    expect(r.roster.map((e) => e.ref).slice(0, 2)).toEqual(["A1", "A2"]);
  });

  it("the unit the drawing's number decodes to comes next, then the rest by tag", () => {
    const small = [asset(1, null, "B-1"), asset(2, "25", "C-1"), asset(3, "20", "D-1"), asset(4, null, "A-1")];
    const r = buildRoster(small, units, { unitCode: "20", drawingUnit: "25", budget: 3 });
    expect(r.roster.filter((e) => e.kind === "asset").map((e) => e.label)).toEqual(["D-1", "C-1", "A-1"]);
    expect(r.assetsOmitted).toBe(1);
  });

  it("deterministic: the same registry in any order grounds on the same roster", () => {
    const a = buildRoster(plant, units, { unitCode: "20" }).roster.map((e) => e.id);
    const b = buildRoster([...plant].reverse(), units, { unitCode: "20" }).roster.map((e) => e.id);
    expect(b).toEqual(a);
  });

  it("a registry read cut at the cap still counts the whole registry (total)", () => {
    const r = buildRoster(plant.slice(0, 500), units, { total: 3200 });
    expect(r.assetsTotal).toBe(3200);
    expect(r.assetsOmitted).toBe(2900);
  });

  it("the prompt tells the model how many were left off and that it may not connect them; a whole roster says nothing extra", () => {
    const r = buildRoster(plant, units, { unitCode: "20" });
    const p = rosterPrompt(r, "Crude");
    expect(p).toMatch(/^ROSTER \(the only entities you may connect\)\. 2900 more registry equipment items are NOT listed \(Crude's equipment is listed first\)/);
    expect(p).toContain("A1 [asset] Z-0");
    expect(p).toContain("U1 [unit] Crude (unit 20)");
    const whole = rosterPrompt(buildRoster(plant.slice(0, 10), units), null);
    expect(whole.split("\n")[0]).toBe("ROSTER (the only entities you may connect):");
  });
});

describe("parseFlowReply — PR-8: a malformed reply is named, never a thrown parse", () => {
  it("valid, empty, unbalanced (no block), invalid JSON, and a non-array flows", () => {
    expect(parseFlowReply('{"flows":[{"from":"A1","to":"A2"}]}')).toEqual({ ok: true, flows: [{ from: "A1", to: "A2" }] });
    expect(parseFlowReply('{"flows":[]}')).toEqual({ ok: true, flows: [] });
    expect(parseFlowReply("{}")).toEqual({ ok: true, flows: [] });
    expect(parseFlowReply(null)).toEqual({ ok: false, reason: "no_json" });
    expect(parseFlowReply("{flows: [{from: A1}]}")).toEqual({ ok: false, reason: "malformed" });
    expect(parseFlowReply('{"flows":"A1>A2"}')).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("planFlowProposals — the settled set by status, the revision rule, confidence", () => {
  const roster = buildRoster([asset(1, "20", "V-101"), asset(2, "20", "E-201"), asset(3, "20", "P-310")], units).roster;
  // A1 = E-201 (a-0002), A2 = P-310 (a-0003), A3 = V-101 (a-0001); U1 = 20, U2 = 25
  const ref = (tag: string) => roster.find((e) => e.label === tag)!.ref;
  const prior = (over: Partial<PriorFlow>): PriorFlow => ({
    id: "f1", from_kind: "asset", from_ref: "a-0001", to_kind: "asset", to_ref: "a-0002",
    status: "proposed", origin: "ai", source_document_id: "kd1", source_version_id: "rev1", ...over,
  });
  const flow = (from: string, to: string, extra: Record<string, unknown> = {}) => ({ from: ref(from), to: ref(to), ...extra });

  it("new, already confirmed, awaiting review, dismissed — each counted apart (AREA-3: a row is not a decision)", () => {
    const plan = planFlowProposals({
      flows: [flow("V-101", "E-201"), flow("E-201", "P-310"), flow("P-310", "V-101"), flow("V-101", "P-310", { confidence: 0.9 })],
      roster, docId: "kd1", revisionRead: "rev1", pagesAttached: [1, 2],
      prior: [
        prior({ id: "c", status: "confirmed", origin: "manual", source_document_id: null, source_version_id: null }),
        prior({ id: "p", from_ref: "a-0002", to_ref: "a-0003", status: "proposed" }),
        prior({ id: "d", from_ref: "a-0003", to_ref: "a-0001", status: "dismissed" }),
      ],
    });
    expect(plan.skippedConfirmed).toBe(1);
    expect(plan.skippedPending).toBe(1);
    expect(plan.skippedDismissed).toBe(1);
    expect(plan.inserts.map((r) => [r.from_ref, r.to_ref])).toEqual([["a-0001", "a-0003"]]);
    expect(plan.repropose).toEqual([]);
    // IEDGE-8: each skipped pair, by name, with its reason
    expect(plan.skippedPairs).toEqual([
      { from: "V-101", to: "E-201", reason: "confirmed" },
      { from: "E-201", to: "P-310", reason: "pending" },
      { from: "P-310", to: "V-101", reason: "dismissed" },
    ]);
  });

  it("IEDGE-8: a dismissal of THIS document's reading at an older revision is re-proposed on a new revision; on the same revision it sticks", () => {
    const dismissed = prior({ id: "d", status: "dismissed", source_version_id: "rev1" });
    const again = planFlowProposals({ flows: [flow("V-101", "E-201")], roster, prior: [dismissed], docId: "kd1", revisionRead: "rev1", pagesAttached: [1] });
    expect(again.skippedDismissed).toBe(1);
    expect(again.inserts).toEqual([]);
    const revised = planFlowProposals({ flows: [flow("V-101", "E-201", { page: 1, confidence: 0.8 })], roster, prior: [dismissed], docId: "kd1", revisionRead: "rev2", pagesAttached: [3] });
    expect(revised.skippedDismissed).toBe(0);
    expect(revised.repropose).toEqual([expect.objectContaining({ id: "d", previousRevision: "rev1", from_ref: "a-0001", to_ref: "a-0002", source_page: 3, confidence: 0.8 })]);
  });

  it("a dismissal sticks when no revision was recorded, when another document was read, for a hand-drawn row, or when this read has no revision", () => {
    expect(reproposable(prior({ status: "dismissed", source_version_id: null }), "kd1", "rev2")).toBe(false);
    expect(reproposable(prior({ status: "dismissed", source_document_id: "kd9" }), "kd1", "rev2")).toBe(false);
    expect(reproposable(prior({ status: "dismissed", origin: "manual" }), "kd1", "rev2")).toBe(false);
    expect(reproposable(prior({ status: "dismissed" }), "kd1", null)).toBe(false);
    expect(reproposable(prior({ status: "confirmed" }), "kd1", "rev2")).toBe(false);
    expect(reproposable(prior({ status: "dismissed" }), "kd1", "rev2")).toBe(true);
  });

  it("FLOW-5: a dismissed A→B does not block B→A (a recycle is a separate flow)", () => {
    const plan = planFlowProposals({
      flows: [flow("E-201", "V-101")], roster, docId: "kd1", revisionRead: "rev1", pagesAttached: [1],
      prior: [prior({ status: "dismissed" })],
    });
    expect(plan.inserts.map((r) => [r.from_ref, r.to_ref])).toEqual([["a-0002", "a-0001"]]);
  });

  it("handles the roster never offered, a self-loop and a repeated pair are not rows; the ungrounded ones are counted", () => {
    const plan = planFlowProposals({
      flows: [{ from: "A99", to: ref("E-201") }, flow("E-201", "E-201"), { from: 7, to: null }, flow("V-101", "E-201"), flow("V-101", "E-201")],
      roster, prior: [], docId: "kd1", revisionRead: null, pagesAttached: [1],
    });
    expect(plan.skippedUngrounded).toBe(3);
    expect(plan.inserts).toHaveLength(1);
  });

  it("PR-7: confidence is kept as the model gave it, null when absent (never 0.5), and low or unknown ones are counted", () => {
    const plan = planFlowProposals({
      flows: [flow("V-101", "E-201"), flow("E-201", "P-310", { confidence: 0.2 }), flow("P-310", "V-101", { confidence: 3 }), flow("V-101", "P-310", { confidence: "high" })],
      roster, prior: [], docId: "kd1", revisionRead: null, pagesAttached: [1],
    });
    expect(plan.inserts.map((r) => r.confidence)).toEqual([null, 0.2, 1, null]);
    expect(plan.lowConfidence).toBe(3);
    expect(LOW_CONFIDENCE).toBe(0.5);
  });

  it("the page the model names maps to the attached page; at most 20 land per read and the rest are counted", () => {
    const many = buildRoster(Array.from({ length: 30 }, (_, i) => asset(i, "20")), units).roster;
    const flows = Array.from({ length: 25 }, (_, i) => ({ from: `A${i + 1}`, to: `A${i + 2}`, page: 2 }));
    const plan = planFlowProposals({ flows, roster: many, prior: [], docId: "kd1", revisionRead: null, pagesAttached: [4, 9] });
    expect(plan.inserts).toHaveLength(MAX_PROPOSALS_PER_READ);
    expect(plan.skippedOverLimit).toBe(5);
    expect(plan.inserts[0].source_page).toBe(9);
  });
});

describe("readNote — every reason a read came back short is named, on both branches (FLOW-11)", () => {
  const base: ReadOutcome = {
    proposed: 0, reproposed: 0, skippedConfirmed: 0, skippedDismissed: 0, skippedPending: 0, skippedUngrounded: 0,
    skippedDuplicate: 0, skippedOverLimit: 0, writeFailed: 0, pagesRead: [1, 2, 3, 4, 5, 6], pagesTotal: 40,
    pagesFailed: [], pagesNotRead: [], defaultPages: true, assetsOmitted: 0,
  };
  it("a 40-page book read by default: the zero branch says pages 1–6 of 40 and how to read the rest — it never blames the drawing", () => {
    const n = readNote(base);
    expect(n).toMatch(/^Read pages 1–6 of 40\. Only the first pages are read by default/);
    expect(n).toContain("No new flows were proposed.");
    expect(n).not.toMatch(/may not print flow arrows/);
  });
  it("the success branch says the same pages, and the skips, failed renders, write failures and the roster cut are named", () => {
    const n = readNote({
      ...base, proposed: 3, reproposed: 1, skippedConfirmed: 2, skippedDismissed: 1, skippedPending: 1, skippedUngrounded: 4,
      skippedDuplicate: 1, writeFailed: 1, pagesRead: [1, 2, 4], pagesFailed: [3], pagesNotRead: [41], defaultPages: false, assetsOmitted: 2900,
    });
    expect(n).toContain("Read pages 1–2, 4 of 40.");
    expect(n).toContain("Page 3 could not be rendered.");
    expect(n).toContain("Page 41 was not read");
    expect(n).toContain("3 flows proposed (1 re-proposed because the drawing has a new revision since it was dismissed)");
    expect(n).toContain("2 already on the map; 1 already awaiting review; 1 dismissed by a person");
    expect(n).toContain("4 named equipment the reader was not offered");
    expect(n).toContain("1 written by someone else while this read ran");
    expect(n).toContain("1 proposal could not be written.");
    expect(n).toContain("2900 registry equipment items were not offered to the reader");
  });
  it("pageList folds runs", () => {
    expect(pageList([6, 1, 2, 3, 9, 10])).toBe("1–3, 6, 9–10");
  });
});

describe("AREA-8 — flowReadCoverage: the flow drawings are the denominator, not every document on the shelf", () => {
  it("names a flow drawing by title or folder — whole words only", () => {
    for (const t of ["PFD", "P&ID 1", "P & ID-200", "PIDs", "20-PFD-001", "Process Flow Diagram Crude", "Block Flow Diagram", "Flowsheet", "Utility UFD", "pfd.pdf"]) {
      expect(namesFlowDrawing(t), t).toBe(true);
    }
    for (const t of ["rapid response", "Data sheet V-101", "Operating manual", "API 650 standard", "Spidery", ""]) {
      expect(namesFlowDrawing(t), t).toBe(false);
    }
    expect(namesFlowDrawing("20-XX-001", "Drawings", "PFDs", "Crude")).toBe(true);
    expect(namesFlowDrawing("20-XX-001", null, undefined)).toBe(false);
  });

  it("12 PFDs read beside 300 data sheets is DONE (12 of 12); the data sheets are said apart", () => {
    const ready = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `PFD-${i}` })),
      ...Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, name: `Data sheet ${i}` })),
    ];
    const read = new Set(Array.from({ length: 12 }, (_, i) => `p${i}`));
    expect(flowReadCoverage(ready, read)).toEqual({ readable: 12, read: 12, otherDocs: 300 });
  });

  it("a document already read for flows always counts (read and readable), whatever its name; an unread flow drawing holds the tick back", () => {
    const ready = [{ id: "m", name: "Operating manual" }, { id: "p", name: "Crude PFD" }, { id: "f", name: "20-XX-9", folderPath: ["P&IDs", "Crude"] }];
    expect(flowReadCoverage(ready, new Set(["m"]))).toEqual({ readable: 3, read: 1, otherDocs: 0 });
    expect(flowReadCoverage(ready, new Set())).toEqual({ readable: 2, read: 0, otherDocs: 1 });
  });
});
