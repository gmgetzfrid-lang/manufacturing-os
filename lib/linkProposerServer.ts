// lib/linkProposerServer.ts — the I/O half of link discovery.
//
// Gathers the facts extraction already stored, hands them to the pure logic
// in linkProposalLogic, and writes the results:
//   * provable proposals apply themselves into document_related_resources
//     (origin='system', evidence attached — visible and severable)
//   * everything else queues in proposed_links for review
//
// Service-role only: it reads across the whole org's extracted entities to
// find connections. What a given PERSON may see is enforced when the review
// surface and the graph read those rows back through RLS.
//
// Bounded by design — a run processes at most BATCH source documents and
// reports whether more remain, so the caller can drive it in slices and no
// single invocation approaches the platform's function timeout.

import type { SupabaseClient } from "@supabase/supabase-js";
import { extractDrawingRefs } from "@/lib/drawingText";
import { normalizeTag } from "@/lib/codebook";
import {
  proposeOpcContinuity, proposeSharedEquipment, customSkillDrafts,
  proposeCoCitations, compileSkillPatterns, mergeDrafts, filterDrafts,
  dropAlreadyQueued, rankDrafts, planBatch, splitByAutoApply, refKey,
  orderPair, carrierOrder, BUILTIN_SKILLS, SKILL_DOC_BUDGET_MS, MAX_MATCHES_PER_TEXT,
  type ProposalDraft, type OpcOccurrence, type TagOccurrence,
  type TextOccurrence, type CoCitationRow, type KnownPairs, type ProposalTier,
} from "@/lib/linkProposalLogic";
// Types only: the worker runner is node-only and this module is reachable
// from browser bundles (the publish pipeline's sweep), so the server route
// hands the matcher in (LNK-6).
import type { SkillMatcherFactory } from "@/lib/customSkillRunner";

const BATCH = 400;
const CHUNK = 150;
const CHUNK_SCAN_CAP = 2400;
/** One PostgREST window. The project's max-rows may be lower; paging walks
 *  on from wherever a window actually ended, and stops at an empty one. */
const PAGE_ROWS = 1000;
/** LNK-2: the ceilings one run reads to. Reaching one is reported on the
 *  run (inputs.saturated + a note) — never a silent, arbitrary slice. */
const READ_CAP = {
  documents: 50_000,
  mirroredDocs: 50_000,
  extractedRefs: 200_000,
  equipmentLinks: 200_000,
  aliases: 50_000,
  systemLinks: 50_000,
  /** Built-in plus org-wide custom connection skills (the rows that run). */
  rules: 5_000,
} as const;
/** LNK-10: how many 'inferred' proposals the review queue holds at once. A
 *  sweep adds guesses only while there is room, so no single run buries the
 *  strong findings under hundreds of weak ones. */
export const MAX_PENDING_INFERRED = 150;
/** LNK-6: the wall-clock all custom skills together may spend in one run —
 *  enforced by the matcher's watchdog, inside a skill as well as between
 *  skills. Each skill gets a fair share of what is left (what is left over
 *  divided by the skills still to run), so one heavy skill cannot keep the
 *  skills after it from running. */
export const CUSTOM_RUN_BUDGET_MS = 15_000;
const QUESTION_WINDOW = 400;

/** What each skill had to work with — so "found nothing" can explain
 *  itself instead of looking broken. Zeroes here ARE the diagnosis;
 *  `saturated` names every input that reached its ceiling (LNK-2). */
export interface ProposerInputs {
  documents: number;
  withNumbers: number;
  mirroredDocs: number;
  extractedRefs: number;
  registryAssets: number;
  equipmentLinks: number;
  citedQuestions: number;
  customSkills: number;
  chunksScanned: number;
  skillsInstalled: boolean;
  saturated: string[];
}

export interface ProposerRun {
  scanned: number;
  /** Rows actually inserted, re-opened or changed in the queue this pass. */
  proposed: number;
  /** Links actually written by this pass (a pair already linked is not). */
  autoApplied: number;
  skipped: number;
  /** System links whose stated evidence no longer holds (link kept, marked). */
  evidenceLost: number;
  /** More NEW work fits a next pass; false once a pass finds nothing new. */
  more: boolean;
  /** 'inferred' proposals waiting for room in the queue (LNK-10). */
  heldInferred: number;
  /** Provable connections that could not be applied and were queued for a
   *  person instead of vanishing (IRLS-2). */
  fellBackToQueue: number;
  /** Connection Skills the engine switched off this pass (LNK-6). */
  disabledSkills: string[];
  notes: string[];
  /** Failures the operator must see — rendered as an error, not a note
   *  (LNK-3: a failed auto-apply is loud). */
  errors: string[];
  inputs: ProposerInputs;
}

interface RuleRow {
  id: string;
  builtin_key: string | null;
  name: string;
  kind: string;
  config: { patterns?: string[]; minCoCitations?: number } | null;
  enabled: boolean;
  visibility: string;
}

type PgError = { code?: string; message: string };
const isMissingTable = (e: PgError | null | undefined) =>
  !!e && (e.code === "42P01" || /does not exist/i.test(e.message ?? ""));

/** Load the org's Connection Skills, seeding any missing built-ins.
 *  `missing`: the table is not there (the migration hasn't run) — the
 *  engine runs the built-in detectors with their defaults. `unreadable`:
 *  the read failed — whether a controller switched a built-in off is
 *  unknown, so NO built-in detector runs and no custom skill runs (fail
 *  closed), and the failure is an error on the run (IRLS-12: the two cases
 *  say different things). Built-ins are seeded with no author: they belong
 *  to the org and only controllers manage them (HUB-2 / LNK-7).
 *
 *  LNK-2 (fix pass 3): only the rows the engine uses are read — every
 *  built-in and every ORG-WIDE custom skill — in a stable order, to
 *  completion or a stated ceiling. Members' private drafts never run, so
 *  they are counted, not read: they can no longer crowd a built-in out of
 *  the read (a built-in a controller switched off then ran by default). A
 *  built-in still absent after a failed seed is unknown — it does not run,
 *  and the run says so as an error. */
