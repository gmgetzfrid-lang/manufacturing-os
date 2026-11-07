import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { shiftForm, formHtml, formText, formDocx, type FormInput } from "@/lib/shiftForm";

const input: FormInput = {
  project: "LRU Turnaround November 2026", date: "November 5, 2026", start: "6:00 AM", end: "6:00 PM", meeting: "5:30 AM",
  attendees: [{ crew: "Operations", names: "Jess Montgomery" }, { crew: "Schultz", names: "Wayne Lederer, Kevin Henry" }],
  incidents: { none: true, items: [] }, safetyTopic: "Vehicle Safety, Proximity Work",
  planned: [{ crew: "Schultz", text: "V-03 – Remove Trays" }, { crew: "KE Maintenance", text: "PSV-209 – Re-install" }, { crew: "Schultz", text: "E-02 – Nozzle repair" }],
  completed: [{ crew: "Ancon", text: "V-01 – Hydroblast" }, { crew: "Ancon", text: "V-24 – Hydroblast Shell" }],
  followUps: ["V-3 trays and membranes confirmed to be intentionally left out upon startup."],
  notes: [{ clock: "5:30 AM", text: "Shift change meeting." }, { clock: "7:00", text: "Ancon cleaning V-4 components" }, { clock: "8:00", text: "" }],
  headcount: [{ crew: "Maintenance", n: 6 }, { crew: "Schultz", n: 30 }],
};

describe("the shift table in the plant's format", () => {
  const f = shiftForm(input);
  it("the rows, named as the plant names them", () => {
    expect(f.when).toBe("November 5, 2026 6:00 AM – 6:00 PM");
    expect(f.rows.map((r) => r.label)).toEqual(["5:30 AM Meeting Attendees", "Safety", "Work to be Completed After 5:30 AM Meeting", "Work Completed Between 5:30 AM and 6:00 PM", "Follow-Up Items", "Shift Notes", "Personnel Headcount"]);
  });
  it("crews in bold with their items under them; empty hours left out", () => {
    const plan = f.rows.find((r) => r.id === "plan")!.lines;
    expect(plan).toEqual([{ k: "group", text: "Schultz" }, { k: "item", text: "V-03 – Remove Trays" }, { k: "item", text: "E-02 – Nozzle repair" }, { k: "group", text: "KE Maintenance" }, { k: "item", text: "PSV-209 – Re-install" }]);
    expect(f.rows.find((r) => r.id === "notes")!.lines).toHaveLength(2);
    expect(f.rows.find((r) => r.id === "safety")!.lines[0]).toMatchObject({ text: "No Safety Incidents", strong: true });
  });
  it("a crew's steps on the same equipment on one line; the same time once", () => {
    const g = shiftForm({ ...input,
      completed: [
        { crew: "Schultz", group: "E-32", text: "Set Blinds; Verify LOTO" }, { crew: "Schultz", text: "PSV-209 - E-27 Propane Condenser" },
        { crew: "Schultz", group: "E-32", text: "Remove Channel Head" }, { crew: "Schultz", group: "E-32", text: "Pull Bundle (0% to 50%)" },
      ],
      notes: [{ clock: "9:00", text: "Schultz: E-02 done" }, { clock: "9:00", text: "Break, 15 min." }, { clock: "9:30", text: "Ancon: V-1 started." }, { clock: "9:30", text: "Schultz: E-23 done" }] });
    expect(g.rows.find((r) => r.id === "done")!.lines).toEqual([{ k: "group", text: "Schultz" },
      { k: "item", text: "E-32 – Set Blinds; Verify LOTO, Remove Channel Head, Pull Bundle (0% to 50%)" }, { k: "item", text: "PSV-209 - E-27 Propane Condenser" }]);
    expect(g.rows.find((r) => r.id === "notes")!.lines.map((l) => ("lead" in l ? `${l.lead}${l.text}` : l.text))).toEqual(["9:00 – Schultz: E-02 done, Break, 15 min.", "9:30 – Ancon: V-1 started. Schultz: E-23 done"]);
  });
  it("the date said once: the header's line, no title row repeating it", () => {
    const g = shiftForm({ ...input, weekday: "Thursday", shift: "Day shift", asOf: "6:00 PM" });
    expect(g.dateLine).toBe("Thursday, November 5, 2026 · Day shift 6:00 AM – 6:00 PM");
    expect(g.asOf).toBe("6:00 PM");
    const both = formHtml(g, [], { project: true, when: true });
    expect(both).not.toContain("November 5, 2026");
    expect(both).not.toContain("LRU Turnaround November 2026");
    // The header without the date: the title row says only the date.
    const dateOnly = formHtml(g, [], { project: true });
    expect(dateOnly).toContain("November 5, 2026 6:00 AM – 6:00 PM");
    expect(dateOnly).not.toContain("LRU Turnaround November 2026");
    expect(formText(g, [], { project: true, when: true })).not.toContain("November 5, 2026");
  });
  it("incidents not entered are said, never shown as none", () => {
    const g = shiftForm({ ...input, incidents: undefined });
    expect(g.rows.find((r) => r.id === "safety")!.lines[0]).toMatchObject({ text: "Incidents not entered" });
  });
  it("rows left out stay out of the email and the text", () => {
    const html = formHtml(f, ["attend", "headcount"]);
    expect(html).not.toContain("Meeting Attendees");
    expect(html).toMatch(/<b[^>]*><u>No Safety Incidents<\/u><\/b>/);
    expect(html).toMatch(/<ol[^>]*><li[^>]*>V-03 – Remove Trays/);
    const t = formText(f, ["notes"]);
    expect(t).toContain("  1. V-03 – Remove Trays");
    expect(t).not.toContain("SHIFT NOTES");
  });
  it("the Word file: the plant's columns, numbering starting again under each crew", async () => {
    const bytes = await formDocx(f, [], { project: "LRU", status: { label: "AHEAD", detail: "20% vs 19% plan", tone: "emerald" }, tiles: [{ label: "Complete", value: "20%", tone: "emerald" }], bars: { done: 20, plan: 19, from: "Fri, Oct 30", to: "Mon, Nov 9" } });
    const zip = await JSZip.loadAsync(bytes);
    const doc = await zip.file("word/document.xml")!.async("string");
    expect(doc).toContain('<w:gridCol w:w="1971"/><w:gridCol w:w="8649"/>');
    expect(doc).toContain("AHEAD");
    expect(doc).toContain("No Safety Incidents");
    // The header says the project: the title row says only the date.
    expect(doc).toContain("November 5, 2026 6:00 AM");
    expect(doc).not.toContain("LRU Turnaround November 2026");
    expect(doc).toContain('<w:top w:val="single" w:sz="18" w:space="0" w:color="000A72"/>');
    const nums = await zip.file("word/numbering.xml")!.async("string");
    expect((nums.match(/<w:num w:numId=/g) ?? []).length).toBe(4);
    expect(nums).toContain("<w:startOverride w:val=\"1\"/>");
  });
});
