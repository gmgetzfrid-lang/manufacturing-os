// lib/scheduleParsers.ts
//
// Parsers for the schedule-import path. Replaces the previous
// "paste CSV in a textarea" UX with real file support for the
// formats project managers actually export from their tools:
//
//   * MS Project XML       (.xml)   — File → Save As → XML
//   * Primavera P6 XML     (.xml)   — Export → XML
//   * Primavera P6 XER     (.xer)   — Export → XER (tab-delimited)
//   * MS Project CSV       (.csv)   — direct export from MS Project
//   * Generic CSV          (.csv)   — our own header convention
//
// All parsers normalize to ParsedMilestone[] so the importer stays
// dumb. Format detection sniffs both the extension and the first
// few bytes — the user shouldn't have to tell us what kind of file
// they just dropped.

export interface ParsedMilestone {
  name: string;
  /** Scheduled FINISH. */
  plannedAt: string;            // ISO
  /** Scheduled START — optional but populated by every modern source. */
  plannedStartAt?: string | null;
  weight?: number;
  description?: string | null;
  /** Stable id from the source file so re-imports upsert. */
  externalRef?: string | null;
  /** Optional progress hint pulled from the source. The importer
   *  doesn't auto-set status — but the UI can show "x of these
   *  arrive already complete" before committing. */
  percentComplete?: number;
  /** WBS code string from the source ("1.2.3"). Decorative. */
  wbs?: string | null;
  /** 1-based outline depth. */
  outlineLevel?: number | null;
  /** True when the row is a rollup parent / summary task. */
  isSummary?: boolean;
  /** externalRef of the PARENT row in the same import batch. The
   *  importer resolves this to a real DB id after the first pass. */
  parentExternalRef?: string | null;
}

export interface ParseResult {
  format: ScheduleFormat;
  rows: ParsedMilestone[];
  warnings: string[];
}

export type ScheduleFormat =
  | "msproject-xml"
  | "msproject-mpp"      // proprietary binary — detected but not parseable in-browser
  | "msproject-mpx"      // older text-based MS Project interchange
  | "p6-xml"
  | "p6-xer"
  | "msproject-csv"
  | "generic-csv"
  | "unknown";

// ─── Format detection ────────────────────────────────────────────
//
// Public API kept text-only for backward compat. The new
// detectFormatFromBytes path is preferred — it lets us sniff for
// binary signatures (.mpp) that pure-text detection can't see.

export function detectFormat(filename: string, text: string): ScheduleFormat {
  const lower = filename.toLowerCase();
  const head = text.slice(0, 4096).toLowerCase();

  // MPX is text — starts with "MPX,<version>" or similar header line.
  if (lower.endsWith(".mpx") || /^mpx[, ]/i.test(text.slice(0, 16))) return "msproject-mpx";

  if (lower.endsWith(".mpp")) return "msproject-mpp";

  if (lower.endsWith(".xer") || head.startsWith("ermhdr")) return "p6-xer";

  if (lower.endsWith(".xml")) {
    if (head.includes("apibusinessobjects") || head.includes("http://xmlns.oracle.com/primavera")) return "p6-xml";
    if (head.includes("<project") && (head.includes("schemas.microsoft.com/project") || head.includes("<savedate") || head.includes("<currencycode"))) return "msproject-xml";
    if (head.includes("<project")) return "msproject-xml";
    return "unknown";
  }

  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    if (/(^|,|\t)\s*"?task name"?\s*(,|\t|$)/i.test(head)) return "msproject-csv";
    if (/(^|,|\t)\s*"?name"?\s*(,|\t|$)/i.test(head) && /planned_at|start|finish/i.test(head)) return "generic-csv";
    return "generic-csv";
  }

  return "unknown";
}

/** Byte-aware variant. Use this when the caller has the raw file
 *  available — catches binary formats (MPP / OLE2 compound files)
 *  before we waste cycles trying to decode them as text. */
