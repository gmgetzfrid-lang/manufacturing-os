// GET/POST /api/cron/embed-drain — background continuation of meaning-index
// builds, so a 25,000-passage library doesn't depend on a browser tab
// surviving for hours.
//
// CONSENT MODEL: the cron never decides to spend anyone's key. Starting a
// build in the UI stamps the library with WHO started it (ai_features.
// embedBuild.userId); this drain only continues libraries carrying that
// stamp, on that user's own embedding key, metered to them like every other
// call. The stamp clears when the library reaches 100% (or when the key
// disappears).
//
// TRIGGERS — both are wired, either alone suffices:
//   - vercel.json cron (hourly where the plan allows it)
//   - a fire-and-forget nudge from the knowledge library page on load, so
//     merely opening the app advances the index for up to ~4 minutes
//
// Auth: CRON_SECRET bearer (platform cron) OR a signed-in user — a user
// trigger drains only the orgs they belong to.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { embeddingConnectionFrom } from "@/lib/ai/embeddings";
import { openAiKey } from "@/lib/ai/keyVault";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import {
  embedLibrarySlice, setEmbedBuildMarker, unembeddedCount,
} from "@/lib/knowledgeEmbedCore";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Whole-run budget: stop starting new work at 240s so every library's last
 *  slice commits and the response returns inside maxDuration. */
const RUN_BUDGET_MS = 240_000;
/** Per-slice loop budget / in-flight hard stop, relative to slice start. */
const SLICE_BUDGET_MS = 45_000;
const SLICE_HARD_STOP_MS = 55_000;
/** Paced batch once a free-tier TPM limit shows itself: ~20 chunks ≈ 8K
 *  tokens, sized to fit Voyage's no-card 10K tokens/minute window. */
const PACED_BATCH = 20;
const FULL_BATCH = 64;

async function handle(req: NextRequest) {
  const startedAt = Date.now();
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const cronSecret = process.env.CRON_SECRET || "";

  // Who may trigger: the platform cron, or a signed-in member (scoped).
  let scopeOrgIds: string[] | null = null; // null = all orgs (cron)
  if (!cronSecret || bearer !== cronSecret) {
    if (!bearer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(bearer);
    if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data: memberships } = await supabaseAdmin
      .from("org_members").select("org_id")
      .eq("uid", user.id).eq("status", "active");
    scopeOrgIds = ((memberships ?? []) as Array<{ org_id: string }>).map((m) => m.org_id);
    if (scopeOrgIds.length === 0) return NextResponse.json({ drained: [] });
  }

  // Libraries carrying the consent stamp.
  let q = supabaseAdmin
    .from("knowledge_libraries")
    .select("id, org_id, ai_features")
    .not("ai_features->embedBuild", "is", null)
    .limit(6);
  if (scopeOrgIds) q = q.in("org_id", scopeOrgIds);
  const { data: libs, error: libErr } = await q;
  if (libErr) return NextResponse.json({ error: libErr.message }, { status: 500 });

  const drained: Array<{ libraryId: string; embedded: number; remaining: number; note?: string }> = [];
  for (const lib of (libs ?? []) as Array<{ id: string; org_id: string; ai_features: Record<string, unknown> }>) {
    if (Date.now() - startedAt > RUN_BUDGET_MS) break;
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
    // or the run budget says stop. 429s wait out the provider's minute.
    let embedded = 0;
    let paced = false;
    const usage = { inputTokens: 0, outputTokens: 0 };
    for (;;) {
      const left = RUN_BUDGET_MS - (Date.now() - startedAt);
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
        if (RUN_BUDGET_MS - (Date.now() - startedAt) < 85_000) break; // no room to wait out the window
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

  return NextResponse.json({ drained, ranMs: Date.now() - startedAt });
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
