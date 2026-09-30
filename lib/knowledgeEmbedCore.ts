// lib/knowledgeEmbedCore.ts — SERVER-ONLY. The one loop that turns
// unembedded knowledge chunks into vectors, shared by two drivers:
//
//   - /api/knowledge/embed        — the browser-driven build (user watching)
//   - /api/cron/embed-drain       — the background continuation (no tab)
//
// Extracted so a large library doesn't depend on someone keeping a browser
// tab alive for hours. Every committed batch is permanent; the slice stops
// on its time budget and reports what's left — the caller loops or the next
// cron run picks it up.
//
// THE QUEUE IS A CLAIM (SEM-7, 20261121). embed_claim_batch() takes a batch
// FOR UPDATE SKIP LOCKED and leases it, so every driver running at once —
// the browser build, a drain per page-load nudge, the daily cron — works on
// DISJOINT passages and nobody pays twice for the same one. An abandoned
// lease simply expires; nothing is lost, which keeps the property that made
// this survivable: every committed batch is permanent.
//
// ONE BAD PASSAGE NEVER PINS A LIBRARY (SEM-4). When the provider refuses the
// INPUT (400 / 413 / 422), the batch is split and retried until the refused
// passage stands alone; that passage gets an attempt and its error recorded,
// and after EMBED_MAX_ATTEMPTS the queue skips it (reported as failed, with
// document and page). A refusal of the key, the model or the provider itself
// stops the slice and blames no passage. Every vector already paid for is
// written, even when one write fails.
//
// Before 20261121 is applied the claim function does not exist: the slice
// falls back to the original unclaimed queue so building keeps working.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  embedPassages, toVectorLiteral, isPassageRefusal, resolveCorpusModel,
  EMBED_MAX_ATTEMPTS, type EmbeddingProviderId, type CorpusModelVerdict,
} from "@/lib/ai/embeddings";
import { AiCallError } from "@/lib/ai/providerCall";
import { AGREEMENT_VERSION } from "@/lib/ai/pricing";

export interface EmbedConnection {
  provider: EmbeddingProviderId;
  model: string;
  apiKey: string;
}

export interface EmbedSliceResult {
  embedded: number;
  rateLimited: boolean;
  /** Chunks are missing vectors but none could be fetched — the classic
   *  stale-PostgREST-schema-cache symptom after a column rebuild. */
  fetchedNone: boolean;
  error: string | null;
  usage: { inputTokens: number; outputTokens: number };
  /** Passages the provider refused during this slice (an attempt recorded
   *  against each). */
  refused: number;
  /** "claim" = the 20261121 queue ran; "legacy" = it isn't applied yet. */
  queue: "claim" | "legacy";
}

interface ClaimedChunk {
  id: string;
  content: string;
  section: string | null;
  page: number;
  document_id: string;
  document_name: string | null;
  embed_attempts: number;
}

/** The claim function (or a column) a pending migration has not created. */
const missingDbObject = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === "PGRST202" || e.code === "42883" || e.code === "42703" || e.code === "PGRST204"
    || /Could not find the function|does not exist/i.test(e.message ?? ""));

/** A lease comfortably longer than one slice, so a live driver never loses
 *  its claim mid-batch; an abandoned one frees the passages soon after. */
const LEASE_SECONDS = 120;

/** Provider calls one batch may spend isolating refused passages. One bad
 *  passage in 64 is found in 13; the cap bounds a request the provider
 *  refuses outright (every split fails) to a few cheap refusals. */
const MAX_CALLS_PER_BATCH = 16;

/** Embed one time-bounded slice of a library. Never throws — every outcome
 *  is a field on the result, because both drivers must keep going. */
