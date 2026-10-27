// The safety moment reads the shift's steps, not just the kinds of work:
// why each topic made the list, crews meeting on the same equipment, a
// hand-off, a note, a job picked up part-way, late work, the night low.

import { describe, it, expect } from "vitest";
import { rankHazards, classifyStep, type HazardJobInput } from "@/lib/safetyMoment";

const H = 3600_000;
const S = Date.parse("2026-10-27T11:00:00Z"); // a 12 h day shift
const job = (id: string, name: string, parentId: string, parentName: string, from: number, to: number, extra: Partial<HazardJobInput> = {}): HazardJobInput =>
  ({ id, name, parentId, parentName, hours: to - from, when: `${from}–${to}`, start: S + from * H, end: S + to * H, ...extra });
const T = (ms: number) => new Date(ms).toISOString().slice(11, 16);

describe("new kinds of step it used to miss", () => {
  it("air-condenser plug pulls are line breaks; flange facing is machining; a TS hydro is a pressure test", () => {
    expect(classifyStep("Pull 100% of the Plugs")).toContain("line_break");
    expect(classifyStep("Machine All 4 Nozzle Flange Faces to Restore Grooves")).toContain("machining");
    expect(classifyStep("Install Bundle and Components for TS Hydro")).toEqual(expect.arrayContaining(["bundle_pull", "pressure_test"]));
  });
});

describe("why it's here, and what's specific to these steps", () => {
  const e20 = "E-20 - Overhead Trim Cooler";
  it("two crews on one exchanger at once becomes the topic, and says what one does to the other", () => {
    const top = rankHazards([
      job("hb", "Hydroblast Shell and Bundle", "e20", e20, 2, 6, { who: "Ancon" }),
      job("in", "Inspect for Cleanliness", "e20", e20, 4, 5, { who: "Schultz" }),
    ], { T });
    const hb = top.find((h) => h.kind === "hydroblast")!;
    expect(hb.why).toEqual(expect.arrayContaining(["can kill", "2 crews on E-20 at once"]));
    expect(hb.tonight[0]).toMatch(/^Schultz on E-20 \(Inspect for Cleanliness\) while Ancon blasts it: .*pump is down and locked/);
  });
  it("a hand-off on the same equipment names the time and what has to be true first", () => {
    const top = rankHazards([
      job("hb", "Hydroblast Shell and Bundle", "e20", e20, 2, 6, { who: "Ancon" }),
      job("in", "Inspect for Cleanliness", "e20", e20, 6, 7, { who: "Schultz" }),
    ], { T });
    const hb = top.find((h) => h.kind === "hydroblast")!;
    expect(hb.why).toContain("E-20 changes hands at 17:00");
    expect(hb.tonight[0]).toMatch(/E-20 goes from blasting to Inspect for Cleanliness at 17:00: pump down and locked, hoses bled/);
  });
  it("a note that changes the job: seized bolts", () => {
    const top = rankHazards([job("pb", "Pull Bundle", "e17", "E-17 - Exchanger", 0, 4, { who: "Schultz", percent: 25, late: true, note: "Bolts seized on south side" })], { T });
    const pb = top[0];
    expect(pb.why).toEqual(expect.arrayContaining(["stuck parts", "picked up at 25%", "carried over, late"]));
    expect(pb.tonight[0]).toMatch(/“Bolts seized on south side” on E-17 Pull Bundle: .*torch, sledge, cheater bar or more pull/);
    expect(pb.tonight.join(" ")).toMatch(/E-17 bundle is 25% out: .*cantilevered load/);
  });
  it("work in a night shift's small hours says so, in that shift's clock", () => {
    const N = Date.parse("2026-10-27T01:00:00Z"); // 18:00 local-ish start
    const j: HazardJobInput = { id: "x", name: "Open Internal Manways", parentId: "v7", parentName: "V-7 - Fractionator", hours: 4, when: "02:00–06:00", start: N + 8 * H, end: N + 12 * H };
    const top = rankHazards([j], { shift: { start: N, end: N + 12 * H, kind: "night" }, T });
    expect(top[0].why).toContain("runs into the 09:00–12:00 low"); // 8–11 h into the shift, in its own clock
    expect(top[0].tonight.join(" ")).toMatch(/into the 09:00–12:00 low of a night shift/);
  });
  it("what's going on around it lifts a topic above the same kind of danger without it", () => {
    const top = rankHazards([
      job("hb", "Hydroblast Vessel", "v8", "V-8 - Reflux Drum", 1, 3, { who: "Ancon" }),
      job("hb2", "Hydroblast Tubes", "e20", e20, 1, 3, { who: "Ancon" }),
      job("in", "Inspect", "e20", e20, 2, 3, { who: "Inspector" }),
      job("blind", "Set Blinds; Verify LOTO", "e16", "E-16 - Cooler", 0, 2, { who: "Schultz" }),
    ], { T });
    expect(top[0].kind).toBe("hydroblast");
    expect(top[0].tonight[0]).toMatch(/E-20/);
  });
  it("a quiet shift still gives plain reasons — never empty", () => {
    const top = rankHazards([job("b", "Set Blinds; Verify LOTO", "e16", "E-16 - Cooler", 0, 2, { who: "Schultz" })], { T });
    expect(top[0].why).toEqual(["can kill"]);
    expect(top[0].tonight).toEqual([]);
  });
});

describe("no noise", () => {
  const e = "E-622 - Exchanger";
  it("a crew is never 'clashing' with itself on two ordinary jobs", () => {
    const top = rankHazards([
      job("a", "Hydroblast tubes", "x", e, 0, 4, { who: "Acme" }),
      job("b", "Inspect", "x", e, 1, 3, { who: "Acme" }),
    ], { T });
    expect(top[0].tonight.join(" ")).not.toMatch(/Acme and Acme/);
    expect(top[0].why.join(" ")).not.toMatch(/at once/);
  });
  it("a clash told under one topic isn't a bare reason under the next", () => {
    const top = rankHazards([
      job("hb", "Hydroblast 10K Tubes and Shell", "e12", "E-12 - Exchanger", 0, 6, { who: "Ancon" }),
      job("pb", "Pull Bundle", "e12", "E-12 - Exchanger", 0, 3, { who: "Schultz" }),
    ], { T });
    const told = top.flatMap((h) => h.tonight).filter((t) => /E-12/.test(t) && /(blast|pull)/i.test(t));
    expect(told.length).toBeGreaterThan(0);
    for (const h of top) if (h.why.some((w) => /2 crews on E-12/.test(w))) expect(h.tonight.some((t) => /E-12/.test(t))).toBe(true);
  });
});

describe("phase names don't make a step dangerous", () => {
  it("calibrating a meter under a 'Startup' phase isn't a start-up", () => {
    const top = rankHazards([{ id: "c", name: "Calibrate meter", parentId: "e", parentName: "E-623 Exchanger", crumbs: ["Shutdown", "Startup"], hours: 2, when: "x" }], { T });
    expect(top).toEqual([]);
  });
});