async function loadRules(
  admin: SupabaseClient, orgId: string, notes: string[], errors: string[],
  onCeiling: (cap: number) => void,
): Promise<{ rows: RuleRow[]; privateDrafts: number } | "missing" | "unreadable"> {
  const COLS = "id, builtin_key, name, kind, config, enabled, visibility";
  const readBuiltins = () => readPaged<RuleRow>((from, to) => admin
    .from("link_rules").select(COLS)
    .eq("org_id", orgId).not("builtin_key", "is", null)
    .order("id", { ascending: true })
    .range(from, to), READ_CAP.rules);
  const builtins = await readBuiltins();
  const custom = builtins.error ? null : await readPaged<RuleRow>((from, to) => admin
    .from("link_rules").select(COLS)
    .eq("org_id", orgId).is("builtin_key", null).eq("visibility", "org")
    .order("id", { ascending: true })
    .range(from, to), READ_CAP.rules);
  const readErr = builtins.error ?? custom?.error ?? null;
  if (readErr) {
    if (isMissingTable(readErr)) {
      notes.push("Connection Skills not installed — run the connection-skills migration to author your own detectors. Built-in detectors ran with defaults.");
      return "missing";
    }
    errors.push(`Connection Skills could not be read (${readErr.message}) — no detector ran this pass, so none a controller switched off ran by default.`);
    return "unreadable";
  }
  if (builtins.saturated || custom?.saturated) onCeiling(READ_CAP.rules);
  const rows = [...builtins.rows, ...(custom?.rows ?? [])];
  // The private reference drafts, counted for the run's note (they never run).
  const { count: privateDrafts } = await admin
    .from("link_rules").select("id", { count: "exact", head: true })
    .eq("org_id", orgId).is("builtin_key", null).neq("visibility", "org")
    .eq("kind", "reference").eq("enabled", true);
  const have = new Set(rows.filter((r) => r.builtin_key).map((r) => r.builtin_key));
  const toSeed = BUILTIN_SKILLS.filter((b) => !have.has(b.builtin_key));
  if (toSeed.length > 0) {
    // Plain insert: the unique (org_id, builtin_key) index is PARTIAL, which
    // ON CONFLICT can't infer through the API. A concurrent seeder turns
    // this into a duplicate-key error; either way the rows exist.
    const { error } = await admin.from("link_rules").insert(
      toSeed.map((b) => ({
        org_id: orgId,
        builtin_key: b.builtin_key,
        name: b.name,
        description: b.description,
        kind: b.kind,
        config: b.config,
        enabled: true,
        visibility: "org",
        created_by: null,
      })),
    );
    if (!error) {
      for (const b of toSeed) {
        rows.push({
          id: `seed:${b.builtin_key}`, builtin_key: b.builtin_key, name: b.name,
          kind: b.kind, config: b.config, enabled: true, visibility: "org",
        });
      }
    } else {
      // A concurrent seeder (23505) wrote them first, or the seed was
      // refused: read the built-ins again. One still absent is unknown — a
      // controller may have switched it off — so it does not run.
      const again = await readBuiltins();
      for (const r of again.error ? [] : again.rows) {
        if (!have.has(r.builtin_key)) { have.add(r.builtin_key); rows.push(r); }
      }
      const unknown = toSeed.filter((b) => !have.has(b.builtin_key));
      if (unknown.length > 0) {
        errors.push(`Built-in connection skills could not be set up (${error.message}) — ${unknown.map((b) => `“${b.name}”`).join(", ")} did not run this pass: whether a controller switched ${unknown.length === 1 ? "it" : "them"} off is unknown.`);
      }
    }
  }
  return { rows, privateDrafts: privateDrafts ?? 0 };
}

/** LNK-5 (fix pass 4): pending proposals queued by a custom connection skill
 *  that is not org-wide now — an author or a controller unshared it after
 *  20261126 retired the earlier ones — are retired to 'stale': the engine no
 *  longer runs the skill, so nothing else would ever refresh or retire them,
 *  and reviewers would keep deciding the output of a skill the org withdrew.
 *  'stale', not dismissed: if a controller shares the skill again, the next
 *  run re-derives them. A deleted skill's proposals stay (what a skill
 *  produced carries its own evidence). Every failure is said on the run. */
async function retirePrivateSkillProposals(
  admin: SupabaseClient, orgId: string, notes: string[], errors: string[],
): Promise<number> {
  const ids = await readPaged<{ id: string }>((from, to) => admin
    .from("link_rules").select("id")
    .eq("org_id", orgId).is("builtin_key", null).neq("visibility", "org")
    .order("id", { ascending: true })
    .range(from, to), READ_CAP.rules);
  if (ids.error) {
    notes.push(`Proposals from private connection skills could not be checked (${ids.error.message}) — any a withdrawn skill queued stay in review this pass.`);
    return 0;
  }
  if (ids.saturated) {
    notes.push(`Checked the proposals of the first ${READ_CAP.rules.toLocaleString("en-US")} private connection skills — the rest were not checked this pass.`);
  }
  const proposers = ids.rows.map((r) => `rule:${r.id}`);
  let retired = 0;
  let writeErr: string | null = null;
  // 100 keys a request: 'rule:' + a uuid is longer than the ids CHUNK sizes.
  for (let i = 0; i < proposers.length; i += 100) {
    const { data, error } = await admin
      .from("proposed_links")
      .update({ status: "stale" })
      .eq("org_id", orgId)
      .eq("status", "pending")
      .in("proposer", proposers.slice(i, i + 100))
      .select("id");
    if (error) { writeErr ??= error.message; continue; }
    retired += ((data as unknown[] | null) ?? []).length;
  }
  if (writeErr) errors.push(`Proposals from connection skills that are no longer org-wide could not be retired (${writeErr}).`);
  if (retired > 0) {
    notes.push(`${retired} pending proposal${retired === 1 ? "" : "s"} from connection skills that are no longer org-wide ${retired === 1 ? "was" : "were"} retired — ${retired === 1 ? "it comes" : "they come"} back if a controller shares the skill again.`);
  }
  return retired;
}

