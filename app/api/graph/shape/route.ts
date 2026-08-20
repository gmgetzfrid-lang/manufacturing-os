// /api/graph/shape — the AI brain behind "Shape the graph".
//
// An ADMIN reads an answer and decides it should leave a mark on the org
// graph. This route does the thinking they shouldn't have to: it grounds
// the answer in real entities (the controlled documents its citations
// resolve to, the registry equipment its text names), asks the member's own
// model WHICH of those genuinely relate and WHY, and returns evidenced
// suggestions the wizard lets the admin curate. Nothing is written here —
// the admin's accept click writes, client-side, under RLS.
//
// Two invariants:
//   * The model never invents an entity. It only ever picks from the
//     candidate list this route assembled deterministically from the
//     database — a hallucinated document cannot become a suggestion.
//   * No AI key? The wizard still works: deterministic co-citation pairs
//     come back labeled as such. Degraded, never dead.
//
// Authority: Admin / DocCtrl only — shaping the graph is curation of the
// org's shared map.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { governedAiCall, GovernedCallError } from "@/lib/ai/governedCall";
import { extractJsonBlock } from "@/lib/orchestrator/protocol";
import { normalizeTag } from "@/lib/codebook";

export const runtime = "nodejs";
export const maxDuration = 60;

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });

/** Punctuation/case-blind containment key, same rule the identity index uses. */
const squash = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

export interface ShapeCandidate {
  /** Stable handle the model must use: D1..Dn, A1..Am. */
  ref: string;
  type: "document" | "asset";
  id: string;
  label: string;       // document number / asset tag
  title: string | null; // document title / asset description
  libraryId?: string;
}

export interface ShapeSuggestion {
  a: string;            // candidate ref
  b: string;            // candidate ref
  label: string;
  reason: string;
  confidence: number;   // 0..1
  aiAssisted: boolean;
}

