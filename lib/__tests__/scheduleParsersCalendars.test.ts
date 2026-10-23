// @vitest-environment jsdom
//
// MS Project calendars → each task's working hours, so the shift report
// knows which crew works it from the schedule, not from its dates.

import { describe, it, expect } from "vitest";
import { parseScheduleFile } from "@/lib/scheduleParsers";
import { workShiftOf } from "@/lib/shiftReport";
import type { Milestone } from "@/types/schema";

const day = (n: number, from: string, to: string) =>
  `<WeekDay><DayType>${n}</DayType><DayWorking>1</DayWorking><WorkingTimes><WorkingTime><FromTime>${from}</FromTime><ToTime>${to}</ToTime></WorkingTime></WorkingTimes></WeekDay>`;
const week = (from: string, to: string) => [1, 2, 3, 4, 5, 6, 7].map((n) => day(n, from, to)).join("");
const task = (uid: number, name: string, cal = -1) => `<Task><UID>${uid}</UID><Name>${name}</Name><OutlineLevel>1</OutlineLevel><Start>2026-10-26T16:00:00</Start><Finish>2026-10-28T04:00:00</Finish><Duration>PT36H0M0S</Duration><CalendarUID>${cal}</CalendarUID></Task>`;
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>TAR</Name><CalendarUID>6</CalendarUID>
  <Calendars>
    <Calendar><UID>4</UID><Name>12-Hour Shift</Name><IsBaseCalendar>1</IsBaseCalendar><BaseCalendarUID>-1</BaseCalendarUID><WeekDays>${week("06:00:00", "18:00:00")}</WeekDays></Calendar>
    <Calendar><UID>6</UID><Name>24 Hours</Name><IsBaseCalendar>1</IsBaseCalendar><BaseCalendarUID>-1</BaseCalendarUID><WeekDays>${week("00:00:00", "00:00:00")}</WeekDays></Calendar>
    <Calendar><UID>8</UID><Name>Schultz - Tower</Name><IsBaseCalendar>0</IsBaseCalendar><BaseCalendarUID>6</BaseCalendarUID></Calendar>
    <Calendar><UID>9</UID><Name>Schultz 1</Name><IsBaseCalendar>0</IsBaseCalendar><BaseCalendarUID>4</BaseCalendarUID></Calendar>
  </Calendars>
  <Tasks>${task(1, "Open Internal Manways")}${task(2, "Pull bundle")}${task(3, "Project default")}${task(4, "Own calendar", 4)}</Tasks>
  <Resources><Resource><UID>4</UID><Name>Schultz - Tower</Name><CalendarUID>8</CalendarUID></Resource><Resource><UID>5</UID><Name>Schultz 1</Name><CalendarUID>9</CalendarUID></Resource></Resources>
  <Assignments><Assignment><TaskUID>1</TaskUID><ResourceUID>4</ResourceUID></Assignment><Assignment><TaskUID>2</TaskUID><ResourceUID>5</ResourceUID></Assignment></Assignments>
</Project>`;

describe("MS Project calendars set the crew", () => {
  const { rows, warnings } = parseScheduleFile("tar.xml", XML, { timeZone: "America/Los_Angeles" });
  const by = (n: string) => rows.find((r) => r.name === n)!;
  const crew = (n: string) => workShiftOf({ id: n, orgId: "o", name: n, plannedAt: by(n).plannedAt, plannedStartAt: by(n).plannedStartAt, durationHours: by(n).durationHours, attributes: by(n).attributes } as Milestone, "America/Los_Angeles");
  it("reads a resource's calendar through its base", () => {
    expect(by("Open Internal Manways").attributes).toMatchObject({ work_calendar: "Schultz - Tower", work_hours: "00:00-24:00" });
    expect(crew("Open Internal Manways")).toBe("both");
    expect(by("Pull bundle").attributes).toMatchObject({ work_calendar: "Schultz 1", work_hours: "06:00-18:00" });
    expect(crew("Pull bundle")).toBe("day");
  });
  it("a task's own calendar wins; no calendar or resource → the project's", () => {
    expect(by("Own calendar").attributes?.work_hours).toBe("06:00-18:00");
    expect(by("Project default").attributes?.work_calendar).toBe("24 Hours");
  });
  it("says so", () => {
    expect(warnings.join(" ")).toMatch(/Working hours read from the schedule's calendars for 4 tasks/);
  });
});
