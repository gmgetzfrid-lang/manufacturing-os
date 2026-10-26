import { describe, it, expect } from "vitest";
import {
  HAZARD_KINDS, classifyStep, rankHazards, equipmentTag, hazardContext, lessonFor, sourceLabel,
  type HazardJobInput, type HazardKind, type SafetyLesson,
} from "@/lib/safetyMoment";
import { SAFETY_LESSONS } from "@/lib/safetyLessons";

const job = (id: string, name: string, parentName: string | null, hours: number, extra: Partial<HazardJobInput> = {}): HazardJobInput =>
  ({ id, name, parentName, hours, when: "all shift", ...extra });

// The night shift of Mon Oct 26 on the Transmix-1 turnaround.
const NIGHT: HazardJobInput[] = [
  job("1", "Shutdown-Required Inspection on Burner Auto S/O Valve at H-1", "Work Orders", 4, { who: "E/I (KE)" }),
  job("2", "Shutdown-Required Fire Eye Cleaning at H-1", "Work Orders", 4, { who: "E/I (KE)" }),
  job("3", "Calibrate Equipment", "UIT-013 - Coriolis Meter for Transmix Feed from Storage", 12),
  job("4", "PSV-021 - E-13 Fractanator Overhead Air Condenser (Swap Existing with the New Model and Run Tubing from the Pilot ot the Branch (MOC 21-62))", "PSVs", 5, { when: "…–23:00", who: "Maintenance (KE)" }),
  job("5", "Open Internal Manways", "V-7 - Transmix Fractionator", 12, { who: "Schultz - Tower" }),
  job("6", "Hydroblast 10K Tubes and Shell", "E-17 - Transmix Feed/Trans. Diesel Exchanger No. 1", 4, { when: "18:00–22:00", who: "Evergreen 1" }),
  job("7", "Complete 100% Tube and Shell Inspection", "E-17 - Transmix Feed/Trans. Diesel Exchanger No. 1", 6, { who: "Inspector (KE)" }),
  job("8", "Hydroblast 10K Tubes and Shell", "E-12 - Transmix Feed/Trans. Diesel Exchanger No. 2", 2, { when: "4:00–…", who: "Evergreen 1" }),
];

describe("classifyStep", () => {
  it("reads turnaround step names", () => {
    expect(classifyStep("Hydroblast 10K Tubes and Shell")).toEqual(["hydroblast"]);
    expect(classifyStep("Open Internal Manways")).toEqual(["confined_space"]);
    expect(classifyStep("Blind / Open Manways")).toEqual(["line_break"]);
    expect(classifyStep("Set Blinds; Verify LOTO")).toEqual(["line_break"]);
    expect(classifyStep("Fly Out and Transport Exchanger")).toEqual(["lifting"]);
    expect(classifyStep("Pull Bundle")).toEqual(["bundle_pull"]);
    expect(classifyStep("Shutdown-Required Fire Eye Cleaning at H-1")).toEqual(["heater"]);
    expect(classifyStep("Hydrotest exchanger shell")).toEqual(["pressure_test"]);
    expect(classifyStep("Weld out new nozzle")).toEqual(["hot_work"]);
  });
  it("leaves ordinary work alone", () => {
    expect(classifyStep("Calibrate Equipment")).toEqual([]);
    expect(classifyStep("Complete 100% Tube and Shell Inspection")).toEqual([]);
  });
  it("falls back to the group's name only when the step names nothing", () => {
    expect(classifyStep("E-12", ["Crane Lifts"])).toEqual(["lifting"]);
    expect(classifyStep("Hydroblast tubes", ["Crane Lifts"])).toEqual(["hydroblast"]);
  });
});

describe("rankHazards", () => {
  it("picks three different kinds, the deadliest first", () => {
    const top = rankHazards(NIGHT);
    expect(top.map((h) => h.kind).sort()).toEqual(["confined_space", "hydroblast", "line_break"]);
    expect(top.every((h) => h.severity === 5)).toBe(true);
    const hb = top.find((h) => h.kind === "hydroblast")!;
    expect(hb.jobs.map((j) => j.equipment)).toEqual(["E-17", "E-12"]);
    expect(hb.hours).toBe(6);
  });
  it("never shows two of one family", () => {
    const top = rankHazards([
      job("a", "Fly Out and Transport Exchanger", "E-20 - Trim Cooler", 3),
      job("b", "Pull Bundle", "E-12 - Exchanger", 4),
      job("c", "Weld nozzle", "V-3 - Drum", 2),
    ]);
    expect(top.map((h) => h.kind)).toEqual(["lifting", "hot_work"]);
  });
  it("returns fewer when the shift has fewer kinds of risky work", () => {
    expect(rankHazards([job("x", "Calibrate Equipment", null, 4)])).toEqual([]);
  });
});

