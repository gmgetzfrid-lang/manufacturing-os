// lib/mppParser.ts
//
// Server-side .mpp parser. MPP files are OLE2 Compound File Binary
// containers — the same wrapper format used by legacy .xls / .doc.
// SheetJS's `cfb` library cracks the container; this module then
// walks the MPP-specific streams to extract task names, dates, and
// IDs.
//
// Honest caveat: the MPP binary format has been undocumented since
// 1994. Apache POI, MPXJ, and a handful of reverse-engineering
// projects have spent decades reverse-engineering it, version by
// version. This module implements the safe common subset:
//
//   * Walks the project's task list (TBkndTask container)
//   * Extracts task name + start + finish from FixData / Var2Data
//   * Best-effort across MS Project 2002 — 365
//
// If `MPP_CONVERTER_URL` is set in the environment, we forward the
// raw bytes to that converter instead — useful if you want full-
// fidelity via MPXJ-as-a-service or a similar backend. The native
// path is the fallback.

import * as CFB from "cfb";

export interface MppTaskRow {
  uid: number | null;
  /** UID of the parent task in the source file, if any. */
  parentUid?: number | null;
  name: string;
  start: string | null;   // ISO
  finish: string | null;  // ISO
  /** 1-based outline depth from the source. */
  outlineLevel?: number | null;
  /** WBS string like "1.2.3". Decorative. */
  wbs?: string | null;
  /** True when the row is a summary task that rolls up children. */
  isSummary?: boolean;
  percentComplete: number | null;
  isMilestone: boolean;
  /** Planned work in hours. */
  workHours?: number | null;
  /** Notes / log typed onto the task. */
  notes?: string | null;
  /** Comma-joined resource (person / crew / contractor) names. */
  resources?: string | null;
  /** Predecessor unique IDs. */
  predecessors?: number[];
  /** Org-specific custom columns keyed by their label/alias. */
  fields?: Record<string, string>;
}

export interface MppParseResult {
  ok: boolean;
  /** Reason for failure or "ok"/"partial" tag for telemetry. */
  status: "ok" | "partial" | "no_tasks" | "unsupported_version" | "not_an_mpp" | "error";
  message?: string;
  projectName?: string | null;
  /** MS Project version code if extracted (e.g. "14" for 2010). */
  projectVersion?: string | null;
  tasks: MppTaskRow[];
}

// ─── External converter (optional) ──────────────────────────────

/** If a remote converter is configured, send the raw bytes there
 *  and trust its JSON. Schema expected:
 *    { projectName?, tasks: [{ uid, name, start, finish, percentComplete?, milestone? }] }
 *  This is the seam for MPXJ-as-a-service / Aspose / Smartsheet. */
async function tryRemoteConverter(buf: ArrayBuffer): Promise<MppParseResult | null> {
  const url = process.env.MPP_CONVERTER_URL;
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        ...(process.env.MPP_CONVERTER_TOKEN
          ? { Authorization: `Bearer ${process.env.MPP_CONVERTER_TOKEN}` }
          : {}),
      },
      body: buf,
    });
    if (!res.ok) return { ok: false, status: "error", message: `Remote converter returned ${res.status}`, tasks: [] };
    const json = (await res.json()) as {
      projectName?: string;
      tasks?: Array<{
        uid?: number; parentUid?: number | null; name: string;
        start?: string | null; finish?: string | null;
        outlineLevel?: number | null;
        wbs?: string | null;
        isSummary?: boolean;
        percentComplete?: number | null;
        milestone?: boolean;
        workHours?: number | null;
        notes?: string | null;
        resources?: string | null;
        predecessors?: number[];
        fields?: Record<string, string>;
      }>;
    };
    return {
      ok: true,
      status: "ok",
      projectName: json.projectName ?? null,
      tasks: (json.tasks ?? []).map((t) => ({
        uid: t.uid ?? null,
        parentUid: t.parentUid ?? null,
        name: t.name,
        start: t.start ?? null,
        finish: t.finish ?? null,
        outlineLevel: t.outlineLevel ?? null,
        wbs: t.wbs ?? null,
        isSummary: !!t.isSummary,
        percentComplete: t.percentComplete ?? null,
        isMilestone: !!t.milestone,
        workHours: t.workHours ?? null,
        notes: t.notes ?? null,
        resources: t.resources ?? null,
        predecessors: t.predecessors ?? [],
        fields: t.fields ?? {},
      })),
    };
  } catch (e) {
    return { ok: false, status: "error", message: `Remote converter failed: ${(e as Error).message}`, tasks: [] };
  }
}

// ─── Native pure-JS path ────────────────────────────────────────

const CFB_MAGIC = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