/** Page a large `in` filter without blowing the URL length. */
async function inChunks<T>(
  ids: string[],
  run: (slice: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    out.push(...await run(ids.slice(i, i + CHUNK)));
  }
  return out;
}

/** LNK-2: read a query to completion in stable-ordered windows (the caller
 *  orders it), up to `cap` rows. PostgREST truncates a response at its
 *  max-rows WITHOUT an error, so a single `.limit()` is an arbitrary slice;
 *  this walks on from where each window actually ended and stops at an
 *  empty one. `saturated` says the cap, not the data, ended the read. */
async function readPaged<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: PgError | null }>,
  cap: number,
): Promise<{ rows: T[]; error: PgError | null; saturated: boolean }> {
  const rows: T[] = [];
  for (let from = 0; ; ) {
    const res = await page(from, from + PAGE_ROWS - 1);
    if (res.error) return { rows, error: res.error, saturated: false };
    const got = (res.data as T[] | null) ?? [];
    if (got.length === 0) return { rows, error: null, saturated: false };
    rows.push(...got);
    if (rows.length >= cap) return { rows: rows.slice(0, cap), error: null, saturated: true };
    from += got.length;
  }
}

export async function runLinkProposers(
  admin: SupabaseClient,
  orgId: string,
  opts?: {
    now?: () => number;
    /** LNK-6: runs custom-skill patterns under a hard deadline (the
     *  /api/links/propose route passes workerSkillMatcher()). Without one,
     *  no custom skill runs — the engine never matches a member-authored
     *  pattern on the request thread. */
    matcher?: SkillMatcherFactory;
  },
): Promise<ProposerRun> {
  const notes: string[] = [];
  const errors: string[] = [];
  const now = opts?.now ?? (() => Date.now());
  const saturated: string[] = [];
  const ceiling = (name: string, cap: number, what: string) => {
    saturated.push(name);
    notes.push(`Read the first ${cap.toLocaleString("en-US")} ${what} — the rest were not considered this pass.`);
  };

  // ── The org's rulebook. Built-ins seed themselves; a disabled skill is
  // simply skipped. Pre-migration orgs run the classic defaults; a rulebook
  // that cannot be read runs nothing (its switches are unknown).
  const loaded = await loadRules(admin, orgId, notes, errors,
    (cap) => ceiling("rules", cap, "built-in and org-wide connection skills"));
  const rules = typeof loaded === "object" ? loaded.rows : null;
  // A built-in that is not in the rulebook after the seed is unknown: it
  // does not run (loadRules recorded the error).
  const builtinEnabled = (key: string): boolean =>
    loaded === "missing" ? true
      : loaded === "unreadable" ? false
      : (loaded.rows.find((r) => r.builtin_key === key)?.enabled ?? false);
  // LNK-5 (DEC-55): only ORG-WIDE custom skills run. A private skill is its
  // author's draft — proven in the Studio's live tester — until a controller
  // shares it; it never runs over the org's corpus and its name never lands
  // in org-readable evidence (it is not even read here — only counted).
  const customRules = (rules ?? []).filter((r) =>
    !r.builtin_key && r.kind === "reference" && r.enabled && r.visibility === "org" &&
    (r.config?.patterns?.length ?? 0) > 0);
  const privateSkipped = typeof loaded === "object" ? loaded.privateDrafts : 0;
  if (privateSkipped > 0) {
    notes.push(`${privateSkipped} private connection skill${privateSkipped === 1 ? " was" : "s were"} not run — a private skill is a draft until a controller shares it org-wide.`);
  }

  const inputs: ProposerInputs = {
    documents: 0, withNumbers: 0, mirroredDocs: 0, extractedRefs: 0,
    registryAssets: 0, equipmentLinks: 0, citedQuestions: 0,
    customSkills: customRules.length, chunksScanned: 0,
    skillsInstalled: rules !== null, saturated,
  };
  const emptyRun = (): ProposerRun => ({
    scanned: inputs.documents, proposed: 0, autoApplied: 0, skipped: 0, evidenceLost: 0,
    more: false, heldInferred: 0, fellBackToQueue: 0, disabledSkills: [], notes, errors, inputs,
  });
  // Fail closed: with the rulebook unreadable, no detector runs this pass.
  if (loaded === "unreadable") return emptyRun();
  // LNK-5 (fix pass 4): a skill unshared since 20261126 no longer runs, so
  // nothing would ever refresh or retire what it queued — retire it here.
  if (typeof loaded === "object") await retirePrivateSkillProposals(admin, orgId, notes, errors);

  // ── Controlled documents: identity index + revision, excluding anything
  // carved out of AI reading. ai_excluded is a young column; if it isn't
  // there yet the select would fail wholesale, so fall back gracefully.
  type DocRow = { id: string; document_number: string | null; rev: string | null };
  let docRead = await readPaged<DocRow & { ai_excluded?: boolean }>((from, to) => admin
    .from("documents")
    .select("id, document_number, rev, ai_excluded")
    .eq("org_id", orgId)
    .eq("ai_excluded", false)
    .order("id", { ascending: true })
    .range(from, to), READ_CAP.documents);
  if (docRead.error) {
    docRead = await readPaged<DocRow>((from, to) => admin
      .from("documents").select("id, document_number, rev")
      .eq("org_id", orgId).order("id", { ascending: true }).range(from, to), READ_CAP.documents);
    if (docRead.error) throw new Error(docRead.error.message);
    notes.push("Per-document AI exclusions not applied — run the link-proposal migration.");
  }
  if (docRead.saturated) ceiling("documents", READ_CAP.documents, "controlled documents");
  const docRows: DocRow[] = docRead.rows.map(({ id, document_number, rev }) => ({ id, document_number, rev }));
  inputs.documents = docRows.length;
  if (docRows.length === 0) return emptyRun();

  const revById = new Map(docRows.map((d) => [d.id, d.rev]));
  const docById = new Map(docRows.map((d) => [d.id, d]));
  const identityIndex = new Map<string, string[]>();
  for (const d of docRows) {
    if (!d.document_number) continue;
    const key = refKey(d.document_number);
    if (!key) continue;
    (identityIndex.get(key) ?? identityIndex.set(key, []).get(key)!).push(d.id);
  }
  inputs.withNumbers = identityIndex.size;
  const allowed = new Set(docRows.map((d) => d.id));

  // ── Off-page connector occurrences. Entities hang off knowledge_documents,
  // which mirror controlled documents via source_document_id. LNK-2: every
  // mirror is read (the old 800-row slice bounded three of the four skills).
  const opcOccurrences: OpcOccurrence[] = [];
  const kdocs = await readPaged<{ id: string; source_document_id: string }>((from, to) => admin
    .from("knowledge_documents")
    .select("id, source_document_id")
    .eq("org_id", orgId)
    .not("source_document_id", "is", null)
    .order("id", { ascending: true })
    .range(from, to), READ_CAP.mirroredDocs);
  const mirrorRows = kdocs.rows;
  if (kdocs.saturated) ceiling("mirroredDocs", READ_CAP.mirroredDocs, "knowledge documents that mirror controlled documents");
  const sourceByKdoc = new Map(mirrorRows.map((k) => [k.id, k.source_document_id]));
  inputs.mirroredDocs = mirrorRows.length;

  if (kdocs.error) {
    notes.push("Drawing entities unavailable — off-page continuity skipped.");
  } else if (mirrorRows.length > 0 && builtinEnabled("opc_continuity")) {
    type EntityRow = { document_id: string; kind: string; tag: string; raw: string | null; page: number };
    let entityFailed = false;
    let entityTotal = 0;
    const entities = await inChunks<EntityRow>(
      mirrorRows.map((k) => k.id),
      async (slice) => {
        if (entityTotal >= READ_CAP.extractedRefs) return [];
        const r = await readPaged<EntityRow>((from, to) => admin
          .from("knowledge_page_entities")
          .select("document_id, kind, tag, raw, page")
          .in("document_id", slice)
          .in("kind", ["opc", "ref"])
          .order("id", { ascending: true })
          .range(from, to), READ_CAP.extractedRefs - entityTotal);
        if (r.error) { entityFailed = true; return []; }
        entityTotal += r.rows.length;
        return r.rows;
      },
    );
    if (entityFailed) notes.push("Some drawing entities could not be read — off-page continuity is partial this pass.");
    if (entityTotal >= READ_CAP.extractedRefs) ceiling("extractedRefs", READ_CAP.extractedRefs, "extracted drawing references");
    for (const e of entities) {
      const sourceDoc = sourceByKdoc.get(e.document_id);
      if (!sourceDoc || !allowed.has(sourceDoc)) continue;
      // 'opc' rows carry the box number in tag and the drawing number in the
      // surrounding text; 'ref' rows are already a drawing number.
      const refs = e.kind === "opc"
        ? extractDrawingRefs(e.raw ?? "")
        : [e.tag];
      if (refs.length === 0) continue;
      opcOccurrences.push({
        documentId: sourceDoc,
        refs,
        box: e.kind === "opc" ? e.tag : undefined,
        page: e.page,
        sourceRev: revById.get(sourceDoc) ?? null,
      });
    }
  }

  // ── Shared equipment. document_assets is the already-normalized bridge
  // between controlled documents and the registry; aliases widen it.
  const tagOccurrences: TagOccurrence[] = [];
  const linkRead = await readPaged<{ document_id: string; asset_id: string; tag_text: string | null }>((from, to) => admin
    .from("document_assets")
    .select("document_id, asset_id, tag_text")
    .eq("org_id", orgId)
    .order("id", { ascending: true })
    .range(from, to), READ_CAP.equipmentLinks);
  if (linkRead.error) notes.push(`Equipment links unavailable (${linkRead.error.message}) — Shared equipment skipped.`);
  if (linkRead.saturated) ceiling("equipmentLinks", READ_CAP.equipmentLinks, "document–equipment links");
  const links = linkRead.rows;
  inputs.equipmentLinks = links.length;
  {
    const { count } = await admin
      .from("assets").select("id", { count: "exact", head: true }).eq("org_id", orgId);
    inputs.registryAssets = count ?? 0;
  }

  // Canonical tag per asset, plus every alias pointing at it.
  const assetIds = [...new Set(links.map((l) => l.asset_id))];
  const assetTag = new Map<string, string>();
  if (assetIds.length > 0) {
    let tagErr: string | null = null;
    const rows = await inChunks<{ id: string; tag: string }>(assetIds, async (slice) => {
      const { data, error } = await admin.from("assets").select("id, tag").in("id", slice);
      if (error) tagErr ??= error.message;
      return (data as Array<{ id: string; tag: string }>) ?? [];
    });
    for (const a of rows) assetTag.set(a.id, normalizeTag(a.tag));
    // LNK-2: a failed read is said, not silently a smaller registry.
    if (tagErr) notes.push(`Some equipment tags could not be read (${tagErr}) — Shared equipment is partial this pass.`);
  }
  const aliasByAsset = new Map<string, string[]>();
  const aliasRead = await readPaged<{ asset_id: string; alias: string }>((from, to) => admin
    .from("asset_aliases").select("asset_id, alias").eq("org_id", orgId)
    .order("id", { ascending: true }).range(from, to), READ_CAP.aliases);
  if (aliasRead.error) {
    notes.push("Aliases unavailable — run the link-proposal migration to widen matching.");
  } else {
    if (aliasRead.saturated) ceiling("aliases", READ_CAP.aliases, "equipment aliases");
    for (const r of aliasRead.rows) {
      (aliasByAsset.get(r.asset_id) ?? aliasByAsset.set(r.asset_id, []).get(r.asset_id)!).push(r.alias);
    }
  }

  for (const l of links) {
    if (!allowed.has(l.document_id)) continue;
    const canonical = assetTag.get(l.asset_id);
    if (!canonical) continue;
    // Did this document reach the asset by its canonical tag, or only
    // because someone taught the system a nickname?
    const viaTag = normalizeTag(l.tag_text ?? "");
    const aliases = aliasByAsset.get(l.asset_id) ?? [];
    const matchedAlias = viaTag && viaTag !== canonical
      ? aliases.find((a) => normalizeTag(a) === viaTag)
      : undefined;
    tagOccurrences.push({
      documentId: l.document_id,
      tag: canonical,
      viaAlias: matchedAlias,
      sourceRev: revById.get(l.document_id) ?? null,
    });
  }

  inputs.extractedRefs = opcOccurrences.length;

  // ── Custom cross-reference skills: scan indexed text ──────────────────
  // The generalization of drawing continuity: ANY identifier convention the
  // org authored as a skill, matched against the indexed text of controlled
  // documents. Bounded per pass, and only fetched when a skill needs it.
  const textOccurrences: TextOccurrence[] = [];
  if (customRules.length > 0 && !opts?.matcher) {
    notes.push("Custom skills did not run — this pass has no bounded matcher for member-authored patterns.");
  } else if (customRules.length > 0 && mirrorRows.length > 0) {
    let capped = false;
    for (let i = 0; i < mirrorRows.length && !capped; i += 25) {
      const slice = mirrorRows.slice(i, i + 25);
      const { rows: data, error } = await readPaged<{ document_id: string; page: number; content: string }>((from, to) => admin
        .from("knowledge_chunks")
        .select("document_id, page, content")
        .in("document_id", slice.map((k) => k.id))
        .order("document_id", { ascending: true })
        .order("page", { ascending: true })
        .order("seq", { ascending: true })
        .range(from, to), CHUNK_SCAN_CAP - inputs.chunksScanned);
      if (error) { notes.push("Indexed text unavailable — custom skills skipped this pass."); break; }
      for (const c of data) {
        const src = sourceByKdoc.get(c.document_id);
        if (!src || !allowed.has(src)) continue;
        textOccurrences.push({
          documentId: src, text: c.content, page: c.page,
          sourceRev: revById.get(src) ?? null,
        });
      }
      inputs.chunksScanned += data.length;
      if (inputs.chunksScanned >= CHUNK_SCAN_CAP) capped = true;
    }
    if (capped) {
      saturated.push("chunksScanned");
      notes.push(`Custom skills scanned the first ${CHUNK_SCAN_CAP} indexed pages this pass — pages beyond that were not read.`);
    }
  }
  const customDrafts: ProposalDraft[] = [];
  const disabledSkills: string[] = [];
  if (customRules.length > 0 && textOccurrences.length > 0 && opts?.matcher) {
    // LNK-6: the patterns run in a worker under a per-text budget (a slow
    // page skips its document), a hard per-text ceiling (a match that never
    // returns switches the skill off) and a fair share of the run's budget —
    // the matcher terminates the worker whatever the regex is doing, so one
    // pattern cannot hold the request or starve the skills after it.
    const matcher = opts.matcher(textOccurrences.map((o) => o.text), textOccurrences.map((o) => o.documentId));
    const customStarted = now();
    const pages = textOccurrences.length;
    try {
      for (let k = 0; k < customRules.length; k++) {
        const rule = customRules[k];
        const left = CUSTOM_RUN_BUDGET_MS - (now() - customStarted);
        if (left <= 0) {
          notes.push(`Custom skills stopped after ${Math.round(CUSTOM_RUN_BUDGET_MS / 1000)} s this pass — not run this pass: ${customRules.slice(k).map((r) => `“${r.name}”`).join(", ")}.`);
          break;
        }
        const { regexes, errors: compileErrors } = compileSkillPatterns(rule.config?.patterns ?? []);
        if (compileErrors.length > 0) notes.push(`Skill “${rule.name}”: ${compileErrors[0]}`);
        if (regexes.length === 0) continue;
        // A fair share of what is left: every skill gets its turn this pass.
        const share = left / (customRules.length - k);
        // runLeftMs: a starting worker may use what is left of the RUN's
        // budget, not only this skill's share (fix pass 4).
        const res = await matcher.match(regexes.map((r) => r.source), {
          softDocMs: SKILL_DOC_BUDGET_MS, budgetMs: share, runLeftMs: left, maxMatches: MAX_MATCHES_PER_TEXT,
        });
        if (res.error) {
          notes.push(`Custom skills did not run to the end — ${res.error}. Not run this pass: ${customRules.slice(k).map((r) => `“${r.name}”`).join(", ")}.`);
          break;
        }
        if (res.terminated) {
          // LNK-6: a match that never returned — the one overrun that switches
          // a skill off, with the reason on the skill itself, and said here.
          // Its partial output is not queued.
          const reason = `Switched off by the engine: one match ran for ${res.terminated.ms} ms on one page of indexed text without finishing and was stopped. Simplify the pattern, then switch it back on.`;
          let { error: offErr } = await admin.from("link_rules")
            .update({ enabled: false, disabled_reason: reason })
            .eq("id", rule.id).eq("org_id", orgId);
          if (offErr && (offErr.code === "PGRST204" || offErr.code === "42703")) {
            // Before 20261125 there is no disabled_reason column: switch it off
            // all the same; the reason is in this run's notes.
            ({ error: offErr } = await admin.from("link_rules")
              .update({ enabled: false }).eq("id", rule.id).eq("org_id", orgId));
          }
          disabledSkills.push(rule.name);
          notes.push(offErr
            ? `Skill “${rule.name}”: one match never finished and was stopped; it could not be switched off (${offErr.message}).`
            : `Skill “${rule.name}”: one match ran for ${res.terminated.ms} ms on one page without finishing and was stopped — the skill was switched off.`);
          continue;
        }
        if (res.startPending) {
          // The worker was still loading the texts when this pass's time ran
          // out: this skill read nothing; the run goes on (the worker keeps
          // loading for the next skill, or the run's budget ends the loop).
          notes.push(`Skill “${rule.name}” did not run this pass — the custom-skill worker was still loading the indexed text when this pass's ${Math.round(CUSTOM_RUN_BUDGET_MS / 1000)} s ran out.`);
          continue;
        }
        customDrafts.push(...customSkillDrafts({ id: rule.id, name: rule.name }, textOccurrences, res.found, identityIndex));
        if (res.skipped.length > 0) {
          // A slow page is not a broken skill: the rest of that document was
          // not read for it this pass, and the run says so.
          const n = res.skipped.length;
          const slowest = Math.max(...res.skipped.map((x) => x.ms));
          notes.push(`Skill “${rule.name}” was slow on ${n} document${n === 1 ? "" : "s"} (up to ${slowest} ms on one page; the budget is ${SKILL_DOC_BUDGET_MS} ms per page) — the rest of ${n === 1 ? "that document was" : "those documents were"} not read for it this pass. Simplify the pattern if this repeats.`);
        }
        if (res.budgetSpent) {
          const read = res.found.filter(Array.isArray).length;
          notes.push(`Skill “${rule.name}” read ${read} of ${pages} indexed pages before its share of this pass's ${Math.round(CUSTOM_RUN_BUDGET_MS / 1000)} s ran out — the rest of the text was not read for it this pass.`);
        }
      }
    } finally {
      await matcher.close();
    }
  }

  // ── Co-citation: the team's own questions as evidence ─────────────────
  let coDrafts: ProposalDraft[] = [];
  if (builtinEnabled("co_citation")) {
    const coRule = (rules ?? []).find((r) => r.builtin_key === "co_citation");
    const minCo = coRule?.config?.minCoCitations ?? 2;
    const { data: qs, error: qErr } = await admin
      .from("knowledge_questions")
      .select("question, citations")
      .eq("org_id", orgId)
      .not("citations", "is", null)
      .order("created_at", { ascending: false })
      .limit(QUESTION_WINDOW);
    // LNK-2: a failed read is said, not silently "no questions".
    if (qErr) notes.push(`Answered questions could not be read (${qErr.message}) — Answered-together skipped this pass.`);
    const questions = (qs as Array<{ question: string | null; citations: unknown }>) ?? [];
    if (questions.length >= QUESTION_WINDOW) {
      saturated.push("citedQuestions");
      notes.push(`Answered-together read the latest ${QUESTION_WINDOW} answered questions.`);
    }
    const coRows: CoCitationRow[] = [];
    for (const q of questions) {
      const cites = Array.isArray(q.citations) ? q.citations : [];
      const ids = new Set<string>();
      for (const c of cites) {
        const kd = (c as { documentId?: string }).documentId;
        if (!kd) continue;
        const src = sourceByKdoc.get(kd);
        if (src && allowed.has(src)) ids.add(src);
      }
      if (ids.size >= 2) coRows.push({ question: q.question ?? "", docIds: [...ids] });
    }
    inputs.citedQuestions = coRows.length;
    coDrafts = proposeCoCitations(coRows, { minCoCitations: minCo });
  }

  // ── Reason ────────────────────────────────────────────────────────────
  const drafts: ProposalDraft[] = [
    ...proposeOpcContinuity(opcOccurrences, identityIndex),
    ...(builtinEnabled("shared_equipment") ? proposeSharedEquipment(tagOccurrences) : []),
    ...customDrafts,
    ...coDrafts,
  ];
  const candidatePairs = new Set(drafts.map((d) => `${d.documentId}|${d.targetDocumentId}`));
  const candidateDocs = [...new Set(drafts.flatMap((d) => [d.documentId, d.targetDocumentId]))];

  // What is already known about THESE pairs — read by targeted query on the
  // candidate documents, to completion (LNK-2: a bulk read truncated at
  // 20,000 rows let dismissed pairs come back). A read that fails stops the
  // pass before anything is written: without the decisions, a dismissed
  // pair would be proposed again.
  const known: Required<KnownPairs> = {
    linked: new Set(), decided: new Set(), dismissed: new Set(), pending: new Map(),
  };
  let readFailed: string | null = null;
  for (const col of ["document_id", "target_document_id"] as const) {
    await inChunks(candidateDocs, async (slice) => {
      const r = await readPaged<{ document_id: string; target_document_id: string }>((from, to) => admin
        .from("document_related_resources")
        .select("document_id, target_document_id")
        .eq("org_id", orgId).not("target_document_id", "is", null)
        .in(col, slice)
        .order("id", { ascending: true })
        .range(from, to), Number.POSITIVE_INFINITY);
      if (r.error) readFailed ??= r.error.message;
      for (const x of r.rows) {
        const [a, b] = orderPair(x.document_id, x.target_document_id);
        known.linked.add(`${a}|${b}`);
      }
      return [];
    });
  }
  // proposed_links stores every pair smallest-id-first, so the pair's first
  // id finds all of its rows.
  const firstIds = [...new Set(drafts.map((d) => d.documentId))];
  await inChunks(firstIds, async (slice) => {
    type Prior = {
      document_id: string; target_document_id: string; proposer: string; status: string; tier: ProposalTier; confidence: number;
      source_rev: string | null; evidence: { summary?: string; page?: number; sourceDocumentId?: string } | null;
    };
    const r = await readPaged<Prior>((from, to) => admin
      .from("proposed_links")
      .select("document_id, target_document_id, proposer, status, tier, confidence, source_rev, evidence")
      .eq("org_id", orgId)
      .in("document_id", slice)
      .order("id", { ascending: true })
      .range(from, to), Number.POSITIVE_INFINITY);
    if (r.error) readFailed ??= r.error.message;
    for (const x of r.rows) {
      const pair = `${x.document_id}|${x.target_document_id}`;
      if (!candidatePairs.has(pair)) continue;
      // LNK-1: approved settles the pair; dismissed blocks that skill's
      // opinion only (LNK-8); pending is already queued (LNK-12) — and is
      // refreshed when its revision or evidence moved on (LNK-1); STALE is
      // none of these — its revision was superseded, so it is re-derived.
      if (x.status === "approved") known.decided.add(pair);
      else if (x.status === "dismissed") known.dismissed.add(`${pair}|${x.proposer}`);
      else if (x.status === "pending") {
        known.pending.set(`${pair}|${x.proposer}`, {
          tier: x.tier, confidence: Number(x.confidence), sourceRev: x.source_rev ?? null, evidence: x.evidence ?? null,
        });
      }
    }
    return [];
  });
  if (readFailed) {
    errors.push(`Existing links and decisions could not be read (${readFailed}) — nothing was written this pass, so no dismissed connection comes back.`);
    return emptyRun();
  }

  const open = filterDrafts(drafts, known);
  const fresh = rankDrafts(dropAlreadyQueued(mergeDrafts(open), known.pending));
  // LNK-10: the ceiling fails CLOSED — a count that cannot be read admits
  // no new guesses this pass (strong and provable proposals still queue).
  const { count: pendingInferred, error: countErr } = await admin
    .from("proposed_links").select("id", { count: "exact", head: true })
    .eq("org_id", orgId).eq("status", "pending").eq("tier", "inferred");
  const inferredRoom = countErr || pendingInferred === null || pendingInferred === undefined
    ? 0
    : Math.max(0, MAX_PENDING_INFERRED - pendingInferred);
  if (countErr) {
    notes.push(`The queue's inferred proposals could not be counted (${countErr.message}) — no new inferred proposals were added this pass.`);
  }
  // LNK-1: refreshing an inferred row already pending takes no new room.
  const plan = planBatch(fresh, { batch: BATCH, inferredRoom, pending: known.pending });
  if (plan.heldInferred > 0) {
    notes.push(`${plan.heldInferred} inferred proposal${plan.heldInferred === 1 ? " is" : "s are"} waiting for room — the queue holds ${MAX_PENDING_INFERRED} inferred at a time; decide some and run again.`);
  }
  const { autoApply, queue } = splitByAutoApply(plan.take);

  // ── Write ─────────────────────────────────────────────────────────────
  // LNK-3 / IRLS-2: provable links apply against the plain (document_id,
  // target_document_id) unique index (20261126) — the carrier is the lower
  // document number (LNK-13). If the batch cannot be written (a database
  // without that index answers 42P10), each row is inserted on its own; a
  // pair already linked is skipped; a row that still fails goes to the
  // review queue for a person instead of vanishing, and the run says so as
  // an ERROR.
  let autoApplied = 0;
  let fellBackToQueue = 0;
  const queueDrafts = [...queue];
  if (autoApply.length > 0) {
    const rowFor = (d: ProposalDraft) => {
      const [carrier, other] = carrierOrder(
        { id: d.documentId, document_number: docById.get(d.documentId)?.document_number },
        { id: d.targetDocumentId, document_number: docById.get(d.targetDocumentId)?.document_number },
      );
      return {
        org_id: orgId,
        document_id: carrier,
        target_document_id: other,
        kind: "document",
        label: d.evidence.summary.slice(0, 120),
        origin: "system",
        proposer: d.proposer,
        evidence: d.evidence,
        sort_order: 0,
      };
    };
    const { data, error } = await admin
      .from("document_related_resources")
      .upsert(autoApply.map(rowFor), { onConflict: "document_id,target_document_id", ignoreDuplicates: true })
      .select("id");
    if (!error) {
      autoApplied = ((data as unknown[] | null) ?? []).length;
    } else {
      if (error.code === "42P10") {
        notes.push("Provable links were applied one by one — the 20261126 migration (plain link index) is not applied yet.");
      }
      let lastError: string | null = null;
      for (const d of autoApply) {
        const one = await admin.from("document_related_resources").insert(rowFor(d)).select("id");
        if (!one.error) { autoApplied += ((one.data as unknown[] | null) ?? []).length; continue; }
        if (one.error.code === "23505") continue; // already linked
        lastError = one.error.message;
        queueDrafts.push(d);
        fellBackToQueue += 1;
      }
      if (fellBackToQueue > 0) {
        errors.push(`${fellBackToQueue} provable connection${fellBackToQueue === 1 ? "" : "s"} could not be applied (${lastError}) — queued for review instead.`);
      }
    }
  }

  let proposed = 0;
  if (queueDrafts.length > 0) {
    const rows = queueDrafts.map((d) => ({
      org_id: orgId,
      document_id: d.documentId,
      target_document_id: d.targetDocumentId,
      proposer: d.proposer,
      tier: d.tier,
      confidence: d.confidence,
      evidence: d.evidence,
      source_rev: d.sourceRev ?? null,
      status: "pending",
    }));
    // LNK-1: a stale row for the same (pair, skill) flips back to pending
    // with the current revision — the upsert refreshes it in place.
    const { data, error } = await admin
      .from("proposed_links")
      .upsert(rows, { onConflict: "document_id,target_document_id,proposer", ignoreDuplicates: false })
      .select("id");
    if (error) errors.push(`Queue write failed: ${error.message}`);
    else proposed = ((data as unknown[] | null) ?? []).length;
  }

  // Evidence audit against the facts as they stand right now.
  const currentTagsByDoc = new Map<string, Set<string>>();
  for (const o of tagOccurrences) {
    (currentTagsByDoc.get(o.documentId) ?? currentTagsByDoc.set(o.documentId, new Set()).get(o.documentId)!)
      .add(o.tag);
  }
  const evidenceLost = await flagLostEvidence(admin, orgId, currentTagsByDoc, () =>
    ceiling("systemLinks", READ_CAP.systemLinks, "system-applied links for the evidence audit"), notes, errors);

  return {
    scanned: docRows.length,
    proposed,
    autoApplied,
    skipped: candidatePairs.size - fresh.length,
    evidenceLost,
    // A pass that failed a write must not be repeated by the slice driver:
    // the same write would fail again (the error is on the run).
    more: plan.more && errors.length === 0,
    heldInferred: plan.heldInferred,
    fellBackToQueue,
    disabledSkills,
    notes,
    errors,
    inputs: { ...inputs, customSkills: customRules.length - disabledSkills.length },
  };
}

