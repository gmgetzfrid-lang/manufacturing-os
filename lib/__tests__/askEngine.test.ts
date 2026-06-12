// lib/__tests__/askEngine.test.ts
//
// parseAsk is the cockpit console's question router — pure string →
// intent. Misrouting sends a user to the wrong engine, so the
// grammar is pinned here.

import { describe, it, expect } from "vitest";
import { parseAsk } from "@/lib/askEngine";

describe("parseAsk", () => {
  it("routes who-questions to who-has with the subject extracted", () => {
    expect(parseAsk("who has E-204?")).toEqual({ kind: "who-has", subject: "E-204" });
    expect(parseAsk("who's got the overhead P&ID")).toEqual({ kind: "who-has", subject: "the overhead P&ID" });
    expect(parseAsk("who checked out ISO-204-12?")).toEqual({ kind: "who-has", subject: "ISO-204-12" });
  });

  it("routes blocked/holds questions", () => {
    expect(parseAsk("what's blocked?")).toEqual({ kind: "blocked" });
    expect(parseAsk("show me the holds")).toEqual({ kind: "blocked" });
  });

  it("routes overdue questions", () => {
    expect(parseAsk("what's overdue")).toEqual({ kind: "overdue" });
  });

  it("routes collision questions", () => {
    expect(parseAsk("any collisions?")).toEqual({ kind: "collisions" });
    expect(parseAsk("scope overlaps")).toEqual({ kind: "collisions" });
  });

  it("routes find-prefixed queries with the subject", () => {
    expect(parseAsk("find P-101 P&ID")).toEqual({ kind: "find", subject: "P-101 P&ID" });
    expect(parseAsk("where is the gasket spec?")).toEqual({ kind: "find", subject: "the gasket spec" });
  });

  it("falls back to find with the whole query", () => {
    expect(parseAsk("relief valve cert")).toEqual({ kind: "find", subject: "relief valve cert" });
  });

  it("strips trailing question marks everywhere", () => {
    expect(parseAsk("collisions???")).toEqual({ kind: "collisions" });
  });
});
