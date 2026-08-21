import { describe, it, expect } from "vitest";
import {
  computeBidEconomics, scoreBids, validateParsedQuote, DEFAULT_WEIGHTS,
  type ParsedQuote,
} from "@/lib/bidTab";
import { buildCostSeries, computeForecast, plannedManpowerSeries } from "@/lib/costSeries";
import { computeProjectHealth, buildCoachItems, type ProjectStateSnapshot } from "@/lib/projectHealth";
import {
  validateSegmentedItems, applyAutoEvidence, rubricCoverageScore,
  validateRubricFindings, QUALITY_MANUAL_RUBRIC,
  type ChecklistItemState, type ProjectEvidenceState,
} from "@/lib/checklistEngine";
import { computeCompanyScorecard, scoreBand, type CompanyEvidence } from "@/lib/companyScore";
import { buildExampleCostData } from "@/lib/exampleProject";

// ── Bid tabulation ─────────────────────────────────────────────────────────

const quote = (over: Partial<ParsedQuote>): ParsedQuote => ({
  id: "q1", vendorName: "V", total: 100_000, lineItems: [], exclusions: [],
  currency: "USD", validUntil: null, notes: null, ...over,
});

describe("bidTab economics", () => {
  it("computes labor hours, blended rate, and dollars-per-hour", () => {
    const [e] = computeBidEconomics([quote({
      total: 120_000,
      lineItems: [
        { description: "Repipe unit 300 exchanger circuits", total: 100_000, hours: 1000, headcount: 8 },
        { description: "NDE examinations", total: 20_000, hours: null, headcount: null },
      ],
    })]);
    expect(e.laborHours).toBe(1000);
    expect(e.blendedRate).toBe(100);          // 100k labor / 1000h
    expect(e.dollarsPerHour).toBe(120);       // whole price / hours
    expect(e.peakHeadcount).toBe(8);
  });

  it("flags scope another bidder priced that this bid neither priced nor excluded", () => {
    const a = quote({ id: "a", lineItems: [
      { description: "Demolition and repipe exchanger circuits", total: 90_000, hours: 900 },
      { description: "Insulation reinstatement complete", total: 10_000, hours: 200 },
    ]});
    const b = quote({ id: "b", total: 80_000, lineItems: [
      { description: "Demolition and repipe exchanger circuits", total: 80_000, hours: 850 },
    ]});
    const econ = computeBidEconomics([a, b]);
    const bEcon = econ.find((e) => e.quoteId === "b")!;
    expect(bEcon.missingScope.some((m) => m.toLowerCase().includes("insulation"))).toBe(true);
    expect(econ.find((e) => e.quoteId === "a")!.missingScope).toHaveLength(0);
  });

  it("does NOT flag scope the bid explicitly excluded (it shows as exclusion instead)", () => {
    const a = quote({ id: "a", lineItems: [
      { description: "Insulation reinstatement complete", total: 10_000 },
      { description: "Demolition and repipe exchanger circuits", total: 90_000 },
    ]});
    const b = quote({ id: "b", exclusions: ["Insulation reinstatement"], lineItems: [
      { description: "Demolition and repipe exchanger circuits", total: 80_000 },
    ]});
    const bEcon = computeBidEconomics([a, b]).find((e) => e.quoteId === "b")!;
    expect(bEcon.missingScope.some((m) => m.toLowerCase().includes("insulation"))).toBe(false);
    expect(bEcon.exclusionCount).toBe(1);
  });

  it("weighted best value: cheapest does not automatically win when coverage/manpower lag", () => {
    const cheapButThin = quote({ id: "thin", total: 80_000, exclusions: ["NDE", "hydrotest", "insulation"], lineItems: [
      { description: "Repipe circuits scope", total: 80_000, hours: null },
    ]});
    const fullAndStaffed = quote({ id: "full", total: 95_000, lineItems: [
      { description: "Repipe circuits scope", total: 70_000, hours: 900 },
      { description: "NDE examinations", total: 10_000 },
      { description: "Hydrotest and reinstate", total: 10_000, hours: 150 },
      { description: "Insulation reinstatement", total: 5_000, hours: 100 },
    ]});
    const econ = computeBidEconomics([cheapButThin, fullAndStaffed]);
    const scores = scoreBids(econ, DEFAULT_WEIGHTS);
    const winner = scores.find((s) => s.best)!;
    expect(winner.quoteId).toBe("full");
    // The math is visible: the thin bid won price but lost manpower + coverage.
    const thin = scores.find((s) => s.quoteId === "thin")!;
    expect(thin.parts.price).toBe(100);
    expect(thin.parts.manpower).toBe(0);
  });

  it("validateParsedQuote hardens AI output and rejects unreadable totals", () => {
    const ok = validateParsedQuote({ vendorName: " Acme ", total: 5000, lineItems: [{ description: "x-line item", hours: 10 }], exclusions: ["a", 3] }, "id1");
    expect(ok.vendorName).toBe("Acme");
    expect(ok.exclusions).toEqual(["a"]);
    expect(ok.lineItems).toHaveLength(1);
    expect(() => validateParsedQuote({ vendorName: "A" }, "id2")).toThrow(/total/i);
  });
});

