// /api/knowledge/trace — follow a pipe run on a drawing sheet.
//
//   POST { orgId, documentId, page, fromTag, toTag }
//        → { found, points: [{nx, ny}...], note, method, source }
//
// TWO WAYS TO ANSWER, AND THEY ARE NOT EQUAL:
//
//   method "raster" — the real one. Render the sheet, vectorize its
//     line-work into horizontal/vertical strokes, and walk the junction
//     network from one tag to the other, going straight through crossings
//     and turning only at real branches (lib/pipeTrace.ts). The corners in
//     the answer are corners in the DRAWING. No model is in this loop.
//
//   method "vision" — the fallback. The model looks at the page and
//     estimates waypoints. Useful when the sheet is a scan too rough to
//     vectorize, and useless as a route: it is labeled as an estimate
//     everywhere it surfaces, because a guessed path over a P&ID reads as
//     authoritative and someone isolates a line based on it.
//
// The endpoints come from the tag markers already stored per page; when a
// tag has no marker yet the model locates it once (that IS what vision is
// good at) and the raster tracer takes it from there.
//
// Costs one page render either way; cached per document/page/from/to so the
// second person to ask pays nothing. ACL: fail-closed, like every read.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openAiKey } from "@/lib/ai/keyVault";
import { loadPrincipal, readableControlledDocIds } from "@/lib/knowledgeAccess";
import { callAiModel, type AiProviderId } from "@/lib/ai/providerCall";
import { ALLOWED_PROVIDERS } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import { VISION_MODEL } from "@/lib/knowledgeVision";
import type { TracePoint } from "@/lib/drawingTrace";
import {
  LOCATE_SYSTEM, buildLocateUser, buildRelocateUser, parseLocateResponse,
} from "@/lib/drawingLocate";
import { binarize, tracePipeOnRaster } from "@/lib/pipeTrace";
import { ensurePdfPolyfills } from "@/lib/knowledgeText";
import { r2, R2_BUCKET } from "@/lib/r2";
import { GetObjectCommand } from "@aws-sdk/client-s3";

export const runtime = "nodejs";
export const maxDuration = 60;

const TRACE_BUDGET_MS = 50_000;

/** Wide enough that a thin CAD pipe survives as a countable stroke — at this
 *  width a 0.5 mm line on an E-size sheet is ~2 px, and title-block text is
 *  well under the minimum run length so it filters itself out. */
const RENDER_WIDTH = 3000;

