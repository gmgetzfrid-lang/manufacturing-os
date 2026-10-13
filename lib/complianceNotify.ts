// lib/complianceNotify.ts
//
// A compliance notice's bell row, retried (notifications Round G, N14 —
// DELIV-16, DELIV-7 done-when 1).
//
// notify() inserts once and answers false on a refusal or a failure (logged,
// never thrown — a failed signal never rolls back the action it reports). For
// an ordinary notice that is enough. A compliance notice (an acknowledgment
// request, a review, an effective date, a retention flag, a recertification)
// is the only way its recipient learns of an obligation, and a one-shot one
// (ack_requested at publish, legal_hold_placed, effective_now) has no second
// chance: nothing writes it again. So here:
//
//   · the notice is written by notify() — the same typed insert, the same
//     row, on the same shared client (the browser's session, or the service
//     role the cron binds) — and nothing changes when it lands;
//   · a notice notify() answers `false` for is tried again AT ONCE through
//     notifyWithReason (the same insert, answering the refusal's text — what
//     notify() does not say). A refusal that cannot change on a retry (a
//     policy, a rail, a constraint, a rate limit: DETERMINISTIC_REFUSAL) is
//     dead-lettered then, with no wait; any other failure gets one more
//     attempt after COMPLIANCE_RETRY_BACKOFF_MS[1];
//   · the retry is BOUNDED (the fix pass on N14 — the cron's step-6 scans
//     walk documents one at a time, and an unbounded wait per failing notice
//     could push the run past its maxDuration): after BREAKER_DEAD_LETTERS
//     consecutive dead letters within BREAKER_WINDOW_MS no retry is made —
//     each notice gets its single notify() — until a write lands; and inside
//     a cron scan (lib/complianceNotifyScope.ts) no retry is made past the
//     deadline the cron sets, so the steps after it keep their time;
//   · when every attempt fails, a dead letter: ONE audit row
//     (NOTIFICATION_DEAD_LETTER, lib/audit.ts) naming the kind, the recipient,
//     the error and the notice, so an Admin sees it in the audit log — written
//     as the signed-in member when a browser producer names no actor (the
//     audit insert policy refuses a NULL-uid row from a session), as the
//     system under the service role; a legible warning line; and, inside a
//     cron scan, an entry that scan's line in the run's errors reports.
//
// No new table: the obligation itself (the acknowledgment roster, the review
// roster, the retention flag) is already a durable row the scans re-read, and
// what is lost when every attempt fails is the signal, which the dead letter
// records where an Admin looks. A notice the insert rail refuses for a
// recipient who is not an active member is SKIPPED by the database (not an
// error) and is never retried or dead-lettered — nobody is notified who
// cannot read it (DEC-86 §2).

import { notify, notifyWithReason, type NotificationInput } from "@/lib/inAppNotifications";
import { logAuditAction } from "@/lib/audit";
import { supabase } from "@/lib/supabase";

/** Attempts in all, at most: the first notify() and two retries. */
export const COMPLIANCE_NOTIFY_ATTEMPTS = 3;
/** The wait before each retry (ms): the first is made at once (it reads the
 *  refusal's text), the second after a second. */
export const COMPLIANCE_RETRY_BACKOFF_MS: readonly number[] = [0, 1000];
/** The audit action a dead letter is written under. */
export const NOTIFICATION_DEAD_LETTER = "NOTIFICATION_DEAD_LETTER";
/** A refusal that a retry within the backoff cannot change: an RLS / grant
 *  refusal, the 20261160 rail's refusals (a non-member, an actor mismatch, an
 *  unknown or server-only kind, a link, a watermark) and its per-minute rate
 *  limits, a constraint or a malformed value. Dead-lettered without a wait. */
export const DETERMINISTIC_REFUSAL = /permission denied|row-level security|violates (check|not-null|foreign key|unique) constraint|invalid input syntax|not a member of this workspace|actor must be the signed-in member|unknown kind|is written only by the server|must be an app-relative path|dedupe watermark|rate limit/i;
/** The breaker: this many consecutive dead letters, each within
 *  BREAKER_WINDOW_MS of the last, and no retry is made until a write lands. */
export const BREAKER_DEAD_LETTERS = 5;
export const BREAKER_WINDOW_MS = 60_000;

export type ComplianceShortfall = { orgId: string; userId: string; kind: string; error: string };

/** One cron scan's collector (lib/complianceNotifyScope.ts binds it to the
 *  scan's async context): what that scan's notices lost, and the time past
 *  which no retry is made. */