export async function embedLibrarySlice(opts: {
  orgId: string;
  libraryId: string;
  connection: EmbedConnection;
  batchSize: number;
  /** Stop STARTING batches after this many ms. */
  budgetMs: number;
  /** Abort the in-flight provider call at this many ms — must leave room
   *  for the write-back inside the caller's platform limit. */
  hardStopMs: number;
}): Promise<EmbedSliceResult> {
  const { orgId, libraryId, connection, batchSize, budgetMs, hardStopMs } = opts;
  const startedAt = Date.now();
  const usage = { inputTokens: 0, outputTokens: 0 };
  let embedded = 0;
  let refused = 0;
  let rateLimited = false;
  let fetchedNone = false;
  let lastError: string | null = null;
  // Switched to "legacy" inside claim() when 20261121 is not applied.
  let queue = "claim" as "claim" | "legacy";
  let stop = false;

  const elapsed = () => Date.now() - startedAt;

  // ── the queue ─────────────────────────────────────────────────────────────
  const claim = async (): Promise<ClaimedChunk[] | null> => {
    if (queue === "claim") {
      const { data, error } = await supabaseAdmin.rpc("embed_claim_batch", {
        p_org_id: orgId, p_library_id: libraryId, p_limit: batchSize,
        p_lease_seconds: LEASE_SECONDS, p_max_attempts: EMBED_MAX_ATTEMPTS,
      });
      if (!error) {
        return ((data ?? []) as ClaimedChunk[])
          .sort((a, b) => a.document_id.localeCompare(b.document_id) || a.page - b.page || a.id.localeCompare(b.id));
      }
      if (!missingDbObject(error)) { lastError = error.message; return null; }
      queue = "legacy"; // 20261121 not applied yet
    }
    const { data: chunks, error } = await supabaseAdmin
      .from("knowledge_chunks").select("id, content, section, page, document_id")
      .eq("org_id", orgId).eq("library_id", libraryId)
      .is("embedding", null)
      .limit(batchSize);
    if (error) { lastError = error.message; return null; }
    const rows = (chunks ?? []) as Array<Omit<ClaimedChunk, "document_name" | "embed_attempts">>;
    // Contextual prefix needs the document names the claim returns inline.
    const names = new Map<string, string>();
    const ids = [...new Set(rows.map((c) => c.document_id))];
    if (ids.length > 0) {
      const { data: docs } = await supabaseAdmin.from("knowledge_documents").select("id, name").in("id", ids);
      for (const d of (docs ?? []) as Array<{ id: string; name: string }>) names.set(d.id, d.name);
    }
    return rows.map((c) => ({ ...c, document_name: names.get(c.document_id) ?? null, embed_attempts: 0 }));
  };

  /** Give back passages this slice claimed but will not embed. */
  const release = async (chunks: ClaimedChunk[]) => {
    if (queue !== "claim" || chunks.length === 0) return;
    await supabaseAdmin.from("knowledge_chunks")
      .update({ embed_claimed_until: null }).in("id", chunks.map((c) => c.id))
      .then(() => undefined, () => undefined); // an unreleased lease just expires
  };

  // ── writing back what was paid for ────────────────────────────────────────
  /** Write every vector; a failed write never abandons the rest. Counts the
   *  rows that actually changed (a passage another driver already embedded
   *  is not counted twice). */
  const writeBack = async (group: ClaimedChunk[], vectors: number[][]): Promise<void> => {
    for (let i = 0; i < group.length; i += 8) {
      const part = group.slice(i, i + 8);
      const results = await Promise.all(part.map((c, j) => {
        const patch = queue === "claim"
          ? { embedding: toVectorLiteral(vectors[i + j]), embedding_model: connection.model, embed_claimed_until: null, embed_error: null }
          : { embedding: toVectorLiteral(vectors[i + j]), embedding_model: connection.model };
        const q = supabaseAdmin.from("knowledge_chunks").update(patch).eq("id", c.id);
        return queue === "claim" ? q.is("embedding", null).select("id") : q;
      }));
      for (const r of results) {
        if (r.error) { lastError ??= r.error.message; continue; }
        if (queue === "claim") embedded += Array.isArray(r.data) ? r.data.length : 0;
        else embedded += 1;
      }
    }
  };

  /** One passage refused by the provider: an attempt and the reason. Its
   *  lease is KEPT, so no driver (this slice included) asks again until the
   *  lease runs out — attempts accrue across runs, not in one tight loop. At
   *  EMBED_MAX_ATTEMPTS the queue stops offering it. */
  const recordRefusal = async (c: ClaimedChunk, message: string) => {
    const { error } = await supabaseAdmin.from("knowledge_chunks")
      .update({ embed_attempts: (c.embed_attempts ?? 0) + 1, embed_error: message.slice(0, 500) })
      .eq("id", c.id);
    if (error) lastError ??= error.message;
    else refused += 1;
  };

  // ── one batch, split on a refused passage ─────────────────────────────────
  const embedBatch = async (root: ClaimedChunk[]) => {
    const refusedHere: Array<{ c: ClaimedChunk; message: string }> = [];
    const embeddedIds = new Set<string>();
    let calls = 0;

    const attempt = async (group: ClaimedChunk[], depth: number): Promise<void> => {
      if (stop || group.length === 0) return;
      // A split never outruns the slice: out of time or out of calls, the
      // unexplored passages go back to the queue untouched.
      if (depth > 0 && (elapsed() >= budgetMs || calls >= MAX_CALLS_PER_BATCH)) { stop = true; return; }
      calls += 1;
      let vectors: number[][];
      try {
        // HARD-BOUNDED: the in-flight provider call must never outlive the
        // caller's platform limit — it aborts with time left to commit.
        const callBudget = Math.max(5_000, hardStopMs - elapsed());
        const out = await embedPassages({
          provider: connection.provider, model: connection.model, apiKey: connection.apiKey,
          // Contextual prefix: document name + section + page make the heading
          // visible to the vector space — the cheapest retrieval upgrade there is.
          passages: group.map((c) => {
            const head = [c.document_name, c.section, `p.${c.page}`].filter(Boolean).join(" — ");
            return head ? `${head}\n${c.content}` : c.content;
          }),
          kind: "document",             // corpus side of the asymmetric pair
          signal: AbortSignal.timeout(callBudget),
        });
        vectors = out.vectors;
        usage.inputTokens += out.usage.inputTokens;
      } catch (e) {
        // 429 is pacing, not failure — the driver waits out the window.
        if (e instanceof AiCallError && e.status === 429) { rateLimited = true; stop = true; return; }
        // Ran out of clock, not out of luck: return committed progress.
        const name = (e as { name?: string })?.name ?? "";
        if (name === "TimeoutError" || name === "AbortError") { stop = true; return; }
        const message = e instanceof AiCallError ? e.message : "Embedding failed.";
        if (queue === "claim" && isPassageRefusal(e)) {
          if (group.length === 1) { refusedHere.push({ c: group[0], message }); return; }
          const mid = Math.ceil(group.length / 2);
          await attempt(group.slice(0, mid), depth + 1);
          await attempt(group.slice(mid), depth + 1);
          return;
        }
        // The key, the model or the provider — never the passages.
        lastError = message;
        stop = true;
        return;
      }
      await writeBack(group, vectors);
      for (const c of group) embeddedIds.add(c.id);
    };

    await attempt(root, 0);
    // Set inside: a 429, a timeout, the call cap, or a refusal of the key /
    // model / provider. Nothing below may turn pacing into a failure.
    const interrupted = stop;
    const unembedded = root.filter((c) => !embeddedIds.has(c.id));

    // The key, the model or the provider refused: blame no passage.
    if (lastError) { await release(unembedded); return; }
    // A multi-passage batch in which NOTHING embedded is the request, not the
    // passages (a parameter the provider now rejects): blame none of them —
    // no attempt is recorded. A completed split says so and stops; a split
    // cut short (pacing, the clock) just gives the batch back.
    if (root.length > 1 && embeddedIds.size === 0 && refusedHere.length > 0) {
      if (!interrupted) { lastError = refusedHere[0].message; stop = true; }
      await release(unembedded);
      return;
    }
    for (const r of refusedHere) await recordRefusal(r.c, r.message);
    await release(unembedded.filter((c) => !refusedHere.some((r) => r.c.id === c.id)));
  };

  while (!stop && elapsed() < budgetMs) {
    const batch = await claim();
    if (!batch) break;
    if (batch.length === 0) {
      if (embedded === 0 && refused === 0) fetchedNone = true;
      break;
    }
    if (queue === "legacy") {
      // The original behaviour, unchanged: one call, stop on any error.
      try {
        const callBudget = Math.max(5_000, hardStopMs - elapsed());
        const out = await embedPassages({
          provider: connection.provider, model: connection.model, apiKey: connection.apiKey,
          passages: batch.map((c) => {
            const head = [c.document_name, c.section, `p.${c.page}`].filter(Boolean).join(" — ");
            return head ? `${head}\n${c.content}` : c.content;
          }),
          kind: "document",
          signal: AbortSignal.timeout(callBudget),
        });
        usage.inputTokens += out.usage.inputTokens;
        await writeBack(batch, out.vectors);
      } catch (e) {
        if (e instanceof AiCallError && e.status === 429) { rateLimited = true; break; }
        const name = (e as { name?: string })?.name ?? "";
        if (name === "TimeoutError" || name === "AbortError") break;
        lastError = e instanceof AiCallError ? e.message : "Embedding failed.";
        break;
      }
    } else {
      await embedBatch(batch);
    }
    if (lastError) break;
  }

  return { embedded, rateLimited, fetchedNone, error: lastError, usage, refused, queue };
}

