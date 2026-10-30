// The hourly shift log as a file: the same hours the report shows, an
// hour never written said from its entries, every shift of the job in one
// file \u2014 PDF and Word on the letterhead, Excel one item a row.

import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { extractText } from "unpdf";
import { jobLogs, logSteps, shiftLog, exportedLabel, clockAt, type ShiftLog } from "@/lib/hourlyLog";
import { hourlyLogDocx, hourlyLogPdf, hourlyLogTable, hourlyLogXlsx, entryParas } from "@/lib/hourlyLogFiles";
import { shiftWindow, type ShiftTimes } from "@/lib/shiftReport";
import type { ShiftRecord } from "@/lib/shiftRecord";
import type { TimeLogRow } from "@/lib/timeLog";
import type { Letterhead } from "@/lib/letterhead";
import type { Milestone } from "@/types/schema";

const TZ = "America/Los_Angeles";
const TIMES: ShiftTimes = { dayStart: "06:00", nightStart: "18:00", meetingBefore: 30, breaks: [{ shift: "day", start: "12:00", minutes: 30, label: "Lunch" }] };
const DAY = shiftWindow("2026-10-29", "day", TZ, TIMES);
const H = 3_600_000;
const at = (h: number, m = 0) => DAY.start + h * H + m * 60_000;
const row = (t: number, p: Partial<TimeLogRow>): TimeLogRow => ({ at: t, shift: "", task: "V-7", wo: "", step: "Clean Tower", crew: "Ancon", what: "Started", pct: "", comment: "", enteredBy: "", enteredAt: null, id: "s1", ...p });
const mk = (p: Partial<Milestone> & { id: string }): Milestone => ({ orgId: "o", projectId: "p", name: p.id, weight: 1, status: "planned", source: "msproject", createdBy: "u", ...p } as Milestone);
const MS = [
  mk({ id: "v7", name: "V-7 - Tower" }),
  mk({ id: "s1", parentId: "v7", name: "Clean Tower", responsibleParty: "Ancon", plannedStartAt: new Date(at(0)).toISOString(), plannedAt: new Date(at(30)).toISOString() }),
  mk({ id: "s2", parentId: "v7", name: "Install Manways", responsibleParty: "Schultz", plannedStartAt: new Date(at(0)).toISOString(), plannedAt: new Date(at(8)).toISOString() }),
];
const record: ShiftRecord = {
  crews: { Schultz: { supervisor: "Mike Leonard", headcount: 12 } },
  hourly: { v: 2, lines: [{ id: "a", at: at(1), text: "Ancon started cleaning the tower on V-7.", hand: true }, { id: "b", at: at(3), text: "Written for them earlier", src: "x" }] },
};
const rows = [row(at(1, 10), {}), row(at(3, 20), { id: "s2", step: "Install Manways", crew: "Schultz", what: "Done", comment: "All 4 in" })];
// Schultz's step was started before the shift, and nothing new on it until 9:20.
const log = [{ milestone_id: "s2", at: new Date(at(-2)).toISOString(), new_status: "in_progress" }, { milestone_id: "s1", at: new Date(at(1, 10)).toISOString(), new_status: "in_progress" }];

const one = () => shiftLog({ shift: DAY, tz: TZ, times: TIMES, record, rows, steps: logSteps(MS, TZ, TIMES), log, now: DAY.end + H });

