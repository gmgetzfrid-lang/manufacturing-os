// GET/POST /api/cron/maintenance
//
// Housekeeping cron — scheduled DAILY at 03:00 UTC (vercel.json). The
// /checkouts page also runs the checkout sweep opportunistically on load,
// so in practice expiry enforcement is "daily at worst, page-visit at best".
// Runs the time-based enforcement that the rest of the app assumes happens
// on a clock rather than only on a page visit:
//
//   1. Auto-release ad-hoc checkouts past their cap, ACROSS ALL ORGS.
//      (A lock must not depend on someone happening to open /checkouts.)
//   2. Drain the queued email_notifications queue as a safety net, in case
//      the fire-and-forget client kick failed.
//   3. Storage watermark alerts.
//   4. Prune expired document_intents rows (the ambient work-in-progress
//      layer decays by design — expired rows are noise).
//   5. Stale-checkout escalation: checkouts held past 14 days notify the
//      org's DocCtrl/Admin pool (a stale lock stops being the holder's
//      private secret).
//   6. Compliance clocks per org — including the hold aging sweep (HLD-14):
//      a hold past its expected release, or open past HOLD_AGING_DAYS with
//      no date, nudges its opener and the release pool once.
//   4c. The intake door's attempt window is pruned (INTK-8 dw4 — the door's
//      rate limiter keeps an hour; two days are kept), and the count of
//      in-review versions no document points at AND nothing withdrew is
//      reported (SAF-10's health signal — a withdrawn or displaced draft is
//      resolved, so the signal is actionable, not permanent noise), as is
//      every document whose pending revision still names a RETIRED draft —
//      a state count, reported on every run until it reaches 0 (INTK-4: the
//      door's unrestorable displacement, audit action
//      INTAKE_DISPLACE_UNRESOLVED, is one way to get there). Each count
//      above 0 is logged (console.error) and nudges that org's controller
//      pool once a day (nudgeReviewHealth); an RPC that fails is reported,
//      unless the function does not exist yet (20261105 not applied).
//      Folded intake publishes / replacements no notice announced get one
//      digest per project (INTK-10 / SEC-8 — flushFoldedIntakeNotices).
//      The door's direct-upload staging is swept (INTK-15 — every object
//      under intake-staging/ older than STAGING_TTL_MS, then the expired
//      reservations; lib/intakeStaging.ts sweepIntakeStaging).
//   4d. The public verify endpoints' scan record (verify_scans) is pruned to
//      90 days (VFY-12; prune_verify_scans(), 20261134).
//   8. (knowledge block) The assistant's write proposals a week past their
//      15-minute expiry are pruned (ORCH-4; pruneOrchestratorProposals,
//      lib/orchestrator/proposals.ts; a no-op before 20261147).
//
// Auth: server-to-server. If CRON_SECRET is set, require it as a Bearer
// token. Degrades gracefully if optional env vars are missing.

import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { autoReleaseExpiredAdHoc } from "@/lib/projects";
import { runStorageAlerts } from "@/lib/storageAlerts";
import { __setServerSupabaseClient, __resetServerSupabaseClient } from "@/lib/supabase";
import { scanAndNotifyReviews } from "@/lib/reviewCycles";
import { scanAndNotifyAcks } from "@/lib/acknowledgments";
import { scanReviews } from "@/lib/reviewControl";
import { scanEffectiveDates } from "@/lib/effectiveDate";
import { scanRetention } from "@/lib/retention";
import { scanAccessRecerts } from "@/lib/accessRecert";
import { scanDistributionAcks } from "@/lib/distributionAcks";
import { scanStaleHolds } from "@/lib/holds";
import { syncAllKnowledgeSources } from "@/lib/knowledgeSourceSync";
import { drainKnowledgeIngestQueue } from "@/lib/knowledgeIngest";
import { drainEmbedBacklog } from "@/lib/knowledgeEmbedDrain";
import { pruneOrchestratorProposals } from "@/lib/orchestrator/proposals";
import { runPlatformStorageAlerts } from "@/lib/storageUsage";
import { rebuildAclIndexes, type RebuildCounts } from "@/lib/aclIndexRebuild";
import { roleFilter } from "@/lib/roleHeld";
import {
  flushFoldedIntakeNotices, deliverFoldedDigest, foldedDigestKind, foldedDigestMetadata,
  nudgeReviewHealth, REVIEW_HEALTH_KIND, isMissingFunction, type ReviewHealthOrg,
} from "@/lib/intakeRateLimit";
import { runWithServerClient } from "@/lib/serverClientScope";
import { sweepIntakeStaging } from "@/lib/intakeStaging";
import { emit, type EmitResult } from "@/lib/notify/dispatch";
import { KIND_META } from "@/lib/notificationKinds";
import { emailAllowedByPrefs } from "@/lib/notificationPrefs";
import { renderNotificationEmail } from "@/lib/emailRender";
import { publicOrigin } from "@/lib/publicOrigin";
import { formatRecordDate, formatRecordTime, orgTimeZone } from "@/lib/recordTime";

export const runtime = "nodejs";
export const maxDuration = 300;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const cronSecret = process.env.CRON_SECRET || "";

