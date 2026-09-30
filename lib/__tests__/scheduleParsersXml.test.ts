// @vitest-environment jsdom
//
// End-to-end verification of MS Project XML ingestion: the format that carries
// the rich data (.mpp can't). Proves dependencies, resources, user-defined
// custom columns, deadlines, milestones, hierarchy and % complete all survive
// the parse. Runs in jsdom so the parser's browser DOMParser is available —
// the same engine used at runtime in the (client-side) import modal.

import { describe, it, expect } from "vitest";
import { parseScheduleFile } from "@/lib/scheduleParsers";

const MSPROJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>Unit 200 Turnaround</Name>
  <ExtendedAttributes>
    <ExtendedAttribute>
      <FieldID>188743731</FieldID>
      <FieldName>Text1</FieldName>
      <Alias>Contractor</Alias>
    </ExtendedAttribute>
    <ExtendedAttribute>
      <FieldID>188743732</FieldID>
      <FieldName>Text2</FieldName>
      <Alias>Area</Alias>
    </ExtendedAttribute>
  </ExtendedAttributes>
  <Tasks>
    <Task>
      <UID>1</UID>
      <Name>Mobilize crew</Name>
      <Start>2026-06-01T08:00:00</Start>
      <Finish>2026-06-03T17:00:00</Finish>
      <OutlineLevel>1</OutlineLevel>
      <PercentComplete>50</PercentComplete>
      <ExtendedAttribute><FieldID>188743731</FieldID><Value>Acme Mechanical</Value></ExtendedAttribute>
      <ExtendedAttribute><FieldID>188743732</FieldID><Value>North flare</Value></ExtendedAttribute>
    </Task>
    <Task>
      <UID>2</UID>
      <Name>Install PSV-201</Name>
      <Start>2026-06-04T08:00:00</Start>
      <Finish>2026-06-04T17:00:00</Finish>
      <OutlineLevel>1</OutlineLevel>
      <Milestone>1</Milestone>
      <Deadline>2026-06-05T17:00:00</Deadline>
      <PredecessorLink><PredecessorUID>1</PredecessorUID></PredecessorLink>
    </Task>
  </Tasks>
  <Resources>
    <Resource><UID>10</UID><Name>Acme Mechanical</Name><Group>Contractor</Group></Resource>
  </Resources>
  <Assignments>
    <Assignment><TaskUID>1</TaskUID><ResourceUID>10</ResourceUID></Assignment>
  </Assignments>
