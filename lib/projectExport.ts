// lib/projectExport.ts
//
// Export a single project or every project in the org to a CSV file.
// Excel opens CSV natively, so this avoids a heavy xlsx dependency.
// Two sheets-as-files concept by default the export bundles two
// pages into one .csv with a separator row, which Excel will read
// fine. For complex multi-sheet needs we'd switch to xlsx, but the
// goal here is "send it to someone in 10 seconds."
//
// PM-10: every cell goes through lib/csvSafe (a formula-leading value is
// written as inert text) — the org export's per-project header line too.
// PERF-2: the org-wide export reads its rows in a handful of bulk queries
// per batch of projects — never one serial round trip per project — reports
// progress, and can be cancelled. Every read pages to exhaustion under
// PostgREST's max-rows cap, so a busy batch is never cut to its first
// thousand rows.

import { supabase } from "@/lib/supabase";
import { userFacingReadError } from "@/lib/userFacingError";
import { csvLine } from "@/lib/csvSafe";

function csvRow(fields: unknown[]): string {
  return csvLine(fields);
}

interface ProjectExportRow {
  project: Record<string, unknown>;
  documents: Array<Record<string, unknown>>;
  checkouts: Array<Record<string, unknown>>;
}

/** Projects per bulk read (PERF-2 default: batches of 100). */
export const EXPORT_PROJECT_BATCH = 100;
/** Document ids per `.in()` read — keeps the request URL bounded. */
const EXPORT_DOC_BATCH = 200;
/** PostgREST returns at most this many rows per request (max-rows). Every
 *  export read pages in windows of this size, ordered so the windows are
 *  stable, until a short page (the lib/companies.ts gather's rule). */
export const EXPORT_PAGE_ROWS = 1000;

export interface ExportProgress {
  /** Projects whose rows have been read. */
  done: number;
  total: number;
}

export interface ExportOptions {
  onProgress?: (p: ExportProgress) => void;
  /** Aborting stops the export between batches; nothing is downloaded. */
  signal?: AbortSignal;
}

