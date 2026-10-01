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
// this survivable: every committed batch is permanent. The claim returns its
// lease instant and every write a slice makes to a claimed passage (its
// vector, its refusal, giving it back) is held to that instant: a Rebuild
// clears every lease, and another driver's newer claim replaces it, so a
// batch still in flight when either happens writes nothing — no old-model
// vector lands in a rebuilt library, and no lease another driver holds is
// cleared.
//
// ONE BAD PASSAGE NEVER PINS A LIBRARY (SEM-4). When the provider refuses the
// INPUT (400 / 413 / 422), the batch is split and retried until the refused
// passage stands alone. A passage refused ALONE is blamed only once the
// provider is known to accept the request itself — another passage of the
// batch embedded, or a one-line canary (same provider, model and parameters)
// did: then it gets an attempt and its error recorded, gives its lease back
// and waits REFUSAL_RETRY_SECONDS (embed_retry_after) before any driver
// offers it again, and after EMBED_MAX_ATTEMPTS the queue skips it (reported
// as failed, with document and page). So two bad passages that make up a
// whole batch, or a bad document longer than a batch, still reach the limit
// and the library still completes around them. A canary the provider refuses
// too means the REQUEST is at fault (a parameter it now rejects): nobody is
// blamed and the slice stops with the provider's words — as for a refusal of
// the key, the model or the provider itself. Every vector already paid for is
// written, even when one write fails.
//
// ONE MODEL PER LIBRARY, AT THE QUEUE (SEM-1). The claim carries the model
// the slice embeds with and hands out nothing while the library holds a
// vector under any other model, so a driver on a stale connection cannot
// add a second vector space once the first vector of a rebuild has landed.
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
  /** Why the slice stopped before a batch at its caller's request
   *  (`beforeBatch`), or null. */
  stopReason: string | null;
}

interface ClaimedChunk {
  id: string;
  content: string;
  section: string | null;
  page: number;
  document_id: string;
  document_name: string | null;
  embed_attempts: number;
  /** The lease instant the claim set (20261121); absent on the legacy queue. */
  embed_claimed_until?: string | null;
}

/** The claim function (or a column) a pending migration has not created. */
const missingDbObject = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === "PGRST202" || e.code === "42883" || e.code === "42703" || e.code === "PGRST204"
    || /Could not find the function|does not exist/i.test(e.message ?? ""));

/** A lease comfortably longer than one slice, so a live driver never loses
 *  its claim mid-batch; an abandoned one frees the passages soon after. */
const LEASE_SECONDS = 120;

/** Provider calls one batch may spend isolating refused passages. One bad
 *  passage in 64 is found in 13; the cap bounds a batch of many bad passages
 *  to a few cheap refusals — the passages isolated so far are charged, the
 *  rest go back to the queue and the slice moves on to its next batch. */
const MAX_CALLS_PER_BATCH = 16;

/** How long a passage the provider refused waits before any driver offers it
 *  again: attempts accrue across runs, never in one tight loop. Its lease is
 *  given back at once — a refused passage is not "being embedded" by anyone,
 *  and the status says so (`waiting`, not `leased`). */
export const REFUSAL_RETRY_SECONDS = 120;

