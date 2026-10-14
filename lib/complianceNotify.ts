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
//   · a retry NEVER writes a second copy (integrator fix pass, re-review
//     minor 3): notify() answers `false` both for an insert that did not
//     commit and for one that committed and whose answer was lost (a reset,
//     "fetch failed"). So before every retry — and once more before a dead
//     letter — the writer READS BACK the row (same org, recipient, kind,
//     title and resource, created since READBACK_SKEW_MS before the first
//     attempt, written by the same actor — none for the cron's notices); a
//     row found is the notice, landed. A retry is made only where
//     that read-back is authoritative: inside a cron scan (the service role
//     the cron binds — lib/complianceNotifyScope.ts) or for the signed-in
//     member's OWN row. A browser writing another member's row cannot read it
//     (notifications_own_select, 20261161); since notifications N15 it asks
//     notification_i_wrote (20261206, SECURITY DEFINER: did a row THIS member
//     wrote, to that recipient, of that kind, title and resource, land since
//     then?) and is retried on that answer. Before 20261206 is pasted (the
//     function is missing — PGRST202 / 42883) or when that read fails, the
//     notice is NOT retried: it is dead-lettered at once, its error saying
//     why (today's path). A server writer with no scan scope and no session
//     (a route on the service role — the intake door) reads the table back
//     directly, as the cron does;
//   · a notice notify() answers `false` for, where it may be retried, is
//     tried again AT ONCE through notifyWithReason (the same insert,
//     answering the refusal's text — what notify() does not say). A refusal
//     that cannot change on a retry (a policy, a rail, a constraint, a rate
//     limit: DETERMINISTIC_REFUSAL) is dead-lettered then, with no wait; any
//     other failure gets one more attempt after COMPLIANCE_RETRY_BACKOFF_MS[1];
//   · the retry is BOUNDED (the fix pass on N14 — the cron's step-6 scans
//     walk documents one at a time, and an unbounded wait per failing notice
//     could push the run past its maxDuration): after BREAKER_DEAD_LETTERS
//     consecutive dead letters IN ONE WORKSPACE within BREAKER_WINDOW_MS no
//     retry is made for that workspace — each notice gets its single
//     notify() — until a write lands there (the breaker is keyed by org —
//     re-review minor 4: one org's systematic refusals never switch off
//     another org's retries on the same server instance); and inside a cron
//     scan no retry is made past the deadline the cron sets, so the steps
//     after it keep their time;
//   · when every attempt fails, a dead letter: ONE audit row
//     (NOTIFICATION_DEAD_LETTER, lib/audit.ts) naming the kind, the recipient,
//     the error and the notice, so an Admin sees it in the audit log — written
//     as the signed-in member when a browser producer names no actor (the
//     audit insert policy refuses a NULL-uid row from a session), as the
//     system under the service role; a legible warning line; and, inside a
//     cron scan, an entry that scan's line in the run's errors reports. A
//     scan's notice carries a retry key (its row): the dead letter records it,
//     and the scan's next run reads them back (loadScanRetryPlan) to send the
//     lost notice again — to its recipient only (DELIV-7 dw1, re-review
//     minor 5: the scan stamps its cooldown only when every notice landed).
//
// No new table: the obligation itself (the acknowledgment roster, the review
// roster, the retention flag) is already a durable row the scans re-read, and
// what is lost when every attempt fails is the signal, which the dead letter
// records where an Admin looks. A notice the insert rail refuses for a
// recipient who is not an active member is SKIPPED by the database (not an
// error) and is never retried or dead-lettered — nobody is notified who
// cannot read it (DEC-86 §2).

import { notify, notifyWithReason, type NotificationInput, type NotifyClient } from "@/lib/inAppNotifications";
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
/** The breaker: this many consecutive dead letters in one workspace, each
 *  within BREAKER_WINDOW_MS of the last, and no retry is made for that
 *  workspace until a write lands there. */