/** Publish-time housekeeping: a pending proposal whose evidence was read
 *  from THIS document at a revision that is no longer its current one — a
 *  ghost of a drawing that no longer says that. Stale it so review never
 *  acts on stale evidence (the next run re-derives it from the new text —
 *  LNK-1).
 *
 *  `source_rev` is a revision of the document the evidence was read from,
 *  which is either endpoint (an off-page connector or a custom skill reads
 *  one side's text). The proposers record that document as
 *  `evidence.sourceDocumentId`; a row whose evidence came from the OTHER
 *  endpoint is left alone — its own publish sweeps it. A row written before
 *  the proposers recorded it is staled only when its revision matches
 *  neither endpoint's current one (whichever side it was read from has
 *  moved on); when it matches the other endpoint it may be current, so it
 *  stays.
 *
 *  Deliberately does NOT touch approved links: at publish time the new
 *  revision hasn't been re-extracted yet, so "did the evidence survive?"
 *  is unanswerable. That check runs in flagLostEvidence() after extraction. */
export async function invalidateProposalsForRevision(
  admin: SupabaseClient,
  input: { orgId: string; documentId: string; newRev: string | null },
): Promise<{ staled: number; error: string | null }> {
  type Row = {
    id: string; document_id: string; target_document_id: string;
    source_rev: string | null; evidence: { sourceDocumentId?: string } | null;
  };
  const read = await readPaged<Row>((from, to) => admin
    .from("proposed_links")
    .select("id, document_id, target_document_id, source_rev, evidence")
    .eq("org_id", input.orgId)
    .eq("status", "pending")
    .or(`document_id.eq.${input.documentId},target_document_id.eq.${input.documentId}`)
    .not("source_rev", "is", null)
    .neq("source_rev", input.newRev ?? "")
    .order("id", { ascending: true })
    .range(from, to), Number.POSITIVE_INFINITY);
  if (read.error) return { staled: 0, error: read.error.message };

  const otherOf = (r: Row) => (r.document_id === input.documentId ? r.target_document_id : r.document_id);
  const legacy = read.rows.filter((r) => !r.evidence?.sourceDocumentId);
  const otherRev = new Map<string, string | null>();
  const otherIds = [...new Set(legacy.map(otherOf))];
  if (otherIds.length > 0) {
    let revErr: string | null = null;
    await inChunks(otherIds, async (slice) => {
      const { data, error } = await admin.from("documents").select("id, rev").eq("org_id", input.orgId).in("id", slice);
      if (error) revErr ??= error.message;
      for (const d of (data as Array<{ id: string; rev: string | null }> | null) ?? []) otherRev.set(d.id, d.rev);
      return [];
    });
    if (revErr) return { staled: 0, error: revErr };
  }
  const ids = read.rows.filter((r) => {
    const src = r.evidence?.sourceDocumentId;
    if (src) return src === input.documentId;
    const other = otherOf(r);
    return !otherRev.has(other) || otherRev.get(other) !== r.source_rev;
  }).map((r) => r.id);
  if (ids.length === 0) return { staled: 0, error: null };

  let staled = 0;
  let writeErr: string | null = null;
  await inChunks(ids, async (slice) => {
    const { data, error } = await admin
      .from("proposed_links")
      .update({ status: "stale" })
      .eq("org_id", input.orgId)
      .eq("status", "pending")
      .in("id", slice)
      .select("id");
    if (error) writeErr ??= error.message;
    staled += ((data as unknown[] | null) ?? []).length;
    return [];
  });
  return { staled, error: writeErr };
}

