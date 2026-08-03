// /api/knowledge/locate — where a tag sits on a drawing sheet.
//
//   POST { orgId, documentId, page, tags[] }
//        → [{ tag, nx, ny, source: "text" | "vision" }]
//
// Two sources, one answer shape:
//   text-layer sheets  — already stored at ingest from the PDF's own
//                        coordinates. Free, exact, instant.
//   vision-read sheets — the model looks at the rendered page and points.
//                        Costs one cheap call for the WHOLE page (every
//                        requested tag at once), then caches forever, so
//                        the second person to ask pays nothing.
//
// ACL: the same fail-closed check as every other knowledge read — a mirror
// of a controlled document the caller can't read never resolves here either.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal, readableControlledDocIds } from "@/lib/knowledgeAccess";
import { callAiModel, type AiProviderId } from "@/lib/ai/providerCall";
import { ALLOWED_PROVIDERS } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import { VISION_MODEL } from "@/lib/knowledgeVision";
import { LOCATE_SYSTEM, buildLocateUser, parseLocateResponse } from "@/lib/drawingLocate";
import { ensurePdfPolyfills } from "@/lib/knowledgeText";
import { r2, R2_BUCKET } from "@/lib/r2";
import { GetObjectCommand } from "@aws-sdk/client-s3";

export const runtime = "nodejs";
export const maxDuration = 60;