export type ComplianceScope = { lost: ComplianceShortfall[]; lostCount: number; deadlineMs: number | null };
/** Entries a scope keeps (the count is exact). */
export const SCOPE_LOST_MAX = 50;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let sleep = realSleep;
let now = () => Date.now();
/** Process-wide (the browser tab, or the server instance): the consecutive
 *  dead letters, and when the last was written. */
let streak = 0;
let lastDeadAt = 0;
let readScope: (() => ComplianceScope | undefined) | null = null;

/** Tests only: replace the backoff's wait. */
export function __setComplianceRetrySleep(fn: ((ms: number) => Promise<void>) | null): void {
  sleep = fn ?? realSleep;
}
/** Tests only: replace the clock the breaker and the deadline read. */
export function __setComplianceRetryClock(fn: (() => number) | null): void {
  now = fn ?? (() => Date.now());
}
/** Tests only: close the breaker. */
export function __resetComplianceBreaker(): void {
  streak = 0;
  lastDeadAt = 0;
}
/** SERVER-ONLY: lib/complianceNotifyScope.ts registers the reader of its
 *  AsyncLocalStorage here (node:async_hooks is not in the browser bundle). */
export function __registerComplianceScope(read: () => ComplianceScope | undefined): void {
  readScope = read;
}

function breakerOpen(t: number): boolean {
  return streak >= BREAKER_DEAD_LETTERS && t - lastDeadAt <= BREAKER_WINDOW_MS;
}

/** The writer of a dead letter for a notice that names no actor: the
 *  signed-in member (a browser producer), else the system (the service role
 *  has no session). Never throws. */
async function deadLetterWriter(input: NotificationInput): Promise<string> {
  if (input.actorUserId) return input.actorUserId;
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.user?.id ?? "system";
  } catch {
    return "system";
  }
}

/**
 * notify() for a compliance notice: the same row, retried (boundedly) when it
 * does not land, dead-lettered when it never does. Answers whether the row
 * was written. Never throws for a refusal; a notify() that throws (it never
 * does in production) throws here as it did before.
 */
export async function notifyCompliance(input: NotificationInput): Promise<boolean> {
  // The first attempt IS notify(): an answer other than `false` is a write.
  if ((await notify(input)) !== false) { streak = 0; return true; }
  const scope = readScope?.();
  let error = "the insert was refused or failed";
  let attempts = 1;
  const t0 = now();
  if (breakerOpen(t0)) {
    error += ` (not retried: the last ${streak} compliance notices were dead-lettered within ${BREAKER_WINDOW_MS / 1000} s of each other — retries resume when a write lands)`;
  } else if (scope?.deadlineMs != null && t0 >= scope.deadlineMs) {
    error += " (not retried: past the run's retry deadline — the steps after the compliance scans keep their time)";
  } else {
    for (let attempt = 2; attempt <= COMPLIANCE_NOTIFY_ATTEMPTS; attempt++) {
      const wait = COMPLIANCE_RETRY_BACKOFF_MS[attempt - 2] ?? 1000;
      if (wait > 0) {
        if (scope?.deadlineMs != null && now() + wait > scope.deadlineMs) {
          error += " (not retried further: the run's retry deadline — the steps after the compliance scans keep their time)";
          break;
        }
        await sleep(wait);
      }
      attempts = attempt;
      const r = await notifyWithReason(input);
      if (r.ok) { streak = 0; return true; }
      if (r.error) error = r.error;
      if (DETERMINISTIC_REFUSAL.test(error)) break;
    }
  }
  const t1 = now();
  if (t1 - lastDeadAt > BREAKER_WINDOW_MS) streak = 0;
  streak += 1;
  lastDeadAt = t1;
  const tried = `${attempts} attempt${attempts === 1 ? "" : "s"}`;
  console.warn(`[compliance-notify] ${input.kind} to ${input.userId} in ${input.orgId} was not written after ${tried} — dead-lettered to the audit log: ${error}`);
  if (scope) {
    scope.lostCount += 1;
    if (scope.lost.length < SCOPE_LOST_MAX) scope.lost.push({ orgId: input.orgId, userId: input.userId, kind: input.kind, error });
  }
  const dead = await logAuditAction({
    action: NOTIFICATION_DEAD_LETTER,
    resourceType: input.resourceType ?? "notification",
    resourceId: input.resourceId ?? input.userId,
    orgId: input.orgId,
    // the writer: the actor a producer names (DEC-86 §2), else the signed-in
    // member, else the system (the cron) — never the recipient
    userId: await deadLetterWriter(input),
    details: {
      kind: input.kind,
      recipient: input.userId,
      error,
      attempts,
      title: input.title,
      link: input.link ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
    },
  });
  if (dead && dead.ok === false) {
    console.error(`[compliance-notify] the dead letter for ${input.kind} to ${input.userId} was not written either: ${dead.error}`);
  }
  return false;
}
