// Background continuation of meaning-index builds — the drain loop shared by
// the /api/knowledge/embed nudge target and the daily maintenance cron.
//
// CONSENT MODEL: this never decides to spend anyone's key. Starting a build
// in the UI stamps the library with WHO started it (ai_features.embedBuild.
// userId); the drain only continues libraries carrying that stamp, on that
// user's own embedding key, metered to them like every other call. The stamp
// clears when the library reaches 100% (or when the key disappears) — unless
// the person chose "keep this index current" (standing: true, SEM-8): then it
// stays, and passages added by later ingestion are embedded on the same key,
// under the same cap, by the next run.
//
// A stamp is trusted only as far as it holds up (GOV-14 limb): a userId that
// is not a uuid, or names nobody who is still an active member of the
// library's org, is released rather than spent on. It is re-read before
// EVERY batch: a consent withdrawn or replaced mid-run (Stop, a Rebuild by
// another member) stops the run before anything more is spent on it. Every
// write to the stamp is conditional on the stamp still being the one this
// run read, and a failed read never releases or completes one: a count the
// drain could not read is unknown, never 0.
//
// THE CAP IS RE-CHECKED BEFORE EVERY BATCH, AND THE RUN IS METERED AS IT
// GOES (GOV-5 / GOV-13). The cap read before a library's first batch is only
// the first check: once a batch is claimed, its worst case (every passage as
// the provider sees it, at 3 characters a token) is reserved against the
// payer's cap with every other reservation in view, before anything is sent.
// One that does not fit sends nothing — the passages go back to the queue and
// the library is held "cap" until the 1st (or, when the ledger cannot be
// read, looked at again within the hour). The run's spend on a library is
// ONE knowledgeEmbed row, as it always was — the first batch's reservation,
// settled to the run's tokens after every batch — so a run killed part-way
// has already recorded what its finished batches spent.
//
// NO LIBRARY STARVES ANOTHER (SEM-11). Every marked library is read (paged —
// no fixed window), and they are worked least-recently-drained first
// (lastDrainAt on the stamp). A library that cannot proceed records WHY and
// WHEN to look again instead of holding a slot: the monthly cap until the
// 1st, a provider / key error with a doubling backoff (released after
// MAX_ERROR_RUNS failed runs), a model conflict or an unsigned agreement for
// an hour. Every run reports each library as advanced / complete / current /
// blocked / released / busy / retrying / recent / starved (never reached this
// run). "busy" means another driver holds the rest; "retrying" means the
// passages left were refused by the provider and wait to be offered again
// (SEM-4) — nobody is embedding them, and the report says so.
//
// SCHEDULING NOTE — read before touching vercel.json: this used to have its
// own hourly cron. Hourly (and any third) cron entries FAIL EVERY VERCEL
// DEPLOYMENT on this plan — deployments silently stopped for a full day, the
// second time that exact mistake was made (see "Revert hourly cron" in the
// log). The drain therefore rides the existing daily maintenance cron plus
// the page-load nudge; lib/__tests__/vercelConfig.test.ts enforces the limit.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { embeddingConnectionFrom, buildModelConflict, EMBED_MAX_ATTEMPTS } from "@/lib/ai/embeddings";
import { openAiKey } from "@/lib/ai/keyVault";
import {
  getMonthUsage, getCapUsd, reserveWithinCap, settleUsage, releaseUsage, type UsageReservation,
} from "@/lib/ai/usageServer";
import { worstCaseCostUsd } from "@/lib/ai/pricing";
import { GovernedCallError } from "@/lib/ai/gateError";
import {
  embedLibrarySlice, setEmbedBuildMarker, patchEmbedBuildMarker, parseEmbedBuildMarker,
  loadEmbedDetail, unembeddedCount, embedAgreementSigned, readEmbedBuildMarker, expectationOf,
  type EmbedBuildMarker,
} from "@/lib/knowledgeEmbedCore";

/** Per-slice loop budget / in-flight hard stop, relative to slice start. */
const SLICE_BUDGET_MS = 45_000;
const SLICE_HARD_STOP_MS = 55_000;
/** Paced batch once a free-tier TPM limit shows itself: ~20 chunks ≈ 8K
 *  tokens, sized to fit Voyage's no-card 10K tokens/minute window. */
const PACED_BATCH = 20;
const FULL_BATCH = 64;
/** A library whose runs keep failing is released after this many in a row —
 *  its stamp says why, and a controller can start it again. */
