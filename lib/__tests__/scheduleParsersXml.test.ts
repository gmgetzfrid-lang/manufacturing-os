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
      <UID>0</UID>
      <Name>Unit 200 Turnaround</Name>
      <Start>2026-06-01T08:00:00</Start>
      <Finish>2026-06-04T17:00:00</Finish>
      <OutlineLevel>0</OutlineLevel>
      <Summary>1</Summary>
    </Task>
    <Task>
      <UID>1</UID>
      <Name>Mobilize crew</Name>
      <Start>2026-06-01T08:00:00</Start>
      <Finish>2026-06-03T17:00:00</Finish>
      <OutlineLevel>1</OutlineLevel>
      <PercentComplete>50</PercentComplete>
      <Duration>PT24H0M0S</Duration>
      <Work>PT36H0M0S</Work>
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
      <Duration>PT4H30M0S</Duration>
      <Work>PT0H0M0S</Work>
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

  it("does not import the project summary row (UID 0) as a task", () => {
    expect(byName("Unit 200 Turnaround")).toBeUndefined();
    expect(result.rows.map((r) => r.externalRef)).not.toContain("msp-uid:0");
    expect(result.rows).toHaveLength(2);
    // Real top-level tasks keep their level and have no phantom parent.
    expect(byName("Mobilize crew")!.parentExternalRef).toBeNull();
  });

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

  it("reads real hours: <Work> when resourced, else <Duration>", () => {
    expect(byName("Mobilize crew")!.durationHours).toBe(36);   // Work wins over Duration
    expect(byName("Install PSV-201")!.durationHours).toBe(4.5); // zero Work → Duration
  });
});