// ── What the build knows about a library (20261121) ─────────────────────────

export interface EmbedDetail {
  /** Retrievable passages (their document is ready or indexing). */
  total: number;
  embedded: number;
  /** Still to embed — the provider has not refused them EMBED_MAX_ATTEMPTS times. */
  remaining: number;
  /** Refused EMBED_MAX_ATTEMPTS times: skipped until retried or rebuilt. */
  failed: number;
  /** Claimed by a driver right now. */
  leased: number;
  remainingChars: number;
  totalChars: number;
  /** Vectors per embedding model, whole library. */
  models: Record<string, number>;
  corpus: CorpusModelVerdict;
}

/** The build's own numbers in one read, or null when 20261121 is not applied
 *  (or the read failed) — callers then fall back to plain coverage. */
export async function loadEmbedDetail(orgId: string, libraryId: string): Promise<EmbedDetail | null> {
  const { data, error } = await supabaseAdmin.rpc("semantic_coverage_detail", {
    p_org_id: orgId, p_library_id: libraryId, p_max_attempts: EMBED_MAX_ATTEMPTS,
  });
  if (error) return null;
  const row = (data as Array<Record<string, unknown>> | null)?.[0];
  if (!row) return null;
  const models = (row.models && typeof row.models === "object" ? row.models : {}) as Record<string, number>;
  return {
    total: Number(row.total ?? 0),
    embedded: Number(row.embedded ?? 0),
    remaining: Number(row.remaining ?? 0),
    failed: Number(row.failed ?? 0),
    leased: Number(row.leased ?? 0),
    remainingChars: Number(row.remaining_chars ?? 0),
    totalChars: Number(row.total_chars ?? 0),
    models,
    corpus: resolveCorpusModel(models),
  };
}