async function handler(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: "Supabase credentials missing" }, { status: 500 });
  }
  // Fail closed: reject unless the caller presents CRON_SECRET. Vercel
  // attaches it automatically to the scheduled invocation; if the secret is
  // somehow unset, deny rather than run world-open.
  const auth = req.headers.get("authorization") || "";
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // The run's clock (N6 fix pass 2): every step that must leave time for the
  // ones after it derives its limit from here — step 2's drain, the
  // compliance digest (6b), the second drain (6c) and the background steps.
  // `runEnd` is the platform's kill (maxDuration) less the response's tail.
  const startedAt = Date.now();
  const runEnd = startedAt + RUN_BUDGET_MS - RUN_TAIL_MS;
  const left = () => runEnd - Date.now();
  // A background step the run has no time left for is not run, and says so.
  const noTimeFor = (step: string, needMs: number): boolean => {
    if (left() >= needMs) return false;
    result.errors.push(`${step}: not run — ${Math.max(0, Math.round(left() / 1000))} s of the run were left (it needs ${needMs / 1000} s; the email steps before it come first) — the next run continues it`);
    return true;
  };

  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const result: {
    releasedCheckouts: number;
    notificationsDrained: number | null;
    storageAlerts: number;
    prunedIntents: number;
    staleEscalations: number;
    complianceNotices: number;
    complianceOrgs: number;
    complianceEmails: number;
    folderTrashPurged?: number;
    knowledgeSync?: { libraries: number; added: number; refreshed: number; removed: number; deferred: number; unsynced: number };
    knowledgeIngest?: { docs: number; pages: number; completed: number };
    orchestratorProposalsPruned?: number;
    platformStorage?: { r2Pct: number; dbPct: number; alerts: number };
    embedDrain?: { libraries: number; embedded: number };
    aclIndexRebuild?: RebuildCounts;
    intakeAttemptsPruned?: number;
    orphanedInReviewVersions?: number;
    pendingOnRetiredVersions?: number;
    intakeFoldedDigests?: number;
    intakeStagingSwept?: number;
    reviewHealthNudges?: number;
    verifyScansPruned?: number;
    /** DELIV-11: what the drain did — an empty queue, a batch that failed, and
     *  unconfigured email are three different answers here. */
    emailDrain?: DrainReport;
    emailDrainAfterDigest?: DrainReport;
    errors: string[];
  } = {
    releasedCheckouts: 0,
    notificationsDrained: null,
    storageAlerts: 0,
    prunedIntents: 0,
    staleEscalations: 0,
    complianceNotices: 0,
    complianceOrgs: 0,
    complianceEmails: 0,
    errors: [],
  };

  // 1. Sweep expired ad-hoc checkouts across every org (no orgId filter).
  try {
    result.releasedCheckouts = await autoReleaseExpiredAdHoc(null, { client: sb });
  } catch (e) {
    result.errors.push(`checkout-sweep: ${(e as Error).message}`);
  }

  // 2. Drain the notification queue (best-effort; the route handles its own
  //    Resend wiring + suppression). We call it in-process via fetch to the
  //    sibling route so the email-sending logic lives in one place.
  //    LOOP until the queue is empty (bounded): the batch cap exists to bound
  //    one request, not the day — a 400-email fan-out must not take 16 days.
  //    DELIV-11: `processed` decides "empty", never `sent` (sent:0 is a real
  //    answer); unconfigured email and failed sends are reported, not read as
  //    an empty queue (drainEmailQueue). N6 fix pass 2: it starts no batch
  //    that could end after FIRST_DRAIN_BUDGET_MS of the run, so a backlog
  //    cannot take the compliance steps' time.
  try {
    const drain = await drainEmailQueue(req.nextUrl.origin, 12, "notifications", result.errors, startedAt + FIRST_DRAIN_BUDGET_MS);
    result.notificationsDrained = drain.sent;
    result.emailDrain = drain;
  } catch (e) {
    result.errors.push(`notifications: ${(e as Error).message}`);
  }

  // 3. Storage watermark alerts: notify admins of orgs over their set quota.
  try {
    const { alerts } = await runStorageAlerts(sb);
    result.storageAlerts = alerts;
  } catch (e) {
    result.errors.push(`storage-alerts: ${(e as Error).message}`);
  }

  // 4. Prune expired intents (decayed ambient signal). No-op pre-migration.
  try {
    const { data, error } = await sb
      .from("document_intents")
      .delete()
      .lt("expires_at", new Date().toISOString())
      .select("id");
    if (!error) result.prunedIntents = ((data as unknown[]) ?? []).length;
  } catch (e) {
    result.errors.push(`intent-prune: ${(e as Error).message}`);
  }

  // 4c. INTAKE DOOR housekeeping (INTK-8 dw4, SAF-10 dw3) — one step, on
  //     this cron (a third vercel.json cron entry fails deployment). No-op
  //     on a database without 20261105 — and only then: an RPC that exists
  //     and fails is reported, never read as a count of 0.
  // Every line this step writes is also logged — the platform's cron log
  // shows console output, not this route's JSON body.
  const intakeLine = (line: string) => { result.errors.push(line); console.error(`[cron/maintenance] ${line}`); };
  try {
    const { data: pruned, error: pruneErr } = await sb.rpc("prune_intake_attempts");
    if (pruneErr) {
      if (!isMissingFunction(pruneErr)) intakeLine(`intake-attempts: ${pruneErr.message}`);
    } else {
      result.intakeAttemptsPruned = Number(pruned ?? 0);
    }
    // INTK-15: the direct door's staging — an abandoned begin's object (a
    // closed tab, a PUT never finalized), or a refused finalize's whose own
    // delete failed, is removed once older than STAGING_TTL_MS, then its
    // expired reservation. Never throws; each failure is a line.
    const staging = await sweepIntakeStaging(sb);
    result.intakeStagingSwept = staging.objectsDeleted;
    for (const e of staging.errors) intakeLine(`intake-staging: ${e}`);
    if (staging.truncated) intakeLine("intake-staging: more staged objects than one run lists — the next run continues");
    const { data: orphans, error: orphanErr } = await sb.rpc("orphaned_in_review_versions_count");
    if (orphanErr) {
      if (!isMissingFunction(orphanErr)) intakeLine(`intake-door: health count unavailable (orphaned_in_review_versions_count): ${orphanErr.message}`);
    } else {
      result.orphanedInReviewVersions = Number(orphans ?? 0);
      if (result.orphanedInReviewVersions > 0) {
        // No screen lists a version nothing points at (the Intake tab and
        // the review panel both follow the pending pointer), so the remedy
        // named is the one a document controller can actually run.
        intakeLine(`review-health: ${result.orphanedInReviewVersions} in-review version(s) that no document points at and nothing withdrew — a document controller must resolve each one (mark it 'superseded' or 'rejected', or re-point its document's pending revision); find them with the query in orphaned_in_review_versions_count() (migration 20261105)`);
      }
    }
    // INTK-4: a document whose pending revision names a RETIRED draft
    // (superseded_at stamped, or review_state 'superseded') is stuck — the
    // Intake tab lists only in-review drafts, the portal shows "in review"
    // for ever, and the orphan count never sees it. Counted from the rows'
    // STATE, so it is reported on every run until it reaches 0 — never
    // only in the day after it happened. (The door's own unrestorable
    // displacement writes audit action INTAKE_DISPLACE_UNRESOLVED.)
    const { data: stuck, error: stuckErr } = await sb.rpc("pending_on_retired_version_count");
    if (stuckErr) {
      if (!isMissingFunction(stuckErr)) intakeLine(`intake-door: health count unavailable (pending_on_retired_version_count): ${stuckErr.message}`);
    } else {
      result.pendingOnRetiredVersions = Number(stuck ?? 0);
      if (result.pendingOnRetiredVersions > 0) {
        intakeLine(`review-health: ${result.pendingOnRetiredVersions} document(s) whose pending revision names a retired draft — each stays 'in review' with nothing to review until a document controller re-opens the draft (review_state 'in_review', superseded_at cleared) or clears the document's pending revision; find them with the query in the comment on pending_on_retired_version_count() (migration 20261105); the intake door's own cases are audit action INTAKE_DISPLACE_UNRESOLVED`);
      }
    }
    // The counts reach a person: each org with one above 0 nudges its
    // controller pool once a day (bell; the compliance email at 6b carries
    // it, REVIEW_HEALTH_KIND being a compliance kind).
    if ((result.orphanedInReviewVersions ?? 0) + (result.pendingOnRetiredVersions ?? 0) > 0) {
      const { data: byOrg, error: byOrgErr } = await sb.rpc("intake_review_health_by_org");
      if (byOrgErr) {
        intakeLine(`intake-door: per-org review-health counts unavailable — no controller was nudged: ${byOrgErr.message}`);
      } else {
        const orgs: ReviewHealthOrg[] = ((byOrg ?? []) as Array<Record<string, unknown>>).map((r) => ({
          orgId: r.org_id == null ? null : String(r.org_id), orphanedInReview: Number(r.orphaned_in_review ?? 0),
          pendingOnRetired: Number(r.pending_on_retired ?? 0),
          exampleDocumentId: r.example_document_id == null ? null : String(r.example_document_id),
        }));
        // DELIV-7 (N6 fix pass 2): what each nudge reached is read, never
        // discarded — one that reached no controller, or whose bell rows were
        // refused, counts as not nudged and is named below.
        const nudgeShort: string[] = [];
        const nudged = await nudgeReviewHealth(sb, {
          orgs, day: new Date().toISOString().slice(0, 10),
          send: (h, text, metadata) => runWithServerClient(sb, () => emit({
            orgId: h.orgId, category: "system", kind: REVIEW_HEALTH_KIND,
            title: text.title, body: text.body,
            resource: { type: "document", id: h.exampleDocumentId ?? "" }, actorName: "System",
            audience: { roles: ["Admin", "DocCtrl"] },
            channels: ["inapp"],
            metadata,
          }).then((r) => {
            const short = emitShortfall(r, "inapp");
            if (short) { nudgeShort.push(`${h.orgId}: ${short}`); throw new Error(short); }
          })),
        });
        result.reviewHealthNudges = nudged.nudged;
        if (nudged.failed > 0) intakeLine(`intake-door: ${nudged.failed} org(s) with review-health counts could not be nudged${nudgeShort.length ? ` — ${nudgeShort.slice(0, 5).join("; ")}` : ""}`);
        if (nudged.orgless > 0) intakeLine(`review-health: ${nudged.orgless} group(s) of rows name no org (neither the version nor its document carries org_id) — counted above, no controller pool to nudge; find them with the two count functions' queries and an org_id IS NULL filter`);
      }
    }
    // INTK-10 / SEC-8: folded intake publishes / replacements that no
    // notice announced (the link went quiet after its burst) — one digest
    // per PROJECT to the controllers and the owner. deliverFoldedDigest
    // inserts the bell rows itself and reports how many landed (emit()
    // swallows its failures, so it cannot say); the email leg is emit() on
    // the email channel, best-effort, drained at 6c.
    if (!pruneErr) {
      const flushed = await flushFoldedIntakeNotices(sb, {
        send: (d) => deliverFoldedDigest(sb, d, (dd) => runWithServerClient(sb, () => emit({
          orgId: dd.orgId, category: "watched", kind: foldedDigestKind(dd),
          title: dd.title, body: dd.body, link: dd.link,
          resource: { type: "project", id: dd.projectId }, actorName: dd.actorName,
          audience: { involved: dd.involved, followers: false },
          channels: ["email"],
          metadata: foldedDigestMetadata(dd),
        }).then((r) => {
          // DELIV-7 (N6 fix pass 2): the email leg's reach is read — the bell
          // rows landed (counted above); an email that reached nobody is a line.
          const short = emitShortfall(r, "email");
          if (short) intakeLine(`intake-notices: project ${dd.projectId} — the digest's email leg: ${short}`);
        }))),
      });
      result.intakeFoldedDigests = flushed.digests;
      if (flushed.failed > 0) {
        intakeLine(`intake-notices: ${flushed.failed} link(s) with folded publishes or replacements could not be announced (nothing landed) — retried on the next run`);
      }
      if (flushed.unrecorded > 0) {
        intakeLine(`intake-notices: ${flushed.unrecorded} link(s) were announced but their 'digested' marker did not land — the next run announces them again`);
      }
    }
  } catch (e) {
    intakeLine(`intake-door: ${(e as Error).message}`);
  }

  // 4d. PUBLIC VERIFY scan record (VFY-12) — keep 90 days. One step, on this
  //     cron (no third vercel.json entry); no-op until 20261134 is applied.
  try {
    const { data: scansPruned, error: scanPruneErr } = await sb.rpc("prune_verify_scans");
    if (scanPruneErr) {
      if (!isMissingFunction(scanPruneErr)) intakeLine(`verify-scans: ${scanPruneErr.message}`);
    } else {
      result.verifyScansPruned = Number(scansPruned ?? 0);
    }
  } catch (e) {
    intakeLine(`verify-scans: ${(e as Error).message}`);
  }

  // 5. Stale-checkout escalation. Sessions active for 14+ days notify the
  //    org's DocCtrl/Admin pool — once per session (metadata-deduped by the
  //    session id in the notification row we insert).
  try {
    result.staleEscalations = await escalateStaleCheckouts(sb, result.errors);
  } catch (e) {
    result.errors.push(`stale-escalation: ${(e as Error).message}`);
  }

  // 4b. Rebuild acl_index from each node's ACL + ancestor chain, dropping
  //     expired rules (DB-4 / OWN-7 / DEC-10). Idempotent and diff-guarded:
  //     it only writes a node whose recomputed index differs from the stored
  //     one, so it is a no-op for already-correct data. This narrows the
  //     stale-grant window to one cron cycle; it is not a full fix.
  try {
    const rebuilt = await rebuildAclIndexes(sb, Date.now());
    result.aclIndexRebuild = rebuilt;
    // The rebuild never throws for a partial failure — it skips the affected
    // org/node and reports it here, so a stale (possibly fail-open) index is
    // never a silent success.
    for (const msg of rebuilt.errors) result.errors.push(`acl-index-rebuild: ${msg}`);
  } catch (e) {
    result.errors.push(`acl-index-rebuild: ${(e as Error).message}`);
  }

  // 6. COMPLIANCE CLOCKS — review cycles, read-&-understood nags, pre-publish
  //    review nudges + alternate activation, effective-date arrivals,
  //    retention flags, access recerts, distribution-ack nags. These scans
  //    are written against the shared lib client; swap it to the service
  //    role for this lambda so they run with full visibility (not one
  //    controller's RLS slice) and run on a real clock instead of whenever
  //    a controller happens to open a browser tab.
  try {
    __setServerSupabaseClient(sb);
    const { data: orgRows, error: orgErr } = await sb.from("orgs").select("id");
    if (orgErr) throw new Error(orgErr.message);
    const scans: Array<[string, (orgId: string) => Promise<number>]> = [
      ["review-cycles", scanAndNotifyReviews],
      ["read-understood", scanAndNotifyAcks],
      ["pre-publish-review", scanReviews],
      ["effective-dates", scanEffectiveDates],
      ["retention", scanRetention],
      ["access-recert", scanAccessRecerts],
      ["distribution-acks", scanDistributionAcks],
      // HLD-14: holds past their expected release, or open past HOLD_AGING_DAYS
      // with no date — the opener and the release pool are nudged once. Rides
      // here because a third vercel.json cron entry fails deployment (step 10).
      ["hold-aging", scanStaleHolds],
    ];
    for (const org of (orgRows as Array<{ id: string }>) ?? []) {
      result.complianceOrgs += 1;
      for (const [name, fn] of scans) {
        try {
          result.complianceNotices += await fn(org.id);
        } catch (e) {
          // Loud, per-scan, per-org — a permanently failing scan must be
          // distinguishable from a clean one.
          result.errors.push(`${name}@${org.id}: ${(e as Error).message}`);
        }
      }
    }
  } catch (e) {
    result.errors.push(`compliance: ${(e as Error).message}`);
  } finally {
    // Never leave the shared client bound to the service role — on a
    // long-lived self-hosted process the swap would otherwise outlive this
    // request and leak into anything else importing @/lib/supabase.
    __resetServerSupabaseClient();
  }

  // 6b. COMPLIANCE EMAIL DIGEST — the bell alone is not an escalation
  //     channel: an obligation that never leaves the app dies with an unread
  //     badge. One email per user per day summarizing their NEW compliance
  //     notices (reviews due, acks outstanding, retention flags, recerts,
  //     effective dates, reviewer nudges). Queued into email_notifications;
  //     the drain below sends it. Each recipient's list is read on its own
  //     (NEDGE-17), unread items only, through the member's email
  //     preferences (NEDGE-9), with an absolute link to their Inbox (NEDGE-4).
  //     N6 fix pass 2: it always gets DIGEST_FLOOR_MS (unless the run ends
  //     first), and a run that cannot reach everyone loses nothing — the
  //     next run resumes where it stopped (queueComplianceDigests). N6 fix
  //     pass 3: it visits org by org, each with its share of that time, so
  //     one org's volume cannot spend another org's digest.
  try {
    result.complianceEmails = await queueComplianceDigests(sb, {
      origin: publicOrigin() || req.nextUrl.origin,
      errors: result.errors,
      deadlineAt: digestDeadlineAt(runEnd, Date.now()),
      runStartedAt: startedAt,
    });
  } catch (e) {
    result.errors.push(`compliance-digest: ${(e as Error).message}`);
  }

  // 6c. Drain anything the compliance steps just queued (step 2 ran before
  //     they existed in this request). DELIV-11: reported like step 2, never
  //     swallowed. With email unconfigured step 2 has already said so, and
  //     this pass would only say it again. It starts no batch that could end
  //     after the run's end.
  if (result.emailDrain?.configured !== false) {
    try {
      result.emailDrainAfterDigest = await drainEmailQueue(req.nextUrl.origin, 6, "notifications (after the compliance steps)", result.errors, runEnd);
    } catch (e) {
      result.errors.push(`notifications (after the compliance steps): ${(e as Error).message}`);
    }
  }

  // 7b. FOLDER TRASH PURGE — soft-deleted folder shells past their 30-day
  //     hold are removed for good. They're empty (contents stepped up at
  //     delete time), so this is a plain row delete. No-op on a DB that
  //     hasn't run 20261011 (no deleted_at column).
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const { data: purged, error: purgeErr } = await sb
      .from("collections").delete()
      .not("deleted_at", "is", null).lt("deleted_at", cutoff)
      .select("id");
    if (purgeErr) {
      if (!/deleted_at|42703/i.test(`${purgeErr.code ?? ""} ${purgeErr.message}`)) {
        result.errors.push(`folder-trash: ${purgeErr.message}`);
      }
    } else {
      result.folderTrashPurged = (purged ?? []).length;
    }
  } catch (e) {
    result.errors.push(`folder-trash: ${(e as Error).message}`);
  }

  // 8. KNOWLEDGE SOURCES — the live-subscription heartbeat. Reconcile every
  //    knowledge library against its document-control sources (newly filed
  //    docs appear, rev-ups go stale, removed/archived docs drop out), then
  //    drain the ingest queue so linked documents index in the background
  //    without anyone babysitting a browser tab. Bounded by pages + a
  //    deadline so this step can't eat the whole invocation. No-op on a
  //    pre-20260917 DB. N6 fix pass 2: from here on each background step
  //    takes what the run has left (noTimeFor / left()) — no reservation for
  //    them is held ahead of the compliance digest.
  if (!noTimeFor("knowledge-sync", KNOWLEDGE_SYNC_MS)) {
    try {
      const sync = await syncAllKnowledgeSources();
      result.knowledgeSync = {
        libraries: sync.libraries, added: sync.added,
        refreshed: sync.refreshed, removed: sync.removed,
        // ILIFE-13: the libraries this run left for the next (the rotation
        // reaches them oldest first), and the rev-ups another sync landed first.
        deferred: sync.deferred, unsynced: sync.unsynced,
      };
      if (sync.errors.length) {
        result.errors.push(...sync.errors.slice(0, 5).map((m) => `knowledge-sync: ${m}`));
      }
    } catch (e) {
      result.errors.push(`knowledge-sync: ${(e as Error).message}`);
    }
  }
  if (!noTimeFor("knowledge-ingest", INGEST_COMMIT_MS + 10_000)) {
    try {
      const drained = await drainKnowledgeIngestQueue({
        maxPages: 400,
        // Bounded to fit the platform's observed kill window with room for the
        // batch to COMMIT — an over-long drain gets killed mid-write and loses
        // every page it processed, which reads as "the cron never indexes".
        // Never past what the run has left (N6 fix pass 2).
        deadlineMs: Date.now() + Math.min(INGEST_MS, left() - INGEST_COMMIT_MS),
      });
      result.knowledgeIngest = {
        docs: drained.docsTouched, pages: drained.pagesIndexed, completed: drained.completed,
      };
      if (drained.errors.length) {
        result.errors.push(...drained.errors.slice(0, 5).map((m) => `knowledge-ingest: ${m}`));
      }
    } catch (e) {
      result.errors.push(`knowledge-ingest: ${(e as Error).message}`);
    }
  }
  // The assistant's proposals (ORCH-4): a row a week past its expiry holds a
  // message or a finding nobody can confirm any more — removed here daily,
  // so an org that stops proposing still sheds them (the store path prunes
  // too). No-op before 20261147; any other failure is a line.
  try {
    result.orchestratorProposalsPruned = await pruneOrchestratorProposals();
  } catch (e) {
    result.errors.push(`orchestrator-proposals: ${(e as Error).message}`);
  }

  // 9. PLATFORM STORAGE WATCHDOG — real measurements (walk the R2 bucket,
  //    exact DB relation sizes) against the plan ceilings (free tiers by
  //    default). Admins get an in-app notification at 70%/90%, deduped to
  //    one per person per resource per week — "upgrade before it breaks",
  //    not "why did uploads stop".
  if (!noTimeFor("platform-storage", STORAGE_WALK_MS)) {
    try {
      const { status, alerts } = await runPlatformStorageAlerts(sb);
      result.platformStorage = { r2Pct: status.r2.pct, dbPct: status.db.pct, alerts };
    } catch (e) {
      result.errors.push(`platform-storage: ${(e as Error).message}`);
    }
  }

  // 10. MEANING-INDEX DRAIN — advance consented embedding builds. This rides
  //     the maintenance cron BECAUSE it must not have a cron of its own: a
  //     third (or hourly) vercel.json cron entry fails every deployment on
  //     this plan — production silently froze for a day the last time one
  //     was added. Page loads nudge the drain far more often; this is the
  //     nobody-opened-the-app backstop. Its budget is what the run has left,
  //     up to EMBED_DRAIN_MS (N6 fix pass 2).
  if (!noTimeFor("embed-drain", EMBED_DRAIN_MIN_MS)) {
    try {
      const drainOut = await drainEmbedBacklog({ scopeOrgIds: null, budgetMs: Math.min(EMBED_DRAIN_MS, left()) });
      result.embedDrain = {
        libraries: drainOut.drained.length,
        embedded: drainOut.drained.reduce((n, d) => n + d.embedded, 0),
      };
    } catch (e) {
      result.errors.push(`embed-drain: ${(e as Error).message}`);
    }
  }

  return NextResponse.json(result);
}

