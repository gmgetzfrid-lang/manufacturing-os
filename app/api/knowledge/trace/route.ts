// /api/knowledge/trace — run a highlighter along a pipe on a drawing sheet.
//
//   POST { orgId, documentId, page, fromTag, toTag, lineNumber? }
//        → { found, points: [{nx, ny}...], note, source: "cache" | "vision" }
//
// The model looks at the rendered sheet and follows the drawn line between
// the two tags, reporting waypoints the viewer strokes over the page like a
// yellow highlighter. Costs one vision call the first time; the path is
// cached per (document, page, from, to) so the second person pays nothing.
// A reversed ask (B → A) reuses the cached A → B path backwards.
//
// The cache table (migration 20261007) is OPTIONAL — without it every trace
// simply re-runs the vision call. Never a hard failure over a cache.
//
// ACL: the same fail-closed check as every other knowledge read.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openAiKey } from "@/lib/ai/keyVault";
import { loadPrincipal, readableControlledDocIds } from "@/lib/knowledgeAccess";
import { callAiModel, type AiProviderId } from "@/lib/ai/providerCall";
import { ALLOWED_PROVIDERS } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import { VISION_MODEL } from "@/lib/knowledgeVision";
import { TRACE_SYSTEM, buildTraceUser, parseTraceResponse, type TracePoint } from "@/lib/drawingTrace";
import { ensurePdfPolyfills } from "@/lib/knowledgeText";
import { r2, R2_BUCKET } from "@/lib/r2";
import { GetObjectCommand } from "@aws-sdk/client-s3";

export const runtime = "nodejs";
export const maxDuration = 60;

/** One page render + one model call has to fit comfortably. */
const TRACE_BUDGET_MS = 45_000;

/** Snap a trace endpoint onto the tag's known marker position when they're
 *  already telling the same story — the marker is the more-refined point. */
const SNAP_DISTANCE = 0.12;

/** Same normalization as locate, plus stripping anything that isn't tag
 *  material — these strings go into a PostgREST or() filter, where a stray
 *  comma or paren changes the query's meaning. */
