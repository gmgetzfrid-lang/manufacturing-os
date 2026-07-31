// /api/knowledge/ask — the question-answering seam for knowledge libraries.
//
// POST { orgId, libraryId, question } →
//   { answer, citations: [{n, documentId, documentName, page}], provider, model }
//
// Two model calls on the asker's EFFECTIVE connection (their personal key if
// they set one, else the org default — always their money, never ours):
//
//   1. Turn the question into 2-4 full-text search queries. Provider-neutral
//      trick: retrieval is Postgres FTS, so the model compensates for the
//      lack of embeddings by writing good keyword queries.
//   2. Answer FROM the retrieved passages only, citing [n] markers that map
//      to (document, page) — every claim traceable to a real page.
//
// Every Q&A lands in knowledge_questions (the library's own record) and the
// ai_usage_events meter.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callAiModel, AiCallError, type AiProviderId, type AiCallInput } from "@/lib/ai/providerCall";
import {
  ALLOWED_PROVIDERS, estimateCostUsd, AGREEMENT_VERSION, buildAgreementText,
} from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import {
  parseSearchQueries, parseFollowupPlan, extractCitationNumbers, mergeRetrieved,
  type RetrievedChunk,
} from "@/lib/knowledgeText";

export const runtime = "nodejs";
export const maxDuration = 120;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !user) return bad("Unauthorized", 401);

  let body: { orgId?: string; libraryId?: string; question?: string; mode?: string };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const libraryId = String(body.libraryId ?? "").trim();
  const question = String(body.question ?? "").trim().slice(0, 2000);
  // "library" (default): answers ONLY from the indexed documents, page-cited.
  // "internet": the provider's live web tool (or model knowledge where the
  // provider has none) — clearly labeled, never mixed with library citations.
  const mode = body.mode === "internet" ? "internet" : "library";
  if (!orgId || !libraryId || !question) return bad("orgId, libraryId and question are required");

  const { data: member } = await supabaseAdmin
    .from("org_members").select("uid, display_name, email")
    .eq("org_id", orgId).eq("uid", user.id).eq("status", "active")
    .maybeSingle();
  if (!member) return bad("Not a member of this workspace", 403);
  const userName = (member.display_name as string) || (member.email as string) || "Member";

  const { data: library } = await supabaseAdmin
    .from("knowledge_libraries").select("id, name, ai_instructions").eq("id", libraryId).eq("org_id", orgId).maybeSingle();
  if (!library) return bad("Library not found", 404);

  // Linked reference libraries (the bridge): asked library GOVERNS, links
  // are consulted as REFERENCE. Missing table/column = no links (42P01/42703).
  let linkedLibraries: Array<{ id: string; name: string }> = [];
  {
    const { data: linkRows } = await supabaseAdmin
      .from("knowledge_library_links").select("linked_library_id").eq("library_id", libraryId);
    const linkedIds = (linkRows ?? []).map((r) => r.linked_library_id as string);
    if (linkedIds.length > 0) {
      const { data: libs } = await supabaseAdmin
        .from("knowledge_libraries").select("id, name").in("id", linkedIds).eq("org_id", orgId);
      linkedLibraries = (libs ?? []).map((l) => ({ id: l.id as string, name: l.name as string }));
    }
  }
  const hasLinks = linkedLibraries.length > 0;
  const libNameById = new Map<string, string>([
    [libraryId, library.name as string],
    ...linkedLibraries.map((l) => [l.id, l.name] as [string, string]),
  ]);
  const aiInstructions = ((library.ai_instructions as string | null) ?? "").trim();

  // Effective connection: personal override wins, else the org default —
  // but ONLY allowlisted providers count, for either scope. A connection on
  // a blocked provider (a grandfathered Gemini row) is dead weight: skipped,
  // never called, no matter who saved it.
  const { data: connRows } = await supabaseAdmin
    .from("ai_connections").select("user_id, provider, model, api_key")
    .eq("org_id", orgId)
    .or(`user_id.is.null,user_id.eq.${user.id}`);
  const rows = connRows ?? [];
  const usable = (r: { provider: string }) =>
    ALLOWED_PROVIDERS.includes(r.provider as AiProviderId);
  const conn = rows.find((r) => r.user_id === user.id && usable(r))
    ?? rows.find((r) => r.user_id === null && usable(r));
  if (!conn) {
    const hasBlocked = rows.some((r) => !usable(r));
    return bad(
      hasBlocked
        ? "The saved AI connection uses a blocked provider — only Anthropic (Claude) and OpenAI " +
          "are allowed, because their API traffic is never used for model training. Save a Claude " +
          "or OpenAI key in AI settings."
        : "No AI connection configured — add a provider API key in AI settings first.",
      412,
    );
  }
  const provider = conn.provider as AiProviderId;
  const model = conn.model as string;
  const apiKey = conn.api_key as string;

  // ── Acceptable-use agreement: everyone signs once (per version) before
  //    their first question. A pre-migration DB (no table) skips the gate —
  //    it couldn't record an acceptance anyway.
  {
    const { data: agree, error: agreeError } = await supabaseAdmin
      .from("ai_key_agreements").select("id")
      .eq("org_id", orgId).eq("user_id", user.id)
      .eq("scope", "use").eq("agreement_version", AGREEMENT_VERSION)
      .limit(1);
    const tableMissing = !!agreeError &&
      (agreeError.code === "42P01" || /does not exist/i.test(agreeError.message));
    if (!tableMissing && (agree ?? []).length === 0) {
      return NextResponse.json({
        error: "Before your first question, read and accept the AI acceptable-use agreement.",
        agreementRequired: true,
        agreementText: buildAgreementText(provider),
        agreementVersion: AGREEMENT_VERSION,
      }, { status: 428 });
    }
  }

  // ── Monthly cap: checked BEFORE any provider call, so a capped user
  //    spends nothing. Cost accrues to the ASKER regardless of whose key
  //    (personal or org) served the request.
  const [monthSoFar, capUsd] = await Promise.all([
    getMonthUsage(orgId, user.id),
    getCapUsd(orgId, user.id),
  ]);
  if (capUsd > 0 && monthSoFar.spentUsd >= capUsd) {
    return bad(
      `Monthly AI budget reached — you've used $${monthSoFar.spentUsd.toFixed(2)} of your ` +
      `$${capUsd.toFixed(2)} cap. It resets on the 1st; an Admin can raise the cap in AI settings.`,
      402,
    );
  }

  // Every model call in this ask (query gen, refine, probes, answer) adds
  // its exact provider-reported tokens here; one metering row per ask.
  const askUsage = { inputTokens: 0, outputTokens: 0 };
  const call = async (input: Omit<AiCallInput, "provider" | "model" | "apiKey">) => {
    const out = await callAiModel({ provider, model, apiKey, ...input });
    askUsage.inputTokens += out.usage.inputTokens;
    askUsage.outputTokens += out.usage.outputTokens;
    return out;
  };
  const meter = (ok: boolean) =>
    recordAskUsage({ orgId, userId: user.id, provider, model, usage: askUsage, ok });
  const budget = () => ({
    spentUsd: Math.round((monthSoFar.spentUsd + estimateCostUsd(model, askUsage)) * 100) / 100,
    capUsd,
  });

  // ── Internet mode: one call, provider web tool, web-source citations ───
  if (mode === "internet") {
    try {
      const out = await call({
        system:
          "You are the reference assistant for a refinery document control system. The user chose " +
          "INTERNET mode, so answer from the web / your general knowledge — this answer is explicitly " +
          "NOT from their controlled internal documents, and you must not pretend it is. Prefer " +
          "authoritative sources (standards bodies, manufacturers, regulators). Name the source of " +
          "each key fact (publication, edition, section) so the reader can verify it. If editions " +
          "matter, say which edition you're describing. Be direct and complete without padding.",
        user: question,
        maxTokens: 3000,
        webSearch: true,
      });
      const citations = out.webSources.map((s, i) => ({
        n: i + 1, url: s.url, title: s.title ?? s.url,
      }));
      await supabaseAdmin.from("knowledge_questions").insert({
        org_id: orgId, library_id: libraryId, user_id: user.id, user_name: userName,
        question, answer: out.text, citations, provider, model, mode: "internet",
      }).then(async (r) => {
        // Pre-migration DBs lack the mode column — retry without it.
        if (r.error?.code === "PGRST204" || r.error?.message?.includes("mode")) {
          await supabaseAdmin.from("knowledge_questions").insert({
            org_id: orgId, library_id: libraryId, user_id: user.id, user_name: userName,
            question, answer: out.text, citations, provider, model,
          });
        }
      });
      await supabaseAdmin.from("audit_logs").insert({
        action: "KNOWLEDGE_ASKED",
        resource_type: "knowledge_library", resource_id: libraryId,
        org_id: orgId, user_id: user.id,
        details: { library: library.name, question: question.slice(0, 200), mode: "internet", liveWeb: out.liveWeb },
      }).then(() => undefined, () => undefined);
      await meter(true);
      return NextResponse.json({
        answer: out.text, citations, provider, model, mode: "internet", liveWeb: out.liveWeb,
        budget: budget(),
      });
    } catch (e) {
      await meter(false);
      if (e instanceof AiCallError) return bad(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
      return bad(`Ask failed: ${(e as Error).message}`, 502);
    }
  }

  try {
    // ── Step 1: question → search queries ────────────────────────────────
    const queryText = await call({
      system:
        'You generate full-text search queries for a technical document library at an oil refinery. ' +
        'Given a question, reply with ONLY a JSON array of 2-5 short keyword queries (2-6 words each) ' +
        'that would find the relevant passages. Include exact designations (like "ASME B16.5") verbatim ' +
        'when present. Standards often use different wording than the question (e.g. "support spacing" ' +
        'tables answer "span between supports" questions) — vary the vocabulary across queries. ' +
        'CHECKLIST QUESTIONS ("what do I need to…", "requirements for…") span MANY topics — cover every ' +
        'facet the question implies (qualifications, documentation, testing, safety, materials…), one ' +
        'query per facet. No prose, no code fence — just the JSON array.',
      user: question,
      maxTokens: 1000,
    });
    const queries = parseSearchQueries(queryText.text, question);

    // Search the asked library first (governing) then each linked library
    // (reference) — governing gets the deeper cut, links a smaller one.
    const searchLibraries: Array<{ id: string; tier: "governing" | "reference" }> = [
      { id: libraryId, tier: "governing" },
      ...linkedLibraries.map((l) => ({ id: l.id, tier: "reference" as const })),
    ];
    const runSearches = async (qs: string[]): Promise<RetrievedChunk[][]> => {
      const out: RetrievedChunk[][] = [];
      for (const lib of searchLibraries) {
        for (const q of qs) {
          const { data } = await supabaseAdmin.rpc("knowledge_search", {
            p_org: orgId, p_library: lib.id, p_query: q,
            p_limit: lib.tier === "governing" ? 10 : 6,
          });
          if (Array.isArray(data)) {
            out.push((data as RetrievedChunk[]).map((c) => ({ ...c, libraryId: lib.id, tier: lib.tier })));
          }
        }
      }
      return out;
    };
    type TieredChunk = RetrievedChunk & { libraryId?: string; tier?: "governing" | "reference" };
    // Governing passages keep the bigger share of the context budget.
    const mergeTiered = (batches: TieredChunk[][]): TieredChunk[] => {
      const flat = batches;
      const governing = mergeRetrieved(
        flat.map((b) => b.filter((c) => (c as TieredChunk).tier !== "reference")), 14,
      ) as TieredChunk[];
      const reference = mergeRetrieved(
        flat.map((b) => b.filter((c) => (c as TieredChunk).tier === "reference")), 8,
      ) as TieredChunk[];
      return [...governing, ...reference];
    };

    // ── Retrieval round 1 ────────────────────────────────────────────────
    const batches = (await runSearches(queries)) as TieredChunk[][];
    let chunks = mergeTiered(batches);

    // ── Reference-chasing round: the model reviews what came back and can
    //    (a) issue NEW queries — different vocabulary, or NAMING a document
    //    the passages reference ("per STD-205", "as required by B31.3") so
    //    the answer follows the spaghetti instead of stopping at one strand;
    //    (b) declare documents that are referenced but apparently absent.
    const missingDocs: string[] = [];
    {
      const preview = chunks.length === 0
        ? "(nothing matched the first-round queries)"
        : chunks.slice(0, 14).map((c, i) =>
            `[${i + 1}] (${libNameById.get(c.libraryId ?? libraryId) ?? "library"}) p.${c.page}: ${c.content.slice(0, 180)}`).join("\n");
      const refineOut = await call({
        system:
          'You review passages retrieved from technical document libraries to answer a question. These ' +
          'standards are spaghetti: one references another ("per STD-205", "as required by ASME B31.3") ' +
          'and part of the answer often lives in the referenced document. Also, checklist questions span ' +
          'many sections — first-round retrieval often catches only SOME of the requirements.\n' +
          'Reply with ONLY a JSON object: {"queries": [...], "missing_documents": [...]}\n' +
          '- "queries": 0-4 NEW searches — different vocabulary for weak coverage, searches NAMING any ' +
          'referenced document ("STD-205 bolting torque"), and searches for facets of the question not ' +
          'yet covered by the passages.\n' +
          '- "missing_documents": designations of documents the passages REFERENCE for the answer that ' +
          'these libraries likely do not contain (e.g. "ASME B31.3"). Empty array if none.\n' +
          'If the passages fully cover the question, reply {"queries": [], "missing_documents": []}.',
        user: `QUESTION: ${question}\n\nRETRIEVED SO FAR:\n${preview}`,
        maxTokens: 800,
      }).catch(() => null);
      const plan = refineOut ? parseFollowupPlan(refineOut.text) : { queries: [], missingDocs: [] };
      if (plan.queries.length > 0) {
        const more = (await runSearches(plan.queries)) as TieredChunk[][];
        chunks = mergeTiered([...batches, ...more]);
      }
      // Validate claimed-missing docs: if a search for the designation hits
      // real passages in ANY reachable library, it isn't missing.
      for (const docRef of plan.missingDocs.slice(0, 4)) {
        const probes = await runSearches([docRef]);
        const hits = probes.flat().length;
        if (hits < 2) missingDocs.push(docRef);
      }
    }

    if (chunks.length === 0) {
      const answer =
        "**Answer:** Nothing in " + (hasLinks ? "this library or its linked libraries" : "this library") +
        " matches the question. It may not be covered by the indexed documents, or it may use different " +
        "terminology — try rephrasing with the exact terms the standard would use." +
        (missingDocs.length > 0 ? `\n! The answer likely lives in: ${missingDocs.join(", ")} — not in your libraries.` : "");
      await supabaseAdmin.from("knowledge_questions").insert({
        org_id: orgId, library_id: libraryId, user_id: user.id, user_name: userName,
        question, answer, citations: [], provider, model,
      });
      await meter(true);
      return NextResponse.json({
        answer, citations: [], provider, model, mode: "library", missingDocs, budget: budget(),
      });
    }

    // Names for the documents the chunks came from.
    const docIds = [...new Set(chunks.map((c) => c.document_id))];
    const { data: docs } = await supabaseAdmin
      .from("knowledge_documents").select("id, name").in("id", docIds);
    const docName = new Map((docs ?? []).map((d) => [d.id as string, d.name as string]));

    // ── Step 2: passages → cited answer ──────────────────────────────────
    // Passages carry document STRUCTURE (§) and, when libraries are linked,
    // the PRECEDENCE TIER — governing site standards vs reference code books.
    const passages = chunks.map((c, i) => {
      const sec = c.section ? `, ${c.section}` : "";
      const tierLabel = hasLinks
        ? `${c.tier === "reference" ? "REFERENCE" : "GOVERNING"} — ${libNameById.get(c.libraryId ?? libraryId) ?? "library"} | `
        : "";
      return `[${i + 1}] (${tierLabel}${docName.get(c.document_id) ?? "Document"}${sec}, page ${c.page})\n${c.content}`;
    }).join("\n\n");

    const precedence = hasLinks
      ? "\n\nPRECEDENCE: passages are labeled GOVERNING (the asked library — site standards) or " +
        "REFERENCE (linked libraries — code books/external references). GOVERNING documents supersede " +
        "REFERENCE minimums. When a GOVERNING passage is silent or explicitly defers (\"per B31.3\"), " +
        "the REFERENCE passage governs. ALWAYS state which document wins and why (e.g. \"site standard " +
        "requires 250 ft-lb [2], exceeding the code minimum [5] — site standard governs\")."
      : "";
    const standing = aiInstructions
      ? `\n\nLIBRARY OWNER'S STANDING INSTRUCTIONS (follow them):\n${aiInstructions.slice(0, 2000)}`
      : "";
    const missing = missingDocs.length > 0
      ? `\n\nKNOWN GAPS: the passages reference these documents, which are NOT in the libraries: ${missingDocs.join(", ")}. ` +
        "Where part of the answer depends on one, say so with an \"! \" line — do not guess its content."
      : "";

    const answerOut = await call({
      system:
        "You are the reference-library assistant for a refinery document control system. Answer the " +
        "question USING ONLY the numbered passages provided.\n\n" +
        "OUTPUT FORMAT — follow it exactly, no deviations, no preamble, no restating the question:\n" +
        "**Answer:** the direct answer in one or two sentences with its [n] markers. Mandatory, first.\n" +
        "**Basis:**\n" +
        "- bullets, one fact each, with its [n] marker and the section/table name when the passage " +
        "label shows one (e.g. \"per §5.3 Pipe Supports [2]\").\n" +
        "! lines starting with \"! \" are ESCALATED VISUALLY as big warnings — use one for anything " +
        "imperative: a MUST, a hold point, a verification the reader cannot skip, or a gap.\n" +
        "**Check:** (when needed) what to verify on the cited page — REQUIRED whenever a value comes " +
        "from a table, because PDF table extraction jumbles numbers.\n\n" +
        "EMPHASIS: wrap every key identifier — document numbers, section refs, specific values and " +
        "limits — in **bold**. Put exact values/designations in `backticks` (rendered as value chips): " +
        "`250 ft-lb`, `ASME B31.3`, `Table 121.5`.\n\n" +
        "COMPLETENESS: for checklist/what-do-I-need questions, completeness BEATS brevity — enumerate " +
        "EVERY requirement found across ALL passages, grouped under short **bold** group names; never " +
        "stop at the first passage's list. If the passages suggest more requirements exist beyond what " +
        "was retrieved (a referenced appendix, a continued table), END with an \"! \" line saying what " +
        "may be missing and where to look. For single-value questions stay under 120 words.\n\n" +
        "NEVER invent requirements, values, or clause numbers. If passages only partially answer, " +
        "**Answer:** says exactly what's covered and what isn't. Engineers act on these answers." +
        precedence + standing + missing,
      user: `PASSAGES:\n\n${passages}\n\nQUESTION: ${question}`,
      maxTokens: 4000,
    });
    const answer = answerOut.text;

    // Citations the answer actually used, in order of first use — each
    // carries the VERBATIM passage so the UI can show exactly what the
    // answer was built from (expand → read the source text → open the page).
    const used = extractCitationNumbers(answer);
    const citations = used
      .filter((n) => n >= 1 && n <= chunks.length)
      .map((n) => {
        const c = chunks[n - 1];
        return {
          n,
          documentId: c.document_id,
          documentName: docName.get(c.document_id) ?? "Document",
          page: c.page,
          section: c.section ?? null,
          quote: c.content.slice(0, 1600),
          ...(hasLinks ? {
            libraryName: libNameById.get(c.libraryId ?? libraryId) ?? "Library",
            tier: c.tier ?? "governing",
          } : {}),
        };
      });

    await supabaseAdmin.from("knowledge_questions").insert({
      org_id: orgId, library_id: libraryId, user_id: user.id, user_name: userName,
      question, answer, citations, provider, model, mode: "library",
      missing_docs: missingDocs.length > 0 ? missingDocs : null,
    }).then(async (r) => {
      // Pre-migration DBs lack mode/missing_docs — retry with the core set.
      if (r.error?.code === "PGRST204" || /mode|missing_docs/.test(r.error?.message ?? "")) {
        await supabaseAdmin.from("knowledge_questions").insert({
          org_id: orgId, library_id: libraryId, user_id: user.id, user_name: userName,
          question, answer, citations, provider, model,
        });
      }
    });
    await supabaseAdmin.from("audit_logs").insert({
      action: "KNOWLEDGE_ASKED",
      resource_type: "knowledge_library", resource_id: libraryId,
      org_id: orgId, user_id: user.id,
      details: {
        library: library.name, question: question.slice(0, 200),
        citations: citations.length, linkedLibraries: linkedLibraries.length,
        missingDocs,
      },
    }).then(() => undefined, () => undefined);
    await meter(true);

    return NextResponse.json({
      answer, citations, provider, model, mode: "library", missingDocs, budget: budget(),
    });
  } catch (e) {
    await meter(false);
    if (e instanceof AiCallError) return bad(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
    return bad(`Ask failed: ${(e as Error).message}`, 502);
  }
}