export const MAX_ERROR_RUNS = 5;
/** How long a hold that a person can clear at any moment (sign the
 *  agreement, set the model back) lasts before the drain looks again —
 *  cheap to re-check, so short. A read error lands here too, never a release. */
const RECHECK_HOLD_MS = 3_600_000;
const MARKER_PAGE = 500;
const MAX_MARKERS = 5_000;

export type DrainOutcome =
  | "advanced"   // embedded passages this run, more remain
  | "complete"   // reached 100%; the stamp cleared
  | "current"    // standing consent, nothing new to embed
  | "blocked"    // holding off (cap / error backoff / model conflict / agreement) — see note
  | "released"   // stamp removed (invalid consent, no key, repeated failure) — see note
  | "busy"       // every remaining passage is claimed by another driver right now
  | "retrying"   // what remains was refused by the provider and waits to be offered again
  | "recent"     // drained moments ago (a user-triggered run skips it)
  | "starved";   // the run's budget ended before this library was reached

export interface DrainedLibrary {
  libraryId: string;
  embedded: number;
  remaining: number;
  outcome: DrainOutcome;
  note?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The first instant of next month (UTC) — when a monthly cap resets. */
export function nextMonthStartIso(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

/** What a run says when the passages left were refused by the provider. */
function refusedNote(waiting: number, leased: number): string {
  return `${waiting} passage${waiting === 1 ? " was" : "s were"} refused by the embeddings provider and wait${waiting === 1 ? "s" : ""} to be tried again by the next run`
    + (leased > 0 ? ` (${leased} more ${leased === 1 ? "is" : "are"} being embedded by another run)` : "")
    + ` — after ${EMBED_MAX_ATTEMPTS} refusals a passage is skipped and listed as failed`;
}

/** Backoff after the n-th consecutive failed run: 15 min, 30, 60 … capped at a day. */
export function errorBackoffMs(errorRuns: number): number {
  return Math.min(24 * 3_600_000, 15 * 60_000 * 2 ** Math.max(0, errorRuns - 1));
}

type MarkedLibrary = { id: string; org_id: string; marker: ReturnType<typeof parseEmbedBuildMarker> & object };

/** Least recently drained first; never looked at before comes first. */
export function orderDrainQueue<T extends { id: string; marker: { lastDrainAt?: string } }>(libs: T[]): T[] {
  return [...libs].sort((a, b) =>
    (a.marker.lastDrainAt ?? "").localeCompare(b.marker.lastDrainAt ?? "") || a.id.localeCompare(b.id));
}

/** Advance every consented, unfinished meaning-index build that fits in
 *  `budgetMs`. `scopeOrgIds` null = all orgs (platform cron); an array
 *  restricts to a user's own workspaces (page-load nudge), and then
 *  `minIntervalMs` skips libraries drained that recently, so a burst of
 *  nudges costs one drain, not ten. Never throws. */
export async function drainEmbedBacklog(opts: {
  scopeOrgIds: string[] | null;
  budgetMs: number;
  minIntervalMs?: number;
}): Promise<{ drained: DrainedLibrary[]; ranMs: number }> {
  const startedAt = Date.now();
  const { scopeOrgIds, budgetMs } = opts;
  const minIntervalMs = opts.minIntervalMs ?? 0;
  const drained: DrainedLibrary[] = [];
  try {
    // ── every marked library, paged ──────────────────────────────────────────
    const marked: MarkedLibrary[] = [];
    for (let from = 0; from < MAX_MARKERS; from += MARKER_PAGE) {
      let q = supabaseAdmin
        .from("knowledge_libraries")
        .select("id, org_id, ai_features")
        .not("ai_features->embedBuild", "is", null)
        .order("id", { ascending: true })
        .range(from, from + MARKER_PAGE - 1);
      if (scopeOrgIds) q = q.in("org_id", scopeOrgIds);
      const { data: libs, error: libErr } = await q;
      if (libErr) {
        return { drained: [{ libraryId: "-", embedded: 0, remaining: -1, outcome: "blocked", note: libErr.message }], ranMs: Date.now() - startedAt };
      }
      for (const l of (libs ?? []) as Array<{ id: string; org_id: string; ai_features: Record<string, unknown> | null }>) {
        const marker = parseEmbedBuildMarker(l.ai_features?.embedBuild);
        if (marker) marked.push({ id: l.id, org_id: l.org_id, marker });
      }
      if ((libs ?? []).length < MARKER_PAGE) break;
    }

    const now = Date.now();
    const queue = orderDrainQueue(marked);
    for (let i = 0; i < queue.length; i++) {
      const lib = queue[i];
      const m = lib.marker;
      // Every write below applies only to the stamp this run read.
      const expect = expectationOf(m);
      const record = (d: Omit<DrainedLibrary, "libraryId">) => drained.push({ libraryId: lib.id, ...d });

      // A hold with a date: cap, backoff, conflict, agreement.
      if (m.blockedUntil && Date.parse(m.blockedUntil) > now) {
        record({ embedded: 0, remaining: -1, outcome: "blocked", note: `${m.blockedReason ?? "held"} until ${m.blockedUntil}${m.lastError ? ` — ${m.lastError}` : ""}` });
        continue;
      }
      if (Date.now() - startedAt > budgetMs - 20_000) {
        for (const rest of queue.slice(i)) {
          if (!(rest.marker.blockedUntil && Date.parse(rest.marker.blockedUntil) > now)) {
            drained.push({ libraryId: rest.id, embedded: 0, remaining: -1, outcome: "starved", note: "the run's budget ended first — next run starts here" });
          }
        }
        break;
      }
      if (minIntervalMs > 0 && m.lastDrainAt && now - Date.parse(m.lastDrainAt) < minIntervalMs) {
        record({ embedded: 0, remaining: -1, outcome: "recent" });
        continue;
      }

      // GOV-14 limb: spend only on a consent that names an active member.
      const userId = m.userId;
      let consentOk = m.valid && UUID_RE.test(userId);
      if (consentOk) {
        const { data: member, error: memberErr } = await supabaseAdmin.from("org_members").select("uid")
          .eq("org_id", lib.org_id).eq("uid", userId).eq("status", "active").maybeSingle();
        if (memberErr) {
          // Could not tell: spend nothing, and never release a consent on a
          // failed read — the next run asks again.
          record({ embedded: 0, remaining: -1, outcome: "blocked", note: `couldn't verify the build's consent: ${memberErr.message}` });
          continue;
        }
        consentOk = !!member;
      }
      if (!consentOk) {
        await setEmbedBuildMarker(lib.id, null, { expect });
        record({ embedded: 0, remaining: -1, outcome: "released", note: "the build's consent names no active member of this workspace — stamp released" });
        continue;
      }

      // Claim the rotation slot before spending anything.
      await patchEmbedBuildMarker(lib.id, { lastDrainAt: new Date().toISOString() }, expect);

      const detail = await loadEmbedDetail(lib.org_id, lib.id);
      const remainingBefore = detail ? detail.remaining : await unembeddedCount(lib.org_id, lib.id);
      if (remainingBefore === null) {
        // Unknown is not 0: spend nothing, keep the stamp, look again next run.
        record({ embedded: 0, remaining: -1, outcome: "blocked", note: "couldn't read the library's coverage — nothing spent, the stamp stays" });
        continue;
      }
      if (remainingBefore === 0) {
        if (m.standing) {
          await patchEmbedBuildMarker(lib.id, { completedAt: m.completedAt ?? new Date().toISOString() }, expect);
          record({ embedded: 0, remaining: 0, outcome: "current" });
        } else {
          await setEmbedBuildMarker(lib.id, null, { expect });
          record({ embedded: 0, remaining: 0, outcome: "complete" });
        }
        continue;
      }
      if (detail && detail.leased + detail.waiting >= detail.remaining) {
        // Nothing is claimable. A passage the provider refused gave its lease
        // back and waits (SEM-4): that is not another run embedding it.
        if (detail.waiting > 0) {
          record({ embedded: 0, remaining: remainingBefore, outcome: "retrying", note: refusedNote(detail.waiting, detail.leased) });
        } else {
          record({ embedded: 0, remaining: remainingBefore, outcome: "busy", note: "every remaining passage is being embedded by another run" });
        }
        continue;
      }

      // The consenting user's own embedding connection — no key, no drain.
      const { data: conn } = await supabaseAdmin
        .from("ai_connections")
        .select("provider, api_key, embedding_provider, embedding_model, embedding_api_key")
        .eq("org_id", lib.org_id).eq("user_id", userId).maybeSingle();
      const connection = embeddingConnectionFrom(conn && {
        ...conn,
        api_key: openAiKey(conn.api_key),
        embedding_api_key: openAiKey(conn.embedding_api_key),
      });
      if (!connection) {
        await setEmbedBuildMarker(lib.id, null, { expect });
        record({ embedded: 0, remaining: remainingBefore, outcome: "released", note: "no embedding key — stamp cleared" });
        continue;
      }

      const hold = async (reason: NonNullable<EmbedBuildMarker["blockedReason"]>, until: string, note: string, embeddedSoFar = 0) => {
        await patchEmbedBuildMarker(lib.id, { blockedReason: reason, blockedUntil: until, lastError: note }, expect);
        record({ embedded: embeddedSoFar, remaining: remainingBefore, outcome: "blocked", note: `${note} — next look ${until}` });
      };

      // The acceptable-use agreement (local gate until the shared one lands).
      if ((await embedAgreementSigned(lib.org_id, userId)) === false) {
        await hold("agreement", new Date(now + RECHECK_HOLD_MS).toISOString(),
          "the member whose key pays has not accepted the current AI acceptable-use agreement");
        continue;
      }
      // One vector space per library (SEM-1 / SEM-3).
      const conflict = detail ? buildModelConflict(detail.corpus, connection) : null;
      if (conflict) {
        await hold("model_conflict", new Date(now + RECHECK_HOLD_MS).toISOString(), conflict.message);
        continue;
      }
      // Respect the consenting user's monthly cap — until it resets.
      const [month, capUsd] = await Promise.all([
        getMonthUsage(lib.org_id, userId), getCapUsd(lib.org_id, userId),
      ]);
      if (capUsd > 0 && month.spentUsd >= capUsd) {
        await hold("cap", nextMonthStartIso(now), "monthly cap reached");
        continue;
      }

      // GOV-5 / GOV-13: each claimed batch's worst case is reserved against
      // the payer's cap before it is sent; the run folds every batch's tokens
      // into ONE knowledgeEmbed row (the first reservation), settled after
      // every batch.
      let capRefusal: unknown = null;
      let meterRow: UsageReservation | null = null;
      let pending: UsageReservation | null = null;
      /** Input tokens of this library's slices already returned this run. */
      let tokensBefore = 0;
      const meterTo = async (inputTokens: number, ok: boolean) => {
        if (pending) {
          if (!meterRow) meterRow = pending; else await releaseUsage(pending.id);
          pending = null;
        }
        if (meterRow) await settleUsage(meterRow.id, { model: connection.model, usage: { inputTokens, outputTokens: 0 }, ok });
      };
      const beforeEmbed = async (inputChars: number): Promise<string | null> => {
        try {
          pending = await reserveWithinCap({
            orgId: lib.org_id, userId, op: "knowledgeEmbed", provider: connection.provider, model: connection.model,
            worstCaseUsd: worstCaseCostUsd(connection.model, { inputChars, maxTokens: 0 }), capUsd,
          });
          return null;
        } catch (e) {
          capRefusal = e;
          return e instanceof GovernedCallError ? e.message : `couldn't reserve the next batch: ${(e as Error)?.message ?? "unknown error"}`;
        }
      };
      const afterBatch = (sliceUsage: { inputTokens: number }) => meterTo(tokensBefore + sliceUsage.inputTokens, true);

      // The consent is re-read before every batch: withdrawn or replaced
      // (Stop, another member's Rebuild) or unreadable, nothing more is spent.
      let consentLost = null as "withdrawn" | "unverified" | null;
      const beforeBatch = async (): Promise<string | null> => {
        const { marker: cur, error } = await readEmbedBuildMarker(lib.id);
        if (error) { consentLost = "unverified"; return `couldn't re-read the build's consent: ${error}`; }
        if (!cur || cur.userId !== userId) { consentLost = "withdrawn"; return "the build's consent was withdrawn or replaced during this run"; }
        return null;
      };

      // Slice until this library is done, rate-limits us out of the window,
      // or the budget says stop. 429s wait out the provider's minute.
      let embedded = 0;
      let paced = false;
      let sliceError: string | null = null;
      let stopReason: string | null = null;
      const usage = { inputTokens: 0, outputTokens: 0 };
      for (;;) {
        const left = budgetMs - (Date.now() - startedAt);
        if (left < 20_000) break;
        const slice = await embedLibrarySlice({
          orgId: lib.org_id, libraryId: lib.id, connection,
          batchSize: paced ? PACED_BATCH : FULL_BATCH,
          budgetMs: Math.min(SLICE_BUDGET_MS, left - 15_000),
          hardStopMs: Math.min(SLICE_HARD_STOP_MS, left - 10_000),
          beforeBatch, beforeEmbed, afterBatch,
        });
        embedded += slice.embedded;
        usage.inputTokens += slice.usage.inputTokens;
        tokensBefore = usage.inputTokens;
        if (slice.stopReason) { stopReason = slice.stopReason; break; }
        if (slice.error) { sliceError = slice.error; break; }
        if (slice.rateLimited) {
          paced = true;
          if (budgetMs - (Date.now() - startedAt) < 85_000) break; // no room to wait out the window
          await new Promise((r) => setTimeout(r, 65_000));
          continue;
        }
        if (slice.fetchedNone || (slice.embedded === 0 && slice.refused === 0)) break;
      }

      // The run's ONE row, settled to its tokens with the run's outcome; a
      // run that spent nothing leaves no row (as before).
      await meterTo(usage.inputTokens, !sliceError);
      const ranRow = meterRow as UsageReservation | null;
      if (ranRow && usage.inputTokens <= 0) await releaseUsage(ranRow.id);

      // GOV-5 done-when 3: the next batch did not fit the payer's cap — the
      // library is held with the reason, its passages left queued.
      if (capRefusal) {
        const e = capRefusal;
        if (e instanceof GovernedCallError && e.status !== 503) {
          await hold("cap", nextMonthStartIso(Date.now()), `monthly cap reached — ${e.message}`, embedded);
        } else {
          await hold("error", new Date(Date.now() + RECHECK_HOLD_MS).toISOString(),
            `the payer's AI usage could not be read, so nothing more was sent: ${(e as Error)?.message ?? "unknown error"}`, embedded);
        }
        continue;
      }

      if (stopReason) {
        // Someone else's decision now governs the stamp: touch nothing.
        record({
          embedded, remaining: -1, outcome: consentLost === "withdrawn" ? "released" : "blocked",
          note: `${stopReason} — stopped; nothing more is spent on it`,
        });
        continue;
      }
      if (sliceError) {
        const runs = (m.errorRuns ?? 0) + 1;
        if (runs >= MAX_ERROR_RUNS) {
          await setEmbedBuildMarker(lib.id, null, { expect });
          record({ embedded, remaining: -1, outcome: "released", note: `released after ${runs} failed runs: ${sliceError}` });
        } else {
          const until = new Date(Date.now() + errorBackoffMs(runs)).toISOString();
          await patchEmbedBuildMarker(lib.id, { blockedReason: "error", blockedUntil: until, lastError: sliceError, errorRuns: runs }, expect);
          record({ embedded, remaining: -1, outcome: "blocked", note: `${sliceError} — retry after ${until}` });
        }
        continue;
      }
      if ((m.errorRuns ?? 0) > 0 || m.blockedReason) {
        await patchEmbedBuildMarker(lib.id, { errorRuns: undefined, blockedReason: undefined, blockedUntil: undefined, lastError: undefined }, expect);
      }

      // A second model appeared while this run worked (the claim then hands
      // out nothing): hold it here rather than report an idle "advanced".
      const detailAfter = await loadEmbedDetail(lib.org_id, lib.id);
      const conflictAfter = detailAfter ? buildModelConflict(detailAfter.corpus, connection) : null;
      if (conflictAfter) {
        await hold("model_conflict", new Date(Date.now() + RECHECK_HOLD_MS).toISOString(), conflictAfter.message, embedded);
        continue;
      }
      const remainingAfter = detailAfter ? detailAfter.remaining : await unembeddedCount(lib.org_id, lib.id);
      if (remainingAfter === null) {
        record({ embedded, remaining: -1, outcome: "blocked", note: "couldn't read the library's coverage after the run — the stamp stays" });
      } else if (remainingAfter === 0) {
        if (m.standing) {
          await patchEmbedBuildMarker(lib.id, { completedAt: new Date().toISOString() }, expect);
          record({ embedded, remaining: 0, outcome: "current" });
        } else {
          await setEmbedBuildMarker(lib.id, null, { expect });
          record({ embedded, remaining: 0, outcome: "complete" });
        }
      } else if (detailAfter && detailAfter.waiting > 0 && detailAfter.leased + detailAfter.waiting >= detailAfter.remaining) {
        record({ embedded, remaining: remainingAfter, outcome: embedded > 0 ? "advanced" : "retrying", note: refusedNote(detailAfter.waiting, detailAfter.leased) });
      } else {
        record({ embedded, remaining: remainingAfter, outcome: "advanced" });
      }
    }
  } catch (e) {
    drained.push({ libraryId: "-", embedded: 0, remaining: -1, outcome: "blocked", note: (e as Error).message });
  }
  return { drained, ranMs: Date.now() - startedAt };
}