// ── Cost series + forecast ────────────────────────────────────────────────

describe("costSeries", () => {
  it("builds a monotonic S-curve with planned only when a schedule exists", () => {
    const s = buildCostSeries({
      budget: 100_000, scheduleStart: "2026-01-01", scheduleEnd: "2026-03-01",
      commitments: [{ date: "2026-01-10", amount: 60_000 }],
      actuals: [{ date: "2026-01-20", amount: 20_000 }, { date: "2026-02-10", amount: 30_000 }],
      points: 10,
    });
    expect(s).toHaveLength(10);
    expect(s[0].planned).toBe(0);
    expect(s[9].planned).toBe(100_000);
    expect(s[9].committed).toBe(60_000);
    expect(s[9].actual).toBe(50_000);
    for (let i = 1; i < s.length; i++) expect(s[i].actual).toBeGreaterThanOrEqual(s[i - 1].actual);
  });

  it("omits the planned curve without schedule dates instead of inventing one", () => {
    const s = buildCostSeries({ budget: 100_000, commitments: [], actuals: [{ date: "2026-01-05", amount: 10 }, { date: "2026-01-08", amount: 5 }] });
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((p) => p.planned === null)).toBe(true);
  });

  it("forecast prefers CPI basis and speaks plainly", () => {
    const fmt = (n: number) => `$${Math.round(n / 1000)}k`;
    const f = computeForecast({ budget: 100_000, spent: 50_000, cpi: 0.8, today: "2026-02-01", fmt });
    expect(f.basis).toBe("cpi");
    expect(f.eac).toBeCloseTo(125_000);
    expect(f.sentence).toContain("over budget");
    const none = computeForecast({ budget: 0, spent: 0, cpi: null, today: "2026-02-01", fmt });
    expect(none.sentence).toBeNull();
  });

  it("planned manpower spreads hours across weeks at 40h heads", () => {
    const series = plannedManpowerSeries({ laborHours: 800, scheduleStart: "2026-01-01", scheduleEnd: "2026-01-29" });
    expect(series).toHaveLength(4);
    expect(series[0].headcount).toBe(5); // 200h/wk / 40
  });
});

// ── Health + coach ────────────────────────────────────────────────────────

const snapshot = (over: Partial<ProjectStateSnapshot> = {}): ProjectStateSnapshot => ({
  hasPurpose: true, hasGoals: true, hasSow: true, jobKind: "standard",
  budget: 100_000, committed: 60_000, spent: 40_000, cpi: 1.0,
  accountCount: 3, accountsPinned: 2, partyCount: 1, quoteCount: 0,
  unawardedRfqGroups: 0, pendingCostDocs: 0,
  openChangeOrders: 0, approvedCoAmount: 0,
  milestoneCount: 10, overdueMilestones: 0, spi: 1.0, hasBaseline: true,
  checklistCount: 1, checklistOpenItems: 0, checklistNeedsEvidence: 0,
  turnoverRequired: 4, turnoverAccepted: 4, punchOpen: 0,
  intakeLinkCount: 1, membersCount: 3,
  ...over,
});