</Project>`;

describe("MS Project XML ingestion", () => {
  const result = parseScheduleFile("turnaround.xml", MSPROJECT_XML);
  const byName = (n: string) => result.rows.find((r) => r.name === n);

  it("detects the format and parses both tasks", () => {
    expect(result.format).toBe("msproject-xml");
    expect(result.rows.length).toBe(2);
  });

  it("extracts the resource/contractor assignment", () => {
    const t = byName("Mobilize crew")!;
    expect(t.responsibleParty).toBe("Acme Mechanical");
    expect(t.responsibleOrg).toBe("Contractor");
  });

  it("captures user-defined custom columns by their alias", () => {
    const t = byName("Mobilize crew")!;
    expect(t.attributes?.Contractor).toBe("Acme Mechanical");
    expect(t.attributes?.Area).toBe("North flare");
  });

  it("carries the linked dependency (predecessor)", () => {
    const t = byName("Install PSV-201")!;
    expect(t.dependsOnExternalRefs).toContain("msp-uid:1");
  });

  it("flags milestones and captures deadlines", () => {
    const t = byName("Install PSV-201")!;
    expect(t.attributes?.milestone).toBe("1");
    expect(t.attributes?.deadline_at).toBeTruthy();
    expect(new Date(t.attributes!.deadline_at as string).getUTCFullYear()).toBe(2026);
  });

  it("keeps exact dates and percent complete", () => {
    const t = byName("Mobilize crew")!;
    expect(t.percentComplete).toBe(50);
    expect(t.plannedStartAt).toBeTruthy();
    expect(new Date(t.plannedStartAt as string).getUTCMonth()).toBe(5); // June
    expect(t.externalRef).toBe("msp-uid:1");
  });
});

// ─── projects Round G ───────────────────────────────────────────────────────

import { shiftForStart } from "@/lib/scheduleFilter";

describe("SCHED-1 · the project-summary row (UID 0 / OutlineLevel 0) is the root parent, not a sibling leaf", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Tasks>
    <Task><UID>0</UID><Name>Unit 200 Turnaround</Name><Start>2026-06-01T08:00:00</Start><Finish>2026-06-30T17:00:00</Finish><OutlineLevel>0</OutlineLevel><Summary>1</Summary><PercentComplete>40</PercentComplete></Task>
    <Task><UID>1</UID><Name>Phase A</Name><Start>2026-06-01T08:00:00</Start><Finish>2026-06-10T17:00:00</Finish><OutlineLevel>1</OutlineLevel><Summary>1</Summary></Task>
    <Task><UID>2</UID><Name>Task A1</Name><Start>2026-06-01T08:00:00</Start><Finish>2026-06-03T17:00:00</Finish><OutlineLevel>2</OutlineLevel><Work>PT40H0M0S</Work></Task>
    <Task><UID>3</UID><Name>Phase B</Name><Start>2026-06-11T08:00:00</Start><Finish>2026-06-30T17:00:00</Finish><OutlineLevel>1</OutlineLevel><Summary>1</Summary></Task>
    <Task><UID>4</UID><Name>Task B1</Name><Start>2026-06-11T19:00:00</Start><Finish>2026-06-12T05:00:00</Finish><OutlineLevel>2</OutlineLevel><Duration>PT8H0M0S</Duration></Task>
  </Tasks>
</Project>`;
  const res = parseScheduleFile("ta.xml", xml);
  const byName = (n: string) => res.rows.find((r) => r.name === n)!;

  it("the level-0 row survives as level 0 → root, and the phases are its children", () => {
    expect(byName("Unit 200 Turnaround").parentExternalRef).toBeNull();
    expect(byName("Unit 200 Turnaround").outlineLevel).toBe(1);
    expect(byName("Phase A").parentExternalRef).toBe("msp-uid:0");
    expect(byName("Phase B").parentExternalRef).toBe("msp-uid:0");
    expect(byName("Phase A").outlineLevel).toBe(2);
    expect(byName("Task A1").parentExternalRef).toBe("msp-uid:1");
    expect(byName("Task B1").parentExternalRef).toBe("msp-uid:3");
    expect(res.warnings.some((w) => /project-summary row .* root parent/.test(w))).toBe(true);
  });

  it("SCHED-2: <Work> and <Duration> reach durationHours; summaries carry none", () => {
    expect(byName("Task A1").durationHours).toBe(40);
    expect(byName("Task B1").durationHours).toBe(8);
    expect(byName("Phase A").durationHours).toBeNull();
    expect(byName("Task A1").attributes?.work).toBe("PT40H0M0S");
  });

  it("SCHED-9: offset-less times get Z, so the shift label is the same on every machine (08:00 → day, 19:00 → night)", () => {
    expect(byName("Task A1").plannedStartAt).toBe("2026-06-01T08:00:00Z");
    expect(byName("Task B1").plannedStartAt).toBe("2026-06-11T19:00:00Z");
    const tz = process.env.TZ;
    try {
      for (const zone of ["Asia/Kolkata", "America/Los_Angeles", "Pacific/Auckland", "UTC"]) {
        process.env.TZ = zone;
        expect(shiftForStart(byName("Task A1").plannedStartAt)).toBe("day");
        expect(shiftForStart(byName("Task B1").plannedStartAt)).toBe("night");
        // The old reading (no Z) parsed as local time; from UTC+5:30 19:00 became 13:30Z = "day".
        expect(new Date("2026-06-11T19:00:00Z").getUTCHours()).toBe(19);
      }
    } finally { process.env.TZ = tz; }
  });

  it("a level without OutlineLevel is still level 1 (NaN test, not truthiness)", () => {
    const flat = parseScheduleFile("flat.xml", `<Project xmlns="http://schemas.microsoft.com/project"><Tasks><Task><UID>7</UID><Name>Only</Name><Finish>2026-06-30T17:00:00</Finish></Task></Tasks></Project>`);
    expect(flat.rows[0].outlineLevel).toBe(1);
  });
});