/** A few of the passages the provider refused, with where they are. */
export async function failedPassageSamples(
  orgId: string, libraryId: string, limit = 5,
): Promise<Array<{ documentName: string; page: number; error: string | null }>> {
  const { data, error } = await supabaseAdmin
    .from("knowledge_chunks")
    .select("page, embed_error, knowledge_documents(name)")
    .eq("org_id", orgId).eq("library_id", libraryId)
    .is("embedding", null)
    .gte("embed_attempts", EMBED_MAX_ATTEMPTS)
    .limit(limit);
  if (error) return [];
  return ((data ?? []) as Array<{ page: number; embed_error: string | null; knowledge_documents: { name?: string } | Array<{ name?: string }> | null }>)
    .map((r) => {
      const doc = Array.isArray(r.knowledge_documents) ? r.knowledge_documents[0] : r.knowledge_documents;
      return { documentName: doc?.name ?? "Document", page: r.page, error: r.embed_error };
    });
}

/** How many chunks in the library still need a vector. With 20261121: the
 *  retrievable passages still in the queue (refused-out ones excluded) — the
 *  same population the claim serves. Before it: the plain null count. */
export async function unembeddedCount(orgId: string, libraryId: string): Promise<number> {
  const detail = await loadEmbedDetail(orgId, libraryId);
  if (detail) return detail.remaining;
  const { count } = await supabaseAdmin
    .from("knowledge_chunks").select("id", { count: "exact", head: true })
    .eq("org_id", orgId).eq("library_id", libraryId).is("embedding", null);
  return count ?? 0;
}

// ── The consent marker (ai_features.embedBuild) ─────────────────────────────
//
// Starting a build records WHO consented to spend their key; the background
// drain only ever continues builds carrying that consent. `standing` (SEM-8)
// is a consent to keep the library current as documents arrive — the stamp
// then survives 100% and the drain embeds new passages on the same key and
// under the same cap. The rest is the drain's bookkeeping (SEM-11): when it
// last looked, and why it is holding off.

