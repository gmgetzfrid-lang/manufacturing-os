// lib/projectExport.ts
//
// Export a single project or every project in the org to a CSV file.
// Excel opens CSV natively, so this avoids a heavy xlsx dependency.
// Two sheets-as-files concept by default the export bundles two
// pages into one .csv with a separator row, which Excel will read
// fine. For complex multi-sheet needs we'd switch to xlsx, but the
// goal here is "send it to someone in 10 seconds."

import { supabase } from "@/lib/supabase";

/** Quote a CSV field. Doubles internal quotes and wraps in " if needed. */
function csvField(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(fields: unknown[]): string {
  return fields.map(csvField).join(",");
}

interface ProjectExportRow {
  project: Record<string, unknown>;
  documents: Array<Record<string, unknown>>;
  checkouts: Array<Record<string, unknown>>;
}

/**
 * Pull a project + its documents + active checkouts. Used by both
 * single-project and bulk-org exports.
 */
async function loadProjectBundle(projectId: string, orgId: string): Promise<ProjectExportRow | null> {
  const { data: project } = await supabase
    .from("projects").select("*")
    .eq("id", projectId).eq("org_id", orgId).maybeSingle();
  if (!project) return null;

  const [{ data: checkouts }, { data: pdocs }] = await Promise.all([
    supabase.from("checkout_sessions").select("*").eq("project_id", projectId),
    supabase.from("project_documents").select("*").eq("project_id", projectId),
  ]);

  const docIds = Array.from(new Set([
    ...((checkouts ?? []).map((c) => (c as Record<string, unknown>).document_id as string).filter(Boolean)),
    ...((pdocs ?? []).map((p) => (p as Record<string, unknown>).document_id as string).filter(Boolean)),
  ]));
  let documents: Array<Record<string, unknown>> = [];
  if (docIds.length > 0) {
    const { data } = await supabase
      .from("documents").select("id, document_number, title, name, rev, status, library_id")
      .in("id", docIds);
    documents = (data ?? []) as Array<Record<string, unknown>>;
  }

  return {
    project: project as Record<string, unknown>,
    documents,
    checkouts: (checkouts ?? []) as Array<Record<string, unknown>>,
  };
}

/** Build the CSV body for one project bundle. */
function bundleToCsv(b: ProjectExportRow, indent = ""): string {
  const out: string[] = [];
  const p = b.project;
  out.push(`${indent}PROJECT`);
  out.push(`${indent}${csvRow(["Field", "Value"])}`);
  out.push(`${indent}${csvRow(["Name", p.name])}`);
  out.push(`${indent}${csvRow(["Status", p.status])}`);
  out.push(`${indent}${csvRow(["Visibility", p.visibility])}`);
  out.push(`${indent}${csvRow(["Owner", p.owner_user_name || p.owner_user_id])}`);
  out.push(`${indent}${csvRow(["Description", p.description ?? ""])}`);
  out.push(`${indent}${csvRow(["MOC ref", p.moc_reference ?? ""])}`);
  out.push(`${indent}${csvRow(["Target completion", p.target_completion_date ?? ""])}`);
  out.push(`${indent}${csvRow(["Started", p.started_at ?? ""])}`);
  out.push(`${indent}${csvRow(["Last activity", p.last_activity_at ?? ""])}`);
  out.push("");
  out.push(`${indent}DOCUMENTS (${b.documents.length})`);
  out.push(`${indent}${csvRow(["Doc Number", "Title", "Rev", "Status", "Library ID"])}`);
  for (const d of b.documents) {
    out.push(`${indent}${csvRow([d.document_number, d.title || d.name, d.rev, d.status, d.library_id])}`);
  }
  out.push("");
  out.push(`${indent}CHECKOUTS (${b.checkouts.length})`);
  out.push(`${indent}${csvRow(["User", "Mode", "Purpose", "Started", "Status", "Doc ID"])}`);
  for (const c of b.checkouts) {
    out.push(`${indent}${csvRow([c.user_name, c.mode, c.purpose ?? "", c.started_at, c.status, c.document_id])}`);
  }
  return out.join("\n");
}

function triggerCsvDownload(filename: string, content: string) {
  // Prepend BOM so Excel reads UTF-8 correctly when the user opens it
  const blob = new Blob(["﻿", content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportProjectToCsv(projectId: string, orgId: string): Promise<void> {
  const bundle = await loadProjectBundle(projectId, orgId);
  if (!bundle) throw new Error("Project not found");
  const safeName = String(bundle.project.name ?? "project").replace(/[^a-z0-9-_ ]/gi, "_").trim() || "project";
  triggerCsvDownload(`${safeName}.csv`, bundleToCsv(bundle));
}

export async function exportAllProjectsToCsv(orgId: string): Promise<void> {
  const { data: projects } = await supabase
    .from("projects").select("id, name")
    .eq("org_id", orgId)
    .order("name");
  if (!projects || projects.length === 0) throw new Error("No projects to export");
  const sections: string[] = [];
  for (const p of projects as Array<{ id: string; name: string }>) {
    const bundle = await loadProjectBundle(p.id, orgId);
    if (!bundle) continue;
    sections.push(`#### ${p.name} ####`);
    sections.push(bundleToCsv(bundle));
    sections.push("");
  }
  triggerCsvDownload(`projects-${new Date().toISOString().slice(0,10)}.csv`, sections.join("\n"));
}
