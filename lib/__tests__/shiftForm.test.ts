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
  it("incidents not entered are said, never shown as none", () => {
    const g = shiftForm({ ...input, incidents: undefined });
    expect(g.rows.find((r) => r.id === "safety")!.lines[0]).toMatchObject({ text: "Incidents not entered" });
  });
  it("rows left out stay out of the email and the text", () => {
    const html = formHtml(f, ["attend", "headcount"]);
    expect(html).not.toContain("Meeting Attendees");
    expect(html).toContain("<b><u>No Safety Incidents</u></b>");
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
    const nums = await zip.file("word/numbering.xml")!.async("string");
    expect((nums.match(/<w:num w:numId=/g) ?? []).length).toBe(4);
    expect(nums).toContain("<w:startOverride w:val=\"1\"/>");
  });
});