export async function POST(req: NextRequest) {
  let body: {
    orgId?: string; question?: string; answer?: string;
    citedKnowledgeDocIds?: string[];
  };
  try { body = await req.json(); } catch { return bad("Bad JSON", 400); }
  const orgId = (body.orgId ?? "").trim();
  const question = (body.question ?? "").slice(0, 2000);
  const answer = (body.answer ?? "").slice(0, 24_000);
  const citedIds = (body.citedKnowledgeDocIds ?? []).filter((x) => typeof x === "string").slice(0, 40);
  if (!orgId || !answer) return bad("orgId and answer required", 400);

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
    return bad("Only admins and document controllers shape the graph.", 403);
  }

  // ── Ground truth: which real entities does this answer involve? ────────
  const candidates: ShapeCandidate[] = [];
  const answerSquash = squash(answer);

  // 1. Citations → the controlled documents they mirror. The strongest
  //    grounding there is: the model literally read these pages.
  const citedControlled = new Set<string>();
  if (citedIds.length > 0) {
    const { data: kdocs } = await supabaseAdmin
      .from("knowledge_documents").select("id, source_document_id")
      .eq("org_id", orgId).in("id", citedIds)
      .not("source_document_id", "is", null);
    for (const k of (kdocs as Array<{ id: string; source_document_id: string }>) ?? []) {
      citedControlled.add(k.source_document_id);
    }
  }

  // 2. Documents whose NUMBER the answer names (covers mentions the model
  //    made beyond its citations).
  const { data: docRows } = await supabaseAdmin
    .from("documents").select("id, document_number, title, library_id")
    .eq("org_id", orgId).not("document_number", "is", null)
    .limit(4000);
  const docs = (docRows as Array<{ id: string; document_number: string; title: string | null; library_id: string }>) ?? [];
  const docById = new Map(docs.map((d) => [d.id, d]));
  const namedDocIds = new Set<string>(citedControlled);
  for (const d of docs) {
    if (namedDocIds.size >= 14) break;
    if (namedDocIds.has(d.id)) continue;
    const key = squash(d.document_number);
    if (key.length >= 4 && answerSquash.includes(key)) namedDocIds.add(d.id);
  }
  let dn = 0;
  for (const id of namedDocIds) {
    const d = docById.get(id);
    if (!d) continue;
    dn += 1;
    candidates.push({
      ref: `D${dn}`, type: "document", id,
      label: d.document_number, title: d.title, libraryId: d.library_id,
    });
    if (dn >= 12) break;
  }

  // 3. Registry equipment the answer names by tag.
  const { data: assetRows } = await supabaseAdmin
    .from("assets").select("id, tag, description")
    .eq("org_id", orgId).eq("archived", false).limit(4000);
  let an = 0;
  for (const a of (assetRows as Array<{ id: string; tag: string; description: string | null }>) ?? []) {
    const key = squash(normalizeTag(a.tag));
    if (key.length >= 3 && answerSquash.includes(key)) {
      an += 1;
      candidates.push({ ref: `A${an}`, type: "asset", id: a.id, label: a.tag, title: a.description });
      if (an >= 8) break;
    }
  }

  if (candidates.length < 2) {
    return NextResponse.json({
      candidates, suggestions: [],
      note: "This answer doesn't ground to two or more known documents or registry assets, so there is nothing to connect. Answers citing linked document-control sources shape best.",
    });
  }

  // ── Already-connected pairs must not come back as suggestions. ─────────
  const existing = new Set<string>();
  const candDocIds = candidates.filter((c) => c.type === "document").map((c) => c.id);
  const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  if (candDocIds.length > 0) {
    const { data: rel } = await supabaseAdmin
      .from("document_related_resources")
      .select("document_id, target_document_id")
      .eq("org_id", orgId).in("document_id", candDocIds).not("target_document_id", "is", null);
    for (const r of (rel as Array<{ document_id: string; target_document_id: string }>) ?? []) {
      existing.add(pairKey(r.document_id, r.target_document_id));
    }
    const { data: da } = await supabaseAdmin
      .from("document_assets").select("document_id, asset_id")
      .eq("org_id", orgId).in("document_id", candDocIds);
    for (const r of (da as Array<{ document_id: string; asset_id: string }>) ?? []) {
      existing.add(pairKey(r.document_id, r.asset_id));
    }
  }
  const byRef = new Map(candidates.map((c) => [c.ref, c]));
  const pairExists = (a: string, b: string) => {
    const ca = byRef.get(a), cb = byRef.get(b);
    return !ca || !cb || existing.has(pairKey(ca.id, cb.id));
  };

  // ── The brain. The model reasons over handles, never raw ids. ──────────
  const roster = candidates
    .map((c) => `${c.ref} [${c.type}] ${c.label}${c.title ? ` — ${c.title}` : ""}`)
    .join("\n");

  let suggestions: ShapeSuggestion[] = [];
  let aiNote: string | undefined;
  try {
    const out = await governedAiCall({
      orgId, userId, op: "graphShape", instructionScope: "knowledge",
      system:
        "You are the relationship analyst for an industrial document-control graph. " +
        "Given a question, its answer, and a roster of REAL entities (controlled documents and " +
        "registry equipment) the answer involves, decide which pairs GENUINELY RELATE — a " +
        "governing standard and the equipment it governs, a spec and the drawing that invokes " +
        "it — not merely co-mentioned items.\n" +
        "Rules:\n" +
        "- Use ONLY the roster handles (D1, A2, …). Never invent entities.\n" +
        "- label: at most 80 characters naming the RELATIONSHIP (e.g. \"Governs welding of\", " +
        "\"Invoked by §8.2.1 for\"). Not a summary of the answer.\n" +
        "- reason: ONE sentence grounded in what the answer actually says.\n" +
        "- confidence: 0 to 1. Propose at most 8 pairs; fewer good pairs beat many weak ones. " +
        "An empty list is a correct response.\n" +
        "Return STRICT JSON: {\"suggestions\":[{\"a\":\"D1\",\"b\":\"A1\",\"label\":\"…\",\"reason\":\"…\",\"confidence\":0.9}]}",
      user: `QUESTION:\n${question || "(not recorded)"}\n\nANSWER:\n${answer}\n\nROSTER:\n${roster}`,
      maxTokens: 1400,
      timeoutMs: 40_000,
    });
    const block = extractJsonBlock(out.text);
    const parsed = block ? (JSON.parse(block) as { suggestions?: unknown[] }) : null;
    for (const raw of parsed?.suggestions ?? []) {
      const s = raw as { a?: string; b?: string; label?: string; reason?: string; confidence?: number };
      if (!s.a || !s.b || s.a === s.b || !byRef.has(s.a) || !byRef.has(s.b)) continue;
      if (pairExists(s.a, s.b)) continue;
      const ca = byRef.get(s.a)!, cb = byRef.get(s.b)!;
      if (ca.type === "asset" && cb.type === "asset") continue; // no asset↔asset edges exist
      suggestions.push({
        a: s.a, b: s.b,
        label: String(s.label ?? "Related").slice(0, 80),
        reason: String(s.reason ?? "").slice(0, 300),
        confidence: Math.max(0, Math.min(1, Number(s.confidence ?? 0.5))),
        aiAssisted: true,
      });
      if (suggestions.length >= 8) break;
    }
  } catch (e) {
    if (e instanceof GovernedCallError && e.status !== 412 && e.status !== 428) {
      return bad(e.message, e.status);
    }
    // No key / no agreement / model failure → deterministic fallback below.
    aiNote = e instanceof GovernedCallError
      ? e.message
      : "The AI pass failed — showing deterministic pairs instead.";
  }

  // ── Fallback (and floor): cited-together pairs, honestly labeled. ──────
  if (suggestions.length === 0) {
    const citedRefs = candidates.filter((c) => c.type === "document" && citedControlled.has(c.id));
    for (let i = 0; i < citedRefs.length && suggestions.length < 6; i++) {
      for (let j = i + 1; j < citedRefs.length && suggestions.length < 6; j++) {
        if (pairExists(citedRefs[i].ref, citedRefs[j].ref)) continue;
        suggestions.push({
          a: citedRefs[i].ref, b: citedRefs[j].ref,
          label: "Cited together in this answer",
          reason: "Both documents were sources for the same answer.",
          confidence: 0.4,
          aiAssisted: false,
        });
      }
    }
  }

  suggestions = suggestions.sort((x, y) => y.confidence - x.confidence);
  return NextResponse.json({ candidates, suggestions, note: aiNote });
}
