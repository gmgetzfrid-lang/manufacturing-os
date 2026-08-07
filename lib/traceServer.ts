// lib/traceServer.ts — trace a line between two tags, callable from ANYWHERE.
//
// The pixel tracer existed for months behind exactly one door: clicking two
// tags in the sheet viewer. Asking "what connects X-16 to V-16?" in plain
// words went to a DIFFERENT tracer that only knows which tags share a page —
// it has never seen a line. So the question the whole feature exists to
// answer could not be asked in the way people actually ask it.
//
// This is the viewer route's trace core, extracted so the ask-time
// orchestrator can call it as a tool. Same physics, same honesty contract:
//   measured  — the route follows the sheet's actual line-work
//   estimated — a vision model guessed, and the answer says so
//   refused   — the geometry couldn't be sure; refusal beats a confident
//               stroke down the wrong pipe
//
// The caller doesn't have to know the sheet. Given only two tags, the entity
// index says which pages carry both, and each candidate page is tried in
// turn — that is what turns "trace P-58 to V-16" from a viewer gesture into
// a question.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openAiKey } from "@/lib/ai/keyVault";
import { callAiModel, type AiProviderId } from "@/lib/ai/providerCall";
import { ALLOWED_PROVIDERS } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import { VISION_MODEL } from "@/lib/knowledgeVision";
import { LOCATE_SYSTEM, buildLocateUser, parseLocateResponse } from "@/lib/drawingLocate";
import { binarize, tracePipeOnRaster } from "@/lib/pipeTrace";
import { ensurePdfPolyfills } from "@/lib/knowledgeText";
import { r2, R2_BUCKET } from "@/lib/r2";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { TracePoint } from "@/lib/drawingTrace";

const RENDER_WIDTH = 3000;

export interface SheetTraceResult {
  found: boolean;
  /** "measured" = followed real line-work; "none" = refused/not found. */
  method: "measured" | "none";
  documentId: string;
  documentName: string;
  page: number;
  turns: number | null;
  points: TracePoint[];
  /** Plain-language account of what happened — success or refusal alike. */
  note: string;
}

/** Documents in this org's knowledge layer whose entity index carries BOTH
 *  tags on the SAME page — the sheets worth trying, best-first. */
export async function sheetsCarryingBoth(
  orgId: string, fromTag: string, toTag: string,
): Promise<Array<{ documentId: string; documentName: string; page: number }>> {
  const { data } = await supabaseAdmin
    .from("knowledge_page_entities")
    .select("document_id, page, tag")
    .eq("org_id", orgId)
    .in("tag", [fromTag, toTag])
    .eq("kind", "equipment")
    .limit(4000);
  const byDocPage = new Map<string, Set<string>>();
  for (const r of (data ?? []) as Array<{ document_id: string; page: number; tag: string }>) {
    const key = `${r.document_id}#${r.page}`;
    byDocPage.set(key, (byDocPage.get(key) ?? new Set()).add(r.tag));
  }
  const hits: Array<{ documentId: string; page: number }> = [];
  for (const [key, tags] of byDocPage) {
    if (tags.size === 2) {
      const [documentId, page] = key.split("#");
      hits.push({ documentId, page: Number(page) });
    }
  }
  if (hits.length === 0) return [];
  const { data: docs } = await supabaseAdmin
    .from("knowledge_documents").select("id, name")
    .in("id", [...new Set(hits.map((h) => h.documentId))]);
  const names = new Map(((docs ?? []) as Array<{ id: string; name: string }>)
    .map((d) => [d.id, d.name]));
  return hits
    .filter((h) => names.has(h.documentId))
    .map((h) => ({ documentId: h.documentId, documentName: names.get(h.documentId)!, page: h.page }));
}

/** Trace between two tags on one sheet. Mirrors the viewer route's core —
 *  cache, stored markers, vision locate for missing endpoints, then the
 *  raster tracer — minus the HTTP shell. */
