import { describe, it, expect } from "vitest";
import {
  classifyStep, rankHazards, equipmentTag, hazardContext, parseSafetyMoment, normalizeUrl, safetyMomentPrompt,
  type HazardJobInput,
} from "@/lib/safetyMoment";

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
  it("the supervisor's note brings in work the schedule doesn't show", () => {
    const top = rankHazards(NIGHT, { note: "Also one crane pick at 02:00 over the pipe rack" });
    expect(top[0].kind).toBe("lifting");
    expect(top[0].fromNote).toBe(true);
    expect(hazardContext(top[0])).toBe("From your note");
    expect(top).toHaveLength(3);
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

describe("parseSafetyMoment", () => {
  const hazards = rankHazards(NIGHT);
  const searched = [
    { url: "https://www.csb.gov/tosco-avon-refinery-petroleum-naphtha-fire/", title: "Tosco Avon" },
    { url: "https://eusalt.com/_library/_files/Proj1_Ineos.pdf", title: "Inovyn" },
  ];
  it("keeps sourced gems, drops any whose source the search never returned", () => {
    const text = "Here you go:\n" + JSON.stringify({ hazards: [
      { kind: "line_break", title: "PSV-021 swap", gems: [
        { watch: "A line that won't drain still holds liquid behind the break.", prevent: "Won't drain? Stop.", source: "http://csb.gov/tosco-avon-refinery-petroleum-naphtha-fire#top" },
        { watch: "Made up lesson.", prevent: "Something.", source: "https://example.com/fake" },
      ] },
      { kind: "hydroblast", title: "Hydroblasting 10K", gems: [
        { watch: "A taped or sticking dump pedal keeps the gun live.", prevent: "Pedal dumps on release.", source: "https://eusalt.com/_library/_files/Proj1_Ineos.pdf" },
        { watch: "In Germany in 2018 an operator taped his pedal down.", prevent: "Don't.", source: "https://eusalt.com/_library/_files/Proj1_Ineos.pdf" },
      ] },
    ] });
    const { items, dropped } = parseSafetyMoment(text, hazards, searched);
    // The made-up source and the story (it names a year) are both dropped.
    expect(dropped).toBe(2);
    expect(items.find((i) => i.kind === "hydroblast")!.gems.map((g) => g.what)).toEqual(["A taped or sticking dump pedal keeps the gun live."]);
    expect(items.map((i) => i.kind)).toEqual(hazards.map((h) => h.kind));
    const lb = items.find((i) => i.kind === "line_break")!;
    expect(lb.title).toBe("PSV-021 swap");
    expect(lb.gems).toHaveLength(1);
    expect(lb.gems[0].source.url).toBe("https://www.csb.gov/tosco-avon-refinery-petroleum-naphtha-fire/");
    // A kind the model skipped keeps its place, empty.
    expect(items.find((i) => i.kind === "confined_space")!.gems).toEqual([]);
  });
  it("refuses an answer that isn't JSON", () => {
    expect(() => parseSafetyMoment("no idea", hazards, searched)).toThrow(/expected form/);
  });
  it("compares URLs loosely", () => {
    expect(normalizeUrl("https://www.csb.gov/a/b/#x")).toBe(normalizeUrl("http://csb.gov/a/b"));
  });
});

describe("safetyMomentPrompt", () => {
  it("lists each kind with its jobs, the note and sources to avoid", () => {
    const p = safetyMomentPrompt({
      projectName: "Transmix-1 Turnaround", shiftLabel: "Night shift Mon, Oct 26 18:00–6:00",
      hazards: rankHazards(NIGHT), note: "Flex lance on the tubes", avoidUrls: ["https://csb.gov/x"],
    });
    expect(p).toContain('kind "hydroblast"');
    expect(p).toContain("E-17: Hydroblast 10K Tubes and Shell — 18:00–22:00 — Evergreen 1");
    expect(p).toContain("Supervisor's note: Flex lance on the tubes");
    expect(p).toContain("- https://csb.gov/x");
  });
});
