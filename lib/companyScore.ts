// lib/companyScore.ts — the Known Company scorecard, pure.
//
// A company's score is built from EVIDENCE the platform already witnessed —
// bids, awards, change orders, turnover reviews, milestones on their scopes,
// safety events, submittal turnaround — never from a typed-in opinion. Five
// dimensions, each 0..100 with its inputs visible, plus a composite. A
// dimension with no evidence scores null and is EXCLUDED from the composite:
// an unknown is an unknown, never a free 100 and never a punishment.
//
// This is what makes "cost isn't the only factor" real at selection time:
// the bid tab shows these numbers beside every price.

export interface CompanyEvidence {
  // Safety (from company_events)
  recordables: number;
  nearMisses: number;
  warnings: number;
  stopWorks: number;
  commendations: number;
  // Quality
  qualityManualScore: number | null;   // 0..100 coverage, human-confirmed
  turnoverAccepted: number;
  turnoverRejected: number;
  punchClosed: number;
  punchTotal: number;
  // Cost discipline
  awardsTotal: number;                 // Σ awarded contract value
  finalCostTotal: number;              // Σ awarded + their approved COs
  changeOrderCount: number;
  changeOrderScopeGapCount: number;    // COs coded scope_gap — THEIR misses
  // Schedule reliability
  milestonesOnTheirScopes: number;
  milestonesHitOnTime: number;
  // Responsiveness (portal timestamps)
  submissionCount: number;
  avgSubmitToReviewDays: number | null; // OUR clock — how long we took
  avgAssignToSubmitDays: number | null; // THEIR clock — how long they took
}

export interface DimensionScore {
  key: "safety" | "quality" | "cost" | "schedule" | "responsiveness";
  label: string;
  score: number | null;
  detail: string;
}