describe("one shift's hourly log", () => {
  it("the meeting, permitting, each hour and its break, in AM / PM", () => {
    const l = one();
    expect(l.title).toBe("Day shift");
    expect(l.date).toBe("Thu, Oct 29, 2026");
    expect(l.window).toBe("6:00 AM to 6:00 PM");
    expect(l.through).toBeUndefined();
    expect(l.entries.map((e) => e.clock).slice(0, 3)).toEqual(["5:30 AM", "6:00 AM", "7:00 AM"]);
    expect(l.entries[0]).toMatchObject({ kind: "meeting", title: "Shift meeting" });
    expect(l.entries[1]).toMatchObject({ kind: "permit", title: "Start of shift - permitting" });
    expect(l.entries.find((e) => e.kind === "break")).toMatchObject({ clock: "12:00 PM", title: "Lunch, 30 min" });
    // 5:30 PM is the next shift's meeting: the last hour runs 5:00 to 5:30.
    expect(l.entries[l.entries.length - 1].clock).toBe("5:00 PM");
  });

  it("attendance as entered, crews that worked without it as -", () => {
    expect(one().entries[0].lines).toEqual(["Schultz: Mike Leonard · 12 on site", "Ancon: -"]);
  });

  it("an hour typed over, as typed; the others say their entries", () => {
    const l = one();
    expect(l.entries.find((e) => e.clock === "7:00 AM")?.lines).toEqual(["Ancon started cleaning the tower on V-7."]);
    expect(l.entries.find((e) => e.clock === "9:00 AM")?.lines).toEqual(["9:20 AM Schultz: V-7 Install Manways done. All 4 in."]);
  });

  it("what kept going, each hour nothing new was entered for it", () => {
    const l = one();
    expect(l.entries.find((e) => e.clock === "6:00 AM")?.continuing).toEqual(["Schultz - V-7 Install Manways"]);
    expect(l.entries.find((e) => e.clock === "8:00 AM")?.continuing).toEqual(["Ancon - V-7 Clean Tower", "Schultz - V-7 Install Manways"]);
  });

  it("a shift still going: up to now, and says so", () => {
    const l = shiftLog({ shift: DAY, tz: TZ, times: TIMES, record, rows, steps: [], log: [], now: at(2, 15) });
    expect(l.through).toBe("8:15 AM");
    expect(l.entries[l.entries.length - 1].clock).toBe("8:00 AM");
  });

  it("midnight is 12:00 AM, and the export says when", () => {
    expect(clockAt(shiftWindow("2026-10-29", "night", TZ, TIMES).start + 6 * H, TZ)).toBe("12:00 AM");
    expect(exportedLabel(at(1, 10), TZ)).toBe("Exported Oct 29, 2026 7:10 AM");
  });
});

describe("every shift of the job", () => {
  it("first to last, only shifts with something in them", () => {
    const records = new Map([["2026-10-29:day", record]]);
    const later = row(at(13), { comment: "", what: "Progress", pct: "10% → 20%" });
    const logs = jobLogs({ milestones: MS, timeLog: [...rows, later], records, log: [], tz: TZ, times: TIMES, now: at(14) });
    expect(logs.map((l) => l.key)).toEqual(["2026-10-29:day", "2026-10-29:night"]);
    expect(logs[1].through).toBe("8:00 PM");
  });
  it("nothing logged: nothing to export", () => {
    expect(jobLogs({ milestones: MS, timeLog: [], records: new Map(), log: [], tz: TZ, times: TIMES, now: at(1) })).toEqual([]);
  });
});

// A letterhead with page 1's own (address) and a logo on every page.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const LH: Letterhead = {
  v: 1, name: "lh.docx", kind: "docx", page: { w: 8.5, h: 11 }, margins: { top: 1.7, right: 1, bottom: 0.8, left: 1 }, pages: "all",
  layer: { floats: [{ x: 1, y: 0.5, w: 2.3, h: 0.78, src: PNG }] },
  first: { floats: [{ x: 1, y: 0.5, w: 2.3, h: 0.78, src: PNG }], header: { x: 1, w: 6.5, top: 0.5, floats: [], items: [{ p: { align: "right", runs: [{ tab: true }, { t: "7724 E. Panama Lane", pt: 10, font: "Lato" }] } }] } },
};
const OPTS = { project: "Transmix-1 TA", lh: LH, exported: "Exported Oct 30, 2026 7:10 AM" };
const two = (): ShiftLog[] => [one(), { ...one(), key: "2026-10-29:night", title: "Night shift" }];

