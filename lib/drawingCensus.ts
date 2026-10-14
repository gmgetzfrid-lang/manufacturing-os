// lib/drawingCensus.ts — SERVER-ONLY. Read a drawing sheet the way the
// chat does, then put the registry right.
//
// The indexer reads text-less sheets with a cheap model, as ONE downscaled
// image, asks for a transcript, and a pattern-matcher guesses which strings
// are equipment. On an E-size P&ID that turns LV-221 into "LU-201" and V-14
// into "V-514", and it cannot tell an equipment callout from an off-sheet
// "FROM X-45" or an instrument bubble. This reader:
//
//   • uses the person's OWN model (the one the chat uses), not a cheap tier;
//   • sends the sheet as an overview plus four overlapping zoomed tiles, so
//     small text is read at full resolution;
//   • asks for STRUCTURE — equipment callouts (tag, site code, name),
//     instruments, off-sheet references, the title block — not a transcript;
//   • stores them as separate kinds ("equipment", "instrument", "xref") and
//     marks the page as read this way ("census"), so a later text pass never
//     overwrites it;
//   • when the sheet is done, corrects the registry for that drawing: tags
//     the old reading put in the equipment column and links it drew that the
//     sheet does not carry are removed, what it does carry is applied.

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ensurePdfPolyfills, chunkPageText, sanitizeStorageText } from "@/lib/knowledgeText";
import { governedAiCall } from "@/lib/ai/governedCall";
import { extractJsonBlock } from "@/lib/orchestrator/protocol";
import { computeForKnowledgeDoc, applyForDocument } from "@/lib/equipmentBridgeServer";
import { resolveEstate } from "@/lib/estate/resolverServer";
import type { AiCallImage } from "@/lib/ai/providerCall";
import { snapshotDoc, recordDocChange, recordReading, type RunCtx } from "@/lib/estate/runJournal";

export interface CensusSheet {
  equipment: Array<{ tag: string; code: string | null; name: string | null; details?: string | null }>;
  instruments: string[];
  offSheet: Array<{ tag: string; direction: "from" | "to" | null; drawing: string | null; sheet: string | null }>;
  title: { drawingNumber: string | null; sheet: string | null; rev: string | null };
  /** Every legible line of the sheet — notes, callouts, title block — so
   *  the reading also feeds full-text search. */
  transcript?: string;
}

export interface CensusPageResult {
  page: number;
  pageCount: number;
  done: boolean;
  sheet: CensusSheet;
  correction?: { removed: string[]; kept: string[]; added: string[]; createdAssets: number; described: number };
  /** False when the undo journal is not installed (migration 20261021). */
  journaled: boolean;
}

const RENDER_WIDTH = 3400;
const OVERLAP = 120;

const SYSTEM =
  "You read ONE sheet of a piping and instrumentation diagram (P&ID) from an industrial plant. " +
  "You get an OVERVIEW image of the whole sheet, then four zoomed TILES of it (top-left, top-right, " +
  "bottom-left, bottom-right) that overlap slightly. Read characters from the tiles; use the overview " +
  "for layout. Return STRICT JSON and nothing else:\n" +
  '{"equipment":[{"tag":"V-14","code":"6110.14","name":"35# STEAM DRUM","details":"4\'-0\\" I.D. x 10\'-0\\" T/T; DESIGN 75 PSIG @ 650 F"}],' +
  '"instruments":["PIT-130","PSV-21","LV-222"],' +
  '"offSheet":[{"tag":"X-45","direction":"from","drawing":"2002-D 2001","sheet":"12"}],' +
  '"title":{"drawingNumber":"2002-D 2001","sheet":"5","rev":"42"},' +
  '"transcript":"every legible line of the sheet, one per line"}\n' +
  "Rules:\n" +
  "- equipment: process equipment whose CALLOUT is printed on this sheet — the tag stacked with its " +
  "description, often with a site code in parentheses and design data (e.g. \"V-14 / (6110.14) / 35# STEAM " +
  "DRUM / 4'-0\\\" I.D. x 10'-0\\\" T/T\"). Vessels, drums, columns, exchangers, pumps, compressors, tanks, " +
  "heaters, filters, packages. One entry per item. code = the parenthesised site code if printed, else null. " +
  "name = the service description if printed, else null. details = the rest of the callout as printed on one " +
  "line — size, design pressure and temperature, capacity, head, duty, materials — separated by \"; \", else null.\n" +
  "- instruments: instrument bubbles (function letters over a loop number — PIT over 130 is \"PIT-130\"), " +
  "relief valves (PSV, PRV), control valves (PV, LV, FV, TV), gauges and switches. Join letters and number " +
  "with one dash.\n" +
  "- offSheet: tags that appear ONLY in off-page connector arrows or FROM / TO notes at the sheet edges — " +
  "they are drawn on other sheets. Never put them in equipment. direction = \"from\" or \"to\" as printed.\n" +
  "- Line numbers, pipe sizes and specs, valve sizes, notes, steam pressures and the sheet's own drawing " +
  "number are none of these.\n" +
  "- transcript: every legible line on the sheet in reading order — callouts, notes, connector text, the " +
  "title block (as DRAWING NO: …, SHEET: n OF m, REV: …, TITLE: …) — separated by newlines. It makes the " +
  "sheet searchable; it is not limited to the items above.\n" +
  "- Copy every character exactly as printed. If you cannot read a character with certainty, leave that " +
  "item out. Never invent an item.";

