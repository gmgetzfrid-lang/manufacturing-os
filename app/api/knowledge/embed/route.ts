// /api/knowledge/embed — building the meaning index, a batch at a time.
//
// POST { orgId, libraryId }        → embed the next batch, report what's left
// POST { orgId, libraryId, action:"status" } → coverage only, spends nothing
// POST { orgId, libraryId, action:"reset" }  → clear vectors so the next
//        build re-embeds everything under current chunking and model
//
// RESUMABLE BY DESIGN. Free-tier serverless kills a request at 60 seconds, so
// this never tries to finish: it embeds what it can inside a budget, commits,
// and reports `remaining`. The caller loops. A pass that dies halfway has
// still permanently embedded every batch it committed — the one property that
// makes a long job survivable on infrastructure that can stop it at any time.
//
// Costs the user's own money on their own key, metered like every other call.
// Uses the EMBEDDING key, which is separate from the chat key — a Claude user
// keeps Claude for answers and adds a Voyage key for this.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal } from "@/lib/knowledgeAccess";
import { estimateCostUsd } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import {
  embeddingConnectionFrom, EMBED_BATCH, NO_EMBEDDING_KEY_MESSAGE,
} from "@/lib/ai/embeddings";
import { openAiKey } from "@/lib/ai/keyVault";
import { embedLibrarySlice, setEmbedBuildMarker, isBusyDbError } from "@/lib/knowledgeEmbedCore";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Stop well short of the platform's kill so the last batch commits and the
 *  response is a real answer rather than a 504 the client has to guess at. */
const BUDGET_MS = 30_000;
/** Absolute ceiling for the in-flight embed call: whatever is running gets
 *  aborted by this point (elapsed ms), leaving time to commit, count and
 *  respond inside maxDuration=60. */
const EMBED_HARD_STOP_MS = 38_000;
/** Everything — setup, embedding, writes, the closing count — is measured
 *  from the moment the request arrived, and answered by this point. The
 *  platform cuts a request at 60s, and a cut request is the "504" in the
 *  console. */
const RESPOND_BY_MS = 52_000;
/** A progress count gets this long. While a build rewrites every passage the
 *  table is busy and an exact count can crawl; past this we answer with the
 *  last known numbers instead of letting the platform kill the request. */
const COUNT_BUDGET_MS = 7_000;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

type Coverage = { total: number; embedded: number };

/** "missing" = the migration isn't applied (a setup state); "busy" = the
 *  database didn't answer in time (weather — say nothing alarming). */
async function coverage(orgId: string, libraryId: string, budgetMs = COUNT_BUDGET_MS): Promise<Coverage | "missing" | "busy"> {
  try {
    const { data, error } = await supabaseAdmin
      .rpc("semantic_coverage", { p_org_id: orgId, p_library_id: libraryId })
      .abortSignal(AbortSignal.timeout(budgetMs));
    if (error) {
      return error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(error.message)
        ? "missing" : "busy";
    }
    const row = (data as Array<{ total: number; embedded: number }> | null)?.[0];
    return { total: Number(row?.total ?? 0), embedded: Number(row?.embedded ?? 0) };
  } catch {
    return "busy";
  }
}

const MIGRATION_MESSAGE = "Semantic search needs migration 20260930 - run it in Supabase, then try again.";