/** After re-extraction: system-applied links whose stated evidence no longer
 *  holds. The link STAYS — a human may still want it — but it's marked, so
 *  "this connection was based on E-101 appearing on both sheets; the current
 *  revision dropped it" becomes visible instead of silently rotting.
 *
 *  Only links carrying tag evidence can be checked this way; OPC continuity
 *  evidence is re-verified by the next proposer pass. */
async function flagLostEvidence(
  admin: SupabaseClient,
  orgId: string,
  currentTagsByDoc: Map<string, Set<string>>,
  onCeiling: () => void,
  notes: string[],
  errors: string[],
): Promise<number> {
  type SysLink = {
    id: string; document_id: string; target_document_id: string | null;
    evidence: { tags?: string[] } | null;
  };
  const read = await readPaged<SysLink>((from, to) => admin
    .from("document_related_resources")
    .select("id, document_id, target_document_id, evidence, origin, evidence_lost_at")
    .eq("org_id", orgId).eq("origin", "system").is("evidence_lost_at", null)
    .order("id", { ascending: true })
    .range(from, to), READ_CAP.systemLinks);
  // LNK-2 (fix pass 4): a failed read is said, never a quiet "nothing lost".
  if (read.error) {
    notes.push(`The evidence audit could not read the system-applied links (${read.error.message}) — no link was checked for lost evidence this pass.`);
    return 0;
  }
  if (read.saturated) onCeiling();

  const lost: string[] = [];
  for (const r of read.rows) {
    const tags = r.evidence?.tags;
    if (!tags || tags.length === 0 || !r.target_document_id) continue;
    const a = currentTagsByDoc.get(r.document_id);
    const b = currentTagsByDoc.get(r.target_document_id);
    // Never flag on missing data — a document that hasn't been extracted
    // yet is unknown, not changed.
    if (!a || !b) continue;
    if (!tags.some((t) => a.has(t) && b.has(t))) lost.push(r.id);
  }
  if (lost.length === 0) return 0;

  // The count reported is the rows actually marked (checked writes); a
  // refused write is an error on the run.
  const stamp = new Date().toISOString();
  let marked = 0;
  let writeErr: string | null = null;
  for (let i = 0; i < lost.length; i += CHUNK) {
    const { data, error } = await admin.from("document_related_resources")
      .update({ evidence_lost_at: stamp })
      .in("id", lost.slice(i, i + CHUNK))
      .select("id");
    if (error) { writeErr ??= error.message; continue; }
    marked += ((data as unknown[] | null) ?? []).length;
  }
  if (writeErr) errors.push(`Marking system links whose evidence was lost failed (${writeErr}) — ${lost.length - marked} of ${lost.length} were not marked.`);
  return marked;
}

export type { ProposalDraft };
