// /api/flows/read — read a process flow diagram, propose the plant's flows.
//
// An admin points at a knowledge document (a PFD, a block diagram, a P&ID
// overview) and the AI reads the printed pages — vision, not text scraping —
// and proposes DIRECTIONAL flow connections. The same grounding contract as
// every AI writer in this app: the model may only connect entities the
// server verified exist (registry assets by tag, Site Codebook units by
// code), so a hallucinated vessel can never enter the topology. Proposals
// land as status='proposed' rows for a human to accept in the unit hub;
// pairs already decided (confirmed OR dismissed) are never re-proposed.
//
// Authority: Admin / DocCtrl — this shapes the org's shared process map.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { GovernedCallError } from "@/lib/ai/governedCall";
import { extractJsonBlock } from "@/lib/orchestrator/protocol";
import { renderKnowledgePages } from "@/lib/knowledgePageRender";
import { loadCodebookAdmin } from "@/lib/codebookServer";
import { callAiModel, type AiProviderId } from "@/lib/ai/providerCall";
import { openAiKey } from "@/lib/ai/keyVault";

export const runtime = "nodejs";
export const maxDuration = 120;

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });
const MAX_PAGES = 6;

export async function POST(req: NextRequest) {
  let body: { orgId?: string; knowledgeDocumentId?: string; pages?: number[] };
  try { body = await req.json(); } catch { return bad("Bad JSON", 400); }
  const orgId = (body.orgId ?? "").trim();
  const kdocId = (body.knowledgeDocumentId ?? "").trim();
  if (!orgId || !kdocId) return bad("orgId and knowledgeDocumentId required", 400);

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return bad("Not signed in", 401);
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return bad("Not signed in", 401);
  const userId = userData.user.id;

  const { data: member } = await supabaseAdmin
    .from("org_members").select("role, status")
    .eq("org_id", orgId).eq("uid", userId).maybeSingle();
  const m = member as { role?: string; status?: string } | null;
  if (!m || m.status !== "active" || !["Admin", "DocCtrl"].includes(m.role ?? "")) {
    return bad("Only admins and document controllers shape the process map.", 403);
  }

  // ── The document, and the roster the model is allowed to connect. ─────
  const { data: kdoc } = await supabaseAdmin
    .from("knowledge_documents").select("id, name, file_key, page_count")
    .eq("org_id", orgId).eq("id", kdocId).maybeSingle();
  const doc = kdoc as { id: string; name: string; file_key: string | null; page_count: number | null } | null;
  if (!doc?.file_key) return bad("That document has no stored file to read.", 404);

  const [{ data: assetRows }, book] = await Promise.all([
    supabaseAdmin.from("assets").select("id, tag").eq("org_id", orgId).eq("archived", false).limit(4000),
    loadCodebookAdmin(supabaseAdmin, orgId).catch(() => null),
  ]);
  const assets = (assetRows as Array<{ id: string; tag: string }>) ?? [];
  const units = book?.units ?? [];
  if (assets.length === 0 && units.length === 0) {
    return bad("Nothing to connect yet — add equipment to the registry (or units to the Site Codebook) first, so the reader has real entities to ground on.", 412);
  }

  const roster: Array<{ ref: string; kind: "asset" | "unit"; id: string; label: string }> = [];
  assets.slice(0, 300).forEach((a, i) => roster.push({ ref: `A${i + 1}`, kind: "asset", id: a.id, label: a.tag }));
  units.forEach((u, i) => roster.push({ ref: `U${i + 1}`, kind: "unit", id: u.code, label: `${u.label || "Unit"} (unit ${u.code})` }));
  const byRef = new Map(roster.map((r) => [r.ref, r]));
  const rosterText = roster.map((r) => `${r.ref} [${r.kind}] ${r.label}`).join("\n");

  // ── Render the pages. Default: first MAX_PAGES (a PFD is usually short). ──
  const wanted = (body.pages ?? []).filter((p) => Number.isInteger(p) && p >= 1).slice(0, MAX_PAGES);
  const pages = wanted.length > 0
    ? wanted
    : Array.from({ length: Math.min(doc.page_count ?? 1, MAX_PAGES) }, (_, i) => i + 1);
  const images = await renderKnowledgePages(doc.file_key, pages, MAX_PAGES);
  if (images.length === 0) return bad("The pages could not be rendered for reading.", 502);

  // ── Already-decided pairs are settled — a dismissal must stick. ────────
  const { data: prior } = await supabaseAdmin
    .from("process_flows").select("from_kind, from_ref, to_kind, to_ref")
    .eq("org_id", orgId).limit(4000);
  const settled = new Set(
    ((prior as Array<{ from_kind: string; from_ref: string; to_kind: string; to_ref: string }>) ?? [])
      .map((f) => `${f.from_kind}:${f.from_ref}>${f.to_kind}:${f.to_ref}`),
  );

  // ── Read. governedAiCall doesn't carry images, so run the same gates
  // then call the model directly with the pages attached. ────────────────
  const SYSTEM =
    "You read industrial process drawings (PFDs, block diagrams, P&ID overviews). Identify " +
    "DIRECTIONAL process flow: which entity feeds which, following flow arrows and line " +
    "connections printed on the drawing.\n" +
    "Rules:\n" +
    "- Use ONLY the roster handles (A1, U2, …). Connect an entity only when its tag or unit is " +
    "PRINTED on the drawing and the flow direction is visible. Never guess from typical plant " +
    "layouts.\n" +
    "- label: the stream's name as printed (\"crude feed\", \"overhead vapor\") or empty if unlabeled.\n" +
    "- page: which attached page (1-based, in attachment order) shows it.\n" +
    "- confidence 0–1. At most 20 flows; an empty list is a correct reading of a drawing " +
    "without flow information.\n" +
    "Return STRICT JSON: {\"flows\":[{\"from\":\"A1\",\"to\":\"A2\",\"label\":\"…\",\"page\":1,\"confidence\":0.9}]}";

  // governedAiCall doesn't carry images yet, so this route runs the same
  // gate order inline: own key → provider allowlist → cap → call → meter.
  let text: string;
  try {
    const { data: conn } = await supabaseAdmin
      .from("ai_connections").select("provider, model, api_key")
      .eq("org_id", orgId).eq("user_id", userId).maybeSingle();
    if (!conn) throw new GovernedCallError("Add your Claude or OpenAI key in AI settings first.", 412);
    const { ALLOWED_PROVIDERS } = await import("@/lib/ai/pricing");
    if (!ALLOWED_PROVIDERS.includes(conn.provider as AiProviderId)) {
      throw new GovernedCallError("Your saved key uses a blocked provider — save a Claude or OpenAI key.", 412);
    }
    const { getMonthUsage, getCapUsd, recordAskUsage } = await import("@/lib/ai/usageServer");
    const [monthSoFar, capUsd] = await Promise.all([getMonthUsage(orgId, userId), getCapUsd(orgId, userId)]);
    if (capUsd > 0 && monthSoFar.spentUsd >= capUsd) {
      throw new GovernedCallError(`Monthly AI budget reached ($${monthSoFar.spentUsd.toFixed(2)} of $${capUsd.toFixed(2)}).`, 402);
    }
    const out = await callAiModel({
      provider: conn.provider as AiProviderId,
      model: String(conn.model),
      apiKey: openAiKey(String(conn.api_key)),
      system: SYSTEM,
      user: `Document: ${doc.name}\nPages attached in order: ${images.map((i) => i.page).join(", ")}\n\nROSTER (the only entities you may connect):\n${rosterText}`,
      images: images.map((i) => ({ base64: i.base64, mediaType: i.mediaType })),
      maxTokens: 1600,
      timeoutMs: 90_000,
    });
    await recordAskUsage({ orgId, userId, provider: conn.provider as AiProviderId, model: String(conn.model), usage: out.usage, ok: true, op: "flowRead" });
    text = out.text;
  } catch (e) {
    if (e instanceof GovernedCallError) return bad(e.message, e.status);
    return bad((e as Error).message, 502);
  }

  const block = extractJsonBlock(text);
  const parsed = block ? (JSON.parse(block) as { flows?: unknown[] }) : null;
  const rows: Array<Record<string, unknown>> = [];
  let skippedSettled = 0;
  for (const raw of parsed?.flows ?? []) {
    const f = raw as { from?: string; to?: string; label?: string; page?: number; confidence?: number };
    const from = f.from ? byRef.get(f.from) : undefined;
    const to = f.to ? byRef.get(f.to) : undefined;
    if (!from || !to || from.ref === to.ref) continue;
    const key = `${from.kind}:${from.id}>${to.kind}:${to.id}`;
    if (settled.has(key)) { skippedSettled += 1; continue; }
    settled.add(key);
    const pageIndex = Number(f.page ?? 1);
    rows.push({
      org_id: orgId,
      from_kind: from.kind, from_ref: from.id,
      to_kind: to.kind, to_ref: to.id,
      label: String(f.label ?? "").slice(0, 120) || null,
      status: "proposed",
      origin: "ai",
      source_document_id: doc.id,
      source_page: images[pageIndex - 1]?.page ?? images[0].page,
      evidence: { docName: doc.name, confidence: Math.max(0, Math.min(1, Number(f.confidence ?? 0.5))) },
      created_by: userId,
    });
    if (rows.length >= 20) break;
  }

  let proposed = 0;
  if (rows.length > 0) {
    const { error } = await supabaseAdmin.from("process_flows").insert(rows);
    if (error) return bad(`Reading succeeded but writing proposals failed: ${error.message}`, 500);
    proposed = rows.length;
  }
  return NextResponse.json({
    proposed,
    skippedSettled,
    pagesRead: images.map((i) => i.page),
    note: proposed === 0
      ? "No new flows found — the drawing may not print flow arrows between known tags, or everything visible was already decided."
      : undefined,
  });
}