describe("projectHealth", () => {
  it("healthy project scores high; unknown dimensions are excluded, not free points", () => {
    const h = computeProjectHealth(snapshot());
    expect(h.score).toBeGreaterThanOrEqual(90);
    const empty = computeProjectHealth(snapshot({
      budget: 0, cpi: null, spent: 0, milestoneCount: 0, spi: null,
      checklistCount: 0, turnoverRequired: 0, openChangeOrders: 0, approvedCoAmount: 0,
    }));
    expect(empty.score).toBeNull(); // nothing known → honest null
  });

  it("change-order growth drags the composite", () => {
    const calm = computeProjectHealth(snapshot()).score!;
    const churning = computeProjectHealth(snapshot({ approvedCoAmount: 25_000, openChangeOrders: 3 })).score!;
    expect(churning).toBeLessThan(calm);
  });

  it("coach: empty project leads with budget + schedule, each stating its payoff", () => {
    const items = buildCoachItems(snapshot({
      budget: 0, milestoneCount: 0, checklistCount: 0, hasSow: false,
      hasPurpose: false, hasGoals: false, partyCount: 0, intakeLinkCount: 0, membersCount: 1,
      accountCount: 0, accountsPinned: 0, hasBaseline: false, spi: null, cpi: null,
    }), "p1");
    expect(items[0].id).toBe("budget");
    expect(items[1].id).toBe("schedule");
    expect(items.every((i) => i.payoff.length > 10 && i.href.startsWith("/projects/p1"))).toBe(true);
  });

  it("coach: pending parsed documents outrank pinning", () => {
    const items = buildCoachItems(snapshot({ pendingCostDocs: 2, accountsPinned: 0 }), "p1");
    const idx = (id: string) => items.findIndex((i) => i.id === id);
    expect(idx("confirm-docs")).toBeGreaterThanOrEqual(0);
    expect(idx("confirm-docs")).toBeLessThan(idx("pin-ev"));
  });
});

// ── Checklist engine ──────────────────────────────────────────────────────

describe("checklistEngine", () => {
  it("validates segmentation, dropping junk and capping runaway parses", () => {
    const items = validateSegmentedItems([
      { section: "General", text: "All equipment installed per design drawings" },
      { text: "ok" }, // too short — dropped
      { text: "Pressure test records complete and accepted" },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].seq).toBe(1);
    expect(() => validateSegmentedItems([])).toThrow(/No checklist items/);
  });

  const item = (over: Partial<ChecklistItemState>): ChecklistItemState => ({
    id: "i1", text: "", applicability: "applies", status: "open",
    manualNote: null, evidence: [], ...over,
  });
  const state = (over: Partial<ProjectEvidenceState> = {}): ProjectEvidenceState => ({
    turnoverAcceptedNames: [], miChecklistComplete: false, documentTitles: [], equipmentTags: [], ...over,
  });

  it("satisfies items whose evidence the platform holds, with the citation attached", () => {
    const res = applyAutoEvidence(
      [item({ id: "a", text: "Hydrotest complete with records" })],
      state({ documentTitles: ["E-301 Hydrotest Report Rev 0"] }),
    );
    expect(res).toEqual([{ id: "a", status: "satisfied", addedEvidence: [{ label: 'Document on file: "E-301 Hydrotest Report Rev 0"', source: "auto" }] }]);
  });

  it("marks evidence-shaped items needs_evidence when nothing is on file", () => {
    const res = applyAutoEvidence([item({ id: "a", text: "NDE reports reviewed and accepted" })], state());
    expect(res[0].status).toBe("needs_evidence");
  });

  it("never touches human-decided items or non-applicable ones", () => {
    const res = applyAutoEvidence([
      item({ id: "a", text: "Hydrotest complete", manualNote: "Verified in the field 8/12" }),
      item({ id: "b", text: "Weld maps accepted", applicability: "na" }),
      item({ id: "c", text: "Operators trained on the new bypass" }), // no rule matches
    ], state({ documentTitles: ["Hydrotest package"] }));
    expect(res).toHaveLength(0);
  });

  it("MI sign-off satisfies mechanical-integrity items", () => {
    const res = applyAutoEvidence(
      [item({ id: "a", text: "New equipment reviewed by the mechanical integrity group" })],
      state({ miChecklistComplete: true }),
    );
    expect(res[0].status).toBe("satisfied");
  });

  it("quality-manual rubric coverage scores confirmed areas only", () => {
    const findings = validateRubricFindings([
      { area: "welding", covered: true, finding: "WPS/PQR section present" },
      { area: "nde", covered: false, finding: "No NDE procedures found" },
      { area: "bogus", covered: true, finding: "ignored" },
    ]);
    expect(findings).toHaveLength(2);
    expect(rubricCoverageScore(findings)).toBe(Math.round((1 / QUALITY_MANUAL_RUBRIC.length) * 100));
  });
});

// ── Company scorecard ─────────────────────────────────────────────────────

const evidence = (over: Partial<CompanyEvidence> = {}): CompanyEvidence => ({
  recordables: 0, nearMisses: 0, warnings: 0, stopWorks: 0, commendations: 0,
  qualityManualScore: null, turnoverAccepted: 0, turnoverRejected: 0,
  punchClosed: 0, punchTotal: 0,
  awardsTotal: 0, finalCostTotal: 0, changeOrderCount: 0, changeOrderScopeGapCount: 0,
  milestonesOnTheirScopes: 0, milestonesHitOnTime: 0,
  submissionCount: 0, avgSubmitToReviewDays: null, avgAssignToSubmitDays: null,
  ...over,
});