/** Snap a traced endpoint onto the tag's stored marker when they already
 *  agree — the marker has been crop-refined, so it is the better terminus. */
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
    fromTag?: string; toTag?: string;
    /** Return the vectorized line-work so the viewer can draw what the
     *  tracer actually sees. Tuning a vectorizer against drawings nobody
     *  can look at is guesswork; this makes a failure visible in one
     *  screenshot instead of a paragraph of speculation. */
    debug?: boolean;
  };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const documentId = String(body.documentId ?? "").trim();
  const page = Number(body.page ?? 0);
  const fromTag = canonical(String(body.fromTag ?? ""));
  const toTag = canonical(String(body.toTag ?? ""));
  const debug = body.debug === true;
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
      .select("from_tag, to_tag, points, note, method, turns")
      .eq("document_id", documentId).eq("page", page)
      .or(`and(from_tag.eq.${fromTag},to_tag.eq.${toTag}),and(from_tag.eq.${toTag},to_tag.eq.${fromTag})`)
      .limit(1).maybeSingle();
    // A debug run must re-vectorize — the whole point is seeing the line-work.
    if (!debug && cached?.points && Array.isArray(cached.points) && (cached.points as TracePoint[]).length >= 2) {
      const points = cached.from_tag === fromTag
        ? (cached.points as TracePoint[])
        : [...(cached.points as TracePoint[])].reverse();
      return NextResponse.json({
        found: true, points,
        note: (cached.note as string | null) ?? null,
        method: (cached.method as string | null) ?? "vision",
        turns: (cached.turns as number | null) ?? null,
        source: "cache",
      });
    }
  } catch { /* no cache table yet — trace live */ }

  // ── Render the sheet once; both methods read from this image ──────────
  let pngBuffer: Buffer;
  try {
    ensurePdfPolyfills();
    const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: doc.file_key as string }));
    const bytes = new Uint8Array(await new Response(obj.Body as ReadableStream).arrayBuffer());
    const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const img = await renderPageAsImage(pdf, page, {
      width: RENDER_WIDTH,
      canvasImport: () => import("@napi-rs/canvas"),
    });
    pngBuffer = Buffer.from(img as ArrayBuffer);
  } catch (e) {
    return bad(`Couldn't render that sheet to trace it: ${(e as Error).message}`, 502);
  }

  // ── Endpoints: stored markers first, model only for what's missing ────
  const ends = new Map<string, { nx: number; ny: number }>();
  try {
    const { data: entRows } = await supabaseAdmin
      .from("knowledge_page_entities")
      .select("tag, nx, ny")
      .eq("document_id", documentId).eq("page", page).in("tag", [fromTag, toTag]);
    for (const r of (entRows ?? []) as Array<{ tag: string; nx: number | null; ny: number | null }>) {
      if (r.nx !== null && r.ny !== null && !ends.has(r.tag)) ends.set(r.tag, { nx: r.nx, ny: r.ny });
    }
  } catch { /* markers are optional — the model can find them */ }

  const { data: conn } = await supabaseAdmin
    .from("ai_connections").select("provider, model, api_key")
    .eq("org_id", orgId).eq("user_id", user.id).maybeSingle();
  const hasKey = !!conn && ALLOWED_PROVIDERS.includes(conn.provider as AiProviderId);
  const provider = conn?.provider as AiProviderId | undefined;
  const visionModel = provider ? (VISION_MODEL[provider] ?? (conn!.model as string)) : null;

  let budgetOk = true;
  if (hasKey) {
    const [spent, cap] = await Promise.all([getMonthUsage(orgId, user.id), getCapUsd(orgId, user.id)]);
    budgetOk = !(cap > 0 && spent.spentUsd >= cap);
  }

  const b64 = pngBuffer.toString("base64");
  const missing = [fromTag, toTag].filter((t) => !ends.has(t));
  if (missing.length > 0) {
    if (!hasKey || !budgetOk) {
      return bad(
        `No stored position for ${missing.join(" and ")} on this sheet, and locating ${missing.length === 1 ? "it" : "them"} needs `
        + (hasKey ? "AI budget that's already spent this month." : "your own AI key (add one in AI settings)."),
        hasKey ? 402 : 412,
      );
    }
    try {
      const out = await callAiModel({
        provider: provider!, model: visionModel!, apiKey: openAiKey(conn!.api_key as string),
        system: LOCATE_SYSTEM,
        user: buildLocateUser(missing, doc.name as string, page),
        maxTokens: 400,
        images: [{ base64: b64, mediaType: "image/png" }],
        timeoutMs: Math.max(5_000, startedAt + TRACE_BUDGET_MS - Date.now()),
      });
      await recordAskUsage({
        orgId, userId: user.id, provider: provider!, model: visionModel!,
        usage: out.usage, ok: true, op: "drawingLocate",
      });
      for (const p of parseLocateResponse(out.text, missing)) ends.set(p.tag, { nx: p.nx, ny: p.ny });
    } catch { /* fall through to the check below */ }
  }

  const from = ends.get(fromTag);
  const to = ends.get(toTag);
  if (!from || !to) {
    const stillMissing = [fromTag, toTag].filter((t) => !ends.has(t));
    return NextResponse.json({
      found: false, points: [], method: "none", source: "live",
      note: `Couldn't find ${stillMissing.join(" and ")} on this sheet, so there's nothing to trace between. `
        + "Check the tag spelling, or open the sheet where that tag actually lives.",
    });
  }

  // ── The real trace: follow the drawn line ─────────────────────────────
  let rasterNote: string | null = null;
  let rasterCached: import("@/lib/pipeTrace").Raster | null = null;
  let lastDiag: { startCandidates: number; goalCandidates: number } | null = null;
  /** Populated on a debug run: every stroke the vectorizer found, as page
   *  fractions, plus the counts behind whatever happened. */
  let debugPayload: {
    lineWork: Array<{ x1: number; y1: number; x2: number; y2: number }>;
    segments: number;
    truncated: boolean;
    diagnostics: {
      nodes: number; startCandidates: number; goalCandidates: number;
      crossingStyle: "break" | "unknown"; crossingBreaks: number;
    };
    from: { nx: number; ny: number };
    to: { nx: number; ny: number };
  } | null = null;
  const DEBUG_SEGMENT_CAP = 6000;
  try {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const img = await loadImage(pngBuffer);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, img.width, img.height);
    const raster = binarize(pixels.data as unknown as Uint8ClampedArray, img.width, img.height);

    rasterCached = raster;
    const traced = tracePipeOnRaster(
      raster,
      { x: from.nx, y: from.ny },
      { x: to.nx, y: to.ny },
    );
    lastDiag = traced.diagnostics;
    if (debug) {
      const shown = traced.lineWork.slice(0, DEBUG_SEGMENT_CAP);
      debugPayload = {
        lineWork: shown.map((s) => (s.horizontal
          ? { x1: s.a / raster.width, y1: s.c / raster.height, x2: s.b / raster.width, y2: s.c / raster.height }
          : { x1: s.c / raster.width, y1: s.a / raster.height, x2: s.c / raster.width, y2: s.b / raster.height })),
        segments: traced.segments,
        truncated: traced.lineWork.length > shown.length,
        diagnostics: traced.diagnostics,
        from, to,
      };
    }
    if (traced.ok) {
      const points: TracePoint[] = traced.points.map((p) => ({ nx: p.x, ny: p.y }));
      // Terminate on the refined markers when the walk already ends near them.
      for (const [tag, mark] of [[fromTag, from], [toTag, to]] as const) {
        const end = tag === fromTag ? points[0] : points[points.length - 1];
        if (Math.hypot(end.nx - mark.nx, end.ny - mark.ny) <= SNAP_DISTANCE) {
          end.nx = mark.nx; end.ny = mark.ny;
        }
      }
      if (!debug) {
        await cacheTrace(orgId, documentId, page, fromTag, toTag, points, null, "raster", traced.turns);
      }
      return NextResponse.json({
        found: true, points, note: null, method: "raster", turns: traced.turns, source: "live",
        debug: debugPayload,
      });
    }
    rasterNote = traced.reason;
    // Numbers beat adjectives when something didn't work.
    if (traced.diagnostics.nodes > 0) {
      rasterNote += ` (found ${traced.segments.toLocaleString()} strokes, `
        + `${traced.diagnostics.startCandidates} pipe end(s) near ${fromTag} and `
        + `${traced.diagnostics.goalCandidates} near ${toTag})`;
    }
  } catch (e) {
    rasterNote = `Couldn't read the sheet's line-work: ${(e as Error).message}`;
  }

  // ── One relocate retry, then an HONEST refusal ────────────────────────
  //
  // The vision waypoint fallback is gone, deliberately. It was the original
  // approach, and the header of pipeTrace.ts records the verdict: spatial
  // coordinate regression over thin line-work is the thing vision models
  // are worst at. In production it drew a confident wrong path on a real
  // drawing — "Estimated, not followed" labels notwithstanding, a drawn
  // stroke gets read as the route. A refusal with reasons is the only
  // honest failure.
  //
  // What vision IS still used for: pointing at a tag. And when the raster
  // trace reports ZERO pipe ends near one endpoint, the position was wrong
  // — the observed case put a tag in the equipment summary row, a spot with
  // no pipes — so one more locate round with that feedback often fixes it.
  if (hasKey && budgetOk && lastDiag
    && (lastDiag.startCandidates === 0 || lastDiag.goalCandidates === 0)) {
    try {
      const suspect: Record<string, [number, number]> = {};
      if (lastDiag.startCandidates === 0) suspect[fromTag] = [from.nx, from.ny];
      if (lastDiag.goalCandidates === 0) suspect[toTag] = [to.nx, to.ny];
      const out = await callAiModel({
        provider: provider!, model: visionModel!, apiKey: openAiKey(conn!.api_key as string),
        system: LOCATE_SYSTEM,
        user: buildRelocateUser(Object.keys(suspect), doc.name as string, page, suspect),
        maxTokens: 400,
        images: [{ base64: b64, mediaType: "image/png" }],
        timeoutMs: Math.max(5_000, startedAt + TRACE_BUDGET_MS - Date.now()),
      });
      await recordAskUsage({
        orgId, userId: user.id, provider: provider!, model: visionModel!,
        usage: out.usage, ok: true, op: "drawingLocate",
      });
      for (const p of parseLocateResponse(out.text, Object.keys(suspect))) {
        ends.set(p.tag, { nx: p.nx, ny: p.ny });
      }
      const f2 = ends.get(fromTag)!, t2 = ends.get(toTag)!;
      const retraced = tracePipeOnRaster(rasterCached!, { x: f2.nx, y: f2.ny }, { x: t2.nx, y: t2.ny });
      if (retraced.ok) {
        const points: TracePoint[] = retraced.points.map((p) => ({ nx: p.x, ny: p.y }));
        await cacheTrace(orgId, documentId, page, fromTag, toTag, points, null, "raster", retraced.turns);
        return NextResponse.json({
          found: true, points, note: null, method: "raster", turns: retraced.turns, source: "live",
          debug: debugPayload,
        });
      }
      rasterNote = retraced.reason
        + ` (after re-locating ${Object.keys(suspect).join(", ")} — the first position had no pipe near it)`;
    } catch { /* fall through to the refusal */ }
  }

  return NextResponse.json({
    found: false, points: [], method: "none", source: "live",
    debug: debugPayload,
    note: rasterNote ?? "Couldn't follow that line on this sheet.",
  });
}

/** Best-effort — the cache table (and its method column) may not exist yet;
 *  re-tracing next time costs one render, never a failed answer. */
async function cacheTrace(
  orgId: string, documentId: string, page: number, fromTag: string, toTag: string,
  points: TracePoint[], note: string | null, method: string, turns: number | null,
) {
  try {
    await supabaseAdmin.from("knowledge_line_traces").upsert(
      {
        org_id: orgId, document_id: documentId, page,
        from_tag: fromTag, to_tag: toTag, points, note, method, turns,
      },
      { onConflict: "document_id,page,from_tag,to_tag" },
    );
  } catch { /* cache is an optimization, never a requirement */ }
}