export async function traceTagsOnSheet(opts: {
  orgId: string;
  userId: string;
  documentId: string;
  page: number;
  fromTag: string;
  toTag: string;
}): Promise<SheetTraceResult> {
  const { orgId, userId, documentId, page, fromTag, toTag } = opts;
  const fail = (note: string, documentName = ""): SheetTraceResult => ({
    found: false, method: "none", documentId, documentName, page,
    turns: null, points: [], note,
  });

  const { data: doc } = await supabaseAdmin
    .from("knowledge_documents")
    .select("id, org_id, name, file_key")
    .eq("id", documentId).eq("org_id", orgId).maybeSingle();
  if (!doc) return fail("Sheet not found in this workspace.");
  const docName = doc.name as string;

  // Cached trace, either direction — the viewer route shares this table.
  try {
    const { data: cached } = await supabaseAdmin
      .from("knowledge_line_traces")
      .select("from_tag, to_tag, points, note, method, turns")
      .eq("document_id", documentId).eq("page", page)
      .or(`and(from_tag.eq.${fromTag},to_tag.eq.${toTag}),and(from_tag.eq.${toTag},to_tag.eq.${fromTag})`)
      .limit(1).maybeSingle();
    if (cached?.points && Array.isArray(cached.points) && (cached.points as TracePoint[]).length >= 2
      && (cached.method as string) === "raster") {
      const points = cached.from_tag === fromTag
        ? (cached.points as TracePoint[])
        : [...(cached.points as TracePoint[])].reverse();
      return {
        found: true, method: "measured", documentId, documentName: docName, page,
        turns: (cached.turns as number | null) ?? null, points,
        note: "Measured from the sheet's line-work (cached from an earlier trace).",
      };
    }
  } catch { /* cache table optional */ }

  // Render the sheet.
  let png: Buffer; let width = 0; let height = 0;
  let pixels: Uint8ClampedArray;
  try {
    ensurePdfPolyfills();
    const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: doc.file_key as string }));
    const bytes = new Uint8Array(await new Response(obj.Body as ReadableStream).arrayBuffer());
    const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const img = await renderPageAsImage(pdf, page, {
      width: RENDER_WIDTH, canvasImport: () => import("@napi-rs/canvas"),
    });
    png = Buffer.from(img as ArrayBuffer);
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const image = await loadImage(png);
    width = image.width; height = image.height;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    pixels = ctx.getImageData(0, 0, width, height).data as unknown as Uint8ClampedArray;
  } catch (e) {
    return fail(`Couldn't render ${docName} page ${page}: ${(e as Error).message}`, docName);
  }

  // Endpoints: stored markers first, vision locate only for what's missing.
  const ends = new Map<string, { nx: number; ny: number }>();
  try {
    const { data: entRows } = await supabaseAdmin
      .from("knowledge_page_entities")
      .select("tag, nx, ny")
      .eq("document_id", documentId).eq("page", page).in("tag", [fromTag, toTag]);
    for (const r of (entRows ?? []) as Array<{ tag: string; nx: number | null; ny: number | null }>) {
      if (r.nx !== null && r.ny !== null && !ends.has(r.tag)) ends.set(r.tag, { nx: r.nx, ny: r.ny });
    }
  } catch { /* markers optional */ }

  const missing = [fromTag, toTag].filter((t) => !ends.has(t));
  if (missing.length > 0) {
    const { data: conn } = await supabaseAdmin
      .from("ai_connections").select("provider, model, api_key")
      .eq("org_id", orgId).eq("user_id", userId).maybeSingle();
    const hasKey = !!conn && ALLOWED_PROVIDERS.includes(conn.provider as AiProviderId);
    if (!hasKey) {
      return fail(
        `No stored position for ${missing.join(" and ")} on ${docName} page ${page}, and locating `
        + "needs an AI key (add one in AI settings).", docName);
    }
    const [spent, cap] = await Promise.all([getMonthUsage(orgId, userId), getCapUsd(orgId, userId)]);
    if (cap > 0 && spent.spentUsd >= cap) {
      return fail("Locating the tags needs AI budget that's already spent this month.", docName);
    }
    const provider = conn!.provider as AiProviderId;
    const visionModel = VISION_MODEL[provider] ?? (conn!.model as string);
    try {
      const out = await callAiModel({
        provider, model: visionModel, apiKey: openAiKey(conn!.api_key as string),
        system: LOCATE_SYSTEM,
        user: buildLocateUser(missing, docName, page),
        maxTokens: 400,
        images: [{ base64: png.toString("base64"), mediaType: "image/png" }],
        timeoutMs: 30_000,
      });
      await recordAskUsage({
        orgId, userId, provider, model: visionModel, usage: out.usage, ok: true, op: "drawingLocate",
      });
      for (const p of parseLocateResponse(out.text, missing)) ends.set(p.tag, { nx: p.nx, ny: p.ny });
    } catch { /* fall through */ }
  }

  const from = ends.get(fromTag);
  const to = ends.get(toTag);
  if (!from || !to) {
    const still = [fromTag, toTag].filter((t) => !ends.has(t));
    return fail(`Couldn't find ${still.join(" and ")} on ${docName} page ${page}.`, docName);
  }

  const raster = binarize(pixels, width, height);
  const traced = tracePipeOnRaster(raster, { x: from.nx, y: from.ny }, { x: to.nx, y: to.ny });
  if (!traced.ok) {
    return fail(
      `Followed the line-work on ${docName} page ${page} but couldn't connect ${fromTag} to ${toTag}: `
      + traced.reason, docName);
  }
  const points: TracePoint[] = traced.points.map((p) => ({ nx: p.x, ny: p.y }));
  try {
    await supabaseAdmin.from("knowledge_line_traces").upsert({
      org_id: orgId, document_id: documentId, page,
      from_tag: fromTag, to_tag: toTag, points, note: null, method: "raster", turns: traced.turns,
    }, { onConflict: "document_id,page,from_tag,to_tag" });
  } catch { /* cache best-effort */ }
  return {
    found: true, method: "measured", documentId, documentName: docName, page,
    turns: traced.turns, points,
    note: `Measured from the sheet's line-work: ${points.length} waypoints, ${traced.turns} turn(s).`,
  };
}

/** The ask-time entry: tags only, no sheet required. Tries every sheet whose
 *  entity index carries both tags (capped), returns the first measured route
 *  plus an honest account of the sheets that refused. */
export async function traceTagsAnywhere(opts: {
  orgId: string; userId: string; fromTag: string; toTag: string; maxSheets?: number;
}): Promise<{ result: SheetTraceResult | null; tried: SheetTraceResult[]; candidates: number }> {
  const sheets = await sheetsCarryingBoth(opts.orgId, opts.fromTag, opts.toTag);
  const tried: SheetTraceResult[] = [];
  for (const s of sheets.slice(0, opts.maxSheets ?? 3)) {
    const r = await traceTagsOnSheet({
      orgId: opts.orgId, userId: opts.userId,
      documentId: s.documentId, page: s.page,
      fromTag: opts.fromTag, toTag: opts.toTag,
    });
    tried.push(r);
    if (r.found) return { result: r, tried, candidates: sheets.length };
  }
  return { result: null, tried, candidates: sheets.length };
}