export const BREAKER_DEAD_LETTERS = 5;
export const BREAKER_WINDOW_MS = 60_000;
/** The read-back's window reaches this far before the first attempt (the
 *  app's clock and the database's may differ; a row is dated by the
 *  database). An identical row (same org, recipient, kind, title, resource)
 *  inside it is taken for this notice. */
export const READBACK_SKEW_MS = 60_000;
/** A scan's dead letters from one run lie within this span of the latest
 *  (a cron run lasts at most 300 s); older ones are an earlier run's. */
export const RETRY_RUN_SPAN_MS = 15 * 60_000;
/** Dead letters one retry-plan read takes, newest first. */
export const RETRY_PLAN_ROWS = 5000;

export type ComplianceShortfall = { orgId: string; userId: string; kind: string; error: string; retried: boolean };

/** What one cron run's compliance notices came to (DELIV-7 — counted per
 *  bell notice, never per document). */
export type ComplianceNoticeTally = { attempted: number; delivered: number; deadLettered: number };

/** One cron scan's collector (lib/complianceNotifyScope.ts binds it to the
 *  scan's async context): what that scan's notices lost, the time past which
 *  no retry is made, and the scan's tally. A scope exists only inside the
 *  cron's step 6, which binds the SERVICE ROLE to the shared client first
 *  (__setServerSupabaseClient) — so inside a scope the read-back sees every
 *  row and is authoritative. */
export type ComplianceScope = {
  lost: ComplianceShortfall[];
  lostCount: number;
  /** of lostCount, the notices whose row the next run sends again */
  lostRetried: number;
  deadlineMs: number | null;
  attempted: number;
  delivered: number;
  /** a line the scan's caller should see (a retry plan that could not be read) */
  notes: string[];
};
/** Entries a scope keeps (the count is exact). */
export const SCOPE_LOST_MAX = 50;

/** notifyCompliance's options. `retryKey` (a scan's notice): `<scan>:<row id>`,
 *  recorded in the dead letter so the scan's next run sends the lost notice
 *  again (loadScanRetryPlan). */
export type ComplianceNotifyOptions = { retryKey?: string };

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let sleep = realSleep;
let now = () => Date.now();
/** Per workspace (keyed by org id), for the tab or the server instance: the
 *  consecutive dead letters, and when the last was written. An entry is
 *  dropped when a write lands, so the map holds only failing workspaces. */
const breakers = new Map<string, { streak: number; lastDeadAt: number }>();
let readScope: (() => ComplianceScope | undefined) | null = null;

/** Tests only: replace the backoff's wait. */
export function __setComplianceRetrySleep(fn: ((ms: number) => Promise<void>) | null): void {
  sleep = fn ?? realSleep;
}
/** Tests only: replace the clock the breaker, the deadline and the read-back read. */
export function __setComplianceRetryClock(fn: (() => number) | null): void {
  now = fn ?? (() => Date.now());
}
/** Tests only: close every breaker. */
export function __resetComplianceBreaker(): void {
  breakers.clear();
}
/** SERVER-ONLY: lib/complianceNotifyScope.ts registers the reader of its
 *  AsyncLocalStorage here (node:async_hooks is not in the browser bundle). */
export function __registerComplianceScope(read: () => ComplianceScope | undefined): void {
  readScope = read;
}

function breakerOpen(orgId: string, t: number): { open: boolean; streak: number } {
  const b = breakers.get(orgId);
  if (!b) return { open: false, streak: 0 };
  return { open: b.streak >= BREAKER_DEAD_LETTERS && t - b.lastDeadAt <= BREAKER_WINDOW_MS, streak: b.streak };
}

/** The shared client, typed loosely for the two reads this file makes. */
const db = (): NotifyClient => supabase as unknown as NotifyClient;

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

