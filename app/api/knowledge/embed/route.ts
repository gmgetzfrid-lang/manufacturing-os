// /api/knowledge/embed — building the meaning index, a batch at a time.
//
// POST { orgId, libraryId }        → embed the next batch, report what's left
// POST { orgId, libraryId, action:"status" } → coverage only, spends nothing
// POST { orgId, libraryId, action:"reset" }  → clear vectors so the next
//        build re-embeds everything under current chunking and model
// POST { orgId, libraryId, action:"retry-failed" } → give the passages the
//        provider refused another chance
// POST { orgId, libraryId, action:"keep-current", on } → the standing
//        consent: the background drain keeps this index current on YOUR key
// POST { orgId, libraryId, action:"release" } → stop the background build
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
//
// ONE VECTOR SPACE PER LIBRARY (SEM-1 / SEM-3). A build whose model differs
// from the vectors already in the library is refused before anything is
// spent — Rebuild (reset) is the way to switch, and the status says so.
// Nothing is ever re-used across models.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal } from "@/lib/knowledgeAccess";
import { estimateCostUsd, buildAgreementText, AGREEMENT_VERSION } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import {
  embeddingConnectionFrom, buildModelConflict, estimateEmbeddingCostUsd, embeddingRateIsPlaceholder,
  EMBED_BATCH, EMBED_MAX_ATTEMPTS, NO_EMBEDDING_KEY_MESSAGE, type EmbeddingConnection,
} from "@/lib/ai/embeddings";
import { openAiKey } from "@/lib/ai/keyVault";
import {
  embedLibrarySlice, setEmbedBuildMarker, patchEmbedBuildMarker, parseEmbedBuildMarker,
  loadEmbedDetail, failedPassageSamples, embedAgreementSigned, type EmbedDetail,
} from "@/lib/knowledgeEmbedCore";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Stop well short of the platform's kill so the last batch commits and the
 *  response is a real answer rather than a 504 the client has to guess at. */
const BUDGET_MS = 35_000;
/** Absolute ceiling for the in-flight embed call: whatever is running gets
 *  aborted by this point (elapsed ms), leaving time to commit and respond
 *  inside maxDuration=60. */
const EMBED_HARD_STOP_MS = 48_000;

function bad(msg: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: msg, ...(extra ?? {}) }, { status });
}

async function coverage(orgId: string, libraryId: string) {
  const { data, error } = await supabaseAdmin
    .rpc("semantic_coverage", { p_org_id: orgId, p_library_id: libraryId });
  if (error) return null;
  const row = (data as Array<{ total: number; embedded: number }> | null)?.[0];
  return { total: Number(row?.total ?? 0), embedded: Number(row?.embedded ?? 0) };
}

/** The caller's embedding connection, key decrypted (never returned). */
async function callerConnection(orgId: string, userId: string): Promise<EmbeddingConnection | null> {
  const { data: conn } = await supabaseAdmin
    .from("ai_connections")
    .select("provider, api_key, embedding_provider, embedding_model, embedding_api_key")
    .eq("org_id", orgId).eq("user_id", userId).maybeSingle();
  return embeddingConnectionFrom(conn && {
    ...conn,
    api_key: openAiKey(conn.api_key),
    embedding_api_key: openAiKey(conn.embedding_api_key),
  });
}

async function readMarker(libraryId: string) {
  const { data } = await supabaseAdmin.from("knowledge_libraries").select("ai_features").eq("id", libraryId).maybeSingle();
  return parseEmbedBuildMarker((data?.ai_features as Record<string, unknown> | null)?.embedBuild);
}

