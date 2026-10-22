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
    expect(t.split("\n")[0]).toBe("SHIFT TURNOVER — Unit 6 Turnaround");
    expect(t).toContain("Status: BEHIND — 42% vs 48% plan");
    expect(t).toContain("2. NEEDS A DECISION");
    expect(t).toMatch(/E-606 Reboiler \(3\/5 steps · 60%\)\n\s+• Pull blinds \[on hold\] — 90% — due Oct 23 7:00 — who: Acme <Mech> — WO 123456\n\s+Reason: waiting on Ops/);
    expect(t).toContain("✓ E-607 › Pull blinds (on time)");
  });

  it("email HTML is tables with inline styles only, and escapes what it prints", () => {
    const h = toEmailHtml(doc);
    expect(h).not.toMatch(/class=|<style|display:\s*(flex|grid)/);
    expect(h).toContain("Acme &lt;Mech&gt;");
    expect(h).toContain(">BEHIND<");
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