const normTag = (raw: unknown): string | null => {
  const t = String(raw ?? "").toUpperCase().replace(/[‐-―−–]/g, "-").replace(/\s+/g, "").replace(/^([A-Z]+)-?(\d)/, "$1-$2");
  return /^[A-Z]{1,5}-\d{1,6}[A-Z]{0,3}$/.test(t) ? t : null;
};
const str = (v: unknown, max = 80): string | null => { const s = String(v ?? "").trim(); return s ? s.slice(0, max) : null; };

export function parseCensus(text: string): CensusSheet {
  const block = extractJsonBlock(text);
  const raw = block ? (JSON.parse(block) as Record<string, unknown>) : {};
  const eq = new Map<string, CensusSheet["equipment"][number]>();
  for (const e of Array.isArray(raw.equipment) ? raw.equipment : []) {
    const o = (e ?? {}) as Record<string, unknown>;
    const tag = normTag(o.tag); if (!tag || eq.has(tag)) continue;
    eq.set(tag, { tag, code: str(o.code, 24), name: str(o.name), details: str(o.details, 240) });
  }
  const inst = new Set<string>();
  for (const i of Array.isArray(raw.instruments) ? raw.instruments : []) {
    const tag = normTag(typeof i === "string" ? i : (i as Record<string, unknown>)?.tag);
    if (tag && !eq.has(tag)) inst.add(tag);
  }
  const off = new Map<string, CensusSheet["offSheet"][number]>();
  for (const r of Array.isArray(raw.offSheet) ? raw.offSheet : []) {
    const o = (r ?? {}) as Record<string, unknown>;
    const tag = normTag(o.tag); if (!tag || eq.has(tag) || off.has(tag)) continue;
    const d = String(o.direction ?? "").toLowerCase();
    off.set(tag, { tag, direction: d === "from" || d === "to" ? d : null, drawing: str(o.drawing, 40), sheet: str(o.sheet, 10) });
  }
  const t = (raw.title ?? {}) as Record<string, unknown>;
  const transcript = typeof raw.transcript === "string" ? raw.transcript.slice(0, 20_000) : undefined;
  return { equipment: [...eq.values()], instruments: [...inst], offSheet: [...off.values()], title: { drawingNumber: str(t.drawingNumber, 40), sheet: str(t.sheet, 10), rev: str(t.rev, 10) }, transcript };
}

type PdfProxy = Awaited<ReturnType<typeof import("unpdf")["getDocumentProxy"]>>;

/** The sheet as the model sees it: an overview and four overlapping zoomed
 *  tiles, so small text is read at full resolution. */
export async function renderSheetImages(pdf: PdfProxy, page: number): Promise<{ images: AiCallImage[]; pageCount: number }> {
  ensurePdfPolyfills();
  const { renderPageAsImage } = await import("unpdf");
  const pageCount = pdf.numPages;
  if (page > pageCount) return { images: [], pageCount };
  const canvasMod = await import("@napi-rs/canvas");
  const png = await renderPageAsImage(pdf, page, { width: RENDER_WIDTH, canvasImport: () => import("@napi-rs/canvas") });
  const img = await canvasMod.loadImage(Buffer.from(png as ArrayBuffer));
  const W = img.width, H = img.height;
  const cut = (sx: number, sy: number, sw: number, sh: number, outW: number): AiCallImage => {
    const scale = outW / sw;
    const c = canvasMod.createCanvas(Math.round(sw * scale), Math.round(sh * scale));
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return { mediaType: "image/jpeg", base64: c.toBuffer("image/jpeg", 90).toString("base64") };
  };
  const hw = Math.ceil(W / 2), hh = Math.ceil(H / 2);
  const tw = Math.min(W, hw + OVERLAP), th = Math.min(H, hh + OVERLAP);
  const images: AiCallImage[] = [
    cut(0, 0, W, H, 1500),                                   // overview
    cut(0, 0, tw, th, tw),                                   // top-left
    cut(W - tw, 0, tw, th, tw),                              // top-right
    cut(0, H - th, tw, th, tw),                              // bottom-left
    cut(W - tw, H - th, tw, th, tw),                         // bottom-right
  ];
  return { images, pageCount };
}

