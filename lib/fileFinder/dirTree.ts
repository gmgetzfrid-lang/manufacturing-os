// lib/fileFinder/dirTree.ts — a pasted directory listing becomes an index.
//
// The network drive is not crawled. Someone runs `tree /f`, `dir /s`, or
// `tree` on it, or exports a list of paths, and pastes the text here. What
// comes out is a flat list of files with their folder path, size and date
// when the listing carried them — enough to say "it's not in the system, but
// the Thor drive has prospects at these paths".
//
// Four formats, detected per paste:
//   * plain paths     \\thor\eng\Crude\U1A.pdf   or  T:\Crude\U1A.pdf  or /mnt/x/y.pdf
//   * dir /s          " Directory of T:\Crude" headers, then dated rows
//   * tree /f (win)   ├───Folder / │   file.pdf / \---Folder  (also +--- and \---)
//   * tree (unix)     ├── name / └── name / │   indentation

export interface ListedFile {
  /** Folder segments from the listing root, excluding the file name. */
  path: string[];
  name: string;
  sizeBytes?: number;
  /** ISO-ish date (YYYY-MM-DD) when the listing carried one. */
  date?: string;
  /** SHA-256 of the bytes, when the listing came from the scanner. */
  hash?: string;
}

export interface ParsedListing {
  files: ListedFile[];
  /** Folders seen, including empty ones, as joined paths. */
  folders: string[];
  format: "paths" | "dir" | "tree-win" | "tree-unix" | "scan" | "empty";
  warnings: string[];
}

const hasExt = (name: string) => /\.[A-Za-z0-9]{1,6}$/.test(name) && !/\.$/.test(name);

function splitPath(p: string): string[] {
  return p.replace(/^\\\\\?\\/, "").split(/[\\/]+/).filter(Boolean);
}

function parseDirDate(s: string): string | undefined {
  // 01/15/2019 or 2019-01-15 or 15.01.2019
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{1,2})[/.](\d{1,2})[/.](\d{4})/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    // Prefer month/day (dir /s default locale); swap when the first part can't be a month.
    const month = a > 12 ? b : a, day = a > 12 ? a : b;
    return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return undefined;
}

function parsePlainPaths(lines: string[]): ParsedListing {
  const files: ListedFile[] = [];
  const folders = new Set<string>();
  for (const line of lines) {
    // Optional trailing "  12345" size or "\t2019-01-15" date columns.
    const m = line.match(/^(.*?)(?:\s+(\d[\d,]*)\s*(?:bytes|b|kb|mb)?)?(?:\s+(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}))?\s*$/i);
    const p = (m?.[1] ?? line).trim();
    const segs = splitPath(p);
    if (!segs.length) continue;
    // Drop a drive letter / server root ("T:", "thor", "eng" stay as folders;
    // only the bare drive letter goes).
    if (/^[A-Za-z]:$/.test(segs[0])) segs.shift();
    const last = segs[segs.length - 1];
    const isDir = p.endsWith("\\") || p.endsWith("/") || !hasExt(last);
    if (isDir) { folders.add(segs.join("/")); continue; }
    const path = segs.slice(0, -1);
    for (let i = 1; i <= path.length; i++) folders.add(path.slice(0, i).join("/"));
    const f: ListedFile = { path, name: last };
    if (m?.[2]) {
      let n = Number(m[2].replace(/,/g, ""));
      const unit = line.match(/\d\s*(kb|mb)\b/i)?.[1]?.toLowerCase();
      if (unit === "kb") n *= 1024; else if (unit === "mb") n *= 1024 * 1024;
      f.sizeBytes = n;
    }
    if (m?.[3]) f.date = parseDirDate(m[3]);
    files.push(f);
  }
  return { files, folders: [...folders], format: "paths", warnings: [] };
}

function parseDirS(lines: string[]): ParsedListing {
  const files: ListedFile[] = [];
  const folders = new Set<string>();
  let cur: string[] | null = null;
  let root: string[] | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const dm = line.match(/^\s*Directory of\s+(.+)$/i);
    if (dm) {
      const segs = splitPath(dm[1]);
      if (/^[A-Za-z]:$/.test(segs[0])) segs.shift();
      if (!root) root = segs;
      cur = segs;
      folders.add(segs.join("/"));
      continue;
    }
    if (!cur) continue;
    // 01/15/2019  03:22 PM           1,234,567 U1A.pdf
    // 01/15/2019  03:22 PM    <DIR>          Heaters
    const rm = line.match(/^\s*(\S+)\s+(\d{1,2}:\d{2}(?:\s*[AP]M)?)\s+(<DIR>|[\d,]+)\s+(.+)$/i);
    if (!rm) continue;
    const name = rm[4].trim();
    if (rm[3].toUpperCase() === "<DIR>") {
      if (name !== "." && name !== "..") folders.add([...cur, name].join("/"));
      continue;
    }
    files.push({ path: cur, name, sizeBytes: Number(rm[3].replace(/,/g, "")), date: parseDirDate(rm[1]) });
  }
  return { files, folders: [...folders], format: "dir", warnings: [] };
}

