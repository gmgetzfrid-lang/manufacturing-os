// POST /api/companies/quality-manual — evaluate a contractor's quality
// manual against the ISO 9001-shaped rubric.
//
// "The system gauges how much of a quality manual they have." A controller
// points at the manual (already in doc control), the model reads the
// printed pages, and reports per-area findings: covered or not, with the
// citation-style finding stated. Coverage % comes from the pure rubric
// scorer. The route only PROPOSES — the score lands on the company's
// permanent record when a human reviews the findings and confirms
// (lib/companies.confirmQualityManual), matching every other AI writer in
// this app.
//
// Authority: Admin / DocCtrl — companies are org-level records.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { governedAiCall, GovernedCallError } from "@/lib/ai/governedCall";
import { extractJsonBlock } from "@/lib/orchestrator/protocol";
import { renderKnowledgePages } from "@/lib/knowledgePageRender";
import { resolveDocumentFile } from "@/lib/docFileServer";
import { QUALITY_MANUAL_RUBRIC, validateRubricFindings, rubricCoverageScore } from "@/lib/checklistEngine";
import { memberHoldsAny } from "@/lib/roleHeld";

export const runtime = "nodejs";
export const maxDuration = 120;

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });
const MAX_PAGES = 10;

export async function POST(req: NextRequest) {
  let body: { orgId?: string; companyId?: string; documentId?: string };
  try { body = await req.json(); } catch { return bad("Bad JSON", 400); }
  const orgId = (body.orgId ?? "").trim();
  const companyId = (body.companyId ?? "").trim();
  const documentId = (body.documentId ?? "").trim();
  if (!orgId || !companyId || !documentId) return bad("orgId, companyId and documentId required", 400);

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return bad("Not signed in", 401);
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return bad("Not signed in", 401);
  const userId = userData.user.id;

  const { data: member } = await supabaseAdmin
    .from("org_members").select("role, roles, status").eq("org_id", orgId).eq("uid", userId).maybeSingle();
  const m = member as { role?: string; status?: string } | null;
  // ADD-1: authority by the role COLLECTION, never the headline alone.
  if (!m || m.status !== "active" || !memberHoldsAny(m, ["Admin", "DocCtrl"])) {
    return bad("Only admins and document controllers evaluate company quality manuals.", 403);
  }

  const { data: company } = await supabaseAdmin
    .from("companies").select("id, name").eq("id", companyId).eq("org_id", orgId).maybeSingle();
  if (!company) return bad("Company not found.", 404);

  const file = await resolveDocumentFile(orgId, documentId);
  if (!file) return bad("That document has no stored file to read.", 404);
  const images = await renderKnowledgePages(file.fileKey, Array.from({ length: MAX_PAGES }, (_, i) => i + 1), MAX_PAGES);
  if (images.length === 0) return bad("The pages could not be rendered for reading — is it a PDF?", 502);

  const rubricText = QUALITY_MANUAL_RUBRIC
    .map((a) => `- ${a.key}: ${a.label} — expect: ${a.hint}`).join("\n");

  const SYSTEM =
    "You evaluate a contractor's QUALITY MANUAL for industrial mechanical work against a fixed rubric, reading the attached printed pages.\n" +
    "Rules:\n" +
    "- For EVERY rubric area report covered true/false with a finding grounded in what the pages actually show (\"Section 4 defines WPS/PQR control and welder continuity\") or what is missing (\"No calibration program appears anywhere in the attached pages\").\n" +
    "- covered=true only when the manual states a real process for the area — a heading alone is not coverage.\n" +
    "- Only the attached pages count. If the manual is longer than what is attached, judge what you can see; never assume unattached content.\n" +
    "- Use ONLY the rubric keys given.\n" +
    'Return STRICT JSON: {"findings":[{"area":"doc_control","covered":true,"finding":"…"}]}';

  let text: string;
  try {
    const out = await governedAiCall({
      orgId, userId, op: "qualityManualReview",
      system: SYSTEM,
      user: `Company: ${String(company.name)}\nManual document: ${file.label}\nPages attached in order: ${images.map((i) => i.page).join(", ")}\n\nRUBRIC AREAS:\n${rubricText}`,
      images: images.map((i) => ({ base64: i.base64, mediaType: i.mediaType })),
      maxTokens: 2500,
      timeoutMs: 90_000,
    });
    text = out.text;
  } catch (e) {
    if (e instanceof GovernedCallError) return bad(e.message, e.status);
    return bad((e as Error).message, 502);
  }

  const block = extractJsonBlock(text);
  let findings: ReturnType<typeof validateRubricFindings>;
  try {
    const parsed = block ? (JSON.parse(block) as { findings?: unknown }) : null;
    findings = validateRubricFindings(parsed?.findings);
  } catch {
    return bad("The evaluation wasn't valid JSON — try again.", 502);
  }
  if (findings.length === 0) return bad("The evaluation returned nothing usable — try again.", 502);
  const score = rubricCoverageScore(findings);

  return NextResponse.json({
    score,
    findings,
    gaps: findings.filter((f) => !f.covered).map((f) => ({ area: f.area, finding: f.finding })),
    pagesRead: images.map((i) => i.page),
    note: "Proposal only — confirm to put it on the company's record.",
  });
}
