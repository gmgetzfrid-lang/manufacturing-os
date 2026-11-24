import { describe, it, expect } from "vitest";
import { toPlainText, toEmailHtml, type ExportDoc } from "@/lib/reportExport";

const doc: ExportDoc = {
  kind: "Shift turnover", project: "Unit 6 Turnaround", when: "Day shift Wed Oct 22 5:30–17:30 → Night shift Wed Oct 22 17:30–5:30 (Thu Oct 23)",
  asOf: "Wed Oct 22 17:30 CDT", status: { label: "BEHIND", tone: "rose", detail: "42% vs 48% plan" },
  sections: [
    { title: "Where we stand", sub: "Day 3 of 12", blocks: [{ k: "stats", items: [{ label: "Actual", value: "42%", tone: "rose" }, { label: "Gap", value: "−36 h", tone: "rose" }] }] },
    { title: "Needs a decision", flag: "rose", blocks: [{ k: "steps", whenHead: "Done", rightHead: "Due", rows: [
      { group: { title: "E-606 Reboiler", meta: "3/5 steps · 60%" }, when: "90%", name: "Pull blinds", tags: [{ t: "on hold", tone: "amber" }], who: "Acme <Mech>", wo: "123456", right: "Oct 23 7:00", note: "Reason: waiting on Ops" },
    ] }] },
    { title: "Last shift", blocks: [{ k: "list", items: [{ text: "E-607 › Pull blinds", note: "on time" }] }] },
  ],
  footer: "Hours are planned work-hours.",
};

describe("a report copied for an update", () => {
  it("plain text keeps the order, groups and tags", () => {
    const t = toPlainText(doc);
    expect(t.split("\n")[0]).toBe("SHIFT TURNOVER - Unit 6 Turnaround");
    expect(t).toContain("Status: BEHIND - 42% vs 48% plan");
    expect(t).toContain("\nNEEDS A DECISION");
    expect(t).not.toMatch(/^\d+\. /m); // no section numbers
    expect(t).toMatch(/E-606 Reboiler \(3\/5 steps · 60%\)\n\s+• Pull blinds \[on hold\] - 90% - due Oct 23 7:00 - who: Acme <Mech> - WO 123456\n\s+Reason: waiting on Ops/);
    expect(t).toContain("✓ E-607 › Pull blinds (on time)");
  });

  it("email HTML is tables with inline styles only, and escapes what it prints", () => {
    const h = toEmailHtml(doc);
    expect(h).not.toMatch(/class=|<style|display:\s*(flex|grid)/);
    expect(h).toContain("Acme &lt;Mech&gt;");
    expect(h).toContain("&nbsp;Behind<");
    expect((h.match(/<table/g) ?? []).length).toBeGreaterThan(4);
  });
});

describe("steps keep their equipment together, as on screen", () => {
  it("one header per piece of equipment, rows in first-appearance order", async () => {
    const { groupRows } = await import("@/lib/reportExport");
    const r = (g: string, name: string) => ({ group: { title: g }, when: "", name, right: "" });
    const out = groupRows([r("T-605", "a"), r("E-608", "b"), r("T-605", "c")]);
    expect(out.map((g) => [g.group?.title, g.rows.map((x) => x.name)])).toEqual([["T-605", ["a", "c"]], ["E-608", ["b"]]]);
    expect(groupRows([r("T-605", "a"), r("E-608", "b")], true)).toHaveLength(1);
  });
});