/** What one drain pass did (DELIV-11). `queueEmpty` is true only when the
 *  route answered processed: 0 — the queue was drained — never because a
 *  batch sent nothing. */
type DrainReport = {
  batches: number;
  attempted: number;
  sent: number;
  failed: number;
  configured: boolean;
  /** Rows left queued because email is not configured (configured: false). */
  deferred: number | null;
  queueEmpty: boolean;
  /** The drain's time ran out with the queue not known to be empty (N6 fix
   *  pass 2): the rest is sent by the next drain. Absent otherwise. */
  outOfTime?: true;
  /** The cron stopped waiting for a batch that had not answered by the
   *  drain's limit (N6 fix pass 3; with outOfTime). Absent otherwise. */
  unanswered?: true;
};

/** One send-queued batch's JSON answer. */
type DrainBatchAnswer = {
  processed?: number; sent?: number; failed?: number; deferred?: number; configured?: boolean; errorSample?: string;
};

/** Drain the email queue through the sibling route, up to `maxBatches`
 *  batches, and report what happened (DELIV-11):
 *   - `processed` decides continuation: 0 is an empty queue. `sent: 0` is a
 *     legitimate answer, not a missing one.
 *   - email not configured (`configured: false`): the backlog stays queued
 *     (the route defers by design) and an error line names its size.
 *   - failed sends: an error line names the count and one provider message.
 *     A batch that sent nothing stops the loop — another batch would claim
 *     the same rows again and spend their attempts inside this one run.
 *   - time (N6 fix pass 2): no batch starts unless it can end (DRAIN_BATCH_MS)
 *     by `stopBy`; a drain that stops for time says so. N6 fix pass 3: and
 *     the cron waits for no batch past `stopBy` (a batch that does not
 *     answer by then is reported, `unanswered`).
 *  Every line is also logged: the platform's cron log shows console output,
 *  not this route's JSON. */
