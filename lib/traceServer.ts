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
import { LOCATE_SYSTEM, buildLocateUser, buildRelocateUser, parseLocateResponse } from "@/lib/drawingLocate";
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
  /** Tagged components sitting ON the traced route, ordered from -> to.
   *  Read by a vision pass over the path drawn on the sheet, because
   *  vision-ingested tags carry no coordinates to measure against. */
  alongRoute: string[];
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
    turns: null, points: [], note, alongRoute: [],
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
      const noteText = (cached.note as string | null) ?? "";
      const alongMatch = /Along the route: (.+)$/m.exec(noteText);
      return {
        found: true, method: "measured", documentId, documentName: docName, page,
        turns: (cached.turns as number | null) ?? null, points,
        note: "Measured from the sheet's line-work (cached from an earlier trace)."
          + (alongMatch ? ` ${alongMatch[0]}` : ""),
        alongRoute: alongMatch ? alongMatch[1].split(",").map((t) => t.trim()).filter(Boolean) : [],
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
  let traced = tracePipeOnRaster(raster, { x: from.nx, y: from.ny }, { x: to.nx, y: to.ny });

  // ZERO pipe ends near a tag means its position is wrong, not that the
  // pipe is missing — seen live when a locate answer pointed at the
  // equipment summary row along the top of the sheet, a spot with no pipes
  // at all. One more locate round, telling the model exactly what was wrong
  // with its first answer, fixes precisely that case.
  if (!traced.ok
    && (traced.diagnostics.startCandidates === 0 || traced.diagnostics.goalCandidates === 0)) {
    const suspect: Record<string, [number, number]> = {};
    if (traced.diagnostics.startCandidates === 0) suspect[fromTag] = [from.nx, from.ny];
    if (traced.diagnostics.goalCandidates === 0) suspect[toTag] = [to.nx, to.ny];
    const { data: conn3 } = await supabaseAdmin
      .from("ai_connections").select("provider, model, api_key")
      .eq("org_id", orgId).eq("user_id", userId).maybeSingle();
    if (conn3 && ALLOWED_PROVIDERS.includes(conn3.provider as AiProviderId)) {
      try {
        const provider = conn3.provider as AiProviderId;
        const visionModel = VISION_MODEL[provider] ?? (conn3.model as string);
        const out = await callAiModel({
          provider, model: visionModel, apiKey: openAiKey(conn3.api_key as string),
          system: LOCATE_SYSTEM,
          user: buildRelocateUser(Object.keys(suspect), docName, page, suspect),
          maxTokens: 400,
          images: [{ base64: png.toString("base64"), mediaType: "image/png" }],
          timeoutMs: 30_000,
        });
        await recordAskUsage({
          orgId, userId, provider, model: visionModel, usage: out.usage, ok: true, op: "drawingLocate",
        });
        for (const pos of parseLocateResponse(out.text, Object.keys(suspect))) {
          ends.set(pos.tag, { nx: pos.nx, ny: pos.ny });
        }
        const f2 = ends.get(fromTag)!, t2 = ends.get(toTag)!;
        traced = tracePipeOnRaster(raster, { x: f2.nx, y: f2.ny }, { x: t2.nx, y: t2.ny });
      } catch { /* keep the first refusal */ }
    }
  }
  if (!traced.ok) {
    return fail(
      `Followed the line-work on ${docName} page ${page} but couldn't connect ${fromTag} to ${toTag}: `
      + traced.reason, docName);
  }
  const points: TracePoint[] = traced.points.map((p) => ({ nx: p.x, ny: p.y }));

  // What sits ON the route. The question that makes tracing useful is rarely
  // "are these connected" — it is "what is BETWEEN them": the first PSV, the
  // block valves, the check valve someone forgot. The route is measured, but
  // the components along it have no stored coordinates (vision ingestion
  // reads tags without positions), so this draws the measured path onto the
  // sheet and has the vision model read the tags it passes through — the one
  // job vision is reliably good at, reading labels at known locations.
  let alongRoute: string[] = [];
  try {
    const { data: conn2 } = await supabaseAdmin
      .from("ai_connections").select("provider, model, api_key")
      .eq("org_id", orgId).eq("user_id", userId).maybeSingle();
    if (conn2 && ALLOWED_PROVIDERS.includes(conn2.provider as AiProviderId)) {
      const provider = conn2.provider as AiProviderId;
      const visionModel = VISION_MODEL[provider] ?? (conn2.model as string);
      const { createCanvas, loadImage } = await import("@napi-rs/canvas");
      const image = await loadImage(png);
      const canvas = createCanvas(image.width, image.height);
      const octx = canvas.getContext("2d");
      octx.drawImage(image, 0, 0);
      octx.strokeStyle = "rgba(255, 80, 0, 0.85)";
      octx.lineWidth = Math.max(6, image.width / 400);
      octx.lineJoin = "round";
      octx.beginPath();
      points.forEach((pt, i) => {
        const x = pt.nx * image.width, y = pt.ny * image.height;
        if (i === 0) octx.moveTo(x, y); else octx.lineTo(x, y);
      });
      octx.stroke();
      const out = await callAiModel({
        provider, model: visionModel, apiKey: openAiKey(conn2.api_key as string),
        system:
          "You read process drawings. An orange route is drawn on this P&ID. List ONLY the tagged "
          + "components (valves, PSVs, instruments, equipment) that sit DIRECTLY ON the orange route, "
          + "in order from the start tag to the end tag. Respond with a comma-separated list of tags "
          + "and nothing else. If none, respond NONE.",
        user: `Route from ${fromTag} to ${toTag} on ${docName} page ${page}.`,
        maxTokens: 300,
        images: [{ base64: canvas.toBuffer("image/png").toString("base64"), mediaType: "image/png" }],
        timeoutMs: 30_000,
      });
      await recordAskUsage({
        orgId, userId, provider, model: visionModel, usage: out.usage, ok: true, op: "drawingLocate",
      });
      const txt = out.text.trim();
      if (txt && !/^none/i.test(txt)) {
        alongRoute = txt.split(",").map((t) => t.trim().toUpperCase())
          .filter((t) => t.length >= 2 && t.length <= 24 && /\d/.test(t))
          .slice(0, 30);
      }
    }
  } catch { /* components are a bonus — the measured route stands alone */ }

  const note = `Measured from the sheet's line-work: ${points.length} waypoints, ${traced.turns} turn(s).`
    + (alongRoute.length > 0 ? `\nAlong the route: ${alongRoute.join(", ")}` : "");
  try {
    await supabaseAdmin.from("knowledge_line_traces").upsert({
      org_id: orgId, document_id: documentId, page,
      from_tag: fromTag, to_tag: toTag, points, note, method: "raster", turns: traced.turns,
    }, { onConflict: "document_id,page,from_tag,to_tag" });
  } catch { /* cache best-effort */ }
  return {
    found: true, method: "measured", documentId, documentName: docName, page,
    turns: traced.turns, points, note, alongRoute,
  };
}

