// lib/ai/gateError.ts — the refusal every AI gate throws.
//
// One class, so a route that maps `e instanceof GovernedCallError` onto its
// response answers with the gate's own status whichever gate refused: no key
// (412), unsigned agreement (428), cap reached / locked (402), too many runs
// at once (429), the spend ledger unreadable (503). lib/ai/governedCall.ts
// re-exports it under the same name its callers already import.

export class GovernedCallError extends Error {
  constructor(
    message: string,
    public status: number,
    /** Machine-readable extras a route may pass through (the agreement text
     *  for a 428, the figures behind a 402). Never a key. */
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** GOV-4: is this the refusal a ledger or cap read throws when the spend
 *  cannot be read (AiUsageUnavailableError in lib/ai/usageServer: 503,
 *  `details.usageUnavailable`)? A caller whose AI step is optional — page
 *  vision during indexing — skips that step on it instead of failing the
 *  work around it. Judged by the class and the flag, so a caller whose tests
 *  stub the ledger module still recognises it. */
export function isAiUsageUnavailable(e: unknown): boolean {
  return e instanceof GovernedCallError && e.details?.usageUnavailable === true;
}
