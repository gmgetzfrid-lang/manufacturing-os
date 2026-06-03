// lib/evidencePack.ts
//
// One-click compliance evidence pack. Assembles a document's full
// chain-of-custody — revision lineage (with the engineering sign-off chain,
// MOC refs, file hashes), every hold (with durations), and the raw audit
// trail — into a clean, print-to-PDF report. This is the "your exit story is
// one click" promise made concrete for auditors (ISO-9001 / PSM evidence).

import { supabase } from "@/lib/supabase";

interface EvidenceData {
  doc: Record<string, unknown> | null;
  versions: Array<Record<string, unknown>>;
  holds: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
}

export async function gatherEvidence(documentId: string, orgId?: string): Promise<EvidenceData> {
  const docQ = supabase.from("documents").select("*").eq("id", documentId).maybeSingle();
  let versionsQ = supabase.from("document_versions").select("*").eq("record_id", documentId).order("created_at", { ascending: true });
  if (orgId) versionsQ = versionsQ.eq("org_id", orgId);
  const holdsQ = supabase.from("document_holds").select("*").eq("document_id", documentId).order("opened_at", { ascending: true });
  const auditQ = supabase.from("audit_logs").select("*").eq("resource_type", "document").eq("resource_id", documentId).order("created_at", { ascending: true }).limit(1000);

  const [doc, versions, holds, audit] = await Promise.all([docQ, versionsQ, holdsQ, auditQ]);
  return {
    doc: (doc.data as Record<string, unknown>) ?? null,
    versions: (versions.data as Array<Record<string, unknown>>) ?? [],
    holds: (holds.data as Array<Record<string, unknown>>) ?? [],
    audit: (audit.data as Array<Record<string, unknown>>) ?? [],
  };
}

const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const date = (v: unknown): string => {
  if (!v) return "—";
  try { return new Date(String(v)).toLocaleString(); } catch { return esc(v); }
};
const dur = (a: unknown, b: unknown): string => {
  if (!a || !b) return "—";
  const ms = new Date(String(b)).getTime() - new Date(String(a)).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
};

