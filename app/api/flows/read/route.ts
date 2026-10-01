// /api/flows/read — read a process flow diagram, propose the plant's flows.
//
// A document controller points at a knowledge document (a PFD, a block
// diagram, a P&ID overview) and the AI reads the printed pages — vision, not
// text scraping — and proposes DIRECTIONAL flow connections. The same
// grounding contract as every AI writer in this app: the model may only
// connect entities the server verified exist (registry assets by tag, Site
// Codebook units by code), through opaque handles, so a hallucinated vessel
// can never enter the topology. Proposals land as status='proposed' rows for
// a controller to accept in the unit hub or the plant-wide review list.
//
// Authority: the controller tier — Admin / DocCtrl held anywhere in the role
// collection (lib/permissions isControllerPrincipal, what is_org_controller
// means; DEC-35: no role list here). This shapes the org's shared process
// map, and the database (20261155) says the same.
//
// The page read is the CALLER's (SEC-10): a mirror of a controlled document
// is resolved through lib/docFileServer resolveDocumentFile — the download
// deny binds, a broken folder chain is named, and pages served only because
// the reader is a controller are recorded (DEC-43, channel "flows_read").
// The gate is asked last, just before the render: a read the AI gates or
// the empty registry refuse opens no file and records no restricted read
// (a 428 → sign → retry is one record, not two).
//
// The model call is governed (GOV-11 / PR-12): assertAiGates runs first —
// own key, allowlist, the signed acceptable-use agreement (428 with the text
// to sign), the cap over every op — so a refusal costs no render, then
// governedAiCall carries the page images through the same gates, reserves
// the call's worst case and meters it.
//
// What the reader proposes, and what it skips, is decided in lib/flowsRead
// (pure): the roster (the launching unit's equipment first, the count left
// off said), settled pairs read whole and keyed by status, a dismissal that
// a new revision of the same drawing may re-propose, a malformed reply named
// as such, the reader's confidence kept as data. Every reason a read came
// back short is in the answer.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { governedAiCall, GovernedCallError } from "@/lib/ai/governedCall";
import { assertAiGates } from "@/lib/ai/aiGates";
import { isTimeoutError } from "@/lib/ai/providerCall";
import { extractJsonBlock } from "@/lib/orchestrator/protocol";
import {
  renderKnowledgePagesReport, DRAWING_RENDER_WIDTH,
} from "@/lib/knowledgePageRender";
import { resolveDocumentFile } from "@/lib/docFileServer";
import { isControllerPrincipal } from "@/lib/permissions";
import { normalizeRoles } from "@/lib/roleCapabilities";
import { routeDeadline, aiBudgetMs, tooLargeToReadMessage } from "@/lib/routeDeadline";
import {
  buildRoster, rosterPrompt, parseFlowReply, planFlowProposals, readNote,
  MALFORMED_REPLY_MESSAGE, SKIP_REASON_TEXT, type PriorFlow, type ProposalRow,
} from "@/lib/flowsRead";
import type { Role } from "@/types/schema";

export const runtime = "nodejs";
export const maxDuration = 120;

const bad = (error: string, status: number, extra?: Record<string, unknown>) =>
  NextResponse.json({ error, ...(extra ?? {}) }, { status });
const MAX_PAGES = 6;
/** The registry and the flow table are read whole, in pages, up to this. */
const READ_CAP = 20_000;
const PAGE = 1000;
/** No page render STARTS with less than this left for the model. */
const MODEL_RESERVE_MS = 45_000;

const columnMissing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42703" || e.code === "PGRST204" || /column [\w."]+ does not exist|could not find the '\w+' column/i.test(e.message ?? ""));