/** The canary's input: one short line, embedded exactly as a passage is. */
const CANARY_PASSAGE = "Embedding check.";

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
  /** Asked before EVERY batch is claimed: a reason to stop (nothing more is
   *  claimed or spent), or null to go on. The background drain uses it to
   *  stop the moment the consent it runs on is withdrawn or replaced. */
  beforeBatch?: () => Promise<string | null>;
}): Promise<EmbedSliceResult> {
  const { orgId, libraryId, connection, batchSize, budgetMs, hardStopMs, beforeBatch } = opts;
  const startedAt = Date.now();
  const usage = { inputTokens: 0, outputTokens: 0 };
  let embedded = 0;
  let refused = 0;
  let rateLimited = false;
  let fetchedNone = false;
  let lastError: string | null = null;
  let stopReason: string | null = null;
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
        p_model: connection.model,
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

  /** Hold a write to a claimed passage to THIS slice's lease instant (the
   *  claim returns it). A claim that did not return one (a pre-release draft
   *  of 20261121) is held to "some lease still stands", which a Rebuild
   *  voids. */
  const heldBy = <Q extends { eq(column: string, value: string): Q; not(column: string, op: string, value: null): Q }>(q: Q, c: ClaimedChunk): Q =>
    (c.embed_claimed_until ? q.eq("embed_claimed_until", c.embed_claimed_until) : q.not("embed_claimed_until", "is", null));

  /** Give back passages this slice claimed but will not embed — only while
   *  this slice's lease still stands (a lease another driver took since, or
   *  one a Rebuild cleared, is not ours to clear). */
  const release = async (chunks: ClaimedChunk[]) => {
    if (queue !== "claim" || chunks.length === 0) return;
    const byLease = new Map<string, string[]>();
    for (const c of chunks) {
      const k = c.embed_claimed_until ?? "";
      byLease.set(k, [...(byLease.get(k) ?? []), c.id]);
    }
    for (const [lease, ids] of byLease) {
      const q = supabaseAdmin.from("knowledge_chunks").update({ embed_claimed_until: null }).in("id", ids);
      await (lease ? q.eq("embed_claimed_until", lease) : q.not("embed_claimed_until", "is", null))
        .then(() => undefined, () => undefined); // an unreleased lease just expires
    }
  };

  // ── writing back what was paid for ────────────────────────────────────────
  /** Write every vector; a failed write never abandons the rest. Counts the
   *  rows that actually changed (a passage another driver already embedded
   *  is not counted twice). On the claim queue a write lands only while the
   *  passage still carries THIS slice's lease (`heldBy`): a Rebuild that
   *  cleared every lease mid-batch, or a newer claim by another driver,
   *  voids it. */
  const writeBack = async (group: ClaimedChunk[], vectors: number[][]): Promise<void> => {
    for (let i = 0; i < group.length; i += 8) {
      const part = group.slice(i, i + 8);
      const results = await Promise.all(part.map((c, j) => {
        const patch = queue === "claim"
          ? { embedding: toVectorLiteral(vectors[i + j]), embedding_model: connection.model, embed_claimed_until: null, embed_error: null, embed_retry_after: null }
          : { embedding: toVectorLiteral(vectors[i + j]), embedding_model: connection.model };
        const q = supabaseAdmin.from("knowledge_chunks").update(patch).eq("id", c.id);
        return queue === "claim" ? heldBy(q.is("embedding", null), c).select("id") : q;
      }));
      for (const r of results) {
        if (r.error) { lastError ??= r.error.message; continue; }
        if (queue === "claim") embedded += Array.isArray(r.data) ? r.data.length : 0;
        else embedded += 1;
      }
    }
  };

  /** One passage refused by the provider: an attempt and the reason. Its
   *  lease is given back and it waits REFUSAL_RETRY_SECONDS before any
   *  driver (this slice included) offers it again — attempts accrue across
   *  runs, not in one tight loop. At EMBED_MAX_ATTEMPTS the queue stops
   *  offering it. */
  const recordRefusal = async (c: ClaimedChunk, message: string) => {
    const { data, error } = await heldBy(supabaseAdmin.from("knowledge_chunks")
      .update({
        embed_attempts: (c.embed_attempts ?? 0) + 1,
        embed_error: message.slice(0, 500),
        embed_claimed_until: null,
        embed_retry_after: new Date(Date.now() + REFUSAL_RETRY_SECONDS * 1000).toISOString(),
      })
      .eq("id", c.id), c).select("id");
    if (error) lastError ??= error.message;
    else refused += Array.isArray(data) ? data.length : 0;   // a voided lease charges nobody
  };

  /** The passages' text as the provider sees it: a contextual prefix
   *  (document name + section + page) makes the heading visible to the
   *  vector space — the cheapest retrieval upgrade there is. */
  const passageText = (c: ClaimedChunk) => {
    const head = [c.document_name, c.section, `p.${c.page}`].filter(Boolean).join(" — ");
    return head ? `${head}\n${c.content}` : c.content;
  };

  // ── one batch, split on a refused passage ─────────────────────────────────
  const embedBatch = async (root: ClaimedChunk[]) => {
    const refusedHere: Array<{ c: ClaimedChunk; message: string }> = [];
    const embeddedIds = new Set<string>();
    let calls = 0;
    // Out of calls: this batch's unexplored passages go back to the queue;
    // the slice goes on to its next batch (unlike the clock, which stops it).
    let capped = false;
    // Does the provider accept THIS request (provider, model, parameters)?
    // Known once a call of this batch embedded, or once the canary did —
    // and only then is a passage refused alone its own fault. The canary is
    // asked at most once per batch, and only when nothing in it embedded.
    let requestAccepted = false;

    /** One short input, the same provider, model and parameters: tells a
     *  refused REQUEST (blame nobody) from refused PASSAGES (blame each). */
    const canary = async (leafMessage: string): Promise<boolean> => {
      try {
        const out = await embedPassages({
          provider: connection.provider, model: connection.model, apiKey: connection.apiKey,
          passages: [CANARY_PASSAGE],
          kind: "document",
          signal: AbortSignal.timeout(Math.max(5_000, hardStopMs - elapsed())),
        });
        usage.inputTokens += out.usage.inputTokens;
        requestAccepted = true;
        return true;
      } catch (e) {
        if (e instanceof AiCallError && e.status === 429) { rateLimited = true; stop = true; return false; }
        const name = (e as { name?: string })?.name ?? "";
        if (name === "TimeoutError" || name === "AbortError") { stop = true; return false; }
        // Refused as well: the request is at fault, not the passages.
        lastError = isPassageRefusal(e)
          ? `The embeddings provider refused a one-line test request as well as these passages, so the request itself is being refused (the model or its parameters), not the passages — no passage was marked failed. ${leafMessage}`
          : (e instanceof AiCallError ? e.message : "Embedding failed.");
        stop = true;
        return false;
      }
    };

    const attempt = async (group: ClaimedChunk[], depth: number): Promise<void> => {
      if (stop || capped || group.length === 0) return;
      // A split never outruns the slice: out of time or out of calls, the
      // unexplored passages go back to the queue untouched.
      if (depth > 0 && elapsed() >= budgetMs) { stop = true; return; }
      if (depth > 0 && calls >= MAX_CALLS_PER_BATCH) { capped = true; return; }
      calls += 1;
      let vectors: number[][];
      try {
        // HARD-BOUNDED: the in-flight provider call must never outlive the
        // caller's platform limit — it aborts with time left to commit.
        const callBudget = Math.max(5_000, hardStopMs - elapsed());
        const out = await embedPassages({
          provider: connection.provider, model: connection.model, apiKey: connection.apiKey,
          passages: group.map(passageText),
          kind: "document",             // corpus side of the asymmetric pair
          signal: AbortSignal.timeout(callBudget),
        });
        vectors = out.vectors;
        usage.inputTokens += out.usage.inputTokens;
        requestAccepted = true;
      } catch (e) {
        // 429 is pacing, not failure — the driver waits out the window.
        if (e instanceof AiCallError && e.status === 429) { rateLimited = true; stop = true; return; }
        // Ran out of clock, not out of luck: return committed progress.
        const name = (e as { name?: string })?.name ?? "";
        if (name === "TimeoutError" || name === "AbortError") { stop = true; return; }
        const message = e instanceof AiCallError ? e.message : "Embedding failed.";
        if (queue === "claim" && isPassageRefusal(e)) {
          // Refused alone: a suspect until the request itself is known good.
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
    const unembedded = root.filter((c) => !embeddedIds.has(c.id));
    // A capped batch that isolated and embedded nothing would only be claimed
    // again as it is: stop the slice rather than spin on it.
    if (capped && embeddedIds.size === 0 && refusedHere.length === 0) stop = true;

    // The key, the model or the provider refused: blame no passage, give the
    // batch back.
    if (lastError) { await release(unembedded); return; }
    // Passages were refused alone and NOTHING in this batch embedded: the
    // passages, or the request (a parameter the provider now rejects)? Ask
    // once with the canary. Refused too → the request: blame nobody. A batch
    // cut short by pacing or the clock is not asked — the next run decides.
    if (refusedHere.length > 0 && !requestAccepted) {
      if (stop || !(await canary(refusedHere[0].message))) { await release(unembedded); return; }
    }
    // Every passage in refusedHere was refused ALONE while the provider
    // accepted the same request (a sibling embedded, or the canary did), so
    // each is charged an attempt — however many of the batch they are. A
    // split cut short (pacing, the clock, the call cap) charges only the
    // passages it isolated; the rest go back to the queue untouched.
    for (const r of refusedHere) await recordRefusal(r.c, r.message);
    await release(unembedded.filter((c) => !refusedHere.some((r) => r.c.id === c.id)));
  };

  while (!stop && elapsed() < budgetMs) {
    if (beforeBatch) {
      stopReason = await beforeBatch().catch((e: unknown) => `couldn't confirm the build may go on: ${(e as Error)?.message ?? "unknown error"}`);
      if (stopReason) break;
    }
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
          passages: batch.map(passageText),
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

  return { embedded, rateLimited, fetchedNone, error: lastError, usage, refused, queue, stopReason };
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
  /** Claimed by a driver right now (a refused passage gives its lease back). */
  leased: number;
  /** Refused by the provider, waiting REFUSAL_RETRY_SECONDS to be offered
   *  again — nobody is embedding them now (SEM-4). */
  waiting: number;
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
    waiting: Number(row.waiting ?? 0),
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
 *  same population the claim serves. Before it: the plain null count.
 *  NULL when neither read succeeded: the count is UNKNOWN, never 0 — a
 *  caller must not read a failed read as "complete" (DEC-59 (5)). */
export async function unembeddedCount(orgId: string, libraryId: string): Promise<number | null> {
  const detail = await loadEmbedDetail(orgId, libraryId);
  if (detail) return detail.remaining;
  const { count, error } = await supabaseAdmin
    .from("knowledge_chunks").select("id", { count: "exact", head: true })
    .eq("org_id", orgId).eq("library_id", libraryId).is("embedding", null);
  if (error || typeof count !== "number") return null;
  return count;
}

// ── The consent marker (ai_features.embedBuild) ─────────────────────────────
//
// Starting a build records WHO consented to spend their key; the background
// drain only ever continues builds carrying that consent. `standing` (SEM-8)
// is a consent to keep the library current as documents arrive — the stamp
// then survives 100% and the drain embeds new passages on the same key and
// under the same cap. The rest is the drain's bookkeeping (SEM-11): when it
// last looked, and why it is holding off.
//
// The marker shares ai_features with the Library AI toggles, so it is never
// written by replacing the whole blob: embed_build_marker_write (20261121)
// sets, patches or clears the `embedBuild` key alone, atomically, and only
// while the marker is still the one the writer read (`expect`) — so a drain
// never reverts a Library AI save made while it ran, never books its run
// against a consent recorded after it looked, and never clears it.
// saveLibraryAiFeatures keeps the marker the same way from the other side.

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

/** The marker a writer read: a write goes through only while the stored
 *  marker still names this member (and, when known, was recorded at `at`).
 *  null = no check on that field; "" = expect NONE (the writer read no
 *  marker, so it writes only while there is still none). */
export interface MarkerExpectation { userId: string | null; at: string | null }

/** The expectation of a writer that read no marker at all. */
export const NO_MARKER: MarkerExpectation = { userId: "", at: null };

/** The expectation for a marker as read — empty fields expect nothing. */
export const expectationOf = (m: { userId?: string; at?: string } | null | undefined): MarkerExpectation =>
  ({ userId: m?.userId || null, at: m?.at || null });

/** What a marker write did. `applied` is false when nothing changed — a
 *  conditional write whose expectation no longer held (the marker was
 *  renewed, replaced or cleared since it was read), a patch of a library
 *  with no marker, or an error. A caller that must KNOW its write landed
 *  (a Rebuild ending another member's consent) reads it; the rest only
 *  report the error. */
export interface MarkerWrite { error: string | null; applied: boolean }

/** Set, patch or clear ai_features.embedBuild ALONE (20261121's atomic
 *  write); before 20261121, the whole-blob read-modify-write it replaces. */
async function writeMarker(
  libraryId: string,
  change: { set: Record<string, unknown> | null } | { patch: Record<string, unknown>; drop: string[] },
  expect?: MarkerExpectation | null,
): Promise<MarkerWrite> {
  const isPatch = "patch" in change;
  const { data, error } = await supabaseAdmin.rpc("embed_build_marker_write", {
    p_library_id: libraryId,
    p_marker: isPatch ? change.patch : change.set,
    p_patch: isPatch,
    p_drop: isPatch ? change.drop : [],
    p_expect_user: expect?.userId ?? null,
    p_expect_at: expect?.at ?? null,
  });
  // The function returns whether a row changed.
  if (!error) return { error: null, applied: data === true };
  if (!missingDbObject(error)) return { error: error.message, applied: false };
  // 20261121 not applied: the original whole-blob write, with the same checks.
  const { feats, error: readErr } = await readFeatures(libraryId);
  if (readErr) return { error: readErr, applied: false };
  const cur = feats.embedBuild && typeof feats.embedBuild === "object" ? feats.embedBuild as Record<string, unknown> : null;
  // The SQL's own test: COALESCE(stored, '') = expected, NULL = no check.
  const stored = (k: "userId" | "at") => (typeof cur?.[k] === "string" ? cur[k] as string : "");
  if (expect && expect.userId !== null && stored("userId") !== expect.userId) return { error: null, applied: false };
  if (expect && expect.at !== null && stored("at") !== expect.at) return { error: null, applied: false };
  if (isPatch) {
    if (!cur) return { error: null, applied: false };
    const next: Record<string, unknown> = { ...cur, ...change.patch };
    for (const k of change.drop) delete next[k];
    feats.embedBuild = next;
  } else if (change.set) {
    feats.embedBuild = change.set;
  } else {
    delete feats.embedBuild;
  }
  const writeErr = await writeFeatures(libraryId, feats);
  return { error: writeErr, applied: !writeErr };
}

/** The library's marker now, or the read error (never guessed). */
export async function readEmbedBuildMarker(
  libraryId: string,
): Promise<{ marker: ReturnType<typeof parseEmbedBuildMarker>; error: string | null }> {
  const { feats, error } = await readFeatures(libraryId);
  if (error) return { marker: null, error };
  return { marker: parseEmbedBuildMarker(feats.embedBuild), error: null };
}

/** Set / clear the background-continuation marker on a library. Starting a
 *  build in the UI records WHO consented to spend their key; the cron only
 *  ever continues builds carrying that consent. A new consent clears any
 *  hold; a standing consent survives only when the same person renews it,
 *  and another member's standing consent is never replaced by a plain build
 *  (only by an explicit `standing` choice, or by clearing it) — the drain
 *  continues the build on the consent that is already standing. A Rebuild
 *  (reset) clears another member's marker first, so a rebuild is never
 *  continued on a consent given for something else.
 *  `expect` makes the write conditional on the marker the caller read.
 *  Without one, setting a consent is conditional on the marker read HERE
 *  (none read → none may exist), so a consent recorded between that read and
 *  the write is never overwritten: a write that no longer applies re-reads
 *  once and applies the same rule to what it finds; still moving → said.
 *  Returns the write error, if any — a consent that did not record is said. */
export async function setEmbedBuildMarker(
  libraryId: string, userId: string | null, opts?: { standing?: boolean; expect?: MarkerExpectation },
): Promise<string | null> {
  if (!userId) return (await writeMarker(libraryId, { set: null }, opts?.expect)).error;
  for (let round = 0; round < 2; round++) {
    const { feats, error } = await readFeatures(libraryId);
    if (error) return error;
    const prior = parseEmbedBuildMarker(feats.embedBuild);
    if (opts?.standing === undefined && prior?.valid && prior.standing && prior.userId !== userId) {
      return null;
    }
    const standing = opts?.standing ?? (prior?.userId === userId && prior.standing === true);
    const expect = opts?.expect ?? (prior ? { userId: prior.userId, at: prior.at || null } : NO_MARKER);
    const out = await writeMarker(
      libraryId,
      { set: { userId, at: new Date().toISOString(), ...(standing ? { standing: true } : {}) } },
      expect,
    );
    if (out.error || out.applied || opts?.expect) return out.error;
  }
  return "the background build's consent changed while this one was being recorded — start the build again to record it";
}

/** Clear the marker only while it is still the one the caller read, and SAY
 *  whether it was cleared: `applied: false` with no error means the marker
 *  changed in between (renewed, replaced or already cleared) and is as its
 *  new writer left it. */
export async function clearEmbedBuildMarkerIf(libraryId: string, expect: MarkerExpectation): Promise<MarkerWrite> {
  return writeMarker(libraryId, { set: null }, expect);
}

/** Merge drain bookkeeping into the existing marker (never creates one); an
 *  undefined / null field is removed. `expect` as for setEmbedBuildMarker. */
export async function patchEmbedBuildMarker(
  libraryId: string, patch: Partial<EmbedBuildMarker>, expect?: MarkerExpectation,
): Promise<string | null> {
  return (await patchEmbedBuildMarkerIf(libraryId, patch, expect)).error;
}

/** patchEmbedBuildMarker, saying whether the patch landed (`applied: false`
 *  with no error: the marker changed since it was read, or is gone). */
export async function patchEmbedBuildMarkerIf(
  libraryId: string, patch: Partial<EmbedBuildMarker>, expect?: MarkerExpectation,
): Promise<MarkerWrite> {
  const set: Record<string, unknown> = {};
  const drop: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) drop.push(k);
    else set[k] = v;
  }
  return writeMarker(libraryId, { patch: set, drop }, expect);
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
