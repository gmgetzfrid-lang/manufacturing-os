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
//   · a notice notify() answers `false` for is tried twice more, after
//     COMPLIANCE_RETRY_BACKOFF_MS, through notifyWithReason (the same insert,
//     answering the refusal's text);
//   · when every attempt fails, a dead letter: ONE audit row
//     (NOTIFICATION_DEAD_LETTER, lib/audit.ts) naming the kind, the recipient,
//     the error and the notice, so an Admin sees it in the audit log; a
//     legible warning line; and an entry the cron reads back after each
//     compliance scan (drainComplianceShortfall) and reports in its result.
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

/** Attempts in all: the first notify() and two retries. */
export const COMPLIANCE_NOTIFY_ATTEMPTS = 3;
/** The wait before each retry (ms). */
export const COMPLIANCE_RETRY_BACKOFF_MS: readonly number[] = [250, 1000];
/** The audit action a dead letter is written under. */
export const NOTIFICATION_DEAD_LETTER = "NOTIFICATION_DEAD_LETTER";

export type ComplianceShortfall = { orgId: string; userId: string; kind: string; error: string };

/** What failed since the last drain — bounded, newest kept (the browser never drains it). */
const SHORTFALL_MAX = 200;
let shortfall: ComplianceShortfall[] = [];
let sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Tests only: replace the backoff's wait. */
export function __setComplianceRetrySleep(fn: ((ms: number) => Promise<void>) | null): void {
  sleep = fn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

/** The compliance notices that were not written since the last call, oldest
 *  first — and forget them. The cron reads it after each compliance scan. */
export function drainComplianceShortfall(): ComplianceShortfall[] {
  const out = shortfall;
  shortfall = [];
  return out;
}

/**
 * notify() for a compliance notice: the same row, retried when it does not
 * land, dead-lettered when it never does. Answers whether the row was written.
 * Never throws for a refusal; a notify() that throws (it never does in
 * production) throws here as it did before.
 */
export async function notifyCompliance(input: NotificationInput): Promise<boolean> {
  // The first attempt IS notify(): an answer other than `false` is a write.
  if ((await notify(input)) !== false) return true;
  let error = "the insert was refused or failed";
  for (let attempt = 2; attempt <= COMPLIANCE_NOTIFY_ATTEMPTS; attempt++) {
    await sleep(COMPLIANCE_RETRY_BACKOFF_MS[attempt - 2] ?? 1000);
    const r = await notifyWithReason(input);
    if (r.ok) return true;
    if (r.error) error = r.error;
  }
  console.warn(`[compliance-notify] ${input.kind} to ${input.userId} in ${input.orgId} was not written after ${COMPLIANCE_NOTIFY_ATTEMPTS} attempts — dead-lettered to the audit log: ${error}`);
  shortfall.push({ orgId: input.orgId, userId: input.userId, kind: input.kind, error });
  if (shortfall.length > SHORTFALL_MAX) shortfall = shortfall.slice(-SHORTFALL_MAX);
  const dead = await logAuditAction({
    action: NOTIFICATION_DEAD_LETTER,
    resourceType: input.resourceType ?? "notification",
    resourceId: input.resourceId ?? input.userId,
    orgId: input.orgId,
    // the writer: the signed-in member a browser producer names (DEC-86 §2),
    // else the system (the cron) — never the recipient
    userId: input.actorUserId ?? "system",
    details: {
      kind: input.kind,
      recipient: input.userId,
      error,
      attempts: COMPLIANCE_NOTIFY_ATTEMPTS,
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
