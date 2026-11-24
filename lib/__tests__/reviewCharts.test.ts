// Where the late hours went: each cause said on its own bar's row, in the
// record's words, never a work order's name standing in for a reason.

import { describe, it, expect } from "vitest";
import { causeWords } from "@/components/projects/ReviewCharts";

describe("causeWords", () => {
  const seg = { key: "job:1", title: "E-12 - Transmix Feed/Trans. Diesel Exchanger No. 2", hours: 3 };
  const job = {
    source: "job" as const, title: seg.title,
    drafted: { title: seg.title, observation: "The material shortfall held E-17 too. We waited on the gaskets.", rating: "gap" as const },
    proof: "The material shortfall held E-17 too.", observation: "The material shortfall held E-17 too. We waited on the gaskets.",
  };
  it("a note written on the job says what it says, and where it was written", () => {
    // E-17's piece goes to a note written on E-12 that names E-17: its
    // heading is E-12's name, which on E-17's bar reads as the wrong job.
    expect(causeWords(seg, job)).toBe("“The material shortfall held E-17 too”, written on E-12");
  });
  it("a headline is said as it is", () => {
    expect(causeWords({ ...seg, title: "A material shortfall set the finish" }, { ...job, source: "records", title: "A material shortfall set the finish" })).toBe("A material shortfall set the finish");
    // A person changed the heading of a note: their words.
    expect(causeWords(seg, { ...job, title: "Gaskets came late for E-12 and E-17" })).toBe("Gaskets came late for E-12 and E-17");
  });
  it("nothing to explain it: the bar's own words", () => {
    expect(causeWords({ key: null, title: "Not explained by the records", hours: 4 }, undefined)).toBe("Not explained by the records");
  });
});
