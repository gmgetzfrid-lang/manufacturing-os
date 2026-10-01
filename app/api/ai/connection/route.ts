// /api/ai/connection — the ONLY door to ai_connections (BYO provider keys).
//
// PER-USER KEYS ONLY. There is no workspace/org key: every member brings
// their own API key, spends their own money, and is metered individually.
// The api_key column is service-role-only by design (RLS with zero client
// policies): a browser can never SELECT it, masked or not. This route:
//
//   GET    ?orgId=…            → { personal, effective } (masked: no keys)
//   POST   { orgId, provider, model, apiKey? }
//                              → save YOUR key. apiKey optional on update so
//                                the model can change without re-pasting.
//   POST   { action: "test" }  → live 1-line call so a bad key fails HERE,
//                                not on someone's first real question.
//   DELETE { orgId }           → remove your connection.
//
// Auth mirrors /api/storage/*: bearer session + active org membership.
//
// Every live call this route makes — the test, the embeddings test, and the
// verify-on-save of a new key — runs through lib/ai/aiGates and is metered
// under the `connectionTest` op (GOV-7): the allowlist for that key's kind
// (GOV-6: the embeddings key on ALLOWED_EMBEDDING_PROVIDERS), the monthly
// cap, and a reservation settled to the provider's counts. The agreement gate
// is waived for these calls ONLY, in writing (GOV-11 done-when 4): each is a
// key-liveness probe that sends a fixed sentence ("Connection test.") and no
// org content. A member at their cap cannot run a test; a NEW key may still
// be verified while saving (key rotation must never be blocked by the cap) as
// a de-minimis exemption, at most DE_MINIMIS_VERIFIES_PER_HOUR an hour,
// metered all the same. The exemption is for a member who has SPENT their
// cap — never for one whose cap is $0: a locked member is allowed no spend on
// any gate (GOV-3), so a new key cannot be checked, or saved, until the lock
// is lifted. A test against the SAVED key uses the saved model —
// a body-supplied model rides only with a body-supplied key (GOV-7).
// GOV-12: a production server without EXPORT_ENCRYPTION_KEY refuses to store
// a key (checked before any verify call is spent), and the GET reports
// whether keys are sealed so the settings page can say so.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callAiModel, AiCallError, type AiProviderId } from "@/lib/ai/providerCall";
import { ALLOWED_PROVIDERS, ALLOWED_EMBEDDING_PROVIDERS, PROVIDER_BLOCK_MESSAGE, type AiUsage } from "@/lib/ai/pricing";
import { embedPassages, defaultEmbeddingModel, type EmbeddingProviderId } from "@/lib/ai/embeddings";
import {
  sealAiKey, openAiKey, isSealedAiKey, aiKeyStorageReady, aiKeyCryptoConfigured, aiKeyPlaintextRefused,
} from "@/lib/ai/keyVault";
import { assertAiGates, type AiGateConnection, type AiReservation } from "@/lib/ai/aiGates";
import { GovernedCallError } from "@/lib/ai/gateError";
import { recordAskUsage } from "@/lib/ai/usageServer";
import { isControllerPrincipal } from "@/lib/permissions";
import type { Role } from "@/types/schema";

// GOV-6: the embeddings key's allowlist is pricing.ts's second list — the
// picker (lib/ai/embeddings EMBEDDING_PROVIDERS) offers a subset of it.
const EMBEDDING_PROVIDER_IDS: readonly string[] = ALLOWED_EMBEDDING_PROVIDERS;

/** The meter line every live call from this route is written under. */
const CONNECTION_TEST_OP = "connectionTest";
/** The fixed probe: no org content ever rides a connection test. */
const PROBE = { system: "You are a connection test. Reply with exactly: OK", user: "Connection test." } as const;
const PROBE_MAX_TOKENS = 500;
/** Verify-on-save calls allowed per hour while the member is at their cap. */
const DE_MINIMIS_VERIFIES_PER_HOUR = 5;

export const runtime = "nodejs";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

