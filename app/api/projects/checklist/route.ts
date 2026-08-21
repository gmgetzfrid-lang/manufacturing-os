// POST /api/projects/checklist — the checklist AI: segment + assess.
//
// "The checklist tells the system what's needed; the system tells you
// what's missing." Two proposal actions, both READ-ONLY — the human saves:
//
//   segment — read a checklist document's printed pages (a PSSR form, an MI
//     checklist, a QA-QC template) and split it into discrete items with
//     their section headings. Returned for review; lib/checklists.
//     createChecklist persists what the human approves.
//
//   assess — given the project's real context (purpose, job kind, SOW,
//     document register, equipment tags, milestones), propose per-item
//     applicability: does this line apply to THIS job, or is it N/A — with
//     the reasoning stated. Returned for review; applyAssessment writes it
//     and never overrides a human's decision.
//
// Authority: any active member can run proposals (they spend the caller's
// own AI key, and saving is where write authority is enforced).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { governedAiCall, GovernedCallError } from "@/lib/ai/governedCall";
import { extractJsonBlock } from "@/lib/orchestrator/protocol";
import { renderKnowledgePages } from "@/lib/knowledgePageRender";
import { resolveDocumentFile } from "@/lib/docFileServer";
import { validateSegmentedItems, type SegmentedItem } from "@/lib/checklistEngine";

export const runtime = "nodejs";
export const maxDuration = 120;

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });
const MAX_PAGES = 10;

const SEGMENT_SYSTEM =
  "You read industrial checklists (PSSR, mechanical integrity, QA/QC) from printed pages and split them into discrete checkable items.\n" +
  "Rules:\n" +
  "- One item per checkable line. Keep the item's own wording — do not paraphrase.\n" +
  "- section: the heading the item sits under, when the form has sections.\n" +
  "- Skip page furniture: titles, signature blocks, revision tables, instructions-to-the-reviewer.\n" +
  "- Preserve document order.\n" +
  'Return STRICT JSON: {"items":[{"section":"Documentation","text":"P&IDs updated to reflect as-built condition"}]}';

