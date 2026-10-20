// lib/ask/knowledgeAskHandler.ts — the question-answering engine for
// knowledge libraries. Served by /api/knowledge/ask (plain JSON) and by
// /api/chat/ask (streamed, persisted) — see lib/ask/types.ts.
//
// POST { orgId, libraryId, question } →
//   { answer, citations: [{n, documentId, documentName, page}], provider, model }
//
// Two model calls on the asker's EFFECTIVE connection (their personal key if
// they set one, else the org default — always their money, never ours):
//
//   1. Turn the question into 2-4 full-text search queries. Keyword search is
//      the half that never misses an exact tag, and the model writes better
//      queries for it than a user typing one phrase.
//
//      Alongside it, when the asker's key is OpenAI, the ORIGINAL question is
//      embedded and searched by nearest neighbour, and the two result lists
//      are fused by RANK (lib/hybridRank.ts) — never by score, because
//      ts_rank and cosine similarity are different units. An Anthropic key
//      gets keyword search alone and the response says so, because an answer
//      that implies a semantic search that never ran is the worst failure
//      this route has.
//   2. Answer FROM the retrieved passages only, citing [n] markers that map
//      to (document, page) — every claim traceable to a real page.
//
// Every Q&A lands in knowledge_questions (the library's own record) and the
// ai_usage_events meter.

import { ok, fail, type AskHandlerInput, type AskHandlerResult } from "@/lib/ask/types";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { TAG_ENTITY_KINDS } from "@/lib/knowledgeEntityKinds";
import { loadOrgInstructionsBlock } from "@/lib/aiInstructionsServer";
import { loadAnswerSkillsBlock } from "@/lib/answerSkillsServer";
import { VISION_MODEL } from "@/lib/knowledgeVision";
import { callAiModel, AiCallError, type AiProviderId, type AiCallInput } from "@/lib/ai/providerCall";
import {
  ALLOWED_PROVIDERS, estimateCostUsd, AGREEMENT_VERSION, buildAgreementText,
} from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import {
  parseSearchQueries, parseFollowupPlan, extractCitationNumbers, sanitizeStorageText, truncateSafe,
  type RetrievedChunk, mergeRetrievedRRF,
  extractEvidenceBlock, extractAnswerMeta, enforceDocumentsOnly, locateSpan, type EvidenceSpan, type EvidenceRole,
} from "@/lib/knowledgeText";
import { fuseRankings } from "@/lib/hybridRank";
import { embeddingConnectionFrom } from "@/lib/ai/embeddings";
import { openAiKey } from "@/lib/ai/keyVault";
import { loadPrincipal, readableControlledDocIds } from "@/lib/knowledgeAccess";
import {
  buildEquipmentCensus, auditDrawingRefs, extractEquipmentTags, extractDrawingRefs, parseUnitMap,
  parsePrefixMap, matchEquipmentListIntent, EQUIPMENT_CATEGORIES,
} from "@/lib/drawingText";
import { renderKnowledgePages, MAX_DEEP_READ_PAGES } from "@/lib/knowledgePageRender";
import { loadCodebookAdmin, codebookToDecoderText } from "@/lib/codebookServer";
import { loadCatalog, loadPipeClasses } from "@/lib/knowledgeCatalogServer";
import {
  buildCatalogBlock, pipeClassFacts, findClassMentions, formsForGoal, matchCatalogName, FORM_PURPOSES,
  type CatalogEntry,
} from "@/lib/knowledgeCatalog";

const bad = fail;