// The ONLY providers a key may be saved or tested for. Providers that can
// train on submitted data never get in the door.
const providerBlocked = (provider: AiProviderId | undefined) =>
  !provider || !ALLOWED_PROVIDERS.includes(provider);

async function authMember(req: NextRequest, orgId: string) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (error || !user) return null;
  const { data: member } = await supabaseAdmin
    .from("org_members").select("uid, role, roles, display_name, email")
    .eq("org_id", orgId).eq("uid", user.id).eq("status", "active")
    .maybeSingle();
  if (!member) return null;
  return {
    userId: user.id,
    name: (member.display_name as string) || (member.email as string) || "Member",
    // The controller tier by the held collection (DEC-35: through the helper).
    isController: isControllerPrincipal({ role: member.role as Role, roles: (member.roles as Role[] | null) ?? [] }),
  };
}

type Row = {
  user_id: string | null; provider: string; model: string; key_last4: string | null;
  updated_at: string;
  embedding_provider?: string | null; embedding_model?: string | null;
  embedding_key_last4?: string | null;
};
const mask = (r: Row | null) =>
  r ? {
    provider: r.provider, model: r.model, keyLast4: r.key_last4, updatedAt: r.updated_at,
    embeddingProvider: r.embedding_provider ?? null,
    embeddingModel: r.embedding_model ?? null,
    embeddingKeyLast4: r.embedding_key_last4 ?? null,
  } : null;

/** Embedding columns arrive with migration 20260930. Read them when present,
 *  fall back cleanly when not — an un-migrated workspace must still be able to
 *  manage its chat key. */
const CONN_BASE = "user_id, provider, model, key_last4, updated_at";
const CONN_FULL = `${CONN_BASE}, embedding_provider, embedding_model, embedding_key_last4`;
const columnMissing = (e: { code?: string; message: string } | null) =>
  !!e && (e.code === "42703" || /column/i.test(e.message));

const ZERO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0 };

/** GOV-12: how many stored keys (chat + embeddings) are NOT sealed, counted
 *  in the database — no key leaves it for this. Scoped to one member when
 *  `userId` is given. null when the count could not be read. */
async function countUnsealed(orgId: string, userId?: string): Promise<number | null> {
  let chat = supabaseAdmin.from("ai_connections").select("id", { count: "exact", head: true })
    .eq("org_id", orgId).not("api_key", "like", "encv1:%");
  let emb = supabaseAdmin.from("ai_connections").select("id", { count: "exact", head: true })
    .eq("org_id", orgId).not("embedding_api_key", "is", null).not("embedding_api_key", "like", "encv1:%");
  if (userId) { chat = chat.eq("user_id", userId); emb = emb.eq("user_id", userId); }
  const [a, b] = await Promise.all([chat, emb]);
  if (a.error) return null;
  // a database without the embeddings columns has no embeddings keys to count
  return (a.count ?? 0) + (b.error ? 0 : (b.count ?? 0));
}

/** One probe call, gated: under the cap it is reserved like any call; at the
 *  cap a probe that VERIFIES A NEW KEY on save runs as a de-minimis exemption
 *  (at most DE_MINIMIS_VERIFIES_PER_HOUR an hour) so a capped member can
 *  still rotate a key, and a plain test is refused. A LOCKED ($0) member is
 *  refused outright — the exemption never admits spend the lock forbids.
 *  Returns the reservation (null under the exemption — metered after with
 *  recordAskUsage) or the refusal to send. */