export async function POST(req: NextRequest) {
  const deadline = routeDeadline(maxDuration);
  let body: { orgId?: string; knowledgeDocumentId?: string; pages?: number[]; unitCode?: string };
  try { body = await req.json(); } catch { return bad("Bad JSON", 400); }
  const orgId = (body.orgId ?? "").trim();
  const kdocId = (body.knowledgeDocumentId ?? "").trim();
  const unitCode = typeof body.unitCode === "string" ? body.unitCode.trim() || null : null;
  if (!orgId || !kdocId) return bad("orgId and knowledgeDocumentId required", 400);

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return bad("Not signed in", 401);
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return bad("Not signed in", 401);
  const userId = userData.user.id;

  const { data: member, error: memberErr } = await supabaseAdmin
    .from("org_members").select("role, roles, status")
    .eq("org_id", orgId).eq("uid", userId).maybeSingle();
  if (memberErr) return bad("Your membership could not be checked — try again.", 503);
  const m = member as { role?: string | null; roles?: unknown; status?: string } | null;
  // FLOW-3 / DEC-35: the controller tier by the role COLLECTION.
  if (!m || m.status !== "active"
      || !isControllerPrincipal({ role: (m.role ?? "") as Role, roles: normalizeRoles(m.roles, m.role) })) {
    return bad("Only admins and document controllers shape the process map.", 403);
  }

  // ── The document (whose pages they are is asked before the render). ────
  const { data: kdoc } = await supabaseAdmin
    .from("knowledge_documents").select("id, name, file_key, page_count, source_document_id, source_version_id")
    .eq("org_id", orgId).eq("id", kdocId).maybeSingle();
  const doc = kdoc as {
    id: string; name: string; file_key: string | null; page_count: number | null;
    source_document_id: string | null; source_version_id: string | null;
  } | null;
  if (!doc?.file_key) return bad("That document has no stored file to read.", 404);

  // ── The gates, before any render (GOV-11): a refusal costs nothing — and
  // opens no file, so it records no restricted read (DEC-43). ────────────
  try {
    await assertAiGates({ orgId, userId, op: "flowRead" });
  } catch (e) {
    if (e instanceof GovernedCallError) return bad(e.message, e.status, e.details);
    throw e;
  }

  // ── The roster the model is allowed to connect (FLOW-4 / AREA-5). ──────
  const assets: Array<{ id: string; tag: string; unit_code: string | null }> = [];
  for (let from = 0; from < READ_CAP; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("assets").select("id, tag, unit_code")
      .eq("org_id", orgId).eq("archived", false)
      .order("tag", { ascending: true }).order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return bad(`Couldn't read the equipment registry: ${error.message}`, 500);
    const rows = (data as typeof assets) ?? [];
    assets.push(...rows);
    if (rows.length < PAGE) break;
  }
  // Past the read cap the roster still says how much was left off.
  let assetsTotal = assets.length;
  if (assets.length >= READ_CAP) {
    const { count } = await supabaseAdmin
      .from("assets").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("archived", false);
    assetsTotal = Math.max(assets.length, count ?? 0);
  }
  const units: Array<{ code: string; label: string | null }> = [];
  for (let from = 0; from < READ_CAP; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("codebook_entries").select("code, label")
      .eq("org_id", orgId).eq("kind", "unit")
      .order("code", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) break; // a codebook that cannot be read grounds on equipment alone, as before
    const rows = (data as typeof units) ?? [];
    units.push(...rows);
    if (rows.length < PAGE) break;
  }
  if (assets.length === 0 && units.length === 0) {
    return bad("Nothing to connect yet — add equipment to the registry (or units to the Site Codebook) first, so the reader has real entities to ground on.", 412);
  }
  // The unit the drawing's number decodes to (documents.unit_code, 20261138).
  let drawingUnit: string | null = null;
  if (doc.source_document_id) {
    const { data: d, error } = await supabaseAdmin
      .from("documents").select("unit_code").eq("org_id", orgId).eq("id", doc.source_document_id).maybeSingle();
    if (!error) drawingUnit = ((d as { unit_code?: string | null } | null)?.unit_code ?? null) || null;
  }
  const unitLabel = unitCode ? (units.find((u) => u.code === unitCode)?.label || `Unit ${unitCode}`) : null;
  const roster = buildRoster(assets, units, { unitCode, drawingUnit, total: assetsTotal });

  // ── Whose pages they are (SEC-10), asked only now that the read will
  // happen: the DEC-43 record names pages actually opened for a reader. ──
  let fileKey = doc.file_key;
  let revisionRead: string | null = null;
  if (doc.source_document_id) {
    const gate = await resolveDocumentFile(orgId, doc.source_document_id, {
      uid: userId, email: userData.user.email ?? null, channel: "flows_read",
    });
    if (!gate.ok) return bad(gate.error, gate.status);
    // The pages read are the ones the gate decided on. The mirror's revision
    // is the one read only when its file IS that file (a mirror a sync has
    // not caught up with reads the current revision, recorded as unknown).
    fileKey = gate.file.fileKey;
    revisionRead = gate.file.fileKey === doc.file_key ? doc.source_version_id : null;
  }

  // ── Render the pages. Default: first MAX_PAGES (a PFD is usually short). ──
  const explicit = (body.pages ?? []).filter((p) => Number.isInteger(p) && p >= 1);
  const wanted = [...new Set(explicit)].slice(0, MAX_PAGES);
  const defaultPages = wanted.length === 0;
  const pagesRequested = defaultPages
    ? Array.from({ length: Math.min(doc.page_count ?? 1, MAX_PAGES) }, (_, i) => i + 1)
    : wanted;
  const render = await renderKnowledgePagesReport(fileKey, pagesRequested, {
    maxPages: MAX_PAGES,
    width: DRAWING_RENDER_WIDTH,
    deadlineAt: deadline - MODEL_RESERVE_MS,
  });
  const images = render.images;
  if (images.length === 0) {
    if (render.notStarted.length > 0) return bad(tooLargeToReadMessage(MAX_PAGES), 504);
    return bad("The pages could not be rendered for reading.", 502, {
      pagesRequested, pagesTotal: render.numPages ?? doc.page_count ?? null,
      pagesFailed: render.failed, pagesNotRead: render.outOfRange,
    });
  }
  const pagesTotal = render.numPages ?? doc.page_count ?? null;

  // ── Pairs already in the table, read WHOLE and in order (FLOW-5). ──────
  const readPrior = async (withVersion: boolean): Promise<{ rows: PriorFlow[]; error: { code?: string; message: string } | null }> => {
    const cols = "id, from_kind, from_ref, to_kind, to_ref, status, origin, source_document_id"
      + (withVersion ? ", source_version_id" : "");
    const rows: PriorFlow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabaseAdmin
        .from("process_flows").select(cols)
        .eq("org_id", orgId).order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) return { rows, error };
      const page = ((data as unknown) as PriorFlow[]) ?? [];
      rows.push(...page);
      if (page.length < PAGE) return { rows, error: null };
    }
  };
  let hasVersionColumn = true;
  let priorRead = await readPrior(true);
  if (priorRead.error && columnMissing(priorRead.error)) {
    // Before 20261155: no revision is recorded, so every dismissal sticks.
    hasVersionColumn = false;
    priorRead = await readPrior(false);
  }
  if (priorRead.error) return bad(`Couldn't read the flows already recorded: ${priorRead.error.message}`, 500);
  const prior = priorRead.rows;

  // ── Read. One governed call carrying the page images (PR-12). ──────────
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
  const budget = aiBudgetMs(deadline, 90_000);
  if (budget === null) return bad(tooLargeToReadMessage(MAX_PAGES), 504);
  let text: string;
  try {
    const out = await governedAiCall({
      orgId, userId, op: "flowRead",
      system: SYSTEM,
      user: `Document: ${doc.name}\nPages attached in order: ${images.map((i) => i.page).join(", ")}\n\n${rosterPrompt(roster, unitLabel)}`,
      images: images.map((i) => ({ base64: i.base64, mediaType: i.mediaType })),
      maxTokens: 1600,
      timeoutMs: budget,
    });
    text = out.text;
  } catch (e) {
    if (e instanceof GovernedCallError) return bad(e.message, e.status, e.details);
    if (isTimeoutError(e)) return bad("The reader ran out of time on these pages — try fewer pages per read.", 504);
    return bad((e as Error).message, 502);
  }

  // ── The reply (PR-8): malformed is said, never a bare 500. ─────────────
  const reply = parseFlowReply(extractJsonBlock(text));
  if (!reply.ok) {
    return bad(MALFORMED_REPLY_MESSAGE, 502, {
      malformedReply: true, pagesRead: images.map((i) => i.page), pagesTotal,
    });
  }
  const plan = planFlowProposals({
    flows: reply.flows, roster: roster.roster, prior,
    docId: doc.id, revisionRead, pagesAttached: images.map((i) => i.page),
  });

  // ── Write (FLOW-12): a colliding pair is skipped, the rest land. ───────
  const rowOf = (r: ProposalRow) => ({
    org_id: orgId,
    from_kind: r.from_kind, from_ref: r.from_ref,
    to_kind: r.to_kind, to_ref: r.to_ref,
    label: r.label,
    status: "proposed",
    origin: "ai",
    source_document_id: doc.id,
    source_page: r.source_page,
    ...(hasVersionColumn ? { source_version_id: revisionRead } : {}),
    evidence: { docName: doc.name, confidence: r.confidence },
    created_by: userId,
  });
  const landed: ProposalRow[] = [];
  let skippedDuplicate = 0;
  const labelOf = new Map(roster.roster.map((e) => [`${e.kind}:${e.id}`, e.label]));
  const skippedPairs = [...plan.skippedPairs] as Array<{ from: string; to: string; reason: string }>;
  const duplicate = (r: ProposalRow) => {
    skippedDuplicate += 1;
    skippedPairs.push({ from: labelOf.get(`${r.from_kind}:${r.from_ref}`) ?? r.from_ref, to: labelOf.get(`${r.to_kind}:${r.to_ref}`) ?? r.to_ref, reason: "duplicate" });
  };
  let writeFailed = 0;
  let writeError: string | null = null;
  if (plan.inserts.length > 0) {
    const { data, error } = await supabaseAdmin.from("process_flows")
      .upsert(plan.inserts.map(rowOf), { onConflict: "org_id,from_kind,from_ref,to_kind,to_ref", ignoreDuplicates: true })
      .select("from_kind, from_ref, to_kind, to_ref");
    if (!error) {
      const got = new Set(((data as Array<{ from_kind: string; from_ref: string; to_kind: string; to_ref: string }>) ?? [])
        .map((r) => `${r.from_kind}:${r.from_ref}>${r.to_kind}:${r.to_ref}`));
      for (const r of plan.inserts) {
        if (got.has(`${r.from_kind}:${r.from_ref}>${r.to_kind}:${r.to_ref}`)) landed.push(r);
        else duplicate(r);
      }
    } else {
      // One bad row (an endpoint deleted since the roster was read) must not
      // cost the others: write them one at a time.
      for (const r of plan.inserts) {
        const { error: e1 } = await supabaseAdmin.from("process_flows").insert(rowOf(r));
        if (!e1) landed.push(r);
        else if (e1.code === "23505") duplicate(r);
        else { writeFailed += 1; writeError = writeError ?? e1.message; }
      }
    }
  }
  let reproposed = 0;
  for (const r of plan.repropose) {
    const { data, error } = await supabaseAdmin.from("process_flows")
      .update({
        status: "proposed", label: r.label, source_page: r.source_page,
        source_version_id: revisionRead,
        evidence: { docName: doc.name, confidence: r.confidence, previousRevision: r.previousRevision },
        decided_by: null, decided_by_name: null, decided_at: null,
      })
      .eq("id", r.id).eq("org_id", orgId).eq("status", "dismissed")
      .select("id");
    if (error) { writeFailed += 1; writeError = writeError ?? error.message; continue; }
    if ((data as unknown[] | null)?.length) { landed.push(r); reproposed += 1; }
    else duplicate(r); // decided again while this read ran
  }

  // FLOW-1: proposals that land outside the unit the read was launched from.
  let outsideUnit: number | null = null;
  if (unitCode) {
    const mine = new Set(assets.filter((a) => a.unit_code === unitCode).map((a) => a.id));
    const touches = (kind: string, ref: string) => (kind === "unit" ? ref === unitCode : mine.has(ref));
    outsideUnit = landed.filter((r) => !touches(r.from_kind, r.from_ref) && !touches(r.to_kind, r.to_ref)).length;
  }

  const pagesRead = images.map((i) => i.page);
  const pagesNotRead = [...render.outOfRange, ...render.notStarted].sort((a, b) => a - b);
  const outcome = {
    proposed: landed.length,
    reproposed,
    skippedConfirmed: plan.skippedConfirmed,
    skippedDismissed: plan.skippedDismissed,
    skippedPending: plan.skippedPending,
    skippedUngrounded: plan.skippedUngrounded,
    skippedDuplicate,
    skippedOverLimit: plan.skippedOverLimit,
    writeFailed,
    pagesRead, pagesTotal, pagesFailed: render.failed, pagesNotRead,
    defaultPages,
    assetsOmitted: roster.assetsOmitted,
  };

  // AREA-8: a read is a fact the area checklist counts, flows found or not.
  await supabaseAdmin.from("audit_logs").insert({
    action: "FLOWS_READ",
    resource_type: "knowledge_document",
    resource_id: doc.id,
    org_id: orgId,
    user_id: userId,
    user_email: userData.user.email ?? null,
    details: {
      pagesRead, pagesTotal, proposed: landed.length, reproposed,
      sourceDocumentId: doc.source_document_id, revisionRead, unitCode,
    },
  }).then(() => undefined, () => undefined);

  if (landed.length === 0 && writeFailed > 0) {
    return bad(
      `The drawing was read (the call was charged to your key), but writing the proposals failed: ${writeError ?? "unknown error"}`,
      500, { ...outcome, note: readNote(outcome) },
    );
  }

  return NextResponse.json({
    ...outcome,
    // Kept for older clients: every pair a person already decided.
    skippedSettled: plan.skippedConfirmed + plan.skippedDismissed,
    lowConfidence: plan.lowConfidence,
    // IEDGE-8: each pair found but not proposed, with its reason.
    skippedPairs: skippedPairs.map((p) => ({ ...p, why: SKIP_REASON_TEXT[p.reason as keyof typeof SKIP_REASON_TEXT] ?? p.reason })),
    outsideUnit,
    pagesRequested,
    truncated: defaultPages && pagesTotal !== null && pagesTotal > pagesRead.length,
    renderWidth: render.width,
    roster: {
      assetsListed: roster.assetsListed, assetsTotal: roster.assetsTotal, assetsOmitted: roster.assetsOmitted,
      unitsListed: roster.unitsListed, launchingUnit: unitCode, launchingUnitListed: roster.launchingUnitListed,
      launchingUnitOmitted: roster.launchingUnitOmitted, drawingUnit,
    },
    ...(writeError ? { writeError } : {}),
    note: readNote(outcome),
  });
}