/** How a read-back may settle this notice — or undefined when none is
 *  authoritative. Inside a cron scan, or on a server route with no session
 *  (the service role, which sees every row), the table is read for the actor
 *  the notice names, or none; in a browser the signed-in member's OWN row is
 *  read from the table (notifications_own_select), and the insert rail
 *  (20261160) stamps the signed-in writer as its actor; a browser writing
 *  SOMEONE ELSE's row asks notification_i_wrote (N15, 20261206), which
 *  answers only for rows whose actor is the caller. A browser with no
 *  session: undefined. Matching the actor means a row a member forged from a
 *  browser (always stamped with its writer) is never taken for a server
 *  notice (lib/__tests__/notificationWriteRails.test.ts). */
type ReadBack =
  /** read the table directly, matching this actor (null: no actor) */
  | { via: "table"; actor: string | null }
  /** a browser writing ANOTHER member's row: ask notification_i_wrote
   *  (20261206, SECURITY DEFINER) whether a row THIS member wrote landed */
  | { via: "rpc" };

async function readBackActor(input: NotificationInput, scope: ComplianceScope | undefined): Promise<ReadBack | undefined> {
  if (scope) return { via: "table", actor: input.actorUserId ?? null };
  try {
    const { data } = await supabase.auth.getSession();
    const uid = data?.session?.user?.id;
    if (uid) return uid === input.userId ? { via: "table", actor: uid } : { via: "rpc" };
    // DELIV-16 (notifications N15): a SERVER writer with no session and no
    // scan scope — a route that bound the shared client to the service role
    // (the intake door's notices, through emit()). The service role reads
    // every row, so its read-back is authoritative. (An unbound server
    // client is the anon key: its insert is refused by RLS, nothing can have
    // landed, and the refusal is deterministic — dead-lettered at once.)
    if (typeof window === "undefined") return { via: "table", actor: input.actorUserId ?? null };
    return undefined;
  } catch {
    return undefined;
  }
}

/** Has this notice's row landed since `sinceIso`? true / false, or null when
 *  the read failed (a landed row cannot be ruled out). */
async function landedSince(input: NotificationInput, sinceIso: string, rb: ReadBack): Promise<boolean | null> {
  if (rb.via === "rpc") {
    try {
      const { data, error } = await (supabase as unknown as {
        rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string | null; message?: string | null } | null }>;
      }).rpc("notification_i_wrote", {
        p_org: input.orgId, p_user: input.userId, p_kind: input.kind, p_title: input.title,
        p_resource_id: input.resourceId ?? null, p_since: sinceIso,
      });
      if (error) return null;
      return data === true;
    } catch {
      return null;
    }
  }
  const actor = rb.actor;
  try {
    let q = db().from("notifications").select("id")
      .eq("org_id", input.orgId).eq("user_id", input.userId).eq("kind", input.kind).eq("title", input.title);
    q = actor ? q.eq("actor_user_id", actor) : q.is("actor_user_id", null);
    q = input.resourceId ? q.eq("resource_id", input.resourceId) : q.is("resource_id", null);
    const { data, error } = await q.gte("created_at", sinceIso).limit(1);
    if (error) return null;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return null;
  }
}

function landed(input: NotificationInput, scope: ComplianceScope | undefined): true {
  breakers.delete(input.orgId);
  if (scope) scope.delivered += 1;
  return true;
}

/**
 * notify() for a compliance notice: the same row, retried (boundedly, and
 * only where a read-back can rule out a row that already landed) when it does
 * not land, dead-lettered when it never does. Answers whether the row was
 * written. Never throws for a refusal; a notify() that throws (it never does
 * in production) throws here as it did before.
 */
