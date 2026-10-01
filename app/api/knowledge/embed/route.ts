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
//
// A REBUILD IS THE REBUILDER'S. Reset clears another member's background
// consent first (a plain build or a standing "keep current"), so a full
// rebuild is never continued on a key whose owner consented to something
// else; the panel's Rebuild dialog says so before it runs. The clear is
// conditional on the consent read, and only a clear that changed the row
// counts: a consent renewed in between is read again and cleared; one that
// keeps changing refuses the rebuild (409) before any vector is touched.
//
// A coverage read that fails is not a missing migration: only a missing
// function (PGRST202 / 42883) says "run 20260930"; anything else (a
// statement timeout during a rebuild) is reported as the transient failure
// it is (503).
//
// Refused passages are reported to controllers with their document and page;
// every other reader gets the count only — a mirror's name is its controlled
// document's number and title, which the reader may not be allowed to see.

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
  loadEmbedDetail, failedPassageSamples, embedAgreementSigned, expectationOf,
  readEmbedBuildMarker, clearEmbedBuildMarkerIf, patchEmbedBuildMarkerIf, type EmbedDetail,
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

/** The coverage read, and — when it fails — whether the function is missing
 *  (a migration to run) or the read itself failed (a timeout while the table
 *  is being rewritten, a dropped connection: try again). */
async function readCoverage(orgId: string, libraryId: string): Promise<
  { stats: { total: number; embedded: number }; missing: false; error: null }
  | { stats: null; missing: boolean; error: string }
> {
  const { data, error } = await supabaseAdmin
    .rpc("semantic_coverage", { p_org_id: orgId, p_library_id: libraryId });
  if (error) {
    const missing = error.code === "PGRST202" || error.code === "42883"
      || /Could not find the function/i.test(error.message ?? "");
    return { stats: null, missing, error: error.message ?? "unknown error" };
  }
  const row = (data as Array<{ total: number; embedded: number }> | null)?.[0];
  return { stats: { total: Number(row?.total ?? 0), embedded: Number(row?.embedded ?? 0) }, missing: false, error: null };
}