async function drainEmailQueue(origin: string, maxBatches: number, label: string, errors: string[], stopBy: number): Promise<DrainReport> {
  const report: DrainReport = { batches: 0, attempted: 0, sent: 0, failed: 0, configured: true, deferred: null, queueEmpty: false };
  const say = (line: string) => { errors.push(line); console.error(`[cron/maintenance] ${line}`); };
  let sample: string | null = null;
  for (let i = 0; i < maxBatches; i++) {
    if (Date.now() + DRAIN_BATCH_MS > stopBy) { report.outOfTime = true; break; }
    // N6 fix pass 3: the cron waits for a batch no later than `stopBy` — a
    // provider call that never answers must not hold the run (and the digest
    // after it) until the platform kills it. Stopping the wait does not stop
    // the batch: its rows stay 'sending' until it finishes, or the drain's
    // 15-minute reclaim re-queues them.
    const waitMs = Math.max(1_000, stopBy - Date.now());
    const signal = AbortSignal.timeout(waitMs);
    let res: Response | null = null;
    let body: DrainBatchAnswer | null = null;
    try {
      res = await fetch(`${origin}/api/notifications/send-queued`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cronSecret}` },
        signal,
      });
      if (res.ok) body = (await res.json().catch(() => null)) as DrainBatchAnswer | null;
    } catch (e) {
      if (!signal.aborted) throw e;
    }
    if (signal.aborted && !body) {
      report.outOfTime = true;
      report.unanswered = true;
      say(`${label}: a batch did not answer within the drain's limit (${Math.round(waitMs / 1000)} s) — the cron stopped waiting for it; its rows stay 'sending' until it finishes, or the drain's 15-minute reclaim re-queues them`);
      break;
    }
    if (!res || !res.ok) { say(`${label}: HTTP ${res?.status}`); break; }
    if (!body) { say(`${label}: the drain answered without a JSON body — nothing is known about that batch`); break; }
    report.batches += 1;
    if (body.configured === false) {
      report.configured = false;
      report.deferred = Number(body.deferred ?? 0);
      break;
    }
    const processed = Number(body.processed ?? 0);
    const sent = Number(body.sent ?? 0);
    report.attempted += processed;
    report.sent += sent;
    report.failed += Number(body.failed ?? 0);
    if (!sample && typeof body.errorSample === "string" && body.errorSample) sample = body.errorSample;
    if (processed === 0) { report.queueEmpty = true; break; }
    if (sent === 0) break;
  }
  if (!report.configured) {
    say(`${label}: email is not configured (RESEND_API_KEY is not set) — ${report.deferred} email(s) left queued, none sent`);
  }
  if (report.failed > 0) {
    say(`${label}: ${report.failed} of ${report.attempted} send attempt(s) failed${sample ? ` — e.g. ${sample}` : ""}`);
  }
  if (report.outOfTime && !report.unanswered) {
    say(report.batches === 0
      ? `${label}: not run — the run's time is spent; the queue is sent by the next drain`
      : `${label}: stopped at its time limit after ${report.batches} batch(es) (${report.sent} sent) — the rest of the queue is sent by the next drain`);
  }
  return report;
}

const STALE_ESCALATION_DAYS = 14;

// The escalation's raw insert stays here until notifications N14 (TAX-11's
// tail) routes it through notify(); DELIV-7 / NEDGE-12 (N6) report its
// failures and label its date.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function escalateStaleCheckouts(sb: SupabaseClient<any>, errors: string[]): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_ESCALATION_DAYS * 24 * 3600 * 1000).toISOString();
  const { data: staleRows, error } = await sb
    .from("checkout_sessions")
    .select("id, org_id, document_id, library_id, user_id, user_name, started_at, purpose")
    .eq("status", "active")
    .lt("started_at", cutoff);
  if (error) {
    errors.push(`stale-escalation: the stale checkouts could not be read — none was escalated: ${error.message}`);
    return 0;
  }
  if (!staleRows?.length) return 0;

  // NEDGE-12: the date in the body is labelled with its zone — the org's
  // configured one, else UTC (lib/recordTime.ts).
  const zones = new Map<string, Promise<string | null>>();
  const zoneOf = (orgId: string) => {
    if (!zones.has(orgId)) zones.set(orgId, orgTimeZone(sb, orgId));
    return zones.get(orgId)!;
  };

  let escalated = 0;
  for (const row of staleRows as Array<{
    id: string; org_id: string; document_id: string; library_id: string | null;
    user_id: string; user_name: string | null; started_at: string; purpose: string | null;
  }>) {
    // Dedupe: skip if we've already escalated this session.
    const { data: existing } = await sb
      .from("notifications")
      .select("id")
      .eq("kind", "checkout_released")
      .contains("metadata", { staleSessionId: row.id })
      .limit(1);
    if ((existing as unknown[] | null)?.length) continue;

    const { data: controllers } = await sb
      .from("org_members")
      .select("uid")
      .eq("org_id", row.org_id)
      .eq("status", "active")
      .or(roleFilter(["Admin", "DocCtrl"]));
    const recipients = ((controllers as Array<{ uid: string }> | null) ?? [])
      .map((c) => c.uid)
      .filter((uid) => uid !== row.user_id);
    if (recipients.length === 0) continue;

    const days = Math.floor((Date.now() - Date.parse(row.started_at)) / (24 * 3600 * 1000));
    const since = formatRecordDate(row.started_at, await zoneOf(row.org_id));
    const inserts = recipients.map((uid) => ({
      org_id: row.org_id,
      user_id: uid,
      kind: "checkout_released",
      title: `Checkout held ${days} days — review needed`,
      body: `${row.user_name || "A user"} has had a document checked out since ${since}${row.purpose ? ` (${row.purpose})` : ""}. Nudge them or force-release if the work is done.`,
      link: row.library_id ? `/documents/${row.library_id}?doc=${row.document_id}` : "/checkouts",
      resource_type: "document",
      resource_id: row.document_id,
      actor_name: "System",
      metadata: { staleSessionId: row.id, escalation: true },
    }));
    const { error: insErr } = await sb.from("notifications").insert(inserts);
    if (insErr) {
      // DELIV-7 dw3: reported, never only a counter that did not move.
      errors.push(`stale-escalation: session ${row.id} — the controllers' notice was not written (retried on the next run): ${insErr.message}`);
      continue;
    }
    escalated += 1;
  }
  return escalated;
}