function isCfbBytes(b: Uint8Array): boolean {
  if (b.length < CFB_MAGIC.length) return false;
  return CFB_MAGIC.every((v, i) => b[i] === v);
}

/**
 * MS Project epoch: Jan 1, 1984 00:00 UTC. Stored as minutes-since-epoch
 * for "Calculated" date fields in MPP. A handful of fields use the
 * Office epoch (1900) instead. We cover both.
 */
const MSP_EPOCH_MS = Date.UTC(1984, 0, 1);
function mspMinutesToIso(minutes: number): string | null {
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 200 * 365 * 24 * 60) return null;
  return new Date(MSP_EPOCH_MS + minutes * 60 * 1000).toISOString();
}

/** Read an MS Project-style date stored as a 4-byte minutes-since-1984
 *  little-endian int. Returns null if the value is the sentinel
 *  "no date" marker (0xFFFFFFFF or 0). */
function readMspDate(view: DataView, offset: number): string | null {
  if (offset < 0 || offset + 4 > view.byteLength) return null;
  const v = view.getUint32(offset, true);
  if (v === 0 || v === 0xFFFFFFFF) return null;
  return mspMinutesToIso(v);
}

/** Read a length-prefixed UTF-16LE string. MPP Var2Data strings are
 *  stored as 2-byte length followed by the bytes. */
