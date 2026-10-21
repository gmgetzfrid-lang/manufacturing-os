// lib/knowledgeCatalog.ts — what the library HOLDS, as data the assistant
// can reason over.
//
// Retrieval finds passages; it can't know that the library has a deviation
// request form, a hydrotest checklist, or a pipe-class table for 1S4 unless
// a question happens to match their text. So every document gets a PROFILE
// — what kind of document it is, its designation and purpose, and for the
// kinds that need it, structure: a form's fields, a piping spec's classes.
// The ask pipeline carries the catalog as context, so "is there a checklist
// for this?" is the system's job, not the user's.
//
// Storage needs no migration: profiles and pipe classes are rows in
// knowledge_page_entities (kind is free text) with the JSON in `raw`.
//   kind "profile"    — one per document, page 1, tag = document type
//   kind "pipe_class" — one per class per page, tag = the class code
//
// Pure: parsing, validation, prompt blocks, matching. Server work lives in
// lib/knowledgeCatalogServer.ts.

export const DOC_TYPES = [
  "standard", "pipe_spec", "form", "checklist", "std_drawing", "pid", "procedure", "datasheet", "other",
] as const;
export type DocType = typeof DOC_TYPES[number];

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  standard: "Engineering standard",
  pipe_spec: "Piping specification",
  form: "Form",
  checklist: "Checklist",
  std_drawing: "Standard drawing",
  pid: "P&ID / drawing",
  procedure: "Procedure",
  datasheet: "Data sheet",
  other: "Other",
};

/** What a form is FOR — how a goal in conversation finds its form. */
export const FORM_PURPOSES = [
  "deviation", "ncr", "moc", "tq", "inspection", "test", "permit", "other",
] as const;
export type FormPurpose = typeof FORM_PURPOSES[number];

export const FORM_PURPOSE_LABEL: Record<FormPurpose, string> = {
  deviation: "Deviation / waiver request",
  ncr: "Nonconformance report",
  moc: "Management of change",
  tq: "Technical query",
  inspection: "Inspection record",
  test: "Test record",
  permit: "Permit",
  other: "Form",
};

export type FieldKind = "text" | "long" | "date" | "check" | "choice" | "signature";

export interface FormField {
  /** The PDF field name for fillable forms; a stable slug otherwise. */
  name: string;
  /** What the form calls it, as printed. */
  label: string;
  kind: FieldKind;
  options?: string[];
}

export interface DocProfile {
  v: 1;
  type: DocType;
  designation: string | null;
  title: string;
  purpose: string;
  covers: string[];
  references: string[];
  form?: {
    purpose: FormPurpose;
    /** True when the PDF itself has fillable fields (filled in place). */
    fillable: boolean;
    fields: FormField[];
  };
  /** What a checklist is used for ("hydrotest", "flange joint assembly"). */
  checklistFor?: string;
  /** Pipe-class extraction progress for piping specs. */
  pipeSpec?: { pagesDone: number; pageCount: number; classes: number; done: boolean };
  profiledAt: string;
}

export interface PipeClassRow {
  component: string;
  size?: string;
  spec: string;
  details?: string;
  notes?: string;
}

export interface PipeClassRecord {
  code: string;
  service?: string;
  rating?: string;
  material?: string;
  corrosionAllowance?: string;
  rows: PipeClassRow[];
  notes?: string[];
}

const str = (v: unknown, max = 400): string =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
const strList = (v: unknown, max: number, each = 120): string[] =>
  Array.isArray(v) ? v.map((x) => str(x, each)).filter(Boolean).slice(0, max) : [];