export async function handleKnowledgeAsk(input: AskHandlerInput): Promise<AskHandlerResult> {
  const { user, emit } = input;
  const extraSystem = input.extraSystem ?? "";
  const userImages = input.userImages ?? [];
  const body = input.body as {
    orgId?: string; libraryId?: string; question?: string; mode?: string;
    focus?: unknown; inputs?: unknown;
    history?: unknown; threadId?: unknown; answerMode?: unknown;
  };
  const orgId = String(body.orgId ?? "").trim();
  const libraryId = String(body.libraryId ?? "").trim();
  const question = truncateSafe(sanitizeStorageText(String(body.question ?? "").trim()), 2000);
  // Aspects the asker picked from a clarify round ("Safety", "Design"…) —
  // when present the answer narrows to them and no new clarify is proposed.
  const focus = Array.isArray(body.focus)
    ? body.focus.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
        .map((f) => f.trim().slice(0, 60)).slice(0, 6)
    : [];
  // Values the asker supplied after a **Need:** round ("test temperature =
  // 150°F") — calculation inputs the documents can't know.
  const inputs = typeof body.inputs === "string" ? truncateSafe(sanitizeStorageText(body.inputs.trim()), 1000) : "";
  // "library" (default): answers ONLY from the indexed documents, page-cited.
  // "internet": the provider's live web tool (or model knowledge where the
  // provider has none) — clearly labeled, never mixed with library citations.
  const mode = body.mode === "internet" ? "internet" : "library";
  // How the answer is shaped. Unset = the model picks from the question;
  // set when the asker taps "Rethink as…" under an answer.
  const answerMode = body.answerMode === "compliance" || body.answerMode === "explore"
    || body.answerMode === "answer" || body.answerMode === "deviation"
    ? body.answerMode : null;
  // Prior turns of THIS conversation — what makes "what about 1 inch?"
  // answerable. Capped hard: 4 turns, answers truncated, because the
  // passages must stay the star of the context window.
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((t): t is { question: string; answer: string } =>
      !!t && typeof (t as { question?: unknown }).question === "string"
      && typeof (t as { answer?: unknown }).answer === "string")
    .slice(-4)
    .map((t) => ({ question: t.question.slice(0, 500), answer: t.answer.slice(0, 1200) }));
  const threadId = typeof body.threadId === "string" && /^[0-9a-f-]{36}$/i.test(body.threadId)
    ? body.threadId : null;
  // Pages earlier turns of THIS conversation cited, most decisive first.
  // They ride along as evidence on every follow-up — an answer must never
  // call a passage "not loaded" that it quoted one turn ago. Every pin is
  // re-checked against the asker's reachable documents before use.
  const pinned = (Array.isArray((body as { pinned?: unknown }).pinned) ? (body as { pinned: unknown[] }).pinned : [])
    .filter((p): p is { documentId: string; page: number } =>
      !!p && typeof (p as { documentId?: unknown }).documentId === "string"
      && /^[0-9a-f-]{36}$/i.test((p as { documentId: string }).documentId)
      && Number.isInteger((p as { page?: unknown }).page) && (p as { page: number }).page >= 1)
    .slice(0, 12);
  const conversationBlock = history.length > 0
    ? "CONVERSATION SO FAR (the question may refer back to it):\n"
      + history.map((t) => `Q: ${t.question}\nA: ${t.answer}`).join("\n---\n") + "\n\n"
    : "";
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
  // DOCUMENTS ONLY is the default and the promise of Library mode: every
  // statement comes from this library's documents (or what the asker said).
  // General engineering knowledge — still clearly tagged — is an explicit
  // per-library opt-in, never something the answer drifts into.
  const allowGeneral = aiFeatures.allowGeneralKnowledge === true;

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
  // Owner-taught numbering scheme ("first two digits = unit: 20 = Crude…").
  // A library with NO decoder of its own inherits the org's Site Codebook —
  // taught once in Admin → Site Codebook, spoken here automatically. A
  // library-level decoder is a full override for odd drawing sets.
  const libraryDecoder = String((aiFeatures.decoder as string | undefined) ?? "").trim();
  const siteBook = await loadCodebookAdmin(supabaseAdmin, orgId);
  const decoderText = libraryDecoder || codebookToDecoderText(siteBook);
  const unitMap = parseUnitMap(decoderText);
  // Owner-taught tag prefixes ("X- = Exchanger") — they beat the built-ins.
  const prefixLabels = parsePrefixMap(decoderText);
  // Legend / decoder SHEETS: the library's own attachments first, then the
  // codebook's site-wide legend fills any remaining slots (3 total).
  const legendDocIds = [
    ...(Array.isArray(aiFeatures.legendDocIds) ? aiFeatures.legendDocIds : [])
      .filter((x): x is string => typeof x === "string"),
    ...siteBook.legendDocIds,
  ].filter((id, i, arr) => arr.indexOf(id) === i).slice(0, 3);

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
  // Ask for the embedding columns, but never let their absence break asking.
  // They arrive with migration 20260930; a workspace that hasn't run it yet
  // must keep answering questions on keyword search, not 500.
  const BASE_CONN = "user_id, provider, model, api_key";
  const readConn = async (columns: string) => supabaseAdmin
    .from("ai_connections").select(columns)
    .eq("org_id", orgId).eq("user_id", user.id).maybeSingle();
  let connRes = await readConn(
    `${BASE_CONN}, embedding_provider, embedding_model, embedding_api_key`,
  );
  if (connRes.error && (connRes.error.code === "42703" || /column/i.test(connRes.error.message))) {
    connRes = await readConn(BASE_CONN);
  }
  const conn = connRes.data as unknown as Record<string, string | null> | null;
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
  const apiKey = openAiKey(conn.api_key);
  // Decrypted copy — everything downstream (embeddings included) sees
  // usable keys, never the sealed at-rest form.
  const connRow = {
    ...conn,
    api_key: apiKey,
    embedding_api_key: openAiKey(conn.embedding_api_key),
  };

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
      return {
        status: 428,
        json: {
          error: "Before your first question, read and accept the AI acceptable-use agreement.",
          agreementRequired: true,
          agreementText: buildAgreementText(provider),
          agreementVersion: AGREEMENT_VERSION,
        },
      };
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
  // Did meaning-based retrieval actually run? Reported to the caller so the
  // UI can say "keyword only" instead of implying a semantic search that
  // never happened — an answer quietly missing its best source, with no way
  // for the reader to know why, is the worst failure this route has.
  let semanticUsed = false;
  const call = async (input: Omit<AiCallInput, "provider" | "model" | "apiKey">) => {
    const out = await callAiModel({ provider, model, apiKey, ...input });
    askUsage.inputTokens += out.usage.inputTokens;
    askUsage.outputTokens += out.usage.outputTokens;
    return out;
  };
  // Planning calls (search queries, the refine round) are short JSON jobs
  // that don't need a frontier model — they run on the provider's fast tier,
  // which takes seconds off every question before the answer starts. Falls
  // back to the asker's own model if the fast tier is refused. Metered with
  // the ask at the asker's model rate, so the cap over-estimates, never under.
  const callFast = async (input: Omit<AiCallInput, "provider" | "model" | "apiKey">) => {
    const fast = VISION_MODEL[provider];
    if (!fast || fast === model) return call(input);
    try {
      const out = await callAiModel({ provider, model: fast, apiKey, ...input });
      askUsage.inputTokens += out.usage.inputTokens;
      askUsage.outputTokens += out.usage.outputTokens;
      return out;
    } catch {
      return call(input);
    }
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
      emit({ t: "status", text: "Searching the web" });
      const out = await call({
        system:
          "You are the reference assistant for a refinery document control system. The user chose " +
          "INTERNET mode, so answer from the web / your general knowledge — this answer is explicitly " +
          "NOT from their controlled internal documents, and you must not pretend it is. Prefer " +
          "authoritative sources (standards bodies, manufacturers, regulators). Name the source of " +
          "each key fact (publication, edition, section) so the reader can verify it. If editions " +
          "matter, say which edition you're describing. Be direct and complete without padding." +
          extraSystem,
        user: question,
        maxTokens: 3000,
        webSearch: true,
        ...(userImages.length > 0 ? { images: userImages } : {}),
        onDelta: (text) => emit({ t: "delta", text }),
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
      return ok({
        answer: out.text, citations, provider, model, mode: "internet", liveWeb: out.liveWeb,
        budget: budget(),
      });
    } catch (e) {
      await meter(false);
      if (e instanceof AiCallError) return bad(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
      return bad(`Ask failed: ${(e as Error).message}`, 502);
    }
  }

  // The documents this conversation has leaned on, heaviest first — the
  // default subject of a follow-up that names none ("show me table 1").
  const conversationDocIds: string[] = [];
  {
    const weight = new Map<string, number>();
    pinned.forEach((p, i) => weight.set(p.documentId, (weight.get(p.documentId) ?? 0) + (pinned.length - i)));
    conversationDocIds.push(...[...weight.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id));
  }
  const conversationDocNames = new Map<string, string>();
  if (conversationDocIds.length > 0) {
    const { data } = await supabaseAdmin
      .from("knowledge_documents").select("id, name").in("id", conversationDocIds);
    for (const d of (data ?? []) as Array<{ id: string; name: string }>) {
      if (!excludedDocIds.has(d.id)) conversationDocNames.set(d.id, d.name);
    }
  }

  try {
    // ── Step 1: question → search queries ────────────────────────────────
    emit({ t: "status", text: userImages.length > 0 ? "Reading your attachment and writing search queries" : "Writing search queries" });
    const queryText = await callFast({
      system:
        'You generate full-text search queries for a technical document library at an oil refinery. ' +
        'Given a question, reply with ONLY a JSON array of 2-5 short keyword queries (2-6 words each) ' +
        'that would find the relevant passages. Include exact designations (like "ASME B16.5") verbatim ' +
        'when present. Standards often use different wording than the question (e.g. "support spacing" ' +
        'tables answer "span between supports" questions) — vary the vocabulary across queries. ' +
        'CHECKLIST QUESTIONS ("what do I need to…", "requirements for…") span MANY topics — cover every ' +
        'facet the question implies (qualifications, documentation, testing, safety, materials…), one ' +
        'query per facet. ' +
        'MATERIAL / PRODUCT-FORM ACCEPTABILITY questions ("can I use welded 304", "is A106 ok") ' +
        'always get a query for the materials-selection tables ("acceptable piping materials ' +
        'table", "Table 1 acceptable materials") alongside the material itself. ' +
        'DEVIATION / "WHY IS THIS REQUIRED" questions also get queries for the REASON behind the rule ' +
        '(the clause topic plus "because", "intent", "to prevent", "purpose") and for the exception or ' +
        'deviation process ("deviation request", "exception approval Owner\'s Engineer"). ' +
        (answerMode === "deviation" ? 'THIS QUESTION IS A DEVIATION CASE — include those queries. ' : '') +
        'ATTACHED IMAGES are the asker\'s own photo, markup, or document: read every identifying string ' +
        'in them — spec and grade stencils ("A312 TP304 WLD"), heat numbers, tags, nameplates, drawing ' +
        'and document numbers — and use those exact terms in the queries alongside the question\'s. ' +
        'No prose, no code fence — just the JSON array.',
      user: [
        // Follow-ups arrive as fragments ("what about at the boiler?") —
        // the retrieval queries must be written against the CONVERSATION,
        // not the fragment, or every follow-up searches for nothing.
        history.length > 0
          ? "(Follow-up in a conversation. Recent turns:\n" +
            history.slice(-3).map((t) =>
              `Q: ${t.question}\nA (abridged): ${truncateSafe(t.answer, 400)}`).join("\n---\n") +
            (conversationDocNames.size > 0
              ? `\nDocuments the conversation has relied on: ${[...conversationDocNames.values()].slice(0, 4).join(", ")}.`
              : "") +
            "\nResolve pronouns and ellipsis against these turns; carry forward the material, equipment, " +
            "documents, and constraints they establish when writing queries. A bare reference like " +
            "\"table 1\" means the one in the document the conversation is about — name that document " +
            "in the query.)"
          : "",
        question,
        focus.length > 0 ? `(The user narrowed this to: ${focus.join(", ")} — target the queries there.)` : "",
        inputs ? `(User-provided inputs: ${inputs} — include queries for the tables/values these imply.)` : "",
      ].filter(Boolean).join("\n\n"),
      maxTokens: 1000,
      ...(userImages.length > 0 ? { images: userImages } : {}),
    });
    const queries = parseSearchQueries(queryText.text, question);
    emit({ t: "status", text: `Searching the library — ${queries.length} quer${queries.length === 1 ? "y" : "ies"}` });

    // ── ALIAS RESOLUTION: the graph's nickname layer feeds retrieval ─────
    // People ask about "the boiler"; the index stores B-101. asset_aliases
    // records that equivalence (taught once on the asset page) — but until
    // now only the document-search box consulted it; the AI ask path never
    // did. Any alias the question uses now resolves to its canonical tag,
    // and the tag becomes a search query of its own.
    try {
      const { data: aliasRows } = await supabaseAdmin
        .from("asset_aliases").select("alias, asset_id")
        .eq("org_id", orgId).limit(500);
      const qLower = ` ${question.toLowerCase()} `;
      const hitAssetIds = [...new Set(
        ((aliasRows ?? []) as Array<{ alias: string; asset_id: string }>)
          .filter((a) => a.alias && a.alias.length >= 3 && qLower.includes(` ${a.alias.toLowerCase()}`))
          .map((a) => a.asset_id),
      )].slice(0, 4);
      if (hitAssetIds.length > 0) {
        const { data: aliasAssets } = await supabaseAdmin
          .from("assets").select("tag").in("id", hitAssetIds);
        for (const a of (aliasAssets ?? []) as Array<{ tag: string }>) {
          if (a.tag && !queries.some((q) => q.toUpperCase().includes(a.tag.toUpperCase()))) {
            queries.push(a.tag);
          }
        }
      }
    } catch { /* alias layer absent — retrieval unchanged */ }

    // Search the asked library first (governing) then each linked library
    // (reference) — governing gets the deeper cut, links a smaller one.
    const searchLibraries: Array<{ id: string; tier: "governing" | "reference" }> = [
      { id: libraryId, tier: "governing" },
      ...linkedLibraries.map((l) => ({ id: l.id, tier: "reference" as const })),
    ];
    const runSearches = async (qs: string[]): Promise<RetrievedChunk[][]> => {
      // Every (library × query) pair is independent — 3 libraries × 4
      // queries used to be 12 SERIAL round trips, doubled by retries. The
      // fan-out now runs concurrently; latency is the slowest single search.
      const jobs = searchLibraries.flatMap((lib) => qs.map((q) => ({ lib, q })));
      const out = await Promise.all(jobs.map(async ({ lib, q }) => {
        // Over-fetch 3× the slot count: AI-excluded documents are filtered
        // HERE, after the database already applied its LIMIT — at exactly
        // the slot count, a user whose top-ranked docs are excluded got a
        // silently starved passage set and an empty-state message blaming
        // their phrasing.
        const limit = (lib.tier === "governing" ? 10 : 6) * 3;
        let { data } = await supabaseAdmin.rpc("knowledge_search", {
          p_org: orgId, p_library: lib.id, p_query: q, p_limit: limit,
        });
        // websearch syntax ANDs every term: "crude preheat exchanger"
        // misses a chunk that says "CRUDE HEAT EXCHANGER" because it lacks
        // "preheat". A multi-word query that comes back THIN — not just
        // empty; one weak hit is not coverage — retries OR-ed, and the two
        // result sets merge rather than the retry replacing the original.
        if ((!Array.isArray(data) || data.length < 3) && /\s/.test(q.trim())) {
          const ored = q.trim().split(/\s+/).filter(Boolean).join(" or ");
          const { data: more } = await supabaseAdmin.rpc("knowledge_search", {
            p_org: orgId, p_library: lib.id, p_query: ored, p_limit: limit,
          });
          if (Array.isArray(more)) {
            const seen = new Set((Array.isArray(data) ? data : []).map((c: RetrievedChunk) => c.id));
            data = [...(Array.isArray(data) ? data : []),
              ...(more as RetrievedChunk[]).filter((c) => !seen.has(c.id))];
          }
        }
        if (!Array.isArray(data)) return [] as RetrievedChunk[];
        return (data as RetrievedChunk[])
          .filter((c) => !excludedDocIds.has(c.document_id))
          .slice(0, lib.tier === "governing" ? 10 : 6)
          .map((c) => ({ ...c, libraryId: lib.id, tier: lib.tier }));
      }));
      return out;
    };
    type TieredChunk = RetrievedChunk & { libraryId?: string; tier?: "governing" | "reference" };

    // ── The meaning half ────────────────────────────────────────────────
    //
    // Keyword search finds "PSV-2001" and nothing beats it at that. It does
    // NOT find the standard that says "hanger and support details" when
    // somebody asks about pipe supports. So the ORIGINAL question — not the
    // generated keyword queries, which have already thrown the phrasing away
    // — gets embedded once and searched by nearest neighbour.
    //
    // Unavailable is a normal state, not an error: no OpenAI key, no
    // migration, or nothing embedded yet all mean keyword search alone, which
    // is exactly what this product did yesterday.
    const runSemantic = async (extraQueries: string[] = []): Promise<TieredChunk[]> => {
      // The EMBEDDING key, not the chat key. A Claude user with a Voyage key
      // gets meaning-based retrieval; a Claude user with no embedding key gets
      // keyword search, which is what this route always did.
      const embedding = embeddingConnectionFrom(connRow);
      if (!embedding) return [];
      try {
        // Compare in the space the CORPUS actually lives in. The vectors were
        // stamped with the model that built them; if the user's saved model
        // has since changed (a settings re-save mid-setup), filtering by the
        // connection's model would exclude every vector in the library and
        // semantic search would silently return nothing. Embed the query with
        // the corpus's own model — same provider key serves all its models.
        const { data: stamped } = await supabaseAdmin
          .from("knowledge_chunks").select("embedding_model")
          .eq("org_id", orgId).eq("library_id", libraryId)
          .not("embedding", "is", null).not("embedding_model", "is", null)
          .limit(1).maybeSingle();
        const corpusModel = (stamped?.embedding_model as string | null) ?? embedding.model;
        const { embedQuery, toVectorLiteral } = await import("@/lib/ai/embeddings");
        // The raw question, plus any refine-round queries: each gets its own
        // nearest-neighbour list, and the union feeds the fusion the same way
        // multiple keyword queries do.
        const texts = extraQueries.length > 0 ? extraQueries : [question];
        const literals: string[] = [];
        for (const t of texts.slice(0, 3)) {
          literals.push(toVectorLiteral(
            await embedQuery(embedding.provider, corpusModel, embedding.apiKey, t)));
        }
        const found: TieredChunk[] = [];
        const jobs: Array<{ lib: typeof searchLibraries[number]; literal: string }> = [];
        for (const lib of searchLibraries) for (const literal of literals) jobs.push({ lib, literal });
        const results = await Promise.all(jobs.map(({ lib, literal }) =>
          supabaseAdmin.rpc("semantic_search", {
            p_org_id: orgId, p_library_id: lib.id, p_embedding: literal,
            p_limit: lib.tier === "governing" ? 12 : 6,
            // Only compare against vectors from the same model — a corpus
            // embedded by another provider lives in a different space.
            p_model: corpusModel,
          }).then((r) => ({ lib, r }))));
        for (const { lib, r } of results) {
          const { data, error } = r;
          if (error || !Array.isArray(data)) continue;
          for (const row of data as Array<{
            chunk_id: string; document_id: string; page: number; content: string; similarity: number;
          }>) {
            if (excludedDocIds.has(row.document_id)) continue;
            found.push({
              id: row.chunk_id, document_id: row.document_id, page: row.page,
              content: row.content, rank: row.similarity,
              libraryId: lib.id, tier: lib.tier,
            });
          }
        }
        return found;
      } catch {
        return [];                       // degrade to keyword, never fail the ask
      }
    };

    /**
     * Combine the two halves.
     *
     * By RANK, never by score: a ts_rank of 0.06 and a cosine similarity of
     * 0.83 are different units, and any arithmetic mixing them is
     * superstition. Reciprocal rank fusion keeps only the ordering, so a
     * passage both retrievers surfaced wins and a passage only one found
     * still places — which is the entire reason for running both.
     */
    const fuseTier = (
      keyword: TieredChunk[], meaning: TieredChunk[], cap: number,
    ): TieredChunk[] => {
      // Fill slots with a per-document cap: without it, nothing stopped all
      // 14 governing slots landing on one document — adjacent overlapping
      // chunks of the same page are mutually high-ranking by construction.
      // 3 per document, then backfill from the remainder if slots are left.
      const diversify = (ranked: TieredChunk[]): TieredChunk[] => {
        const picked: TieredChunk[] = [];
        const perDoc = new Map<string, number>();
        const overflow: TieredChunk[] = [];
        for (const c of ranked) {
          if (picked.length >= cap) break;
          const n = perDoc.get(c.document_id) ?? 0;
          if (n >= 3) { overflow.push(c); continue; }
          perDoc.set(c.document_id, n + 1);
          picked.push(c);
        }
        for (const c of overflow) {
          if (picked.length >= cap) break;
          picked.push(c);
        }
        return picked;
      };
      if (meaning.length === 0) return diversify(keyword);
      return diversify(fuseRankings<TieredChunk>(
        [{ source: "keyword", items: keyword }, { source: "meaning", items: meaning }],
        (c) => c.id,
      ).map((f) => f.item));
    };
    // Governing passages keep the bigger share of the context budget.
    const mergeTiered = (batches: TieredChunk[][]): TieredChunk[] => {
      const flat = batches;
      const governing = mergeRetrievedRRF(
        flat.map((b) => b.filter((c) => (c as TieredChunk).tier !== "reference")), 14,
      ) as TieredChunk[];
      const reference = mergeRetrievedRRF(
        flat.map((b) => b.filter((c) => (c as TieredChunk).tier === "reference")), 8,
      ) as TieredChunk[];
      return [...governing, ...reference];
    };

    // ── Retrieval round 1 ────────────────────────────────────────────────
    // Both halves run concurrently — the embedding call is one small round
    // trip and must not add its latency on top of the keyword searches.
    const [batches, semantic] = await Promise.all([
      runSearches(queries) as Promise<TieredChunk[][]>,
      runSemantic(),
    ]);
    semanticUsed = semantic.length > 0;
    const keywordMerged = mergeTiered(batches);
    let chunks = [
      ...fuseTier(
        keywordMerged.filter((c) => c.tier !== "reference"),
        semantic.filter((c) => c.tier !== "reference"),
        14,
      ),
      ...fuseTier(
        keywordMerged.filter((c) => c.tier === "reference"),
        semantic.filter((c) => c.tier === "reference"),
        8,
      ),
    ];

    // One roster of every reachable document — reused by proven-ground,
    // pull-by-name, whole-document mode, and the graph hop, so designation
    // resolution is one fetch instead of four.
    type ReachableDoc = {
      id: string; name: string; library_id: string; file_key: string | null;
      status: string | null; page_count: number | null; pages_indexed: number | null;
    };
    const squashDes = (t: string) => t.toUpperCase().replace(/[^A-Z0-9]/g, "");
    let reachableDocs: ReachableDoc[] = [];
    {
      const reachableLibIds = [libraryId, ...linkedLibraries.map((l) => l.id)];
      const { data } = await supabaseAdmin
        .from("knowledge_documents")
        .select("id, name, library_id, file_key, status, page_count, pages_indexed")
        .in("library_id", reachableLibIds);
      reachableDocs = ((data ?? []) as ReachableDoc[]).filter((d) => !excludedDocIds.has(d.id));
    }
    // Passages that hold their seat no matter how the ranking reshuffles —
    // proven-ground pages and pages earlier turns cited. A refine round
    // rebuilds `chunks` from the search results and used to drop these.
    const reserved: TieredChunk[] = [];
    const reachableIds = new Set(reachableDocs.map((d) => d.id));

    // ── CONVERSATION EVIDENCE: the pages earlier turns cited ─────────────
    const pinnedChunkIds = new Set<string>();
    if (pinned.length > 0) {
      try {
        const usablePins = pinned.filter((p) => reachableIds.has(p.documentId));
        const pinDocIds = [...new Set(usablePins.map((p) => p.documentId))];
        const pinPages = [...new Set(usablePins.map((p) => p.page))];
        if (pinDocIds.length > 0) {
          const { data: pc } = await supabaseAdmin
            .from("knowledge_chunks").select("id, document_id, page, content, section")
            .eq("org_id", orgId).in("document_id", pinDocIds).in("page", pinPages)
            .order("seq", { ascending: true })
            .limit(80);
          const rows = (pc ?? []) as RetrievedChunk[];
          const have = new Set(chunks.map((c) => c.id));
          for (const p of usablePins) {
            let perPage = 0;
            for (const c of rows) {
              if (c.document_id !== p.documentId || c.page !== p.page || perPage >= 2) continue;
              perPage++;
              pinnedChunkIds.add(c.id);
              const libId = reachableDocs.find((d) => d.id === c.document_id)?.library_id ?? libraryId;
              const tiered: TieredChunk = {
                ...c, rank: 1, libraryId: libId, tier: libId === libraryId ? "governing" : "reference",
              };
              reserved.push(tiered);
              if (!have.has(c.id)) { chunks.push(tiered); have.add(c.id); }
            }
            if (pinnedChunkIds.size >= 12) break;
          }
        }
      } catch { /* conversation memory is additive — retrieval stands without it */ }
    }

    // ── THE CATALOG: what the libraries hold, and pipe classes in play ────
    // The model is told what exists — forms, checklists, specs, standard
    // drawings — so finding "the checklist for this" is the system's job.
    // Pipe classes the conversation names come in as trusted table rows,
    // and their pages join the passages so they can be cited and marked.
    const catalog = await loadCatalog(supabaseAdmin, {
      orgId, libraryIds: [libraryId, ...linkedLibraries.map((l) => l.id)], excludedDocIds,
    });
    const pipeClasses = await loadPipeClasses(supabaseAdmin, {
      orgId, libraryIds: [libraryId, ...linkedLibraries.map((l) => l.id)], excludedDocIds,
      text: [question, ...history.slice(-3).map((t) => `${t.question}\n${t.answer.slice(0, 600)}`), inputs].join("\n"),
      match: findClassMentions,
    });
    if (pipeClasses.length > 0) {
      const have = new Set(chunks.map((c) => c.id));
      const pairs = [...new Map(pipeClasses.map((r) => [`${r.documentId}:${r.page}`, r])).values()].slice(0, 6);
      for (const r of pairs) {
        const { data: pc } = await supabaseAdmin
          .from("knowledge_chunks").select("id, document_id, library_id, page, content, section")
          .eq("org_id", orgId).eq("document_id", r.documentId).eq("page", r.page)
          .order("seq", { ascending: true }).limit(3);
        for (const c of (pc ?? []) as Array<RetrievedChunk & { library_id: string }>) {
          if (have.has(c.id)) continue;
          have.add(c.id);
          const tiered: TieredChunk = { ...c, rank: 1, libraryId: c.library_id, tier: c.library_id === libraryId ? "governing" : "reference" };
          reserved.push(tiered);
          chunks.push(tiered);
        }
      }
    }

    // ── PROVEN GROUND: answers the team rated 👍 teach retrieval. When a
    //    similar question was answered before and a human confirmed the
    //    answer was right, the pages it cited get seats in the pool before
    //    any ranking — the closest thing RAG has to learning from use.
    try {
      const { data: proven } = await supabaseAdmin
        .from("knowledge_questions")
        .select("citations")
        .eq("library_id", libraryId).eq("rating", 1)
        .textSearch("question", question, { type: "websearch", config: "english" })
        .order("created_at", { ascending: false })
        .limit(2);
      const pairs: Array<{ documentId: string; page: number }> = [];
      for (const row of (proven ?? []) as Array<{ citations: Array<{ documentId?: string; page?: number }> | null }>) {
        for (const c of row.citations ?? []) {
          if (c.documentId && typeof c.page === "number" && !excludedDocIds.has(c.documentId)) {
            pairs.push({ documentId: c.documentId, page: c.page });
          }
        }
      }
      if (pairs.length > 0) {
        const have = new Set(chunks.map((c) => c.id));
        for (const p of pairs.slice(0, 6)) {
          const { data: pc } = await supabaseAdmin
            .from("knowledge_chunks").select("id, document_id, page, content, section")
            .eq("org_id", orgId).eq("document_id", p.documentId).eq("page", p.page)
            .limit(2);
          for (const c of (pc ?? []) as RetrievedChunk[]) {
            if (have.has(c.id)) continue;
            have.add(c.id);
            const tiered: TieredChunk = { ...c, rank: 1, libraryId, tier: "governing" };
            reserved.push(tiered);
            chunks.push(tiered);
          }
        }
      }
    } catch { /* pre-20261013 DB (no rating column) — retrieval unchanged */ }

    // ── Reference-chasing round: the model reviews what came back and can
    //    (a) issue NEW queries — different vocabulary, or NAMING a document
    //    the passages reference ("per STD-205", "as required by B31.3") so
    //    the answer follows the spaghetti instead of stopping at one strand;
    //    (b) declare documents that are referenced but apparently absent.
    const missingDocs: string[] = [];
    // Documents that ARE in the library but can't answer: zero or partial
    // indexed pages. Named in the answer so "bad results" become "re-index
    // EP 5-1-1" instead of a silent gap.
    const partialDocs: string[] = [];
    // Documents the question NAMED (matched by designation against document
    // names) — candidates for whole-document reading below.
    const namedDocs: Array<{ id: string; name: string; libraryId: string }> = [];
    const questionDocIds = new Set<string>();
    {
      const preview = chunks.length === 0
        ? "(nothing matched the first-round queries)"
        : chunks.slice(0, 14).map((c, i) =>
            `[${i + 1}] (${libNameById.get(c.libraryId ?? libraryId) ?? "library"}) p.${c.page}: ${truncateSafe(c.content, 180)}`).join("\n");
      emit({ t: "status", text: chunks.length === 0
        ? "Nothing matched yet — rewriting the search"
        : `Reviewing ${chunks.length} passage${chunks.length === 1 ? "" : "s"} and chasing references` });
      const refineOut = await callFast({
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
        user: (history.length > 0
          ? `EARLIER IN THIS CONVERSATION:\n${history.slice(-3).map((t) => `Q: ${truncateSafe(t.question, 200)}`).join("\n")}` +
            (conversationDocNames.size > 0
              ? `\nDocuments relied on so far: ${[...conversationDocNames.values()].slice(0, 4).join(", ")}`
              : "") + "\n\n"
          : "") + `QUESTION: ${question}\n\nRETRIEVED SO FAR:\n${preview}`,
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
        return ok({
          clarification: plan.clarify,
          provider, model, mode: "library",
          budget: budget(),
        });
      }
      if (plan.queries.length > 0) {
        // Round 2 must not undo round 1. This line used to rebuild `chunks`
        // from the keyword batches alone — throwing the semantic half away
        // on every non-trivial question while the response still reported
        // "hybrid". The refine queries also run through the vector index
        // now: "per STD-205" follow-ups were the one genuinely multi-hop
        // path in the system, and they were keyword-only.
        const [more, semantic2] = await Promise.all([
          runSearches(plan.queries) as Promise<TieredChunk[][]>,
          runSemantic(plan.queries.slice(0, 2)),
        ]);
        const keyword2 = mergeTiered([...batches, ...more]);
        const meaning = [...semantic, ...semantic2];
        chunks = [
          ...fuseTier(
            keyword2.filter((c) => c.tier !== "reference"),
            meaning.filter((c) => c.tier !== "reference"),
            14,
          ),
          ...fuseTier(
            keyword2.filter((c) => c.tier === "reference"),
            meaning.filter((c) => c.tier === "reference"),
            8,
          ),
        ];
        const have = new Set(chunks.map((c) => c.id));
        for (const c of reserved) {
          if (!have.has(c.id)) { chunks.push(c); have.add(c.id); }
        }
      }
      // ── PULL BY NAME: chunk search finds text INSIDE pages, so a document
      //    whose pages don't repeat its own designation is unfindable by
      //    content even though it sits in the library — the exact failure
      //    behind "EP 5-1-1 is not in the loaded passages at all" while
      //    EP 5-1-1 was right there in the Documents list. Designations from
      //    the model's plan AND the question are matched against DOCUMENT
      //    NAMES across every reachable library; matched documents contribute
      //    reserved passages that bypass ranking entirely.
      const squashName = squashDes;
      const designations = new Set<string>();
      for (const src of [...plan.missingDocs, ...plan.queries, question]) {
        for (const m of src.matchAll(/\b[A-Za-z]{1,8}[- ]?\d+(?:[-.]\d+)*[A-Za-z]?\b/g)) {
          const sq = squashName(m[0]);
          if (sq.length >= 4 && /\d/.test(sq) && /[A-Z]/.test(sq)) designations.add(m[0].trim());
        }
      }
      const matchedDesignations = new Set<string>();
      if (designations.size > 0) {
        const docRows = reachableDocs;
        const targets: Array<{ doc: ReachableDoc; designation: string }> = [];
        for (const des of designations) {
          const sq = squashName(des);
          for (const d of docRows) {
            if (!squashName(d.name).includes(sq)) continue;
            matchedDesignations.add(des);
            if (!targets.some((t) => t.doc.id === d.id)) targets.push({ doc: d, designation: des });
          }
        }
        // The TOPIC behind the designation: the refine query that mentioned
        // it, minus the designation itself ("EP 5-1-1 suction line sizing" →
        // "suction line sizing"); the raw question when there isn't one.
        const topicFor = (des: string): string => {
          const q = plan.queries.find((x) => squashName(x).includes(squashName(des)));
          const stripped = (q ?? "").split(des).join(" ").replace(/\s+/g, " ").trim();
          return stripped.length >= 6 ? stripped : question;
        };
        for (const t of targets.slice(0, 3)) {
          namedDocs.push({ id: t.doc.id, name: t.doc.name, libraryId: t.doc.library_id });
        }
        const pulls = await Promise.all(targets.slice(0, 3).map(async ({ doc, designation }) => {
          let rows: RetrievedChunk[] = [];
          const { data, error } = await supabaseAdmin.rpc("knowledge_search_document", {
            p_org: orgId, p_document: doc.id, p_query: topicFor(designation), p_limit: 5,
          });
          if (!error && Array.isArray(data)) rows = data as RetrievedChunk[];
          if (rows.length === 0) {
            // Pre-migration DB (no RPC yet): the document's first pages —
            // scope and definitions — still beat returning nothing.
            const { data: front } = await supabaseAdmin
              .from("knowledge_chunks").select("id, document_id, page, content, section")
              .eq("org_id", orgId).eq("document_id", doc.id)
              .order("page", { ascending: true }).order("seq", { ascending: true })
              .limit(4);
            rows = ((front ?? []) as RetrievedChunk[]).map((c) => ({ ...c, rank: 0 }));
          }
          // The most actionable diagnosis this route can make: the document
          // IS here but its index can't answer for it.
          if (rows.length === 0) {
            partialDocs.push(`${doc.name} — 0 indexed pages; re-index it`);
          } else if (doc.page_count && (doc.pages_indexed ?? 0) < doc.page_count && doc.status !== "indexing") {
            partialDocs.push(`${doc.name} — only ${doc.pages_indexed ?? 0} of ${doc.page_count} pages indexed; re-index it`);
          }
          return rows.map((c) => ({ ...c, libraryId: doc.library_id, tier: "governing" as const }));
        }));
        const targeted = pulls.flat();
        const have = new Set(chunks.map((c) => c.id));
        for (const c of targeted.slice(0, 10)) {
          if (!have.has(c.id)) { chunks.push(c); have.add(c.id); }
        }
      }
      // Documents the QUESTION itself names, as opposed to ones the model's
      // plan brought up — "Table 1" resolves to theirs first.
      for (const m of question.matchAll(/\b[A-Za-z]{1,8}[- ]?\d+(?:[-.]\d+)*[A-Za-z]?\b/g)) {
        const sq = squashName(m[0]);
        if (sq.length < 4 || !/\d/.test(sq) || !/[A-Z]/.test(sq)) continue;
        for (const d of reachableDocs) if (squashName(d.name).includes(sq)) questionDocIds.add(d.id);
      }
      // A follow-up that names no document is about the one the
      // conversation has been reading. It joins the named documents (after
      // any the question names) so whole-document mode reads it in full —
      // the cure for "Table 1 isn't in the attached pages" two turns after
      // quoting from the same standard.
      for (const docId of conversationDocIds.slice(0, 1)) {
        if (namedDocs.length >= 3 || namedDocs.some((d) => d.id === docId)) continue;
        const d = reachableDocs.find((x) => x.id === docId);
        if (d) namedDocs.push({ id: d.id, name: d.name, libraryId: d.library_id });
      }
      // Validate claimed-missing docs. A NAME match above proves presence. A
      // content probe that hits real passages proves it too — and those
      // passages now JOIN the pool instead of being thrown away (they used
      // to be discarded after counting, so the route could prove a document
      // existed and still answer without it).
      for (const docRef of plan.missingDocs.slice(0, 4)) {
        const sqRef = squashName(docRef);
        if ([...matchedDesignations].some((d) =>
          sqRef.includes(squashName(d)) || squashName(d).includes(sqRef))) continue;
        const probes = await runSearches([docRef]);
        const flat = probes.flat();
        if (flat.length < 2) { missingDocs.push(docRef); continue; }
        const have = new Set(chunks.map((c) => c.id));
        for (const c of flat.slice(0, 3)) {
          if (!have.has(c.id)) { chunks.push(c); have.add(c.id); }
        }
      }
    }

    // ── WHOLE-DOCUMENT MODE: read named documents COVER TO COVER ─────────
    // The single biggest quality gap vs pasting a PDF into a chat window:
    // there the model reads the ENTIRE document; here it got ~22 snippets.
    // For synthesis questions ("what does EP-5-1-1 require for…") snippets
    // lose — the answer is assembled across sections the ranking never
    // surfaced. So when the question NAMES documents and they're small
    // enough to fit, their scattered snippets are replaced with the full
    // text in page order. Scale stays safe: this only fires for named
    // documents, at most two, within a hard character budget.
    const wholeDocIds = new Set<string>();
    if (namedDocs.length > 0) {
      const WHOLE_DOC_MAX_CHUNKS = 130;      // per document
      const WHOLE_DOC_CHAR_BUDGET = 170_000; // across all whole docs (~42k tokens)
      let charBudget = WHOLE_DOC_CHAR_BUDGET;
      // Read order: what the question names, then what the conversation is
      // about, then documents the refine plan brought up.
      const readRank = (id: string) => questionDocIds.has(id) ? 0 : conversationDocIds.includes(id) ? 1 : 2;
      const readOrder = [...namedDocs].sort((a, b) => readRank(a.id) - readRank(b.id));
      for (const nd of readOrder.slice(0, 2)) {
        if (charBudget <= 0) break;
        try {
          const { count } = await supabaseAdmin
            .from("knowledge_chunks").select("id", { count: "exact", head: true })
            .eq("document_id", nd.id);
          if (!count || count === 0 || count > WHOLE_DOC_MAX_CHUNKS) continue;
          const { data: full } = await supabaseAdmin
            .from("knowledge_chunks")
            .select("id, document_id, page, seq, content, section")
            .eq("org_id", orgId).eq("document_id", nd.id)
            .order("page", { ascending: true }).order("seq", { ascending: true })
            .limit(WHOLE_DOC_MAX_CHUNKS);
          if (!full || full.length === 0) continue;
          const ordered: TieredChunk[] = [];
          for (const row of full as Array<RetrievedChunk & { seq: number }>) {
            if (charBudget - row.content.length < 0) break;
            charBudget -= row.content.length;
            ordered.push({ ...row, rank: 1, libraryId: nd.libraryId, tier: "governing" });
          }
          if (ordered.length < (full.length ?? 0) * 0.8) continue; // most of it or none of it
          wholeDocIds.add(nd.id);
          // Full text replaces this document's scattered snippets, grouped
          // in reading order at the FRONT of the passage list.
          chunks = [...ordered, ...chunks.filter((c) => c.document_id !== nd.id)];
        } catch { /* snippets still cover this doc */ }
      }
    }

    // ── GRAPH HOP: follow the reference edges the index already knows ────
    // The knowledge graph records, at ingest time, that document X page P
    // says "CONT ON DWG 025-A-1001" (entity kind 'ref') — and prose
    // standards cite each other by designation right in the passage text.
    // Until now those edges were drawn on the graph page and audited, but
    // retrieval never WALKED them: the answer stopped at one document
    // unless the model happened to name the next one. This makes the hop
    // deterministic — every retrieved passage's outbound references are
    // resolved against document names and the neighbors contribute
    // passages, no model in the loop.
    const graphHops: Array<{ from: string; to: string; via: string }> = [];
    try {
      const retrievedDocIds = [...new Set(chunks.map((c) => c.document_id))];
      const retrievedPages = new Set(chunks.map((c) => `${c.document_id}:${c.page}`));
      // (a) ref entities on the exact retrieved pages
      const refCandidates = new Map<string, { via: string; fromDocId: string }>();
      if (retrievedDocIds.length > 0) {
        const { data: refs } = await supabaseAdmin
          .from("knowledge_page_entities")
          .select("document_id, page, tag")
          .in("document_id", retrievedDocIds.slice(0, 12))
          .eq("kind", "ref")
          .limit(400);
        for (const r of (refs ?? []) as Array<{ document_id: string; page: number; tag: string }>) {
          if (!retrievedPages.has(`${r.document_id}:${r.page}`)) continue;
          const key = squashDes(r.tag);
          if (key.length >= 4 && !refCandidates.has(key)) {
            refCandidates.set(key, { via: r.tag, fromDocId: r.document_id });
          }
        }
      }
      // (b) designations written in the retrieved passages' own text
      for (const c of chunks.slice(0, 30)) {
        for (const m of c.content.slice(0, 3000).matchAll(/\b[A-Za-z]{1,8}[- ]\d+(?:[-.]\d+)+[A-Za-z]?\b/g)) {
          const key = squashDes(m[0]);
          if (key.length >= 5 && !refCandidates.has(key)) {
            refCandidates.set(key, { via: m[0].trim(), fromDocId: c.document_id });
          }
        }
      }
      // Resolve against document names; docs already in the pool don't need
      // a hop — the point is reaching documents ranking never surfaced.
      const inPool = new Set(retrievedDocIds);
      const neighborPulls: Array<{ doc: ReachableDoc; via: string; fromDocId: string }> = [];
      for (const [key, cand] of refCandidates) {
        if (neighborPulls.length >= 3) break;
        const hit = reachableDocs.find((d) => !inPool.has(d.id) && squashDes(d.name).includes(key));
        if (hit && !neighborPulls.some((n) => n.doc.id === hit.id)) {
          neighborPulls.push({ doc: hit, via: cand.via, fromDocId: cand.fromDocId });
        }
      }
      if (neighborPulls.length > 0) {
        const have = new Set(chunks.map((c) => c.id));
        const pulled = await Promise.all(neighborPulls.map(async ({ doc, via, fromDocId }) => {
          const { data, error } = await supabaseAdmin.rpc("knowledge_search_document", {
            p_org: orgId, p_document: doc.id, p_query: question, p_limit: 3,
          });
          const rows = (!error && Array.isArray(data) ? data : []) as RetrievedChunk[];
          if (rows.length > 0) graphHops.push({ from: fromDocId, to: doc.name, via });
          return rows.map((c) => ({
            ...c, libraryId: doc.library_id,
            tier: (doc.library_id === libraryId ? "governing" : "reference") as "governing" | "reference",
          }));
        }));
        for (const c of pulled.flat().slice(0, 9)) {
          if (!have.has(c.id)) { chunks.push(c); have.add(c.id); }
        }
      }
    } catch { /* the graph hop is a bonus — retrieval stands without it */ }

    // ── DRAWING FACTS: deterministic layer for P&ID/drawing libraries ────
    // Retrieval finds where something is WRITTEN; it cannot count vessels
    // or audit references. When the library has extracted entities, compute
    // the census + reference audit and hand them to the model as trusted
    // facts — count questions answer from DATA, not from 14 passages.
    let drawingFacts = "";
    // Out-of-scope destinations discovered by the audit — feeds the scope
    // checklist below and the re-ask detection.
    let outOfScopeList: Array<{ series: string; unitName: string | null; count: number; refs: string[] }> = [];
    // Structured, CLICKABLE equipment register — built when the question asks
    // for equipment lists/tables/counts. The client renders it as an
    // interactive table; every sheet reference opens the drawing with the
    // tag ringed. Deterministic data, never model output.
    type EquipTableItem = {
      tag: string; note: string | null;
      sheets: Array<{ documentId: string; documentName: string; page: number; sheetLabel: string }>;
    };
    let equipmentTable: {
      total: number; truncated: boolean; filteredTo: string | null;
      categories: Array<{ prefix: string; label: string; count: number; items: EquipTableItem[] }>;
    } | null = null;
    try {
      const allLibIds = [libraryId, ...linkedLibraries.map((l) => l.id)];
      const { data: entRows } = await supabaseAdmin
        .from("knowledge_page_entities")
        .select("document_id, page, kind, tag, raw")
        .in("library_id", allLibIds)
        // Name the kinds: this slab feeds the equipment census the prompt
        // tells the model to TRUST for counts, and an unfiltered read lets
        // any future kind silently eat the row cap.
        .in("kind", TAG_ENTITY_KINDS as unknown as string[])
        .order("document_id", { ascending: true })
        .limit(20000);
      const ents = ((entRows ?? []) as Array<{ document_id: string; page: number; kind: string; tag: string; raw?: string | null }>)
        .filter((e) => !excludedDocIds.has(e.document_id));
      if (ents.length > 0) {
        const { data: dRows } = await supabaseAdmin
          .from("knowledge_documents").select("id, name, library_id").in("library_id", allLibIds);
        const docsList = ((dRows ?? []) as Array<{ id: string; name: string; library_id: string }>)
          .filter((d) => !excludedDocIds.has(d.id));
        const census = buildEquipmentCensus(ents.filter((e) => e.kind === "equipment"), prefixLabels);
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
        const audit = auditDrawingRefs(docsList, refsByDoc, selfByDoc, unitMap);
        outOfScopeList = audit.outOfScope.map((o) => ({
          series: o.series, unitName: o.unitName ?? null, count: o.count, refs: o.refs,
        }));
        const declaredCount = docsList.filter((d) => selfByDoc.has(d.id)).length;

        // ── Clickable equipment table ─────────────────────────────────────
        const intent = matchEquipmentListIntent(question);
        if (intent.match) {
          // Restricted to the ASKED library: the client resolves file keys
          // from its own document list to open the viewer.
          const ownDocIds = new Set(docsList.filter((d) => d.library_id === libraryId).map((d) => d.id));
          // Which SHEET each PDF page is — the title-block layer records the
          // sheet number per page, and "X-22 on 2002-D-0001" without the
          // sheet is half an address.
          const shtByDocPage = new Map<string, string>();
          for (const e of ents) {
            if (e.kind !== "self") continue;
            const m = e.tag.match(/-SH(\d+)$/);
            if (m) shtByDocPage.set(`${e.document_id}:${e.page}`, m[1]);
          }
          // Display name = what the title block declares, else the file name.
          const displayName = (docId: string): string => {
            const declared = (selfByDoc.get(docId) ?? [])
              .filter((t) => !/-SH\d+$/.test(t)).sort((a, b) => a.length - b.length)[0];
            return declared ?? docsList.find((d) => d.id === docId)?.name ?? "Sheet";
          };
          const byTag = new Map<string, { prefix: string; note: string | null; sheets: Map<string, number> }>();
          for (const e of ents) {
            if (e.kind !== "equipment" || !ownDocIds.has(e.document_id)) continue;
            const prefix = e.tag.split("-")[0] ?? e.tag;
            if (intent.prefixes && !intent.prefixes.includes(prefix)) continue;
            const entry = byTag.get(e.tag) ?? { prefix, note: null, sheets: new Map<string, number>() };
            if (!entry.sheets.has(e.document_id)) entry.sheets.set(e.document_id, e.page);
            // The most informative context line wins (vision transcripts
            // carry service text; bare text items are just the tag again).
            const raw = (e.raw ?? "").trim();
            if (raw.length > e.tag.length + 4 && raw.length > (entry.note?.length ?? 0)) entry.note = raw;
            byTag.set(e.tag, entry);
          }
          const MAX_ROWS = 400;
          const allTags = [...byTag.entries()]
            .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
          const byPrefix = new Map<string, EquipTableItem[]>();
          let rows = 0;
          for (const [tag, entry] of allTags) {
            if (rows >= MAX_ROWS) break;
            const list = byPrefix.get(entry.prefix) ?? [];
            list.push({
              tag,
              note: entry.note ? entry.note.slice(0, 140) : null,
              sheets: [...entry.sheets.entries()].slice(0, 6)
                .map(([docId, page]) => {
                  const sht = shtByDocPage.get(`${docId}:${page}`);
                  return {
                    documentId: docId, documentName: displayName(docId), page,
                    sheetLabel: sht ? `SHT ${sht}` : `p.${page}`,
                  };
                }),
            });
            byPrefix.set(entry.prefix, list);
            rows++;
          }
          if (byTag.size > 0) {
            equipmentTable = {
              total: byTag.size,
              truncated: byTag.size > MAX_ROWS,
              filteredTo: intent.label,
              categories: [...byPrefix.entries()]
                .map(([prefix, items]) => ({
                  prefix,
                  label: prefixLabels[prefix] ?? EQUIPMENT_CATEGORIES[prefix] ?? "Unknown prefix",
                  count: items.length,
                  items,
                }))
                .sort((a, b) => b.count - a.count),
            };
          }
        }
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
                .map((c) => `${c.label} [${c.prefix}]: ${c.distinctTags}` +
                  (c.nextNumber !== null ? ` (highest ${c.prefix}-${c.maxNumber}, next free ${c.prefix}-${c.nextNumber})` : ""))
                .join("; ")
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
                `${o.series}${o.unitName ? ` = ${o.unitName}` : ""} (${o.count} connector(s): ${o.refs.slice(0, 6).join(", ")})`).join("; ")
            : "none") + "\n" +
          `- One-way connectors (BOTH sheets loaded, reference runs only one direction): ` +
          (audit.oneWay.length > 0
            ? `${audit.oneWay.length} — ` + audit.oneWay.slice(0, 6).map((o) => `${o.from} → ${o.to}`).join("; ")
            : "none") + "\n" +
          (ents.some((e) => e.kind === "opc")
            ? (() => {
                const opcs = ents.filter((e) => e.kind === "opc");
                const broken = opcs.filter((o) => !o.raw || extractDrawingRefs(o.raw).length === 0);
                return `- Off-page connector BOX NUMBERS captured: ${opcs.length} ` +
                  "(the numbered box at the page edge; the same number on the continuation sheet is " +
                  "the match, verified by stream name and destination equipment).\n" +
                  `- BROKEN connectors — an OPC with NO drawing number is broken by definition ` +
                  `(nothing tells the reader where to continue): ${broken.length}` +
                  (broken.length > 0
                    ? ` — e.g. ${broken.slice(0, 4).map((b) => `box ${b.tag}: "${(b.raw ?? "").slice(0, 60)}"`).join("; ")}`
                    : "") + "\n";
              })()
            : "") +
          (decoderText
            ? `\nSITE NUMBERING DECODER (owner-provided — use it to read every drawing number):\n${decoderText.slice(0, 1200)}\n`
            : "") +
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

    // ── Scope checklist ──────────────────────────────────────────────────
    // "Audit all the connectors" against one unit's drawings touches every
    // unit they connect to. Instead of answering into that ambiguity, hand
    // the asker a checklist of the DISCOVERED destinations — check what
    // stays in scope for now; everything loaded gets covered either way,
    // and the checked ones become the tracked needs list. This is core
    // behavior, not the opt-in facet feature.
    const ONLY_LOADED = "Only what's loaded now";
    const scopeAudity = /\b(audit|connector|off[\s-]?page|opc|continuation|cross[\s-]?ref|scope)/i.test(question);
    const chosenScope = outOfScopeList.filter((o) =>
      focus.some((f) => f.includes(o.series) || (o.unitName && f.includes(o.unitName))));
    const onlyLoadedChosen = focus.includes(ONLY_LOADED);
    const scopeFocused = chosenScope.length > 0 || onlyLoadedChosen;
    if (scopeAudity && focus.length === 0 && !inputs && outOfScopeList.length >= 2) {
      await meter(true);
      return ok({
        clarification: {
          question:
            `The loaded documents connect outward to ${outOfScopeList.length} other drawing ` +
            "sets/units that aren't in this library. Everything that IS loaded gets fully covered " +
            "either way — pick which destinations to keep in scope, and I'll track those as the " +
            "documents to obtain next instead of listing everything.",
          options: [
            ...outOfScopeList.slice(0, 8).map((o) => {
              const nums = o.refs.slice(0, 3).join(", ") +
                (o.refs.length > 3 ? ` +${o.refs.length - 3} more` : "");
              return `${nums}${o.unitName ? ` — ${o.unitName}` : ""} (${o.count} connector${o.count === 1 ? "" : "s"})`;
            }),
            ONLY_LOADED,
          ],
        },
        provider, model, mode: "library", budget: budget(),
      });
    }

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
          (missingDocs.length > 0 ? `\n! The answer likely lives in: ${missingDocs.join(", ")} — not in your libraries.` : "") +
          (partialDocs.length > 0 ? `\n! Indexing gap: ${partialDocs.join("; ")}.` : "");
      await supabaseAdmin.from("knowledge_questions").insert({
        org_id: orgId, library_id: libraryId, user_id: user.id, user_name: userName,
        question, answer, citations: [], provider, model,
      });
      await meter(true);
      return ok({
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

    let anchorFacts = "";
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
      // (b) referenced table/figure pages. Ingestion records where every
      // caption LIVES (kind 'anchor'), so "see Table 3" resolves by lookup
      // — deterministic, zero extra search — with the old text hunt kept as
      // the fallback for corpora indexed before anchors existed.
      const refCounts = new Map<string, number>();
      for (const c of [...chunks, { content: question } as { content: string }]) {
        for (const m of c.content.matchAll(/\b(?:Table|Fig(?:ure)?\.?|Chart|Detail)\s+[A-Z0-9][A-Z0-9.\-]{0,10}/gi)) {
          const label = m[0].replace(/\s+/g, " ").trim();
          refCounts.set(label, (refCounts.get(label) ?? 0) + 1);
        }
      }
      const topRefs = [...refCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const normalizeLabel = (l: string) => l.toUpperCase()
        .replace(/^FIG\.?\s/, "FIGURE ").replace(/\s+/g, " ").trim();
      const wantedAnchors = [...new Set(topRefs.map(([l]) => normalizeLabel(l)))];
      const anchorHits: Array<{ tag: string; document_id: string; page: number }> = [];
      if (wantedAnchors.length > 0) {
        try {
          const libIds = [libraryId, ...linkedLibraries.map((l) => l.id)];
          const { data: aRows } = await supabaseAdmin
            .from("knowledge_page_entities")
            .select("tag, document_id, page")
            .in("library_id", libIds).eq("kind", "anchor").in("tag", wantedAnchors)
            .limit(200);
          const retrievedDocs = new Set(chunks.map((c) => c.document_id));
          for (const tag of wantedAnchors) {
            const rows = ((aRows ?? []) as typeof anchorHits).filter((r) => r.tag === tag);
            // The Table 3 in the SAME document the prose came from, not a
            // namesake in another standard.
            // Then: a document the question names, then the one the
            // conversation is about — "table 1" three turns into an EP 5-2-1
            // discussion is EP 5-2-1's Table 1, not a SEMI table elsewhere.
            const best = rows.find((r) => questionDocIds.has(r.document_id))
              ?? rows.find((r) => conversationDocIds.includes(r.document_id))
              ?? rows.find((r) => retrievedDocs.has(r.document_id)) ?? rows[0];
            if (best && !excludedDocIds.has(best.document_id)) anchorHits.push(best);
          }
        } catch { /* anchors are additive */ }
      }
      const resolved = new Set(anchorHits.map((a) => a.tag));
      for (const a of anchorHits) addTarget(a.document_id, a.page);
      for (const [label] of topRefs) {
        if (resolved.has(normalizeLabel(label))) continue;
        for (const hit of await findPagesByText([label], 2)) addTarget(hit.documentId, hit.page);
      }
      if (anchorHits.length > 0) {
        anchorFacts =
          "\n\nREFERENCED TABLES & FIGURES — recorded at indexing, where each one lives:\n" +
          anchorHits.map((a) =>
            `- ${a.tag} → ${docName.get(a.document_id) ?? "document"} p.${a.page}` +
            " (its page image is attached — read values from the IMAGE, not from prose about it)").join("\n");
      }
      if (targets.length > 0) emit({ t: "status", text: `Reading ${Math.min(targets.length, MAX_DEEP_READ_PAGES)} printed page${Math.min(targets.length, MAX_DEEP_READ_PAGES) === 1 ? "" : "s"} as images` });
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
          const wholeTag = wholeDocIds.has(c.document_id) ? "FULL TEXT | " : "";
          const pinTag = pinnedChunkIds.has(c.id) ? "CITED EARLIER IN THIS CONVERSATION | " : "";
          return `[${i + 1}] (${pinTag}${wholeTag}${tierLabel}${docName.get(c.document_id) ?? "Document"}${sec}, page ${c.page})\n${c.content}`;
        }).join("\n\n");
    const graphHopNote = graphHops.length > 0
      ? "\n\nGRAPH HOPS: some passages were pulled by FOLLOWING REFERENCES found in the retrieved " +
        "pages — the document graph resolved these edges automatically:\n" +
        graphHops.map((h) =>
          `- ${docName.get(h.from) ?? "a retrieved document"} references "${h.via}" → passages from ${h.to} were attached`).join("\n") +
        "\nWhen a hopped document supplies part of the answer, SAY the chain in Why (\"§X points to " +
        "**" + "the referenced document" + "** [n]\") — the reader should see the trail, not just the destination."
      : "";
    const wholeDocNote = wholeDocIds.size > 0
      ? "\n\nFULL DOCUMENTS LOADED: passages marked FULL TEXT are the COMPLETE text of " +
        [...wholeDocIds].map((id) => `**${docName.get(id) ?? "a document"}**`).join(" and ") +
        " in page order — you are reading the whole document, not excerpts. Synthesize across its " +
        "sections the way you would reading it cover to cover; nothing from it is missing, so never " +
        "say its content 'was not retrieved'."
      : "";

    const precedence = hasLinks
      ? "\n\nPRECEDENCE: passages are labeled GOVERNING (the asked library — site standards) or " +
        "REFERENCE (linked libraries — code books/external references). GOVERNING documents supersede " +
        "REFERENCE minimums. When a GOVERNING passage is silent or explicitly defers (\"per B31.3\"), " +
        "the REFERENCE passage governs. ALWAYS state which document wins and why (e.g. \"site standard " +
        "requires 250 ft-lb [2], exceeding the code minimum [5] — site standard governs\")."
      : "";
    // Legend / decoder sheets ride along with every question — the way an
    // engineer keeps the legend page open next to the drawing. ACL applies;
    // capped so a fat legend can't crowd out the actual passages.
    let legendBlock = "";
    if (legendDocIds.length > 0) {
      const usable = legendDocIds.filter((id) => !excludedDocIds.has(id));
      if (usable.length > 0) {
        const { data: legendChunks } = await supabaseAdmin
          .from("knowledge_chunks")
          .select("document_id, page, content")
          .in("document_id", usable)
          .order("page", { ascending: true })
          .limit(40);
        let budgetLeft = 6000;
        const parts: string[] = [];
        for (const c of (legendChunks ?? []) as Array<{ content: string }>) {
          if (budgetLeft <= 0) break;
          const piece = truncateSafe(c.content, budgetLeft);
          parts.push(piece);
          budgetLeft -= piece.length;
        }
        if (parts.length > 0) legendBlock = parts.join("\n");
      }
    }
    const catalogBlock = buildCatalogBlock(catalog);
    const catalogNote = catalogBlock
      ? "\n\nWHAT THE LIBRARIES HOLD — a catalog of every mapped document the user can reach. You know " +
        "this library: when a form, checklist, procedure, standard drawing, pipe class or standard in it " +
        "fits what the user is doing, say so — never make them ask whether one exists:\n" + catalogBlock
      : "";
    const pipeClassNote = pipeClasses.length > 0
      ? "\n\nPIPE CLASS FACTS — extracted from the printed class tables; TRUST these rows for what a class " +
        "calls for (component, size range, spec and grade, seamless or welded). Their pages are among the " +
        "passages — cite those [n]:\n" + pipeClassFacts(pipeClasses)
      : "";
    const standing =
      (aiInstructions
        ? `\n\nLIBRARY OWNER'S STANDING INSTRUCTIONS (follow them):\n${aiInstructions.slice(0, 2000)}`
        : "") +
      (legendBlock
        ? `\n\nP&ID LEGEND / DECODER SHEETS (owner-attached — authoritative for symbols, line ` +
          `codes, and abbreviations on these drawings):\n${legendBlock}`
        : "");
    const missing = (missingDocs.length > 0
      ? `\n\nKNOWN GAPS: the passages reference these documents, which are NOT in the libraries: ${missingDocs.join(", ")}. ` +
        "Where part of the answer depends on one, say so with an \"! \" line — do not guess its content."
      : "") + (partialDocs.length > 0
      ? `\n\nINDEXING GAPS: these documents ARE in the libraries but their search index is incomplete, so ` +
        `passages from them may be missing: ${partialDocs.join("; ")}. If the answer seems thin on one of ` +
        `them, add an "! " line telling the user to re-index that document — do not blame the library for ` +
        `lacking it.`
      : "");
    const focusDirective = focus.length > 0 && !scopeFocused
      ? `\n\nFOCUS: the user was asked which aspects they want and chose: ${focus.join(", ")}. ` +
        "Answer ONLY those aspects. If another aspect contains something safety-critical they must not " +
        "miss, give it ONE \"! \" line pointing at it — nothing more."
      : "";
    const scopeDirective = scopeFocused
      ? "\n\nUSER-CHOSEN SCOPE: cover everything in the loaded documents fully. " +
        (chosenScope.length > 0
          ? `Track ONLY these as the documents to obtain next: ${chosenScope
              .map((o) => `${o.series}${o.unitName ? ` (${o.unitName})` : ""}`).join("; ")}. ` +
            "All other outward references get at most one combined-count line."
          : "The user chose to stay with what's loaded — no outside-documents needs list beyond " +
            "gaps inside the loaded sets; outward references get at most one combined-count line.")
      : "";
    // Applies to EVERY library — standards, drawings, manuals, mixed. The
    // tool's job is never silently narrowed to what happens to be loaded.
    const needsDirective =
      "\n\nNEEDS: do the whole job with what's loaded, and never silently shrink it. If doing it " +
      "COMPLETELY requires documents or values you don't have — a referenced spec or code edition, " +
      "another unit's drawings, a data sheet, a legend, a vendor manual, a measurement only the user " +
      "knows — finish everything you CAN, then add a short 'To go further I need:' list under **More:** naming " +
      "each item and exactly why — at most 3 items, and only items that would change the answer or " +
      "finish the job. When the user must choose between discovered options, ask ONE question " +
      "listing them rather than assuming.";
    // "How do I determine X?" must leave the reader COVERED — the whole
    // decision path, not a compressed one-liner that skips the estimate
    // rules and floors the source spells out.
    const decisionPathProtocol =
      "\n\nHOW-DO-I / DETERMINE / SIZE / SELECT QUESTIONS: the reader must be covered by the answer " +
      "ALONE. Walk the COMPLETE decision path the passages define — the general rule, every special " +
      "case that changes it, the mandated estimating rules when data isn't available yet, any " +
      "floor/minimum or vacuum/external-pressure provision, and any duty to re-evaluate later — " +
      "each as its OWN Why bullet carrying the [n] of the exact provision it came from. NEVER " +
      "merge several provisions into one bullet or one citation: a claim built from §A plus §B " +
      "cites [nA] on the §A part and [nB] on the §B part, so each highlight matches its claim. " +
      "When the user supplied their own operating numbers, END with '### Applied to your case' " +
      "walking those values through the path to a concrete result. If a required user-specific " +
      "input is MISSING for that final step, do NOT append a Need inside the answer — follow the " +
      "CALCULATIONS rule instead: reply with ONLY the one-line '**Need:** …' question; the full " +
      "decision path comes after they answer.";
    const calcProtocol =
      "\n\nCALCULATIONS: when the question requires computing from a cited formula (test pressures, " +
      "spans, thicknesses…): (1) transcribe the formula EXACTLY as printed with its variable " +
      "definitions [n]; (2) list every input with its source — a cited passage [n], a table lookup " +
      "(name the table and the exact row/column you read), or USER-PROVIDED; (3) substitute and " +
      "compute step by step; (4) state units, and end with a **Check:** naming the table cells to " +
      "verify. If a required input is user-specific (test temperature, design pressure, material " +
      "grade…) and was NOT provided, do NOT assume a value: reply with ONLY one line " +
      "'**Need:** <one specific question naming exactly which value(s) you need and why>' — nothing else.";
    const askerImagesNote = userImages.length > 0
      ? `\n\nASKER ATTACHMENTS: the first ${userImages.length} image${userImages.length === 1 ? "" : "s"} ` +
        "in the image list were attached by the asker for THIS question (a photo, a marked-up " +
        "drawing, a screenshot, or pages of a PDF they attached). Read them as context for the " +
        "question. They are NOT library documents — never cite them with [n]; describe what you " +
        "read in them in words. When what you see bears on the answer (a stencil reading " +
        "\"A312 TP304 WLD\", a visible weld seam, corrosion, a nameplate value), the FIRST Why " +
        "bullet starts \"From your attachment:\" and says exactly what you read and where in the " +
        "image — so the asker can confirm you looked at the right thing. If the image is unclear " +
        "or doesn't show what the question needs, say what's missing in that bullet."
      : "";
    const buildPagesNote = (imgs: typeof pageImages) => askerImagesNote + (imgs.length > 0
      ? "\n\nPRINTED PAGES: attached are the actual page images, in order: " +
        imgs.map((img, i) =>
          `image ${userImages.length + i + 1} = ${docName.get(img.documentId) ?? "Document"} page ${img.page}`).join("; ") +
        ". Use them to read tables, formulas, and figures EXACTLY as printed — they outrank the " +
        "extracted text when the two disagree. A value read from a page image cites the [n] of a " +
        "passage from that same page (or names the document and page when no passage matches)."
      : "");
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

    const tableNote = equipmentTable
      ? "\n\nSTRUCTURED TABLE ATTACHED: an interactive equipment table (grouped by category, every " +
        "tag clickable to open its sheet with the tag ringed) is shown to the user WITH your answer. " +
        "Do NOT re-list every tag. Give totals, notable items, anomalies, and anything the user " +
        "specifically asked about — the table does the enumeration."
      : "";
    // Org Playbooks: standing instructions this org taught its AI ("our
    // transmittals cite the PO number") ride on every ask. Reasoning Skills
    // ride with them — self-gating disciplines (Basis of Design, Change
    // Impact Review, …) the workspace switched on, plus the asker's own
    // private ones.
    const orgInstructions =
      (await loadOrgInstructionsBlock(supabaseAdmin, orgId, "knowledge")) +
      (await loadAnswerSkillsBlock(supabaseAdmin, orgId, user.id)) +
      extraSystem;
    const baseAnswerSystem =
      "You are the reference-library assistant for an industrial facility's document control system. Answer the " +
      "question USING ONLY the numbered passages provided.\n\n" +
      (allowGeneral
        ? "KNOWLEDGE SOURCE — documents first, general knowledge allowed: this library's owner allows " +
          "general engineering knowledge where the documents are silent. Every such statement must end " +
          "with \"(not from your library)\" so the reader can tell it apart; never mix it into a cited " +
          "sentence.\n\n"
        : "KNOWLEDGE SOURCE — DOCUMENTS ONLY (this library's setting; non-negotiable): every statement must " +
          "come from the numbered passages, the PIPE CLASS / DRAWING FACTS, or what the user told you. Do " +
          "NOT add engineering knowledge, code requirements, typical values, or reasons from your own " +
          "training — not even marked or hedged. When the documents don't say something the answer needs " +
          "(why a rule exists, a code value, a design basis), say plainly that the library doesn't state " +
          "it, and name under **To settle this:** what would — the referenced code or standard, the " +
          "basis document, or who to ask.\n\n") +
      "OUTPUT FORMAT — follow it exactly, sections in this order, no preamble, no restating the question:\n" +
      "**Mode:** answer | compliance | explore | deviation — one word, the shape you chose (see ANSWER MODES).\n" +
      "**Heading toward:** (optional) when the conversation shows where the user is going — not just " +
      "this question — one of: deviation, compliance, ncr, tq, moc, inspection, test, design, " +
      "troubleshoot, learn; then \" — \" and one short reason (\"deviation — wants to keep slip-on " +
      "flanges on elbows that EP 5-2-2 §4.3 prohibits\"). Leave it out unless it is evident.\n" +
      "**Use this:** (optional, up to 2 lines) a document from WHAT THE LIBRARIES HOLD that the user " +
      "should use for what they're doing, by its exact quoted name, then \" — \" and why (\"Use this: " +
      "Deviation Request Form — to request the exception formally\").\n" +
      "**Answering for:** what you understood the question to be about, as 2-5 short facts joined " +
      "by \" · \" — the item/material, the governing document, and any condition the answer turns " +
      "on (e.g. \"304 stainless · welded pipe · EP 5-2-1 · line class: not given\"). A fact the " +
      "answer depends on that the user hasn't given is written \"<name>: not given\". When a word in " +
      "the question has two meanings in this field, the chip says which one you answered for " +
      "(e.g. \"welded = seam welded at the mill, not fabrication welds\"). Resolve " +
      "follow-ups against the conversation here, so the user can see and correct your reading.\n" +
      "**Answer:** the direct answer in ONE or two SHORT sentences (45 words MAX) with its [n] " +
      "markers. Mandatory. NEVER pack an enumeration into the Answer line.\n" +
      "VERDICT: when the question asks for a decision — can I / may I / is it allowed, acceptable, " +
      "required, permitted, OK to use — the Answer line STARTS with exactly one of these words in " +
      "capitals, then an em dash: YES — / NO — / YES, WITH CONDITIONS — / NOT SETTLED —. " +
      "YES or NO only when a passage explicitly settles it; YES, WITH CONDITIONS when it is " +
      "permitted subject to named conditions or approvals (list them under Before you act); NOT " +
      "SETTLED when the passages genuinely don't decide it — then the sentence names which " +
      "document and section DOES decide it, or who does (e.g. the Owner's Engineer).\n" +
      "RULE, NOT READING LIST: for which / what / how-do-I-know / how-do-I-choose questions, the " +
      "Answer line states the RULE the reader applies and what it yields (e.g. \"Use the " +
      "insulation schedule the Owner's Engineer issued for the line; only where none exists, " +
      "select from EP 11-3-7 Table 2 by operating temperature and pipe size [n]\"). An Answer that " +
      "only names documents to go read is a WRONG answer. Answer the question asked, about the " +
      "item asked — not a neighboring topic.\n" +
      "**To settle this:** (ONLY when the verdict is NOT SETTLED / CAN'T DETERMINE, or the answer " +
      "hinges on a document or value that isn't here)\n" +
      "- **<document, table, or value>** — why it settles the question, quoting where the loaded " +
      "standards point to it (\"EP 5-2-1 §2.0 invokes **ASME B31.3**; its **Table A-1B** gives the " +
      "joint factor for welded A312 [n]\"). One bullet per item, most decisive first, at most 4.\n" +
      "- **Best answer with what I have:** the most likely outcome and why, in one sentence.\n" +
      "**Why:**\n" +
      "- 1-4 bullets: the chain of provisions that leads to the Answer, one claim each, with its " +
      "[n] and the section/table name (e.g. \"Table 1 sends austenitic steels to Table 4 [66]\"). " +
      "Checklist questions may use more bullets, grouped under short \"### \" headings.\n" +
      "**Engineering trail:**\n" +
      "- the FULL chain an engineer would walk, one provision per bullet, in order: " +
      "\"**<document §/table>** → what it says → what it means for this case [n]\" (e.g. \"**EP " +
      "5-2-1 Table 1** → austenitic Cr-Ni steel → use Table 4 [94]\"). 3-10 steps. Include the steps " +
      "that rule things OUT, and end on the deciding step. This is the proof the reader forwards — " +
      "every step cites. Shown collapsed under Why.\n" +
      "**Before you act:**\n" +
      "- the checklist: ONLY conditions, approvals, hold points, and verifications that could change " +
      "the outcome, each a short imperative with its [n] (\"Confirm the line class in EP 5-2-3 " +
      "lists welded A312 [n]\"). When the items cover different things, start each with what it " +
      "applies to in bold — e.g. **The pipe you have:**, **When fabricating:**, **Approval:** — so " +
      "the reader never has to guess. Whenever a value comes from a table, include what to verify on " +
      "the printed page — PDF table extraction jumbles numbers. A line starting \"! \" marks a " +
      "safety-critical MUST. Leave the section out when there is nothing.\n" +
      "**Don't miss:** (optional) at most 2 bullets — ONLY things the user didn't ask about that are " +
      "safety-critical or would change the outcome (a hold point, a prohibited combination, a " +
      "service condition that voids the answer). Everything else that's merely related goes under " +
      "More, never here.\n" +
      "**One question:** (optional, one line) the ONE question whose answer would change or finish " +
      "the answer, then \" | options: a; b; c\" when there are natural choices. Leave it out when " +
      "nothing missing would change the answer.\n" +
      "**More:**\n" +
      "- (optional) anything useful but not needed to act — related rules, a draft technical " +
      "query, what you'd need to go further. Shown collapsed.\n" +
      "STRUCTURE IS NOT OPTIONAL: under every section each line is a \"- \" bullet or a \"### \" " +
      "heading — NEVER a paragraph. No paragraph anywhere may exceed two sentences. Never repeat " +
      "the same fact in two sections.\n\n" +
      "EMPHASIS: wrap every key identifier — document numbers, section refs, specific values and " +
      "limits — in **bold**. Put exact values/designations in `backticks` (rendered as value chips): " +
      "`250 ft-lb`, `ASME B31.3`, `Table 121.5`.\n\n" +
      "PRIORITY ORDER: within each section and each ### group, order bullets by what the reader " +
      "must act on first — binding requirements (shall/must, hold points, safety limits) first, " +
      "specific values and limits next, supporting context last. The reader works top-down.\n\n" +
      "COMPLETENESS: for checklist/what-do-I-need questions, completeness BEATS brevity — enumerate " +
      "EVERY requirement found across ALL passages, grouped under short **bold** group names; never " +
      "stop at the first passage's list. If the passages suggest more requirements exist beyond what " +
      "was retrieved (a referenced appendix, a continued table), add a Before you act line saying " +
      "what may be missing and where to look. For single-value questions stay under 120 words.\n\n" +
      "NEVER invent requirements, values, or clause numbers. If passages only partially answer, " +
      "**Answer:** says exactly what's covered and what isn't. Engineers act on these answers.\n\n" +
      "WHOLE PROVISION: when a cited passage states a rule AND then adds a recommendation, default, " +
      "exception, or practice (\"it is recommended…\", \"unless…\", \"typically…\", \"should be set " +
      "at…\"), the answer INCLUDES that part — a recommendation in the source is part of the answer, " +
      "not commentary. Stopping at \"no explicit value is given\" when the same passage recommends " +
      "one is a WRONG answer.\n\n" +
      "RELEVANCE — answer THE question, not the topic area: before writing, identify what the asker " +
      "is actually trying to decide or do, and lead with exactly that. Passages are a haystack you " +
      "were handed, not an outline to summarize — leave out anything that doesn't change the asker's " +
      "decision, even when it's from the right document. The one exception: a safety-critical fact " +
      "they didn't ask about but cannot act without gets ONE \"! \" line. An answer that buries the " +
      "point under adjacent material is a WRONG answer here.\n\n" +
      "SCOPE CHECK: before citing a clause, check it covers the SAME material, component, and " +
      "service the question is about (a carbon-steel table does not govern 304 stainless; a tubing " +
      "rule does not govern pipe). Cite an out-of-scope clause ONLY to show that it does NOT apply, " +
      "and say so in the same bullet. Never present one as if it governs.\n\n" +
      "CONVERSATION: a follow-up continues the same job. Interpret short follow-ups (\"show me " +
      "table 1\", \"what about fittings\") against the conversation — the same material, item, and " +
      "document — never as a fresh question about something else. When the user pushes back " +
      "(\"that doesn't answer it\", \"be more explicit\"), keep the same question and give a SHARPER " +
      "verdict in FEWER lines — do not add sections. Passages marked CITED EARLIER IN THIS " +
      "CONVERSATION are evidence you already relied on; they remain valid.\n\n" +
      "NEVER write that a passage, table, or section is \"not in the attached/loaded pages\" or " +
      "\"not retrieved\". If a table you need is referenced but its text isn't here, use Fetch. If " +
      "the library truly doesn't decide the question, say NOT SETTLED and name exactly what you " +
      "checked and where the answer would live.\n\n" +
      "NO FILLER: never write a section or bullet with placeholder content (\"Details below.\", " +
      "\"See below.\"). Leave a section out when it has nothing real in it.\n\n" +
      "PLAIN WORDS: the reader is a field engineer reading fast; if they can't tell what you mean " +
      "at a glance, the answer failed even when it is technically right. When a term has more " +
      "than one meaning in this field, say which one in plain words the first time you use it " +
      "(\"seam-welded pipe — made with a weld along its length at the mill\" vs \"welded joints — " +
      "the welds made when the piping is fabricated\"), and never switch meanings mid-answer. " +
      "Spell out codes and shorthand on first use (AES = Aggressive Environmental Service; P8 = " +
      "the austenitic stainless weld group; S5 = full radiography of the seam; CMTR = certified " +
      "mill test report).\n\n" +
      "RESOLUTION PATH: when the verdict is NOT SETTLED, or the user has something different from " +
      "what was specified or ordered, the answer must tell them how to settle it: the exact " +
      "document/entry to check, what each possible outcome means (\"if the line class lists welded " +
      "A312 → use it; if it says seamless only → it is a deviation: request Owner's Engineer " +
      "approval\"), and a ready-to-send deviation request or technical query under **More:**. " +
      "Never leave the user with \"confirm with the Owner's Engineer\" and nothing to send.\n\n" +
      "ANSWER MODES:\n" +
      "- answer: the default — the direct answer to what was asked, as above.\n" +
      "- compliance: the user describes work done or planned (\"they fabricated…\", \"we installed…\", " +
      "\"does this meet…\") and needs to know if it meets the standard. The Answer line starts with " +
      "COMPLIES — / DOES NOT COMPLY — / CAN'T DETERMINE —. Each Why bullet is one finding: " +
      "\"**Requirement:** what the standard requires [n] — **Found:** what was done — **Gap:** the " +
      "difference (or none)\". Before you act lists the corrective actions. Under More, add a short, " +
      "factual, ready-to-send note to the responsible party stating each requirement, the quoted " +
      "clause with document/section/page, and the required correction — firm, not personal.\n" +
      "- deviation: the user wants to depart from a requirement (\"get out of\", \"exception\", " +
      "\"waiver\", \"deviation\", \"do we really have to\"). Build the case honestly, for an " +
      "engineer to judge: the Answer line says whether a deviation looks technically supportable " +
      "for THEIR case — YES, WITH CONDITIONS — / NO — / NOT SETTLED —. Why, in order: (1) " +
      "**Requirement:** the rule, quoted [n]; (2) **Why the rule exists:** the reason as the " +
      "standard or its referenced code states it [n] — " +
      (allowGeneral
        ? "when no passage states it, give the generally accepted engineering reason marked (not from your library); "
        : "when no passage states it, say the library doesn't state the reason and list under **To settle this:** the " +
          "document that would (the referenced code clause, the standard's basis) — do not supply a reason yourself; ") +
      "(3) **Does that reason " +
      "apply here:** what about their case makes the hazard present or absent; (4) **Proposed " +
      "alternative and mitigations.** Before you act: approvals, calculations, inspections the " +
      "deviation needs. One question: the single fact that decides whether the reason applies. " +
      "Under More, write the justification text ready to paste into a deviation form. Never argue " +
      "a safety requirement away; if the reason clearly applies, say NO and why.\n" +
      "- explore: the user is brainstorming, designing, or reviewing (\"what should I consider…\", " +
      "\"design review\"). A verdict is optional; Why may run to 8 bullets; Don't miss may hold up " +
      "to 5 considerations; still cite everything.\n" +
      (answerMode
        ? `THE USER CHOSE MODE: ${answerMode.toUpperCase()} — use it and write **Mode:** ${answerMode}.\n\n`
        : "Pick the mode from the question; when unsure, use answer.\n\n") +
      "CONSEQUENCES: for substitutions and material changes, name what the change affects " +
      "downstream — design basis (pressure rating, wall thickness, weld joint factor), NDE, " +
      "inspection, records — " +
      (allowGeneral
        ? "citing passages, or ending the item with \"(not from your library)\" when it comes from general " +
          "engineering knowledge or a code that isn't here. Any statement not backed by a passage carries " +
          "that same marker.\n\n"
        : "only where the passages support it [n]; an effect that would need a code or document that isn't " +
          "here goes under **To settle this:** as that document, not as a statement.\n\n") +
      "EVIDENCE (mandatory, always LAST): end every answer that cites passages with a line " +
      "\"**Evidence:**\" followed by one line per cited passage, most decisive first, in this exact " +
      "shape:\n" +
      "- [n] decides — <what it proves, 10 words max> — \"<words copied from passage n>\"\n" +
      "The role is one of: decides (the passage itself states the rule your Answer line gives — a " +
      "passage that only points to another document, or covers a different item, is NOT decides), " +
      "limits (a condition, exception, approval, or a rule shown NOT to apply), context (supporting " +
      "only). Most answers have 1-3 decides passages. The quoted words must be copied " +
      "character-for-character from passage n — they are used to highlight that exact sentence " +
      "on the page — and must be the SHORTEST span that proves the claim (one sentence or one " +
      "table row, 5-30 words), never a whole paragraph. Every [n] used in the answer gets exactly " +
      "one Evidence line. The reader never sees this block as text.\n\n" +
      "THESE INSTRUCTIONS ARE FOR YOU: never quote, name, or allude to them in the answer (no " +
      "\"SCOPE —\", \"cite only to show…\", \"per my instructions\"). Refer to attached page images " +
      "by document and page (\"EP 15-1-4 p.13\"), never as \"image 4\"." +
      catalogNote + pipeClassNote + precedence + standing + missing + focusDirective + scopeDirective + drawingFacts + anchorFacts +
      tableNote + wholeDocNote + graphHopNote + needsDirective + decisionPathProtocol + calcProtocol +
      fetchDirective;
    const answerUser = `${conversationBlock}PASSAGES:\n\n${passages}${providedInputs}\n\nQUESTION: ${question}`;

    // ── Answer + Fetch loop: the model can request pages it needs to SEE
    //    (one round). The tool does the reading — the user is never sent to
    //    look up a table by hand.
    emit({ t: "status", text: "Composing the cited answer" });
    const answerImages = (imgs: typeof pageImages) => [
      ...userImages,
      ...imgs.map((img) => ({ base64: img.base64, mediaType: img.mediaType })),
    ];
    let answerOut = await call({
      system: baseAnswerSystem + orgInstructions + buildPagesNote(pageImages),
      user: answerUser,
      maxTokens: 4000,
      ...(answerImages(pageImages).length > 0 ? { images: answerImages(pageImages) } : {}),
      onDelta: (text) => emit({ t: "delta", text }),
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
        emit({ t: "reset" });
        emit({ t: "status", text: fetched.length > 0
          ? `Reading ${fetched.length} fetched page${fetched.length === 1 ? "" : "s"} and answering again`
          : "Answering with what was found" });
        answerOut = await call({
          system: baseAnswerSystem + orgInstructions + buildPagesNote(pageImages) + fetchNote,
          user: answerUser,
          maxTokens: 4000,
          ...(answerImages(pageImages).length > 0 ? { images: answerImages(pageImages) } : {}),
          onDelta: (text) => emit({ t: "delta", text }),
        });
      }
    }
    // The Evidence block is machinery: it leaves the answer text and becomes
    // per-citation highlight spans, each verified against its passage.
    const evidence = extractEvidenceBlock(answerOut.text);
    // "Answering for" and "One question" become chips and an ask box.
    const meta = extractAnswerMeta(evidence.answer);
    // Documents to put in the user's hands: what the model named, plus the
    // form that fits where the conversation is heading. Resolved against the
    // catalog — a name the model invented resolves to nothing and is dropped.
    type SuggestedDoc = {
      documentId: string; name: string; libraryName: string; fileKey: string | null;
      type: string; title: string; why: string;
      form?: { purpose: string; fillable: boolean; fieldCount: number };
    };
    const suggestedDocs: SuggestedDoc[] = [];
    {
      const add = (e: CatalogEntry, why: string) => {
        if (suggestedDocs.length >= 3 || suggestedDocs.some((d) => d.documentId === e.documentId)) return;
        suggestedDocs.push({
          documentId: e.documentId, name: e.name, libraryName: e.libraryName, fileKey: e.fileKey,
          type: e.profile.type, title: e.profile.title, why,
          ...(e.profile.form ? { form: { purpose: e.profile.form.purpose, fillable: e.profile.form.fillable, fieldCount: e.profile.form.fields.length } } : {}),
        });
      };
      for (const u of meta.useThis) {
        const e = matchCatalogName(catalog, u.name);
        if (e) add(e, u.why);
      }
      const goalKind = meta.goal?.kind ?? (answerMode === "deviation" ? "deviation" : null);
      if (goalKind && (FORM_PURPOSES as readonly string[]).includes(goalKind)) {
        const f = formsForGoal(catalog, goalKind)[0];
        if (f) add(f, "The form for this, from your library");
      }
    }
    let answer = meta.answer.replace(/\[image \d+(?:,\s*(p\.\s*\d+))?\]/gi,
      (_m, pg: string | undefined) => (pg ? `(${pg})` : ""));
    // Documents only, enforced in code too: a statement the model itself
    // marked as outside the library does not reach the reader of a
    // documents-only library. Said in one line, so nothing vanishes silently.
    if (!allowGeneral) answer = enforceDocumentsOnly(answer).answer;
    const spanByN = new Map<number, EvidenceSpan>();
    for (const s of evidence.spans) if (!spanByN.has(s.n)) spanByN.set(s.n, s);

    // Citations the answer actually used, in order of first use — each
    // carries the VERBATIM passage so the UI can show exactly what the
    // answer was built from (expand → read the source text → open the page).
    let used = extractCitationNumbers(answer);
    // A passage the Evidence block names as decisive is proof even when the
    // prose forgot its marker — keep it in the citation list.
    for (const s of evidence.spans) {
      if (s.role !== "context" && !used.includes(s.n) && s.n >= 1 && s.n <= chunks.length) used.push(s.n);
    }
    {
      // A [17] the model invented used to be dropped from the citation
      // PAYLOAD and left in the answer TEXT — the reader sees a marker,
      // clicks nothing, and gets no signal the claim is uncited. Strip
      // out-of-range markers from the text itself and say one line about it.
      const invented = used.filter((n) => n < 1 || n > chunks.length);
      if (invented.length > 0) {
        for (const n of new Set(invented)) {
          answer = answer.split(`[${n}]`).join("");
        }
        answer +=
          "\n\n! One or more citation markers pointed at no retrieved passage and were removed — " +
          "treat any adjacent claim as uncited.";
        used = used.filter((n) => n >= 1 && n <= chunks.length);
      }
    }

    // Which equipment tags does the ANSWER talk about? On a drawing, that's
    // what the viewer points at — highlighting a quoted passage is useless
    // when the sheet has no text layer to highlight in.
    const answerTags = new Set(extractEquipmentTags(answer).map((t) => t.tag));
    const questionTags = extractEquipmentTags(question).map((t) => t.tag);
    for (const t of questionTags) answerTags.add(t);
    // People type X35 / x 35 / X‑35-with-a-unicode-hyphen; the index stores
    // one spelling. Resolve each question tag to the index's own form so
    // citations and sheet pointing survive the difference.
    try {
      const { resolveTagAgainstIndex } = await import("@/lib/knowledgeTagResolve");
      for (const t of questionTags.slice(0, 6)) {
        const r = await resolveTagAgainstIndex(orgId, t);
        if (r.resolved && r.resolved !== t) answerTags.add(r.resolved);
      }
    } catch { /* resolution is additive */ }
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
          .in("kind", TAG_ENTITY_KINDS as unknown as string[])
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
      highlight?: string; role?: EvidenceRole; claim?: string;
    };
    const citations: CitationOut[] = used
      .filter((n) => n >= 1 && n <= chunks.length)
      .map((n) => {
        const c = chunks[n - 1];
        const pageTags = citedPageTags.get(`${c.document_id}:${c.page}`) ?? [];
        // The exact words that prove the claim, as the PASSAGE spells them —
        // only when they're really in it. A span the model paraphrased is
        // dropped, and the citation falls back to the whole passage.
        const span = spanByN.get(n);
        const highlight = span ? locateSpan(c.content, span.quote) : null;
        // A long passage is stored as the window AROUND the proof, so the
        // highlight is never cut off by the 1,600-char cap.
        let quote = truncateSafe(c.content, 1600);
        if (highlight && !quote.includes(highlight)) {
          const at = c.content.indexOf(highlight);
          const from = Math.max(0, Math.min(at - 600, c.content.length - 1600));
          quote = truncateSafe(c.content.slice(from), 1600);
        }
        return {
          n,
          documentId: c.document_id,
          documentName: docName.get(c.document_id) ?? "Document",
          page: c.page,
          section: c.section ?? null,
          quote,
          ...(highlight && quote.includes(highlight) ? { highlight } : {}),
          ...(span ? { role: span.role, ...(span.claim ? { claim: span.claim } : {}) } : {}),
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

    // Every document the ANSWER names becomes a click. "per EP 5-6-2" with
    // no [n] behind it used to be a dead reference — the reader was told a
    // document matters and given no way to open it. Designations in the
    // final answer text are matched against the reachable roster; the client
    // renders each as an open-the-document chip (best cited page, else p.1).
    const mentionedDocs: Array<{ id: string; name: string; fileKey: string; page: number; mention: string }> = [];
    try {
      const bestPage = new Map<string, number>();
      for (const c of citations) {
        if (c.documentId && typeof c.page === "number" && !bestPage.has(c.documentId)) {
          bestPage.set(c.documentId, c.page);
        }
      }
      const seen = new Set<string>();
      for (const m of answer.match(/\b[A-Za-z]{1,8}[- ]?\d+(?:[-.]\d+)*[A-Za-z]?\b/g) ?? []) {
        const key = squashDes(m);
        if (key.length < 4 || seen.has(key)) continue;
        seen.add(key);
        const doc = reachableDocs.find((d) => d.file_key && squashDes(d.name).includes(key));
        if (!doc) continue;
        mentionedDocs.push({
          id: doc.id, name: doc.name, fileKey: doc.file_key as string,
          page: bestPage.get(doc.id) ?? 1, mention: m,
        });
        if (mentionedDocs.length >= 12) break;
      }
    } catch { /* link decoration must never break an answer */ }

    // The row id comes back so the client can attach a thumbs-up/down to
    // THIS answer (the feedback that trains future retrieval).
    let questionId: string | null = null;
    {
      const r = await supabaseAdmin.from("knowledge_questions").insert({
        org_id: orgId, library_id: libraryId, user_id: user.id, user_name: userName,
        question, answer, citations, provider, model, mode: "library",
        missing_docs: missingDocs.length > 0 ? missingDocs : null,
        thread_id: threadId,
      }).select("id").maybeSingle();
      questionId = (r.data?.id as string | undefined) ?? null;
      // Pre-migration DBs lack mode/missing_docs/thread_id — retry with the core set.
      if (r.error?.code === "PGRST204" || /mode|missing_docs|thread_id/.test(r.error?.message ?? "")) {
        const r2 = await supabaseAdmin.from("knowledge_questions").insert({
          org_id: orgId, library_id: libraryId, user_id: user.id, user_name: userName,
          question, answer, citations, provider, model,
        }).select("id").maybeSingle();
        questionId = (r2.data?.id as string | undefined) ?? null;
      }
    }
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

    return ok({
      answer, citations, provider, model, mode: "library", missingDocs, partialDocs, questionId, budget: budget(),
      ...(meta.answeringFor.length > 0 ? { answeringFor: meta.answeringFor } : {}),
      ...(meta.goal ? { goal: meta.goal } : {}),
      knowledgeSource: allowGeneral ? "documents_and_general" : "documents",
      ...(suggestedDocs.length > 0 ? { suggestedDocs } : {}),
      ...(meta.followup ? { followup: meta.followup } : {}),
      answerMode: meta.mode ?? answerMode ?? "answer",
      graphHops: graphHops.map((h) => ({ from: docName.get(h.from) ?? "retrieved document", to: h.to, via: h.via })),
      // How the passages behind this answer were found. "keyword" is not a
      // degraded state to hide — it's what this product did yesterday and
      // still does well. What must never happen is an answer that LOOKS like
      // it searched by meaning when it didn't.
      retrieval: semanticUsed ? "hybrid" : "keyword",
      ...(mentionedDocs.length > 0 ? { mentionedDocs } : {}),
      ...(equipmentTable ? { equipmentTable } : {}),
    });
  } catch (e) {
    await meter(false);
    if (e instanceof AiCallError) return bad(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
    return bad(`Ask failed: ${(e as Error).message}`, 502);
  }
}
