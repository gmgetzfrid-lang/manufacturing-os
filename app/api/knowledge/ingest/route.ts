// /api/knowledge/ingest — turn a knowledge document's PDF into searchable
// chunks, one client-driven batch at a time.
//
// A 900-page standard cannot be indexed inside one serverless invocation, so
// the CLIENT drives batches: POST { documentId } repeatedly; each call
// ingests the next PAGE_BATCH pages and reports progress. The loop is
// resumable — a dropped connection or timeout just re-POSTs and picks up at
// pages_indexed. The maintenance cron drains the same queue in the
// background (lib/knowledgeIngest is the single engine for both).
//
// Scanned (image-only) pages yield no text; we count them so the UI can say
// "34 of 900 pages had no extractable text" instead of pretending.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ingestKnowledgeDocBatch, type VisionContext } from "@/lib/knowledgeIngest";
import { ALLOWED_PROVIDERS, estimateCostUsd, type AiUsage } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import type { AiProviderId } from "@/lib/ai/providerCall";

export const runtime = "nodejs";
// Hobby functions are killed at 60s no matter what maxDuration says, so the
// real budget is the one we enforce ourselves — see INVOCATION_BUDGET_MS.
export const maxDuration = 60;

/** Stop and commit with time to spare. A killed invocation writes NOTHING
 *  (every insert happens after the page loop), so pages_indexed wouldn't
 *  advance and the client would re-POST the same range forever — indexing
 *  stuck at zero with a 504 in the console. Finishing early always beats
 *  being killed. */
const INVOCATION_BUDGET_MS = 45_000;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const deadlineMs = Date.now() + INVOCATION_BUDGET_MS;
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !user) return bad("Unauthorized", 401);

  let body: { documentId?: string };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const documentId = String(body.documentId ?? "").trim();
  if (!documentId) return bad("documentId is required");

  const { data: doc } = await supabaseAdmin
    .from("knowledge_documents").select("*").eq("id", documentId).maybeSingle();
  if (!doc) return bad("Document not found", 404);

  // Ingest is a controller action (same bar as adding library documents).
  const { data: member } = await supabaseAdmin
    .from("org_members").select("role, roles")
    .eq("org_id", doc.org_id as string).eq("uid", user.id).eq("status", "active")
    .maybeSingle();
  const roles = new Set<string>([
    (member?.role as string) ?? "", ...(((member?.roles as string[]) ?? [])),
  ]);
  if (!member || (!roles.has("Admin") && !roles.has("DocCtrl"))) {
    return bad("Only Admin or Doc Control can index documents.", 403);
  }

  if (doc.status === "ready") {
    return NextResponse.json({ done: true, pageCount: doc.page_count, pagesIndexed: doc.pages_indexed });
  }

  // ── Vision fallback context ────────────────────────────────────────────
  // Pages with no text layer (AutoCAD SHX exports, scans) get READ by the
  // model. It spends THIS user's key — the person who triggered indexing —
  // metered as its own op and stopped at their monthly cap. No key or no
  // headroom just means text-only indexing, never a failure.
  const orgId = doc.org_id as string;
  // Library option: read EVERY page with vision (drawing sets where even the
  // text layer can't be trusted).
  const { data: libRow } = await supabaseAdmin
    .from("knowledge_libraries").select("ai_features")
    .eq("id", doc.library_id as string).maybeSingle();
  const forceAllPages =
    ((libRow?.ai_features ?? {}) as Record<string, unknown>).visionAllPages === true;
  const visionUsage: AiUsage = { inputTokens: 0, outputTokens: 0 };
  let visionModel = "";
  let vision: VisionContext | undefined;
  let visionSkipReason: string | null = null;
  {
    const { data: conn } = await supabaseAdmin
      .from("ai_connections").select("provider, model, api_key")
      .eq("org_id", orgId).eq("user_id", user.id).maybeSingle();
    const usable = !!conn && ALLOWED_PROVIDERS.includes(conn.provider as AiProviderId);
    if (!usable) {
      visionSkipReason = "Add your AI key in AI settings to read pages that have no text layer.";
    } else {
      const [spent, cap] = await Promise.all([
        getMonthUsage(orgId, user.id),
        getCapUsd(orgId, user.id),
      ]);
      if (cap > 0 && spent.spentUsd >= cap) {
        visionSkipReason = `Monthly AI budget reached ($${spent.spentUsd.toFixed(2)} of $${cap.toFixed(2)}) — ` +
          "pages without a text layer were skipped. They index automatically once the cap resets or is raised.";
      } else {
        vision = {
          provider: conn!.provider as AiProviderId,
          model: conn!.model as string,
          apiKey: conn!.api_key as string,
          // Bounded per invocation: render + transcribe is seconds per page
          // and free-tier functions die at 60s. The client loop continues.
          budgetPages: 4,
          forceAllPages,
          onUsage: (u, model) => {
            visionUsage.inputTokens += u.inputTokens;
            visionUsage.outputTokens += u.outputTokens;
            visionModel = model;
          },
        };
      }
    }
  }

  try {
    const res = await ingestKnowledgeDocBatch({
      id: doc.id as string,
      org_id: orgId,
      library_id: doc.library_id as string,
      name: doc.name as string,
      file_key: doc.file_key as string,
      status: doc.status as string,
      pages_indexed: (doc.pages_indexed as number | null) ?? 0,
      page_count: doc.page_count as number | null,
      last_section: (doc.last_section as string | null) ?? null,
    }, vision, deadlineMs);

    if (visionUsage.inputTokens + visionUsage.outputTokens > 0) {
      await recordAskUsage({
        orgId, userId: user.id,
        provider: vision!.provider, model: visionModel || vision!.model,
        usage: visionUsage, ok: true, op: "knowledgeVision",
      });
    }

    if (res.done) {
      await supabaseAdmin.from("audit_logs").insert({
        action: "KNOWLEDGE_DOC_INDEXED",
        resource_type: "knowledge_document", resource_id: String(doc.id),
        org_id: doc.org_id, user_id: user.id,
        details: { name: doc.name, pages: res.pageCount, visionPages: res.visionPages },
      }).then(() => undefined, () => undefined);
    }

    return NextResponse.json({
      ...res,
      visionSkipReason,
      visionCostUsd: visionUsage.inputTokens + visionUsage.outputTokens > 0
        ? estimateCostUsd(visionModel || vision!.model, visionUsage)
        : 0,
    });
  } catch (e) {
    const message = (e as Error).message;
    await supabaseAdmin.from("knowledge_documents")
      .update({ status: "error", error: message.slice(0, 500) })
      .eq("id", doc.id as string);
    return bad(`Indexing failed: ${message}`, 502);
  }
}