async function gateProbe(input: {
  orgId: string; userId: string; key: "chat" | "embedding"; connection: AiGateConnection;
  inputChars: number; maxTokens: number; verifyOnSave: boolean;
}): Promise<{ reservation: AiReservation | null } | { refuse: NextResponse }> {
  try {
    const gate = await assertAiGates({
      orgId: input.orgId, userId: input.userId, op: CONNECTION_TEST_OP, key: input.key,
      requireAgreement: false, // liveness probe, no org content (GOV-11 done-when 4)
      connection: input.connection,
    });
    return { reservation: await gate.reserve({ inputChars: input.inputChars, maxTokens: input.maxTokens }) };
  } catch (e) {
    if (!(e instanceof GovernedCallError)) throw e;
    if (e.status === 402 && e.details?.locked === true && input.verifyOnSave) {
      return { refuse: bad(`${e.message} A new key can't be checked while AI is locked for you, so it was not saved.`, 402) };
    }
    if (e.status !== 402 || !input.verifyOnSave) return { refuse: bad(e.message, e.status) };
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const { count, error } = await supabaseAdmin.from("ai_usage_events").select("id", { count: "exact", head: true })
      .eq("org_id", input.orgId).eq("user_id", input.userId).eq("op", CONNECTION_TEST_OP).gte("created_at", since);
    if (error) return { refuse: bad(`AI usage can't be read right now, so the new key can't be checked: ${error.message}`, 503) };
    if ((count ?? 0) >= DE_MINIMIS_VERIFIES_PER_HOUR) {
      return {
        refuse: bad(`${e.message} A new key can still be checked while you're at your cap, but only `
          + `${DE_MINIMIS_VERIFIES_PER_HOUR} times an hour — try again later.`, 429),
      };
    }
    return { reservation: null };
  }
}

/** Meter a probe: settle its reservation, or record it under the exemption. */
async function meterProbe(orgId: string, userId: string, reservation: AiReservation | null, conn: AiGateConnection, usage: AiUsage, ok: boolean) {
  if (reservation) { await reservation.settle({ usage, ok }); return; }
  await recordAskUsage({ orgId, userId, provider: conn.provider, model: conn.model, usage, ok, op: CONNECTION_TEST_OP })
    .catch(() => undefined);
}

export async function GET(req: NextRequest) {
  const orgId = (req.nextUrl.searchParams.get("orgId") ?? "").trim();
  if (!orgId) return bad("orgId is required");
  const auth = await authMember(req, orgId);
  if (!auth) return bad("Unauthorized", 401);

  const read = (columns: string) => supabaseAdmin
    .from("ai_connections").select(columns)
    .eq("org_id", orgId).eq("user_id", auth.userId).maybeSingle();
  let res = await read(CONN_FULL);
  if (columnMissing(res.error)) res = await read(CONN_BASE);
  const { data, error } = res;
  if (error) {
    // Never swallow this — an empty modal with no reason is undiagnosable.
    const missing = error.code === "42P01" || /does not exist/i.test(error.message);
    return bad(
      missing
        ? "The ai_connections table doesn't exist yet — run migration 20260911 in Supabase, then reopen this dialog."
        : `Couldn't load your connection: ${error.message}`,
      missing ? 424 : 500,
    );
  }
  const personal = mask((data as Row | null) ?? null);
  // GOV-12: is key storage encrypted here, and are any stored keys not?
  const [yoursUnsealed, orgUnsealed] = await Promise.all([
    countUnsealed(orgId, auth.userId),
    auth.isController ? countUnsealed(orgId) : Promise.resolve(undefined),
  ]);
  return NextResponse.json({
    org: null,                               // workspace keys are retired
    personal,
    effective: personal,
    canManageOrg: auth.isController,
    keyStorage: {
      encrypted: aiKeyCryptoConfigured(),
      plaintextRefused: aiKeyPlaintextRefused(),
      yoursUnsealed,
      ...(orgUnsealed !== undefined ? { orgUnsealed } : {}),
    },
  });
}