export interface EmbedBuildMarker {
  userId: string;
  at: string;
  standing?: boolean;
  lastDrainAt?: string;
  blockedUntil?: string;
  blockedReason?: "cap" | "error" | "model_conflict" | "agreement";
  lastError?: string;
  errorRuns?: number;
  completedAt?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The marker as stored, or null. A marker is only ever trusted as far as
 *  it parses: a non-uuid userId is reported as `valid: false` so the drain
 *  releases it instead of spending on it (GOV-14 limb). */
export function parseEmbedBuildMarker(raw: unknown): (EmbedBuildMarker & { valid: boolean }) | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const userId = typeof r.userId === "string" ? r.userId : "";
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    userId,
    at: str(r.at) ?? "",
    standing: r.standing === true,
    lastDrainAt: str(r.lastDrainAt),
    blockedUntil: str(r.blockedUntil),
    blockedReason: str(r.blockedReason) as EmbedBuildMarker["blockedReason"],
    lastError: str(r.lastError),
    errorRuns: typeof r.errorRuns === "number" ? r.errorRuns : 0,
    completedAt: str(r.completedAt),
    valid: UUID_RE.test(userId),
  };
}

async function readFeatures(libraryId: string): Promise<{ feats: Record<string, unknown>; error: string | null }> {
  const { data: lib, error } = await supabaseAdmin
    .from("knowledge_libraries").select("ai_features").eq("id", libraryId).maybeSingle();
  if (error) return { feats: {}, error: error.message };
  return { feats: { ...((lib?.ai_features as Record<string, unknown> | null) ?? {}) }, error: null };
}

async function writeFeatures(libraryId: string, feats: Record<string, unknown>): Promise<string | null> {
  const { error } = await supabaseAdmin.from("knowledge_libraries").update({ ai_features: feats }).eq("id", libraryId);
  return error ? error.message : null;
}

/** Set / clear the background-continuation marker on a library. Starting a
 *  build in the UI records WHO consented to spend their key; the cron only
 *  ever continues builds carrying that consent. A new consent clears any
 *  hold; a standing consent survives only when the same person renews it,
 *  and another member's standing consent is never replaced by a plain build
 *  (only by an explicit `standing` choice, or by clearing it) — the drain
 *  continues the build on the consent that is already standing.
 *  Returns the write error, if any — a consent that did not record is said. */
export async function setEmbedBuildMarker(
  libraryId: string, userId: string | null, opts?: { standing?: boolean },
): Promise<string | null> {
  const { feats, error } = await readFeatures(libraryId);
  if (error) return error;
  const prior = parseEmbedBuildMarker(feats.embedBuild);
  if (userId && opts?.standing === undefined && prior?.valid && prior.standing && prior.userId !== userId) {
    return null;
  }
  if (userId) {
    const standing = opts?.standing ?? (prior?.userId === userId && prior.standing === true);
    feats.embedBuild = { userId, at: new Date().toISOString(), ...(standing ? { standing: true } : {}) };
  } else {
    delete feats.embedBuild;
  }
  return writeFeatures(libraryId, feats);
}

/** Merge drain bookkeeping into the existing marker (never creates one). */
export async function patchEmbedBuildMarker(
  libraryId: string, patch: Partial<EmbedBuildMarker>,
): Promise<string | null> {
  const { feats, error } = await readFeatures(libraryId);
  if (error) return error;
  const cur = feats.embedBuild;
  if (!cur || typeof cur !== "object") return null;
  const next: Record<string, unknown> = { ...(cur as Record<string, unknown>), ...patch };
  for (const [k, v] of Object.entries(next)) if (v === undefined || v === null) delete next[k];
  feats.embedBuild = next;
  return writeFeatures(libraryId, feats);
}

/** The acceptable-use agreement, checked locally until I-05's aiGates lands:
 *  true = signed the current version; false = not; null = the agreements
 *  table is not installed (the gate is skipped, as the ask route does). */
export async function embedAgreementSigned(orgId: string, userId: string): Promise<boolean | null> {
  const { data, error } = await supabaseAdmin
    .from("ai_key_agreements").select("id")
    .eq("org_id", orgId).eq("user_id", userId)
    .eq("scope", "use").eq("agreement_version", AGREEMENT_VERSION)
    .limit(1);
  if (error) return error.code === "42P01" || /does not exist/i.test(error.message) ? null : false;
  return (data ?? []).length > 0;
}