/** THE drawing reader. The indexer and "Read with AI" both call this: same
 *  images, same instructions, same structured answer. `call` is whoever
 *  pays — the person's governed key, or the indexer's vision context. */
export async function readDrawingSheet(pdf: PdfProxy, page: number, name: string, call: (args: { system: string; user: string; images: AiCallImage[]; maxTokens: number }) => Promise<string>): Promise<{ sheet: CensusSheet; pageCount: number } | null> {
  const { images, pageCount } = await renderSheetImages(pdf, page);
  if (!images.length) return null;
  const text = await call({
    system: SYSTEM,
    user: `Sheet: "${name}", page ${page} of ${pageCount}. Images in order: overview, top-left, top-right, bottom-left, bottom-right.`,
    images, maxTokens: 8000,
  });
  return { sheet: parseCensus(text), pageCount };
}

/** The rows a reading becomes, in the one storage format both callers use. */
export function sheetEntityRows(base: { org_id: string; library_id: string; document_id: string; page: number }, sheet: CensusSheet): Array<Record<string, unknown>> {
  const b = { ...base, x: null, y: null };
  return [
    ...sheet.equipment.map((e) => ({ ...b, kind: "equipment", tag: e.tag, raw: [e.tag, e.code ? `(${e.code})` : "", e.name ?? "", e.details ? `· ${e.details}` : ""].filter(Boolean).join(" ").slice(0, 400) })),
    ...sheet.instruments.map((t) => ({ ...b, kind: "instrument", tag: t, raw: t })),
    ...sheet.offSheet.map((o) => ({ ...b, kind: "xref", tag: o.tag, raw: [o.direction?.toUpperCase(), o.tag, o.drawing, o.sheet ? `SHT ${o.sheet}` : ""].filter(Boolean).join(" ").slice(0, 160) })),
    { ...b, kind: "census", tag: "census-v1", raw: `${sheet.equipment.length} equipment, ${sheet.instruments.length} instruments, ${sheet.offSheet.length} off-sheet` },
  ];
}

