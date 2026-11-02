// Findings: the close-out review's suggestions from the record (added
// scope, comments that say something went wrong, hold reasons, the team's
// lessons), reviewed once each; equipment read from the work orders, units
// respected; "From past jobs" for the next project; Ask's question reading.

import { describe, it, expect } from "vitest";
import type { Milestone, MilestoneNote } from "@/types/schema";
import { discoveryAttr, type DiscoveryRecord } from "@/lib/discovery";
import {
  suggestFindings, reviewState, equipmentOf, leadTag, tagsIn, tagKey, registryTagKey, guessTopic, guessKind,
  pastJobsFor, fieldsProblem, findingLine, draftKey, EQUIP_ID, EQUIP_TAG, EQUIP_NONE, type Finding,
} from "@/lib/findings";
import { matchWorkOrders, proposeTag, setupOrders, undecided, withEquipment, type RegistryAsset } from "@/lib/projectEquipment";
import { questionTags } from "@/lib/findingsAsk";

const T0 = Date.parse("2026-10-26T13:00:00Z");
const h = (n: number) => new Date(T0 + n * 3_600_000).toISOString();
const mk = (p: Partial<Milestone> & { id: string }): Milestone =>
  ({ orgId: "o", projectId: "p", name: p.id, weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);
const note = (id: string, milestoneId: string, kind: MilestoneNote["kind"], at: number, body: string, statusAt?: string): MilestoneNote =>
  ({ id, orgId: "o", milestoneId, kind, body, createdAt: h(at), createdBy: "u", createdByName: "Gabe", ...(statusAt ? { statusAt } : {}) } as MilestoneNote);
const rec = (id: string, what: string, hours: number, kind: "discovery" | "added" = "discovery"): DiscoveryRecord => ({
  id, kind, what, foundAt: T0 + 30 * 3_600_000, addedAt: T0 + 30 * 3_600_000, seq: 1, of: 1,
  impact: { hours, taskFinish: [0, 0], finish: [0, 0], critical: false, pushed: [] },
});

// The Transmix-1 shape: phase › group › equipment task › steps; a work
// order on its own task; discovery under V-7.
const ms: Milestone[] = [
  mk({ id: "maint", name: "Transmix-1 - Maintenance" }),
  mk({ id: "towers", name: "Towers", parentId: "maint" }),
  mk({ id: "v7", name: "V-7 - Transmix Fractionator", parentId: "towers" }),
  mk({ id: "trays", name: "Remove trays", parentId: "v7", status: "completed" }),
  mk({ id: "dc", name: "Clean downcomers", parentId: "v7", attributes: { discovery: discoveryAttr(rec("r1", "Unplanned clean downcomers", 40, "added")) } }),
  mk({ id: "exch", name: "Exchangers", parentId: "maint" }),
  mk({ id: "e12", name: "E-12 - Transmix Feed/Trans. Diesel Exchanger No. 2", parentId: "exch" }),
  mk({ id: "test", name: "Hydro test tube side", parentId: "e12" }),
  mk({ id: "wos", name: "Work Orders", parentId: "maint" }),
  mk({ id: "fg", name: "Clean fuel gas supply header to H-1", parentId: "wos", workOrderRef: "311388" }),
  mk({ id: "fg1", name: "Hydroblast piping", parentId: "fg", workOrderRef: "311388" }),
];
const notes: MilestoneNote[] = [
  note("n1", "test", "note", 60, "Discovered 20 of the required 24 seal ring replacements were ordered. Re-used 4 existing seal rings"),
  note("n2", "test", "note", 61, "Pulling seal rings to improvise the seal"),
  note("n3", "test", "note", 62, "Starting filling tube side for re-test"),
  note("n4", "test", "status", 50, "Progress → 50%", "in_progress"),
  note("n5", "test", "status", 55, "Leaks on shell side preventing tube side. Shell side pulled to repair leaks.", "on_hold"),
  note("n6", "test", "status", 58, "Progress → 60%", "in_progress"),
  note("n7", "trays", "note", 20, "LEL's detected in vessel. Crew stand down for air stripping the tower."),
  note("n8", "trays", "note", 21, "7 of 57 trays removed"),
  note("n9", "dc", "note", 31, "Added scope: Unplanned clean downcomers"),
  note("n10", "fg1", "note", 40, "Caltrol picked up to get calibrated. Expected back in 72hrs"),
  note("n11", "fg1", "note", 41, "Caltrol picked up expected back in 72 hrs."),
];
const byId = new Map(ms.map((m) => [m.id!, m]));

describe("equipment from the names", () => {
  it("reads the tag a task starts with, up the chain", () => {
    expect(leadTag("E-12 - Transmix Feed/Trans. Diesel Exchanger No. 2")).toBe("E-12");
    expect(leadTag("UIT-013 - Corilois Meter")).toBe("UIT-013");
    expect(leadTag("Transmix-1 - Maintenance")).toBeNull();
    expect(equipmentOf(byId.get("test")!, byId)).toEqual({ assetId: null, tag: "E-12" });
    expect(equipmentOf(byId.get("dc")!, byId)?.tag).toBe("V-7");
  });
  it("reads a tag inside a name, and what Setup saved wins", () => {
    expect(tagsIn("Piping replacement for P-7A/B discharge and FV-008 to FE-008")).toEqual(["P-7A", "FV-008", "FE-008"]);
    expect(proposeTag(byId.get("fg")!, byId)).toBe("H-1");
    const saved = mk({ id: "x", name: "E-12 - thing", attributes: { [EQUIP_TAG]: "E-12", [EQUIP_ID]: "a-e12" } });
    expect(equipmentOf(saved, new Map([["x", saved]]))).toEqual({ assetId: "a-e12", tag: "E-12" });
    const none = mk({ id: "y", name: "E-12 - thing", attributes: { [EQUIP_NONE]: true } });
    expect(equipmentOf(none, new Map([["y", none]]))).toBeNull();
  });
  it("one tag however it's typed; the registry's (code) left off", () => {
    expect(tagKey("V-7")).toBe(tagKey("v 7"));
    expect(registryTagKey("X-31 (2030.31)")).toBe(tagKey("X-31"));
  });
});

describe("suggestions from the record", () => {
  const drafts = suggestFindings({ milestones: ms, notes, unitCode: "55", lessons: [{ id: "l1", kind: "improve", text: "Get hot-work permits signed before the shift starts", at: T0 }] });
  const byBody = (t: string) => drafts.find((d) => d.body.startsWith(t));

  it("added scope: missed scope on its equipment, with the hours", () => {
    const d = byBody("Unplanned clean downcomers")!;
    expect(d).toMatchObject({ kind: "missed_scope", source: "discovery", appliesTo: "equipment", assetTag: "V-7", hours: 40, unitCode: "55", from: "Added scope", topic: "Planning" });
    // Its auto-written "Added scope: …" comment isn't suggested again.
    expect(drafts.filter((x) => /downcomers/.test(x.body))).toHaveLength(1);
  });
  it("comments that say something went wrong; not progress lines", () => {
    const seal = byBody("Discovered 20 of the required 24")!;
    expect(seal).toMatchObject({ kind: "material", topic: "Materials", assetTag: "E-12", source: "note", by: "Gabe" });
    expect(byBody("Pulling seal rings")).toBeDefined();
    expect(byBody("Starting filling")).toBeUndefined();
    expect(byBody("7 of 57")).toBeUndefined();
    expect(byBody("LEL's detected")?.topic).toBe("Safety");
  });
  it("a hold reason, with the hours it sat", () => {
    expect(byBody("Leaks on shell side")).toMatchObject({ source: "hold", hours: 3, assetTag: "E-12" });
  });
  it("the same thing said twice on the same equipment: once", () => {
    expect(drafts.filter((d) => /Caltrol/.test(d.body))).toHaveLength(1);
    expect(byBody("Caltrol")?.assetTag).toBe("H-1");
  });
  it("the team's close-out lessons apply to every job", () => {
    expect(byBody("Get hot-work permits")).toMatchObject({ kind: "lesson", appliesTo: "all", source: "lesson", topic: "Permits" });
  });
  it("the old Lessons learned box: a line each, headings left out", () => {
    const d = suggestFindings({ milestones: [], notes: [], lessonsLearned: "Change orders:\n- Scaffold requests went in a day late\n- ok" });
    expect(d.map((x) => x.body)).toEqual(["Scaffold requests went in a day late"]);
  });
  it("stable keys: the same record makes the same suggestion", () => {
    const again = suggestFindings({ milestones: ms, notes, unitCode: "55" });
    expect(again.map((d) => d.key)).toEqual(drafts.filter((d) => d.source !== "lesson").map((d) => d.key));
  });
});

describe("the review", () => {
  const drafts = suggestFindings({ milestones: ms, notes, unitCode: "55" });
  const row = (p: Partial<Finding>): Finding => ({
    id: "f1", orgId: "o", projectId: "p", kind: "problem", appliesTo: "project", topic: "Other", body: "x", nextTime: "",
    assetId: null, assetTag: null, unitCode: null, projectType: "Turnaround", milestoneId: null, workOrderRef: null, hours: null,
    source: "manual", sourceRef: null, status: "open", foundAt: T0, createdBy: null, createdByName: null, reviewedByName: null, reviewedAt: null, ...p,
  });
  it("a suggestion kept or dropped doesn't come back; + Finding entries wait to be reviewed", () => {
    const first = drafts[0];
    const st = reviewState(drafts, [
      row({ id: "k", source: first.source, sourceRef: first.sourceRef, status: "kept" }),
      row({ id: "m", body: "Crane was booked for the wrong day", status: "open" }),
      row({ id: "d", source: drafts[1].source, sourceRef: drafts[1].sourceRef, status: "dropped" }),
    ]);
    expect(st.toReview.some((x) => x.draft.key === first.key)).toBe(false);
    expect(st.toReview.some((x) => x.draft.key === drafts[1].key)).toBe(false);
    expect(st.toReview.some((x) => x.row?.id === "m")).toBe(true);
    expect(st.toReview).toHaveLength(drafts.length - 2 + 1);
    expect(st.kept.map((f) => f.id)).toEqual(["k"]);
    expect(st.dropped.map((f) => f.id)).toEqual(["d"]);
    expect(draftKey(first.source, first.sourceRef)).toBe(first.key);
  });
  it("can't keep one with nothing said, or equipment unnamed", () => {
    expect(fieldsProblem({ ...drafts[0], body: " " })).toBe("Say what happened.");
    expect(fieldsProblem({ ...drafts[0], appliesTo: "equipment", assetTag: null })).toBe("Pick the equipment.");
    expect(fieldsProblem({ ...drafts[0], appliesTo: "unit", unitCode: null })).toMatch(/unit in Setup/);
    expect(fieldsProblem(drafts[0])).toBeNull();
  });
  it("guesses type and topic from the words", () => {
    expect(guessKind("Only 20 of 24 seal rings were ordered", "manual")).toBe("material");
    expect(guessKind("Crane was booked for the wrong day", "manual")).toBe("problem");
    expect(guessTopic("Crane was booked for the wrong day")).toBe("Contractors");
    expect(guessTopic("Permit came late from operations")).toBe("Permits");
  });
});

describe("work orders matched to the registry, units respected", () => {
  const orders = setupOrders(ms);
  const registry: RegistryAsset[] = [
    { id: "a-v7", tag: "V-7", unitCode: "20" },
    { id: "a-e12", tag: "E-12", unitCode: "20" },
  ];
  it("a work order's steps with its number are one work order, on the task", () => {
    expect(orders.map((o) => o.owner.id)).toEqual(["fg", "e12", "v7"]);
  });
  it("V-7 and E-12 found under the Crude Unit: flagged as another unit; H-1 not in the registry", () => {
    const m = matchWorkOrders(orders, ms, registry, "55");
    const of = (id: string) => m.find((x) => x.ownerId === id)!;
    expect(of("v7")).toMatchObject({ tag: "V-7", state: "other_unit", otherUnit: true });
    expect(of("e12")).toMatchObject({ tag: "E-12", state: "other_unit" });
    expect(of("fg")).toMatchObject({ tag: "H-1", state: "not_in_registry", asset: null });
    expect(undecided(m)).toHaveLength(3);
  });
  it("the project's own unit first when both have the tag", () => {
    const m = matchWorkOrders(orders, ms, [...registry, { id: "a-v7b", tag: "V-7", unitCode: "55" }], "55");
    expect(m.find((x) => x.ownerId === "v7")).toMatchObject({ state: "found", otherUnit: false, asset: { id: "a-v7b" } });
  });
  it("what was just saved shows at once, before the schedule is read again", () => {
    const ms2 = withEquipment(ms, new Map([["v7", { assetId: "a-v7", tag: "V-7" }], ["fg", null]]));
    const m = matchWorkOrders(setupOrders(ms2), ms2, registry, "55");
    expect(m.find((x) => x.ownerId === "v7")?.state).toBe("linked");
    expect(m.find((x) => x.ownerId === "fg")?.state).toBe("none");
    expect(ms.find((x) => x.id === "v7")?.attributes).toBeUndefined();
  });
  it("saved: linked or no equipment, nothing left to confirm", () => {
    const saved = ms.map((x) => x.id === "v7" ? { ...x, attributes: { [EQUIP_TAG]: "V-7", [EQUIP_ID]: "a-v7" } } : x.id === "e12" || x.id === "fg" ? { ...x, attributes: { [EQUIP_NONE]: true } } : x);
    const m = matchWorkOrders(setupOrders(saved), saved, registry, "55");
    expect(m.find((x) => x.ownerId === "v7")).toMatchObject({ state: "linked", otherUnit: true });
    expect(m.find((x) => x.ownerId === "e12")?.state).toBe("none");
    expect(undecided(m)).toHaveLength(0);
  });
});

describe("from past jobs", () => {
  const f = (p: Partial<Finding>): Finding => ({
    id: Math.random().toString(36), orgId: "o", projectId: "old", kind: "problem", appliesTo: "equipment", topic: "Other", body: "x", nextTime: "",
    assetId: null, assetTag: null, unitCode: "55", projectType: "Turnaround", milestoneId: null, workOrderRef: null, hours: null,
    source: "manual", sourceRef: null, status: "kept", foundAt: T0, createdBy: null, createdByName: null, reviewedByName: null, reviewedAt: null, ...p,
  });
  const all = [
    f({ id: "seal", kind: "material", assetTag: "E-12", body: "Only 20 of 24 seal rings ordered", nextTime: "Order 24 plus spares", hours: 6 }),
    f({ id: "crude", assetTag: "E-12", unitCode: "20", body: "Crude E-12 tube leak" }),
    f({ id: "unit", appliesTo: "unit", body: "Transmix flare blinds take a full shift" }),
    f({ id: "all", appliesTo: "all", unitCode: null, body: "Orientation ate the first hour" }),
    f({ id: "cap", appliesTo: "all", unitCode: null, projectType: "Capital project", body: "Capital lesson" }),
    f({ id: "own", projectId: "new", assetTag: "E-12", body: "This project's own" }),
    f({ id: "open", status: "open", assetTag: "E-12", body: "Not reviewed" }),
  ];
  it("this project's equipment and unit, and every-job lessons of its kind; never its own or unreviewed", () => {
    const got = pastJobsFor(all, { projectId: "new", unitCode: "55", equipment: [{ assetId: null, tag: "E-12" }], projectType: "Turnaround" }).map((x) => x.id);
    expect(got.sort()).toEqual(["all", "seal", "unit"]);
  });
  it("by id wherever it's filed", () => {
    const got = pastJobsFor([f({ id: "byid", assetId: "a-e12", unitCode: "20" })], { projectId: "new", unitCode: "55", equipment: [{ assetId: "a-e12", tag: "E-12" }], projectType: "Turnaround" });
    expect(got.map((x) => x.id)).toEqual(["byid"]);
  });
  it("says it in one line", () => {
    expect(findingLine(all[0])).toBe("E-12 · Material · Only 20 of 24 seal rings ordered (6 h) · Next time: Order 24 plus spares");
  });
});

describe("Ask reads tags as people type them", () => {
  it("E-12, E12, e-12; not unit 55, WO 311388 or a year", () => {
    expect(questionTags("what about E-12 and e-17, E12?")).toEqual(["E-12", "E-17"]);
    expect(questionTags("warn me about the next Transmix TA in unit 55, WO 311388, October 2026")).toEqual([]);
    expect(questionTags("V 7 downcomers")).toEqual(["V-7"]);
  });
});
