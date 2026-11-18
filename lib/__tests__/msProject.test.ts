import { describe, it, expect } from "vitest";
import { msProjectXml, mspDuration, mspTime, type MspTask } from "@/lib/msProject";

const tz = "America/Los_Angeles";
const times = { dayStart: "06:00", nightStart: "18:00" };
const at = (s: string) => Date.parse(s);

describe("a schedule as a Microsoft Project file", () => {
  const tasks: MspTask[] = [
    { key: "wo:1", name: "WO 301235 · V-7 & <tower>", level: 1, summary: true, start: at("2026-10-26T06:00:00-07:00"), finish: at("2026-10-27T18:00:00-07:00"), hours: 0, cal: "both" },
    { key: "a", name: "Open manways", level: 2, start: at("2026-10-26T06:00:00-07:00"), finish: at("2026-10-26T18:00:00-07:00"), hours: 12, cal: "day", snet: at("2026-10-26T06:00:00-07:00"), resource: "Schultz" },
    { key: "b", name: "Clean tower", level: 2, start: at("2026-10-27T06:00:00-07:00"), finish: at("2026-10-27T18:00:00-07:00"), hours: 12, cal: "day", preds: ["a"], resource: "Ancon", notes: "off site" },
  ];
  const xml = msProjectXml({ title: "Transmix, suggested schedule", tz, times, tasks });
  it("work orders over their steps, links, crews, the plant's calendars", () => {
    expect(xml).toContain("<OutlineNumber>1</OutlineNumber><OutlineLevel>1</OutlineLevel>");
    expect(xml).toContain("<OutlineNumber>1.2</OutlineNumber><OutlineLevel>2</OutlineLevel>");
    expect(xml).toContain("<PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type>");
    expect(xml).toContain("<Name>Day shift</Name>");
    expect(xml).toContain("<FromTime>06:00:00</FromTime><ToTime>18:00:00</ToTime>");
    expect(xml).toContain("<Resource><UID>1</UID><ID>1</ID><Name>Schultz</Name>");
    expect(xml).toContain("WO 301235 · V-7 &amp; &lt;tower&gt;");
    // Held no earlier than its suggested start, on the day calendar.
    expect(xml).toContain("<ConstraintType>4</ConstraintType><CalendarUID>2</CalendarUID><ConstraintDate>2026-10-26T06:00:00</ConstraintDate>");
  });
  it("times on the plant's clock; durations as Project writes them", () => {
    expect(mspTime(at("2026-10-26T13:00:00Z"), tz)).toBe("2026-10-26T06:00:00");
    expect(mspDuration(12.5)).toBe("PT12H30M0S");
  });
  it("around-the-clock time across the night the clocks go back is wall-clock hours", () => {
    const x = msProjectXml({ title: "t", tz, times, tasks: [{ key: "x", name: "Introduce feed", level: 2, start: at("2026-10-31T21:00:00-07:00"), finish: at("2026-11-01T03:00:00-08:00"), hours: 7, cal: "both" }] });
    expect(x).toContain("<Duration>PT6H0M0S</Duration>");
  });
});
