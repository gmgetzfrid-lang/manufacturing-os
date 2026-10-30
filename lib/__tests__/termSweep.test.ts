import { describe, it, expect } from "vitest";
import { sweepTerms, sentencesWith, tieIn, sweepPassages, sweepBlock, sectionAt, type TermSweep, type SweepChunk } from "@/lib/ask/termSweep";

const chunk = (id: string, docId: string, page: number, content: string, section: string | null = null): SweepChunk =>
  ({ id, document_id: docId, library_id: "L", page, section, content });

describe("sweepTerms - the asker's own words", () => {
  it("pulls the subject out of a selection question", () => {
    const t = sweepTerms("What piping spec should I use for 150 class sour gas stream?");
    expect(t[0]).toBe("sour gas");
    expect(t).toContain("sour");
    expect(t).not.toContain("class");
    expect(t).not.toContain("150");
  });
  it("puts the query writer's quoted terms first", () => {
    expect(sweepTerms("bolting for low temperature service", ["impact test"])[0]).toBe("impact test");
  });
  it("works for any vocabulary", () => {
    expect(sweepTerms("Is PWHT required for caustic service carbon steel?")).toEqual(expect.arrayContaining(["pwht", "caustic", "carbon steel"]));
  });
});

describe("finding the sentences that tie terms together", () => {
  const ep1283 = "7.5 Valve trim shall be hardened per EP 10-2-2. 7.6 Valves for use in sour gas (Wet H2S) service shall use materials which conform to NACE MR0103, except that hardness requirements for the body, bonnet, and stem shall be per EP 10-2-3. In addition, free machining steels, as defined in this Practice, shall not be used in sour gas service.";
  it("reads 'sour gas (Wet H2S)' as the document writing the term as Wet H2S", () => {
    const [s] = sentencesWith(ep1283, "sour gas");
    expect(s).toMatch(/^7\.6 Valves for use in sour gas \(Wet H2S\)/);
    expect(tieIn(s, "sour gas", ["wet h2s", "h2s", "nace"])).toEqual({ kind: "paren", to: "Wet H2S" });
  });
  it("a related term in the same sentence is noted as such - weaker than a parenthesis", () => {
    const s = "Valves for use in sour gas (H2S) service shall conform to NACE MR0103.";
    expect(tieIn(s, "sour gas", ["nace"])).toEqual({ kind: "paren", to: "H2S" });
    expect(tieIn("Sour gas lines shall meet NACE MR0103.", "sour gas", ["nace"])).toEqual({ kind: "related", to: "nace" });
  });
  it("a definition counts", () => {
    expect(tieIn("Sour gas – gas containing hydrogen sulfide above 50 ppm.", "sour gas", [])?.kind).toBe("defines");
  });
  it("whole words only", () => {
    expect(sentencesWith("Sourcing of crude was approved.", "sour")).toEqual([]);
    expect(sentencesWith("Flanges per the nozzles schedule.", "nozzle")).toHaveLength(1);
  });
});