describe("equipmentTag / hazardContext", () => {
  it("shortens equipment names to their tag", () => {
    expect(equipmentTag("E-17 - Transmix Feed/Trans. Diesel Exchanger No. 1")).toBe("E-17");
    expect(equipmentTag("V-7 - Transmix Fractionator")).toBe("V-7");
    expect(equipmentTag("Work Orders")).toBe("Work Orders");
    expect(equipmentTag("PSVs", "PSV-021 - E-13 Fractanator Overhead Air Condenser (Swap …)")).toBe("PSV-021");
    expect(equipmentTag("V-7 - Transmix Fractionator", "TK-9 - something")).toBe("V-7");
    expect(equipmentTag(null)).toBeNull();
  });
  it("says where, when and who in one line", () => {
    const hb = rankHazards(NIGHT).find((h) => h.kind === "hydroblast")!;
    expect(hazardContext(hb)).toBe("E-17 18:00–22:00, E-12 4:00–… · Evergreen 1");
  });
});
describe("hit lists", () => {
  it("every kind has a short standard hit list", () => {
    for (const def of Object.values(HAZARD_KINDS)) {
      expect(def.hitList.length).toBeGreaterThanOrEqual(4);
      expect(def.hitList.length).toBeLessThanOrEqual(5);
      for (const t of def.hitList) expect(t.split(/\s+/).length).toBeLessThanOrEqual(9);
    }
  });
});

describe("the lesson library", () => {
  const words = (t: string) => t.trim().split(/\s+/).length;
  it("every lesson is a short takeaway with a real source — never the story", () => {
    expect(SAFETY_LESSONS.length).toBeGreaterThan(0);
    for (const l of SAFETY_LESSONS) {
      expect(HAZARD_KINDS[l.kind], l.watch).toBeTruthy();
      expect(words(l.watch), l.watch).toBeLessThanOrEqual(24);
      expect(words(l.prevent), l.prevent).toBeLessThanOrEqual(16);
      expect(l.source.url, l.watch).toMatch(/^https:\/\/[^\s]+\.[a-z]{2,}/i);
      expect(l.source.title.length, l.watch).toBeGreaterThan(0);
      // A year means it's retelling the incident.
      expect(`${l.watch} ${l.prevent}`, l.watch).not.toMatch(/\b(19|20)\d{2}\b/);
    }
  });
  it("no lesson is listed twice", () => {
    const seen = new Set(SAFETY_LESSONS.map((l) => l.watch.toLowerCase()));
    expect(seen.size).toBe(SAFETY_LESSONS.length);
  });
  it("the common turnaround jobs each have lessons", () => {
    const has = (k: HazardKind) => SAFETY_LESSONS.some((l) => l.kind === k);
    for (const k of ["confined_space", "hydroblast", "line_break"] as HazardKind[]) expect(has(k), k).toBe(true);
  });
});

describe("lessonFor", () => {
  const lib: SafetyLesson[] = ["a", "b", "c"].map((w) => ({ kind: "hydroblast", watch: w, prevent: "p", source: { url: "https://x.test", title: "t" } }));
  const SHIFT = 43_200_000;
  it("gives a different lesson each shift, round the list, the same on every screen", () => {
    const t0 = Date.parse("2026-10-26T13:00:00Z");
    const seq = [0, 1, 2, 3].map((n) => lessonFor("hydroblast", t0 + n * SHIFT, lib)!.watch);
    expect(new Set(seq.slice(0, 3)).size).toBe(3);
    expect(seq[3]).toBe(seq[0]);
    expect(lessonFor("hydroblast", t0, lib)).toEqual(lessonFor("hydroblast", t0, lib));
  });
  it("nothing for a kind with no lessons", () => {
    expect(lessonFor("radiography", Date.now(), lib)).toBeNull();
  });
  it("names a source by its site", () => {
    expect(sourceLabel({ url: "https://www.csb.gov/x/" })).toBe("csb.gov");
  });
});
