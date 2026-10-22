import { describe, it, expect } from "vitest";
import { sweepTerms, sentencesWith, tieIn, sweepPassages, sweepBlock, sectionAt, type TermSweep, type SweepChunk } from "@/lib/ask/termSweep";

const chunk = (id: string, docId: string, page: number, content: string, section: string | null = null): SweepChunk =>
  ({ id, document_id: docId, library_id: "L", page, section, content });

describe("sweepTerms — the asker's own words", () => {
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
  it("a related term in the same sentence is noted as such — weaker than a parenthesis", () => {
    const s = "Valves for use in sour gas (H2S) service shall conform to NACE MR0103.";
    expect(tieIn(s, "sour gas", ["nace"])).toEqual({ kind: "paren", to: "H2S" });
    expect(tieIn("Sour gas lines shall meet NACE MR0103.", "sour gas", ["nace"])).toEqual({ kind: "related", to: "nace" });
  });
  it("a definition counts", () => {
    expect(tieIn("Sour gas – gas containing hydrogen sulfide above 50 ppm.", "sour gas", [])?.kind).toBe("defines");
  });
  it("whole words only", () => {
    expect(sentencesWith("Soured crude was stored.", "sour")).toEqual([]);
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
        { key: "AAAC2H", page: 812, rating: "150#", line: "AAAC2H - Hydrocarbon and/or Hydrogen Rich Service, Sour Service (200 BHN MAX)", chunk: spec },
        { key: "FAAA1G", page: 1700, rating: "1500#", line: "FAAA1G - Hydrocarbon, Sour Service", chunk: spec2 },
      ] }],
    },
  ];
  it("attaches every tie, then the class that fits the asked rating — not the Class 1500 one", () => {
    const ids = sweepPassages(sweeps, "150").map((c) => c.id);
    expect(ids.slice(0, 2)).toEqual(["v1", "p1"]);
    expect(ids).toContain("s1");
    expect(ids).not.toContain("s2");
  });
  it("lists the whole map, with [n] for attached passages", () => {
    const names: Record<string, string> = { SPEC: "E2G Piping Specs (All).pdf", EP1283: "EP 12-8-3 - Control Valves", EP5116: "EP 5-11-6", EP10115: "EP 10-1-15" };
    const nOf: Record<string, number> = { v1: 23, s1: 30 };
    const text = sweepBlock(sweeps, (id) => names[id], (c) => nOf[c] ?? null, 1312, "150");
    expect(text).toMatch(/searching all 1312 reachable documents/);
    expect(text).toMatch(/EP 12-8-3 - Control Valves p\.14 \(7\.0 Materials\) \[23\]: "7\.6 Valves for use in sour gas \(Wet H2S\)/);
    expect(text).toMatch(/writes "sour gas" as "Wet H2S"/);
    expect(text).toMatch(/AAAC2H p\.812 · rating 150# \[30\]: "AAAC2H - Hydrocarbon and\/or Hydrogen Rich Service, Sour Service \(200 BHN MAX\)"/);
    expect(text).toMatch(/1 recorded as Class 150/);
    expect(text).toMatch(/EP 10-1-15 p\.7 \(not attached\)/);
  });
  it("a section is the last one starting at or before a page", () => {
    const secs = [{ key: "A", page: 1 }, { key: "B", page: 10 }, { key: "C", page: 20 }];
    expect(sectionAt(secs, 15)?.key).toBe("B");
    expect(sectionAt(secs, 20)?.key).toBe("C");
  });
});
