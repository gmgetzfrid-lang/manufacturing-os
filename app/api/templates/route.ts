// /api/templates — output template definitions (blank template + examples +
// placeholder spec). The template FILE is uploaded to R2 by the client; this
// route stores the definition and analyzes the file's fill points.
//
//   GET    ?orgId=…                     → the org's templates
//   POST   { orgId, ...template }        → create/update (controllers)
//   POST   { orgId, action:"analyze", fileKey, kind }
//                                        → read the uploaded template, find
//                                          its {tags}, propose a placeholder
//                                          spec (kind, label, guidance)
//   POST   { orgId, action:"style", templateId }
//                                        → distill the example documents
//                                          into a reusable style guide
//   DELETE { orgId, id }                 → remove (controllers)

import { NextRequest, NextResponse } from "next/server";
import { fetchBytes } from "@/lib/r2Bytes";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal } from "@/lib/knowledgeAccess";
import { extractDocxText, extractXlsxText } from "@/lib/docxRender";
import { findPlaceholders, proposePlaceholders } from "@/lib/outputTemplateText";

export const runtime = "nodejs";
export const maxDuration = 120;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function authUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  return error || !user ? null : user;
}

const missingTable = (message: string, code?: string) =>
  code === "42P01" || /does not exist/i.test(message);

export async function GET(req: NextRequest) {
  const orgId = (req.nextUrl.searchParams.get("orgId") ?? "").trim();
  if (!orgId) return bad("orgId is required");
  const user = await authUser(req);
  if (!user) return bad("Unauthorized", 401);
  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not a member of this workspace", 403);

  const { data, error } = await supabaseAdmin
    .from("output_templates").select("*")
    .eq("org_id", orgId).order("created_at", { ascending: false });
  if (error) {
    return bad(
      missingTable(error.message, error.code)
        ? "Output templates need migration 20260923 — run it in Supabase, then reload."
        : `Couldn't load templates: ${error.message}`,
      missingTable(error.message, error.code) ? 424 : 500,
    );
  }
  const { data: gens } = await supabaseAdmin
    .from("output_generations").select("*")
    .eq("org_id", orgId).order("created_at", { ascending: false }).limit(20);

  return NextResponse.json({
    templates: data ?? [],
    generations: gens ?? [],
    canManage: principal.isController,
  });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  if (!orgId) return bad("orgId is required");
  const user = await authUser(req);
  if (!user) return bad("Unauthorized", 401);
  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not a member of this workspace", 403);

  // ── Analyze an uploaded template file ──────────────────────────────────
  // Guarded two ways: only controllers (who can manage templates anyway),
  // and only keys under this org's own output-template upload folders. Both
  // matter — without the prefix check this endpoint would happily return
  // the text of ANY object in the bucket, straight past document ACLs.
  if (body.action === "analyze") {
    if (!principal.isController) {
      return bad("Only Admin or Doc Control can manage output templates.", 403);
    }
    const fileKey = String(body.fileKey ?? "").trim();
    const kind = body.kind === "xlsx" ? "xlsx" : "docx";
    if (!fileKey) return bad("fileKey is required");
    const allowedPrefixes = [
      `orgs/${orgId}/output-templates/`,
      `orgs/${orgId}/output-examples/`,
      `orgs/${orgId}/output-data/`,
    ];
    if (!allowedPrefixes.some((p) => fileKey.startsWith(p)) || fileKey.includes("..")) {
      return bad("That file isn't an output-template upload.", 403);
    }
    let text = "";
    try {
      const bytes = await fetchBytes(fileKey);
      text = kind === "xlsx" ? extractXlsxText(bytes) : extractDocxText(bytes);
    } catch (e) {
      return bad(`Couldn't read that file: ${(e as Error).message}`, 502);
    }
    const found = findPlaceholders(text);
    return NextResponse.json({
      placeholders: proposePlaceholders(found.fields),
      loops: found.loops,
      // A preview so people can see the system really read their file.
      preview: text.slice(0, 4000),
      hasTags: found.fields.length > 0 || found.loops.length > 0,
    });
  }

  if (!principal.isController) {
    return bad("Only Admin or Doc Control can manage output templates.", 403);
  }

  // ── Create / update a template definition ──────────────────────────────
  const id = String(body.id ?? "").trim();
  const fields: Record<string, unknown> = {
    org_id: orgId,
    name: String(body.name ?? "").trim() || "Untitled template",
    description: String(body.description ?? "").trim() || null,
    kind: body.kind === "xlsx" ? "xlsx" : "docx",
    template_file_key: body.templateFileKey ? String(body.templateFileKey) : null,
    template_file_name: body.templateFileName ? String(body.templateFileName) : null,
    example_files: Array.isArray(body.exampleFiles) ? body.exampleFiles : [],
    example_text: body.exampleText ? String(body.exampleText).slice(0, 20000) : null,
    placeholders: Array.isArray(body.placeholders) ? body.placeholders : [],
    instructions: String(body.instructions ?? "").trim() || null,
    mode: ["per_row", "summary", "both"].includes(String(body.mode)) ? String(body.mode) : "per_row",
    column_map: body.columnMap && typeof body.columnMap === "object" ? body.columnMap : {},
    filename_pattern: String(body.filenamePattern ?? "").trim() || null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = id
    ? await supabaseAdmin.from("output_templates").update(fields).eq("id", id).eq("org_id", orgId).select().maybeSingle()
    : await supabaseAdmin.from("output_templates").insert({
        ...fields,
        created_by: user.id,
        created_by_name: principal.uid === user.id ? undefined : undefined,
      }).select().maybeSingle();
  if (error) {
    return bad(
      missingTable(error.message, error.code)
        ? "Output templates need migration 20260923 — run it in Supabase first."
        : `Couldn't save the template: ${error.message}`,
      missingTable(error.message, error.code) ? 424 : 500,
    );
  }
  return NextResponse.json({ template: data });
}

export async function DELETE(req: NextRequest) {
  let body: { orgId?: string; id?: string };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const id = String(body.id ?? "").trim();
  if (!orgId || !id) return bad("orgId and id are required");
  const user = await authUser(req);
  if (!user) return bad("Unauthorized", 401);
  const principal = await loadPrincipal(orgId, user.id);
  if (!principal?.isController) {
    return bad("Only Admin or Doc Control can manage output templates.", 403);
  }
  const { error } = await supabaseAdmin
    .from("output_templates").delete().eq("id", id).eq("org_id", orgId);
  if (error) return bad(`Couldn't delete: ${error.message}`, 500);
  return NextResponse.json({ ok: true });
}