export interface CompanyScorecard {
  composite: number | null;
  dimensions: DimensionScore[];
  /** Honest context the card must show: how much evidence backs this. */
  evidenceCount: number;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const r1 = (n: number) => Math.round(n * 10) / 10;

export function computeCompanyScorecard(e: CompanyEvidence): CompanyScorecard {
  const dims: DimensionScore[] = [];

  // SAFETY — severity-weighted deductions from 100. A recordable hurts far
  // more than a near miss REPORTED (near-miss reporting is healthy culture,
  // so it costs little); commendations claw a bit back.
  {
    const events = e.recordables + e.nearMisses + e.warnings + e.stopWorks + e.commendations;
    if (events === 0) {
      dims.push({ key: "safety", label: "Safety", score: null, detail: "No safety history recorded yet" });
    } else {
      const score = clamp(100 - e.recordables * 25 - e.stopWorks * 15 - e.warnings * 8 - e.nearMisses * 2 + e.commendations * 5);
      dims.push({
        key: "safety", label: "Safety", score: r1(score),
        detail: [
          e.recordables ? `${e.recordables} recordable${e.recordables === 1 ? "" : "s"}` : null,
          e.stopWorks ? `${e.stopWorks} stop-work${e.stopWorks === 1 ? "" : "s"}` : null,
          e.warnings ? `${e.warnings} warning${e.warnings === 1 ? "" : "s"}` : null,
          e.nearMisses ? `${e.nearMisses} near miss${e.nearMisses === 1 ? "" : "es"} reported` : null,
          e.commendations ? `${e.commendations} commendation${e.commendations === 1 ? "" : "s"}` : null,
        ].filter(Boolean).join(" · ") || "clean record",
      });
    }
  }

  // QUALITY — turnover acceptance rate (the hard evidence), quality-manual
  // coverage, punch burn-down.
  {
    const reviews = e.turnoverAccepted + e.turnoverRejected;
    const parts: number[] = [];
    const bits: string[] = [];
    if (reviews > 0) {
      parts.push((e.turnoverAccepted / reviews) * 100);
      bits.push(`turnover ${e.turnoverAccepted}/${reviews} accepted`);
    }
    if (e.qualityManualScore != null) {
      parts.push(e.qualityManualScore);
      bits.push(`quality manual covers ${Math.round(e.qualityManualScore)}%`);
    }
    if (e.punchTotal > 0) {
      parts.push((e.punchClosed / e.punchTotal) * 100);
      bits.push(`punch ${e.punchClosed}/${e.punchTotal} closed`);
    }
    dims.push(parts.length === 0
      ? { key: "quality", label: "Quality", score: null, detail: "No quality evidence yet" }
      : { key: "quality", label: "Quality", score: r1(clamp(parts.reduce((a, b) => a + b, 0) / parts.length)), detail: bits.join(" · ") });
  }

  // COST DISCIPLINE — did the final cost stay near the bid? Scope-gap COs
  // (their own misses) count double against them.
  {
    if (e.awardsTotal <= 0) {
      dims.push({ key: "cost", label: "Cost discipline", score: null, detail: "No awarded work yet" });
    } else {
      const growth = Math.max(0, (e.finalCostTotal - e.awardsTotal) / e.awardsTotal); // 0.2 = 20% over bid
      const gapShare = e.changeOrderCount > 0 ? e.changeOrderScopeGapCount / e.changeOrderCount : 0;
      const score = clamp(100 - growth * 250 - gapShare * growth * 250);
      dims.push({
        key: "cost", label: "Cost discipline", score: r1(score),
        detail: growth > 0
          ? `${Math.round(growth * 100)}% cost growth over bid · ${e.changeOrderCount} change order${e.changeOrderCount === 1 ? "" : "s"}${e.changeOrderScopeGapCount ? ` (${e.changeOrderScopeGapCount} from their scope gaps)` : ""}`
          : "finished on their bid",
      });
    }
  }

  // SCHEDULE RELIABILITY — milestone hit rate on their scopes.
  {
    if (e.milestonesOnTheirScopes === 0) {
      dims.push({ key: "schedule", label: "Schedule", score: null, detail: "No scheduled scopes yet" });
    } else {
      const rate = e.milestonesHitOnTime / e.milestonesOnTheirScopes;
      dims.push({
        key: "schedule", label: "Schedule", score: r1(clamp(rate * 100)),
        detail: `${e.milestonesHitOnTime}/${e.milestonesOnTheirScopes} milestones on time`,
      });
    }
  }

  // RESPONSIVENESS — their turnaround; OUR review clock shown honestly in
  // the detail so a slow score can't hide our own delay.
  {
    if (e.submissionCount === 0 || e.avgAssignToSubmitDays == null) {
      dims.push({ key: "responsiveness", label: "Responsiveness", score: null, detail: "No portal history yet" });
    } else {
      const d = e.avgAssignToSubmitDays;
      const score = clamp(d <= 2 ? 100 : d <= 5 ? 90 - (d - 2) * 8 : d <= 14 ? 66 - (d - 5) * 5 : 20 - (d - 14));
      dims.push({
        key: "responsiveness", label: "Responsiveness", score: r1(score),
        detail: `${r1(d)}d avg to submit${e.avgSubmitToReviewDays != null ? ` · our review took ${r1(e.avgSubmitToReviewDays)}d` : ""}`,
      });
    }
  }

  const known = dims.filter((x) => x.score != null) as Array<DimensionScore & { score: number }>;
  const evidenceCount =
    e.recordables + e.nearMisses + e.warnings + e.stopWorks + e.commendations +
    e.turnoverAccepted + e.turnoverRejected + e.changeOrderCount +
    e.milestonesOnTheirScopes + e.submissionCount + (e.qualityManualScore != null ? 1 : 0) +
    (e.awardsTotal > 0 ? 1 : 0);

  return {
    composite: known.length ? Math.round(known.reduce((a, x) => a + x.score, 0) / known.length) : null,
    dimensions: dims,
    evidenceCount,
  };
}

/** Grade band for the profile card's dial. */
export function scoreBand(score: number | null): { label: string; tone: "green" | "lime" | "amber" | "rose" | "slate" } {
  if (score == null) return { label: "Unrated", tone: "slate" };
  if (score >= 85) return { label: "Excellent", tone: "green" };
  if (score >= 70) return { label: "Good", tone: "lime" };
  if (score >= 50) return { label: "Watch", tone: "amber" };
  return { label: "Concern", tone: "rose" };
}