/** Windows `tree /f`: depth = count of 4-char columns before the name. */
function parseTreeWin(lines: string[]): ParsedListing {
  const files: ListedFile[] = [];
  const folders = new Set<string>();
  const stack: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (/^Folder PATH listing/i.test(line) || /^Volume serial number/i.test(line)) continue;
    // Root line like "T:." or "T:\" or "\\thor\eng"
    if (/^[A-Za-z]:[.\\]?$/.test(line.trim()) || /^\\\\/.test(line.trim())) continue;
    // Folder: ├───Name, └───Name, +---Name, \---Name, possibly prefixed by │/| columns.
    const fm = line.match(/^((?:[│|]\s{3}|\s{4})*)[├└+\\]─{3}(.+)$/) ?? line.match(/^((?:[│|]\s{3}|\s{4})*)[├└+\\]-{3}(.+)$/);
    if (fm) {
      const depth = Math.round(fm[1].length / 4);
      stack.length = depth;
      stack[depth] = fm[2].trim();
      folders.add(stack.slice(0, depth + 1).join("/"));
      continue;
    }
    // File: prefix columns then the name, no branch glyph.
    const fileM = line.match(/^((?:[│|]\s{3}|\s{4})+)(.+)$/);
    if (fileM) {
      const depth = Math.round(fileM[1].length / 4);
      const path = stack.slice(0, depth);
      files.push({ path, name: fileM[2].trim() });
      continue;
    }
    // Files directly under the root have no prefix at all.
    if (!/^[├└│|+\\-]/.test(line) && hasExt(line.trim())) files.push({ path: [], name: line.trim() });
  }
  return { files, folders: [...folders], format: "tree-win", warnings: [] };
}

/** Unix `tree`: ├── name / └── name, 4 chars per depth. A line with no
 *  extension that has children is a folder; a leaf with an extension is a file. */
function parseTreeUnix(lines: string[]): ParsedListing {
  type Row = { depth: number; name: string };
  const rows: Row[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (/^\d+ director(y|ies)/.test(line.trim())) continue;
    const m = line.match(/^((?:│\s{3}|\|\s{3}|\s{4})*)[├└][─-]{2}\s(.+)$/);
    if (m) { rows.push({ depth: Math.round(m[1].length / 4) + 1, name: m[2].trim() }); continue; }
    if (!/^[├└│|]/.test(line) && !/^\s/.test(line)) rows.push({ depth: 0, name: line.trim().replace(/[\\/]+$/, "") });
  }
  const files: ListedFile[] = [];
  const folders = new Set<string>();
  const stack: string[] = [];
  rows.forEach((r, i) => {
    const next = rows[i + 1];
    const isDir = (next && next.depth > r.depth) || r.name.endsWith("/") || (!hasExt(r.name) && r.depth === 0);
    const name = r.name.replace(/\/$/, "");
    stack.length = r.depth;
    if (isDir || (!hasExt(name) && !(next && next.depth > r.depth))) {
      // Treat extension-less leaves as folders too — a listing rarely has files without extensions.
      stack[r.depth] = name;
      if (r.depth > 0) folders.add(stack.slice(1, r.depth + 1).join("/"));
      return;
    }
    files.push({ path: stack.slice(1, r.depth), name });
  });
  return { files, folders: [...folders], format: "tree-unix", warnings: [] };
}

/** The scanner's JSON (scripts/thor-scan.mjs): paths, sizes, dates and hashes. */
function parseScanJson(text: string): ParsedListing | null {
  try {
    const j = JSON.parse(text) as { format?: string; files?: Array<Partial<ListedFile> & { path?: unknown }>; folders?: unknown };
    if (!j || !Array.isArray(j.files)) return null;
    const files: ListedFile[] = [];
    for (const f of j.files) {
      if (!f || typeof f.name !== "string") continue;
      const path = Array.isArray(f.path) ? (f.path as unknown[]).map(String) : [];
      const row: ListedFile = { path, name: f.name };
      if (typeof f.sizeBytes === "number") row.sizeBytes = f.sizeBytes;
      if (typeof f.date === "string") row.date = f.date;
      if (typeof f.hash === "string" && /^[0-9a-f]{32,128}$/i.test(f.hash)) row.hash = f.hash.toLowerCase();
      files.push(row);
    }
    const folders = new Set<string>(Array.isArray(j.folders) ? (j.folders as unknown[]).map(String) : []);
    for (const f of files) for (let i = 1; i <= f.path.length; i++) folders.add(f.path.slice(0, i).join("/"));
    return { files, folders: [...folders], format: "scan", warnings: j.format === "thor-scan/1" ? [] : ["JSON listing without a thor-scan format marker - read anyway."] };
  } catch { return null; }
}

export function parseDirectoryListing(text: string): ParsedListing {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) { const scan = parseScanJson(trimmed); if (scan) return scan; }
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim().length > 0);
  if (!lines.length) return { files: [], folders: [], format: "empty", warnings: [] };
  if (lines.some((l) => /^\s*Directory of\s+/i.test(l))) return parseDirS(lines);
  if (lines.some((l) => /[├└+\\]─{3}|^[├└+\\]-{3}/.test(l)) && !lines.some((l) => /[├└]──\s/.test(l))) return parseTreeWin(lines);
  if (lines.some((l) => /[├└][─-]{2}\s/.test(l))) return parseTreeUnix(lines);
  const out = parsePlainPaths(lines);
  if (!out.files.length) out.warnings.push("No file lines recognised. Paste the output of `tree /f`, `dir /s`, `tree`, or one full path per line.");
  return out;
}