describe("the files", () => {
  it("a row's text: its name, what happened, what kept going", () => {
    const e = one().entries;
    expect(entryParas(e[1]).map((p) => p.style)).toEqual(["title", "cont"]);
    expect(entryParas({ clock: "x", kind: "work", lines: [], continuing: [] })).toEqual([{ text: "Nothing logged", style: "muted" }]);
  });

  it("PDF: each shift on its own pages, the letterhead on them, no em dash", async () => {
    const bytes = await hourlyLogPdf(two(), OPTS);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
    const { text } = await extractText(bytes, { mergePages: false });
    expect(text[0]).toContain("7724 E. Panama Lane");
    expect(text[0]).toContain("Day shift · Thu, Oct 29, 2026");
    expect(text[0]).toContain("Schultz: Mike Leonard · 12 on site");
    expect(text[text.length - 1]).toContain("Night shift");
    expect(text.join("\n")).not.toMatch(/\u2014|\b1[3-9]:\d\d\b|\b2[0-3]:\d\d\b/);
  });

  it("PDF without a letterhead: plain margins, page numbers", async () => {
    const { text } = await extractText(await hourlyLogPdf([one()], { ...OPTS, lh: null }), { mergePages: true });
    expect(text).toContain("Page 1 of 1");
  });

  it("Word: page 1 of each shift with page 1's letterhead, the rest the repeating one", async () => {
    const zip = await JSZip.loadAsync(await hourlyLogDocx(two(), OPTS));
    const doc = await zip.file("word/document.xml")!.async("string");
    expect(doc.match(/<w:sectPr>/g)).toHaveLength(2);
    expect(doc).toContain('w:type="first"');
    expect(doc).toContain("<w:titlePg/>");
    expect(doc).toContain("Schultz: Mike Leonard · 12 on site");
    expect(doc).toContain("<w:tblHeader/>");
    expect(doc).not.toContain("\u2014");
    const first = await zip.file("word/header2.xml")!.async("string");
    expect(first).toContain("7724 E. Panama Lane");
    expect(first).toContain("<wp:anchor");
    expect(zip.file("word/_rels/header2.xml.rels")).toBeTruthy();
    expect(Object.keys(zip.files).some((f) => f.startsWith("word/media/image1."))).toBe(true);
    const ct = await zip.file("[Content_Types].xml")!.async("string");
    expect(ct).toContain("/word/header1.xml");
  });

  it("Excel: one item a row, with its date, shift and time", async () => {
    const t = hourlyLogTable([one()]);
    expect(t[0]).toEqual(["Thu, Oct 29, 2026", "Day shift", "5:30 AM", "Meeting", "Schultz: Mike Leonard · 12 on site"]);
    expect(t).toContainEqual(["Thu, Oct 29, 2026", "Day shift", "12:00 PM", "Break", "Lunch, 30 min"]);
    expect(t).toContainEqual(["Thu, Oct 29, 2026", "Day shift", "8:00 AM", "In progress", "Ancon - V-7 Clean Tower"]);
    const XLSX = await import("xlsx");
    const wb = XLSX.read(await hourlyLogXlsx([one()], OPTS), { type: "array" });
    const back = XLSX.utils.sheet_to_json<string[]>(wb.Sheets["Hourly log"], { header: 1 });
    expect(back[3]).toEqual(["Date", "Shift", "Time", "Type", "What happened"]);
    expect(back.length).toBe(4 + t.length);
  });
});

describe("when the job starts", () => {
  it("the first planned or baseline start on the schedule", async () => {
    const { jobStartOf } = await import("@/components/projects/JobStartContext");
    expect(jobStartOf([{ plannedStartAt: "2026-10-25T13:00:00Z" }, { plannedStartAt: "2026-10-24T21:00:00Z", baselineStartAt: "2026-10-24T21:00:00Z" }, { plannedStartAt: null }]))
      .toBe(Date.parse("2026-10-24T21:00:00Z"));
    expect(jobStartOf([])).toBeUndefined();
  });
  it("the whole-job log starts at the first entry, not the log's own lines for steps being made", () => {
    const made = [{ milestone_id: "x", at: new Date(DAY.start - 6 * 86_400_000).toISOString(), new_status: "planned" }];
    const logs = jobLogs({ milestones: MS, timeLog: rows, records: new Map(), log: made, tz: TZ, times: TIMES, now: DAY.end });
    expect(logs[0].key).toBe("2026-10-29:day");
  });
});