describe("companyScore", () => {
  it("no evidence → null composite (Unrated), never a fake 100", () => {
    const card = computeCompanyScorecard(evidence());
    expect(card.composite).toBeNull();
    expect(scoreBand(card.composite).label).toBe("Unrated");
  });

  it("a recordable hurts far more than reported near misses", () => {
    const nearMisses = computeCompanyScorecard(evidence({ nearMisses: 3 }));
    const recordable = computeCompanyScorecard(evidence({ recordables: 1 }));
    const s = (c: typeof nearMisses) => c.dimensions.find((d) => d.key === "safety")!.score!;
    expect(s(nearMisses)).toBeGreaterThan(s(recordable));
  });

  it("underbidding shows: 20% growth with scope-gap COs scores worse than clean growth", () => {
    const clean = computeCompanyScorecard(evidence({ awardsTotal: 100_000, finalCostTotal: 120_000, changeOrderCount: 2, changeOrderScopeGapCount: 0 }));
    const gappy = computeCompanyScorecard(evidence({ awardsTotal: 100_000, finalCostTotal: 120_000, changeOrderCount: 2, changeOrderScopeGapCount: 2 }));
    const cost = (c: typeof clean) => c.dimensions.find((d) => d.key === "cost")!.score!;
    expect(cost(gappy)).toBeLessThan(cost(clean));
    expect(clean.dimensions.find((d) => d.key === "cost")!.detail).toContain("20% cost growth");
  });

  it("responsiveness shows OUR review clock in the detail — honest both ways", () => {
    const card = computeCompanyScorecard(evidence({ submissionCount: 5, avgAssignToSubmitDays: 3, avgSubmitToReviewDays: 9 }));
    const dim = card.dimensions.find((d) => d.key === "responsiveness")!;
    expect(dim.score).toBeGreaterThan(60);
    expect(dim.detail).toContain("our review took 9d");
  });
});

// ── Example data determinism ──────────────────────────────────────────────

describe("exampleProject", () => {
  it("is deterministic and internally consistent", () => {
    const a = buildExampleCostData();
    const b = buildExampleCostData();
    expect(a).toEqual(b);
    expect(a.quotes).toHaveLength(3);
    expect(a.accounts.reduce((s, x) => s + x.budget, 0)).toBe(a.budget);
    // The example bid tab must actually exercise the comparison math.
    const econ = computeBidEconomics(a.quotes);
    expect(econ.some((e) => e.missingScope.length > 0 || e.exclusionCount > 0)).toBe(true);
    expect(scoreBids(econ).filter((s) => s.best)).toHaveLength(1);
  });
});

// ── Adversarial-review regression pins ────────────────────────────────────
// Each test here pins the FIX for a defect the review fleet confirmed —
// remove one and you re-open a verified bug.

