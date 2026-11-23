// Each requirement says where it came from, truthfully: the app's default,
// set when the project was made, or set for this project (when and by whom
// only when that was recorded).

import { describe, it, expect } from "vitest";
import { sourceWords, stampWords, whoWord, latestStamp, pssrSource, turnoverSource, jobSizeWord } from "@/lib/requirementSource";

const tz = "America/Los_Angeles";
const now = Date.parse("2026-11-23T18:00:00Z");

describe("requirementSource", () => {
  it("who: an email's name part, a name as it is", () => {
    expect(whoWord("ggetzfrid@kernenergy.com")).toBe("ggetzfrid");
    expect(whoWord("Ireland Barton")).toBe("Ireland Barton");
    expect(whoWord("  ")).toBeNull();
    expect(whoWord(null)).toBeNull();
  });

  it("stamp: the day in the plant's zone, the year only when it isn't this one", () => {
    expect(stampWords({ at: "2026-10-21T02:00:00Z", by: "ggetzfrid@kernenergy.com" }, tz, now)).toBe("Oct 20 by ggetzfrid");
    expect(stampWords({ at: "2025-03-02T20:00:00Z" }, tz, now)).toBe("Mar 2, 2025");
    expect(stampWords({ by: "Art Lopez" }, tz, now)).toBe("by Art Lopez");
    expect(stampWords({}, tz, now)).toBe("");
    expect(stampWords(null, tz, now)).toBe("");
  });

  it("source lines say only what is recorded", () => {
    expect(sourceWords({ kind: "default", note: "each phase needs its own PSSR" }, tz, now)).toBe("App default: each phase needs its own PSSR");
    expect(sourceWords({ kind: "set", stamp: { at: 1794579903228, by: "ggetzfrid@kernenergy.com" } }, tz, now)).toBe("Set for this project (Nov 13 by ggetzfrid)");
    expect(sourceWords({ kind: "set" }, tz, now)).toBe("Set for this project");
    expect(sourceWords({ kind: "made", stamp: { at: "2026-10-13T17:32:57Z" } }, tz, now)).toBe("Set when the project was made (Oct 13)");
    expect(sourceWords({ kind: "asked", by: "the post-event review" }, tz, now)).toBe("Asked by the post-event review");
    expect(sourceWords({ kind: "skipped", stamp: { at: "2026-10-13T17:32:57Z" } }, tz, now)).toBe("Skipped when the project was made (Oct 13)");
  });

  it("latest stamp: the newest with a time", () => {
    expect(latestStamp([{ at: "2026-11-01T00:00:00Z", by: "a" }, null, { by: "no time" }, { at: "2026-11-18T00:00:00Z", by: "b" }])?.by).toBe("b");
    expect(latestStamp([null, { by: "x" }])).toBeNull();
  });

  it("PSSR: the app's rule until a person changes it", () => {
    expect(pssrSource(undefined, true)).toEqual({ kind: "default", note: "each phase needs its own PSSR" });
    expect(pssrSource({ notNeeded: false }, false)).toEqual({ kind: "default", note: "every project needs a PSSR" });
    // Marked not needed before who and when were kept: no made-up date.
    expect(pssrSource({ notNeeded: true }, true)).toEqual({ kind: "set", stamp: null });
    expect(sourceWords(pssrSource({ notNeeded: true, at: "2026-11-23T17:00:00Z", by: "eng@kern.test" }, true), tz, now)).toBe("Set for this project (Nov 23 by eng)");
    expect(sourceWords(pssrSource({ notNeeded: false, at: "2026-11-23T17:00:00Z", by: "eng@kern.test" }, true), tz, now)).toBe("Set for this project (Nov 23 by eng)");
  });

  it("turnover: none required is the default; a list that came with the project says so", () => {
    expect(turnoverSource([], "2026-10-13T17:32:57Z")).toEqual({ kind: "default", note: "no documents required until you add them" });
    expect(turnoverSource([{ required: false, createdAt: "2026-10-20T00:00:00Z" }], null).kind).toBe("default");
    const names = (u: string | null | undefined) => (u === "u1" ? "ggetzfrid@kernenergy.com" : null);
    const made = turnoverSource([{ required: true, createdAt: "2026-10-13T17:33:10Z", createdBy: "u1" }], "2026-10-13T17:32:57Z", names);
    expect(sourceWords(made, tz, now)).toBe("Set when the project was made (Oct 13 by ggetzfrid)");
    const later = turnoverSource([{ required: true, createdAt: "2026-10-21T02:00:00Z", createdBy: "u9" }], "2026-10-13T17:32:57Z", names);
    expect(sourceWords(later, tz, now)).toBe("Set for this project (Oct 20)");
  });

  it("job size words", () => {
    expect(jobSizeWord("capital")).toBe("Capital project");
    expect(jobSizeWord(null)).toBe("Standard project");
  });
});
