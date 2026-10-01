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