const canonical = (tag: string): string =>
  tag.toUpperCase().replace(/[\s–]+/g, "-").replace(/-+/g, "-")
    .replace(/[^A-Z0-9/-]/g, "").trim();

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Unauthorized", 401);

  let body: {
    orgId?: string; documentId?: string; page?: number;
    fromTag?: string; toTag?: string; lineNumber?: string;
  };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const documentId = String(body.documentId ?? "").trim();
  const page = Number(body.page ?? 0);
  const fromTag = canonical(String(body.fromTag ?? ""));
  const toTag = canonical(String(body.toTag ?? ""));
  const lineNumber = String(body.lineNumber ?? "").trim() || null;
  if (!orgId || !documentId || !page || !fromTag || !toTag) {
    return bad("orgId, documentId, page, fromTag and toTag are required");
  }
  if (fromTag === toTag) return bad("Pick two different tags to trace between.");

  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not a member of this workspace", 403);

  const { data: doc } = await supabaseAdmin
    .from("knowledge_documents")
    .select("id, org_id, name, file_key, source_document_id")
    .eq("id", documentId).eq("org_id", orgId).maybeSingle();
  if (!doc) return bad("Sheet not found", 404);

  // Fail closed: a mirrored controlled document obeys the source's ACL.
  if (doc.source_document_id) {
    try {
      const readable = await readableControlledDocIds(principal, [doc.source_document_id as string]);
      if (!readable.has(doc.source_document_id as string)) return bad("Not permitted", 403);
    } catch {
      return bad("Not permitted", 403);
    }
  }

  // ── Cached trace (either direction) — best-effort, table is optional ───
  try {
    const { data: cached } = await supabaseAdmin
      .from("knowledge_line_traces")
      .select("from_tag, to_tag, points, note")
      .eq("document_id", documentId).eq("page", page)
      .or(`and(from_tag.eq.${fromTag},to_tag.eq.${toTag}),and(from_tag.eq.${toTag},to_tag.eq.${fromTag})`)
      .limit(1).maybeSingle();
    if (cached?.points && Array.isArray(cached.points) && (cached.points as TracePoint[]).length >= 2) {
      const points = cached.from_tag === fromTag
        ? (cached.points as TracePoint[])
        : [...(cached.points as TracePoint[])].reverse();
      return NextResponse.json({
        found: true, points, note: (cached.note as string | null) ?? null, source: "cache",
      });
    }
  } catch { /* no cache table yet — trace live */ }

  // ── Vision trace ───────────────────────────────────────────────────────
  const { data: conn } = await supabaseAdmin
    .from("ai_connections").select("provider, model, api_key")
    .eq("org_id", orgId).eq("user_id", user.id).maybeSingle();
  if (!conn || !ALLOWED_PROVIDERS.includes(conn.provider as AiProviderId)) {
    return bad(
      "Tracing a line needs your own AI key (add one in AI settings) — the model has to look at the sheet.",
      412,
    );
  }
  const provider = conn.provider as AiProviderId;
  const [spent, cap] = await Promise.all([getMonthUsage(orgId, user.id), getCapUsd(orgId, user.id)]);
  if (cap > 0 && spent.spentUsd >= cap) {
    return bad(
      `Monthly AI budget reached ($${spent.spentUsd.toFixed(2)} of $${cap.toFixed(2)}) — it resets on the 1st.`,
      402,
    );
  }

  try {
    ensurePdfPolyfills();
    const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: doc.file_key as string }));
    const bytes = new Uint8Array(await new Response(obj.Body as ReadableStream).arrayBuffer());
    const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    // Wider than locate's render: following thin line-work through crossings
    // needs more pixels than spotting a printed label does.
    const img = await renderPageAsImage(pdf, page, {
      width: 2200,
      canvasImport: () => import("@napi-rs/canvas"),
    });
    const out = await callAiModel({
      provider,
      model: VISION_MODEL[provider] ?? (conn.model as string),
      apiKey: openAiKey(conn.api_key as string),
      system: TRACE_SYSTEM,
      user: buildTraceUser({ fromTag, toTag, lineNumber, documentName: doc.name as string, page }),
      maxTokens: 1500,
      images: [{ base64: Buffer.from(img as ArrayBuffer).toString("base64"), mediaType: "image/png" }],
      timeoutMs: Math.max(5_000, startedAt + TRACE_BUDGET_MS - Date.now()),
    });
    await recordAskUsage({
      orgId, userId: user.id, provider,
      model: VISION_MODEL[provider] ?? (conn.model as string),
      usage: out.usage, ok: true, op: "drawingTrace",
    });

    const trace = parseTraceResponse(out.text);
    if (!trace.found) {
      return NextResponse.json({
        found: false, points: [], source: "vision",
        note: trace.note ?? "The model couldn't confidently follow that line on this sheet — try zooming into the region, or trace a shorter hop (tag to the next tag).",
      });
    }

    // Anchor the ends onto the tags' known marker positions when both agree
    // they're in the same neighborhood — the marker has been crop-refined,
    // so it's the better point for where the stroke should terminate.
    try {
      const { data: entRows } = await supabaseAdmin
        .from("knowledge_page_entities")
        .select("tag, nx, ny")
        .eq("document_id", documentId).eq("page", page).in("tag", [fromTag, toTag]);
      for (const r of (entRows ?? []) as Array<{ tag: string; nx: number | null; ny: number | null }>) {
        if (r.nx === null || r.ny === null) continue;
        const end = r.tag === fromTag ? trace.points[0] : trace.points[trace.points.length - 1];
        if (Math.hypot(end.nx - r.nx, end.ny - r.ny) <= SNAP_DISTANCE) {
          end.nx = r.nx; end.ny = r.ny;
        }
      }
    } catch { /* markers are an enhancement; the trace stands on its own */ }

    // Cache for the next viewer — best-effort, the table may not exist yet.
    try {
      await supabaseAdmin.from("knowledge_line_traces").upsert(
        {
          org_id: orgId, document_id: documentId, page,
          from_tag: fromTag, to_tag: toTag,
          points: trace.points, note: trace.note,
        },
        { onConflict: "document_id,page,from_tag,to_tag" },
      );
    } catch { /* re-tracing next time costs one small call — acceptable */ }

    return NextResponse.json({
      found: true, points: trace.points, note: trace.note, source: "vision",
    });
  } catch (e) {
    return bad(`Couldn't trace that line: ${(e as Error).message}`, 502);
  }
}