export async function POST(req: NextRequest) {
  let body: {
    orgId?: string; scope?: string; provider?: string; model?: string;
    apiKey?: string; action?: string;
    embeddingProvider?: string; embeddingModel?: string; embeddingApiKey?: string;
    clearEmbedding?: boolean;
  };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  if (!orgId) return bad("orgId is required");
  const auth = await authMember(req, orgId);
  if (!auth) return bad("Unauthorized", 401);

  if (body.scope === "org") {
    return bad("Workspace keys are retired — everyone uses their own personal API key.", 410);
  }

  // ── Test: run a real 1-line call on the saved (or provided) connection ──
  if (body.action === "test") {
    let connection: AiGateConnection;
    const bodyKey = body.apiKey?.trim();
    if (bodyKey) {
      const provider = body.provider as AiProviderId | undefined;
      const model = body.model?.trim();
      if (!provider || !model) return bad("provider, model and apiKey are required to test.");
      if (providerBlocked(provider)) return bad(PROVIDER_BLOCK_MESSAGE, 403);
      connection = { provider, model, apiKey: bodyKey };
    } else {
      const { data: row } = await supabaseAdmin
        .from("ai_connections").select("provider, model, api_key")
        .eq("org_id", orgId).eq("user_id", auth.userId).maybeSingle();
      if (!row) return bad("No key saved yet — enter one first.", 404);
      // GOV-7: the SAVED key is tested on the SAVED model — a body-supplied
      // model never rides a saved key.
      if (providerBlocked(row.provider as AiProviderId)) return bad(PROVIDER_BLOCK_MESSAGE, 403);
      connection = { provider: String(row.provider), model: String(row.model), apiKey: openAiKey(row.api_key as string) };
    }
    if (!connection.apiKey) return bad("provider, model and apiKey are required to test.");
    const gated = await gateProbe({
      orgId, userId: auth.userId, key: "chat", connection,
      inputChars: PROBE.system.length + PROBE.user.length, maxTokens: PROBE_MAX_TOKENS, verifyOnSave: false,
    });
    if ("refuse" in gated) return gated.refuse;
    try {
      const out = await callAiModel({
        provider: connection.provider as AiProviderId, model: connection.model, apiKey: connection.apiKey,
        system: PROBE.system, user: PROBE.user, maxTokens: PROBE_MAX_TOKENS,
      });
      await meterProbe(orgId, auth.userId, gated.reservation, connection, out.usage, true);
      return NextResponse.json({ ok: true, reply: out.text.slice(0, 80) });
    } catch (e) {
      await meterProbe(orgId, auth.userId, gated.reservation, connection, ZERO_USAGE, false);
      const err = e as AiCallError;
      return bad(err.message, err.status >= 400 && err.status < 600 ? err.status : 502);
    }
  }

  // ── Test the embeddings key: one real 1-word embed call, so a bad key
  //    fails HERE with a clear message instead of at index-build time. ──────
  if (body.action === "embedding-test") {
    let ep = String(body.embeddingProvider ?? "").trim();
    let model = String(body.embeddingModel ?? "").trim();
    let key = String(body.embeddingApiKey ?? "").trim();
    if (!key) {
      const { data: row } = await supabaseAdmin
        .from("ai_connections")
        .select("embedding_provider, embedding_model, embedding_api_key")
        .eq("org_id", orgId).eq("user_id", auth.userId).maybeSingle();
      if (!row?.embedding_api_key) return bad("No embeddings key saved yet — paste one first.", 404);
      // The saved key is tested on the saved provider and model (GOV-7).
      ep = String(row.embedding_provider ?? "");
      model = String(row.embedding_model ?? "");
      key = openAiKey(row.embedding_api_key as string);
    }
    if (!EMBEDDING_PROVIDER_IDS.includes(ep)) {
      return bad("Embeddings provider must be Voyage AI or OpenAI.", 400);
    }
    const connection: AiGateConnection = {
      provider: ep, model: model || defaultEmbeddingModel(ep as EmbeddingProviderId), apiKey: key,
    };
    const gated = await gateProbe({
      orgId, userId: auth.userId, key: "embedding", connection,
      inputChars: "connection test".length, maxTokens: 0, verifyOnSave: false,
    });
    if ("refuse" in gated) return gated.refuse;
    try {
      const out = await embedPassages({
        provider: ep as EmbeddingProviderId,
        model: connection.model,
        apiKey: key,
        passages: ["connection test"],
        kind: "query",
      });
      await meterProbe(orgId, auth.userId, gated.reservation, connection, out.usage, true);
      return NextResponse.json({ ok: true });
    } catch (e) {
      await meterProbe(orgId, auth.userId, gated.reservation, connection, ZERO_USAGE, false);
      const err = e as { message?: string; status?: number };
      return bad(err.message || "The embeddings provider rejected the call.",
        err.status && err.status >= 400 && err.status < 600 ? err.status : 502);
    }
  }

  // ── Save YOUR embedding key (separate service, separate key) ────────────
  if (body.action === "embedding") {
    const ep = String(body.embeddingProvider ?? "").trim();
    if (body.clearEmbedding) {
      const { error } = await supabaseAdmin.from("ai_connections").update({
        embedding_provider: null, embedding_model: null,
        embedding_api_key: null, embedding_key_last4: null,
      }).eq("org_id", orgId).eq("user_id", auth.userId);
      if (error) return bad(`Couldn't remove the embeddings key: ${error.message}`, 500);
      return NextResponse.json({ ok: true });
    }
    if (!EMBEDDING_PROVIDER_IDS.includes(ep)) {
      return bad("Embeddings provider must be Voyage AI or OpenAI.", 400);
    }
    const key = String(body.embeddingApiKey ?? "").trim();
    const readRow = (columns: string) => supabaseAdmin
      .from("ai_connections").select(columns).eq("org_id", orgId).eq("user_id", auth.userId).maybeSingle();
    let rowRes = await readRow("id, embedding_api_key");
    if (columnMissing(rowRes.error)) rowRes = await readRow("id");
    const row = rowRes.data as { id: string; embedding_api_key?: string | null } | null;
    if (!row) {
      return bad("Save your chat API key first — the embeddings key attaches to it.", 409);
    }
    // Verify a NEW key with a real embed call before storing it. A key that
    // saves is a key that works — no more discovering a typo at index-build.
    if (key) {
      // GOV-12: never spend a verify call on a key this server won't keep.
      const ready = aiKeyStorageReady();
      if (!ready.ok) return bad(ready.error, 503);
      const model = String(body.embeddingModel ?? "").trim() || defaultEmbeddingModel(ep as EmbeddingProviderId);
      const connection: AiGateConnection = { provider: ep, model, apiKey: key };
      const gated = await gateProbe({
        orgId, userId: auth.userId, key: "embedding", connection,
        inputChars: "connection test".length, maxTokens: 0, verifyOnSave: true,
      });
      if ("refuse" in gated) return gated.refuse;
      try {
        const out = await embedPassages({
          provider: ep as EmbeddingProviderId,
          model,
          apiKey: key,
          passages: ["connection test"],
          kind: "query",
        });
        await meterProbe(orgId, auth.userId, gated.reservation, connection, out.usage, true);
      } catch (e) {
        await meterProbe(orgId, auth.userId, gated.reservation, connection, ZERO_USAGE, false);
        const err = e as { message?: string };
        return bad(`That key didn't work, so it was NOT saved: ${err.message || "the provider rejected the call."}`, 400);
      }
    }
    // GOV-12: a plaintext key from before encryption was configured is
    // re-sealed the next time its owner saves, new key or not.
    const reseal = !key && !!row.embedding_api_key && !isSealedAiKey(row.embedding_api_key) && aiKeyCryptoConfigured();
    const { error } = await supabaseAdmin.from("ai_connections").update({
      embedding_provider: ep,
      embedding_model: String(body.embeddingModel ?? "").trim() || null,
      ...(key ? { embedding_api_key: sealAiKey(key), embedding_key_last4: key.slice(-4) } : {}),
      ...(reseal ? { embedding_api_key: sealAiKey(row.embedding_api_key as string) } : {}),
      updated_at: new Date().toISOString(),
    }).eq("id", row.id as string);
    if (error) {
      return bad(
        columnMissing(error)
          ? "Meaning-based search needs migration 20260930 — run it in Supabase, then try again."
          : `Couldn't save the embeddings key: ${error.message}`,
        columnMissing(error) ? 424 : 500,
      );
    }
    await supabaseAdmin.from("audit_logs").insert({
      action: "AI_EMBEDDING_KEY_SAVED",
      resource_type: "ai_connection", resource_id: orgId,
      org_id: orgId, user_id: auth.userId,
      details: { provider: ep, keyChanged: !!key, resealed: reseal },
    }).then(() => undefined, () => undefined);
    return NextResponse.json({ ok: true, encrypted: aiKeyCryptoConfigured() });
  }

  // ── Save YOUR key ───────────────────────────────────────────────────────
  const provider = body.provider as AiProviderId;
  const model = String(body.model ?? "").trim();
  const apiKey = String(body.apiKey ?? "").trim();
  if (providerBlocked(provider)) return bad(PROVIDER_BLOCK_MESSAGE, 403);
  if (!model) return bad("model is required");

  const { data: existing } = await supabaseAdmin
    .from("ai_connections").select("id, api_key")
    .eq("org_id", orgId).eq("user_id", auth.userId).maybeSingle();

  if (!apiKey && !existing) return bad("An API key is required.");

  // Verify a NEW key with a real 1-line call before storing it, so a saved
  // key is always a working key. Model-only updates skip this (no new key).
  if (apiKey) {
    // GOV-12: never spend a verify call on a key this server won't keep.
    const ready = aiKeyStorageReady();
    if (!ready.ok) return bad(ready.error, 503);
    const connection: AiGateConnection = { provider, model, apiKey };
    const gated = await gateProbe({
      orgId, userId: auth.userId, key: "chat", connection,
      inputChars: PROBE.system.length + PROBE.user.length, maxTokens: PROBE_MAX_TOKENS, verifyOnSave: true,
    });
    if ("refuse" in gated) return gated.refuse;
    try {
      const out = await callAiModel({
        provider, model, apiKey,
        system: PROBE.system, user: PROBE.user, maxTokens: PROBE_MAX_TOKENS,
      });
      await meterProbe(orgId, auth.userId, gated.reservation, connection, out.usage, true);
    } catch (e) {
      await meterProbe(orgId, auth.userId, gated.reservation, connection, ZERO_USAGE, false);
      const err = e as AiCallError;
      return bad(`That key didn't work, so it was NOT saved: ${err.message}`,
        err.status >= 400 && err.status < 600 ? err.status : 502);
    }
  }

  // GOV-12: a plaintext key from before encryption was configured is
  // re-sealed the next time its owner saves, new key or not.
  const storedKey = (existing?.api_key as string | null | undefined) ?? null;
  const reseal = !apiKey && !!storedKey && !isSealedAiKey(storedKey) && aiKeyCryptoConfigured();
  const fields = {
    provider, model,
    ...(apiKey ? { api_key: sealAiKey(apiKey), key_last4: apiKey.slice(-4) } : {}),
    ...(reseal ? { api_key: sealAiKey(storedKey as string) } : {}),
    created_by: auth.userId,
    created_by_name: auth.name,
    updated_at: new Date().toISOString(),
  };
  const { error } = existing
    ? await supabaseAdmin.from("ai_connections").update(fields).eq("id", existing.id as string)
    : await supabaseAdmin.from("ai_connections").insert({ org_id: orgId, user_id: auth.userId, ...fields });
  if (error) return bad(`Couldn't save the connection: ${error.message}`, 500);

  await supabaseAdmin.from("audit_logs").insert({
    action: "AI_CONNECTION_SAVED",
    resource_type: "ai_connection", resource_id: orgId,
    org_id: orgId, user_id: auth.userId,
    details: { scope: "personal", provider, model, keyChanged: !!apiKey, resealed: reseal },
  }).then(() => undefined, () => undefined);

  return NextResponse.json({ ok: true, encrypted: aiKeyCryptoConfigured() });
}

export async function DELETE(req: NextRequest) {
  let body: { orgId?: string; scope?: string };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  if (!orgId) return bad("orgId is required");
  const auth = await authMember(req, orgId);
  if (!auth) return bad("Unauthorized", 401);
  if (body.scope === "org") {
    return bad("Workspace keys are retired — nothing to remove.", 410);
  }
  const { error } = await supabaseAdmin
    .from("ai_connections").delete()
    .eq("org_id", orgId).eq("user_id", auth.userId);
  if (error) return bad(`Couldn't remove the connection: ${error.message}`, 500);
  return NextResponse.json({ ok: true });
}