export function renderEvidenceHtml(data: EvidenceData): string {
  const d = data.doc ?? {};
  const number = esc(d.document_number || d.title || d.name || "Document");
  const rows = (arr: string[]) => arr.join("");

  const versionRows = data.versions.map((v) => `
    <tr>
      <td><b>${esc(v.revision_label)}</b></td>
      <td>${esc(v.issue_type || "—")}</td>
      <td>${esc(v.change_type || "—")}</td>
      <td>${date(v.released_at || v.created_at)}</td>
      <td>${esc(v.drawn_by_name || "—")}</td>
      <td>${esc(v.checked_by_name || "—")}</td>
      <td>${esc(v.approved_by_name || "—")}</td>
      <td>${esc(v.moc_reference || "—")}</td>
      <td class="mono">${esc(v.file_hash ? String(v.file_hash).slice(0, 16) + "…" : "—")}</td>
    </tr>
    <tr class="narr"><td colspan="9"><span class="lbl">Change narrative:</span> ${esc(v.change_log || "—")}${v.superseded_at ? ` <span class="sup">· superseded ${date(v.superseded_at)}</span>` : ""}</td></tr>
  `);

  const holdRows = data.holds.map((h) => `
    <tr>
      <td><b>${esc(h.reason)}</b></td>
      <td>${esc(h.notes || "—")}</td>
      <td>${date(h.opened_at)} <span class="muted">by ${esc(h.opened_by_name || "—")}</span></td>
      <td>${h.released_at ? `${date(h.released_at)} <span class="muted">by ${esc(h.released_by_name || "—")}</span>` : '<span class="open">OPEN</span>'}</td>
      <td>${dur(h.opened_at, h.released_at)}</td>
    </tr>`);

  const auditRows = data.audit.map((a) => `
    <tr>
      <td>${date(a.created_at)}</td>
      <td><b>${esc(a.action)}</b></td>
      <td>${esc(a.user_email || a.user_id || "—")}${a.user_role ? ` <span class="muted">(${esc(a.user_role)})</span>` : ""}</td>
      <td class="mono small">${esc(a.details ? JSON.stringify(a.details) : "")}</td>
    </tr>`);

  return `<!doctype html><html><head><meta charset="utf-8"><title>Evidence Pack — ${number}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #0f172a; margin: 0; padding: 32px; font-size: 12px; }
  h1 { font-size: 20px; margin: 0 0 2px; } h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #475569; margin: 28px 0 8px; border-bottom: 2px solid #e2e8f0; padding-bottom: 4px; }
  .sub { color: #64748b; margin-bottom: 4px; } .meta { display: flex; gap: 18px; flex-wrap: wrap; color: #334155; margin-top: 8px; }
  .meta b { color: #0f172a; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; } th, td { text-align: left; padding: 5px 7px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  th { background: #f8fafc; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; }
  .mono { font-family: ui-monospace, Menlo, monospace; } .small { font-size: 10px; color: #64748b; word-break: break-all; }
  .narr td { background: #fafafa; color: #334155; font-size: 11px; border-bottom: 2px solid #e2e8f0; } .lbl { color: #64748b; font-weight: 700; }
  .muted { color: #94a3b8; } .open { color: #b91c1c; font-weight: 700; } .sup { color: #b45309; } .empty { color: #94a3b8; font-style: italic; padding: 8px 0; }
  .toolbar { position: sticky; top: 0; background: #fff; padding-bottom: 10px; } .btn { background: #ea580c; color: #fff; border: 0; padding: 8px 14px; border-radius: 8px; font-weight: 700; cursor: pointer; }
  .footer { margin-top: 28px; color: #94a3b8; font-size: 10px; border-top: 1px solid #e2e8f0; padding-top: 8px; }
  @media print { .toolbar { display: none; } body { padding: 0; } }
</style></head><body>
  <div class="toolbar"><button class="btn" onclick="window.print()">Print / Save as PDF</button></div>
  <h1>Compliance Evidence Pack</h1>
  <div class="sub">${number}${d.title && d.title !== d.document_number ? ` — ${esc(d.title)}` : ""}</div>
  <div class="meta">
    <span><b>Current rev:</b> ${esc(d.rev || "—")}</span>
    <span><b>Status:</b> ${esc(d.status || "—")}</span>
    <span><b>Created:</b> ${date(d.created_at)}</span>
    <span><b>By:</b> ${esc(d.created_by_name || "—")}</span>
  </div>

  <h2>Revision lineage (${data.versions.length})</h2>
  ${data.versions.length === 0 ? '<div class="empty">No versions recorded.</div>' : `<table>
    <thead><tr><th>Rev</th><th>Issue</th><th>Change</th><th>Released</th><th>Drawn</th><th>Checked</th><th>Approved</th><th>MOC</th><th>SHA-256</th></tr></thead>
    <tbody>${rows(versionRows)}</tbody></table>`}

  <h2>Holds (${data.holds.length})</h2>
  ${data.holds.length === 0 ? '<div class="empty">No holds recorded.</div>' : `<table>
    <thead><tr><th>Reason</th><th>Notes</th><th>Opened</th><th>Released</th><th>Duration</th></tr></thead>
    <tbody>${rows(holdRows)}</tbody></table>`}

  <h2>Audit trail (${data.audit.length})</h2>
  ${data.audit.length === 0 ? '<div class="empty">No audit entries.</div>' : `<table>
    <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Details</th></tr></thead>
    <tbody>${rows(auditRows)}</tbody></table>`}

  <div class="footer">Generated ${new Date().toLocaleString()} · ManufacturingOS · This pack is assembled from the immutable audit trail and revision records for ${number}.</div>
</body></html>`;
}

/** Gather + open the evidence pack in a new window for print/save-as-PDF. */
export async function openEvidencePack(documentId: string, orgId?: string): Promise<void> {
  const data = await gatherEvidence(documentId, orgId);
  openPrintWindow(renderEvidenceHtml(data));
}

// ─── Project-level evidence pack ───────────────────────────────────────────

interface ProjectEvidence {
  project: Record<string, unknown> | null;
  members: Array<Record<string, unknown>>;
  milestones: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
}

export async function gatherProjectEvidence(projectId: string): Promise<ProjectEvidence> {
  const [project, members, milestones, audit] = await Promise.all([
    supabase.from("projects").select("*").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("*").eq("project_id", projectId).order("joined_at", { ascending: true }),
    supabase.from("milestones").select("*").eq("project_id", projectId).order("planned_at", { ascending: true }).limit(2000),
    supabase.from("audit_logs").select("*").eq("resource_type", "project").eq("resource_id", projectId).order("created_at", { ascending: true }).limit(1000),
  ]);
  return {
    project: (project.data as Record<string, unknown>) ?? null,
    members: (members.data as Array<Record<string, unknown>>) ?? [],
    milestones: (milestones.data as Array<Record<string, unknown>>) ?? [],
    audit: (audit.data as Array<Record<string, unknown>>) ?? [],
  };
}