/** Read one page of a knowledge document's drawing and store the result. */
export async function censusPage(input: { orgId: string; userId: string; knowledgeDocId: string; page: number; deadlineMs: number; run: RunCtx }): Promise<CensusPageResult> {
  const { data: kdoc } = await supabaseAdmin.from("knowledge_documents").select("id, org_id, library_id, name, file_key, page_count, source_document_id").eq("id", input.knowledgeDocId).eq("org_id", input.orgId).maybeSingle();
  if (!kdoc) throw new Error("That drawing has no read copy.");
  const k = kdoc as { id: string; library_id: string; name: string; file_key: string; page_count: number | null; source_document_id: string | null };
  const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: k.file_key }));
  const bytes = new Uint8Array(await new Response(obj.Body as ReadableStream).arrayBuffer());
  ensurePdfPolyfills();
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const read = await readDrawingSheet(pdf, input.page, k.name, async (a) => (await governedAiCall({
    orgId: input.orgId, userId: input.userId, op: "drawingCensus", instructionScope: "equipment",
    ...a, timeoutMs: Math.max(15_000, input.deadlineMs - Date.now() - 3_000),
  })).text);
  if (!read) return { page: input.page, pageCount: pdf.numPages, done: true, journaled: true, sheet: { equipment: [], instruments: [], offSheet: [], title: { drawingNumber: null, sheet: null, rev: null } } };
  const { sheet, pageCount } = read;
  // The page's searchable text follows the reading, so search and the tags
  // agree. Only when the transcript says more than what is stored.
  if (sheet.transcript && sheet.transcript.length > 200) {
    const { data: cur } = await supabaseAdmin.from("knowledge_chunks").select("content").eq("document_id", k.id).eq("page", input.page);
    const have = ((cur as Array<{ content: string }> | null) ?? []).reduce((n, c) => n + c.content.length, 0);
    if (sheet.transcript.length > have) {
      await supabaseAdmin.from("knowledge_chunks").delete().eq("document_id", k.id).eq("page", input.page);
      const parts = chunkPageText(sheet.transcript.split("\n").map((l) => sanitizeStorageText(l.trim())).filter(Boolean).join("\n"));
      if (parts.length) await supabaseAdmin.from("knowledge_chunks").insert(parts.map((c, i) => ({ org_id: input.orgId, library_id: k.library_id, document_id: k.id, page: input.page, seq: i, content: c }))).then(() => undefined, () => undefined);
    }
  }

  // Replace this page's reading: equipment, instruments and off-sheet tags
  // from the old reader go; the census marker says this page is read right.
  const { data: prior } = await supabaseAdmin.from("knowledge_page_entities").select("*").eq("document_id", k.id).eq("page", input.page).in("kind", ["equipment", "instrument", "xref", "census"]);
  let journaled = await recordReading(supabaseAdmin, input.orgId, input.run, k.id, k.source_document_id, input.page, (prior as Array<Record<string, unknown>> | null) ?? []);
  await supabaseAdmin.from("knowledge_page_entities").delete().eq("document_id", k.id).eq("page", input.page).in("kind", ["equipment", "instrument", "xref", "census"]);
  const rows = sheetEntityRows({ org_id: input.orgId, library_id: k.library_id, document_id: k.id, page: input.page }, sheet);
  const { error } = await supabaseAdmin.from("knowledge_page_entities").insert(rows);
  if (error) throw new Error(`Could not store the reading: ${error.message}`);

  const done = input.page >= pageCount;
  const res: CensusPageResult = { page: input.page, pageCount, done, sheet, journaled };
  if (done && k.source_document_id) {
    const c = await correctDocument(input.orgId, k.id, k.source_document_id, input.userId, input.run, k.name);
    res.correction = c.correction; journaled = journaled && c.journaled; res.journaled = journaled;
  }
  return res;
}

/** After a sheet is read right: take back what the old reading put on the
 *  document and is not on the sheet, apply what is. */
