export interface IntakeState {
  version: string;
  settings: { root: string; references: string[]; model: string; author: string; parallel: number; paused: boolean; key: string | null };
  models: { id: string; label: string }[];
  root_ok: boolean;
  waiting_in_drop: number;
  counts: { by_status?: Record<string, number>; documents?: number; pages_filed?: number; cost?: number; new_folders?: number };
  running: number[];
  registry: string;
  references_ok: { path: string; ok: boolean }[];
  pdf_engine: boolean;
  pdf_engine_error: string;
  ocr: boolean;
  index_failed: string[];
  notice: string;
  folders: { name: string; about: string }[];
}

export interface Scan {
  id: number;
  file_name: string;
  original_path: string;
  pages: number;
  status: "queued" | "reading" | "analyzing" | "filing" | "filed" | "review" | "failed" | "duplicate" | "set_aside";
  stage: string;
  equipment: string;
  equipment_rel: string;
  new_folder: boolean;
  problems: string[];
  cost: number;
  added_at: number;
  done_at: number;
  error: string;
  documents: number;
}

export interface FiledDoc {
  id: number;
  scan_id: number;
  equipment: string;
  equipment_rel: string;
  folder: string;
  file_rel: string;
  title: string;
  date: string;
  pages: number;
  first_page: number;
  last_page: number;
  as_other: string;
  drawing_number: string;
  revision: string;
  summary: string;
  note: string;
  filed_at: number;
}

export interface DocCall {
  first_page: number;
  last_page: number;
  continues_previous_part: boolean;
  folder: string;
  title: string;
  date: string;
  date_basis: string;
  written_for_number: string;
  written_for_tag: string;
  relation: string;
  drawing_number: string;
  revision: string;
  summary: string;
  drop_pages: number[];
  confidence: string;
  verdict: string;
  doubts: string;
}

export interface Filing {
  equipment: { number: string; tag: string; description: string; existing_folder: string; confidence: string; evidence: string; matches_file_name: string };
  documents: DocCall[];
  notes: string;
}

export interface EquipEntry {
  no: { text: string };
  oos: boolean;
  rel: string;
  folder_name: string;
  subfolders: string[];
  reference: boolean;
}

export interface ScanDetail {
  scan: Scan;
  filing: Filing | null;
  documents: FiledDoc[];
  pages: { n: number; blank: boolean; sheet: string }[];
  file_equipment: string | null;
  candidates: EquipEntry[];
  flagged: number[];
}

export const STATUS: Record<Scan["status"], { label: string; color: string }> = {
  queued: { label: "Waiting", color: "var(--color-text-faint)" },
  reading: { label: "Reading pages", color: "var(--color-info)" },
  analyzing: { label: "Sorting", color: "var(--color-info)" },
  filing: { label: "Filing", color: "var(--color-info)" },
  filed: { label: "Filed", color: "var(--color-ok)" },
  review: { label: "Needs review", color: "var(--color-warn)" },
  failed: { label: "Failed", color: "var(--color-bad)" },
  duplicate: { label: "Duplicate", color: "var(--color-text-muted)" },
  set_aside: { label: "Set aside", color: "var(--color-text-muted)" },
};

export function money(x?: number): string {
  return `$${(x ?? 0).toFixed(2)}`;
}

export function ago(secs: number): string {
  if (!secs) return "";
  const d = Date.now() / 1000 - secs;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(secs * 1000).toLocaleDateString();
}

/** Mirrors spec::document_file_name closely enough for a preview. */
export function previewName(equip: string, d: DocCall): string {
  const clean = (s: string) => s.replace(/[<>"|?*]/g, " ").replace(/[:/\\]/g, "-").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  let title = clean(d.title);
  if (equip && title.startsWith(equip)) title = title.slice(equip.length).replace(/^[\s\-_,]+/, "");
  let name = `${equip} ${title || "Document"}`;
  if (d.relation === "former_identity" || d.relation === "other_equipment_history") {
    const other = [d.written_for_number.trim() !== equip ? d.written_for_number.trim() : "", d.written_for_tag.trim().toUpperCase()].filter(Boolean).join(" ");
    if (other) name += ` (as ${clean(other)})`;
  }
  name += ` ${/^\d{4}(-\d{2}(-\d{2})?)?$/.test(d.date.trim()) ? d.date.trim() : "Undated"}`;
  return `${name}.pdf`;
}