export function renderProjectEvidenceHtml(data: ProjectEvidence): string {
  const p = data.project ?? {};
  const name = esc(p.name || "Project");
  const join = (a: string[]) => a.join("");

  const memberRows = data.members.map((m) => `
    <tr><td><b>${esc(m.user_name || m.user_email || m.user_id)}</b></td><td>${esc(m.role)}</td><td>${esc(m.responsibility || "—")}</td><td>${date(m.joined_at)}</td></tr>`);

  const msRows = data.milestones.map((m) => {
    const deps = Array.isArray(m.depends_on) ? (m.depends_on as unknown[]).length : 0;
    return `<tr>
      <td style="padding-left:${(Number(m.outline_level || 1) - 1) * 14 + 7}px">${m.is_summary ? "<b>" : ""}${esc(m.name)}${m.is_summary ? "</b>" : ""}</td>
      <td>${date(m.planned_start_at || m.planned_at)}</td>
      <td>${date(m.planned_at)}</td>
      <td>${esc(m.status || "—")}</td>
      <td>${esc(m.responsible_user_name || m.responsible_party || "—")}</td>
      <td>${deps > 0 ? `${deps} pred.` : "—"}</td>
    </tr>`;
  });

  const auditRows = data.audit.map((a) => `
    <tr><td>${date(a.created_at)}</td><td><b>${esc(a.action)}</b></td><td>${esc(a.user_email || a.user_id || "—")}</td><td class="mono small">${esc(a.details ? JSON.stringify(a.details) : "")}</td></tr>`);

  return `<!doctype html><html><head><meta charset="utf-8"><title>Project Evidence Pack — ${name}</title>
<style>
  * { box-sizing: border-box; } body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #0f172a; margin: 0; padding: 32px; font-size: 12px; }
  h1 { font-size: 20px; margin: 0 0 2px; } h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #475569; margin: 28px 0 8px; border-bottom: 2px solid #e2e8f0; padding-bottom: 4px; }
  .sub { color: #64748b; } .meta { display: flex; gap: 18px; flex-wrap: wrap; color: #334155; margin-top: 8px; } .meta b { color: #0f172a; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; } th, td { text-align: left; padding: 5px 7px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  th { background: #f8fafc; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; }
  .mono { font-family: ui-monospace, Menlo, monospace; } .small { font-size: 10px; color: #64748b; word-break: break-all; } .empty { color: #94a3b8; font-style: italic; padding: 8px 0; }
  .toolbar { position: sticky; top: 0; background: #fff; padding-bottom: 10px; } .btn { background: #ea580c; color: #fff; border: 0; padding: 8px 14px; border-radius: 8px; font-weight: 700; cursor: pointer; }
  .footer { margin-top: 28px; color: #94a3b8; font-size: 10px; border-top: 1px solid #e2e8f0; padding-top: 8px; }
  @media print { .toolbar { display: none; } body { padding: 0; } }
</style></head><body>
  <div class="toolbar"><button class="btn" onclick="window.print()">Print / Save as PDF</button></div>
  <h1>Project Evidence Pack</h1>
  <div class="sub">${name}</div>
  <div class="meta">
    <span><b>Status:</b> ${esc(p.status || "—")}</span>
    <span><b>Owner:</b> ${esc(p.owner_user_name || "—")}</span>
    <span><b>Started:</b> ${date(p.started_at)}</span>
    <span><b>Target:</b> ${date(p.target_completion_date)}</span>
  </div>

  <h2>Team & responsibilities (${data.members.length})</h2>
  ${data.members.length === 0 ? '<div class="empty">No members.</div>' : `<table><thead><tr><th>Member</th><th>Role</th><th>Responsibility</th><th>Joined</th></tr></thead><tbody>${join(memberRows)}</tbody></table>`}

  <h2>Schedule (${data.milestones.length})</h2>
  ${data.milestones.length === 0 ? '<div class="empty">No milestones.</div>' : `<table><thead><tr><th>Task</th><th>Start</th><th>Finish</th><th>Status</th><th>Responsible</th><th>Deps</th></tr></thead><tbody>${join(msRows)}</tbody></table>`}

  <h2>Audit trail (${data.audit.length})</h2>
  ${data.audit.length === 0 ? '<div class="empty">No audit entries.</div>' : `<table><thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Details</th></tr></thead><tbody>${join(auditRows)}</tbody></table>`}

  <div class="footer">Generated ${new Date().toLocaleString()} · ManufacturingOS · Assembled from the project record, team, schedule, and immutable audit trail.</div>
</body></html>`;
}

export async function openProjectEvidencePack(projectId: string): Promise<void> {
  const data = await gatherProjectEvidence(projectId);
  openPrintWindow(renderProjectEvidenceHtml(data));
}

export function openPrintWindow(html: string): void {
  const w = window.open("", "_blank");
  if (!w) throw new Error("Pop-up blocked — allow pop-ups to open the evidence pack.");
  w.document.open();
  w.document.write(html);
  w.document.close();
}
