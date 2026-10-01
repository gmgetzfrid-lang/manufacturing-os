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

import { readExtent } from "@/lib/bidTab";

export interface CompanyEvidence {
  // Safety (from company_events)
  recordables: number;
  nearMisses: number;
  warnings: number;
  stopWorks: number;
  commendations: number;
  // Quality
  qualityManualScore: number | null;   // 0..100 coverage, human-confirmed
  /** How much of the manual the evaluation saw (COST-3): a coverage
   *  figure from a truncated or unknown-extent read never renders bare. */
  qualityManualPagesRead?: number | null;
  qualityManualPagesTotal?: number | null;
  turnoverAccepted: number;
  turnoverRejected: number;
  punchClosed: number;
  punchTotal: number;
  // Cost discipline. The reason-code contract (lib/changeOrders.ts):
  // scope_gap lands on the contractor, design_error and owner_request land
  // on us, field_condition is contractor-neutral (DEC-48). Only the
  // contractor-attributable total enters the growth numerator.
  awardsTotal: number;                 // Σ awarded work, per party: posted commitments, else that party's contract_value
  finalCostTotal: number;              // Σ awarded + their CONTRACTOR-ATTRIBUTABLE approved COs
  changeOrderCount: number;            // every approved CO on their scopes (shown, not all scored)
  changeOrderScopeGapCount: number;    // COs coded scope_gap — THEIR misses
  ownerDrivenCoCount?: number;         // design_error + owner_request — OUR side of the ledger
  ownerDrivenCoTotal?: number;
  neutralCoCount?: number;             // field_condition / other — nobody's miss
  neutralCoTotal?: number;
  /** Where awardsTotal came from, so the card can say "contract value
   *  typed on the party" versus "posted commitments" — "mixed" when some
   *  parties contribute each way (the base is resolved per party). */
  awardsSource?: "entries" | "contract_value" | "mixed" | "none";
  awardsPostedPartyCount?: number;
  awardsTypedPartyCount?: number;
  /** How many project parties are linked to this registry row. 0 means
   *  the evidence channels that hang off party_id CANNOT reach it — an
   *  unlinked company must never read as an unrated-but-clean one. */
  partiesLinked?: number;
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

  const unlinked = (e.partiesLinked ?? 1) === 0;
  const unlinkedNote = "no project's contractor is linked to this company — link one on that project's Costs tab";

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
      const extent = readExtent(e.qualityManualPagesRead, e.qualityManualPagesTotal);
      bits.push(`quality manual covers ${Math.round(e.qualityManualScore)}%${extent.known && !extent.truncated ? "" : ` (${extent.label})`}`);
    }
    if (e.punchTotal > 0) {
      parts.push((e.punchClosed / e.punchTotal) * 100);
      bits.push(`punch ${e.punchClosed}/${e.punchTotal} closed`);
    }
    dims.push(parts.length === 0
      ? { key: "quality", label: "Quality", score: null, detail: unlinked ? `Unlinked — turnover and punch evidence can't reach this record (${unlinkedNote})` : "No quality evidence yet" }
      : { key: "quality", label: "Quality", score: r1(clamp(parts.reduce((a, b) => a + b, 0) / parts.length)), detail: bits.join(" · ") });
  }

  // COST DISCIPLINE — did the final cost stay near the bid? Only COs the
  // reason code attributes to the contractor (scope_gap) are in
  // finalCostTotal; scope-gap share counts double against them. Owner-
  // driven growth is SHOWN so the number shows its work, never scored.
  {
    const ownerN = e.ownerDrivenCoCount ?? 0;
    const ownerTotal = e.ownerDrivenCoTotal ?? 0;
    const neutralN = e.neutralCoCount ?? 0;
    const scoredN = e.changeOrderCount - ownerN - neutralN;
    if (e.awardsTotal <= 0) {
      dims.push({
        key: "cost", label: "Cost discipline", score: null,
        detail: unlinked ? `Unlinked — awards can't reach this record (${unlinkedNote})` : "No awarded work yet",
      });
    } else {
      const growth = Math.max(0, (e.finalCostTotal - e.awardsTotal) / e.awardsTotal); // 0.2 = 20% over bid
      const gapShare = scoredN > 0 ? e.changeOrderScopeGapCount / scoredN : 0;
      const score = clamp(100 - growth * 250 - gapShare * growth * 250);
      const ownerBit = ownerN > 0
        ? `${ownerN} owner-driven CO${ownerN === 1 ? "" : "s"} (${Math.round((ownerTotal / e.awardsTotal) * 100)}% growth on our side — not scored against them)`
        : null;
      const neutralBit = neutralN > 0 ? `${neutralN} field-condition/other CO${neutralN === 1 ? "" : "s"} not scored` : null;
      dims.push({
        key: "cost", label: "Cost discipline", score: r1(score),
        detail: [
          growth > 0
            ? `${Math.round(growth * 100)}% cost growth over bid, contractor-driven · ${scoredN} change order${scoredN === 1 ? "" : "s"}${e.changeOrderScopeGapCount ? ` (${e.changeOrderScopeGapCount} from their scope gaps)` : ""}`
            : "finished on their bid",
          ownerBit, neutralBit,
          e.awardsSource === "contract_value" ? "awards from the typed contract value" : null,
          e.awardsSource === "mixed"
            // The counts are contractor rows (project_parties) — one company
            // can be two contractors on one project — so they are named as
            // contractor records, never as projects.
            ? `awards from posted commitments on ${e.awardsPostedPartyCount ?? "some"} contractor record${e.awardsPostedPartyCount === 1 ? "" : "s"} and the typed contract value on ${e.awardsTypedPartyCount ?? "others"}`
            : null,
        ].filter(Boolean).join(" · "),
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
        detail: `${e.milestonesHitOnTime}/${e.milestonesOnTheirScopes} tasks on time`,
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
      // Piecewise but CONTINUOUS — a 1-hour difference in average turnaround
      // must never cost a 10-point cliff: 2d→100, 5d→70, 14d→25, then fading.
      const score = clamp(d <= 2 ? 100 : d <= 5 ? 100 - (d - 2) * 10 : d <= 14 ? 70 - (d - 5) * 5 : 25 - (d - 14) * 2);
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

/** Fewer recorded evidence points than this and the band is PROVISIONAL —
 *  one commendation must never render "Excellent" (COST-12). */
export const MIN_EVIDENCE_FOR_BAND = 3;

/** Grade band for the profile card's dial. Pass the scorecard's
 *  evidenceCount so a thin record shows as provisional, not graded. */
export function scoreBand(score: number | null, evidenceCount?: number): { label: string; tone: "green" | "lime" | "amber" | "rose" | "slate" } {
  if (score == null) return { label: "Unrated", tone: "slate" };
  if (evidenceCount != null && evidenceCount < MIN_EVIDENCE_FOR_BAND) return { label: "Provisional", tone: "slate" };
  if (score >= 85) return { label: "Excellent", tone: "green" };
  if (score >= 70) return { label: "Good", tone: "lime" };
  if (score >= 50) return { label: "Watch", tone: "amber" };
  return { label: "Concern", tone: "rose" };
}