export async function notifyCompliance(input: NotificationInput, opts?: ComplianceNotifyOptions): Promise<boolean> {
  const scope = readScope?.();
  if (scope) scope.attempted += 1;
  // the read-back's window opens before the first attempt
  const sinceIso = new Date(now() - READBACK_SKEW_MS).toISOString();
  // The first attempt IS notify(): an answer other than `false` is a write.
  if ((await notify(input)) !== false) return landed(input, scope);
  const rb = await readBackActor(input, scope);
  let readable = rb !== undefined;
  let error = "the insert was refused or failed";
  let attempts = 1;
  // the last failure may have committed (its answer lost): a read-back settles it
  let unsettled = true;
  const t0 = now();
  const breaker = breakerOpen(input.orgId, t0);
  if (!readable) {
    error += " (not retried: this writer cannot read its rows back — a browser with no session — so a retry after a lost answer could write a second copy)";
  } else if (breaker.open) {
    error += ` (not retried: the last ${breaker.streak} compliance notices in this workspace were dead-lettered within ${BREAKER_WINDOW_MS / 1000} s of each other — retries resume when a write lands)`;
  } else if (scope?.deadlineMs != null && t0 >= scope.deadlineMs) {
    error += " (not retried: past the run's retry deadline — the steps after the compliance scans keep their time)";
  } else {
    for (let attempt = 2; attempt <= COMPLIANCE_NOTIFY_ATTEMPTS; attempt++) {
      const wait = COMPLIANCE_RETRY_BACKOFF_MS[attempt - 2] ?? 1000;
      if (wait > 0 && scope?.deadlineMs != null && now() + wait > scope.deadlineMs) {
        error += " (not retried further: the run's retry deadline — the steps after the compliance scans keep their time)";
        break;
      }
      const seen = await landedSince(input, sinceIso, rb!);
      if (seen === true) return landed(input, scope);
      if (seen === null) {
        error += rb!.via === "rpc"
          ? " (not retried: this writer's read-back of its own rows (notification_i_wrote, 20261206) failed or is not deployed — a retry could write a second copy)"
          : " (not retried: the read-back that would rule out a landed row failed — a retry could write a second copy)";
        readable = false;
        break;
      }
      if (wait > 0) await sleep(wait);
      attempts = attempt;
      const r = await notifyWithReason(input);
      if (r.ok) return landed(input, scope);
      if (r.error) error = r.error;
      if (DETERMINISTIC_REFUSAL.test(error)) { unsettled = false; break; }
    }
  }
  // Before the dead letter: did the last attempt land after all?
  if (readable && unsettled && (await landedSince(input, sinceIso, rb!)) === true) return landed(input, scope);

  const t1 = now();
  const prev = breakers.get(input.orgId);
  const streak = prev && t1 - prev.lastDeadAt <= BREAKER_WINDOW_MS ? prev.streak + 1 : 1;
  breakers.set(input.orgId, { streak, lastDeadAt: t1 });
  const tried = `${attempts} attempt${attempts === 1 ? "" : "s"}`;
  console.warn(`[compliance-notify] ${input.kind} to ${input.userId} in ${input.orgId} was not written after ${tried} — dead-lettered to the audit log: ${error}`);
  if (scope) {
    scope.lostCount += 1;
    if (opts?.retryKey) scope.lostRetried += 1;
    if (scope.lost.length < SCOPE_LOST_MAX) scope.lost.push({ orgId: input.orgId, userId: input.userId, kind: input.kind, error, retried: !!opts?.retryKey });
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
      ...(opts?.retryKey ? { retryKey: opts.retryKey } : {}),
    },
  });
  if (dead && dead.ok === false) {
    console.error(`[compliance-notify] the dead letter for ${input.kind} to ${input.userId} was not written either: ${dead.error}`);
  }
  return false;
}

/** SERVER (a step-6 scan): a line for the scan's caller to see — the run's
 *  errors, under the scan's label. Outside a scan it is a warning line only. */
export function noteComplianceScan(note: string): void {
  const scope = readScope?.();
  if (scope) scope.notes.push(note);
  else console.warn(`[compliance-notify] ${note}`);
}