async function coverage(orgId: string, libraryId: string) {
  return (await readCoverage(orgId, libraryId)).stats;
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

/** The marker for DISPLAY (the status panel) and for the finished build's
 *  tidy-up, where an unreadable marker writes nothing. Never for a control
 *  that reports what it changed: release and keep-current read through
 *  readEmbedBuildMarker, whose failure is an error, not "no marker". */
async function readMarker(libraryId: string) {
  const { data } = await supabaseAdmin.from("knowledge_libraries").select("ai_features").eq("id", libraryId).maybeSingle();
  return parseEmbedBuildMarker((data?.ai_features as Record<string, unknown> | null)?.embedBuild);
}

/** Everything the panel shows beyond the bar — shared by status and build.
 *  The refused passages' document names (read on the service role) go to
 *  controllers only: everyone else gets the count. */
async function detailFields(orgId: string, libraryId: string, userId: string, detail: EmbedDetail | null, connection: EmbeddingConnection | null, isController: boolean) {
  const marker = await readMarker(libraryId);
  const conflict = detail && connection ? buildModelConflict(detail.corpus, connection) : null;
  const passagesLeft = detail ? detail.remaining : 0;
  return {
    failed: detail?.failed ?? 0,
    failedSamples: isController && detail && detail.failed > 0 ? await failedPassageSamples(orgId, libraryId) : [],
    busy: detail?.leased ?? 0,
    // Refused by the provider and waiting to be offered again — nobody is
    // embedding them, so they are never shown as "busy" (SEM-4).
    waiting: detail?.waiting ?? 0,
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

  const cov = await readCoverage(orgId, libraryId);
  if (!cov.stats) {
    if (cov.missing) {
      return bad(
        "Semantic search needs migration 20260930 — run it in Supabase, then try again.", 424,
      );
    }
    return bad(
      `Couldn't read the meaning index's coverage just now (${cov.error}). The database may be busy — `
      + "a rebuild rewrites every passage — so try again in a moment.", 503,
    );
  }
  const stats = cov.stats;

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
      ...(await detailFields(orgId, libraryId, user.id, detail, connection, principal.isController)),
    });
  }

  if (body.action === "release") {
    // The marker's owner may withdraw their consent; controllers may stop
    // any background build (SEM-11: a stuck build an admin can see and end).
    // A marker that could not be READ is not "no marker": answering
    // { released: false } then would tell a payer nothing was running while
    // their consent keeps spending — the read's failure is the answer (500).
    const seen = await readEmbedBuildMarker(libraryId);
    if (seen.error) return bad(`Couldn't read the background build, so nothing was stopped: ${seen.error}`, 500);
    const marker = seen.marker;
    if (!marker) return NextResponse.json({ released: false });
    if (!principal.isController && marker.userId !== user.id) {
      return bad("Only the member whose key pays, or Admin / Doc Control, can stop this background build.", 403);
    }
    // Only the build the caller was allowed to stop — not one started since.
    // A clear that matched nothing means the consent moved in between (it
    // was renewed or replaced): nothing was stopped, and the caller is told
    // so rather than shown "stopped" while the new consent keeps spending.
    const cleared = await clearEmbedBuildMarkerIf(libraryId, expectationOf(marker));
    if (cleared.error) return bad(`Couldn't stop the background build: ${cleared.error}`, 500);
    if (!cleared.applied) {
      return bad(
        "The background build changed while it was being stopped (it was restarted or renewed), so nothing was "
        + "stopped — look at it again and stop it if you still want to.", 409, { released: false, changed: true },
      );
    }
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
  //
  // Another member's background consent is cleared FIRST (SEM-8 / SEM-11):
  // they consented to continue their build, or to keep new passages current
  // on their key — not to pay for a full rebuild someone else started. Their
  // running drain stops at its next batch; the rebuild that follows records
  // the caller's own consent. The caller's own consent is left as it is.
  if (body.action === "reset") {
    // backgroundCleared is reported only when a clear actually changed the
    // row. A conditional clear that matched nothing means the consent moved
    // between the read and the clear (renewed, re-recorded, replaced): read
    // it again and clear THAT one, once; still moving → 409, nothing cleared.
    let backgroundCleared = false;
    let seen = await readEmbedBuildMarker(libraryId);
    for (let round = 0; ; round++) {
      if (seen.error) return bad(`Couldn't read the background build before the rebuild: ${seen.error}`, 500);
      const other = seen.marker && seen.marker.userId !== user.id ? seen.marker : null;
      if (!other) break;
      const cleared = await clearEmbedBuildMarkerIf(libraryId, expectationOf(other));
      if (cleared.error) return bad(`Couldn't stop another member's background build before the rebuild: ${cleared.error}`, 500);
      if (cleared.applied) { backgroundCleared = true; break; }
      if (round >= 1) {
        return bad(
          "Another member's background build changed while the rebuild was starting, so nothing was cleared "
          + "and no vector was touched — try the rebuild again.", 409,
        );
      }
      seen = await readEmbedBuildMarker(libraryId);
    }
    let { error } = await supabaseAdmin
      .from("knowledge_chunks")
      .update({ embedding: null, embedding_model: null, embed_attempts: 0, embed_error: null, embed_claimed_until: null, embed_retry_after: null })
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
      backgroundCleared,
    });
  }

  if (body.action === "retry-failed") {
    const { data, error } = await supabaseAdmin
      .from("knowledge_chunks")
      .update({ embed_attempts: 0, embed_error: null, embed_retry_after: null })
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
    // As for release: an unreadable marker is never reported withdrawn.
    const seen = await readEmbedBuildMarker(libraryId);
    if (seen.error) {
      return bad(`Couldn't read the standing consent, so nothing was withdrawn: ${seen.error}`, 500, { standing: null });
    }
    const marker = seen.marker;
    if (marker) {
      const detail = await loadEmbedDetail(orgId, libraryId);
      const left = detail ? detail.remaining : stats.total - stats.embedded;
      const write = left === 0
        ? await clearEmbedBuildMarkerIf(libraryId, expectationOf(marker))
        : await patchEmbedBuildMarkerIf(libraryId, { standing: undefined }, expectationOf(marker));
      if (write.error) return bad(`Couldn't withdraw the standing consent: ${write.error}`, 500);
      if (!write.applied) {
        return bad(
          "The background build's consent changed while it was being withdrawn (it was renewed or replaced), so "
          + "nothing was changed — look at it again.", 409, { standing: null, changed: true },
        );
      }
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
  /** Every passage still to embed is leased by a driver or waiting to be
   *  offered again (or none is left) — an empty claim is then expected. */
  const heldElsewhere = (d: EmbedDetail | null) => !!d && d.leased + d.waiting >= d.remaining;
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
  const conflictAfter = detailAfter ? buildModelConflict(detailAfter.corpus, embedding) : null;
  if (slice.fetchedNone && conflictAfter && !lastError) {
    // The claim hands out nothing while the library holds another model's
    // vectors (another driver's landed first): that, not the cache.
    lastError = conflictAfter.message;
  } else if (slice.fetchedNone && remainingBefore > 0
    && !heldElsewhere(detailBefore) && !heldElsewhere(detailAfter)) {
    // Coverage says passages lack vectors, yet the fetch returned none —
    // the classic symptom of a stale PostgREST schema cache after the
    // embedding column was rebuilt. Say so; silence here reads as "done".
    // Never when every passage left is held by another driver or waiting to
    // be retried — before this slice's claim OR after it: another driver
    // (the drain a page load nudged) may have claimed the tail in between,
    // and a controller told to run SQL for that is told something false.
    // The response carries `busy`, and the build loop waits on it.
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
    if (marker?.standing) await patchEmbedBuildMarker(libraryId, { completedAt: new Date().toISOString() }, expectationOf(marker));
    else if (marker) await setEmbedBuildMarker(libraryId, null, { expect: expectationOf(marker) });
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
    ...(await detailFields(orgId, libraryId, user.id, detailAfter, embedding, principal.isController)),
  });
}
