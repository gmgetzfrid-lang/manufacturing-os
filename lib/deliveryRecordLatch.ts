// lib/deliveryRecordLatch.ts
//
// notifications N18 DELIVERY RECORD (drafting-flow EVID-9): before migration
// 20261258 is pasted, two writes are certain to be refused —
//   * queueEmail's not_emailed record (the status CHECK answers 23514), and
//   * the drain's 'sent' update carrying provider_message_id (the column is
//     missing: PGRST204 / 42703), after which today's update is sent again.
// Each latch is a plain flag: once a caller sees its write refused that way,
// it sets the flag, and while the flag holds every later caller in this
// process skips the write that cannot land (and, for the record, the second
// email_gate ask that only serves it). Who is emailed and what is sent never
// depend on a latch: it only removes a request that was going to fail.
//
// No caller ever waits on another (DEC-90: bookkeeping never delays or
// blocks a send). Callers that start together before any refusal has been
// seen each make their write, so a concurrent burst before the paste may pay
// one refused write per concurrent caller, as it did before the latch
// existed. Callers that start after the refusal skip.
//
// A latch is not forever: DELIVERY_RECORD_REPROBE_MS after the refusal the
// flag lapses and the next write is tried again, so a process that was
// running when 20261258 was pasted (a browser tab, a warm server instance)
// starts recording within that window instead of only after it restarts.
// A write that lands clears the flag.
//
// Browser-safe: no imports.

/** How long a refusal holds before the write is tried again (10 minutes). */
export const DELIVERY_RECORD_REPROBE_MS = 10 * 60_000;

export interface Latch {
  /** True while a refusal seen less than DELIVERY_RECORD_REPROBE_MS ago holds. */
  held(): boolean;
  /** The write was refused because 20261258 is not pasted. */
  set(): void;
  /** The write landed (or a test starts over). */
  clear(): void;
}

function makeLatch(): Latch {
  let since: number | null = null;
  return {
    held: () => since !== null && Date.now() - since < DELIVERY_RECORD_REPROBE_MS,
    set: () => { since = Date.now(); },
    clear: () => { since = null; },
  };
}

/** queueEmail's not_emailed record is refused by the old status CHECK. */
export const notEmailedRecordLatch: Latch = makeLatch();
/** The drain's provider_message_id column is missing. */
export const providerIdColumnLatch: Latch = makeLatch();

/** Tests: each case starts in a fresh process's state. */
export function resetDeliveryRecordLatches(): void {
  notEmailedRecordLatch.clear();
  providerIdColumnLatch.clear();
}