describe("the turnover as management reads it", () => {
  it("one status sentence leads, its key number big, and no verdict box beside the name", async () => {
    const { toEmailHtml: html, toPlainText: text } = await import("@/lib/reportExport");
    const late: ExportDoc = { ...doc, status: { label: "FINISHED LATE", tone: "rose", key: "43.5 h", detail: "Phase 1 finished Sat, Nov 21 1:30 AM, 43.5 h late (1.8 days)." }, headcount: "38 on site: Schultz 12, Ancon 20, Brand 6" };
    const h = html(late);
    expect(h).toContain("43.5&nbsp;h");
    expect(h).toContain("Phase 1 finished Sat, Nov 21 1:30 AM, 43.5 h late (1.8 days).");
    expect(h).not.toContain("ON TRACK");
    // The head count comes before any section.
    expect(h.indexOf("38 on site: Schultz 12")).toBeLessThan(h.indexOf("Where we stand"));
    const t = text(late);
    expect(t).toContain("Status: FINISHED LATE - Phase 1 finished Sat, Nov 21 1:30 AM, 43.5 h late (1.8 days).");
    expect(t.indexOf("38 on site")).toBeLessThan(t.indexOf("WHERE WE STAND"));
  });

  it("the head count in one line, from the counts entered only", async () => {
    const { headcountLine } = await import("@/lib/reportExport");
    expect(headcountLine([{ crew: "Schultz", n: 12 }, { crew: "Ancon", n: 20 }])).toBe("32 on site: Schultz 12, Ancon 20");
    expect(headcountLine([])).toBeUndefined();
  });

  it("done, next shift, problems and follow-ups, safety, people last; short titles with the times beside them", async () => {
    const { forManagement } = await import("@/lib/reportExport");
    const sec = (id: string, title: string, sub?: string) => ({ id, title, sub, blocks: [] });
    const d: ExportDoc = { ...doc, status: { label: "BEHIND", tone: "rose", key: "36 h", detail: "x" }, sections: [
      sec("stand", "Where we stand"), sec("done", "Done - Day shift Thu, Nov 19", "3 finished"), sec("meetings", "Shift meetings - Day shift Thu, Nov 19", "who attended"),
      sec("incidents", "Safety incidents - Day shift Thu, Nov 19"), sec("next", "Next - Night shift Thu, Nov 19 6:00 PM-6:00 AM", "4 steps"), sec("notes", "Notes & actions"),
      sec("waiting", "Waiting and ready - Day shift Thu, Nov 19"),
      { id: "stand2", title: "Other", blocks: [{ k: "overview", stats: [], bars: { done: 100, plan: 100, from: "a", to: "b" }, title: "", lines: [] }] },
    ] };
    const out = forManagement(d, { done: "Day shift Thu, Nov 19 6:00 AM-6:00 PM", next: "Night shift Thu, Nov 19 6:00 PM-6:00 AM" });
    expect(out.sections.map((s) => s.id)).toEqual(["stand", "done", "next", "waiting", "notes", "incidents", "meetings", "stand2"]);
    expect(out.sections[1]).toMatchObject({ title: "Done", sub: "Day shift Thu, Nov 19 6:00 AM-6:00 PM · 3 finished" });
    expect(out.sections[2]).toMatchObject({ title: "Next shift", sub: "Night shift Thu, Nov 19 6:00 PM-6:00 AM · 4 steps" });
    expect(out.sections[6]).toMatchObject({ title: "People", sub: "Day shift Thu, Nov 19 · who attended" });
    // Two full bars only repeat 100%: dropped; the tiles go quiet under the sentence.
    expect(out.sections[7].blocks[0]).toMatchObject({ k: "overview", small: true, bars: undefined });
  });

  it("the plant's table: done first, the people last, short row names with the times in the row", async () => {
    const { managementForm } = await import("@/lib/reportExport");
    const { shiftForm } = await import("@/lib/shiftForm");
    const f = shiftForm({ project: "P", date: "November 19, 2026", start: "6:00 AM", end: "6:00 PM", meeting: "5:30 AM",
      attendees: [{ crew: "Schultz", names: "Mike Leonard" }], planned: [], completed: [{ crew: "Schultz", text: "Pull bundle" }], followUps: [], notes: [], headcount: [{ crew: "Schultz", n: 12 }] });
    const m = managementForm(f, { meeting: "5:30 AM", end: "6:00 PM" });
    expect(m.rows.map((r) => r.id)).toEqual(["done", "plan", "followup", "safety", "notes", "attend", "headcount"]);
    expect(m.rows[0].label).toBe("Done");
    expect(m.rows[0].lines[0]).toEqual({ k: "text", text: "5:30 AM to 6:00 PM" });
    expect(m.rows.find((r) => r.id === "attend")!.label).toBe("Attendees");
    expect(m.rows.find((r) => r.id === "plan")!.label).toBe("Plan");
  });
});

describe("a table's notes are never squeezed or dropped", () => {
  const withNotes: ExportDoc = { kind: "Close-out meeting", project: "P", when: "w", asOf: "a", sections: [{ id: "setbacks", title: "What set us back", blocks: [{
    k: "table", head: ["Lost", "Step", "Who"],
    rows: [["+26 h", { t: "Pull bundle", note: "E-12", sub: [{ t: "task 40% done" }], lines: [{ t: "Hydroblast" }] }, "Ancon"], ["+2 h", "Box up", "Brand"]],
    notes: ["Why: on hold 20 h, waiting on material; ran 6 h longer than planned", null],
  }] }] };
  it("a row's note is a full-width line under it in the email, in a table row of its own", () => {
    const h = toEmailHtml(withNotes);
    expect(h).toMatch(/<tr><td colspan="3" style="[^"]*">Why: on hold 20 h, waiting on material; ran 6 h longer than planned<\/td><\/tr>/);
    expect(h).not.toMatch(/class=|<style|display:\s*(flex|grid)/);
  });
  it("in plain text: the note on an indented line under its row, and the first cell keeps its note, lines and sub-lines", () => {
    const t = toPlainText({ ...withNotes, sections: [{ ...withNotes.sections[0], blocks: [{ k: "table", head: ["Step", "Lost"], rows: [[{ t: "Pull bundle", note: "E-12", sub: [{ t: "task 40% done" }], lines: [{ t: "Hydroblast" }] }, "+26 h"]], notes: ["Why: waiting on material"] }] }] });
    expect(t).toContain(`   • Pull bundle ("E-12"); Hydroblast (task 40% done) - lost +26 h\n       Why: waiting on material`);
    const t2 = toPlainText(withNotes);
    expect(t2).toContain(`• +26 h - step Pull bundle ("E-12"); Hydroblast (task 40% done) · who Ancon`);
    expect(t2).toContain("\n       Why: on hold 20 h, waiting on material; ran 6 h longer than planned\n");
  });
});
