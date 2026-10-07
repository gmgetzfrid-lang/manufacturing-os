// A stand-in for lib/ai/usageServer's reservation calls (GOV-13 / GOV-5),
// for tests that mock the module rather than run it over a ledger
// (intelligence Round G, I-18). It keeps the month's rows in memory and
// decides each reservation as reserveWithinCap does: refused (402) when the
// cap is locked, when settled spend plus the reservations already made
// reaches the cap, or when this call's worst case does not fit what is left;
// a refused reservation leaves no row. settleUsage prices the call's real
// figures with the app's own price table; holdUsage prices a run's calls so
// far and keeps the row a reservation; releaseUsage drops the row.
//
// `cap` 0 is the stand-in these suites have always used for "no cap" (the
// real getCapUsd never answers 0 — a $0 cap is LOCKED_CAP_USD): nothing is
// refused then, so a suite that is not about the cap runs exactly as before.
// The real reservation logic is tested in aiUsage.test.ts and
// orchestratorReserve.test.ts.
//
// Use from a vi.mock factory:
//   vi.mock("@/lib/ai/usageServer", async () => (await import("./helpers/fakeUsageMeter")).fakeUsageServer());
// and import `meter` in the test to set `spent` / `cap` and read `rows`.

import { vi } from "vitest";
import { estimateCostUsd, type AiUsage } from "@/lib/ai/pricing";
import { GovernedCallError } from "@/lib/ai/gateError";

export type MeterRow = {
  id: string; orgId: string; userId: string; op: string; provider: string; model: string;
  /** The reservation's worst case until settled; then the call's real cost. */
  costUsd: number;
  /** true while it is a reservation (no figures yet). */
  reserved: boolean;
  inputTokens: number | null; outputTokens: number | null; ok: boolean;
};

export const meter = {
  /** What getMonthUsage answers before any row here (spend settled elsewhere). */
  spent: 0,
  /** What getCapUsd answers; 0 = no cap in these suites (see above). */
  cap: 0,
  rows: [] as MeterRow[],
  seq: 0,
  /** Set: the next reservation fails as an unreadable ledger (503). */
  ledgerDown: false,
  /** Every reservation asked for, refused ones included. */
  asked: [] as Array<{ op: string; worstCaseUsd: number; capUsd: number; refused: string | null }>,
  /** Calls to recordAskUsage (the unreserved path). */
  recorded: [] as Array<Record<string, unknown>>,
};

export function resetMeter(over: Partial<Pick<typeof meter, "spent" | "cap">> = {}): void {
  meter.spent = over.spent ?? 0;
  meter.cap = over.cap ?? 0;
  meter.rows = [];
  meter.seq = 0;
  meter.ledgerDown = false;
  meter.asked = [];
  meter.recorded = [];
}

const LOCKED = Number.MIN_VALUE;
const money = (n: number) => `$${n.toFixed(2)}`;
/** Settled spend plus every reservation for this member (what is used). */
const usedBy = (userId: string) => meter.spent + meter.rows.filter((r) => r.userId === userId).reduce((n, r) => n + r.costUsd, 0);

/** The module's calls, as vi.fn()s (a suite may still override one). */
export function fakeUsageServer() {
  return {
    DEFAULT_MONTHLY_CAP_USD: 10,
    LOCKED_CAP_USD: LOCKED,
    capIsLocked: (capUsd: number) => capUsd <= LOCKED,
    capReached: (spentUsd: number, capUsd: number) => capUsd <= LOCKED || spentUsd >= capUsd,
    displayCapUsd: (capUsd: number) => (capUsd <= LOCKED ? 0 : capUsd),
    getMonthUsage: vi.fn(async (_orgId: string, userId: string) => ({ spentUsd: usedBy(userId) })),
    getCapUsd: vi.fn(async (_orgId?: string, _userId?: string) => meter.cap),
    recordAskUsage: vi.fn(async (r: Record<string, unknown>) => { meter.recorded.push(r); }),
    reserveWithinCap: vi.fn(async (input: {
      orgId: string; userId: string; op: string; provider: string; model: string; worstCaseUsd: number; capUsd: number;
    }) => {
      const worst = Math.max(0, Math.round(input.worstCaseUsd * 1_000_000) / 1_000_000);
      const ask = { op: input.op, worstCaseUsd: worst, capUsd: input.capUsd, refused: null as string | null };
      meter.asked.push(ask);
      if (meter.ledgerDown) {
        meter.ledgerDown = false;
        ask.refused = "ledger";
        throw new GovernedCallError("AI usage can't be read right now, so AI calls are refused until it can (couldn't read the usage ledger: statement timeout).", 503, { usageUnavailable: true });
      }
      if (input.capUsd > 0) {
        if (input.capUsd <= LOCKED) {
          ask.refused = "locked";
          throw new GovernedCallError("Your monthly AI cap is set to $0, so AI is locked for you until someone who manages AI caps raises it.", 402, { locked: true });
        }
        const before = usedBy(input.userId);
        const details = { spentUsd: before, capUsd: input.capUsd, reservedUsd: worst, locked: false };
        if (before >= input.capUsd) {
          ask.refused = "reached";
          throw new GovernedCallError(`Monthly AI budget reached (${money(before)} of ${money(input.capUsd)}).`, 402, details);
        }
        if (before + worst > input.capUsd) {
          ask.refused = "does not fit";
          throw new GovernedCallError(
            `This call could cost up to ${money(worst)} and ${money(Math.max(0, input.capUsd - before))} is left of your ${money(input.capUsd)} monthly AI cap, so it was not made.`,
            402, details,
          );
        }
      }
      const row: MeterRow = {
        id: `ev-${++meter.seq}`, orgId: input.orgId, userId: input.userId, op: input.op, provider: input.provider, model: input.model,
        costUsd: worst, reserved: true, inputTokens: null, outputTokens: null, ok: true,
      };
      meter.rows.push(row);
      return { id: row.id, reservedUsd: worst };
    }),
    settleUsage: vi.fn(async (id: string, input: { model: string; usage: AiUsage; ok: boolean }) => {
      const row = meter.rows.find((r) => r.id === id);
      if (!row) return;
      Object.assign(row, {
        model: input.model, reserved: false, ok: input.ok,
        inputTokens: input.usage.inputTokens, outputTokens: input.usage.outputTokens,
        costUsd: estimateCostUsd(input.model, input.usage),
      });
    }),
    // A run's cost so far on its row, which stays a reservation (in flight).
    holdUsage: vi.fn(async (id: string, input: { model: string; usage: AiUsage }) => {
      const row = meter.rows.find((r) => r.id === id);
      if (row) Object.assign(row, { model: input.model, costUsd: estimateCostUsd(input.model, input.usage) });
    }),
    releaseUsage: vi.fn(async (id: string) => { meter.rows = meter.rows.filter((r) => r.id !== id); }),
    ORCHESTRATOR_ROUND_OP: "orchestratorRound",
  };
}