/** The compliance digest's kinds — derived from the registry's `compliance`
 *  column (lib/notificationKinds.ts KIND_META, DEC-81 §1; TAX-5's seventh
 *  list collapsed, N6). The set is what this file listed by hand before:
 *  reviews due / overdue / requested / completed / invalidated / alternate
 *  activated, owner behind, deletion requested, acknowledgments requested /
 *  overdue / unsatisfiable, retention, access recerts, effective dates, and
 *  doc_superseded (manual distribution-ack requests and re-nudges ride on it).
 *  A kind flagged compliance there rides the digest; nothing here to edit. */
const COMPLIANCE_KINDS: string[] = (Object.keys(KIND_META) as Array<keyof typeof KIND_META>)
  .filter((k) => KIND_META[k].compliance);

/** How many distinct titles one digest lists (then "…and N more"). */
const DIGEST_LINES = 12;
/** How many of one recipient's newest unread compliance rows are read — far
 *  more than the digest lists; the subject's count is exact regardless. */
const DIGEST_SCAN_PER_RECIPIENT = 200;
/** Rows per page of the orgs list and of one org's recipient search (N6 fix
 *  pass 3: keyset on user_id within the org, skipping past each one found). */
const DIGEST_DISCOVERY_PAGE = 1000;
/** uids per .in() read (members, preferences) — keeps the URL short. */
const DIGEST_UID_CHUNK = 150;
const DIGEST_PARALLEL = 8;

/** The run's wall clock (NEDGE-17, N6 fix pass 2). The platform kills the
 *  function at `maxDuration` (300 s), losing the steps not yet run and this
 *  route's JSON with them; `runEnd` keeps RUN_TAIL_MS of that back for the
 *  response itself. */
const RUN_BUDGET_MS = maxDuration * 1000;
const RUN_TAIL_MS = 10_000;
/** One send-queued batch, typically (100 rows in ~30 s — that route's own
 *  note): a drain starts a batch only when this much of its limit is left,
 *  and waits for it no longer than the limit (N6 fix pass 3 — a batch that
 *  has not answered by then is reported and left to finish on its own). */
const DRAIN_BATCH_MS = 30_000;
/** Step 2's share of the run: it starts no batch that could end after this,
 *  so a backlog cannot take the compliance steps' time (what it leaves is
 *  sent at 6c and by the next drain). */
const FIRST_DRAIN_BUDGET_MS = 120_000;
/** What the compliance digest is always given from the moment it starts,
 *  however long the steps before it took — unless the run ends sooner. */
const DIGEST_FLOOR_MS = 60_000;
/** Kept back from the digest for the obligation step after it: the second
 *  drain (6c, one batch), which sends what the digest queued, and the two
 *  one-statement prunes. The background steps after them — knowledge sync,
 *  ingest, the storage walk, the embed drain — take what the run has left;
 *  no reservation for them is held ahead of the digest. */
const AFTER_DIGEST_RESERVE_MS = DRAIN_BATCH_MS + 10_000;
/** The background steps: the most each is given, cut to what the run has
 *  left; with less than it needs a step is not run, says so, and the next
 *  run continues it. */
const KNOWLEDGE_SYNC_MS = 15_000; // the sync's own default budget (lib/knowledgeSourceSync.ts)
const INGEST_MS = 40_000;
/** Room after the ingest's deadline for its last batch to commit. */
const INGEST_COMMIT_MS = 15_000;
const STORAGE_WALK_MS = 15_000;
const EMBED_DRAIN_MS = 100_000;
/** Below this the embed drain only marks libraries starved. */
const EMBED_DRAIN_MIN_MS = 20_000;

/** The digest's deadline: the run's end less the 6c reserve — and never less
 *  than DIGEST_FLOOR_MS from `now`, unless the run itself ends sooner. */
function digestDeadlineAt(runEnd: number, now: number): number {
  return Math.min(runEnd, Math.max(runEnd - AFTER_DIGEST_RESERVE_MS, now + DIGEST_FLOOR_MS));
}

/** DELIV-7 (N6 fix pass 2): what an emit() from this cron fell short of, as a
 *  sentence — nobody resolved, or bell rows refused — else null. The cron
 *  reads it instead of discarding the result. (emit() reports no per-email
 *  outcome; its email leg is judged by its audience alone.) */
function emitShortfall(r: EmitResult | null | undefined, leg: "inapp" | "email"): string | null {
  if (!r || r.recipients === 0) return "it reached no recipient (the audience resolved to nobody)";
  const failed = r.inapp?.failed ?? 0;
  if (leg === "inapp" && failed > 0) return `${failed} of ${r.recipients} bell row(s) were refused`;
  return null;
}

/** Where the compliance digest stands between runs (NEDGE-17; N6 fix passes
 *  2 and 3, and the integrator's fix pass) — one platform_settings row
 *  (20260920; service role only):
 *   - openSince: where the search starts for every org that has no entry in
 *     `orgs`. A run that visited every org moves it to its `asOf` less
 *     DIGEST_CLOCK_OVERLAP_MS; one whose deadline left orgs unvisited leaves
 *     it where it was.
 *   - orgs: one entry per org whose search starts somewhere else — its own
 *     window start (`since`) and, when its last visit did not finish
 *     (`unfinished`), the last recipient (uid) that visit reached (`after`):
 *     the org's next visit starts with the one after them and wraps, so
 *     successive short visits reach each of its recipients in turn. A
 *     finished visit's entry starts at the older of: the oldest item someone
 *     was held back from (the per-day dedupe, a failed read or insert), and
 *     this run's `asOf` less the margin. An entry equal to the new openSince
 *     says nothing openSince does not, and is dropped. So after a run that
 *     visited every org, a finished org keeps an entry only when someone was
 *     held back from before openSince; after a run that left orgs unvisited
 *     (openSince stays), every org it visited keeps one, and its next search
 *     starts where this run's stopped rather than at the older openSince.
 *   - nextOrg: the first org the last run did not visit (its deadline came
 *     first); the next run starts with it. Null when every org was visited.
 *  (Fix pass 2's single cursor — `after` beside openSince — is not read: such
 *  a state resumes from its openSince, which covers what that cursor owed.) */
const DIGEST_STATE_KEY = "compliance_digest";
type DigestOrgState = { since: string; after: string | null; unfinished: boolean };
type DigestState = { openSince: string; orgs: Record<string, DigestOrgState>; nextOrg: string | null };
/** How far back a digest's search ever reaches; within it, an item no run
 *  listed is listed by the next. No more than the purge's 7-day minimum, so
 *  the digest rows each recipient's window starts from are still there. */
const DIGEST_LOOKBACK_MS = 7 * 24 * 3600 * 1000;
/** The window of the first run (no state row yet) — the 25 hours the digest
 *  has always covered. */
const DIGEST_FIRST_WINDOW_MS = 25 * 3600 * 1000;
/** The clock margin (NEDGE-17, the integrator's fix pass). `asOf` is this
 *  server's clock; a row's created_at is the database's now() — when its
 *  transaction began. Every read runs to `asOf`, and the next window starts
 *  this much before where the last one stopped (each recipient's
 *  metadata.through, the org's window, openSince). So a row the last read
 *  could not see yet — written just after it, but stamped no later than
 *  `asOf` because this server's clock ran ahead of the database's, or
 *  committed after the read by a transaction that began before it — is found
 *  by the next run. The assumption: that clock difference plus such a
 *  transaction's length stays under five minutes (NTP keeps the two clocks
 *  far closer). What the last digest counted inside the margin it re-reads is
 *  left out of the next one by id (DIGEST_TAIL_IDS). */
const DIGEST_CLOCK_OVERLAP_MS = 5 * 60_000;
/** The most row ids a digest records (metadata.tail) of those it counted in
 *  the last DIGEST_CLOCK_OVERLAP_MS of its window — the stretch the next
 *  digest re-reads, which leaves them out (`not.in`, so its count stays
 *  exact). It bounds that read's URL (~39 characters an id). A digest that
 *  counted more there records its newest ones; the rest may be listed once
 *  more by the next digest. */
const DIGEST_TAIL_IDS = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The least one org's visit is given (NEDGE-17, N6 fix pass 3). Its share is
 *  the digest's time left divided among the orgs not yet visited, never less
 *  than this: the first half for finding the org's recipients, the rest for
 *  composing theirs. One org's volume spends its own share, never another's. */
