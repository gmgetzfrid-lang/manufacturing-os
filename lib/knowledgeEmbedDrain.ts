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
// library's org, is released rather than spent on.
//
// NO LIBRARY STARVES ANOTHER (SEM-11). Every marked library is read (paged —
// no fixed window), and they are worked least-recently-drained first
// (lastDrainAt on the stamp). A library that cannot proceed records WHY and
// WHEN to look again instead of holding a slot: the monthly cap until the
// 1st, a provider / key error with a doubling backoff (released after
// MAX_ERROR_RUNS failed runs), a model conflict or an unsigned agreement for
// a day. Every run reports each library as advanced / complete / current /
// blocked / released / busy / recent / starved (never reached this run).
//
// SCHEDULING NOTE — read before touching vercel.json: this used to have its
// own hourly cron. Hourly (and any third) cron entries FAIL EVERY VERCEL
// DEPLOYMENT on this plan — deployments silently stopped for a full day, the
// second time that exact mistake was made (see "Revert hourly cron" in the
// log). The drain therefore rides the existing daily maintenance cron plus
// the page-load nudge; lib/__tests__/vercelConfig.test.ts enforces the limit.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { embeddingConnectionFrom, buildModelConflict } from "@/lib/ai/embeddings";
import { openAiKey } from "@/lib/ai/keyVault";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import {
  embedLibrarySlice, setEmbedBuildMarker, patchEmbedBuildMarker, parseEmbedBuildMarker,
  loadEmbedDetail, unembeddedCount, embedAgreementSigned, type EmbedBuildMarker,
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
const MARKER_PAGE = 500;
const MAX_MARKERS = 5_000;

export type DrainOutcome =
  | "advanced"   // embedded passages this run, more remain
  | "complete"   // reached 100%; the stamp cleared
  | "current"    // standing consent, nothing new to embed
  | "blocked"    // holding off (cap / error backoff / model conflict / agreement) — see note
  | "released"   // stamp removed (invalid consent, no key, repeated failure) — see note
  | "busy"       // every remaining passage is claimed by another driver right now
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
        const { data: member } = await supabaseAdmin.from("org_members").select("uid")
          .eq("org_id", lib.org_id).eq("uid", userId).eq("status", "active").maybeSingle();
        consentOk = !!member;
      }
      if (!consentOk) {
        await setEmbedBuildMarker(lib.id, null);
        record({ embedded: 0, remaining: -1, outcome: "released", note: "the build's consent names no active member of this workspace — stamp released" });
        continue;
      }

      // Claim the rotation slot before spending anything.
      await patchEmbedBuildMarker(lib.id, { lastDrainAt: new Date().toISOString() });

      const detail = await loadEmbedDetail(lib.org_id, lib.id);
      const remainingBefore = detail ? detail.remaining : await unembeddedCount(lib.org_id, lib.id);
      if (remainingBefore === 0) {
        if (m.standing) {
          await patchEmbedBuildMarker(lib.id, { completedAt: m.completedAt ?? new Date().toISOString() });
          record({ embedded: 0, remaining: 0, outcome: "current" });
        } else {
          await setEmbedBuildMarker(lib.id, null);
          record({ embedded: 0, remaining: 0, outcome: "complete" });
        }
        continue;
      }
      if (detail && detail.leased >= detail.remaining) {
        record({ embedded: 0, remaining: remainingBefore, outcome: "busy", note: "every remaining passage is being embedded by another run" });
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
        await setEmbedBuildMarker(lib.id, null);
        record({ embedded: 0, remaining: remainingBefore, outcome: "released", note: "no embedding key — stamp cleared" });
        continue;
      }

      const hold = async (reason: NonNullable<EmbedBuildMarker["blockedReason"]>, until: string, note: string) => {
        await patchEmbedBuildMarker(lib.id, { blockedReason: reason, blockedUntil: until, lastError: note });
        record({ embedded: 0, remaining: remainingBefore, outcome: "blocked", note: `${note} — next look ${until}` });
      };

      // The acceptable-use agreement (local gate until the shared one lands).
      if ((await embedAgreementSigned(lib.org_id, userId)) === false) {
        await hold("agreement", new Date(now + 24 * 3_600_000).toISOString(),
          "the member whose key pays has not accepted the current AI acceptable-use agreement");
        continue;
      }
      // One vector space per library (SEM-1 / SEM-3).
      const conflict = detail ? buildModelConflict(detail.corpus, connection) : null;
      if (conflict) {
        await hold("model_conflict", new Date(now + 24 * 3_600_000).toISOString(), conflict.message);
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

      // Slice until this library is done, rate-limits us out of the window,
      // or the budget says stop. 429s wait out the provider's minute.
      let embedded = 0;
      let paced = false;
      let sliceError: string | null = null;
      const usage = { inputTokens: 0, outputTokens: 0 };
      for (;;) {
        const left = budgetMs - (Date.now() - startedAt);
        if (left < 20_000) break;
        const slice = await embedLibrarySlice({
          orgId: lib.org_id, libraryId: lib.id, connection,
          batchSize: paced ? PACED_BATCH : FULL_BATCH,
          budgetMs: Math.min(SLICE_BUDGET_MS, left - 15_000),
          hardStopMs: Math.min(SLICE_HARD_STOP_MS, left - 10_000),
        });
        embedded += slice.embedded;
        usage.inputTokens += slice.usage.inputTokens;
        if (slice.error) { sliceError = slice.error; break; }
        if (slice.rateLimited) {
          paced = true;
          if (budgetMs - (Date.now() - startedAt) < 85_000) break; // no room to wait out the window
          await new Promise((r) => setTimeout(r, 65_000));
          continue;
        }
        if (slice.fetchedNone || (slice.embedded === 0 && slice.refused === 0)) break;
      }

      if (usage.inputTokens > 0) {
        await recordAskUsage({
          orgId: lib.org_id, userId, provider: connection.provider, model: connection.model,
          usage, ok: !sliceError, op: "knowledgeEmbed",
        });
      }

      if (sliceError) {
        const runs = (m.errorRuns ?? 0) + 1;
        if (runs >= MAX_ERROR_RUNS) {
          await setEmbedBuildMarker(lib.id, null);
          record({ embedded, remaining: -1, outcome: "released", note: `released after ${runs} failed runs: ${sliceError}` });
        } else {
          const until = new Date(Date.now() + errorBackoffMs(runs)).toISOString();
          await patchEmbedBuildMarker(lib.id, { blockedReason: "error", blockedUntil: until, lastError: sliceError, errorRuns: runs });
          record({ embedded, remaining: -1, outcome: "blocked", note: `${sliceError} — retry after ${until}` });
        }
        continue;
      }
      if ((m.errorRuns ?? 0) > 0 || m.blockedReason) {
        await patchEmbedBuildMarker(lib.id, { errorRuns: undefined, blockedReason: undefined, blockedUntil: undefined, lastError: undefined });
      }

      const remainingAfter = await unembeddedCount(lib.org_id, lib.id);
      if (remainingAfter === 0) {
        if (m.standing) {
          await patchEmbedBuildMarker(lib.id, { completedAt: new Date().toISOString() });
          record({ embedded, remaining: 0, outcome: "current" });
        } else {
          await setEmbedBuildMarker(lib.id, null);
          record({ embedded, remaining: 0, outcome: "complete" });
        }
      } else {
        record({ embedded, remaining: remainingAfter, outcome: "advanced" });
      }
    }
  } catch (e) {
    drained.push({ libraryId: "-", embedded: 0, remaining: -1, outcome: "blocked", note: (e as Error).message });
  }
  return { drained, ranMs: Date.now() - startedAt };
}
