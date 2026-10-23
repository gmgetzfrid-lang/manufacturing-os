// lib/scheduleParsers.ts
//
// Parsers for the schedule-import path. Replaces the previous
import { parseLinkToken, type LinkSpec } from "@/lib/scheduleLinks";
import { naiveToIso, normalizeTimeZone } from "@/lib/scheduleTz";
import { parseIsoDurationHours } from "@/lib/scheduleRules";
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
  /** externalRefs of PREDECESSOR rows (finish-to-start). Resolved to ids
   *  by the importer's dependency pass. */
  dependsOnExternalRefs?: string[];
  /** How it waits on each predecessor (start-to-start, lag…), by the
   *  predecessor's externalRef. Missing = finish-to-start, no lag. */
  linksByRef?: Record<string, LinkSpec>;
  // ── Rich execution detail (optional; populated where the source
  //    carries it). Everything we can't map to a first-class field
  //    lands in `attributes` keyed by the source's own column label. ──
  workOrderRef?: string | null;
  responsibleParty?: string | null;
  responsibleKind?: string | null;
  responsibleOrg?: string | null;
  location?: string | null;
  durationHours?: number | null;
  attributes?: Record<string, string | number | boolean | null> | null;
}

export interface ParseResult {
  format: ScheduleFormat;
  rows: ParsedMilestone[];
  warnings: string[];
}

export type ScheduleFormat =
  | "msproject-xml"
  | "msproject-mpp"      // proprietary binary — detected only so we can refuse it and demand XML
  | "msproject-mpx"      // legacy text interchange — detected only so we can refuse it and demand XML
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

/** Options for a parse. `timeZone` is the project's IANA zone: bare dates
 *  and naive times in the file ("2026-08-15 08:00") are plant wall-clock
 *  time, so they are converted into instants in that zone. Omitted = UTC. */
export interface ParseOptions { timeZone?: string | null }

export function parseScheduleFile(filename: string, text: string, options: ParseOptions = {}): ParseResult {
  const format = detectFormat(filename, text);
  return runParser(format, filename, text, normalizeTimeZone(options.timeZone));
}

/** Byte-aware entry point. Preferred when the caller has the raw
 *  file — handles MPP detection before falling through to text. */