/** Sheets where a tag of ANY kind appears — equipment for vessel tags,
 *  opc for connector box numbers. */
async function pagesWith(
  orgId: string, tag: string, kinds: string[],
): Promise<Array<{ documentId: string; page: number }>> {
  const { data } = await supabaseAdmin
    .from("knowledge_page_entities")
    .select("document_id, page")
    .eq("org_id", orgId).eq("tag", tag).in("kind", kinds).limit(500);
  const seen = new Set<string>();
  const out: Array<{ documentId: string; page: number }> = [];
  for (const r of (data ?? []) as Array<{ document_id: string; page: number }>) {
    const k = `${r.document_id}#${r.page}`;
    if (!seen.has(k)) { seen.add(k); out.push({ documentId: r.document_id, page: r.page }); }
  }
  return out;
}

export interface CrossSheetTrace {
  found: boolean;
  /** Each leg is one sheet's measured route; leg N ends at the off-page
   *  connector that leg N+1 starts from. */
  legs: SheetTraceResult[];
  /** Connector box number(s) the route hops through, in order. */
  connectors: string[];
  note: string;
}

/** A line that leaves the sheet does it through an OFF-PAGE CONNECTOR — a
 *  numbered box at the sheet edge, with the same number printed on the
 *  continuation sheet. That is drafting's own mechanism for multi-sheet
 *  routes, and following it is what the human eye does: trace to the
 *  pennant, find the matching pennant, keep going. One hop supported —
 *  fromTag's sheet -> shared connector -> toTag's sheet. */