export class ExportCancelledError extends Error {
  constructor() { super("Export cancelled."); this.name = "ExportCancelledError"; }
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** A read the export depends on: its refusal is the export's failure, never
 *  an empty section in a file someone mails to an auditor. */
function rowsOf(label: string, res: { data: unknown; error: { message: string } | null }): Array<Record<string, unknown>> {
  if (res.error) throw new Error(`The export could not read ${label}: ${userFacingReadError(res.error, "projectExport")}`);
  return (res.data ?? []) as Array<Record<string, unknown>>;
}

type PageRead = (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/** Read to exhaustion, one EXPORT_PAGE_ROWS window at a time: a read that
 *  hits the row cap is followed by the next window, never taken as the
 *  whole set — a short read is how silent gaps reach an auditor. */
async function readAll(label: string, page: PageRead, signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += EXPORT_PAGE_ROWS) {
    if (signal?.aborted) throw new ExportCancelledError();
    const batch = rowsOf(label, await page(from, from + EXPORT_PAGE_ROWS - 1));
    rows.push(...batch);
    if (batch.length < EXPORT_PAGE_ROWS) return rows;
  }
}

/**
 * Pull every project's documents + checkouts in bulk: per batch of
 * EXPORT_PROJECT_BATCH projects, one checkout_sessions read and one
 * project_documents read (in parallel, each paged to exhaustion), then the
 * referenced documents in chunks. The round-trip count grows with
 * ceil(projects / 100) — plus one more page per 1000 rows a batch
 * carries — not with the project count. Used by both the single-project
 * and org exports.
 */
async function loadProjectBundles(
  projects: Array<Record<string, unknown>>,
  opts: ExportOptions = {},
): Promise<ProjectExportRow[]> {
  const total = projects.length;
  const out: ProjectExportRow[] = [];
  opts.onProgress?.({ done: 0, total });
  for (const batch of chunks(projects, EXPORT_PROJECT_BATCH)) {
    if (opts.signal?.aborted) throw new ExportCancelledError();
    const ids = batch.map((p) => String(p.id));
    const [checkouts, pdocs] = await Promise.all([
      readAll("checkouts", (f, t) => supabase.from("checkout_sessions").select("*").in("project_id", ids).order("id").range(f, t), opts.signal),
      readAll("project documents", (f, t) => supabase.from("project_documents").select("*").in("project_id", ids).order("id").range(f, t), opts.signal),
    ]);

    const docIds = Array.from(new Set([
      ...checkouts.map((c) => c.document_id as string).filter(Boolean),
      ...pdocs.map((p) => p.document_id as string).filter(Boolean),
    ]));
    const docById = new Map<string, Record<string, unknown>>();
    for (const part of chunks(docIds, EXPORT_DOC_BATCH)) {
      if (opts.signal?.aborted) throw new ExportCancelledError();
      const res = await supabase
        .from("documents").select("id, document_number, title, name, rev, status, library_id")
        .in("id", part);
      for (const d of rowsOf("documents", res)) docById.set(String(d.id), d);
    }

    for (const p of batch) {
      const pid = String(p.id);
      const mine = checkouts.filter((c) => String(c.project_id) === pid);
      const linked = pdocs.filter((d) => String(d.project_id) === pid);
      const ids1 = Array.from(new Set([
        ...mine.map((c) => c.document_id as string).filter(Boolean),
        ...linked.map((d) => d.document_id as string).filter(Boolean),
      ]));
      out.push({
        project: p,
        documents: ids1.map((id) => docById.get(id)).filter((d): d is Record<string, unknown> => !!d),
        checkouts: mine,
      });
    }
    opts.onProgress?.({ done: out.length, total });
  }
  return out;
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

/** The single-project CSV body (exported for tests). */
export async function buildProjectCsv(projectId: string, orgId: string): Promise<{ name: string; csv: string } | null> {
  const res = await supabase
    .from("projects").select("*")
    .eq("id", projectId).eq("org_id", orgId).maybeSingle();
  if (res.error) throw new Error(`The export could not read the project: ${userFacingReadError(res.error, "projectExport")}`);
  if (!res.data) return null;
  const [bundle] = await loadProjectBundles([res.data as Record<string, unknown>]);
  return { name: String(bundle.project.name ?? "project"), csv: bundleToCsv(bundle) };
}

export async function exportProjectToCsv(projectId: string, orgId: string): Promise<void> {
  const built = await buildProjectCsv(projectId, orgId);
  if (!built) throw new Error("Project not found");
  const safeName = built.name.replace(/[^a-z0-9-_ ]/gi, "_").trim() || "project";
  triggerCsvDownload(`${safeName}.csv`, built.csv);
}

/** The org-wide CSV body (exported for tests): one projects read, then the
 *  bulk bundle reads, then the sections in name order. */
export async function buildAllProjectsCsv(orgId: string, opts: ExportOptions = {}): Promise<string> {
  const projects = await readAll("projects", (f, t) => supabase
    .from("projects").select("*")
    .eq("org_id", orgId)
    .order("name").order("id")
    .range(f, t), opts.signal);
  if (projects.length === 0) throw new Error("No projects to export");
  const bundles = await loadProjectBundles(projects, opts);
  if (opts.signal?.aborted) throw new ExportCancelledError();
  const sections: string[] = [];
  for (const bundle of bundles) {
    // The section header is a cell like any other (PM-10): a name carrying
    // a line break or a comma must not start a new line or cell that a
    // spreadsheet evaluates. Line breaks fold to a space so the header stays
    // one line; csvLine quotes and neutralises the rest.
    const name = String(bundle.project.name ?? "").replace(/[\r\n]+/g, " ");
    sections.push(csvLine([`#### ${name} ####`]));
    sections.push(bundleToCsv(bundle));
    sections.push("");
  }
  return sections.join("\n");
}

export async function exportAllProjectsToCsv(orgId: string, opts: ExportOptions = {}): Promise<void> {
  const csv = await buildAllProjectsCsv(orgId, opts);
  triggerCsvDownload(`projects-${new Date().toISOString().slice(0,10)}.csv`, csv);
}