/** A scan's plan for this run: which of a row's notices to send. */
export type ScanRetryPlan = {
  /** For the row `key` (`<scan>:<row id>`) whose cooldown was last stamped at
   *  `stampedAt`: a predicate over (kind, recipient). A row with no dead
   *  letter since its stamp sends every notice (the scan as it always was);
   *  a row whose last run dead-lettered sends only the notices that run lost. */
  only(key: string, stampedAt: string | null | undefined): (kind: string, uid: string) => boolean;
  /** Did the row's latest run lose any notice (a dead letter carrying its
   *  key, after `stampedAt`)? For a scan whose watermark is the bell rows
   *  themselves (scanStaleHolds — N15): it re-sends only when this is true,
   *  and only to the lost recipients that still have no row. */
  has(key: string, stampedAt: string | null | undefined): boolean;
  /** the dead letters could not be read: every row sends every notice */
  unreadable: boolean;
};

/**
 * SERVER (the cron's step-6 scans). DELIV-7 dw1 (re-review minor 5): a scan
 * stamps a row's cooldown only when every notice it sent for the row landed;
 * a dead-lettered notice is sent again on the next run, to its recipient
 * only. This reads the scan's dead letters of the last `lookbackMs` (ONE
 * read per scan per org) and answers, per row, which notices its last run
 * lost: the dead letters carrying the row's retry key, written after the
 * row's last stamp, from the latest run (within RETRY_RUN_SPAN_MS of the
 * newest). A read that fails is a note in the scan's line, and every row
 * then sends every notice (a lost notice's co-recipients may get a second
 * copy — the scan's behaviour before this pass).
 */
export async function loadScanRetryPlan(orgId: string, scan: string, lookbackMs: number): Promise<ScanRetryPlan> {
  const byKey = new Map<string, Array<{ at: number; kind: string; recipient: string }>>();
  let unreadable = false;
  try {
    const { data, error } = await db().from("audit_logs").select("details, timestamp")
      .eq("org_id", orgId).eq("action", NOTIFICATION_DEAD_LETTER)
      .gte("timestamp", new Date(Date.now() - lookbackMs).toISOString())
      .order("timestamp", { ascending: false }).limit(RETRY_PLAN_ROWS);
    if (error) throw new Error(error.message ?? String(error));
    for (const row of (data ?? []) as Array<{ details?: Record<string, unknown> | null; timestamp?: string | null }>) {
      const d = row.details ?? null;
      const key = d && typeof d.retryKey === "string" ? d.retryKey : null;
      if (!key || !key.startsWith(`${scan}:`)) continue;
      const at = row.timestamp ? Date.parse(row.timestamp) : NaN;
      if (!Number.isFinite(at)) continue;
      const list = byKey.get(key) ?? [];
      list.push({ at, kind: String(d!.kind), recipient: String(d!.recipient) });
      byKey.set(key, list);
    }
  } catch (e) {
    unreadable = true;
    const note = `the dead letters of the last run could not be read (${(e as Error).message}) — every due row sends every notice this run`;
    console.warn(`[compliance-notify] ${scan}@${orgId}: ${note}`);
    if (readScope?.()) noteComplianceScan(note);
  }
  const after = (key: string, stampedAt: string | null | undefined) => {
    const stamp = stampedAt ? Date.parse(stampedAt) : NaN;
    return (byKey.get(key) ?? []).filter((x) => !Number.isFinite(stamp) || x.at > stamp);
  };
  return {
    unreadable,
    has(key, stampedAt) {
      return after(key, stampedAt).length > 0;
    },
    only(key, stampedAt) {
      const list = after(key, stampedAt);
      if (list.length === 0) return () => true;
      const latest = Math.max(...list.map((x) => x.at));
      const lost = new Set(list.filter((x) => x.at >= latest - RETRY_RUN_SPAN_MS).map((x) => `${x.kind}|${x.recipient}`));
      return (kind, uid) => lost.has(`${kind}|${uid}`);
    },
  };
}