export function detectFormatFromBytes(filename: string, bytes: Uint8Array): ScheduleFormat {
  const lower = filename.toLowerCase();
  // MPP files are OLE2 Compound File Binary — magic bytes
  // D0 CF 11 E0 A1 B1 1A E1. MS Project shares this container with
  // legacy Office formats (.xls / .doc), but the .mpp extension
  // disambiguates.
  if (bytes.length >= 8) {
    const isCfb =
      bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0 &&
      bytes[4] === 0xA1 && bytes[5] === 0xB1 && bytes[6] === 0x1A && bytes[7] === 0xE1;
    if (isCfb && lower.endsWith(".mpp")) return "msproject-mpp";
    if (isCfb) return "msproject-mpp"; // even without .mpp ext, treat as MPP-class
  }
  // Fall through to text-based detection for everything else.
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096));
  return detectFormat(filename, text);
}

// ─── Dispatcher ─────────────────────────────────────────────────

export function parseScheduleFile(filename: string, text: string): ParseResult {
  const format = detectFormat(filename, text);
  return runParser(format, filename, text);
}

/** Byte-aware entry point. Preferred when the caller has the raw
 *  file — handles MPP detection before falling through to text. */
export function parseScheduleFileFromBytes(filename: string, bytes: Uint8Array): ParseResult {
  const format = detectFormatFromBytes(filename, bytes);
  if (format === "msproject-mpp") {
    return {
      format,
      rows: [],
      warnings: [
        `"${filename}" is a Microsoft Project binary file (.mpp). The MPP container is proprietary and cannot be read in the browser — but you can convert it to a format we DO read in about 15 seconds.`,
      ],
    };
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return runParser(format, filename, text);
}

function runParser(format: ScheduleFormat, filename: string, text: string): ParseResult {
  try {
    switch (format) {
      case "msproject-xml": return { format, ...parseMsProjectXml(text) };
      case "msproject-mpx": return { format, ...parseMsProjectMpx(text) };
      case "p6-xml":        return { format, ...parseP6Xml(text) };
      case "p6-xer":        return { format, ...parseP6Xer(text) };
      case "msproject-csv": return { format, ...parseMsProjectCsv(text) };
      case "generic-csv":   return { format, ...parseGenericCsv(text) };
      case "msproject-mpp":
        return {
          format,
          rows: [],
          warnings: [
            `"${filename}" is a Microsoft Project binary file (.mpp). The MPP container is proprietary and cannot be read in the browser — but you can convert it to a format we DO read in about 15 seconds.`,
          ],
        };
      default:
        return { format: "unknown", rows: [], warnings: [`Couldn't identify file type for "${filename}". Drop a .xml, .xer, .mpx, or .csv exported from your PM tool.`] };
    }
  } catch (e) {
    return { format, rows: [], warnings: [`Parser threw: ${(e as Error).message}`] };
  }
}

// ─── MS Project XML ─────────────────────────────────────────────
// Schema: <Project><Tasks><Task><UID/><Name/><Start/><Finish/>
// <Milestone>1</Milestone><PercentComplete>50</PercentComplete>...
// We accept all tasks but flag Milestone=1 as weight=1 (others
// also weight=1 unless duration extracted — keeping naive for now).

function parseMsProjectXml(text: string): { rows: ParsedMilestone[]; warnings: string[] } {
  const warnings: string[] = [];
  const rows: ParsedMilestone[] = [];

  const doc = parseXml(text);
  if (!doc) { warnings.push("XML could not be parsed."); return { rows, warnings }; }

  const taskNodes = Array.from(doc.getElementsByTagNameNS("*", "Task"));
  if (taskNodes.length === 0) { warnings.push("No <Task> elements found in the project XML."); return { rows, warnings }; }

  // Hierarchy reconstruction: walk tasks in document order maintaining
  // a stack of "the most recent task at each outline level" so we can
  // assign parentExternalRef without needing explicit parent links.
  // MS Project XML exports tasks in flattened outline order, so this
  // works for every well-formed file.
  const recentByLevel = new Map<number, string>(); // level → parent's externalRef
  let dropped = 0;

  for (const t of taskNodes) {
    const name = childText(t, "Name");
    const start = childText(t, "Start");
    const finish = childText(t, "Finish");
    const uid = childText(t, "UID");
    const outlineLevelRaw = childText(t, "OutlineLevel");
    const outlineNumber = childText(t, "OutlineNumber"); // WBS string like "1.2.3"
    const isSummary = childText(t, "Summary") === "1";
    const isMilestone = childText(t, "Milestone") === "1";
    const pct = Number(childText(t, "PercentComplete") || "0");

    const plannedRaw = finish || start;
    if (!name || !plannedRaw) { dropped++; continue; }

    const outlineLevel = Number(outlineLevelRaw) || 1;
    const externalRef = uid ? `msp-uid:${uid}` : null;

    // Parent is the most recent task at outlineLevel-1.
    let parentExternalRef: string | null = null;
    if (outlineLevel > 1) {
      const p = recentByLevel.get(outlineLevel - 1);
      if (p) parentExternalRef = p;
    }
    if (externalRef) recentByLevel.set(outlineLevel, externalRef);
    // Clear any deeper levels so the next sibling at this depth
    // doesn't get treated as a grandchild of the previous one.
    for (const k of Array.from(recentByLevel.keys())) {
      if (k > outlineLevel) recentByLevel.delete(k);
    }

    const descParts: string[] = [];
    if (isMilestone) descParts.push("Milestone task");
    if (isSummary) descParts.push("Summary (rolls up children)");

    rows.push({
      name: name.trim(),
      plannedAt: coerceIso(plannedRaw),
      plannedStartAt: start ? coerceIso(start) : null,
      weight: 1,
      externalRef,
      description: descParts.length > 0 ? descParts.join(" · ") : null,
      percentComplete: isNaN(pct) ? undefined : pct,
      outlineLevel,
      wbs: outlineNumber || null,
      isSummary,
      parentExternalRef,
    });
  }
  if (dropped > 0) warnings.push(`${dropped} task${dropped === 1 ? "" : "s"} skipped (missing name or date).`);
  if (rows.length === 0) warnings.push("No usable rows found in the MS Project XML.");
  return { rows, warnings };
}

// ─── Primavera P6 XML ───────────────────────────────────────────
// Element of interest: <Activity><Name/><PlannedFinishDate/>...
// The wrapper varies (APIBusinessObjects, Project, etc.). We just
// grab every <Activity> we can find.

function parseP6Xml(text: string): { rows: ParsedMilestone[]; warnings: string[] } {
  const warnings: string[] = [];
  const rows: ParsedMilestone[] = [];

  const doc = parseXml(text);
  if (!doc) { warnings.push("XML could not be parsed."); return { rows, warnings }; }

  const acts = Array.from(doc.getElementsByTagNameNS("*", "Activity"));
  if (acts.length === 0) { warnings.push("No <Activity> elements found in the P6 XML."); return { rows, warnings }; }

  let dropped = 0;
  for (const a of acts) {
    const name = childText(a, "Name");
    const finish = childText(a, "PlannedFinishDate") || childText(a, "ExpectedFinishDate") || childText(a, "FinishDate");
    const start  = childText(a, "PlannedStartDate")  || childText(a, "StartDate");
    const idTxt  = childText(a, "Id") || childText(a, "ActivityId") || childText(a, "ObjectId");
    const pct    = Number(childText(a, "PercentComplete") || childText(a, "DurationPercentComplete") || "0");
    const plannedRaw = finish || start;
    if (!name || !plannedRaw) { dropped++; continue; }
    rows.push({
      name: name.trim(),
      plannedAt: coerceIso(plannedRaw),
      weight: 1,
      externalRef: idTxt ? `p6-id:${idTxt}` : null,
      percentComplete: isNaN(pct) ? undefined : pct,
    });
  }
  if (dropped > 0) warnings.push(`${dropped} activit${dropped === 1 ? "y" : "ies"} skipped (missing name or date).`);
  return { rows, warnings };
}

// ─── Primavera P6 XER ──────────────────────────────────────────
// XER is tab-delimited with section markers:
//   %T TASK
//   %F task_id  task_name  target_end_date  ...
//   %R 12345    "Engineering complete"  2026-08-15 00:00 ...
//
// We extract only the TASK table.

function parseP6Xer(text: string): { rows: ParsedMilestone[]; warnings: string[] } {
  const warnings: string[] = [];
  const rows: ParsedMilestone[] = [];

  const lines = text.split(/\r?\n/);
  let inTask = false;
  let fields: string[] = [];
  let i_name = -1, i_id = -1, i_finish = -1, i_start = -1, i_pct = -1;

  for (const line of lines) {
    if (line.startsWith("%T\t")) {
      inTask = line.slice(3).trim().toUpperCase() === "TASK";
      fields = []; i_name = -1; i_id = -1; i_finish = -1; i_start = -1; i_pct = -1;
      continue;
    }
    if (!inTask) continue;
    if (line.startsWith("%F\t")) {
      fields = line.slice(3).split("\t").map((c) => c.trim());
      i_id     = fields.findIndex((c) => /task_id|task_code|object_id/i.test(c));
      i_name   = fields.findIndex((c) => /task_name|name/i.test(c));
      i_finish = fields.findIndex((c) => /target_end_date|end_date|act_end_date|finish_date/i.test(c));
      i_start  = fields.findIndex((c) => /target_start_date|start_date|act_start_date/i.test(c));
      i_pct    = fields.findIndex((c) => /phys_complete_pct|complete_pct/i.test(c));
      continue;
    }
    if (line.startsWith("%R\t")) {
      const cells = line.slice(3).split("\t");
      const name = i_name >= 0 ? cells[i_name]?.trim() : "";
      const finish = i_finish >= 0 ? cells[i_finish]?.trim() : "";
      const start  = i_start  >= 0 ? cells[i_start]?.trim()  : "";
      const id     = i_id     >= 0 ? cells[i_id]?.trim()     : "";
      const pctRaw = i_pct    >= 0 ? cells[i_pct]?.trim()    : "";
      const planned = finish || start;
      if (!name || !planned) continue;
      const pct = Number(pctRaw || "0");
      rows.push({
        name,
        plannedAt: coerceIso(planned),
        weight: 1,
        externalRef: id ? `p6-task:${id}` : null,
        percentComplete: isNaN(pct) ? undefined : pct,
      });
      continue;
    }
    if (line.startsWith("%E\t")) inTask = false;
  }
  if (rows.length === 0) warnings.push("XER had no TASK rows we could read. Check that you exported the activity table.");
  return { rows, warnings };
}

// ─── MS Project CSV ────────────────────────────────────────────
// MS Project's CSV export ships with these typical columns:
//   ID, Task Name, Duration, Start, Finish, % Complete,
//   Predecessors, Resource Names, Outline Level
//
// We accept comma OR tab delimited (MS Project Save As often uses
// tabs depending on the locale).

function parseMsProjectCsv(text: string): { rows: ParsedMilestone[]; warnings: string[] } {
  return parseCsvLikeWithSynonyms(text, {
    name:     ["task name", "name"],
    planned:  ["finish", "finish date", "end", "due date", "due", "planned_at", "start"],
    id:       ["id", "task id", "uid", "wbs"],
    pct:      ["% complete", "percent complete", "complete"],
    desc:     ["notes", "description"],
  }, "msp");
}

// ─── Generic CSV (our own convention, still backward-compatible) ─

function parseGenericCsv(text: string): { rows: ParsedMilestone[]; warnings: string[] } {
  return parseCsvLikeWithSynonyms(text, {
    name:     ["name", "task name", "milestone", "title"],
    planned:  ["planned_at", "due", "due date", "finish", "finish date", "end", "date"],
    id:       ["external_ref", "id", "ref"],
    pct:      ["% complete", "percent complete", "complete"],
    desc:     ["description", "notes"],
    weight:   ["weight"],
  }, "csv");
}

interface SynonymSpec {
  name: string[];
  planned: string[];
  id?: string[];
  pct?: string[];
  desc?: string[];
  weight?: string[];
}

function parseCsvLikeWithSynonyms(text: string, syn: SynonymSpec, refTag: string): { rows: ParsedMilestone[]; warnings: string[] } {
  const warnings: string[] = [];
  const rows: ParsedMilestone[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) { warnings.push("File needs a header row plus at least one data row."); return { rows, warnings }; }

  // Auto-detect delimiter — tab beats comma if both appear.
  const sampleLine = lines[0];
  const delim = sampleLine.includes("\t") ? "\t" : ",";
  const header = csvSplit(sampleLine, delim).map((h) => h.toLowerCase().trim().replace(/^"|"$/g, ""));

  const findCol = (cands: string[]): number => {
    for (const c of cands) { const i = header.indexOf(c); if (i >= 0) return i; }
    return -1;
  };

  const iName    = findCol(syn.name);
  const iPlanned = findCol(syn.planned);
  const iId      = syn.id     ? findCol(syn.id)     : -1;
  const iPct     = syn.pct    ? findCol(syn.pct)    : -1;
  const iDesc    = syn.desc   ? findCol(syn.desc)   : -1;
  const iWeight  = syn.weight ? findCol(syn.weight) : -1;

  if (iName < 0 || iPlanned < 0) {
    warnings.push(`Couldn't find required columns. Expected something like "${syn.name[0]}" and "${syn.planned[0]}" — got: ${header.join(", ")}`);
    return { rows, warnings };
  }

  let dropped = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = csvSplit(lines[i], delim);
    const name = cells[iName]?.trim().replace(/^"|"$/g, "");
    const planned = cells[iPlanned]?.trim().replace(/^"|"$/g, "");
    if (!name || !planned) { dropped++; continue; }
    const id     = iId     >= 0 ? cells[iId]?.trim().replace(/^"|"$/g, "")     : "";
    const pctRaw = iPct    >= 0 ? cells[iPct]?.trim().replace(/[%"]/g, "")     : "";
    const desc   = iDesc   >= 0 ? cells[iDesc]?.trim().replace(/^"|"$/g, "")   : "";
    const wRaw   = iWeight >= 0 ? cells[iWeight]?.trim().replace(/^"|"$/g, "") : "";
    const weight = wRaw ? Number(wRaw) : 1;
    const pct = pctRaw ? Number(pctRaw) : NaN;
    rows.push({
      name,
      plannedAt: coerceIso(planned),
      weight: isNaN(weight) ? 1 : weight,
      externalRef: id ? `${refTag}:${id}` : null,
      description: desc || null,
      percentComplete: isNaN(pct) ? undefined : pct,
    });
  }
  if (dropped > 0) warnings.push(`${dropped} row${dropped === 1 ? "" : "s"} skipped (missing name or date).`);
  return { rows, warnings };
}

// ─── Helpers ────────────────────────────────────────────────────

function parseXml(text: string): Document | null {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  return doc;
}

function childText(parent: Element, tag: string): string {
  // Walk only direct-ish children — first match wins. Use *NS so
  // we tolerate namespace prefixes.
  const found = parent.getElementsByTagNameNS("*", tag);
  for (const node of Array.from(found)) {
    // Prefer immediate children but accept the first descendant if
    // there are no direct hits (P6 XML often nests deeper).
    if (node.parentNode === parent) return (node.textContent ?? "").trim();
  }
  return found.length > 0 ? (found[0].textContent ?? "").trim() : "";
}

// Coerce a bunch of common date strings to an ISO instant. Accepts:
//   2026-08-15
//   2026-08-15T00:00:00
//   2026-08-15 00:00
//   8/15/2026
//   15/08/2026 (ambiguous — we treat as M/D/Y if first part ≤ 12)
function coerceIso(s: string): string {
  const trimmed = s.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return trimmed;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T00:00:00Z`;
  // "2026-08-15 00:00" / "2026-08-15 00:00:00"
  const m1 = trimmed.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m1) return `${m1[1]}T${m1[2]}:${m1[3]}:${m1[4] ?? "00"}Z`;
  // M/D/YYYY or D/M/YYYY (assume the first form when ambiguous)
  const m2 = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m2) {
    const a = Number(m2[1]); const b = Number(m2[2]);
    const yRaw = Number(m2[3]); const y = yRaw < 100 ? 2000 + yRaw : yRaw;
    const month = a; const day = b; // M/D first
    return `${y.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}T00:00:00Z`;
  }
  // Last resort — let Date try.
  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) return d.toISOString();
  return trimmed; // hand it to the importer; if invalid, Supabase will reject.
}

// Same minimal CSV split as before, but parameterizable by delim.
function csvSplit(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuote = false; }
      } else cur += c;
    } else {
      if (c === '"') inQuote = true;
      else if (c === delim) { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ─── MS Project MPX (text interchange) ─────────────────────────
// MPX is the legacy text-based MS Project interchange format —
// comma-delimited, with a numeric "record number" as the first
// field of every line. Schema (abridged):
//
//   10  → File creation info
//   20  → Currency settings
//   30  → Default settings
//   40  → Date / time settings
//   50  → Calendar (multiple)
//   60  → Project header
//   70  → Resource model
//   71  → Resource record (one per resource)
//   72  → Resource notes
//   75  → Resource calendar
//   80  → Task model
//   70…→ Task record
//
// What we need is record 70 (task model header — gives us column
// order) followed by 71/72/etc. for tasks. Realistically MPX files
// in the wild use record numbers 50..99 with a fairly predictable
// task block at 70. We keep it robust: scan for lines whose
// first field is a task-class record number and extract Name +
// dates by column position derived from the model record.

function parseMsProjectMpx(text: string): { rows: ParsedMilestone[]; warnings: string[] } {
  const warnings: string[] = [];
  const rows: ParsedMilestone[] = [];

  const lines = text.split(/\r?\n/);
  if (lines.length < 2 || !/^mpx/i.test(lines[0])) {
    warnings.push("File doesn't start with the MPX header line.");
    return { rows, warnings };
  }

  // Default column positions for an MPX task record (record 70).
  // From the published MS Project MPX spec — most exporters honor
  // this default ordering unless a leading model record overrides
  // it. We accept either case.
  // Index into the comma-split row (skipping the leading record
  // number itself):
  //   1=Name, 2=WBS, 3=Outline Level, ...
  //   5=Duration, 6=Resource Initials,
  //   7=% Complete, 8=% Work Complete,
  //   ... 11=Start, 12=Finish ...
  // Practical observation: real-world MPX from Microsoft Project
  // exporters places Start ≈ index 11, Finish ≈ index 12.
  let nameIdx = 1;
  let startIdx = 11;
  let finishIdx = 12;
  let pctIdx = 7;
  let idIdx  = 0; // record-number-relative
  let modelSet = false;

  // Record 70 is the model — its fields define the order for
  // following 71/72 task records. We try to read it.
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = csvSplit(trimmed, ",");
    const rec = fields[0]?.trim();
    if (rec === "70" && !modelSet) {
      // Each subsequent column is a field name; build index map.
      const headers = fields.slice(1).map((h) => h.trim().toLowerCase());
      const findIdx = (cands: string[]): number => {
        for (const c of cands) {
          const i = headers.indexOf(c);
          if (i >= 0) return i + 1; // +1 to skip the record number cell
        }
        return -1;
      };
      const n  = findIdx(["name"]);
      const st = findIdx(["start"]);
      const fn = findIdx(["finish"]);
      const pc = findIdx(["% complete", "percent complete"]);
      const id = findIdx(["id", "unique id", "uid"]);
      if (n  >= 0) nameIdx   = n;
      if (st >= 0) startIdx  = st;
      if (fn >= 0) finishIdx = fn;
      if (pc >= 0) pctIdx    = pc;
      if (id >= 0) idIdx     = id;
      modelSet = true;
      continue;
    }
    // Task records: numeric record numbers in the 71-79 range, or
    // sometimes 70 with task data when the file omits a model row.
    if (rec === "71" || rec === "72" || rec === "73" || rec === "74") {
      const name = fields[nameIdx]?.trim();
      const finish = fields[finishIdx]?.trim();
      const start  = fields[startIdx]?.trim();
      const id     = idIdx > 0 ? fields[idIdx]?.trim() : "";
      const pctRaw = pctIdx > 0 ? fields[pctIdx]?.trim() : "";
      const planned = finish || start;
      if (!name || !planned) continue;
      const pct = pctRaw ? Number(pctRaw.replace(/[%"]/g, "")) : NaN;
      rows.push({
        name,
        plannedAt: coerceIso(planned),
        weight: 1,
        externalRef: id ? `mpx-id:${id}` : null,
        percentComplete: isNaN(pct) ? undefined : pct,
      });
    }
  }
  if (rows.length === 0) warnings.push("No task records (record 71-74) recognized in this MPX file. If the file came from a recent Project version, prefer Save As → XML — MPX is a legacy format.");
  return { rows, warnings };
}