export async function POST(req: NextRequest) {
  const arrived = Date.now();
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !user) return bad("Unauthorized", 401);

  let body: { orgId?: string; libraryId?: string; action?: string; batch?: number; known?: { total?: number; covered?: number } };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  // Free-tier providers cap tokens-per-minute hard (Voyage without a card:
  // 10K TPM) — a full 96-passage batch can never fit. The client shrinks the
  // batch when it sees rateLimited and paces itself; we just honor the size.
  const batchSize = Math.max(1, Math.min(Number(body.batch) || EMBED_BATCH, EMBED_BATCH));
  const orgId = String(body.orgId ?? "").trim();
  const libraryId = String(body.libraryId ?? "").trim();
  if (!orgId || !libraryId) return bad("orgId and libraryId are required");

  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not a member of this workspace", 403);

  // The caller's last known numbers: what we answer with when the database
  // is too busy to count, instead of an error or a misleading zero.
  const known: Coverage | null = Number.isFinite(body.known?.total) && Number.isFinite(body.known?.covered)
    ? { total: Number(body.known!.total), embedded: Number(body.known!.covered) } : null;

  if (body.action === "status") {
    const stats = await coverage(orgId, libraryId);
    if (stats === "missing") return bad(MIGRATION_MESSAGE, 424);
    if (stats === "busy") {
      return NextResponse.json({
        embedded: 0, total: known?.total ?? 0, coveredNow: known?.embedded ?? 0,
        remaining: known ? known.total - known.embedded : 0,
        done: false, error: null, spentThisRun: 0, busy: true, countUnavailable: !known,
      });
    }
    // Mirror the SemanticProgress shape the build path returns EXACTLY.
    return NextResponse.json({
      embedded: 0,                       // passages embedded by THIS call: none, it's a read
      total: stats.total,
      coveredNow: stats.embedded,
      remaining: stats.total - stats.embedded,
      done: stats.total - stats.embedded === 0,
      error: null,
      spentThisRun: 0,
    });
  }

  if (!principal.isController) {
    return bad("Only Admin or Doc Control can build the meaning index.", 403);
  }

  // Clear every vector so the next build re-embeds from scratch.
  //
  // This is not a convenience. Vectors are only as good as the chunking and
  // the model that produced them, and BOTH change: chunk boundaries move
  // when ingestion improves, and an embedding model gets swapped for a
  // better one. Without a reset those upgrades reach only documents added
  // afterwards, so a library ends up half-indexed under two different
  // regimes with nothing on screen saying so — the retrieval quietly gets
  // worse and no button exists to fix it. The build path only ever fills
  // rows where embedding IS NULL, which is exactly why emptying them is the
  // whole of a rebuild.
  if (body.action === "reset") {
    const { error } = await supabaseAdmin
      .from("knowledge_chunks")
      .update({ embedding: null, embedding_model: null })
      .eq("org_id", orgId)
      .eq("library_id", libraryId)
      .not("embedding", "is", null);
    if (error) {
      return bad(isBusyDbError(error.message)
        ? "The database is busy right now (the index is still being written). Nothing was cleared - try the rebuild again in a few minutes."
        : `Couldn't clear the existing vectors: ${error.message}`, isBusyDbError(error.message) ? 503 : 500);
    }
    const after = await coverage(orgId, libraryId);
    const a = typeof after === "object" ? after : null;
    return NextResponse.json({
      embedded: 0,
      total: a?.total ?? known?.total ?? 0,
      coveredNow: a?.embedded ?? 0,
      remaining: (a?.total ?? known?.total ?? 0) - (a?.embedded ?? 0),
      done: false,
      error: null,
      spentThisRun: 0,
    });
  }

  const { data: conn } = await supabaseAdmin
    .from("ai_connections")
    .select("provider, api_key, embedding_provider, embedding_model, embedding_api_key")
    .eq("org_id", orgId).eq("user_id", user.id).maybeSingle();
  const embedding = embeddingConnectionFrom(conn && {
    ...conn,
    api_key: openAiKey(conn.api_key),
    embedding_api_key: openAiKey(conn.embedding_api_key),
  });
  if (!embedding) return bad(NO_EMBEDDING_KEY_MESSAGE, 412);

  const [monthSoFar, capUsd] = await Promise.all([
    getMonthUsage(orgId, user.id),
    getCapUsd(orgId, user.id),
  ]);
  if (capUsd > 0 && monthSoFar.spentUsd >= capUsd) {
    return bad(
      `Monthly AI budget reached - $${monthSoFar.spentUsd.toFixed(2)} of $${capUsd.toFixed(2)}. `
      + "It resets on the 1st; an Admin can raise the cap in AI settings.",
      402,
    );
  }

  // Consent marker for the background drain: starting a build records WHO
  // is paying, and the hourly cron continues THIS build with THIS key until
  // the library is done — the tab is optional from here on.
  await setEmbedBuildMarker(libraryId, user.id);

  // Starting numbers. The caller already knows them from its last call, so
  // only count when it doesn't — every count competes with the build itself.
  let stats: Coverage | null = known;
  if (!stats) {
    const c = await coverage(orgId, libraryId);
    if (c === "missing") return bad(MIGRATION_MESSAGE, 424);
    stats = c === "busy" ? null : c;
  }

  // Setup (sign-in, key, budget, marker) already used part of the clock on a
  // busy database; the slice gets what is left, not a fresh 30 seconds. If
  // setup alone ate most of it, answer "busy" now — the caller waits a
  // moment and calls again — rather than start work that can't finish.
  const spent = Date.now() - arrived;
  if (spent > 25_000) {
    return NextResponse.json({
      embedded: 0, total: stats?.total ?? 0, coveredNow: stats?.embedded ?? 0,
      remaining: stats ? stats.total - stats.embedded : 0,
      done: false, error: null, spentThisRun: 0, busy: true, estimated: true, countUnavailable: !stats,
    });
  }
  const slice = await embedLibrarySlice({
    orgId, libraryId,
    connection: embedding,
    batchSize,
    budgetMs: Math.max(5_000, BUDGET_MS - spent),
    hardStopMs: Math.max(10_000, EMBED_HARD_STOP_MS - spent),
    finishBy: arrived + RESPOND_BY_MS - 6_000,
  });
  const usage = slice.usage;
  const embedded = slice.embedded;
  const rateLimited = slice.rateLimited;
  let lastError = slice.error;
  if (slice.fetchedNone && stats && stats.total - stats.embedded > 0 && !known) {
    // Coverage says passages lack vectors, yet the fetch returned none —
    // the classic symptom of a stale PostgREST schema cache after the
    // embedding column was rebuilt. Say so; silence here reads as "done".
    // (Only on a fresh count: a remembered one can simply be out of date.)
    lastError =
      `${stats.total - stats.embedded} passages lack vectors but none could be fetched - ` +
      "the API schema cache is likely stale after a column rebuild. In the Supabase SQL " +
      "editor run:  NOTIFY pgrst, 'reload schema';  wait ~10 seconds, then build again.";
  }

  if (usage.inputTokens > 0) {
    await recordAskUsage({
      orgId, userId: user.id, provider: embedding.provider, model: embedding.model,
      usage, ok: !lastError, op: "knowledgeEmbed",
    });
  }

  // Finished = the slice looked for a passage without a vector and found
  // none. That's exact, and needs no count.
  const exhausted = slice.exhausted && !lastError;
  // The closing count only if it fits; otherwise last known + this call.
  const countRoom = arrived + RESPOND_BY_MS - Date.now() - 2_000;
  const counted = countRoom >= 2_000 ? await coverage(orgId, libraryId, Math.min(COUNT_BUDGET_MS, countRoom)) : "busy" as const;
  const after: Coverage | null = typeof counted === "object" ? counted
    // Too busy to count: last known + what this call wrote. Shown as is;
    // the next successful count corrects it.
    : stats ? { total: stats.total, embedded: Math.min(stats.total, stats.embedded + embedded) } : null;
  const exact = typeof counted === "object";
  // Wrote vectors but an exact count didn't move: the writes are vanishing —
  // that's a bug worth naming, never a success.
  if (exact && stats && !known && embedded > 0 && after!.embedded < stats.embedded + embedded && !lastError) {
    lastError =
      `Wrote ${embedded} vector(s) but the library's count only shows ${after!.embedded} - ` +
      "writes are not landing. Tell your admin: verify library_id/org_id on knowledge_chunks.";
  }
  const remaining = exhausted ? 0 : after ? Math.max(0, after.total - after.embedded) : 0;
  const done = (exhausted || (exact && remaining === 0)) && !lastError && !rateLimited;
  // Build finished: withdraw the background-continuation consent marker so
  // the cron stops looking at this library until someone starts a new build.
  if (done) await setEmbedBuildMarker(libraryId, null);
  return NextResponse.json({
    embedded,
    total: after?.total ?? 0,
    coveredNow: exhausted && after ? after.total : after?.embedded ?? 0,
    remaining,
    done,
    error: lastError,
    rateLimited,
    // The database was too busy to take more this round — the caller waits
    // a moment and continues. Nothing written is lost.
    busy: slice.busy,
    /** Numbers are last-known + this call's writes (the count was too slow). */
    estimated: !exact,
    countUnavailable: !after,
    // Free tiers meter per minute; a hair over one minute guarantees a
    // fresh window even with clock skew.
    retryAfterMs: rateLimited ? 65_000 : undefined,
    spentThisRun: estimateCostUsd(embedding.model, usage),
    provider: embedding.provider,
    model: embedding.model,
  });
}
