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
import { loadPrincipal, readableControlledDocIds } from "@/lib/knowledgeAccess";
import { buildEquipmentCensus, auditDrawingRefs, extractEquipmentTags } from "@/lib/drawingText";
import { renderKnowledgePages, MAX_DEEP_READ_PAGES } from "@/lib/knowledgePageRender";

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

  let body: {
    orgId?: string; libraryId?: string; question?: string; mode?: string;
    focus?: unknown; inputs?: unknown;
  };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const libraryId = String(body.libraryId ?? "").trim();
  const question = String(body.question ?? "").trim().slice(0, 2000);
  // Aspects the asker picked from a clarify round ("Safety", "Design"…) —
  // when present the answer narrows to them and no new clarify is proposed.
  const focus = Array.isArray(body.focus)
    ? body.focus.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
        .map((f) => f.trim().slice(0, 60)).slice(0, 6)
    : [];
  // Values the asker supplied after a **Need:** round ("test temperature =
  // 150°F") — calculation inputs the documents can't know.
  const inputs = typeof body.inputs === "string" ? body.inputs.trim().slice(0, 1000) : "";
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
    .from("knowledge_libraries").select("*").eq("id", libraryId).eq("org_id", orgId).maybeSingle();
  if (!library) return bad("Library not found", 404);
  // Additive per-library AI feature toggles ({} on pre-20260918 DBs).
  const aiFeatures = (library.ai_features ?? {}) as Record<string, unknown>;
  const clarifyEnabled = aiFeatures.clarifyFacets === true && focus.length === 0 && !inputs;
  // Deep read is DEFAULT ON — reading tables/formulas as printed is baseline
  // behavior, not a feature. The checkbox is an opt-OUT for token thrift.
  const visionEnabled = aiFeatures.visionPages !== false;

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

  // ── Per-asker ACL filter over source-linked documents ───────────────────
  // Knowledge docs mirrored from document control inherit its ACLs: exclude
  // from retrieval every mirror whose CONTROLLED document this asker can't
  // read — two people can ask the same question and correctly get different
  // answers. Upload-origin docs stay org-readable, unchanged. Fails CLOSED:
  // if the readable set can't be computed, linked docs are excluded.
  let excludedDocIds = new Set<string>();
  {
    const allLibIds = [libraryId, ...linkedLibraries.map((l) => l.id)];
    const { data: linkedDocs, error: linkErr } = await supabaseAdmin
      .from("knowledge_documents")
      .select("id, source_document_id")
      .in("library_id", allLibIds)
      .not("source_document_id", "is", null);
    // linkErr (42703 on a pre-20260917 DB) = no source columns = no mirrors.
    if (!linkErr && linkedDocs && linkedDocs.length > 0) {
      try {
        const principal = await loadPrincipal(orgId, user.id);
        if (!principal) throw new Error("no principal");
        const dcIds = [...new Set(linkedDocs.map((d) => d.source_document_id as string))];
        const readable = await readableControlledDocIds(principal, dcIds);
        excludedDocIds = new Set(
          linkedDocs
            .filter((d) => !readable.has(d.source_document_id as string))
            .map((d) => d.id as string),
        );
      } catch {
        excludedDocIds = new Set(linkedDocs.map((d) => d.id as string));
      }
    }
  }

  // PER-USER KEYS ONLY: every question runs on the ASKER'S own key — their
  // money, their meter. No workspace fallback exists. A key on a blocked
  // provider (a grandfathered Gemini row) is dead weight: never called.
  const { data: conn } = await supabaseAdmin
    .from("ai_connections").select("user_id, provider, model, api_key")
    .eq("org_id", orgId)
    .eq("user_id", user.id)
    .maybeSingle();
  const usable = !!conn && ALLOWED_PROVIDERS.includes(conn.provider as AiProviderId);
  if (!usable) {
    return bad(
      conn
        ? "Your saved key uses a blocked provider — only Anthropic (Claude) and OpenAI are " +
          "allowed, because their API traffic is never used for model training. Save a Claude " +
          "or OpenAI key in AI settings."
        : "You haven't added your API key yet — every member uses their own. Add a Claude or " +
          "OpenAI key in AI settings first.",
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
      user: [
        question,
        focus.length > 0 ? `(The user narrowed this to: ${focus.join(", ")} — target the queries there.)` : "",
        inputs ? `(User-provided inputs: ${inputs} — include queries for the tables/values these imply.)` : "",
      ].filter(Boolean).join("\n\n"),
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
            out.push(
              (data as RetrievedChunk[])
                .filter((c) => !excludedDocIds.has(c.document_id))
                .map((c) => ({ ...c, libraryId: lib.id, tier: lib.tier })),
            );
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
          (clarifyEnabled
            ? '- OPTIONALLY "clarify": {"question": "...", "options": ["...", "..."]} — ONLY when the ' +
              'retrieved passages answer the question across MULTIPLE genuinely DISTINCT aspects (e.g. ' +
              'safety requirements vs fabrication requirements vs design limits) AND answering all of ' +
              'them would bury the asker in mostly-irrelevant material. 2-6 short option labels naming ' +
              'the aspects found IN THE PASSAGES. Omit "clarify" for single-aspect questions — a needless ' +
              'clarification is worse than a long answer.\n'
            : '') +
          'If the passages fully cover the question, reply {"queries": [], "missing_documents": []}.',
        user: `QUESTION: ${question}\n\nRETRIEVED SO FAR:\n${preview}`,
        maxTokens: 800,
      }).catch(() => null);
      const plan = refineOut
        ? parseFollowupPlan(refineOut.text)
        : { queries: [], missingDocs: [], clarify: null };
      // ── Clarify round (opt-in per library): the answer spans several
      //    distinct aspects — ask WHICH before answering, instead of burying
      //    the asker in mostly-irrelevant material. Returns before the big
      //    answer call, so a clarify round is cheap.
      if (clarifyEnabled && plan.clarify && chunks.length > 0) {
        await meter(true);
        return NextResponse.json({
          clarification: plan.clarify,
          provider, model, mode: "library",
          budget: budget(),
        });
      }
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

    // ── DRAWING FACTS: deterministic layer for P&ID/drawing libraries ────
    // Retrieval finds where something is WRITTEN; it cannot count vessels
    // or audit references. When the library has extracted entities, compute
    // the census + reference audit and hand them to the model as trusted
    // facts — count questions answer from DATA, not from 14 passages.
    let drawingFacts = "";
    try {
      const allLibIds = [libraryId, ...linkedLibraries.map((l) => l.id)];
      const { data: entRows } = await supabaseAdmin
        .from("knowledge_page_entities")
        .select("document_id, kind, tag")
        .in("library_id", allLibIds)
        .limit(20000);
      const ents = ((entRows ?? []) as Array<{ document_id: string; kind: string; tag: string }>)
        .filter((e) => !excludedDocIds.has(e.document_id));
      if (ents.length > 0) {
        const { data: dRows } = await supabaseAdmin
          .from("knowledge_documents").select("id, name").in("library_id", allLibIds);
        const docsList = ((dRows ?? []) as Array<{ id: string; name: string }>)
          .filter((d) => !excludedDocIds.has(d.id));
        const census = buildEquipmentCensus(ents.filter((e) => e.kind === "equipment"));
        const refsByDoc = new Map<string, string[]>();
        for (const r of ents.filter((e) => e.kind === "ref")) {
          const list = refsByDoc.get(r.document_id) ?? [];
          list.push(r.tag);
          refsByDoc.set(r.document_id, list);
        }
        // Identities each sheet declared in its own title block.
        const selfByDoc = new Map<string, string[]>();
        for (const e of ents.filter((x) => x.kind === "self")) {
          const list = selfByDoc.get(e.document_id) ?? [];
          if (!list.includes(e.tag)) list.push(e.tag);
          selfByDoc.set(e.document_id, list);
        }
        const audit = auditDrawingRefs(docsList, refsByDoc, selfByDoc);
        const declaredCount = docsList.filter((d) => selfByDoc.has(d.id)).length;
        drawingFacts =
          "\n\nDRAWING FACTS — computed deterministically from EVERY sheet's extracted tags. TRUST " +
          "these for counts and totals (the passages above are excerpts, never the whole picture):\n" +
          `- Sheets: ${docsList.length}` +
          (declaredCount > 0
            ? ` (${declaredCount} declare their identity in their own title block — drawing number/sheet/rev were READ, not inferred)`
            : " (no title-block identities could be read; sheet identity falls back to filenames)") + "\n" +
          `- Equipment, distinct tags: ${census.totalDistinct}` +
          (census.categories.length > 0
            ? " — " + census.categories.slice(0, 12)
                .map((c) => `${c.label} [${c.prefix}]: ${c.distinctTags}`).join("; ")
            : "") + "\n" +
          (census.unknownPrefixes.length > 0
            ? `- Unrecognized tag prefixes: ${census.unknownPrefixes.slice(0, 8).join(", ")} — if asked about these, say you need the site's tag legend.\n`
            : "") +
          `- Drawing cross-references: ${audit.totalRefs} total; ${audit.resolved} resolve to sheets ` +
          "that ARE loaded.\n" +
          `- SCOPE of this drawing set — series loaded: ${audit.seriesInScope.join(", ") || "(unknown)"}.\n` +
          `- Referenced but NOT loaded, SAME series (gaps in this set — actionable): ` +
          (audit.missingInSeries.length > 0
            ? `${audit.missingInSeries.length} — ${audit.missingInSeries.slice(0, 10).map((m) => `${m.ref}×${m.count}`).join(", ")}`
            : "none") + "\n" +
          `- Referenced but NOT loaded, DIFFERENT series (outside this set — EXPECTED, NOT broken): ` +
          (audit.outOfScope.length > 0
            ? audit.outOfScope.slice(0, 10).map((o) =>
                `${o.series} (${o.count} connector(s): ${o.refs.slice(0, 6).join(", ")})`).join("; ")
            : "none") + "\n" +
          `- One-way connectors (BOTH sheets loaded, reference runs only one direction): ` +
          (audit.oneWay.length > 0
            ? `${audit.oneWay.length} — ` + audit.oneWay.slice(0, 6).map((o) => `${o.from} → ${o.to}`).join("; ")
            : "none") + "\n" +
          "- The full tag list is in the library's Drawing intelligence panel (equipment register export).\n" +
          "- When the user asks to SEE or FIND specific equipment, keep the answer short and lean on " +
          "the citations: every cited sheet opens in the viewer with the named tags ringed on the " +
          "drawing itself.\n" +
          "\nCONNECTOR SCOPE RULE (non-negotiable): a connector pointing to a DIFFERENT series is not " +
          "broken, missing, or an error — the user gave you one unit's drawings and every unit ends at " +
          "battery limits that hand off to units you weren't given. NEVER report those as broken or as " +
          "problems. Say what you CAN audit (connectors inside the loaded series, plus same-series " +
          "sheets that are absent), then NAME the exact series/drawing numbers you'd need to extend " +
          "the audit, and note that adding them will in turn expose their own outward connectors — " +
          "so the audit is always bounded by what's loaded. Reserve the words broken/missing for: " +
          "same-series sheets that are absent, one-way connectors between loaded sheets, and " +
          "malformed drawing numbers.";
      }
    } catch { /* pre-migration DB — no facts */ }

    if (chunks.length === 0 && !drawingFacts) {
      // Diagnose WHY before shrugging: "your search terms missed" and "your
      // documents contain no machine-readable text at all" need completely
      // different advice.
      const { count: anyChunks } = await supabaseAdmin
        .from("knowledge_chunks")
        .select("id", { count: "exact", head: true })
        .in("library_id", [libraryId, ...linkedLibraries.map((l) => l.id)]);
      const answer = (anyChunks ?? 0) === 0
        ? "**Answer:** Nothing is indexed from these documents yet — every page came back with **no " +
          "text layer**. That is normal for AutoCAD exports drawn with **SHX fonts** (the tags plot as " +
          "line-work, not text) and for scans.\n" +
          "! Fix: open this library and press **Rebuild index** with your AI key saved — pages without " +
          "text are read by **AI vision** during indexing, which makes their tags, connectors, and notes " +
          "searchable. Rephrasing the question will not help until that runs.\n" +
          "**Basis:**\n" +
          "- Every indexed page in this library yielded zero extractable text.\n" +
          "- Vision indexing bills to your own key and counts against your monthly cap.\n" +
          "- Re-issuing the drawings with TrueType fonts is the alternative — then plain text extraction works."
        : "**Answer:** Nothing in " + (hasLinks ? "this library or its linked libraries" : "this library") +
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

    // Names (and file keys, for the deep-read render) of the documents the
    // chunks came from.
    const docIds = [...new Set(chunks.map((c) => c.document_id))];
    const { data: docs } = await supabaseAdmin
      .from("knowledge_documents").select("id, name, file_key").in("id", docIds);
    const docName = new Map((docs ?? []).map((d) => [d.id as string, d.name as string]));
    const docFileKey = new Map((docs ?? []).map((d) => [d.id as string, d.file_key as string]));

    // ── DEEP READ (default ON): the model must READ pages as printed —
    //    formulas typeset as figures, stress tables like B31.3 Table A-1.
    //    Three sources of pages, all bounded:
    //      (a) the top-ranked passage pages;
    //      (b) pages of tables/figures the passages LEAN ON ("per Table
    //          A-1") — tables rank terribly in text search (text-thin), so
    //          they're hunted by name and attached proactively;
    //      (c) pages the MODEL requests mid-answer via the Fetch loop below.
    const allSearchLibIds = [libraryId, ...linkedLibraries.map((l) => l.id)];

    // Pages whose text contains ALL tokens — how "Table A-1" (+ qualifiers)
    // resolves to printable pages. ACL-filtered like everything else.
    const findPagesByText = async (
      tokens: string[], cap: number,
    ): Promise<Array<{ documentId: string; page: number }>> => {
      const terms = tokens.map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 4);
      if (terms.length === 0) return [];
      let q = supabaseAdmin.from("knowledge_chunks")
        .select("document_id, page")
        .in("library_id", allSearchLibIds)
        .limit(300);
      for (const t of terms) q = q.ilike("content", `%${t}%`);
      const { data } = await q;
      const counts = new Map<string, number>();
      for (const r of (data ?? []) as Array<{ document_id: string; page: number }>) {
        if (excludedDocIds.has(r.document_id)) continue;
        const key = `${r.document_id}:${r.page}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap)
        .map(([key]) => {
          const [documentId, page] = key.split(":");
          return { documentId, page: Number(page) };
        });
    };

    const renderTargets = async (
      targets: Array<{ documentId: string; page: number }>, max: number,
    ): Promise<Array<{ base64: string; mediaType: string; page: number; documentId: string }>> => {
      const byDoc = new Map<string, number[]>();
      for (const t of targets) {
        const list = byDoc.get(t.documentId) ?? [];
        list.push(t.page);
        byDoc.set(t.documentId, list);
      }
      const out: Array<{ base64: string; mediaType: string; page: number; documentId: string }> = [];
      for (const [documentId, pages] of byDoc) {
        let fileKey = docFileKey.get(documentId);
        if (!fileKey) {
          // Fetch targets can live in docs outside the retrieved set.
          const { data: extra } = await supabaseAdmin
            .from("knowledge_documents").select("id, name, file_key")
            .eq("id", documentId).maybeSingle();
          if (extra) {
            docFileKey.set(documentId, extra.file_key as string);
            docName.set(documentId, extra.name as string);
            fileKey = extra.file_key as string;
          }
        }
        if (!fileKey) continue;
        const rendered = await renderKnowledgePages(fileKey, pages, max - out.length);
        out.push(...rendered.map((r) => ({ ...r, documentId })));
        if (out.length >= max) break;
      }
      return out;
    };

    let pageImages: Array<{ base64: string; mediaType: string; page: number; documentId: string }> = [];
    if (visionEnabled && chunks.length > 0) {
      const targets: Array<{ documentId: string; page: number }> = [];
      const seen = new Set<string>();
      const addTarget = (documentId: string, page: number) => {
        const key = `${documentId}:${page}`;
        if (!seen.has(key)) { seen.add(key); targets.push({ documentId, page }); }
      };
      // (a) top-ranked passage pages
      for (const c of chunks.slice(0, 3)) addTarget(c.document_id, c.page);
      // (b) hunted table/figure pages
      const refCounts = new Map<string, number>();
      for (const c of chunks) {
        for (const m of c.content.matchAll(/\b(?:Table|Fig(?:ure)?\.?)\s+[A-Z0-9][A-Z0-9.\-]{0,10}/gi)) {
          const label = m[0].replace(/\s+/g, " ").trim();
          refCounts.set(label, (refCounts.get(label) ?? 0) + 1);
        }
      }
      const topRefs = [...refCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      for (const [label] of topRefs) {
        for (const hit of await findPagesByText([label], 2)) addTarget(hit.documentId, hit.page);
      }
      pageImages = await renderTargets(targets, MAX_DEEP_READ_PAGES);
    }

    // ── Step 2: passages → cited answer ──────────────────────────────────
    // Passages carry document STRUCTURE (§) and, when libraries are linked,
    // the PRECEDENCE TIER — governing site standards vs reference code books.
    const passages = chunks.length === 0
      ? "(no text passages matched the question's search terms — answer from the DRAWING FACTS if they cover it, otherwise say what's missing)"
      : chunks.map((c, i) => {
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
    const focusDirective = focus.length > 0
      ? `\n\nFOCUS: the user was asked which aspects they want and chose: ${focus.join(", ")}. ` +
        "Answer ONLY those aspects. If another aspect contains something safety-critical they must not " +
        "miss, give it ONE \"! \" line pointing at it — nothing more."
      : "";
    const calcProtocol =
      "\n\nCALCULATIONS: when the question requires computing from a cited formula (test pressures, " +
      "spans, thicknesses…): (1) transcribe the formula EXACTLY as printed with its variable " +
      "definitions [n]; (2) list every input with its source — a cited passage [n], a table lookup " +
      "(name the table and the exact row/column you read), or USER-PROVIDED; (3) substitute and " +
      "compute step by step; (4) state units, and end with a **Check:** naming the table cells to " +
      "verify. If a required input is user-specific (test temperature, design pressure, material " +
      "grade…) and was NOT provided, do NOT assume a value: reply with ONLY one line " +
      "'**Need:** <one specific question naming exactly which value(s) you need and why>' — nothing else.";
    const buildPagesNote = (imgs: typeof pageImages) => imgs.length > 0
      ? "\n\nPRINTED PAGES: attached are the actual page images, in order: " +
        imgs.map((img, i) =>
          `image ${i + 1} = ${docName.get(img.documentId) ?? "Document"} page ${img.page}`).join("; ") +
        ". Use them to read tables, formulas, and figures EXACTLY as printed — they outrank the " +
        "extracted text when the two disagree. A value read from a page image cites the [n] of a " +
        "passage from that same page (or names the document and page when no passage matches)."
      : "";
    const fetchDirective = visionEnabled
      ? "\n\nFETCHING PAGES: if you need to SEE a table, figure, or page that is NOT attached (e.g. " +
        "`Table A-1` to read a stress value), reply with ONLY one line " +
        "'**Fetch:** <table/figure name plus qualifiers — material grade, temperature, document>' and " +
        "those pages will be attached and the question re-asked. NEVER guess a table value, and NEVER " +
        "tell the user to look a value up themselves when a Fetch could read it."
      : "";
    const providedInputs = inputs
      ? `\n\nUSER-PROVIDED INPUTS (treat as given): ${inputs}`
      : "";

    const baseAnswerSystem =
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
      precedence + standing + missing + focusDirective + drawingFacts + calcProtocol + fetchDirective;
    const answerUser = `PASSAGES:\n\n${passages}${providedInputs}\n\nQUESTION: ${question}`;

    // ── Answer + Fetch loop: the model can request pages it needs to SEE
    //    (one round). The tool does the reading — the user is never sent to
    //    look up a table by hand.
    let answerOut = await call({
      system: baseAnswerSystem + buildPagesNote(pageImages),
      user: answerUser,
      maxTokens: 4000,
      ...(pageImages.length > 0
        ? { images: pageImages.map((img) => ({ base64: img.base64, mediaType: img.mediaType })) }
        : {}),
    });
    {
      const fetchReq = visionEnabled ? answerOut.text.trim().match(/^\*\*Fetch:\*\*\s*([\s\S]+)$/) : null;
      if (fetchReq) {
        const rawTerms = fetchReq[1].trim().slice(0, 120);
        const tokens = rawTerms.split(/[\s,;+]+/).filter((t) => t.length >= 2).slice(0, 4);
        let hits = await findPagesByText(tokens, 3);
        if (hits.length === 0 && tokens.length > 2) hits = await findPagesByText(tokens.slice(0, 2), 3);
        const fetched = hits.length > 0 ? await renderTargets(hits, 3) : [];
        const fetchNote = fetched.length > 0
          ? "\n\nFETCHED: the pages you requested are attached at the END of the image list — read the value there."
          : `\n\nFETCH RESULT: no pages matched "${rawTerms}". Answer with what you have and state ` +
            "plainly which value could not be read and exactly where it lives (document, table).";
        if (fetched.length > 0) pageImages = [...pageImages, ...fetched];
        answerOut = await call({
          system: baseAnswerSystem + buildPagesNote(pageImages) + fetchNote,
          user: answerUser,
          maxTokens: 4000,
          ...(pageImages.length > 0
            ? { images: pageImages.map((img) => ({ base64: img.base64, mediaType: img.mediaType })) }
            : {}),
        });
      }
    }
    const answer = answerOut.text;

    // Citations the answer actually used, in order of first use — each
    // carries the VERBATIM passage so the UI can show exactly what the
    // answer was built from (expand → read the source text → open the page).
    const used = extractCitationNumbers(answer);

    // Which equipment tags does the ANSWER talk about? On a drawing, that's
    // what the viewer points at — highlighting a quoted passage is useless
    // when the sheet has no text layer to highlight in.
    const answerTags = new Set(extractEquipmentTags(answer).map((t) => t.tag));
    const questionTags = extractEquipmentTags(question).map((t) => t.tag);
    for (const t of questionTags) answerTags.add(t);
    const citedPageTags = new Map<string, string[]>();
    if (answerTags.size > 0 && used.length > 0) {
      const pages = used
        .filter((n) => n >= 1 && n <= chunks.length)
        .map((n) => chunks[n - 1]);
      try {
        const { data: tagRows } = await supabaseAdmin
          .from("knowledge_page_entities")
          .select("document_id, page, tag")
          .in("document_id", [...new Set(pages.map((c) => c.document_id))])
          .in("tag", [...answerTags])
          .limit(5000);
        for (const r of (tagRows ?? []) as Array<{ document_id: string; page: number; tag: string }>) {
          const key = `${r.document_id}:${r.page}`;
          const list = citedPageTags.get(key) ?? [];
          if (!list.includes(r.tag)) list.push(r.tag);
          citedPageTags.set(key, list);
        }
      } catch { /* pre-migration DB — citations simply carry no tags */ }
    }

    type CitationOut = {
      n: number; documentId: string; documentName: string; page: number;
      section: string | null; quote: string; tags?: string[];
      libraryName?: string; tier?: string;
    };
    const citations: CitationOut[] = used
      .filter((n) => n >= 1 && n <= chunks.length)
      .map((n) => {
        const c = chunks[n - 1];
        const pageTags = citedPageTags.get(`${c.document_id}:${c.page}`) ?? [];
        return {
          n,
          documentId: c.document_id,
          documentName: docName.get(c.document_id) ?? "Document",
          page: c.page,
          section: c.section ?? null,
          quote: c.content.slice(0, 1600),
          ...(pageTags.length > 0 ? { tags: pageTags.slice(0, 12) } : {}),
          ...(hasLinks ? {
            libraryName: libNameById.get(c.libraryId ?? libraryId) ?? "Library",
            tier: c.tier ?? "governing",
          } : {}),
        };
      });

    // ── SHOW-ME GUARANTEE for drawings ────────────────────────────────────
    // Text citations exist only where RETRIEVAL found passages. On a P&ID
    // the answer often comes from the DRAWING FACTS layer — counts, sheet
    // assignments — with zero passages behind it, which used to mean zero
    // citations: "V-10 is on 025-PID-0103" with nothing to click. Any tag
    // the question or answer names that no citation covers gets a direct
    // sheet citation from the entity index, so the viewer can open the
    // drawing and ring it. ACL-filtered like everything else.
    try {
      const covered = new Set(citations.flatMap((c) => c.tags ?? []));
      const wanted = [...answerTags].filter((t) => !covered.has(t)).slice(0, 8);
      if (wanted.length > 0) {
        const { data: locRows } = await supabaseAdmin
          .from("knowledge_page_entities")
          .select("document_id, page, tag, raw")
          .eq("library_id", libraryId)
          .eq("kind", "equipment")
          .in("tag", wanted)
          .limit(2000);
        const firstByTag = new Map<string, { document_id: string; page: number; raw: string | null }>();
        for (const r of (locRows ?? []) as Array<{ document_id: string; page: number; tag: string; raw: string | null }>) {
          if (excludedDocIds.has(r.document_id)) continue;
          if (!firstByTag.has(r.tag)) firstByTag.set(r.tag, r);
        }
        // One citation per sheet+page, carrying every tag found there.
        const grouped = new Map<string, { document_id: string; page: number; tags: string[]; raws: string[] }>();
        for (const [tag, loc] of firstByTag) {
          const key = `${loc.document_id}:${loc.page}`;
          const g = grouped.get(key) ?? { document_id: loc.document_id, page: loc.page, tags: [], raws: [] };
          g.tags.push(tag);
          if (loc.raw) g.raws.push(loc.raw);
          grouped.set(key, g);
        }
        const unnamed = [...new Set([...grouped.values()].map((g) => g.document_id))]
          .filter((id) => !docName.has(id));
        if (unnamed.length > 0) {
          const { data: extraDocs } = await supabaseAdmin
            .from("knowledge_documents").select("id, name").in("id", unnamed);
          for (const d of extraDocs ?? []) docName.set(d.id as string, d.name as string);
        }
        let nextN = citations.reduce((m, c) => Math.max(m, c.n), 0);
        for (const g of grouped.values()) {
          citations.push({
            n: ++nextN,
            documentId: g.document_id,
            documentName: docName.get(g.document_id) ?? "Sheet",
            page: g.page,
            section: null,
            quote: g.raws.slice(0, 4).join("\n"),
            tags: g.tags.slice(0, 12),
          });
        }
      }
    } catch { /* entity layer absent (pre-20260921) — text citations only */ }

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
