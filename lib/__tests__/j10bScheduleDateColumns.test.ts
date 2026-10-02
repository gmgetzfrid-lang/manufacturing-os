// @vitest-environment jsdom
//
// projects Round G — J10b UI REMAINDERS: projects-tab GAP-403 acceptance 3,
// "An ambiguous date is rejected with a named column, never guessed." The
// never-guessed half held (SCH-1: a file whose slash dates read either way
// withholds every row until the user picks the order). The named-column half
// did not: the question named a sample value, and the skip warning said "a
// start or finish date". Now both name the column — as the file spells its
// header — the question in the parser's warning and on the import modal,
// and the skip warning per column with its row count. A file that
// contradicts itself names EACH side's own column, in the warning and on the
// modal (the review: the modal gave both sides the first one's column).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/milestones", () => ({ importMilestonesFromParsed: vi.fn() }));

import { parseScheduleFile } from "@/lib/scheduleParsers";
import ScheduleImportModal from "@/components/projects/ScheduleImportModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("GAP-403 acceptance 3 — the date question names its column", () => {
  it("an ambiguous file: the question names the start and finish columns as the file spells them, and the sample's own column", () => {
    const csv = ["Task Name,Start Date,Due Date", "A,05/08/2026,06/08/2026", "B,03/04/2026,04/04/2026"].join("\n");
    const asked = parseScheduleFile("plan.csv", csv);
    expect(asked.needsDateConvention).toBe(true);
    expect(asked.rows).toEqual([]);
    expect(asked.warnings[0]).toBe('Every slash date in the "Start Date" and "Due Date" columns (e.g. 05/08/2026 in "Start Date") reads as either day/month or month/day. Choose how to read dates before importing — the choice applies to every row.');
    expect(asked.dateSource).toEqual({ columns: ["Start Date", "Due Date"], samples: [{ value: "05/08/2026", column: "Start Date", reads: null }], conflict: false });
    // the existing dates record is unchanged
    expect(asked.dates).toEqual({ convention: null, decidedBy: "none", sample: "05/08/2026" });
  });

  it("one date column: 'the \"Finish\" column'", () => {
    const asked = parseScheduleFile("plan.csv", ["Task Name,Finish", "A,05/08/2026", "B,03/04/2026"].join("\n"));
    expect(asked.warnings[0]).toMatch(/^Every slash date in the "Finish" column \(e\.g\. 05\/08\/2026 in "Finish"\) reads as either day\/month or month\/day\./);
  });

  it("a self-contradicting file names the column of each side", () => {
    const csv = ["Task Name,Start,Finish", "A,01/08/2026,15/08/2026", "B,08/15/2026,08/16/2026"].join("\n");
    const asked = parseScheduleFile("plan.csv", csv);
    expect(asked.needsDateConvention).toBe(true);
    expect(asked.warnings[0]).toMatch(/^The file contradicts itself about date order \(15\/08\/2026 in "Finish" vs 08\/15\/2026 in "Start"\)\./);
    // each side carries its own column, and the only order it reads in
    expect(asked.dateSource).toEqual({
      columns: ["Start", "Finish"], conflict: true,
      samples: [{ value: "15/08/2026", column: "Finish", reads: "dmy" }, { value: "08/15/2026", column: "Start", reads: "mdy" }],
    });
  });

  it("under the chosen order an impossible date skips its row, and the warning names the column and counts its rows", () => {
    const csv = ["Task Name,Start,Finish", "A,01/08/2026,15/08/2026", "B,08/15/2026,08/16/2026", "C,13/08/2026,08/17/2026"].join("\n");
    const res = parseScheduleFile("plan.csv", csv, { dateConvention: "mdy" });
    expect(res.warnings).toContain('2 rows skipped (a start or finish date could not be read as month/day/year) — in "Finish" (1 row), "Start" (1 row).');
    const dmy = parseScheduleFile("plan.csv", csv, { dateConvention: "dmy" });
    // B fails in both columns under day/month (08/15 and 08/16), C in Finish only (08/17)
    expect(dmy.warnings).toContain('2 rows skipped (a start or finish date could not be read as day/month/year) — in "Start" (1 row), "Finish" (2 rows).');
  });

  it("XML and XER carry ISO dates and never reach the question (no date source)", () => {
    const xml = '<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><Tasks><Task><UID>1</UID><Name>A</Name><Start>2026-06-01T08:00:00</Start><Finish>2026-06-02T17:00:00</Finish></Task></Tasks></Project>';
    const res = parseScheduleFile("plan.xml", xml);
    expect(res.needsDateConvention).toBeUndefined();
    expect(res.dateSource).toBeUndefined();
  });
});

describe("GAP-403 acceptance 3 — rendered: the import modal's question names the column", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("dropping an ambiguous CSV asks how to read dates, naming its date columns and the sample's column", async () => {
    await act(async () => {
      root.render(createElement(ScheduleImportModal, { orgId: "o1", projectId: "p1", userId: "u1", onClose: () => {}, onDone: () => {} }));
    });
    const text = await drop(["Task Name,Start,Finish", "A,05/08/2026,06/08/2026", "B,03/04/2026,04/04/2026"].join("\n"));
    expect(text).toContain("How should dates in this file be read?");
    expect(text).toContain("Every slash date in “Start” and “Finish” (e.g. 05/08/2026 in “Start”) could be day/month or month/day.");
  });

  it("a self-contradicting CSV (Start 08/15/2026, Finish 15/08/2026): each value is named with its OWN column — never both with one", async () => {
    await act(async () => {
      root.render(createElement(ScheduleImportModal, { orgId: "o1", projectId: "p1", userId: "u1", onClose: () => {}, onDone: () => {} }));
    });
    const text = await drop(["Task Name,Start,Finish", "A,08/15/2026,15/08/2026"].join("\n"));
    expect(text).toContain("How should dates in this file be read?");
    expect(text).toContain("This file contradicts itself about date order: 15/08/2026 in “Finish” can only be day/month, but 08/15/2026 in “Start” can only be month/day. Nothing is imported until you choose; the choice applies to the whole file, and a row whose dates cannot be read that way is skipped.");
    // the review's failure: "(e.g. 15/08/2026 vs 08/15/2026 in "Finish")"
    expect(text).not.toContain("vs 08/15/2026 in “Finish”");
    expect(text).not.toContain("08/15/2026 in “Finish”");
    expect(text).not.toContain("Every slash date");
  });

  async function drop(csv: string): Promise<string> {
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    const bytes = new TextEncoder().encode(csv);
    const file = new File([bytes], "plan.csv", { type: "text/csv" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    return (host.textContent ?? "").replace(/\s+/g, " ");
  }
});
