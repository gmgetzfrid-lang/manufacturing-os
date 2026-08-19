// Background continuation of meaning-index builds — the drain loop shared by
// the /api/knowledge/embed nudge target and the daily maintenance cron.
//
// CONSENT MODEL: this never decides to spend anyone's key. Starting a build
// in the UI stamps the library with WHO started it (ai_features.embedBuild.
// userId); the drain only continues libraries carrying that stamp, on that
// user's own embedding key, metered to them like every other call. The stamp
// clears when the library reaches 100% (or when the key disappears).
//
// SCHEDULING NOTE — read before touching vercel.json: this used to have its
// own hourly cron. Hourly (and any third) cron entries FAIL EVERY VERCEL
// DEPLOYMENT on this plan — deployments silently stopped for a full day, the
// second time that exact mistake was made (see "Revert hourly cron" in the
// log). The drain therefore rides the existing daily maintenance cron plus
// the page-load nudge; lib/__tests__/vercelConfig.test.ts enforces the limit.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { embeddingConnectionFrom } from "@/lib/ai/embeddings";
import { openAiKey } from "@/lib/ai/keyVault";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import {
  embedLibrarySlice, setEmbedBuildMarker, unembeddedCount,
} from "@/lib/knowledgeEmbedCore";

/** Per-slice loop budget / in-flight hard stop, relative to slice start. */
const SLICE_BUDGET_MS = 45_000;
const SLICE_HARD_STOP_MS = 55_000;
/** Paced batch once a free-tier TPM limit shows itself: ~20 chunks ≈ 8K
 *  tokens, sized to fit Voyage's no-card 10K tokens/minute window. */
const PACED_BATCH = 20;
const FULL_BATCH = 64;

export interface DrainedLibrary {
  libraryId: string;
  embedded: number;
  remaining: number;
  note?: string;
}

/** Advance every consented, unfinished meaning-index build that fits in
 *  `budgetMs`. `scopeOrgIds` null = all orgs (platform cron); an array
 *  restricts to a user's own workspaces (page-load nudge). Never throws. */
export async function drainEmbedBacklog(opts: {
  scopeOrgIds: string[] | null;
  budgetMs: number;
}): Promise<{ drained: DrainedLibrary[]; ranMs: number }> {
  const startedAt = Date.now();
  const { scopeOrgIds, budgetMs } = opts;
  const drained: DrainedLibrary[] = [];
  try {
    let q = supabaseAdmin
      .from("knowledge_libraries")
      .select("id, org_id, ai_features")
      .not("ai_features->embedBuild", "is", null)
      .limit(6);
    if (scopeOrgIds) q = q.in("org_id", scopeOrgIds);
    const { data: libs, error: libErr } = await q;
    if (libErr) return { drained: [{ libraryId: "-", embedded: 0, remaining: -1, note: libErr.message }], ranMs: Date.now() - startedAt };

    for (const lib of (libs ?? []) as Array<{ id: string; org_id: string; ai_features: Record<string, unknown> }>) {
      if (Date.now() - startedAt > budgetMs) break;
      const marker = (lib.ai_features?.embedBuild ?? null) as { userId?: string } | null;
      const userId = marker?.userId;
      if (!userId) continue;

      const remainingBefore = await unembeddedCount(lib.org_id, lib.id);
      if (remainingBefore === 0) {
        await setEmbedBuildMarker(lib.id, null);
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
        drained.push({ libraryId: lib.id, embedded: 0, remaining: remainingBefore, note: "no embedding key — stamp cleared" });
        continue;
      }

      // Respect the consenting user's monthly cap.
      const [month, capUsd] = await Promise.all([
        getMonthUsage(lib.org_id, userId), getCapUsd(lib.org_id, userId),
      ]);
      if (capUsd > 0 && month.spentUsd >= capUsd) {
        drained.push({ libraryId: lib.id, embedded: 0, remaining: remainingBefore, note: "monthly cap reached" });
        continue;
      }

      // Slice until this library is done, rate-limits us out of the window,
      // or the budget says stop. 429s wait out the provider's minute.
      let embedded = 0;
      let paced = false;
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
        if (slice.error) { drained.push({ libraryId: lib.id, embedded, remaining: -1, note: slice.error }); break; }
        if (slice.rateLimited) {
          paced = true;
          if (budgetMs - (Date.now() - startedAt) < 85_000) break; // no room to wait out the window
          await new Promise((r) => setTimeout(r, 65_000));
          continue;
        }
        if (slice.fetchedNone || slice.embedded === 0) break;
      }

      if (usage.inputTokens > 0) {
        await recordAskUsage({
          orgId: lib.org_id, userId, provider: connection.provider, model: connection.model,
          usage, ok: true, op: "knowledgeEmbed",
        });
      }
      const remainingAfter = await unembeddedCount(lib.org_id, lib.id);
      if (remainingAfter === 0) await setEmbedBuildMarker(lib.id, null);
      if (!drained.some((d) => d.libraryId === lib.id)) {
        drained.push({ libraryId: lib.id, embedded, remaining: remainingAfter });
      }
    }
  } catch (e) {
    drained.push({ libraryId: "-", embedded: 0, remaining: -1, note: (e as Error).message });
  }
  return { drained, ranMs: Date.now() - startedAt };
}