export async function POST(req: NextRequest) {
  let body: {
    orgId?: string; projectId?: string; action?: string;
    documentId?: string; checklistId?: string;
  };
  try { body = await req.json(); } catch { return bad("Bad JSON", 400); }
  const orgId = (body.orgId ?? "").trim();
  const projectId = (body.projectId ?? "").trim();
  const action = (body.action ?? "").trim();
  if (!orgId || !projectId) return bad("orgId and projectId required", 400);
  if (action !== "segment" && action !== "assess") return bad("action must be segment or assess", 400);

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return bad("Not signed in", 401);
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return bad("Not signed in", 401);
  const userId = userData.user.id;

  const [{ data: member }, { data: project }] = await Promise.all([
    supabaseAdmin.from("org_members").select("status").eq("org_id", orgId).eq("uid", userId).maybeSingle(),
    supabaseAdmin.from("projects")
      .select("id, name, purpose, goals, success_criteria, job_kind, sow_document_id, intake_collection_id")
      .eq("id", projectId).eq("org_id", orgId).maybeSingle(),
  ]);
  if (!member || (member as { status?: string }).status !== "active") return bad("Not a member of this workspace.", 403);
  if (!project) return bad("Project not found.", 404);

  // ── segment ─────────────────────────────────────────────────────────────
  if (action === "segment") {
    const documentId = (body.documentId ?? "").trim();
    if (!documentId) return bad("documentId required", 400);
    const file = await resolveDocumentFile(orgId, documentId);
    if (!file) return bad("That document has no stored file to read.", 404);

    const images = await renderKnowledgePages(file.fileKey, Array.from({ length: MAX_PAGES }, (_, i) => i + 1), MAX_PAGES);
    if (images.length === 0) return bad("The pages could not be rendered for reading — is it a PDF?", 502);

    let text: string;
    try {
      const out = await governedAiCall({
        orgId, userId, op: "checklistSegment",
        system: SEGMENT_SYSTEM,
        user: `Document: ${file.label}\nPages attached in order: ${images.map((i) => i.page).join(", ")}`,
        images: images.map((i) => ({ base64: i.base64, mediaType: i.mediaType })),
        maxTokens: 4000,
        timeoutMs: 90_000,
      });
      text = out.text;
    } catch (e) {
      if (e instanceof GovernedCallError) return bad(e.message, e.status);
      return bad((e as Error).message, 502);
    }

    const block = extractJsonBlock(text);
    let items: SegmentedItem[];
    try {
      const parsed = block ? (JSON.parse(block) as { items?: unknown }) : null;
      items = validateSegmentedItems(parsed?.items);
    } catch (e) {
      return bad((e as Error).message, 422);
    }
    return NextResponse.json({ items, pagesRead: images.map((i) => i.page), sourceLabel: file.label });
  }

  // ── assess ──────────────────────────────────────────────────────────────
  const checklistId = (body.checklistId ?? "").trim();
  if (!checklistId) return bad("checklistId required", 400);
  const { data: checklist } = await supabaseAdmin
    .from("project_checklists").select("id, title, kind")
    .eq("id", checklistId).eq("project_id", projectId).maybeSingle();
  if (!checklist) return bad("Checklist not found.", 404);
  const { data: itemRows } = await supabaseAdmin
    .from("checklist_items").select("id, seq, section, text, manual_note")
    .eq("checklist_id", checklistId).order("seq").limit(300);
  const items = ((itemRows ?? []) as Array<{ id: string; seq: number; section: string | null; text: string; manual_note: string | null }>);
  if (items.length === 0) return bad("This checklist has no items to assess.", 404);

  // The project's REAL context — the assessment grounds on what the
  // platform holds, not on typical-plant guesswork.
  const safe = async <T>(p: PromiseLike<{ data: T | null }>): Promise<T | null> => {
    try { return (await p).data; } catch { return null; }
  };
  const [sowFile, milestones, docs, assets] = await Promise.all([
    project.sow_document_id ? resolveDocumentFile(orgId, String(project.sow_document_id)).catch(() => null) : Promise.resolve(null),
    safe(supabaseAdmin.from("milestones").select("name, status").eq("project_id", projectId).limit(100)),
    project.intake_collection_id
      ? safe(supabaseAdmin.from("documents").select("title, name, document_number").eq("collection_id", String(project.intake_collection_id)).limit(200))
      : Promise.resolve(null),
    safe(supabaseAdmin.from("assets").select("tag").eq("org_id", orgId).eq("archived", false).limit(300)),
  ]);

  const goals = Array.isArray(project.goals) ? (project.goals as string[]).join("; ") : "";
  const context = [
    `Project: ${String(project.name ?? "")}`,
    project.job_kind ? `Job kind: ${String(project.job_kind)} (small = minor work, capital = major project)` : "",
    project.purpose ? `Purpose: ${String(project.purpose)}` : "",
    goals ? `Goals: ${goals}` : "",
    project.success_criteria ? `Success criteria: ${String(project.success_criteria)}` : "",
    sowFile ? `Summary of Work document on file: ${sowFile.label}` : "No Summary of Work attached.",
    milestones?.length
      ? `Schedule milestones: ${(milestones as Array<{ name: string }>).map((m) => m.name).slice(0, 40).join("; ")}`
      : "No schedule loaded.",
    docs?.length
      ? `Project documents on file: ${(docs as Array<{ title: string | null; name: string | null; document_number: string | null }>).map((d) => [d.document_number, d.title ?? d.name].filter(Boolean).join(" ")).slice(0, 60).join("; ")}`
      : "No project documents on file yet.",
    assets?.length ? `Known equipment tags (sample): ${(assets as Array<{ tag: string }>).map((a) => a.tag).slice(0, 60).join(", ")}` : "",
  ].filter(Boolean).join("\n");

  const itemList = items.map((it) => `${it.id.slice(0, 8)} | ${it.section ? `[${it.section}] ` : ""}${it.text}`).join("\n");

  const ASSESS_SYSTEM =
    "You assess which items of an industrial checklist apply to a SPECIFIC job, using only the project context provided.\n" +
    "Rules:\n" +
    "- applicability: \"applies\" when the project context shows this kind of work/equipment is in scope; \"na\" when the context clearly shows it is not; \"unknown\" when the context doesn't say — NEVER guess na without stated grounds.\n" +
    "- rationale: one sentence grounded in the context (\"SOW covers exchanger repipe — new welds, so weld records apply\"). No rationale, no verdict.\n" +
    "- ref is the 8-character id printed before each item.\n" +
    'Return STRICT JSON: {"assessments":[{"ref":"a1b2c3d4","applicability":"applies","rationale":"…"}]}';

  let text: string;
  try {
    const out = await governedAiCall({
      orgId, userId, op: "checklistAssess",
      system: ASSESS_SYSTEM,
      user: `PROJECT CONTEXT:\n${context}\n\nCHECKLIST "${String(checklist.title)}" (${String(checklist.kind)}) ITEMS:\n${itemList}`,
      maxTokens: 4000,
      timeoutMs: 90_000,
    });
    text = out.text;
  } catch (e) {
    if (e instanceof GovernedCallError) return bad(e.message, e.status);
    return bad((e as Error).message, 502);
  }

  const block = extractJsonBlock(text);
  let parsed: { assessments?: unknown[] } | null = null;
  try { parsed = block ? (JSON.parse(block) as { assessments?: unknown[] }) : null; }
  catch { return bad("The assessment wasn't valid JSON — try again.", 502); }
  const byRef = new Map(items.map((it) => [it.id.slice(0, 8), it]));
  const proposals: Array<{ itemId: string; applicability: "applies" | "na" | "unknown"; rationale: string }> = [];
  for (const raw of parsed?.assessments ?? []) {
    const a = raw as { ref?: string; applicability?: string; rationale?: string };
    const item = a.ref ? byRef.get(a.ref) : undefined;
    if (!item) continue;
    if (a.applicability !== "applies" && a.applicability !== "na" && a.applicability !== "unknown") continue;
    proposals.push({
      itemId: item.id,
      applicability: a.applicability,
      rationale: String(a.rationale ?? "").slice(0, 1000),
    });
  }
  if (proposals.length === 0) return bad("The assessment returned nothing usable — try again.", 502);
  return NextResponse.json({
    proposals,
    humanDecided: items.filter((it) => it.manual_note).length,
  });
}