export function parseScheduleFileFromBytes(filename: string, bytes: Uint8Array, options: ParseOptions = {}): ParseResult {
  const format = detectFormatFromBytes(filename, bytes);
  if (format === "msproject-mpp" || format === "msproject-mpx") {
    return { format, rows: [], warnings: [xmlDemand(filename, format)] };
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return runParser(format, filename, text, normalizeTimeZone(options.timeZone));
}

/** The enforcement message for refused MS Project formats. Detection is kept
 *  precisely so this can be specific: name the file, say why it's refused,
 *  and give the exact export step that produces a file we import 1:1. */
function xmlDemand(filename: string, format: "msproject-mpp" | "msproject-mpx"): string {
  const kind = format === "msproject-mpp"
    ? "a Microsoft Project binary file (.mpp)"
    : "a legacy Microsoft Project interchange file (.mpx)";
  return `"${filename}" is ${kind}. This format is not accepted — export the XML instead: open the schedule in Microsoft Project, File → Save As → choose "XML Format (*.xml)", then drop that file here. The XML import is a true 1:1 copy (every date, dependency, resource, and the full hierarchy).`;
}

function runParser(format: ScheduleFormat, filename: string, text: string, tz: string): ParseResult {
  try {
    switch (format) {
      case "msproject-xml": return { format, ...parseMsProjectXml(text, tz) };
      case "p6-xml":        return { format, ...parseP6Xml(text, tz) };
      case "p6-xer":        return { format, ...parseP6Xer(text, tz) };
      case "msproject-csv": return { format, ...parseMsProjectCsv(text, tz) };
      case "generic-csv":   return { format, ...parseGenericCsv(text, tz) };
      case "msproject-mpp":
      case "msproject-mpx":
        return { format, rows: [], warnings: [xmlDemand(filename, format)] };
      default:
        return { format: "unknown", rows: [], warnings: [`Couldn't identify file type for "${filename}". Drop a .xml, .xer, or .csv exported from your PM tool.`] };
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

function parseMsProjectXml(text: string, tz: string): { rows: ParsedMilestone[]; warnings: string[] } {
  const warnings: string[] = [];
  const rows: ParsedMilestone[] = [];

  const doc = parseXml(text);
  if (!doc) { warnings.push("XML could not be parsed."); return { rows, warnings }; }

  const taskNodes = Array.from(doc.getElementsByTagNameNS("*", "Task"));
  if (taskNodes.length === 0) { warnings.push("No <Task> elements found in the project XML."); return { rows, warnings }; }

  // ── Resource assignments ──────────────────────────────────────
  // MS Project XML stores resources (<Resource>) and assignments
  // (<Assignment> linking TaskUID→ResourceUID) SEPARATELY from tasks.
  // Cross-reference them so each task carries the contractor / department /
  // crew responsible for the work — the "Resource" column users expect.
  const resourceByUid = new Map<string, { name: string; group: string | null }>();
  for (const rEl of Array.from(doc.getElementsByTagNameNS("*", "Resource"))) {
    const ruid = childText(rEl as Element, "UID");
    const rname = childText(rEl as Element, "Name");
    if (ruid && rname) resourceByUid.set(ruid, { name: rname, group: childText(rEl as Element, "Group") || null });
  }
  const resUidsByTaskUid = new Map<string, string[]>();
  for (const aEl of Array.from(doc.getElementsByTagNameNS("*", "Assignment"))) {
    const tUid = childText(aEl as Element, "TaskUID");
    const rUid = childText(aEl as Element, "ResourceUID");
    if (!tUid || !rUid || rUid === "-65535") continue; // -65535 = unassigned placeholder
    const arr = resUidsByTaskUid.get(tUid) ?? [];
    if (!arr.includes(rUid)) arr.push(rUid);
    resUidsByTaskUid.set(tUid, arr);
  }
  let resourcesFound = 0;
  let nonFsLinks = 0;

  // ── Custom (extended) columns ────────────────────────────────
  // User-defined columns in MS Project ("Contractor", "Area", "Cost Code")
  // are stored as extended attributes: definitions at project level map a
  // FieldID → the user's alias; values live per task. Capture them by the
  // user's OWN column name so the importer is dynamic, not hardcoded.
  const extAliasByFieldId = new Map<string, string>();
  for (const cont of Array.from(doc.getElementsByTagNameNS("*", "ExtendedAttributes"))) {
    for (const ea of Array.from(cont.getElementsByTagNameNS("*", "ExtendedAttribute"))) {
      const fid = childText(ea as Element, "FieldID");
      const alias = childText(ea as Element, "Alias") || childText(ea as Element, "FieldName");
      if (fid && alias) extAliasByFieldId.set(fid, alias);
    }
  }

  // Hierarchy reconstruction: walk tasks in document order maintaining
  // a stack of "the most recent task at each outline level" so we can
  // assign parentExternalRef without needing explicit parent links.
  // MS Project XML exports tasks in flattened outline order, so this
  // works for every well-formed file.
  const recentByLevel = new Map<number, string>(); // level → parent's externalRef
  let dropped = 0;
  let projectSummarySkipped = false;

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

    // UID 0 / OutlineLevel 0 is MS Project's PROJECT SUMMARY row — the file's
    // own title ("TMIX-1 TAR - OCT.26") spanning the whole schedule. It is
    // not a task and never appears on a printed schedule; importing it made
    // a childless row that covered every day of the calendar.
    if (uid === "0" || outlineLevelRaw === "0") { projectSummarySkipped = true; continue; }

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

    // Predecessors → finish-to-start dependencies. MS Project stores each as
    // <PredecessorLink><PredecessorUID>N</PredecessorUID></PredecessorLink>.
    // Other link types (SS / FF / SF) and lags are kept as text on the
    // task — the schedule here links finish-to-start only — and counted
    // so the import says so instead of quietly changing the logic.
    // MS Project link Type: 0 FF, 1 FS, 2 SF, 3 SS; LinkLag in tenths of a minute.
    const dependsOnExternalRefs: string[] = [];
    const linksByRef: Record<string, LinkSpec> = {};
    for (const link of Array.from(t.getElementsByTagNameNS("*", "PredecessorLink"))) {
      const predUid = childText(link as Element, "PredecessorUID");
      if (!predUid) continue;
      dependsOnExternalRefs.push(`msp-uid:${predUid}`);
      const type = Number(childText(link as Element, "Type") ?? "1");
      const lagMin = Number(childText(link as Element, "LinkLag") ?? "0") / 10;
      const kind = (["FF", "FS", "SF", "SS"] as const)[Number.isFinite(type) ? type : 1] ?? "FS";
      const lagHours = Number.isFinite(lagMin) ? Math.round((lagMin / 60) * 100) / 100 : 0;
      if (kind !== "FS" || lagHours) { linksByRef[`msp-uid:${predUid}`] = { type: kind, lagHours }; nonFsLinks++; }
    }

    // Resource(s) responsible for this task.
    let responsibleParty: string | null = null;
    let responsibleOrg: string | null = null;
    if (uid) {
      const names: string[] = [];
      const groups = new Set<string>();
      for (const ru of resUidsByTaskUid.get(uid) ?? []) {
        const r = resourceByUid.get(ru);
        if (r) { names.push(r.name); if (r.group) groups.add(r.group); }
      }
      if (names.length) { responsibleParty = names.join(", "); resourcesFound++; }
      if (groups.size) responsibleOrg = Array.from(groups).join(", ");
    }

    // Deadline (MS Project <Deadline>). Sentinel "NA"/empty/absent → ignore.
    const deadlineRaw = childText(t, "Deadline");
    const deadlineIso = deadlineRaw && !/^NA$/i.test(deadlineRaw) ? coerceIso(deadlineRaw, tz) : null;
    const attributes: Record<string, string> = {};
    if (deadlineIso) attributes.deadline_at = deadlineIso;
    if (isMilestone) attributes.milestone = "1"; // so the Gantt can draw a diamond
    const workRaw = childText(t, "Work"); // PT40H0M0S style → keep raw for reference
    if (workRaw) attributes.work = workRaw;
    // Real hours. Prefer <Work> (resourced effort) when it carries any, else
    // <Duration> (the schedule's own span in working time). Without this every
    // step weighed the same in the shift report's "hours behind / ahead".
    const durationRaw = childText(t, "Duration");
    const durationHours = isSummary ? null : (parseIsoDurationHours(workRaw) ?? parseIsoDurationHours(durationRaw));
    // Per-task custom column values, keyed by the user's column name.
    for (const ea of Array.from(t.getElementsByTagNameNS("*", "ExtendedAttribute"))) {
      const fid = childText(ea as Element, "FieldID");
      const val = childText(ea as Element, "Value");
      if (fid && val) attributes[extAliasByFieldId.get(fid) || `field-${fid}`] = val;
    }

    rows.push({
      name: name.trim(),
      plannedAt: coerceIso(plannedRaw, tz),
      plannedStartAt: start ? coerceIso(start, tz) : null,
      weight: 1,
      externalRef,
      description: descParts.length > 0 ? descParts.join(" · ") : null,
      percentComplete: isNaN(pct) ? undefined : pct,
      outlineLevel,
      wbs: outlineNumber || null,
      isSummary,
      parentExternalRef,
      dependsOnExternalRefs: dependsOnExternalRefs.length > 0 ? dependsOnExternalRefs : undefined,
      linksByRef: Object.keys(linksByRef).length ? linksByRef : undefined,
      responsibleParty,
      responsibleOrg,
      durationHours,
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    });
  }
  if (resourcesFound > 0) warnings.push(`Resources mapped onto ${resourcesFound} task${resourcesFound === 1 ? "" : "s"}.`);
  if (nonFsLinks > 0) warnings.push(`${nonFsLinks} link${nonFsLinks === 1 ? " is" : "s are"} start-to-start, finish-to-finish or carry a lag — kept as they are.`);
  if (dropped > 0) warnings.push(`${dropped} task${dropped === 1 ? "" : "s"} skipped (missing name or date).`);
  if (projectSummarySkipped) warnings.push("The file's project summary row (its title) was not imported as a task.");
  const cleaned = dropPlaceholderLeaves(rows);
  if (cleaned.dropped > 0) warnings.push(`${cleaned.dropped} unnamed "<New Task>" placeholder row${cleaned.dropped === 1 ? "" : "s"} dropped.`);
  if (cleaned.rows.length === 0) warnings.push("No usable rows found in the MS Project XML.");
  return { rows: cleaned.rows, warnings };
}

// ─── Primavera P6 XML ───────────────────────────────────────────
// Element of interest: <Activity><Name/><PlannedFinishDate/>...
// The wrapper varies (APIBusinessObjects, Project, etc.). We just
// grab every <Activity> we can find.

function parseP6Xml(text: string, tz: string): { rows: ParsedMilestone[]; warnings: string[] } {
  const warnings: string[] = [];
  const rows: ParsedMilestone[] = [];

  const doc = parseXml(text);
  if (!doc) { warnings.push("XML could not be parsed."); return { rows, warnings }; }

  // ── WBS nodes → summary rows ───────────────────────────────────
  // Primavera carries hierarchy in a separate <WBS> table. Each node
  // has an ObjectId, a ParentObjectId, and a Name. Activities point
  // at a WBS node via <WBSObjectId>. We import WBS nodes as summary
  // rows so the Execution view can group activities under their phase
  // exactly the way P6 shows them. WBS nodes carry no dates of their
  // own — rollUpSummaryDates() fills their span from descendants.
  const wbsNodes = Array.from(doc.getElementsByTagNameNS("*", "WBS"));
  for (const w of wbsNodes) {
    const objId = childText(w, "ObjectId");
    if (!objId) continue;
    const parentId = childText(w, "ParentObjectId");
    const name = childText(w, "Name") || childText(w, "Code") || `WBS ${objId}`;
    rows.push({
      name: name.trim(),
      plannedAt: "",            // rolled up from children
      plannedStartAt: null,
      weight: 1,
      externalRef: `p6-wbs:${objId}`,
      parentExternalRef: parentId ? `p6-wbs:${parentId}` : null,
      isSummary: true,
      wbs: childText(w, "Code") || null,
    });
  }

  // ── Relationships → finish-to-start dependencies ───────────────
  // P6 XML stores activity links in <Relationship> elements pointing at the
  // predecessor + successor ObjectIds. Index them by successor so each activity
  // can carry its predecessors (same depends_on path as MS Project XML).
  const predsByActObjId = new Map<string, string[]>();
  const p6Links = new Map<string, LinkSpec>();
  let p6NonFs = 0;
  for (const rel of Array.from(doc.getElementsByTagNameNS("*", "Relationship"))) {
    const succ = childText(rel as Element, "SuccessorActivityObjectId") || childText(rel as Element, "SuccessorObjectId");
    const pred = childText(rel as Element, "PredecessorActivityObjectId") || childText(rel as Element, "PredecessorObjectId");
    if (!succ || !pred) continue;
    // P6: "Start to Start" … and Lag in hours.
    const type = (childText(rel as Element, "Type") ?? "").toLowerCase();
    const lag = Number(childText(rel as Element, "Lag") ?? "0");
    const kind: LinkSpec["type"] = /start to start/.test(type) ? "SS" : /finish to finish/.test(type) ? "FF" : /start to finish/.test(type) ? "SF" : "FS";
    if (kind !== "FS" || (Number.isFinite(lag) && lag !== 0)) {
      p6NonFs++;
      p6Links.set(`${succ}|${pred}`, { type: kind, lagHours: Number.isFinite(lag) ? lag : 0 });
    }
    const arr = predsByActObjId.get(succ) ?? [];
    if (!arr.includes(pred)) arr.push(pred);
    predsByActObjId.set(succ, arr);
  }
  let relationCount = 0;

  // ── Activities → leaf rows ─────────────────────────────────────
  const acts = Array.from(doc.getElementsByTagNameNS("*", "Activity"));
  if (acts.length === 0 && wbsNodes.length === 0) {
    warnings.push("No <Activity> or <WBS> elements found in the P6 XML.");
    return { rows, warnings };
  }

  let dropped = 0;
  for (const a of acts) {
    const name = childText(a, "Name");
    const finish = childText(a, "PlannedFinishDate") || childText(a, "ExpectedFinishDate") || childText(a, "FinishDate");
    const start  = childText(a, "PlannedStartDate")  || childText(a, "StartDate");
    const objId  = childText(a, "ObjectId");
    const idTxt  = childText(a, "Id") || childText(a, "ActivityId") || objId;
    const wbsId  = childText(a, "WBSObjectId");
    const pct    = Number(childText(a, "PercentComplete") || childText(a, "DurationPercentComplete") || "0");
    const plannedRaw = finish || start;
    if (!name || !plannedRaw) { dropped++; continue; }
    const preds = objId ? (predsByActObjId.get(objId) ?? []) : [];
    if (preds.length) relationCount += preds.length;
    rows.push({
      name: name.trim(),
      plannedAt: coerceIso(plannedRaw, tz),
      plannedStartAt: start ? coerceIso(start, tz) : null,
      weight: 1,
      externalRef: objId ? `p6-act:${objId}` : (idTxt ? `p6-id:${idTxt}` : null),
      parentExternalRef: wbsId ? `p6-wbs:${wbsId}` : null,
      dependsOnExternalRefs: preds.length ? preds.map((p) => `p6-act:${p}`) : undefined,
      linksByRef: (() => {
        const o: Record<string, LinkSpec> = {};
        for (const p of preds) { const l = p6Links.get(`${objId}|${p}`); if (l) o[`p6-act:${p}`] = l; }
        return Object.keys(o).length ? o : undefined;
      })(),
      percentComplete: isNaN(pct) ? undefined : pct,
      wbs: idTxt || null,
    });
  }
  if (relationCount > 0) warnings.push(`${relationCount} dependency link${relationCount === 1 ? "" : "s"} mapped from relationships.`);
  if (p6NonFs > 0) warnings.push(`${p6NonFs} link${p6NonFs === 1 ? " is" : "s are"} start-to-start, finish-to-finish or carry a lag — kept as they are.`);

  // Roll WBS spans up from activities, then compute outline depth and
  // drop any WBS branch that ended up with no dated descendants.
  rollUpSummaryDates(rows);
  computeOutlineLevels(rows);
  const usable = rows.filter((r) => r.plannedAt && r.plannedAt.length > 0);
  const droppedSummaries = rows.length - usable.length;

  if (dropped > 0) warnings.push(`${dropped} activit${dropped === 1 ? "y" : "ies"} skipped (missing name or date).`);
  if (droppedSummaries > 0) warnings.push(`${droppedSummaries} empty WBS node${droppedSummaries === 1 ? "" : "s"} dropped (no dated activities beneath).`);
  if (usable.length === 0) warnings.push("No usable rows found in the P6 XML.");
  return { rows: usable, warnings };
}

// ─── Primavera P6 XER ──────────────────────────────────────────
// XER is tab-delimited with section markers:
//   %T TASK
//   %F task_id  task_name  target_end_date  ...
//   %R 12345    "Engineering complete"  2026-08-15 00:00 ...
//
// We extract only the TASK table.

interface XerTable { fields: string[]; rows: string[][] }

/** Read every section of an XER file into a name→table map. XER is
 *  tab-delimited with section markers: %T <TABLE>, %F <field row>,
 *  %R <data row>, %E <end>. */
function readXerTables(text: string): Map<string, XerTable> {
  const tables = new Map<string, XerTable>();
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("%T\t")) {
      current = line.slice(3).trim().toUpperCase();
      if (!tables.has(current)) tables.set(current, { fields: [], rows: [] });
    } else if (line.startsWith("%F\t") && current) {
      tables.get(current)!.fields = line.slice(3).split("\t").map((c) => c.trim());
    } else if (line.startsWith("%R\t") && current) {
      tables.get(current)!.rows.push(line.slice(3).split("\t"));
    } else if (line.startsWith("%E")) {
      current = null;
    }
  }
  return tables;
}

function parseP6Xer(text: string, tz: string): { rows: ParsedMilestone[]; warnings: string[] } {
  const warnings: string[] = [];
  const rows: ParsedMilestone[] = [];

  const tables = readXerTables(text);
  const task = tables.get("TASK");
  if (!task || task.rows.length === 0) {
    warnings.push("XER had no TASK rows we could read. Check that you exported the activity table.");
    return { rows, warnings };
  }
  const col = (t: XerTable, names: string[]): number => {
    for (const n of names) { const i = t.fields.indexOf(n); if (i >= 0) return i; }
    return -1;
  };

  // ── PROJWBS → summary rows ─────────────────────────────────────
  // The WBS hierarchy lives in its own table; activities reference a
  // wbs_id. Import each WBS node as a summary so activities group
  // under their phase. proj_node_flag='Y' marks the project root.
  const wbs = tables.get("PROJWBS");
  if (wbs) {
    const wId     = col(wbs, ["wbs_id"]);
    const wParent = col(wbs, ["parent_wbs_id"]);
    const wName   = col(wbs, ["wbs_name"]);
    const wShort  = col(wbs, ["wbs_short_name"]);
    const wProj   = col(wbs, ["proj_node_flag"]);
    for (const r of wbs.rows) {
      const id = wId >= 0 ? r[wId]?.trim() : "";
      if (!id) continue;
      const isRoot = wProj >= 0 && /^y/i.test(r[wProj]?.trim() ?? "");
      const parent = wParent >= 0 ? r[wParent]?.trim() : "";
      rows.push({
        name: (wName >= 0 ? r[wName]?.trim() : "") || `WBS ${id}`,
        plannedAt: "",
        plannedStartAt: null,
        weight: 1,
        externalRef: `p6-wbs:${id}`,
        parentExternalRef: (!isRoot && parent) ? `p6-wbs:${parent}` : null,
        isSummary: true,
        wbs: wShort >= 0 ? (r[wShort]?.trim() || null) : null,
      });
    }
  }

  // ── TASKPRED → finish-to-start dependencies ────────────────────
  // P6's activity links live in their own table: each row ties a successor
  // (task_id) to a predecessor (pred_task_id). Index by successor so each task
  // carries its predecessors through the same depends_on path as everything else.
  const predsByTaskId = new Map<string, string[]>();
  const xerLinks = new Map<string, LinkSpec>();
  let xerNonFs = 0;
  const taskpred = tables.get("TASKPRED");
  if (taskpred) {
    const pSucc = col(taskpred, ["task_id"]);
    const pPred = col(taskpred, ["pred_task_id"]);
    const pType = col(taskpred, ["pred_type"]);
    const pLag = col(taskpred, ["lag_hr_cnt"]);
    if (pSucc >= 0 && pPred >= 0) {
      for (const r of taskpred.rows) {
        const succ = r[pSucc]?.trim();
        const pred = r[pPred]?.trim();
        if (!succ || !pred) continue;
        const type = pType >= 0 ? (r[pType] ?? "").trim().toUpperCase() : "";
        const lag = pLag >= 0 ? Number(r[pLag]) : 0;
        const kind: LinkSpec["type"] = type === "PR_SS" ? "SS" : type === "PR_FF" ? "FF" : type === "PR_SF" ? "SF" : "FS";
        if (kind !== "FS" || (Number.isFinite(lag) && lag !== 0)) {
          xerNonFs++;
          xerLinks.set(`${succ}|${pred}`, { type: kind, lagHours: Number.isFinite(lag) ? lag : 0 });
        }
        const arr = predsByTaskId.get(succ) ?? [];
        if (!arr.includes(pred)) arr.push(pred);
        predsByTaskId.set(succ, arr);
      }
    }
  }
  let relationCount = 0;

  // ── TASK → leaf rows ───────────────────────────────────────────
  const tId     = col(task, ["task_id"]);
  const tName   = col(task, ["task_name"]);
  const tCode   = col(task, ["task_code"]);
  const tWbs    = col(task, ["wbs_id"]);
  const tStart  = col(task, ["target_start_date", "act_start_date", "early_start_date", "start_date"]);
  const tFinish = col(task, ["target_end_date", "act_end_date", "early_end_date", "finish_date", "end_date"]);
  const tPct    = col(task, ["phys_complete_pct", "complete_pct"]);
  let dropped = 0;
  for (const r of task.rows) {
    const name = tName >= 0 ? r[tName]?.trim() : "";
    const finish = tFinish >= 0 ? r[tFinish]?.trim() : "";
    const start  = tStart  >= 0 ? r[tStart]?.trim()  : "";
    const planned = finish || start;
    if (!name || !planned) { dropped++; continue; }
    const id    = tId  >= 0 ? r[tId]?.trim()  : "";
    const wbsId = tWbs >= 0 ? r[tWbs]?.trim() : "";
    const pct   = tPct >= 0 ? Number(r[tPct]?.trim() || "0") : NaN;
    const preds = id ? (predsByTaskId.get(id) ?? []) : [];
    if (preds.length) relationCount += preds.length;
    rows.push({
      name,
      plannedAt: coerceIso(planned, tz),
      plannedStartAt: start ? coerceIso(start, tz) : null,
      weight: 1,
      externalRef: id ? `p6-task:${id}` : null,
      parentExternalRef: wbsId ? `p6-wbs:${wbsId}` : null,
      dependsOnExternalRefs: preds.length ? preds.map((p) => `p6-task:${p}`) : undefined,
      linksByRef: (() => {
        const o: Record<string, LinkSpec> = {};
        for (const p of preds) { const l = xerLinks.get(`${id}|${p}`); if (l) o[`p6-task:${p}`] = l; }
        return Object.keys(o).length ? o : undefined;
      })(),
      percentComplete: isNaN(pct) ? undefined : pct,
      wbs: tCode >= 0 ? (r[tCode]?.trim() || null) : null,
    });
  }
  if (relationCount > 0) warnings.push(`${relationCount} dependency link${relationCount === 1 ? "" : "s"} mapped from TASKPRED.`);
  if (xerNonFs > 0) warnings.push(`${xerNonFs} link${xerNonFs === 1 ? " is" : "s are"} start-to-start, finish-to-finish or carry a lag — kept as they are.`);

  rollUpSummaryDates(rows);
  computeOutlineLevels(rows);
  const usable = rows.filter((r) => r.plannedAt && r.plannedAt.length > 0);
  const droppedSummaries = rows.length - usable.length;

  if (dropped > 0) warnings.push(`${dropped} activit${dropped === 1 ? "y" : "ies"} skipped (missing name or date).`);
  if (droppedSummaries > 0) warnings.push(`${droppedSummaries} empty WBS node${droppedSummaries === 1 ? "" : "s"} dropped (no dated activities beneath).`);
  if (usable.length === 0) warnings.push("XER parsed but no rows carried a usable date.");
  return { rows: usable, warnings };
}

// ─── MS Project CSV ────────────────────────────────────────────
// MS Project's CSV export ships with these typical columns:
//   ID, Task Name, Duration, Start, Finish, % Complete,
//   Predecessors, Resource Names, Outline Level
//
// We accept comma OR tab delimited (MS Project Save As often uses
// tabs depending on the locale).

function parseMsProjectCsv(text: string, tz: string): { rows: ParsedMilestone[]; warnings: string[] } {
  return parseCsvLikeWithSynonyms(text, tz, {
    name:     ["task name", "name"],
    planned:  ["finish", "finish date", "end", "due date", "due", "planned_at"],
    start:    ["start", "start date", "planned_start", "planned start"],
    id:       ["unique id", "uid", "id", "task id"],
    pct:      ["% complete", "percent complete", "complete"],
    desc:     ["notes", "description"],
    outline:  ["outline level", "outline_level", "level"],
    wbs:      ["wbs"],
    pred:     ["predecessors", "predecessor", "preds"],
  }, "msp");
}

// ─── Generic CSV (our own convention, still backward-compatible) ─

function parseGenericCsv(text: string, tz: string): { rows: ParsedMilestone[]; warnings: string[] } {
  return parseCsvLikeWithSynonyms(text, tz, {
    name:     ["name", "task name", "milestone", "title"],
    planned:  ["planned_at", "due", "due date", "finish", "finish date", "end", "date"],
    start:    ["planned_start_at", "planned_start", "start", "start date"],
    id:       ["external_ref", "id", "ref"],
    pct:      ["% complete", "percent complete", "complete"],
    desc:     ["description", "notes"],
    weight:   ["weight"],
    outline:  ["outline level", "outline_level", "level"],
    wbs:      ["wbs"],
    pred:     ["predecessors", "predecessor", "preds", "depends_on", "depends on"],
  }, "csv");
}

interface SynonymSpec {
  name: string[];
  planned: string[];
  start?: string[];
  id?: string[];
  pct?: string[];
  desc?: string[];
  weight?: string[];
  outline?: string[];
  wbs?: string[];
  pred?: string[];
}

function parseCsvLikeWithSynonyms(text: string, tz: string, syn: SynonymSpec, refTag: string): { rows: ParsedMilestone[]; warnings: string[] } {
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
  const iStart   = syn.start   ? findCol(syn.start)   : -1;
  const iId      = syn.id      ? findCol(syn.id)      : -1;
  const iPct     = syn.pct     ? findCol(syn.pct)     : -1;
  const iDesc    = syn.desc    ? findCol(syn.desc)    : -1;
  const iWeight  = syn.weight  ? findCol(syn.weight)  : -1;
  const iOutline = syn.outline ? findCol(syn.outline) : -1;
  const iWbs     = syn.wbs     ? findCol(syn.wbs)     : -1;
  const iPred    = syn.pred    ? findCol(syn.pred)    : -1;

  if (iName < 0 || iPlanned < 0) {
    warnings.push(`Couldn't find required columns. Expected something like "${syn.name[0]}" and "${syn.planned[0]}" — got: ${header.join(", ")}`);
    return { rows, warnings };
  }

  // Columns we've claimed for first-class fields. Everything else is
  // an org-specific column (WO#, contractor, area, …) and gets carried
  // into attributes keyed by its header so nothing is silently lost.
  const claimed = new Set([iName, iPlanned, iStart, iId, iPct, iDesc, iWeight, iOutline, iWbs, iPred].filter((x) => x >= 0));
  const extraCols = header.map((h, idx) => ({ h, idx })).filter((c) => c.idx >= 0 && !claimed.has(c.idx) && c.h);
  const resourceCol = findCol(["resource names", "resource_names", "resources", "resource"]);
  const woCol = extraCols.find((c) => /work\s*order|^wo$|wo\s*#|wo[_-]?num|order\s*#/i.test(c.h))?.idx ?? -1;
  const locCol = extraCols.find((c) => /location|area|unit|equipment|tag/i.test(c.h))?.idx ?? -1;

  // Day-first or month-first, decided per file from the dates themselves.
  const dateCells = (idx: number) => idx < 0 ? [] : lines.slice(1).map((l) => (csvSplit(l, delim)[idx] ?? "").trim().replace(/^"|"$/g, ""));
  const order = dayFirstColumn([...dateCells(iPlanned), ...dateCells(iStart)]);
  if (order.dayFirst) warnings.push("Dates read as day/month/year (the file has dates like 15/08 that only work that way).");
  if (order.ambiguous) warnings.push("Some dates only work as day/month and others only as month/day — check the dates after import.");
  let badDates = 0;
  let roughLinks = 0;

  let dropped = 0;
  let rowIndex = 0; // stable index used for synthetic refs / hierarchy
  for (let i = 1; i < lines.length; i++) {
    const cells = csvSplit(lines[i], delim);
    const cell = (idx: number) => (idx >= 0 ? cells[idx]?.trim().replace(/^"|"$/g, "") : "");
    const name = cell(iName);
    const planned = cell(iPlanned);
    if (!name || !planned) { dropped++; continue; }
    const startRaw = cell(iStart);
    const id     = cell(iId);
    const pctRaw = iPct >= 0 ? cells[iPct]?.trim().replace(/[%"]/g, "") : "";
    const desc   = cell(iDesc);
    const wRaw   = cell(iWeight);
    const outRaw = iOutline >= 0 ? cells[iOutline]?.trim().replace(/[^0-9]/g, "") : "";
    const wbsRaw = cell(iWbs);
    const weight = wRaw ? Number(wRaw) : 1;
    const pct = pctRaw ? Number(pctRaw) : NaN;
    const outlineLevel = outRaw ? Number(outRaw) : null;

    const attributes: Record<string, string> = {};
    for (const c of extraCols) { const v = cell(c.idx); if (v) attributes[c.h] = v; }
    const resources = resourceCol >= 0 ? cell(resourceCol) : "";

    // Predecessors column → finish-to-start deps. Values look like "2",
    // "2,3", or "2FS,3SS+1d"; take the leading id of each token. Only
    // resolvable when the file has an id column (so refs line up); otherwise
    // they're left for the user to wire up manually rather than mis-linked.
    let dependsOnExternalRefs: string[] | undefined;
    let linksByRef: Record<string, LinkSpec> | undefined;
    if (iPred >= 0 && iId >= 0) {
      const raw = cell(iPred);
      if (raw) {
        // ";" separates links when present ("2FS+1,5d;3" has a decimal comma).
        const parsed = raw.split(raw.includes(";") ? ";" : ",").map((tok) => parseLinkToken(tok.replace(/(\d),(\d)/g, "$1.$2"))).filter((x): x is NonNullable<typeof x> => !!x);
        if (parsed.length) dependsOnExternalRefs = parsed.map((p) => `${refTag}:${p.id}`);
        for (const p of parsed) if (p.link.type !== "FS" || p.link.lagHours) (linksByRef ??= {})[`${refTag}:${p.id}`] = p.link;
        roughLinks += parsed.filter((p) => p.approx).length;
      }
    }

    const plannedIso = coerceIsoStrict(planned, tz, order.dayFirst);
    if (!plannedIso) { badDates++; dropped++; continue; }
    const startIso = startRaw ? coerceIsoStrict(startRaw, tz, order.dayFirst) : null;
    if (startRaw && !startIso) badDates++;
    rows.push({
      name,
      plannedAt: plannedIso,
      plannedStartAt: startIso,
      weight: isNaN(weight) ? 1 : weight,
      // Always give CSV rows a stable ref so hierarchy can be wired up
      // even when the file has no id column.
      externalRef: id ? `${refTag}:${id}` : `${refTag}-row:${rowIndex}`,
      description: desc || null,
      percentComplete: isNaN(pct) ? undefined : pct,
      outlineLevel,
      wbs: wbsRaw || null,
      dependsOnExternalRefs,
      linksByRef,
      workOrderRef: woCol >= 0 ? cell(woCol) || null : null,
      responsibleParty: resources || null,
      location: locCol >= 0 ? cell(locCol) || null : null,
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    });
    rowIndex++;
  }

  // If the export carried an outline-level column, rebuild the WBS
  // from it: parent links, summary flags, rolled-up summary spans.
  const hasOutline = rows.some((r) => (r.outlineLevel ?? 0) > 1);
  if (hasOutline) {
    reconstructHierarchyFromOutline(rows);
    markStructuralSummaries(rows);
    rollUpSummaryDates(rows);
    computeOutlineLevels(rows);
  }

  // No id column: key each row by its place in the outline and its name
  // (not its line number), so inserting a row in the spreadsheet doesn't
  // slide every later row's progress and comments onto the wrong task.
  if (iId < 0) stableRowKeys(rows, refTag);

  if (roughLinks > 0) warnings.push(`${roughLinks} predecessor link${roughLinks === 1 ? "" : "s"} had a lag that can't be kept (like a % of the other task) or text that couldn't be read — kept as plain finish-to-start. Check ${roughLinks === 1 ? "it" : "them"} on the task.`);
  if (badDates > 0) warnings.push(`${badDates} date${badDates === 1 ? "" : "s"} couldn't be read (like a month 13 or Feb 30) — ${badDates === 1 ? "that row was" : "those rows were"} skipped or left without a start.`);
  if (dropped - badDates > 0) warnings.push(`${dropped - badDates} row${dropped - badDates === 1 ? "" : "s"} skipped (missing name or date).`);
  return { rows, warnings };
}

/** Replace line-number refs with keys from each row's outline path and
 *  name ("csv-key:e-12 › pull bundle"), numbering exact repeats. Parent
 *  links follow the new keys. */
function stableRowKeys(rows: ParsedMilestone[], refTag: string): void {
  const byRef = new Map(rows.filter((r) => r.externalRef).map((r) => [r.externalRef!, r]));
  const norm = (x: string) => x.trim().replace(/\s+/g, " ").toLowerCase();
  const pathOf = (r: ParsedMilestone): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (let cur: ParsedMilestone | undefined = r; cur && !seen.has(cur.externalRef ?? ""); cur = cur.parentExternalRef ? byRef.get(cur.parentExternalRef) : undefined) {
      seen.add(cur.externalRef ?? "");
      names.unshift(norm(cur.name));
    }
    return names.join(" › ");
  };
  const counts = new Map<string, number>();
  const rename = new Map<string, string>();
  for (const r of rows) {
    const base = r.wbs ? `wbs ${norm(r.wbs)}` : pathOf(r);
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    // Repeats are numbered after a mark no task name uses (\u241F), so
    // "Heater #1" stays its own name.
    if (r.externalRef) rename.set(r.externalRef, `${refTag}-key:${base}${n > 1 ? `\u241F${n}` : ""}`);
  }
  for (const r of rows) {
    if (r.externalRef) r.externalRef = rename.get(r.externalRef) ?? r.externalRef;
    if (r.parentExternalRef) r.parentExternalRef = rename.get(r.parentExternalRef) ?? r.parentExternalRef;
  }
}

// ─── Hierarchy helpers (shared across P6 + CSV) ─────────────────
//
// Imported schedules carry hierarchy in three different shapes:
//   * MS Project XML / MPP — explicit OutlineLevel per task.
//   * Primavera           — a separate WBS table; activities point
//                           at a WBS node, WBS nodes point at parents.
//   * CSV                 — usually just an "Outline Level" column.
//
// All three normalize to the same thing: each row gets an
// externalRef and (when it has a parent) a parentExternalRef. These
// two helpers then (a) roll start/finish up onto summary rows that
// carry no dates of their own (every P6 WBS node), and (b) compute a
// 1-based outline level from the parent chain so the Execution view
// can sort and indent faithfully.

/** Roll start/finish up onto summary / parent rows from their
 *  descendants. P6 WBS nodes and reconstructed CSV parents have no
 *  dates of their own — their span is the envelope of everything
 *  beneath them. Leaf rows and rows that already carry explicit
 *  dates are left untouched. */
function rollUpSummaryDates(rows: ParsedMilestone[]): void {
  const byRef = new Map<string, ParsedMilestone>();
  for (const r of rows) if (r.externalRef) byRef.set(r.externalRef, r);
  const childrenOf = new Map<string, ParsedMilestone[]>();
  for (const r of rows) {
    if (!r.parentExternalRef) continue;
    const arr = childrenOf.get(r.parentExternalRef) ?? [];
    arr.push(r);
    childrenOf.set(r.parentExternalRef, arr);
  }

  const memo = new Map<string, { start: number; finish: number } | null>();
  const inProgress = new Set<string>();
  function span(ref: string): { start: number; finish: number } | null {
    if (memo.has(ref)) return memo.get(ref)!;
    if (inProgress.has(ref)) return null; // cycle guard
    inProgress.add(ref);
    const node = byRef.get(ref);
    let start = Infinity;
    let finish = -Infinity;
    if (node) {
      const ownS = node.plannedStartAt ? Date.parse(node.plannedStartAt) : NaN;
      const ownF = node.plannedAt ? Date.parse(node.plannedAt) : NaN;
      if (Number.isFinite(ownS)) start = Math.min(start, ownS);
      if (Number.isFinite(ownF)) finish = Math.max(finish, ownF);
      for (const k of childrenOf.get(ref) ?? []) {
        if (!k.externalRef) continue;
        const e = span(k.externalRef);
        if (e) { start = Math.min(start, e.start); finish = Math.max(finish, e.finish); }
      }
    }
    inProgress.delete(ref);
    const result = Number.isFinite(start) && Number.isFinite(finish) ? { start, finish } : null;
    memo.set(ref, result);
    return result;
  }

  for (const r of rows) {
    if (!r.externalRef) continue;
    const isParent = (childrenOf.get(r.externalRef)?.length ?? 0) > 0;
    if (!r.isSummary && !isParent) continue;
    const e = span(r.externalRef);
    if (!e) continue;
    // Only fill what's missing — never shrink an explicit summary span.
    if (!r.plannedStartAt) r.plannedStartAt = new Date(e.start).toISOString();
    if (!r.plannedAt) r.plannedAt = new Date(e.finish).toISOString();
  }
}

/** Compute a 1-based outline level for every row from its parent
 *  chain. Top-level rows are level 1. */
function computeOutlineLevels(rows: ParsedMilestone[]): void {
  const byRef = new Map<string, ParsedMilestone>();
  for (const r of rows) if (r.externalRef) byRef.set(r.externalRef, r);
  const depthOf = (r: ParsedMilestone, seen: Set<string>): number => {
    if (!r.parentExternalRef) return 1;
    if (r.externalRef && seen.has(r.externalRef)) return 1; // cycle guard
    if (r.externalRef) seen.add(r.externalRef);
    const p = byRef.get(r.parentExternalRef);
    if (!p) return 1;
    return 1 + depthOf(p, seen);
  };
  for (const r of rows) r.outlineLevel = depthOf(r, new Set());
}

/** Mark any row that is the parent of another row as a summary. Used
 *  by the CSV path, where summary-ness is implied by structure rather
 *  than an explicit flag. */
function markStructuralSummaries(rows: ParsedMilestone[]): void {
  const parents = new Set<string>();
  for (const r of rows) if (r.parentExternalRef) parents.add(r.parentExternalRef);
  for (const r of rows) if (r.externalRef && parents.has(r.externalRef)) r.isSummary = true;
}

/** Reconstruct parent links from a flat, outline-ordered list using
 *  each row's outlineLevel. Rows MUST be in document/outline order
 *  (true for MS Project XML/MPP/CSV exports). The most recent row at
 *  a shallower level becomes the parent. Rows that already carry a
 *  parentExternalRef are left untouched, so this only *fills gaps* —
 *  e.g. the MPXJ converter bug that orphans every top-level phase
 *  because their parent is the project-summary row (MS Project ID 0).
 *  Every row must already have an externalRef. */
export function reconstructHierarchyFromOutline<T extends {
  externalRef?: string | null;
  parentExternalRef?: string | null;
  outlineLevel?: number | null;
}>(rows: T[]): void {
  const recentByLevel = new Map<number, string>();
  for (const r of rows) {
    const lvl = r.outlineLevel ?? 1;
    if (r.externalRef && !r.parentExternalRef) {
      for (let l = lvl - 1; l >= 0; l--) {
        const p = recentByLevel.get(l);
        if (p && p !== r.externalRef) { r.parentExternalRef = p; break; }
      }
    }
    if (r.externalRef) {
      recentByLevel.set(lvl, r.externalRef);
      for (const k of Array.from(recentByLevel.keys())) if (k > lvl) recentByLevel.delete(k);
    }
  }
}

/** True for MS Project's literal placeholder name for an unnamed row.
 *  A planner who inserts a row but never names it leaves "<New Task>"
 *  behind — these carry no meaning and just clutter the board. */
export function isPlaceholderTaskName(name: string): boolean {
  return /^<\s*new\s+task\s*>$/i.test(name.trim());
}

/** Drop placeholder ("<New Task>") rows that are *leaves* — i.e. not
 *  the parent of any other row, so removing them never orphans real
 *  work. Returns the filtered list and how many were removed. */
export function dropPlaceholderLeaves<T extends {
  name: string; externalRef?: string | null; parentExternalRef?: string | null;
}>(rows: T[]): { rows: T[]; dropped: number } {
  const parents = new Set<string>();
  for (const r of rows) if (r.parentExternalRef) parents.add(r.parentExternalRef);
  const kept = rows.filter((r) => {
    if (!isPlaceholderTaskName(r.name)) return true;
    if (r.externalRef && parents.has(r.externalRef)) return true; // has children — keep
    return false;
  });
  return { rows: kept, dropped: rows.length - kept.length };
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
//   2026-08-15 · 2026-08-15T08:00:00 · 2026-08-15 08:00
//   8/15/2026 · 8/15/26 8:00 AM · Mon 8/15/26 8:00 PM · 8/15/2026 08:00:00
//   15/08/2026 when the column reads day-first (see dayFirstColumn)
// Schedule files write wall-clock times at the plant; they become instants
// in the project's zone — never the zone of whoever's browser imports them.
// An impossible date (month 13, Feb 30) is refused, not rolled over into
// another month: null, and the caller warns.
const SLASH_DATE = /^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?)?$/;

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function naiveParts(y: number, mo: number, d: number, h: number, mi: number, sec: number, tz: string): string | null {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const timed = h !== 0 || mi !== 0 || sec !== 0;
  return naiveToIso(`${pad(y, 4)}-${pad(mo)}-${pad(d)}${timed ? `T${pad(h)}:${pad(mi)}:${pad(sec)}` : ""}`, tz);
}

export function coerceIsoStrict(s: string, tz: string, dayFirst = false): string | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  // ISO date-time (with or without an offset) or a bare date.
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed)!;
    if (!validYmd(+m[1], +m[2], +m[3])) return null;
    return naiveToIso(trimmed, tz);
  }
  const m2 = trimmed.match(SLASH_DATE);
  if (m2) {
    const a = Number(m2[1]), b = Number(m2[2]);
    const yRaw = Number(m2[3]); const y = yRaw < 100 ? 2000 + yRaw : yRaw;
    const month = dayFirst ? b : a, day = dayFirst ? a : b;
    if (!validYmd(y, month, day)) return null;
    let h = m2[4] ? Number(m2[4]) : 0;
    const mi = m2[5] ? Number(m2[5]) : 0, sec = m2[6] ? Number(m2[6]) : 0;
    const ap = m2[7]?.toLowerCase().replace(/\./g, "");
    if (ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (ap === "pm" ? 12 : 0); }
    if (h > 23 || mi > 59 || sec > 59) return null;
    return naiveParts(y, month, day, h, mi, sec, tz);
  }
  // Anything else ("October 26, 2026 8:00 AM"): let Date read it, then take
  // the wall clock it read and place it in the plant's zone. Text carrying
  // its own offset or Z is a real instant and is kept as is.
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) return null;
  if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return d.toISOString();
  return naiveParts(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), tz);
}

/** Does a column of dates read day-first (15/08/2026)? Yes when some value
 *  only makes sense that way and none only makes sense month-first. */
export function dayFirstColumn(values: string[]): { dayFirst: boolean; ambiguous: boolean } {
  let onlyDayFirst = false, onlyMonthFirst = false;
  for (const v of values) {
    const m = v.trim().match(SLASH_DATE);
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2]);
    if (a > 12 && b <= 12) onlyDayFirst = true;
    if (b > 12 && a <= 12) onlyMonthFirst = true;
  }
  return { dayFirst: onlyDayFirst && !onlyMonthFirst, ambiguous: onlyDayFirst && onlyMonthFirst };
}

/** Lenient form for the XML / XER readers (their dates are ISO). */
function coerceIso(s: string, tz: string): string {
  return coerceIsoStrict(s, tz) ?? s.trim();
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