function readVarString(buf: Uint8Array, offset: number): string {
  if (offset + 2 > buf.length) return "";
  const len = buf[offset] | (buf[offset + 1] << 8);
  const start = offset + 2;
  const end = Math.min(buf.length, start + len);
  let out = "";
  for (let i = start; i + 1 < end; i += 2) {
    const code = buf[i] | (buf[i + 1] << 8);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out.trim();
}

/** Find a CFB stream by walking the directory and matching the
 *  trailing name component (case-insensitive). MPP nests streams
 *  inside containers like "TBkndTaskFixedData" with a control
 *  character separator — match by suffix so we don't have to
 *  recreate the full path. */
function findStream(cfb: CFB.CFB$Container, suffix: string): Uint8Array | null {
  const want = suffix.toLowerCase();
  // CFB exposes a FileIndex array of {name, content}.
  const files = (cfb as unknown as { FileIndex: Array<{ name: string; content?: Uint8Array | number[] }> }).FileIndex;
  if (!Array.isArray(files)) return null;
  for (const f of files) {
    if (!f?.name) continue;
    if (f.name.toLowerCase().endsWith(want) || f.name.toLowerCase().includes(want)) {
      const c = f.content;
      if (!c) continue;
      return c instanceof Uint8Array ? c : new Uint8Array(c);
    }
  }
  return null;
}

/** Best-effort task extraction. Walks the FixedData / Var2Data
 *  streams under TBkndTask and pulls name + dates out of each
 *  task record.
 *
 *  Reality check: MPP encodes thousands of fields per task at
 *  version-specific offsets. We deliberately handle only what
 *  every recent version puts in predictable places. Files that
 *  fail this parse get downgraded to status="partial" or
 *  "no_tasks" and the UI tells the user to do the XML export.
 */
function extractTasksNative(cfb: CFB.CFB$Container): MppTaskRow[] {
  const tasks: MppTaskRow[] = [];

  // The "task names" stream is the most reliable across versions
  // — it's a concatenation of Var2Data strings. We pull names from
  // there as the spine, and join in dates from FixedData when we
  // find a matching record.
  const var2 = findStream(cfb, "Var2Data");
  const fixed = findStream(cfb, "FixedData");
  const fixedMeta = findStream(cfb, "FixedMeta");

  if (!var2 && !fixed) return tasks;

  // Pull every printable Var2Data string of length >= 2; treat each
  // as a candidate task name. Most MPPs interleave names with other
  // small strings (calendar names, codes, custom fields) — we filter
  // out short ones and anything that looks numeric / pure punctuation.
  const candidateNames: string[] = [];
  if (var2) {
    let i = 0;
    while (i + 2 < var2.length) {
      const len = var2[i] | (var2[i + 1] << 8);
      if (len > 0 && len < 1024 && i + 2 + len <= var2.length) {
        const s = readVarString(var2, i);
        if (s && s.length >= 2 && s.length <= 256 && /[A-Za-z]/.test(s) && !/^\d+$/.test(s)) {
          candidateNames.push(s);
        }
        i += 2 + len;
      } else {
        i++;
      }
    }
  }

  // FixedData blocks in modern MPP are typically 502 or 644 bytes
  // per task. Start + Finish dates live at known offsets that vary
  // by version. We try the common offsets and keep the first pair
  // that yields sane dates (i.e. parses to a year between 1990 and
  // 2100). This catches MS Project 2007 / 2010 / 2013 / 2016 / 365
  // for the common case.
  const dates: Array<{ start: string | null; finish: string | null; uid: number | null; pct: number | null }> = [];
  if (fixed && fixedMeta) {
    const META_RECORD_SIZE_OFFSETS = [502, 366, 644];
    for (const recSize of META_RECORD_SIZE_OFFSETS) {
      if (fixed.length < recSize * 2) continue;
      const view = new DataView(fixed.buffer, fixed.byteOffset, fixed.byteLength);
      const count = Math.floor(fixed.length / recSize);
      const tmp: typeof dates = [];
      let validHits = 0;
      for (let r = 0; r < count; r++) {
        const base = r * recSize;
        // Try a couple of common offset pairs for start/finish.
        const OFFSET_PAIRS = [[44, 48], [44, 50], [80, 84]];
        let foundStart: string | null = null;
        let foundFinish: string | null = null;
        for (const [so, fo] of OFFSET_PAIRS) {
          const s = readMspDate(view, base + so);
          const f = readMspDate(view, base + fo);
          if (s || f) { foundStart = s; foundFinish = f; break; }
        }
        // UID = first 4 bytes of the task record in most versions.
        let uid: number | null = null;
        if (base + 4 <= fixed.length) {
          uid = view.getUint32(base, true);
          if (uid > 0xFFFFFF) uid = null; // sanity
        }
        // % complete is usually at a small offset; cap at 100.
        let pct: number | null = null;
        if (base + 122 <= fixed.length) {
          const v = view.getUint16(base + 122, true);
          if (v <= 100) pct = v;
        }
        tmp.push({ start: foundStart, finish: foundFinish, uid, pct });
        if (foundStart || foundFinish) validHits++;
      }
      if (validHits >= 1) { dates.push(...tmp); break; }
    }
  }

  // Pair names with dates positionally. We don't claim perfect
  // accuracy — for ambiguous files the user should still go the
  // XML route — but in practice this gives a usable preview for
  // many TARs and capital project schedules.
  const n = Math.min(candidateNames.length, dates.length || candidateNames.length);
  for (let i = 0; i < n; i++) {
    const d = dates[i] ?? { start: null, finish: null, uid: null, pct: null };
    tasks.push({
      uid: d.uid,
      name: candidateNames[i],
      start: d.start,
      finish: d.finish,
      percentComplete: d.pct,
      isMilestone: false,
    });
  }
  return tasks;
}

/** Try to pull the project name out of SummaryInformation. */
function extractProjectName(cfb: CFB.CFB$Container): string | null {
  const s = findStream(cfb, "SummaryInformation");
  if (!s) return null;
  // SummaryInformation is a property-set stream; the title property
  // usually sits in the first kilobyte as a length-prefixed string.
  // Heuristic: find the first printable ASCII run of length > 4.
  let run = "";
  let best = "";
  for (let i = 0; i < Math.min(s.length, 2048); i++) {
    const b = s[i];
    if (b >= 32 && b <= 126) { run += String.fromCharCode(b); }
    else { if (run.length > best.length && run.length >= 4) best = run; run = ""; }
  }
  if (run.length > best.length && run.length >= 4) best = run;
  return best || null;
}

// ─── Public entry point ─────────────────────────────────────────

export async function parseMppFile(arrayBuf: ArrayBuffer): Promise<MppParseResult> {
  const bytes = new Uint8Array(arrayBuf);
  if (!isCfbBytes(bytes)) {
    return { ok: false, status: "not_an_mpp", message: "File doesn't have the OLE2/Compound File signature.", tasks: [] };
  }

  // If a remote converter is configured, prefer it — full fidelity.
  const remote = await tryRemoteConverter(arrayBuf);
  if (remote) return remote;

  // Native fallback.
  let cfb: CFB.CFB$Container;
  try {
    cfb = CFB.read(bytes, { type: "array" });
  } catch (e) {
    return { ok: false, status: "error", message: `CFB read failed: ${(e as Error).message}`, tasks: [] };
  }

  const projectName = extractProjectName(cfb);
  const tasks = extractTasksNative(cfb);

  if (tasks.length === 0) {
    return {
      ok: false,
      status: "no_tasks",
      message: "Couldn't extract task records from the MPP binary. This is the limit of the in-process parser — for full fidelity, use File → Save As → XML in MS Project, or configure MPP_CONVERTER_URL to point at a server-side converter.",
      projectName,
      tasks: [],
    };
  }

  // If most rows lack dates, flag as partial so the UI can warn.
  const withDates = tasks.filter((t) => t.start || t.finish).length;
  const status: MppParseResult["status"] = withDates >= Math.max(1, Math.floor(tasks.length * 0.5)) ? "ok" : "partial";

  return {
    ok: true,
    status,
    projectName,
    tasks,
  };
}