const DIGEST_ORG_FLOOR_MS = 5_000;
/** How many orgs' unfinished visits one run names, one line each. */
const DIGEST_ORG_LINES = 10;

const isTimestamp = (t: unknown): t is string => typeof t === "string" && Number.isFinite(Date.parse(t));

function parseDigestState(v: unknown): DigestState | null {
  const o = v as { openSince?: unknown; orgs?: unknown; nextOrg?: unknown } | null;
  if (!o || !isTimestamp(o.openSince)) return null;
  const orgs: Record<string, DigestOrgState> = {};
  if (o.orgs != null) {
    if (typeof o.orgs !== "object" || Array.isArray(o.orgs)) return null;
    for (const [id, e] of Object.entries(o.orgs as Record<string, unknown>)) {
      const s = e as { since?: unknown; after?: unknown; unfinished?: unknown } | null;
      // One entry this run cannot read makes the whole state unreadable:
      // falling back to openSince for that org could skip what it is owed.
      if (!s || !isTimestamp(s.since) || (s.after != null && typeof s.after !== "string")) return null;
      orgs[id] = { since: s.since, after: typeof s.after === "string" && s.after ? s.after : null, unfinished: s.unfinished === true };
    }
  }
  return { openSince: o.openSince, orgs, nextOrg: typeof o.nextOrg === "string" && o.nextOrg ? o.nextOrg : null };
}

/** Where a recipient's last digest stopped: the end of its window
 *  (metadata.through) or, for a digest queued before N6 fix pass 2, when it
 *  was queued. */
function digestThrough(row: { created_at?: unknown; metadata?: unknown }): number | null {
  const through = (row.metadata as { through?: unknown } | null)?.through;
  const t = typeof through === "string" ? Date.parse(through) : NaN;
  if (Number.isFinite(t)) return t;
  const c = typeof row.created_at === "string" ? Date.parse(row.created_at) : NaN;
  return Number.isFinite(c) ? c : null;
}

/** The ids a recipient's last digest counted in its last
 *  DIGEST_CLOCK_OVERLAP_MS (metadata.tail) — uuids only, at most
 *  DIGEST_TAIL_IDS: anything else (a row from before the integrator's fix
 *  pass has none; a forged one may carry anything) is not put in a filter. */
function digestTail(row: { metadata?: unknown }): string[] {
  const tail = (row.metadata as { tail?: unknown } | null)?.tail;
  if (!Array.isArray(tail)) return [];
  return tail.filter((id): id is string => typeof id === "string" && UUID_RE.test(id)).slice(0, DIGEST_TAIL_IDS);
}