describe("review regressions", () => {
  it("a zero-dollar 'bid' never scores Infinity or wins best value", () => {
    const zero: ParsedQuote = {
      id: "z", vendorName: "Freebie Inc", total: 0, exclusions: [],
      lineItems: [{ description: "Demo and repipe the exchanger circuits", hours: 500 }],
    };
    const real: ParsedQuote = {
      id: "r", vendorName: "Real Co", total: 100_000, exclusions: [],
      lineItems: [{ description: "Demo and repipe the exchanger circuits", hours: 1000, total: 100_000 }],
    };
    const scores = scoreBids(computeBidEconomics([zero, real]));
    for (const s of scores) {
      expect(Number.isFinite(s.score)).toBe(true);
      expect(Number.isFinite(s.parts.manpower)).toBe(true);
    }
    expect(scores.find((s) => s.quoteId === "z")!.best).toBe(false);
    // And the validator refuses a zero total outright.
    expect(() => validateParsedQuote({ vendorName: "x", total: 0, lineItems: [] }, "id")).toThrow();
  });

  it("going over budget scores WORSE than sitting at budget (no discontinuity reward)", () => {
    const at = computeProjectHealth(snapshot({ cpi: null, spent: 100_000 })).parts.find((p) => p.label === "Cost")!;
    const over = computeProjectHealth(snapshot({ cpi: null, spent: 110_000 })).parts.find((p) => p.label === "Cost")!;
    expect(over.score!).toBeLessThan(at.score!);
  });

  it("short-abbreviation scope (NDE / RT) is judgeable — a bid that neither prices nor excludes it is flagged", () => {
    const withNde: ParsedQuote = {
      id: "a", vendorName: "A", total: 150_000, exclusions: [],
      lineItems: [
        { description: "Demo and repipe exchanger circuits", total: 120_000 },
        { description: "NDE (RT 10%)", total: 30_000 },
      ],
    };
    const silent: ParsedQuote = {
      id: "b", vendorName: "B", total: 120_000, exclusions: [],
      lineItems: [{ description: "Demo and repipe exchanger circuits", total: 120_000 }],
    };
    const econ = computeBidEconomics([withNde, silent]);
    expect(econ.find((e) => e.quoteId === "b")!.missingScope).toContain("NDE (RT 10%)");
    // …while "under" in an unrelated line never counts as mentioning NDE.
    const under: ParsedQuote = {
      id: "c", vendorName: "C", total: 120_000, exclusions: [],
      lineItems: [{ description: "Grout under baseplates and repipe exchanger circuits", total: 120_000 }],
    };
    const econ2 = computeBidEconomics([withNde, under]);
    expect(econ2.find((e) => e.quoteId === "c")!.missingScope).toContain("NDE (RT 10%)");
  });

  it("evidence rules match whole words only — no false green from 'grounded' or 'Rapid'", () => {
    const state: ProjectEvidenceState = {
      turnoverAcceptedNames: [], miChecklistComplete: false,
      documentTitles: ["NDE Report Pkg 4", "Rapid Response Plan Rev 2"],
      equipmentTags: [],
    };
    const items: ChecklistItemState[] = [
      { id: "1", text: "All piping supports grounded and bonded per spec", applicability: "applies", status: "open", manualNote: null, evidence: [] },
      { id: "2", text: "P&ID redlines complete", applicability: "applies", status: "open", manualNote: null, evidence: [] },
      { id: "3", text: "NDE complete per ITP", applicability: "applies", status: "open", manualNote: null, evidence: [] },
    ];
    const results = applyAutoEvidence(items, state);
    // "grounded and bonded" matches no rule — untouched, never satisfied.
    expect(results.find((r) => r.id === "1")).toBeUndefined();
    // "Rapid Response Plan" must NOT satisfy the P&ID item.
    const pid = results.find((r) => r.id === "2");
    expect(pid?.status ?? "needs_evidence").toBe("needs_evidence");
    // The real NDE doc still greens the real NDE item, citation attached.
    const nde = results.find((r) => r.id === "3")!;
    expect(nde.status).toBe("satisfied");
    expect(nde.addedEvidence[0].label).toContain("NDE Report Pkg 4");
  });

  it("entries dated after schedule end still reach the S-curve's terminal totals", () => {
    const series = buildCostSeries({
      budget: 100_000,
      scheduleStart: "2026-01-01", scheduleEnd: "2026-03-01",
      commitments: [{ date: "2026-01-10", amount: 80_000 }],
      actuals: [{ date: "2026-02-01", amount: 40_000 }, { date: "2026-03-15", amount: 40_000 }],
    });
    const last = series[series.length - 1];
    expect(last.actual).toBe(80_000);        // the late invoice is not dropped
    expect(last.planned).toBe(100_000);      // planned holds at budget past schedule end
  });

  it("quality health never grants vacuous checklist credit on a turnover-only project", () => {
    const noTurnoverProgress = computeProjectHealth(snapshot({
      checklistCount: 0, checklistOpenItems: 0, checklistNeedsEvidence: 0,
      turnoverRequired: 4, turnoverAccepted: 0,
    })).parts.find((p) => p.label === "Quality")!;
    expect(noTurnoverProgress.score!).toBeLessThanOrEqual(5);
  });

  it("responsiveness scoring is continuous around the 2-day mark", () => {
    const ev = (days: number): CompanyEvidence => ({
      recordables: 0, nearMisses: 0, warnings: 0, stopWorks: 0, commendations: 0,
      qualityManualScore: null, turnoverAccepted: 0, turnoverRejected: 0,
      punchClosed: 0, punchTotal: 0,
      awardsTotal: 0, finalCostTotal: 0, changeOrderCount: 0, changeOrderScopeGapCount: 0,
      milestonesOnTheirScopes: 0, milestonesHitOnTime: 0,
      submissionCount: 3, avgSubmitToReviewDays: null, avgAssignToSubmitDays: days,
    });
    const at2 = computeCompanyScorecard(ev(2)).dimensions.find((d) => d.key === "responsiveness")!.score!;
    const just = computeCompanyScorecard(ev(2.1)).dimensions.find((d) => d.key === "responsiveness")!.score!;
    expect(at2 - just).toBeLessThan(2);
  });
});