describe("the sweep, as the answer reads it", () => {
  const spec = chunk("s1", "SPEC", 812, "Services: AAAC2H - Hydrocarbon and/or Hydrogen Rich Service, Sour Service (200 BHN MAX)");
  const spec2 = chunk("s2", "SPEC", 1700, "Services: FAAA1G - Hydrocarbon, Sour Service");
  const valve = chunk("v1", "EP1283", 14, "7.6 Valves for use in sour gas (Wet H2S) service shall use materials which conform to NACE MR0103.", "7.0 Materials");
  const prv = chunk("p1", "EP5116", 5, "Valves for use in sour gas (H2S) service shall use materials which conform to NACE MR0103.");
  const sru = chunk("r1", "EP10115", 7, "Operation on hot standby with sour gas is a problem for SRUs.");
  const sweeps: TermSweep[] = [
    {
      term: "sour gas", docCount: 3, passageCount: 3, tooCommon: false, sections: [],
      docs: [
        { documentId: "EP10115", hits: 1, best: [{ chunk: sru, sentence: sru.content, tie: null }] },
        { documentId: "EP1283", hits: 2, best: [{ chunk: valve, sentence: valve.content, tie: { kind: "paren", to: "Wet H2S" } }] },
        { documentId: "EP5116", hits: 1, best: [{ chunk: prv, sentence: prv.content, tie: { kind: "paren", to: "H2S" } }] },
      ],
    },
    {
      term: "sour", docCount: 40, passageCount: 300, tooCommon: false, docs: [],
      sections: [{ documentId: "SPEC", items: [
        { key: "AAAC2H", page: 812, rating: "150#", seen: [], line: "AAAC2H - Hydrocarbon and/or Hydrogen Rich Service, Sour Service (200 BHN MAX)", chunk: spec },
        { key: "FAAA1G", page: 1700, rating: "1500#", seen: [], line: "FAAA1G - Hydrocarbon, Sour Service", chunk: spec2 },
      ] }],
    },
  ];
  it("attaches every tie, then the class that fits the asked rating - not the Class 1500 one", () => {
    const ids = sweepPassages(sweeps, ["150"]).map((c) => c.id);
    expect(ids.slice(0, 2)).toEqual(["v1", "p1"]);
    expect(ids).toContain("s1");
    expect(ids).not.toContain("s2");
  });
  it("lists the whole map, with [n] for attached passages", () => {
    const names: Record<string, string> = { SPEC: "E2G Piping Specs (All).pdf", EP1283: "EP 12-8-3 - Control Valves", EP5116: "EP 5-11-6", EP10115: "EP 10-1-15" };
    const nOf: Record<string, number> = { v1: 23, s1: 30 };
    const text = sweepBlock(sweeps, (id) => names[id], (c) => nOf[c] ?? null, 1312, ["150"]);
    expect(text).toMatch(/searching all 1312 reachable documents/);
    expect(text).toMatch(/EP 12-8-3 - Control Valves p\.14 \(7\.0 Materials\) \[23\]: "7\.6 Valves for use in sour gas \(Wet H2S\)/);
    expect(text).toMatch(/writes "sour gas" as "Wet H2S"/);
    expect(text).toMatch(/AAAC2H p\.812 · rating 150# \[30\]: "AAAC2H - Hydrocarbon and\/or Hydrogen Rich Service, Sour Service \(200 BHN MAX\)"/);
    expect(text).toMatch(/1 recorded as Class 150/);
    expect(text).toMatch(/"sour gas": in 3 documents/);
    expect(text).toMatch(/EP 10-1-15 p\.7 \(not attached\)/);
  });
  it("a section is the last one starting at or before a page", () => {
    const secs = [{ key: "A", page: 1 }, { key: "B", page: 10 }, { key: "C", page: 20 }];
    expect(sectionAt(secs, 15)?.key).toBe("B");
    expect(sectionAt(secs, 20)?.key).toBe("C");
  });
});

import { pressureClassesOf, lineClassOf, pressureClassNote } from "@/lib/pressureClass";
import { partRegex } from "@/lib/ask/termSweep";

describe("a part rated differently from its line", () => {
  const q = "can i use 300 class flanges in a 150 class piping line if im bolting to a vessel nozzle";
  it("reads both classes and knows which is the line's", () => {
    expect(pressureClassesOf(q)).toEqual(["300", "150"]);
    expect(lineClassOf(q)).toBe("150");
    expect(lineClassOf("What piping spec for 150 class sour gas?")).toBe("150");
  });
  it("tells the answer both classes are the subject - not 'Class 300 doesn't answer it'", () => {
    const note = pressureClassNote("150", ["300", "150"]);
    expect(note).toMatch(/Class 300 components in a Class 150 line/);
    expect(note).not.toMatch(/do NOT answer it/);
    expect(pressureClassNote("150")).toMatch(/do NOT answer it/);
  });
  it("searches where Class 300 meets each subject - nozzle included - and drops filler", () => {
    const t = sweepTerms(q, [], 7, ["300", "150"], "150");
    expect(t.slice(0, 4)).toEqual(["class 300 + nozzle", "class 300 + vessel", "class 300 + bolting", "class 300 + flanges"]);
    expect(t).toContain("vessel nozzle");
    expect(t.join(" ")).not.toMatch(/\bim\b/);
  });
  it("finds the spec book's note: Class 300 with nozzle(s), in one sentence", () => {
    const note = "Notes 106 Use against control valves and other Class 300 flanged equipment nozzles as required per design drawings. F127 Normalized.";
    const [s] = sentencesWith(note, "class 300 + nozzle");
    expect(s).toMatch(/Class 300 flanged equipment nozzles/);
    expect(tieIn(s, "class 300 + nozzle", [])?.kind).toBe("together");
    expect(sentencesWith("Class 300 flanges. Nozzles are per the vessel drawing.", "class 300 + nozzle")).toEqual([]);
  });
  it("a class part reads every notation, and never 3000", () => {
    const re = partRegex("class 300");
    expect(["Class 300", "300#", "300 lb", "CL300", "300 class"].every((x) => re.test(x))).toBe(true);
    expect(re.test("Class 3000")).toBe(false);
  });
});

import { ratingsSeen } from "@/lib/ask/termSweep";

describe("the questions that failed on the real library", () => {
  it("'where it connects to a vessel': searches Class 300 with equipment and nozzle, never 'connects'", () => {
    const q = "can i use a 300 class flange on a 150 class piping system if its where it connects to a vessel";
    const t = sweepTerms(q, [], 7, ["300", "150"], "150");
    expect(t).toEqual(expect.arrayContaining(["class 300 + vessel", "class 300 + equipment", "class 300 + nozzle"]));
    expect(t.join(" ")).not.toMatch(/connects/);
  });
  it("reads which classes a spec page is written for when no rating was recorded", () => {
    const page = "Services: AAAC2H - Hydrocarbon and/or Hydrogen Rich Service, Sour Service (200 BHN MAX) Flanges 1D15210300 0.5 150 FLANGES: CS, Class 150, XXS 1D16210000 150 Blind, Class 150 1D15230300 300 FLANGES: Class 300, XXS";
    expect(ratingsSeen(page)[0]).toEqual(["150", 2]);
    expect(ratingsSeen(page).map(([n]) => n)).toContain("300");
  });
  it("a spec-book class with no recorded rating but Class 150 on its page is attached for a Class 150 question", () => {
    const ch = chunk("aaac2h", "SPEC", 812, "Services: AAAC2H - Hydrocarbon and/or Hydrogen Rich Service, Sour Service (200 BHN MAX)");
    const other = chunk("x", "SPEC", 1700, "Services: FAAA1G - Hydrocarbon, Sour Service");
    const sw: TermSweep[] = [{ term: "sour", docCount: 1, passageCount: 2, tooCommon: false, docs: [], sections: [{ documentId: "SPEC", items: [
      { key: "FAAA1G", page: 1700, rating: null, seen: [["1500", 9]], line: "FAAA1G - Hydrocarbon, Sour Service", chunk: other },
      { key: "AAAC2H", page: 812, rating: null, seen: [["150", 12], ["300", 4]], line: "AAAC2H - Hydrocarbon and/or Hydrogen Rich Service, Sour Service (200 BHN MAX)", chunk: ch },
    ] }] }];
    expect(sweepPassages(sw, ["150"]).map((c) => c.id)).toEqual(["aaac2h"]);
    const text = sweepBlock(sw, () => "E2G Piping Specs (All)", (id) => (id === "aaac2h" ? 9 : null), 1300, ["150"]);
    expect(text).toMatch(/AAAC2H p\.812 · no rating recorded · page shows Class 150 ×12, Class 300 ×4 \[9\]/);
    expect(text.indexOf("AAAC2H")).toBeLessThan(text.indexOf("FAAA1G"));
  });
});

describe("contents lines are not passages", () => {
  it("skips '7.0 LINE CLASS SELECTION ........ 4' and keeps the section text", () => {
    const text = "6.0 DESIGN CONDITIONS .......... 4 7.0 LINE CLASS SELECTION ............ 4 8.0 PIPING CLASS DESCRIPTION ..... 5";
    expect(sentencesWith(text, "class selection")).toEqual([]);
    expect(sentencesWith("7.1 A summary of each pipe class is provided in the Piping Class Service Index. The class selection requires the actual class.", "class selection")).toHaveLength(1);
  });
});
