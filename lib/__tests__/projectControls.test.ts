import { describe, it, expect } from "vitest";
import {
  computeBidEconomics, scoreBids, validateParsedQuote, DEFAULT_WEIGHTS,
  normalizeCompanyName, matchCompanyByName, isoCurrency, fieldCurrency, effectiveWeights,
  MANPOWER_MAX_COMPOSITE_SWING, bidCurrency, parseTypedAmount, withHumanTotal,
  type ParsedQuote,
} from "@/lib/bidTab";
import { buildCostSeries, computeForecast, plannedManpowerSeries } from "@/lib/costSeries";
import { computeProjectHealth, buildCoachItems, type ProjectStateSnapshot } from "@/lib/projectHealth";
import {
  validateSegmentedItems, applyAutoEvidence, rubricCoverageScore,
  validateRubricFindings, QUALITY_MANUAL_RUBRIC,
  type ChecklistItemState, type ProjectEvidenceState,
} from "@/lib/checklistEngine";
import { computeCompanyScorecard, scoreBand, MIN_EVIDENCE_FOR_BAND, type CompanyEvidence } from "@/lib/companyScore";
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

// ── Round G scoring honesty (BID-3 / BID-4 / BID-6 / BID-7 / COST-5) ──────

describe("bidTab honesty (Round G, DEC-47)", () => {
  const line = (description: string, total: number, hours: number | null = null) => ({ description, total, hours });

  it("BID-3 / COST-5: declaring an exclusion never lowers a bid's score relative to hiding it", () => {
    const rival = quote({ id: "rival", total: 100_000, lineItems: [line("Demo and repipe exchanger circuits", 80_000, 900), line("Insulation reinstatement complete", 20_000, 200)] });
    const declared = quote({ id: "d", total: 95_000, exclusions: ["Insulation reinstatement"], lineItems: [line("Demo and repipe exchanger circuits", 95_000, 900)] });
    const hidden = quote({ id: "h", total: 95_000, exclusions: [], lineItems: [line("Demo and repipe exchanger circuits", 95_000, 900)] });
    const sD = scoreBids(computeBidEconomics([rival, declared])).find((s) => s.quoteId === "d")!;
    const sH = scoreBids(computeBidEconomics([rival, hidden])).find((s) => s.quoteId === "h")!;
    expect(sD.score).toBe(sH.score);
    // The letter's promise ("declared exclusions do not") is the scorer's behaviour: coverage is not a scored part.
    expect(sD.parts.coverage).toBeNull();
    expect(sH.parts.coverage).toBeNull();
    // The declared exclusion is still a visible fact; the hidden gap is a check prompt, not a score.
    const eD = computeBidEconomics([rival, declared]).find((e) => e.quoteId === "d")!;
    const eH = computeBidEconomics([rival, hidden]).find((e) => e.quoteId === "h")!;
    expect(eD.exclusionCount).toBe(1);
    expect(eD.missingScope).toHaveLength(0);
    expect(eH.missingScope.some((m) => /insulation/i.test(m))).toBe(true);
  });

  it("COST-5: single-exclusion three-bid field — the disclosing bidder is not driven to a coverage part of 0", () => {
    const a = quote({ id: "a", total: 100_000, exclusions: ["Insulation reinstatement"], lineItems: [line("Demo and repipe exchanger circuits", 100_000, 1000)] });
    const b = quote({ id: "b", total: 100_000, lineItems: [line("Demo and repipe exchanger circuits", 100_000, 1000)] });
    const c = quote({ id: "c", total: 100_000, lineItems: [line("Demo and repipe exchanger circuits", 100_000, 1000)] });
    const scores = scoreBids(computeBidEconomics([a, b, c]));
    const sa = scores.find((s) => s.quoteId === "a")!;
    expect(sa.parts.coverage).not.toBe(0);
    expect(sa.score).toBe(scores.find((s) => s.quoteId === "b")!.score);
    // All three tie — none is badged; the tie is rendered as a tie.
    expect(scores.every((s) => !s.best && s.tied)).toBe(true);
  });

  it("BID-4: realistically-worded competing bids — coverage never drives the score; prompts are prompts", () => {
    const alpha = quote({ id: "alpha", total: 180_000, lineItems: [
      line("Remove and dispose existing piping at E-301", 60_000, 600),
      line("Fabricate and erect replacement spools (ISO 301-A)", 90_000, 900),
      line("Hydrotest, dry and return to operations", 30_000, 300),
    ]});
    const bravo = quote({ id: "bravo", total: 172_000, lineItems: [
      line("Demolition of existing 6-inch process piping", 58_000, 580),
      line("Install new spool pieces per ISO 301-A", 86_000, 860),
      line("Hydrostatic test and reinstate to service", 28_000, 280),
    ]});
    const econ = computeBidEconomics([alpha, bravo]);
    // Token-set similarity absorbs "existing piping" / "spool ... ISO 301-A"; only the
    // hydrotest wording is left as a CHECK prompt (a prompt to open the PDF, not an accusation).
    for (const e of econ) expect(e.missingScope.length).toBeLessThanOrEqual(1);
    const scores = scoreBids(econ);
    for (const s of scores) expect(s.parts.coverage).toBeNull();
    // Same bids with the prompts stripped score identically: the prompt is not in the score.
    const stripped = scoreBids(econ.map((e) => ({ ...e, missingScope: [] })));
    expect(scores.map((s) => s.score)).toEqual(stripped.map((s) => s.score));
  });

  it("COST-5: padded hours cannot buy best value against a slightly cheaper honest bid (swing capped)", () => {
    const honest = quote({ id: "honest", total: 188_000, lineItems: [line("Repipe unit 300 exchanger circuits", 188_000, 2000)] });
    const padded = quote({ id: "padded", total: 200_000, lineItems: [line("Repipe unit 300 exchanger circuits", 200_000, 4000)] });
    const scores = scoreBids(computeBidEconomics([honest, padded]));
    expect(scores.find((s) => s.best)!.quoteId).toBe("honest");
    // Between two bids that state hours, the manpower part moves the composite by at most the cap.
    const w = effectiveWeights();
    const h = scores.find((s) => s.quoteId === "honest")!, p = scores.find((s) => s.quoteId === "padded")!;
    expect((p.parts.manpower! - h.parts.manpower!) * w.manpower).toBeLessThanOrEqual(MANPOWER_MAX_COMPOSITE_SWING + 1e-9);
    // Not stating hours at all scores 0 on manpower — below every stated figure; undisclosed never beats disclosed.
    const silent = quote({ id: "silent", total: 188_000, lineItems: [line("Repipe unit 300 exchanger circuits", 188_000, null)] });
    const s2 = scoreBids(computeBidEconomics([silent, padded]));
    expect(s2.find((s) => s.quoteId === "silent")!.parts.manpower).toBe(0);
  });

  it("BID-6: a single bid shows a score with no best-value badge; a tie is a tie", () => {
    const only = scoreBids(computeBidEconomics([quote({ id: "solo", lineItems: [line("Repipe circuits", 100_000, 1000)] })]));
    expect(only[0].score).not.toBeNull();
    expect(only[0].best).toBe(false);
    const twins = scoreBids(computeBidEconomics([
      quote({ id: "t1", lineItems: [line("Repipe circuits", 100_000, 1000)] }),
      quote({ id: "t2", lineItems: [line("Repipe circuits", 100_000, 1000)] }),
    ]));
    expect(twins.every((s) => !s.best && s.tied)).toBe(true);
  });

  it("BID-7 / COST-8: a mixed-currency field is refused — nothing scored, nothing badged", () => {
    const econ = computeBidEconomics([
      quote({ id: "us", currency: "USD", total: 195_000, lineItems: [line("Repipe circuits", 195_000, 2000)] }),
      quote({ id: "eu", currency: "EUR", total: 168_000, lineItems: [line("Repipe circuits", 168_000, 2000)] }),
    ]);
    expect(fieldCurrency(econ)).toEqual({ currency: null, currencies: ["USD", "EUR"], mixed: true });
    const scores = scoreBids(econ);
    expect(scores.every((s) => s.score === null && !s.best && s.unscored === "mixed-currency")).toBe(true);
    // An unknown currency beside a known one is NOT mixed — it is taken as the field's.
    const same = computeBidEconomics([quote({ id: "a", currency: "USD" }), quote({ id: "b", currency: null })]);
    expect(fieldCurrency(same).mixed).toBe(false);
    expect(isoCurrency("eur")).toBe("EUR");
    expect(isoCurrency("dollars")).toBeNull();
    expect(isoCurrency("$")).toBeNull();
  });

  it("BID-12 / COST-3: normalised company matching resolves realistic letterhead variants, never ambiguity", () => {
    const registry = [{ id: "g", name: "Gulf Mechanical" }, { id: "a", name: "Apex Industrial" }, { id: "a2", name: "Apex Industrial Services" }];
    expect(normalizeCompanyName("Gulf Mechanical, Inc.")).toBe("gulf mechanical");
    expect(normalizeCompanyName("GULF  MECHANICAL LLC")).toBe("gulf mechanical");
    expect(normalizeCompanyName("The Gulf Mechanical Co. Ltd")).toBe("gulf mechanical");
    expect(normalizeCompanyName("A&B Fabrication")).toBe("a and b fabrication");
    expect(matchCompanyByName("Gulf Mechanical, Inc.", registry)?.id).toBe("g");
    expect(matchCompanyByName("Apex Industrial Services, LLC", registry)?.id).toBe("a2");
    expect(matchCompanyByName("Apex", registry)).toBeNull();          // no fuzzy binding
    expect(matchCompanyByName("Unknown vendor", registry)).toBeNull();
    // Two registry rows that normalise alike never auto-bind.
    expect(matchCompanyByName("Gulf Mechanical", [...registry, { id: "dup", name: "Gulf Mechanical LLC" }])).toBeNull();
  });

  it("COST-5 / DEC-47 (recorded for ratification): silence on hours scores 0, so stating ANY hours is worth up to 100 × the manpower share; the 5-point cap binds hours against hours only", () => {
    const w = effectiveWeights();
    const silent = quote({ id: "silent", total: 100_000, lineItems: [line("Repipe unit 300 exchanger circuits", 100_000, null)] });
    const oneHour = quote({ id: "one", total: 240_000, lineItems: [line("Repipe unit 300 exchanger circuits", 240_000, 1)] });
    const scores = scoreBids(computeBidEconomics([silent, oneHour]));
    const si = scores.find((s) => s.quoteId === "silent")!, oh = scores.find((s) => s.quoteId === "one")!;
    expect(si.parts.manpower).toBe(0);
    expect(oh.parts.manpower).toBe(100);
    // The consequence the record states, not the one DEC-47 once claimed: 37.5 composite points at the default weights.
    expect((oh.parts.manpower! - si.parts.manpower!) * w.manpower).toBeCloseTo(100 * w.manpower, 9);
    expect(100 * w.manpower).toBeCloseTo(37.5, 9);
    expect(si.score).toBe(62.5);
    expect(oh.score).toBe(63.5);
    // …which is why the badge sits on the 2.4×-priced bid here. Changing this is the user's call (DEC-47 reversal).
    expect(scores.find((s) => s.best)!.quoteId).toBe("one");
  });

  it("BID-5 limb: a one-word declared exclusion covers the longer scope line built on it — never 'excludes: NDE' beside 'check: NDE (RT 10%)'", () => {
    const rival = quote({ id: "r", total: 100_000, lineItems: [line("Repipe exchanger circuits", 90_000, 900), line("NDE (RT 10%)", 10_000)] });
    const excl = quote({ id: "x", total: 85_000, exclusions: ["NDE"], lineItems: [line("Repipe exchanger circuits", 85_000, 850)] });
    const silentGap = quote({ id: "s", total: 85_000, lineItems: [line("Repipe exchanger circuits", 85_000, 850)] });
    const econ = computeBidEconomics([rival, excl, silentGap]);
    expect(econ.find((e) => e.quoteId === "x")!.missingScope).toEqual([]);
    // Without the declaration the same line is still a prompt to check.
    expect(econ.find((e) => e.quoteId === "s")!.missingScope).toEqual(["NDE (RT 10%)"]);
    // A multi-word exclusion still needs two shared words: "Insulation removal" does not cover "Insulation reinstatement complete".
    const other = quote({ id: "o", total: 85_000, exclusions: ["Insulation removal"], lineItems: [line("Repipe exchanger circuits", 85_000, 850)] });
    const withInsul = quote({ id: "w", total: 100_000, lineItems: [line("Repipe exchanger circuits", 90_000, 900), line("Insulation reinstatement complete", 10_000)] });
    expect(computeBidEconomics([withInsul, other]).find((e) => e.quoteId === "o")!.missingScope).toEqual(["Insulation reinstatement complete"]);
  });

  it("BID-7: a bid with no printed currency is shown, scored and awarded in the field's currency, marked assumed — never in dollars beside euros", () => {
    const econ = computeBidEconomics([
      quote({ id: "eu", currency: "EUR", total: 150_000, lineItems: [line("Repipe circuits", 150_000, 1500)] }),
      quote({ id: "unk", currency: null, total: 140_000, lineItems: [line("Repipe circuits", 140_000, 1500)] }),
    ]);
    const field = fieldCurrency(econ);
    expect(field).toEqual({ currency: "EUR", currencies: ["EUR"], mixed: false });
    expect(bidCurrency(econ.find((e) => e.quoteId === "unk")!.currency, field)).toEqual({ code: "EUR", known: true, note: "currency not printed — assumed EUR" });
    expect(bidCurrency("EUR", field)).toEqual({ code: "EUR", known: true, note: null });
    // In a mixed field an unprinted currency cannot be vouched for.
    expect(bidCurrency(null, { currency: null, currencies: ["USD", "EUR"] })).toEqual({ code: "USD", known: false, note: "currency not printed — unknown in a mixed field" });
    // No currency printed anywhere: the display default, unmarked (nothing to be inconsistent with).
    expect(bidCurrency(null, { currency: null, currencies: [] })).toEqual({ code: "USD", known: false, note: null });
  });

  it("BID-7: restating a foreign bid ('correct total' with a currency code) joins it to the field — the mixed flag clears and the AI's reading stays", () => {
    const eu = quote({ id: "eu", currency: "EUR", total: 150_000, lineItems: [line("Repipe circuits", 150_000, 1500)] });
    const us = quote({ id: "us", currency: "USD", total: 170_000, lineItems: [line("Repipe circuits", 170_000, 1600)] });
    expect(fieldCurrency(computeBidEconomics([eu, us])).mixed).toBe(true);
    const typed = parseTypedAmount("162,000 USD");
    expect(typed).toEqual({ amount: 162_000, currency: "USD", badCurrency: null });
    // The panel writes total_amount AND currency on the row; the table overlays both.
    const econ = computeBidEconomics([withHumanTotal(eu, typed.amount, typed.currency), us]);
    expect(fieldCurrency(econ)).toEqual({ currency: "USD", currencies: ["USD"], mixed: false });
    expect(econ.find((e) => e.quoteId === "eu")).toMatchObject({ total: 162_000, currency: "USD", totalSource: "human", extractedTotal: 150_000, extractedCurrency: "EUR" });
    expect(scoreBids(econ).every((s) => s.score != null)).toBe(true);
    // A row whose currency matches the extraction is not a restatement.
    expect(withHumanTotal(eu, 150_000, "EUR").totalSource).toBe("extracted");
    expect(parseTypedAmount("182000EUR").currency).toBe("EUR");
    expect(parseTypedAmount("USD 1,182,000.50")).toEqual({ amount: 1_182_000.5, currency: "USD", badCurrency: null });
    expect(parseTypedAmount("182000 XYZ").badCurrency).toBe("XYZ");
    expect(parseTypedAmount("182000").currency).toBeNull();
    expect(parseTypedAmount("n/a").amount).toBeNull();
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

  it("COST-7: 25% growth entirely from owner_request COs scores the same as finishing on bid", () => {
    // The gatherer keeps owner-driven COs OUT of finalCostTotal and reports them separately.
    const onBid = computeCompanyScorecard(evidence({ awardsTotal: 500_000, finalCostTotal: 500_000, changeOrderCount: 0 }));
    const ownerGrowth = computeCompanyScorecard(evidence({
      awardsTotal: 500_000, finalCostTotal: 500_000, changeOrderCount: 2, changeOrderScopeGapCount: 0,
      ownerDrivenCoCount: 2, ownerDrivenCoTotal: 125_000,
    }));
    const cost = (c: typeof onBid) => c.dimensions.find((d) => d.key === "cost")!;
    expect(cost(ownerGrowth).score).toBe(cost(onBid).score);
    expect(cost(ownerGrowth).score).toBe(100);
    // The detail shows its work: the owner-side counter is surfaced, not hidden.
    expect(cost(ownerGrowth).detail).toContain("2 owner-driven COs");
    expect(cost(ownerGrowth).detail).toContain("25% growth on our side");
    // Contractor-driven growth still counts, and says so.
    const gap = computeCompanyScorecard(evidence({ awardsTotal: 500_000, finalCostTotal: 625_000, changeOrderCount: 1, changeOrderScopeGapCount: 1 }));
    expect(cost(gap).score).toBeLessThan(100);
    expect(cost(gap).detail).toContain("contractor-driven");
  });

  it("COST-12: one commendation is not 'Excellent' — the band is provisional below the evidence floor", () => {
    const one = computeCompanyScorecard(evidence({ commendations: 1 }));
    expect(one.composite).toBe(100);
    expect(one.evidenceCount).toBe(1);
    expect(scoreBand(one.composite, one.evidenceCount).label).toBe("Provisional");
    expect(scoreBand(one.composite).label).toBe("Excellent"); // without the count the old call still grades
    const enough = computeCompanyScorecard(evidence({ commendations: MIN_EVIDENCE_FOR_BAND }));
    expect(scoreBand(enough.composite, enough.evidenceCount).label).toBe("Excellent");
  });

  it("COST-12: an unlinked company reads 'unlinked', distinct from 'no work'", () => {
    const unlinked = computeCompanyScorecard(evidence({ partiesLinked: 0 }));
    const linkedNoWork = computeCompanyScorecard(evidence({ partiesLinked: 2 }));
    const cost = (c: typeof unlinked) => c.dimensions.find((d) => d.key === "cost")!.detail;
    expect(cost(unlinked)).toMatch(/Unlinked/);
    expect(cost(linkedNoWork)).toBe("No awarded work yet");
    expect(unlinked.dimensions.find((d) => d.key === "quality")!.detail).toMatch(/Unlinked/);
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