/** The daily compliance digest: one email per (org, member) listing their
 *  UNREAD compliance notices that no earlier digest listed.
 *   - Window (NEDGE-17, N6 fix pass 2 — lossless): each recipient's list runs
 *     from where their last digest stopped (metadata.through) — for someone
 *     no digest in the window has reached, from their org's window start (its
 *     state entry, else openSince) — to `asOf`. A visit or a run cut short
 *     leaves the state so a later run's search still covers what it did not
 *     list (up to DIGEST_LOOKBACK_MS back), and nobody it did reach is listed
 *     an item twice. The first run (no state) covers the 25 hours to now; a
 *     run that cannot read the state searches the whole lookback, starts each
 *     list where that person's last digest stopped, and records nothing.
 *     The integrator's fix pass: `asOf` is this server's clock and created_at
 *     the database's, so every window that starts where an earlier one
 *     stopped starts DIGEST_CLOCK_OVERLAP_MS before it, and leaves out what
 *     the last digest counted there (its metadata.tail).
 *   - Org by org (NEDGE-17, N6 fix pass 3): the orgs (keyset-paged by id) are
 *     visited in turn, starting with the first one the last run did not
 *     visit; after a run that visited every org, the orgs whose last visit did
 *     not finish go last, so they are given what the others leave. Each visit
 *     has a share of the digest's time (above). It finds the org's recipients
 *     from THAT ORG's unread compliance rows in its window — (user_id,
 *     created_at) only, ordered by (user_id, created_at) and skipping past
 *     each recipient found, so a recipient costs at most one page however many
 *     rows they hold — starting after the org's `after` and wrapping, to the
 *     empty page (never a short page read as the last: the API's row cap may
 *     be below the page). Then it composes the ones it found, in that order.
 *     A search cut short still composes what it found; a visit always reads
 *     one page and composes one round (the progress guarantee — a visit can
 *     outlast `deadlineAt` by that much). So a flood of one org's rows spends
 *     that org's share, never another org's; a single read slower than the
 *     whole digest delays the orgs after it by one run, which starts with
 *     them. Each recipient must be an ACTIVE member of that org with an
 *     address.
 *   - NEDGE-17: each recipient's list comes from a read scoped to that
 *     (org, member) and ordered newest first — no window shared across orgs
 *     and recipients, so one member's rows cannot push anyone else's lines
 *     out of their digest.
 *   - NEDGE-9: the member's preferences decide, through the app's one email
 *     rule (lib/notificationPrefs.ts emailAllowedByPrefs — master switch,
 *     then 'never'; the digest has no toggle of its own, DEC-74 §3), read as
 *     the service role, so a missing row really is the defaults. A row that
 *     cannot be read sends the digest stamped pref_gate = 'unverified'
 *     (DEC-74 §4). An item already read in the bell is not listed.
 *   - NEDGE-4: the email links the member's Inbox, absolute (lib/emailRender.ts).
 *   - NEDGE-12: it names its window — "from <since> to <asOf>", in the org's
 *     zone when configured, else UTC.
 *   - The per-(org, user, day) dedupe on metadata.day (the UTC day) is kept:
 *     a manual re-run never mails anyone twice; what it holds back stays owed.
 *   - Time: no org's visit starts at or after `deadlineAt` (the caller's
 *     digestDeadlineAt); the run says which orgs it did not visit or finish.
 *   - DELIV-7: every read and write that fails is a line in `errors`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function queueComplianceDigests(sb: SupabaseClient<any>, opts: { origin: string; errors: string[]; deadlineAt: number; runStartedAt: number }): Promise<number> {
  const now = Date.now();
  const asOf = new Date(now).toISOString();
  const dayKey = asOf.slice(0, 10);
  const iso = (ms: number) => new Date(ms).toISOString();
  const say = (line: string) => { opts.errors.push(`compliance-digest: ${line}`); console.error(`[cron/maintenance] compliance-digest: ${line}`); };
  const lookbackDays = DIGEST_LOOKBACK_MS / 86_400_000;
  // The first window, recorded only where no state row exists yet (one
  // statement; a no-op otherwise) — so even a first run that composes
  // nothing leaves the next run the window it owes.
  const recordFirstWindow = async () => {
    const first: DigestState = { openSince: iso(now - DIGEST_FIRST_WINDOW_MS), orgs: {}, nextOrg: null };
    const { error } = await sb.from("platform_settings").upsert(
      { key: DIGEST_STATE_KEY, value: first, updated_at: asOf }, { onConflict: "key", ignoreDuplicates: true });
    if (error) say(`the digest's first window could not be recorded — a run that does not finish may leave items older than ${DIGEST_FIRST_WINDOW_MS / 3_600_000} hours unlisted: ${error.message}`);
  };
  if (now >= opts.deadlineAt) {
    say(`nothing was composed — no time was left in this run (the steps before it used ${Math.round((now - opts.runStartedAt) / 1000)} s of the ${RUN_BUDGET_MS / 1000} s); nothing is lost: the next run's search starts where the last one that finished left off`);
    await recordFirstWindow();
    return 0;
  }

  // WHERE the last run stopped. Unreadable: search the whole lookback and
  // record nothing — the state stays as the last readable run left it.
  let state: DigestState | null = null;
  let stateReadable = true;
  let stateMalformed = false;
  try {
    const { data, error } = await sb.from("platform_settings").select("value").eq("key", DIGEST_STATE_KEY).maybeSingle();
    if (error) throw new Error(error.message);
    state = parseDigestState((data as { value?: unknown } | null)?.value ?? null);
    stateMalformed = !!data && !state;
  } catch (e) {
    stateReadable = false;
    say(`where the last run stopped could not be read — this run searches the last ${lookbackDays} days, lists each recipient's items from where their last digest stopped, starts at the first org and records nothing: ${(e as Error).message}`);
  }
  if (stateMalformed) {
    say(`the recorded state (platform_settings '${DIGEST_STATE_KEY}') is not one this run can read — it searches the last ${lookbackDays} days, lists each recipient's items from where their last digest stopped, and records a new state`);
  }
  if (stateReadable && !state && !stateMalformed) await recordFirstWindow();
  const horizon = now - DIGEST_LOOKBACK_MS;
  const searchAll = !stateReadable || stateMalformed;
  // Not clamped to the lookback here: only an org with no entry of its own
  // searches from openSince, and its visit clamps its window and names it
  // (visitOrg, `clamped`). After runs that left orgs unvisited, every org
  // visited since has its own entry, so an old openSince is no loss of theirs
  // (the integrator's fix pass — this said, for every org, that their items
  // past the lookback were no longer listed).
  const openSinceMs = searchAll ? horizon : state ? Date.parse(state.openSince) : now - DIGEST_FIRST_WINDOW_MS;
  const orgState: Record<string, DigestOrgState> = searchAll ? {} : state?.orgs ?? {};
  const startOrg = searchAll ? null : state?.nextOrg ?? null;

  // WHICH orgs: every one, by id, keyset-paged to the empty page.
  const orgIds: string[] = [];
  for (;;) {
    let q = sb.from("orgs").select("id");
    if (orgIds.length > 0) q = q.gt("id", orgIds[orgIds.length - 1]);
    const { data, error } = await q.order("id", { ascending: true }).limit(DIGEST_DISCOVERY_PAGE);
    if (error) { say(`the orgs could not be listed — no digest was composed; the next run searches the same window: ${error.message}`); return 0; }
    const page = (data as Array<{ id: unknown }> | null) ?? [];
    if (page.length === 0) break;
    for (const o of page) orgIds.push(String(o.id));
  }
  // The rotation: from the first org the last run did not visit; after a run
  // that visited every org, the unfinished ones last.
  let firstAt = startOrg === null ? 0 : orgIds.findIndex((id) => id >= startOrg);
  if (firstAt < 0) firstAt = 0;
  let order = [...orgIds.slice(firstAt), ...orgIds.slice(0, firstAt)];
  if (startOrg === null) order = [...order.filter((id) => !orgState[id]?.unfinished), ...order.filter((id) => orgState[id]?.unfinished)];

  type Member = { uid: string; org_id: string; email: string | null };
  // Preferences are a member's, not an org's: read once per uid per run.
  const prefs = new Map<string, Record<string, unknown>>();
  const unverified = new Set<string>();
  const prefsRead = new Set<string>();
  const readPrefs = async (uids: string[]) => {
    const todo = uids.filter((u) => !prefsRead.has(u));
    for (let i = 0; i < todo.length; i += DIGEST_UID_CHUNK) {
      const chunk = todo.slice(i, i + DIGEST_UID_CHUNK);
      chunk.forEach((u) => prefsRead.add(u));
      const { data, error } = await sb.from("notification_preferences").select("*").in("user_id", chunk);
      if (error) {
        chunk.forEach((u) => unverified.add(u));
        say(`the email preferences of ${chunk.length} member(s) could not be read — their digest is sent, stamped pref_gate=unverified: ${error.message}`);
        continue;
      }
      for (const p of (data as Array<Record<string, unknown>> | null) ?? []) prefs.set(String(p.user_id), p);
    }
  };

  const orgNames = new Map<string, Promise<string | null>>();
  const nameOf = (orgId: string) => {
    if (!orgNames.has(orgId)) {
      orgNames.set(orgId, Promise.resolve(sb.from("orgs").select("name").eq("id", orgId).maybeSingle()).then(
        ({ data }) => (((data as { name?: unknown } | null)?.name as string | null) ?? null), () => null));
    }
    return orgNames.get(orgId)!;
  };
  const zones = new Map<string, Promise<string | null>>();
  const zoneOf = (orgId: string) => {
    if (!zones.has(orgId)) zones.set(orgId, orgTimeZone(sb, orgId));
    return zones.get(orgId)!;
  };

  let queued = 0;
  /** Offer one member their digest. `owe(fromMs)`: what a later run's search
   *  for them must start from, when this one held something back. */
  const one = async (m: Member, windowMs: number, oldestMs: number, owe: (fromMs: number) => void) => {
    // Declined by their preferences: offered, and nothing is owed.
    if (!unverified.has(m.uid) && !emailAllowedByPrefs(prefs.get(m.uid) ?? null, "compliance_digest")) return;
    // Their last digest: today's means no second one today (the per-day
    // dedupe); otherwise their list starts where it stopped. A read that
    // fails sends anyway, from the window's start — a line listed twice is
    // better than none.
    // `sinceMs` is the window the digest names (and records as
    // metadata.since): from where their last digest stopped. Its read starts
    // DIGEST_CLOCK_OVERLAP_MS earlier (`readFromMs`) and leaves out the ids
    // that digest counted there (`tail`), so what it adds is only what that
    // digest's read could not see yet (the integrator's fix pass).
    let sinceMs = windowMs;
    let readFromMs = windowMs;
    let tail: string[] = [];
    const { data: last, error: lastErr } = await sb
      .from("email_notifications").select("created_at, metadata")
      .eq("org_id", m.org_id)
      .eq("to_user_id", m.uid)
      .eq("event_type", "compliance_digest")
      .order("created_at", { ascending: false })
      .limit(1);
    if (lastErr) {
      say(`${m.org_id}/${m.uid}: their last digest could not be read — sent anyway, listing from ${iso(windowMs)}: ${lastErr.message}`);
    } else {
      const row = ((last as Array<{ created_at?: unknown; metadata?: unknown }> | null) ?? [])[0];
      if (row) {
        const through = digestThrough(row);
        if ((row.metadata as { day?: unknown } | null)?.day === dayKey) {
          owe(Math.max(oldestMs - 1, through === null ? windowMs : through - DIGEST_CLOCK_OVERLAP_MS));
          return;
        }
        if (through !== null && through > sinceMs) {
          sinceMs = through;
          readFromMs = Math.max(windowMs, through - DIGEST_CLOCK_OVERLAP_MS);
          tail = digestTail(row);
        }
      }
    }
    const since = iso(sinceMs);
    // NEDGE-17: this member's own rows, in this org, newest first.
    let listQ = sb
      .from("notifications").select("id, kind, title, created_at", { count: "exact" })
      .in("kind", COMPLIANCE_KINDS)
      .eq("org_id", m.org_id)
      .eq("user_id", m.uid)
      .is("read_at", null)
      .gt("created_at", iso(readFromMs))
      .lte("created_at", asOf);
    if (tail.length > 0) listQ = listQ.not("id", "in", `(${tail.join(",")})`);
    const { data: rows, error, count } = await listQ
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(DIGEST_SCAN_PER_RECIPIENT);
    if (error) {
      say(`${m.org_id}/${m.uid}: their compliance items could not be read — no digest for them this run; the next run lists them: ${error.message}`);
      owe(Math.max(oldestMs - 1, readFromMs));
      return;
    }
    const list = (rows as Array<{ id: unknown; title: string; created_at: unknown }> | null) ?? [];
    if (list.length === 0) return;
    // What the next digest re-reads (the margin before this one's `asOf`) and
    // must leave out: the ids counted there, newest first (the read's order).
    const nextTail = list
      .filter((r) => Date.parse(String(r.created_at)) >= now - DIGEST_CLOCK_OVERLAP_MS)
      .map((r) => String(r.id))
      .filter((id) => UUID_RE.test(id))
      .slice(0, DIGEST_TAIL_IDS);

    const total = typeof count === "number" && count >= list.length ? count : list.length;
    const unique = [...new Set(list.map((r) => r.title))].slice(0, DIGEST_LINES);
    const more = total - unique.length;
    const [orgName, zone] = await Promise.all([nameOf(m.org_id), zoneOf(m.org_id)]);
    const subject = `Compliance items need you (${total})`;
    const message =
      "These document-control items are waiting on you:\n\n" +
      unique.map((t) => `  • ${t}`).join("\n") +
      (more > 0 ? `\n  …and ${more} more` : "") +
      `\n\nThis digest lists your unread compliance notices from ${formatRecordTime(since, zone)} to ${formatRecordTime(asOf, zone)}.`;
    let rendered: { bodyText: string; bodyHtml: string } | null = null;
    let link: string | null = null;
    try {
      const r = renderNotificationEmail({ subject, body: message, link: "/inbox", linkLabel: "Open your Inbox to act on them", orgName, origin: opts.origin });
      rendered = { bodyText: r.bodyText, bodyHtml: r.bodyHtml };
      link = `${opts.origin.replace(/\/+$/, "")}/inbox`;
    } catch (e) {
      say(`${m.org_id}/${m.uid}: ${(e as Error).message} — the digest is queued without a link`);
    }
    const { error: insErr } = await sb.from("email_notifications").insert({
      org_id: m.org_id,
      to_user_id: m.uid,
      to_email: m.email,
      subject,
      body_text: rendered ? rendered.bodyText : `${message}\n\nOpen your Inbox to act on them.`,
      body_html: rendered ? rendered.bodyHtml : null,
      event_type: "compliance_digest",
      metadata: {
        day: dayKey, count: total, since, through: asOf,
        ...(nextTail.length > 0 ? { tail: nextTail } : {}),
        ...(link ? { link, rendered: true } : {}),
        ...(unverified.has(m.uid) ? { pref_gate: "unverified" } : {}),
      },
      status: "queued",
    });
    if (insErr) {
      say(`${m.org_id}/${m.uid}: the digest was not queued — the next run lists these items again: ${insErr.message}`);
      owe(Math.max(oldestMs - 1, readFromMs));
      return;
    }
    queued += 1;
  };

  /** One org's visit: find its recipients until `searchBy`, then compose
   *  theirs until `composeBy` (each phase does one step whatever the clock
   *  says). Returns the org's next state entry and, when the visit did not
   *  finish, a line saying why. Every entry starts no later than `asOf` less
   *  DIGEST_CLOCK_OVERLAP_MS: what this visit's reads could not see yet is
   *  searched again by the next. */
  const clamped: string[] = [];
  const visitOrg = async (org: string, searchBy: number, composeBy: number): Promise<{ entry: DigestOrgState; line: string | null }> => {
    const own = orgState[org];
    let windowMs = own ? Date.parse(own.since) : openSinceMs;
    if (windowMs < horizon) { clamped.push(org); windowMs = horizon; }
    const windowStart = iso(windowMs);
    const cursor = own?.after ?? null;

    // WHO in this org has something pending, in uid order from the cursor
    // (wrapping): each recipient's oldest pending item, which a later run
    // must search from if this one does not reach them.
    const found: Array<{ uid: string; oldestMs: number }> = [];
    const ranges: Array<[string | null, string | null]> = cursor === null ? [[null, null]] : [[cursor, null], [null, cursor]];
    let searched = false;
    let searchFailure: string | null = null;
    let pages = 0;
    search: for (let ri = 0; ri < ranges.length; ri++) {
      const [lo, hi] = ranges[ri];
      let from = lo;
      for (;;) {
        if (pages > 0 && Date.now() >= searchBy) break search;
        let q = sb
          .from("notifications").select("user_id, created_at")
          .eq("org_id", org)
          .in("kind", COMPLIANCE_KINDS)
          .is("read_at", null)
          .gt("created_at", windowStart)
          .lte("created_at", asOf)
          .not("user_id", "is", null);
        if (from !== null) q = q.gt("user_id", from);
        if (hi !== null) q = q.lte("user_id", hi);
        const { data, error } = await q.order("user_id", { ascending: true }).order("created_at", { ascending: true }).limit(DIGEST_DISCOVERY_PAGE);
        pages += 1;
        if (error) { searchFailure = error.message; break search; }
        const page = (data as Array<{ user_id: string | null; created_at: string | null }> | null) ?? [];
        if (page.length === 0) break;
        for (const r of page) {
          const uid = r.user_id == null ? "" : String(r.user_id);
          // ordered by (user_id, created_at): a uid's first row is its oldest
          if (!uid || found[found.length - 1]?.uid === uid) continue;
          const at = Date.parse(String(r.created_at));
          found.push({ uid, oldestMs: Number.isFinite(at) ? at : windowMs });
        }
        from = String(page[page.length - 1].user_id);
      }
      if (ri === ranges.length - 1) searched = true;
    }

    // Of those, the ACTIVE members of this org with an address. A read that
    // fails leaves the rest of the found for the next visit.
    const members = new Map<string, Member>();
    let composable = found.length;
    let memberFailure: string | null = null;
    for (let i = 0; i < found.length; i += DIGEST_UID_CHUNK) {
      const chunk = found.slice(i, i + DIGEST_UID_CHUNK).map((f) => f.uid);
      const { data, error } = await sb
        .from("org_members").select("uid, org_id, email").eq("org_id", org).eq("status", "active").in("uid", chunk);
      if (error) { memberFailure = error.message; composable = i; break; }
      for (const m of (data as Member[] | null) ?? []) if (m.email) members.set(m.uid, m);
    }
    await readPrefs([...members.keys()]);

    // Compose, in the order found.
    let owedMs = Infinity;
    const owe = (fromMs: number) => { owedMs = Math.min(owedMs, Math.max(windowMs, fromMs)); };
    let reached = 0;
    for (let rounds = 0; reached < composable; rounds++) {
      if (rounds > 0 && Date.now() >= composeBy) break;
      const round = found.slice(reached, Math.min(composable, reached + DIGEST_PARALLEL));
      await Promise.all(round.map((f) => {
        const m = members.get(f.uid);
        return m ? one(m, windowMs, f.oldestMs, owe) : Promise.resolve();
      }));
      reached += round.length;
    }
    const unreached = found.slice(reached);
    for (const f of unreached) owe(f.oldestMs - 1);
    const after = reached > 0 ? found[reached - 1].uid : cursor;
    const marginMs = now - DIGEST_CLOCK_OVERLAP_MS;

    if (searched && unreached.length === 0) {
      // Finished: the next search starts at the oldest item someone was held
      // back from, or at the margin before `asOf` — whichever is older.
      return { entry: { since: iso(Math.min(owedMs, marginMs)), after: null, unfinished: false }, line: null };
    }
    // Not finished. What its search did not reach may be anywhere in its
    // window, so the window stays where it was; if the search finished, the
    // oldest item of those it did not reach bounds what is owed.
    const since = iso(Math.min(searched ? owedMs : windowMs, marginMs));
    const offered = `${reached} of the ${found.length} recipient(s) found were offered their digest`;
    const line = searchFailure
      ? `${org}: the search for its recipients failed (${offered}) — its next visit starts after the last one reached and searches back to ${since}: ${searchFailure}`
      : memberFailure
        ? `${org}: the memberships of ${found.length - composable} recipient(s) could not be read — no digest for them this run (${offered}); its next visit lists them: ${memberFailure}`
        : `${org}: its share of the digest's time ran out — ${offered}${searched ? "" : ", and its search for more did not finish"}; its next visit starts after the last one reached and searches back to ${since}, so nothing is lost within ${lookbackDays} days`;
    return { entry: { since, after, unfinished: true }, line };
  };

  // The visits. Each org's share: the time left over the orgs left, never
  // less than DIGEST_ORG_FLOOR_MS — so one org's volume costs its own share.
  const nextOrgs: Record<string, DigestOrgState> = {};
  const lines: string[] = [];
  let visited = 0;
  for (; visited < order.length; visited++) {
    const org = order[visited];
    const t0 = Date.now();
    if (t0 >= opts.deadlineAt) break;
    const share = Math.max(DIGEST_ORG_FLOOR_MS, (opts.deadlineAt - t0) / (order.length - visited));
    const composeBy = Math.min(opts.deadlineAt, t0 + share);
    const v = await visitOrg(org, t0 + (composeBy - t0) / 2, composeBy);
    nextOrgs[org] = v.entry;
    if (v.line) lines.push(v.line);
  }
  const notVisited = order.slice(visited);
  // An org not visited keeps what it was owed.
  for (const org of notVisited) if (orgState[org]) nextOrgs[org] = orgState[org];
  const nextOpenMs = notVisited.length === 0 ? now - DIGEST_CLOCK_OVERLAP_MS : openSinceMs;
  // A finished entry equal to openSince says nothing openSince does not:
  // dropped. Every other entry is kept — older (someone is owed from before
  // it) or newer (the integrator's fix pass: a run that left orgs unvisited
  // keeps openSince where it was, and an org it served searches next from
  // where this run stopped, not the older openSince). After a run that
  // visited every org no finished entry is newer than openSince (each is at
  // most `asOf` less the margin, which openSince then is), so there this
  // rule and the earlier `since >= openSince` drop the same entries.
  for (const [org, e] of Object.entries(nextOrgs)) {
    if (!e.unfinished && Date.parse(e.since) === nextOpenMs) delete nextOrgs[org];
  }
  const next: DigestState = { openSince: iso(nextOpenMs), orgs: nextOrgs, nextOrg: notVisited[0] ?? null };

  if (clamped.length > 0) {
    say(`the window still owed to ${clamped.length} org(s) reached back past ${lookbackDays} days (${clamped.slice(0, DIGEST_ORG_LINES).join(", ")}${clamped.length > DIGEST_ORG_LINES ? ", …" : ""}) — their unread items older than ${iso(horizon)} that no run listed are no longer listed`);
  }
  for (const line of lines.slice(0, DIGEST_ORG_LINES)) say(line);
  if (lines.length > DIGEST_ORG_LINES) say(`…and ${lines.length - DIGEST_ORG_LINES} more org(s) whose visit did not finish`);
  if (notVisited.length > 0) {
    say(`stopped at its deadline — ${notVisited.length} of ${order.length} org(s) were not visited this run; ` +
      (stateReadable
        ? `the next run starts with them, and what they are owed stays open, so nothing is lost within ${lookbackDays} days`
        : `this run could not record where it stopped, so the next run starts from the last point recorded`));
  }
  if (stateReadable) {
    const { error: saveErr } = await sb.from("platform_settings").upsert(
      { key: DIGEST_STATE_KEY, value: next, updated_at: asOf }, { onConflict: "key" });
    if (saveErr) say(`where this run stopped could not be recorded — the next run starts from the state the last run recorded (nobody reached here is listed an item twice): ${saveErr.message}`);
  }
  return queued;
}

export async function POST(req: NextRequest) { return handler(req); }
export async function GET(req: NextRequest) { return handler(req); }