export async function correctDocument(orgId: string, knowledgeDocId: string, documentId: string, userId: string, run: RunCtx, sheetName: string): Promise<{ correction: NonNullable<CensusPageResult["correction"]>; journaled: boolean }> {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const before = await snapshotDoc(supabaseAdmin, orgId, documentId);
  const { data: ents } = await supabaseAdmin.from("knowledge_page_entities").select("tag").eq("document_id", knowledgeDocId).eq("kind", "equipment").limit(2000);
  const onSheet = new Set(((ents as Array<{ tag: string }> | null) ?? []).map((e) => norm(e.tag)));

  // 1. The equipment column: remove tags the BRIDGE wrote that the sheet
  //    does not carry. Tags a person typed (never in the bridge's applied
  //    list) stay.
  const { data: sug } = await supabaseAdmin.from("document_equipment_suggestions").select("applied").eq("org_id", orgId).eq("document_id", documentId).maybeSingle();
  const appliedBefore: string[] = Array.isArray(sug?.applied) ? (sug!.applied as string[]) : [];
  const wrong = appliedBefore.filter((t) => !onSheet.has(norm(t)));
  const kept = appliedBefore.filter((t) => onSheet.has(norm(t)));
  if (wrong.length) {
    const wrongSet = new Set(wrong.map(norm));
    const { data: doc } = await supabaseAdmin.from("documents").select("library_id, metadata").eq("id", documentId).eq("org_id", orgId).maybeSingle();
    const { data: lib } = doc ? await supabaseAdmin.from("libraries").select("equipment_bridge").eq("id", (doc as { library_id: string }).library_id).maybeSingle() : { data: null };
    const key = (lib?.equipment_bridge as { targetColumnKey?: string } | null)?.targetColumnKey;
    const md = ((doc as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}) as Record<string, unknown>;
    if (key && md[key] !== undefined) {
      const cur = md[key];
      const list = Array.isArray(cur) ? cur.map(String) : typeof cur === "string" ? cur.split(",").map((v) => v.trim()).filter(Boolean) : [];
      const next = list.filter((t) => !wrongSet.has(norm(t)));
      if (next.length !== list.length) await supabaseAdmin.from("documents").update({ metadata: { ...md, [key]: next } }).eq("id", documentId).eq("org_id", orgId);
    }
    await supabaseAdmin.from("document_equipment_suggestions").update({ applied: kept }).eq("org_id", orgId).eq("document_id", documentId);
  }

  // 2. Links drawn from the old reading ("drawn on this sheet") that the
  //    sheet does not carry. Only machine-drawn ones; a person's stay.
  const { data: edges } = await supabaseAdmin.from("estate_edges").select("id, b, origin").eq("org_id", orgId).eq("a", `doc:${documentId}`).eq("type", "tagged_to").in("origin", ["vision", "bridge"]).limit(500);
  const assetIds = ((edges as Array<{ b: string }> | null) ?? []).map((e) => e.b.replace(/^asset:/, ""));
  if (assetIds.length) {
    const { data: assets } = await supabaseAdmin.from("assets").select("id, tag").in("id", assetIds);
    const tagOf = new Map(((assets as Array<{ id: string; tag: string }> | null) ?? []).map((a) => [a.id, a.tag]));
    const stale = ((edges as Array<{ id: string; b: string }> | null) ?? []).filter((e) => { const t = tagOf.get(e.b.replace(/^asset:/, "")); return !t || !onSheet.has(norm(t)); }).map((e) => e.id);
    if (stale.length) await supabaseAdmin.from("estate_edges").delete().in("id", stale);
  }

  // 3. Apply what the sheet carries: suggestions recomputed from the new
  //    reading, applied as reviewed (a callout read by the person's model),
  //    then the links redrawn.
  let added: string[] = [];
  let createdAssets = 0;
  const comp = await computeForKnowledgeDoc(supabaseAdmin, knowledgeDocId, { autoApply: false }).catch(() => null);
  if (comp?.suggestions.length) {
    const r = await applyForDocument(supabaseAdmin, { orgId, documentId, userId, byPerson: true }).catch(() => null);
    if (r) { added = r.appliedTags.filter((t) => !kept.some((k) => norm(k) === norm(t))); createdAssets = r.createdAssets; }
  }
  await resolveEstate(supabaseAdmin, { orgId, documentIds: [documentId] }).catch(() => undefined);

  // 4. What the callout says about each piece of equipment, written onto
  //    registry items nobody has described: the service name, the site
  //    code, and the design data, with the sheet it came from.
  const assetsUpdated: Array<{ id: string; before: Record<string, unknown>; after: Record<string, unknown> }> = [];
  const { data: callouts } = await supabaseAdmin.from("knowledge_page_entities").select("tag, raw, page").eq("document_id", knowledgeDocId).eq("kind", "equipment").limit(500);
  for (const c of (callouts as Array<{ tag: string; raw: string | null; page: number }> | null) ?? []) {
    const m = String(c.raw ?? "").match(/^\S+(?:\s+\(([^)]+)\))?\s*([^·]*?)\s*(?:·\s*(.*))?$/);
    const code = m?.[1]?.trim() || null, name = m?.[2]?.trim() || null, details = m?.[3]?.trim() || null;
    if (!name && !details && !code) continue;
    const { data: a } = await supabaseAdmin.from("assets").select("id, description, code, metadata").eq("org_id", orgId).eq("tag_normalized", norm(c.tag)).maybeSingle();
    const asset = a as { id: string; description: string | null; code: string | null; metadata: Record<string, unknown> | null } | null;
    if (!asset) continue;
    const patch: Record<string, unknown> = {};
    if (!asset.description && name) patch.description = name;
    if (!asset.code && code) patch.code = code;
    const md = asset.metadata ?? {};
    if (!md.drawingCallout) patch.metadata = { ...md, drawingCallout: { code, name, details, sheet: sheetName, page: c.page, documentId } };
    if (!Object.keys(patch).length) continue;
    const prev: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) prev[k] = (asset as Record<string, unknown>)[k] ?? null;
    const { error } = await supabaseAdmin.from("assets").update(patch).eq("id", asset.id).eq("org_id", orgId);
    if (!error) assetsUpdated.push({ id: asset.id, before: prev, after: patch });
  }

  const after = await snapshotDoc(supabaseAdmin, orgId, documentId);
  const journaled = await recordDocChange(supabaseAdmin, orgId, run, documentId, before, after, { assetsUpdated });
  return { correction: { removed: wrong, kept, added, createdAssets, described: assetsUpdated.length }, journaled };
}
