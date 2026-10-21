// lib/deliveryRecordLatch.ts
//
// notifications N18 DELIVERY RECORD (drafting-flow EVID-9): before migration
// 20261258 is pasted, two writes are certain to be refused —
//   * queueEmail's not_emailed record (the status CHECK answers 23514), and
//   * the drain's 'sent' update carrying provider_message_id (the column is
//     missing: PGRST204 / 42703), after which today's update is sent again.
// Each latch remembers, in this process, that its write was refused that way,
// so the callers skip the write that cannot land (and, for the record, the
// second email_gate ask that only serves it) instead of paying for it on
// every recipient and every send. Who is emailed and what is sent never
// depend on a latch: it only removes a request that was going to fail.
//
// One refusal per process, not one per concurrent caller: until a write of
// the kind has landed once, a write that finds another of its kind in flight
// waits for that one's answer first (emit() queues every recipient at once;
// the drain sends five at a time). Once one has landed, nobody waits.
//
// A latch is not forever: after DELIVERY_RECORD_REPROBE_MS the next write is
// tried again, so a process that was running when 20261258 was pasted (a
// browser tab, a warm server instance) starts recording within that window
// instead of only after it restarts.
//
// Browser-safe: no imports.

/** How long a refusal holds before the write is tried again (10 minutes). */
export const DELIVERY_RECORD_REPROBE_MS = 10 * 60_000;

/** What a write's answer says about the paste: it landed ("ok"), it was
 *  refused because the paste is missing ("refused"), or neither ("other" —
 *  another error, or the write was not made). */
export type LatchAnswer = "ok" | "refused" | "other";

export interface Latch {
  /** True while a refusal seen less than DELIVERY_RECORD_REPROBE_MS ago holds. */
  held(): boolean;
  /** Run `write` unless a refusal holds (then `skipped()` is answered and
   *  `write` is never called). `classify` reads its answer. Until a write has
   *  landed once, writes run one at a time. */
  write<T>(write: () => Promise<T>, classify: (answer: T) => LatchAnswer, skipped: () => T): Promise<T>;
  /** Tests: a fresh process's state. */
  reset(): void;
}

function makeLatch(): Latch {
  let since: number | null = null;
  let landed = false;
  let inflight: Promise<void> | null = null;
  const held = () => since !== null && Date.now() - since < DELIVERY_RECORD_REPROBE_MS;
  const apply = (a: LatchAnswer) => {
    if (a === "refused") since = Date.now();
    else if (a === "ok") { since = null; landed = true; }
  };
  return {
    held,
    async write<T>(write: () => Promise<T>, classify: (answer: T) => LatchAnswer, skipped: () => T): Promise<T> {
      for (;;) {
        if (held()) return skipped();
        if (landed || !inflight) break;
        await inflight;
      }
      if (landed) {
        const r = await write();
        apply(classify(r));
        return r;
      }
      let release: () => void = () => undefined;
      inflight = new Promise<void>((resolve) => { release = resolve; });
      try {
        const r = await write();
        apply(classify(r));
        return r;
      } finally {
        inflight = null;
        release();
      }
    },
    reset: () => { since = null; landed = false; inflight = null; },
  };
}

/** queueEmail's not_emailed record is refused by the old status CHECK. */
export const notEmailedRecordLatch: Latch = makeLatch();
/** The drain's provider_message_id column is missing. */
export const providerIdColumnLatch: Latch = makeLatch();

/** Tests: each case starts in a fresh process's state. */
export function resetDeliveryRecordLatches(): void {
  notEmailedRecordLatch.reset();
  providerIdColumnLatch.reset();
}