describe("SCHED-1 · a dropped row clears its level so a deeper row cannot inherit a stale parent", () => {
  it("the child of a dropped level-2 row does not attach to the previous level-2 sibling", () => {
    const xml = `<Project xmlns="http://schemas.microsoft.com/project"><Tasks>
      <Task><UID>1</UID><Name>Phase</Name><Finish>2026-06-30T17:00:00</Finish><OutlineLevel>1</OutlineLevel></Task>
      <Task><UID>2</UID><Name>Sub A</Name><Finish>2026-06-10T17:00:00</Finish><OutlineLevel>2</OutlineLevel></Task>
      <Task><UID>3</UID><Name>Sub B (undated)</Name><OutlineLevel>2</OutlineLevel></Task>
      <Task><UID>4</UID><Name>Leaf under B</Name><Finish>2026-06-20T17:00:00</Finish><OutlineLevel>3</OutlineLevel></Task>
    </Tasks></Project>`;
    const res = parseScheduleFile("drop.xml", xml);
    const leaf = res.rows.find((r) => r.name === "Leaf under B")!;
    expect(leaf.parentExternalRef).not.toBe("msp-uid:2");
    expect(leaf.parentExternalRef).toBeNull();
    expect(res.warnings.some((w) => /1 task skipped \(missing name or date\)/.test(w))).toBe(true);
  });
});

describe("SCH-8 · MS Project XML PredecessorLink Type + LinkLag", () => {
  it("SS with lag is recorded, not turned into an FS edge; FS lag is recorded on the task", () => {
    const xml = `<Project xmlns="http://schemas.microsoft.com/project"><Tasks>
      <Task><UID>1</UID><Name>A</Name><Finish>2026-06-03T17:00:00</Finish></Task>
      <Task><UID>2</UID><Name>B</Name><Finish>2026-06-05T17:00:00</Finish>
        <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>3</Type><LinkLag>4800</LinkLag><LagFormat>7</LagFormat></PredecessorLink>
      </Task>
      <Task><UID>3</UID><Name>C</Name><Finish>2026-06-08T17:00:00</Finish>
        <PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type><LinkLag>600</LinkLag></PredecessorLink>
        <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>0</Type><LinkLag>0</LinkLag></PredecessorLink>
      </Task>
    </Tasks></Project>`;
    const res = parseScheduleFile("links.xml", xml);
    const b = res.rows.find((r) => r.name === "B")!;
    expect(b.dependsOnExternalRefs).toBeUndefined();
    expect(b.links).toEqual([{ predecessorExternalRef: "msp-uid:1", type: "SS", lagHours: 8 }]);
    expect(b.attributes?.source_links).toBe("SS msp-uid:1 +8h");
    const c = res.rows.find((r) => r.name === "C")!;
    expect(c.dependsOnExternalRefs).toEqual(["msp-uid:2"]);
    expect(c.attributes?.source_links).toBe("FS msp-uid:2 +1h; FF msp-uid:1");
    expect(res.links).toEqual({ fs: 1, notEnforced: 2, withLag: 1, unresolved: 0 });
  });
});