/** Pull a JSON object out of model output (fenced, prefixed, or bare). */
export function parseModelJson(text: string): Record<string, unknown> | null {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(t.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export const slugField = (label: string, i: number): string =>
  (label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || `field_${i + 1}`);

/** Validate the profiler model's JSON into a DocProfile. Anything the model
 *  got wrong degrades to safe defaults rather than failing the document.
 *  `pdfFields` (from the PDF's own AcroForm) win over model-listed fields:
 *  those names are what fills the file. */
export function normalizeProfile(
  raw: Record<string, unknown> | null,
  ctx: { name: string; pdfFields?: Array<{ name: string; kind: FieldKind; options?: string[] }>; now?: string },
): DocProfile {
  const r = raw ?? {};
  const type = (DOC_TYPES as readonly string[]).includes(String(r.type)) ? r.type as DocType : "other";
  const profile: DocProfile = {
    v: 1,
    type,
    designation: str(r.designation, 60) || null,
    title: str(r.title, 160) || ctx.name.replace(/\.pdf$/i, ""),
    purpose: str(r.purpose, 300),
    covers: strList(r.covers, 10, 80),
    references: strList(r.references, 15, 40),
    profiledAt: ctx.now ?? new Date().toISOString(),
  };
  const pdfFields = ctx.pdfFields ?? [];
  if (type === "form" || type === "checklist" || pdfFields.length > 0) {
    const f = (r.form ?? {}) as Record<string, unknown>;
    const purpose = (FORM_PURPOSES as readonly string[]).includes(String(f.purpose)) ? f.purpose as FormPurpose : "other";
    const modelFields = Array.isArray(f.fields) ? f.fields as Array<Record<string, unknown>> : [];
    const kindOf = (k: unknown): FieldKind =>
      (["text", "long", "date", "check", "choice", "signature"] as const).includes(k as FieldKind) ? k as FieldKind : "text";
    let fields: FormField[];
    if (pdfFields.length > 0) {
      // The PDF's field names are authoritative; the model only supplies a
      // readable label (and a better kind for long text) per name.
      const labelByName = new Map(modelFields.map((m) => [str(m.name, 120), m]));
      fields = pdfFields.slice(0, 120).map((pf) => {
        const m = labelByName.get(pf.name);
        const modelKind = m ? kindOf(m.kind) : null;
        return {
          name: pf.name,
          label: str(m?.label, 120) || pf.name.replace(/[_.]+/g, " ").trim(),
          kind: pf.kind === "text" && modelKind && ["long", "date", "signature"].includes(modelKind) ? modelKind : pf.kind,
          ...(pf.options && pf.options.length > 0 ? { options: pf.options.slice(0, 30) } : {}),
        };
      });
    } else {
      const seen = new Set<string>();
      fields = modelFields.slice(0, 80).map((m, i) => {
        const label = str(m.label, 120) || str(m.name, 120) || `Field ${i + 1}`;
        let name = slugField(str(m.name, 60) || label, i);
        while (seen.has(name)) name = `${name}_${i}`;
        seen.add(name);
        const options = strList(m.options, 30, 60);
        return { name, label, kind: kindOf(m.kind), ...(options.length > 0 ? { options } : {}) };
      });
    }
    profile.form = { purpose, fillable: pdfFields.length > 0, fields };
    if (type === "checklist") profile.checklistFor = str(r.checklistFor, 120) || profile.purpose.slice(0, 120);
  }
  return profile;
}

export function parseProfile(raw: string | null | undefined): DocProfile | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as DocProfile;
    return v && v.v === 1 && (DOC_TYPES as readonly string[]).includes(v.type) ? v : null;
  } catch {
    return null;
  }
}

/** Validate one page's pipe-class extraction. */
export function normalizePipeClasses(raw: Record<string, unknown> | null, opts: { allowEmptyRows?: boolean } = {}): PipeClassRecord[] {
  const list = Array.isArray(raw?.classes) ? raw!.classes as Array<Record<string, unknown>> : [];
  const out: PipeClassRecord[] = [];
  for (const c of list.slice(0, 12)) {
    const code = str(c.code, 30).toUpperCase();
    if (!code || code.length < 2) continue;
    const rows = (Array.isArray(c.rows) ? c.rows as Array<Record<string, unknown>> : [])
      .map((r) => ({
        component: str(r.component, 60),
        ...(str(r.size, 40) ? { size: str(r.size, 40) } : {}),
        spec: str(r.spec, 160),
        ...(str(r.details, 160) ? { details: str(r.details, 160) } : {}),
        ...(str(r.notes, 200) ? { notes: str(r.notes, 200) } : {}),
      }))
      .filter((r) => r.component && r.spec)
      .slice(0, 80);
    // A class read from its opening page may have no component rows yet —
    // its rating, service and material still identify it.
    if (rows.length === 0 && !(opts.allowEmptyRows && (str(c.rating, 40) || str(c.service, 160) || str(c.material, 80)))) continue;
    out.push({
      code,
      ...(str(c.service, 160) ? { service: str(c.service, 160) } : {}),
      ...(str(c.rating, 40) ? { rating: str(c.rating, 40) } : {}),
      ...(str(c.material, 80) ? { material: str(c.material, 80) } : {}),
      ...(str(c.corrosionAllowance, 30) ? { corrosionAllowance: str(c.corrosionAllowance, 30) } : {}),
      rows,
      ...(strList(c.notes, 12, 240).length > 0 ? { notes: strList(c.notes, 12, 240) } : {}),
    });
  }
  return out;
}

// ── The catalog as the assistant sees it ────────────────────────────────────

export interface CatalogEntry {
  documentId: string;
  libraryId: string;
  libraryName: string;
  name: string;
  fileKey: string | null;
  profile: DocProfile;
}

const ORDER: DocType[] = ["form", "checklist", "pipe_spec", "standard", "procedure", "std_drawing", "datasheet", "pid", "other"];

/** One line per document, grouped by type — forms and checklists first,
 *  because those are what a user can't find by asking a question. */