export async function traceAcrossSheets(opts: {
  orgId: string; userId: string; fromTag: string; toTag: string;
}): Promise<CrossSheetTrace> {
  const { orgId, userId, fromTag, toTag } = opts;
  const [fromPages, toPages] = await Promise.all([
    pagesWith(orgId, fromTag, ["equipment"]),
    pagesWith(orgId, toTag, ["equipment"]),
  ]);
  if (fromPages.length === 0 || toPages.length === 0) {
    const missing = [fromPages.length === 0 ? fromTag : null, toPages.length === 0 ? toTag : null]
      .filter(Boolean).join(" and ");
    return { found: false, legs: [], connectors: [],
      note: `${missing} appears on no indexed sheet, so there is nothing to trace from.` };
  }

  // Connector numbers on each side's page, then the intersection: a box
  // number printed on BOTH sheets is drafting saying "this line continues".
  const opcsOn = async (documentId: string, page: number): Promise<Set<string>> => {
    const { data } = await supabaseAdmin
      .from("knowledge_page_entities")
      .select("tag")
      .eq("document_id", documentId).eq("page", page).eq("kind", "opc").limit(300);
    return new Set(((data ?? []) as Array<{ tag: string }>).map((r) => r.tag));
  };

  const attempts: string[] = [];
  for (const fp of fromPages.slice(0, 2)) {
    for (const tp of toPages.slice(0, 2)) {
      const [fromOpcs, toOpcs] = await Promise.all([
        opcsOn(fp.documentId, fp.page), opcsOn(tp.documentId, tp.page)]);
      const shared = [...fromOpcs].filter((c) => toOpcs.has(c));
      if (shared.length === 0) continue;
      for (const connector of shared.slice(0, 3)) {
        const leg1 = await traceTagsOnSheet({
          orgId, userId, documentId: fp.documentId, page: fp.page,
          fromTag, toTag: connector,
        });
        if (!leg1.found) { attempts.push(`${leg1.documentName} p.${leg1.page} (${fromTag}->box ${connector}): ${leg1.note}`); continue; }
        const leg2 = await traceTagsOnSheet({
          orgId, userId, documentId: tp.documentId, page: tp.page,
          fromTag: connector, toTag,
        });
        if (!leg2.found) { attempts.push(`${leg2.documentName} p.${leg2.page} (box ${connector}->${toTag}): ${leg2.note}`); continue; }
        return {
          found: true, legs: [leg1, leg2], connectors: [connector],
          note: `The line leaves ${leg1.documentName} page ${leg1.page} through off-page connector `
            + `${connector} and continues on ${leg2.documentName} page ${leg2.page}. Both legs are `
            + "measured from the drawn line-work.",
        };
      }
    }
  }
  return {
    found: false, legs: [], connectors: [],
    note: attempts.length > 0
      ? `Cross-sheet route attempted via shared off-page connectors but no complete path was confirmed:\n`
        + attempts.slice(0, 4).map((a) => `- ${a}`).join("\n")
      : `${fromTag} and ${toTag} share no page and their sheets share no off-page connector number, `
        + "so no continuation could be followed.",
  };
}

/** The ask-time entry: tags only, no sheet required. Tries every sheet whose
 *  entity index carries both tags (capped), returns the first measured route
 *  plus an honest account of the sheets that refused. */
export async function traceTagsAnywhere(opts: {
  orgId: string; userId: string; fromTag: string; toTag: string; maxSheets?: number;
}): Promise<{
  result: SheetTraceResult | null; tried: SheetTraceResult[]; candidates: number;
  cross?: CrossSheetTrace;
}> {
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
  // No single sheet worked — the line may LEAVE its sheet. Follow the
  // off-page connectors, the way the drawing itself says to.
  const cross = await traceAcrossSheets(opts);
  return { result: null, tried, candidates: sheets.length, cross };
}