/** One page render + one model call has to fit comfortably. */
const LOCATE_BUDGET_MS = 40_000;
/** Asking for the world would turn one call into a bad transcription job. */
const MAX_TAGS = 12;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Unauthorized", 401);

  let body: { orgId?: string; documentId?: string; page?: number; tags?: string[] };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const documentId = String(body.documentId ?? "").trim();
  const page = Number(body.page ?? 0);
  const tags = [...new Set((body.tags ?? []).map((t) => String(t).trim().toUpperCase()).filter(Boolean))]
    .slice(0, MAX_TAGS);
  if (!orgId || !documentId || !page || tags.length === 0) {
    return bad("orgId, documentId, page and tags are required");
  }

  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not a member of this workspace", 403);

  const { data: doc } = await supabaseAdmin
    .from("knowledge_documents")
    .select("id, org_id, library_id, name, file_key, source_document_id, vision_pages")
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

  // ── Cached positions ───────────────────────────────────────────────────
  const { data: rows, error: entErr } = await supabaseAdmin
    .from("knowledge_page_entities")
    .select("tag, nx, ny, pos_source")
    .eq("document_id", documentId).eq("page", page).in("tag", tags);
  if (entErr) {
    const missing = entErr.code === "42P01" || /does not exist|nx/i.test(entErr.message);
    return bad(
      missing
        ? "Locating tags on drawings needs migration 20260924 — run it in Supabase, then try again."
        : entErr.message,
      missing ? 424 : 500,
    );
  }

  const found = new Map<string, { tag: string; nx: number; ny: number; source: string }>();
  for (const r of (rows ?? []) as Array<{ tag: string; nx: number | null; ny: number | null; pos_source: string | null }>) {
    if (r.nx === null || r.ny === null || found.has(r.tag)) continue;
    found.set(r.tag, { tag: r.tag, nx: r.nx, ny: r.ny, source: r.pos_source ?? "text" });
  }
  const unlocated = tags.filter((t) => !found.has(t));
  // Only tags this page actually carries are worth a model call — asking it
  // to find something that isn't there is how you get a confident wrong dot.
  const onThisPage = new Set(((rows ?? []) as Array<{ tag: string }>).map((r) => r.tag));
  const toLocate = unlocated.filter((t) => onThisPage.has(t));

  // ── Not here? Say WHERE. ───────────────────────────────────────────────
  // "V-3 isn't on this page" leaves an engineer exactly where they started;
  // "V-3 is on 025-PID-0103" is navigation. The entity index knows every
  // tag on every sheet in the library — use it. ACL fails closed: a mirror
  // of a controlled doc the caller can't read is never suggested.
  const missingHere = tags.filter((t) => !onThisPage.has(t));
  const elsewhere: Array<{
    tag: string; documentId: string; documentName: string; fileKey: string;
    page: number; sameDocument: boolean;
  }> = [];
  if (missingHere.length > 0) {
    try {
      const { data: elseRows } = await supabaseAdmin
        .from("knowledge_page_entities")
        .select("document_id, page, tag")
        .eq("library_id", doc.library_id as string)
        .in("tag", missingHere)
        .limit(1000);
      const hits = (elseRows ?? []) as Array<{ document_id: string; page: number; tag: string }>;
      const hitDocIds = [...new Set(hits.map((r) => r.document_id))];
      if (hitDocIds.length > 0) {
        const { data: docRows } = await supabaseAdmin
          .from("knowledge_documents")
          .select("id, name, file_key, source_document_id")
          .in("id", hitDocIds);
        const docsById = new Map((docRows ?? []).map((d) => [d.id as string, d]));
        const mirrors = (docRows ?? []).filter((d) => d.source_document_id);
        let readable = new Set<string>();
        if (mirrors.length > 0) {
          try {
            readable = await readableControlledDocIds(
              principal, [...new Set(mirrors.map((d) => d.source_document_id as string))]);
          } catch { readable = new Set(); }
        }
        const best = new Map<string, { document_id: string; page: number }>();
        // Prefer another page of the OPEN sheet, then the lowest page.
        const score = (h: { document_id: string; page: number }) =>
          (h.document_id === documentId ? 0 : 1_000_000) + h.page;
        for (const h of hits) {
          const d = docsById.get(h.document_id);
          if (!d) continue;
          if (d.source_document_id && !readable.has(d.source_document_id as string)) continue;
          const prev = best.get(h.tag);
          if (!prev || score(h) < score(prev)) best.set(h.tag, h);
        }
        for (const [tag, hit] of best) {
          const d = docsById.get(hit.document_id)!;
          elsewhere.push({
            tag, documentId: hit.document_id,
            documentName: d.name as string, fileKey: d.file_key as string,
            page: hit.page, sameDocument: hit.document_id === documentId,
          });
        }
      }
    } catch { /* best-effort — a missing answer here just means less help */ }
  }
  const trulyAbsent = missingHere.filter((t) => !elsewhere.some((e) => e.tag === t));

  if (toLocate.length === 0) {
    return NextResponse.json({
      positions: [...found.values()],
      notOnPage: trulyAbsent,
      elsewhere,
    });
  }

  // ── Vision locate ──────────────────────────────────────────────────────
  const { data: conn } = await supabaseAdmin
    .from("ai_connections").select("provider, model, api_key")
    .eq("org_id", orgId).eq("user_id", user.id).maybeSingle();
  if (!conn || !ALLOWED_PROVIDERS.includes(conn.provider as AiProviderId)) {
    return NextResponse.json({
      positions: [...found.values()],
      notOnPage: trulyAbsent,
      elsewhere,
      skipped: "These tags came from an AI-read sheet, so pointing at them needs your own AI key " +
        "(add one in AI settings). The sheet still opens at the right page.",
    });
  }
  const provider = conn.provider as AiProviderId;
  const [spent, cap] = await Promise.all([getMonthUsage(orgId, user.id), getCapUsd(orgId, user.id)]);
  if (cap > 0 && spent.spentUsd >= cap) {
    return NextResponse.json({
      positions: [...found.values()],
      notOnPage: trulyAbsent,
      elsewhere,
      skipped: `Monthly AI budget reached ($${spent.spentUsd.toFixed(2)} of $${cap.toFixed(2)}) — ` +
        "the sheet still opens at the right page.",
    });
  }

  try {
    ensurePdfPolyfills();
    const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: doc.file_key as string }));
    const bytes = new Uint8Array(await new Response(obj.Body as ReadableStream).arrayBuffer());
    const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const img = await renderPageAsImage(pdf, page, {
      width: 1800,
      canvasImport: () => import("@napi-rs/canvas"),
    });
    const out = await callAiModel({
      provider,
      model: VISION_MODEL[provider] ?? (conn.model as string),
      apiKey: conn.api_key as string,
      system: LOCATE_SYSTEM,
      user: buildLocateUser(toLocate, doc.name as string, page),
      maxTokens: 500,
      images: [{ base64: Buffer.from(img as ArrayBuffer).toString("base64"), mediaType: "image/png" }],
      timeoutMs: Math.max(5_000, startedAt + LOCATE_BUDGET_MS - Date.now()),
    });
    await recordAskUsage({
      orgId, userId: user.id, provider,
      model: VISION_MODEL[provider] ?? (conn.model as string),
      usage: out.usage, ok: true, op: "drawingLocate",
    });

    const located = parseLocateResponse(out.text, toLocate);
    // Cache: the next person to ask this question pays nothing.
    for (const pos of located) {
      await supabaseAdmin.from("knowledge_page_entities")
        .update({ nx: pos.nx, ny: pos.ny, pos_source: "vision" })
        .eq("document_id", documentId).eq("page", page).eq("tag", pos.tag)
        .then(() => undefined, () => undefined);
      found.set(pos.tag, { ...pos, source: "vision" });
    }
    return NextResponse.json({
      positions: [...found.values()],
      notOnPage: trulyAbsent,
      elsewhere,
      // Named honestly: "the model looked and couldn't see it" is different
      // from "we never looked".
      notVisible: toLocate.filter((t) => !found.has(t)),
    });
  } catch (e) {
    // Locating is an enhancement — never let it break opening the sheet.
    return NextResponse.json({
      positions: [...found.values()],
      notOnPage: trulyAbsent,
      elsewhere,
      skipped: `Couldn't point at those tags: ${(e as Error).message}`,
    });
  }
}