export function buildCatalogBlock(entries: CatalogEntry[], budget = 6000): string {
  if (entries.length === 0) return "";
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const type of ORDER) {
    const group = entries.filter((e) => e.profile.type === type);
    if (group.length === 0) continue;
    const head = `${DOC_TYPE_LABEL[type]}s (${group.length}):`;
    if (used + head.length > budget) { dropped += group.length; continue; }
    lines.push(head);
    used += head.length;
    for (const e of group) {
      const p = e.profile;
      const extra = p.checklistFor
        ? ` — for ${p.checklistFor}${p.form?.fillable ? ", fillable PDF" : ""}`
        : p.form
        ? ` — ${FORM_PURPOSE_LABEL[p.form.purpose]}${p.form.fillable ? ", fillable PDF" : ""}, ${p.form.fields.length} fields`
        : p.pipeSpec ? ` — ${p.pipeSpec.classes} pipe classes indexed`
        : p.purpose ? ` — ${p.purpose.slice(0, 110)}` : "";
      const line = `- "${e.name.replace(/\.pdf$/i, "")}"${p.designation && !e.name.includes(p.designation) ? ` (${p.designation})` : ""}: ${p.title}${extra}`;
      if (used + line.length > budget) { dropped += 1; continue; }
      lines.push(line);
      used += line.length;
    }
  }
  if (dropped > 0) lines.push(`(+${dropped} more documents not listed)`);
  return lines.join("\n");
}

/** Forms whose purpose matches a goal, best first. */
export function formsForGoal(entries: CatalogEntry[], goal: string): CatalogEntry[] {
  const g = goal.toLowerCase();
  const kw: Record<string, RegExp> = {
    deviation: /deviat|waiver|exception|variance/i,
    ncr: /non-?conform|ncr/i,
    moc: /management of change|\bmoc\b/i,
    tq: /technical query|\btq\b|\brfi\b/i,
    inspection: /inspect/i,
    test: /test|hydro|pneumatic/i,
    permit: /permit/i,
  };
  const re = kw[g];
  const score = (e: CatalogEntry): number => {
    const p = e.profile;
    if (!p.form) return 0;
    let s = p.form.purpose === g ? 10 : 0;
    if (re && (re.test(e.name) || re.test(p.title))) s += 5;
    if (p.form.fillable) s += 1;
    return s;
  };
  return entries.filter((e) => score(e) >= 5).sort((a, b) => score(b) - score(a));
}

/** Resolve a document name the model wrote ("Use this:") to a catalog
 *  entry: exact, then contained either way, case- and punctuation-blind. */
export function matchCatalogName(entries: CatalogEntry[], written: string): CatalogEntry | null {
  const sq = (s: string) => s.toLowerCase().replace(/\.pdf$/i, "").replace(/[^a-z0-9]/g, "");
  const w = sq(written);
  if (w.length < 4) return null;
  return entries.find((e) => sq(e.name) === w)
    ?? entries.find((e) => sq(e.profile.title) === w)
    ?? entries.find((e) => sq(e.name).includes(w) || w.includes(sq(e.name)))
    ?? entries.find((e) => sq(e.profile.title).includes(w) || (sq(e.profile.title).length >= 8 && w.includes(sq(e.profile.title))))
    ?? null;
}

// ── Pipe classes at ask time ────────────────────────────────────────────────

/** Which known pipe-class codes does this text mention? Whole-token,
 *  case-insensitive; short codes (≤2 chars) need a "class" word nearby. */
export function findClassMentions(text: string, codes: string[]): string[] {
  const hits: string[] = [];
  const upper = ` ${text.toUpperCase()} `;
  for (const code of codes) {
    const esc = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^A-Z0-9])${esc}([^A-Z0-9]|$)`);
    if (!re.test(upper)) continue;
    if (code.length <= 2 && !new RegExp(`CLASS\\s*${esc}\\b|${esc}\\s*CLASS`).test(upper)) continue;
    if (!hits.includes(code)) hits.push(code);
  }
  return hits.slice(0, 4);
}

/** Pipe-class records as trusted facts for the answer prompt. */
export function pipeClassFacts(
  records: Array<PipeClassRecord & { documentName: string; page: number }>,
): string {
  if (records.length === 0) return "";
  return records.map((r) => {
    const head = `PIPE CLASS ${r.code} — ${r.documentName} p.${r.page}` +
      [r.service && `service: ${r.service}`, r.rating && `rating: ${r.rating}`, r.material && `material: ${r.material}`,
        r.corrosionAllowance && `CA: ${r.corrosionAllowance}`].filter(Boolean).map((x) => `; ${x}`).join("");
    const rows = r.rows.map((x) => `  - ${x.component}${x.size ? ` [${x.size}]` : ""}: ${x.spec}${x.details ? ` (${x.details})` : ""}${x.notes ? ` — ${x.notes}` : ""}`);
    const notes = (r.notes ?? []).map((n) => `  note: ${n}`);
    return [head, ...rows, ...notes].join("\n");
  }).join("\n\n");
}