describe("P6 XML · SCHED-6 project choice and SCH-8 relationship types", () => {
  const p6 = `<?xml version="1.0" encoding="UTF-8"?>
<APIBusinessObjects xmlns="http://xmlns.oracle.com/Primavera/P6/V8.3/API/BusinessObjects">
  <Project><ObjectId>100</ObjectId><Id>U100</Id><Name>Unit 100</Name>
    <WBS><ObjectId>1</ObjectId><Name>U100 Root</Name></WBS>
    <Activity><ObjectId>10</ObjectId><Id>A1000</Id><Name>Isolate</Name><WBSObjectId>1</WBSObjectId><PlannedStartDate>2026-06-01T07:00:00</PlannedStartDate><PlannedFinishDate>2026-06-02T17:00:00</PlannedFinishDate><PlannedDuration>16</PlannedDuration></Activity>
    <Activity><ObjectId>11</ObjectId><Id>A1010</Id><Name>Purge</Name><WBSObjectId>1</WBSObjectId><PlannedStartDate>2026-06-02T07:00:00</PlannedStartDate><PlannedFinishDate>2026-06-03T17:00:00</PlannedFinishDate></Activity>
    <Relationship><ObjectId>500</ObjectId><PredecessorActivityObjectId>10</PredecessorActivityObjectId><SuccessorActivityObjectId>11</SuccessorActivityObjectId><Type>Start to Start</Type><Lag>8</Lag></Relationship>
    <Relationship><ObjectId>501</ObjectId><PredecessorActivityObjectId>10</PredecessorActivityObjectId><SuccessorActivityObjectId>11</SuccessorActivityObjectId><Type>Finish to Finish</Type><Lag>0</Lag></Relationship>
  </Project>
  <Project><ObjectId>200</ObjectId><Id>U200</Id><Name>Unit 200</Name>
    <WBS><ObjectId>2</ObjectId><Name>U200 Root</Name></WBS>
    <Activity><ObjectId>20</ObjectId><Id>B1000</Id><Name>Other unit</Name><WBSObjectId>2</WBSObjectId><PlannedFinishDate>2026-06-09T17:00:00</PlannedFinishDate></Activity>
  </Project>
  <BaselineProject><ObjectId>900</ObjectId>
    <Activity><ObjectId>90</ObjectId><Name>Baseline copy</Name><PlannedFinishDate>2026-06-09T17:00:00</PlannedFinishDate></Activity>
  </BaselineProject>
</APIBusinessObjects>`;

  it("two <Project> elements: rows are withheld until one is chosen, and the count is reported", () => {
    const res = parseScheduleFile("eps.xml", p6);
    expect(res.format).toBe("p6-xml");
    expect(res.needsProjectChoice).toBe(true);
    expect(res.rows).toEqual([]);
    expect(res.projects).toEqual([{ id: "100", name: "Unit 100", rows: 2 }, { id: "200", name: "Unit 200", rows: 1 }]);
  });

  it("with a choice, only that project's WBS + activities come through (baseline copies excluded)", () => {
    const res = parseScheduleFile("eps.xml", p6, { projectId: "100" });
    expect(res.selectedProjectId).toBe("100");
    expect(res.rows.map((r) => r.name).sort()).toEqual(["Isolate", "Purge", "U100 Root"]);
  });

  it("an SS + FF pair between two activities creates NO edge (no cycle), is recorded with lag, and PlannedDuration reaches durationHours", () => {
    const res = parseScheduleFile("eps.xml", p6, { projectId: "100" });
    const purge = res.rows.find((r) => r.name === "Purge")!;
    const isolate = res.rows.find((r) => r.name === "Isolate")!;
    expect(purge.dependsOnExternalRefs).toBeUndefined();
    expect(isolate.dependsOnExternalRefs).toBeUndefined();
    expect(purge.links).toEqual([
      { predecessorExternalRef: "p6-act:10", type: "SS", lagHours: 8 },
      { predecessorExternalRef: "p6-act:10", type: "FF", lagHours: 0 },
    ]);
    expect(purge.attributes?.source_links).toBe("SS p6-act:10 +8h; FF p6-act:10");
    expect(res.links).toEqual({ fs: 0, notEnforced: 2, withLag: 0, unresolved: 0 });
    expect(isolate.durationHours).toBe(16);
    expect(isolate.plannedStartAt).toBe("2026-06-01T07:00:00Z");
  });
});

describe("SCH-1 · XML dates are ISO, so a slash date in a note never withholds the file", () => {
  it("an MS Project XML whose <Notes> holds '3/4/2026' imports without the date question", () => {
    const xml = `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><SaveDate>2026-01-01T00:00:00</SaveDate><Tasks>
      <Task><UID>1</UID><Name>A</Name><Start>2026-06-01T08:00:00</Start><Finish>2026-06-02T17:00:00</Finish><OutlineLevel>1</OutlineLevel><Notes>see memo 3/4/2026</Notes></Task>
    </Tasks></Project>`;
    const res = parseScheduleFile("plan.xml", xml);
    expect(res.format).toBe("msproject-xml");
    expect(res.needsDateConvention).toBeUndefined();
    expect(res.dates).toEqual({ convention: null, decidedBy: "none", sample: null });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].plannedStartAt).toBe("2026-06-01T08:00:00Z");
  });
});

describe("SCHED-9 · an unreadable Start in MS Project XML is counted like an unreadable Finish", () => {
  it("the row is skipped and reported, never imported without the start it carried", () => {
    const xml = `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><Tasks>
      <Task><UID>1</UID><Name>A</Name><Start>not a date</Start><Finish>2026-06-01T17:00:00</Finish><OutlineLevel>1</OutlineLevel></Task>
      <Task><UID>2</UID><Name>B</Name><Start>2026-06-01T08:00:00</Start><Finish>2026-06-01T17:00:00</Finish><OutlineLevel>1</OutlineLevel></Task>
    </Tasks></Project>`;
    const res = parseScheduleFile("plan.xml", xml);
    expect(res.rows.map((r) => [r.name, r.plannedStartAt])).toEqual([["B", "2026-06-01T08:00:00Z"]]);
    expect(res.warnings).toContain("1 task skipped (a start or finish date could not be read).");
  });
});