/** Everything the panel shows beyond the bar — shared by status and build. */
async function detailFields(orgId: string, libraryId: string, userId: string, detail: EmbedDetail | null, connection: EmbeddingConnection | null) {
  const marker = await readMarker(libraryId);
  const conflict = detail && connection ? buildModelConflict(detail.corpus, connection) : null;
  const passagesLeft = detail ? detail.remaining : 0;
  return {
    failed: detail?.failed ?? 0,
    failedSamples: detail && detail.failed > 0 ? await failedPassageSamples(orgId, libraryId) : [],
    busy: detail?.leased ?? 0,
    models: detail?.models ?? {},
    mixed: detail?.corpus.state === "mixed",
    connection: connection ? { provider: connection.provider, model: connection.model } : null,
    conflict: conflict?.message ?? null,
    // SEM-13: quoted from the same price table the ledger bills with, over
    // the library's real text, for the model this caller would build with.
    estimate: detail && connection ? {
      model: connection.model,
      remainingUsd: estimateEmbeddingCostUsd(connection.model, detail.remainingChars, passagesLeft),
      fullUsd: estimateEmbeddingCostUsd(connection.model, detail.totalChars, detail.total),
      placeholderRate: embeddingRateIsPlaceholder(connection.model),
    } : null,
    background: marker ? {
      mine: marker.userId === userId,
      standing: marker.standing === true,
      startedAt: marker.at || null,
      lastDrainAt: marker.lastDrainAt ?? null,
      blockedUntil: marker.blockedUntil ?? null,
      blockedReason: marker.blockedReason ?? null,
      lastError: marker.lastError ?? null,
    } : null,
  };
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !user) return bad("Unauthorized", 401);

  let body: { orgId?: string; libraryId?: string; action?: string; batch?: number; on?: boolean };
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

  // The library must be this org's — every write below is keyed by its id.
  const { data: lib } = await supabaseAdmin.from("knowledge_libraries").select("id")
    .eq("id", libraryId).eq("org_id", orgId).maybeSingle();
  if (!lib) return bad("Library not found", 404);

  const stats = await coverage(orgId, libraryId);
  if (!stats) {
    return bad(
      "Semantic search needs migration 20260930 — run it in Supabase, then try again.", 424,
    );
  }

  if (body.action === "status") {
    // Mirror the SemanticProgress shape the build path returns EXACTLY.
    // This response used to omit coveredNow — the one field the panel
    // renders — so the bar showed 0% forever regardless of the database.
    // Remaining counts what the queue will still embed; passages the
    // provider refused are reported separately (failed) and do not hold
    // the library below "done".
    const detail = await loadEmbedDetail(orgId, libraryId);
    const connection = await callerConnection(orgId, user.id);
    const remaining = detail ? detail.remaining : stats.total - stats.embedded;
    return NextResponse.json({
      embedded: 0,                       // passages embedded by THIS call: none, it's a read
      total: stats.total,
      coveredNow: stats.embedded,
      remaining,
      done: remaining === 0,
      error: null,
      spentThisRun: 0,
      ...(await detailFields(orgId, libraryId, user.id, detail, connection)),
    });
  }

  if (body.action === "release") {
    // The marker's owner may withdraw their consent; controllers may stop
    // any background build (SEM-11: a stuck build an admin can see and end).
    const marker = await readMarker(libraryId);
    if (!marker) return NextResponse.json({ released: false });
    if (!principal.isController && marker.userId !== user.id) {
      return bad("Only the member whose key pays, or Admin / Doc Control, can stop this background build.", 403);
    }
    const err = await setEmbedBuildMarker(libraryId, null);
    if (err) return bad(`Couldn't stop the background build: ${err}`, 500);
    return NextResponse.json({ released: true });
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
  // whole of a rebuild. Refusal counts and leases reset with the vectors.
  if (body.action === "reset") {
    let { error } = await supabaseAdmin
      .from("knowledge_chunks")
      .update({ embedding: null, embedding_model: null, embed_attempts: 0, embed_error: null, embed_claimed_until: null })
      .eq("org_id", orgId)
      .eq("library_id", libraryId);
    if (error && (error.code === "PGRST204" || error.code === "42703")) {
      // 20261121 not applied: the counters don't exist yet.
      ({ error } = await supabaseAdmin
        .from("knowledge_chunks")
        .update({ embedding: null, embedding_model: null })
        .eq("org_id", orgId)
        .eq("library_id", libraryId)
        .not("embedding", "is", null));
    }
    if (error) return bad(`Couldn't clear the existing vectors: ${error.message}`, 500);
    const after = await coverage(orgId, libraryId);
    return NextResponse.json({
      embedded: 0,
      total: after?.total ?? stats.total,
      coveredNow: after?.embedded ?? 0,
      remaining: (after?.total ?? stats.total) - (after?.embedded ?? 0),
      done: false,
      error: null,
      spentThisRun: 0,
    });
  }

  if (body.action === "retry-failed") {
    const { data, error } = await supabaseAdmin
      .from("knowledge_chunks")
      .update({ embed_attempts: 0, embed_error: null })
      .eq("org_id", orgId).eq("library_id", libraryId)
      .is("embedding", null)
      .gte("embed_attempts", EMBED_MAX_ATTEMPTS)
      .select("id");
    if (error) return bad(`Couldn't requeue the failed passages: ${error.message}`, 500);
    return NextResponse.json({ requeued: (data ?? []).length });
  }

  const embedding = await callerConnection(orgId, user.id);

  // The acceptable-use agreement (a local gate until the shared aiGates
  // helper lands): nothing is sent to a provider for someone who has not
  // accepted it. Pre-migration (no table) skips the gate, as the ask route does.
  const agreementGate = async () => {
    if ((await embedAgreementSigned(orgId, user.id)) !== false) return null;
    return bad("Before building the meaning index, read and accept the AI acceptable-use agreement.", 428, {
      agreementRequired: true,
      agreementText: buildAgreementText(embedding?.provider),
      agreementVersion: AGREEMENT_VERSION,
    });
  };

  if (body.action === "keep-current") {
    // SEM-8: the standing consent. On = the drain keeps this library's index
    // current as documents are added, on the CALLER's key and cap; off =
    // the stamp clears once nothing is left to embed.
    const on = body.on === true;
    if (on) {
      if (!embedding) return bad(NO_EMBEDDING_KEY_MESSAGE, 412);
      const gated = await agreementGate();
      if (gated) return gated;
      const err = await setEmbedBuildMarker(libraryId, user.id, { standing: true });
      if (err) return bad(`Couldn't record the standing consent: ${err}`, 500);
      return NextResponse.json({ standing: true });
    }
    const marker = await readMarker(libraryId);
    if (marker) {
      const detail = await loadEmbedDetail(orgId, libraryId);
      const left = detail ? detail.remaining : stats.total - stats.embedded;
      const err = left === 0
        ? await setEmbedBuildMarker(libraryId, null)
        : await patchEmbedBuildMarker(libraryId, { standing: undefined });
      if (err) return bad(`Couldn't withdraw the standing consent: ${err}`, 500);
    }
    return NextResponse.json({ standing: false });
  }

  if (!embedding) return bad(NO_EMBEDDING_KEY_MESSAGE, 412);
  {
    const gated = await agreementGate();
    if (gated) return gated;
  }

  const [monthSoFar, capUsd] = await Promise.all([
    getMonthUsage(orgId, user.id),
    getCapUsd(orgId, user.id),
  ]);
  if (capUsd > 0 && monthSoFar.spentUsd >= capUsd) {
    return bad(
      `Monthly AI budget reached — $${monthSoFar.spentUsd.toFixed(2)} of $${capUsd.toFixed(2)}. `
      + "It resets on the 1st; an Admin can raise the cap in AI settings.",
      402,
    );
  }

  // One vector space per library: never add a second model's vectors.
  const detailBefore = await loadEmbedDetail(orgId, libraryId);
  if (detailBefore) {
    const conflict = buildModelConflict(detailBefore.corpus, embedding);
    if (conflict) return bad(conflict.message, 409, { conflict: true, stamped: conflict.stamped, yours: conflict.yours });
  }

  // Consent marker for the background drain: starting a build records WHO
  // is paying, and the drain continues THIS build with THIS key until the
  // library is done — the tab is optional from here on.
  const markerError = await setEmbedBuildMarker(libraryId, user.id);

  const slice = await embedLibrarySlice({
    orgId, libraryId,
    connection: embedding,
    batchSize,
    budgetMs: BUDGET_MS,
    hardStopMs: EMBED_HARD_STOP_MS,
  });
  const usage = slice.usage;
  const embedded = slice.embedded;
  const rateLimited = slice.rateLimited;
  let lastError = slice.error;
  const detailAfter = await loadEmbedDetail(orgId, libraryId);
  const remainingBefore = detailBefore ? detailBefore.remaining : stats.total - stats.embedded;
  if (slice.fetchedNone && remainingBefore > 0 && !(detailBefore && detailBefore.leased >= detailBefore.remaining)) {
    // Coverage says passages lack vectors, yet the fetch returned none —
    // the classic symptom of a stale PostgREST schema cache after the
    // embedding column was rebuilt. Say so; silence here reads as "done".
    lastError =
      `${remainingBefore} passages lack vectors but none could be fetched — ` +
      "the API schema cache is likely stale after a column rebuild. In the Supabase SQL " +
      "editor run:  NOTIFY pgrst, 'reload schema';  wait ~10 seconds, then build again.";
  }


  if (usage.inputTokens > 0) {
    await recordAskUsage({
      orgId, userId: user.id, provider: embedding.provider, model: embedding.model,
      usage, ok: !lastError, op: "knowledgeEmbed",
    });
  }

  const after = await coverage(orgId, libraryId);
  // If the post-run count can't be read, DON'T claim done — an unverifiable
  // "complete" over a 0% bar is exactly the contradiction that burns trust.
  if (!after && !lastError) {
    lastError = "Couldn't verify the vector count after writing — re-check the panel; the build may still have succeeded.";
  }
  // Wrote vectors but the count didn't move: the writes are vanishing —
  // that's a bug worth naming, never a success. Only the pre-20261121 queue
  // needs the check: the claim's write-back confirms every row it changed,
  // so concurrent drivers (whose writes also move the count) never trip it.
  if (slice.queue === "legacy" && after && embedded > 0 && after.embedded < stats.embedded + embedded && !lastError) {
    lastError =
      `Wrote ${embedded} vector(s) but the library's count only shows ${after.embedded} — ` +
      "writes are not landing. Tell your admin: verify library_id/org_id on knowledge_chunks.";
  }
  const remaining = detailAfter ? detailAfter.remaining : (after ? after.total - after.embedded : 0);
  // Build finished: withdraw the background-continuation consent marker so
  // the cron stops looking at this library until someone starts a new build
  // — unless the consent is standing (keep the index current), which stays.
  if (remaining === 0 && !lastError) {
    const marker = await readMarker(libraryId);
    if (marker?.standing) await patchEmbedBuildMarker(libraryId, { completedAt: new Date().toISOString() });
    else await setEmbedBuildMarker(libraryId, null);
  }
  return NextResponse.json({
    embedded,
    total: after?.total ?? stats.total,
    coveredNow: after?.embedded ?? stats.embedded,
    remaining,
    done: remaining === 0 && !lastError && !rateLimited,
    error: lastError,
    rateLimited,
    // Free tiers meter per minute; a hair over one minute guarantees a
    // fresh window even with clock skew.
    retryAfterMs: rateLimited ? 65_000 : undefined,
    spentThisRun: estimateCostUsd(embedding.model, usage),
    provider: embedding.provider,
    model: embedding.model,
    refused: slice.refused,
    ...(markerError ? { backgroundNote: `The background continuation could not be recorded (${markerError}) — keep this page open until the build finishes.` } : {}),
    ...(await detailFields(orgId, libraryId, user.id, detailAfter, embedding)),
  });
}
