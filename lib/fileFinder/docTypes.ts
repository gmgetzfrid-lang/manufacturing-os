// lib/fileFinder/docTypes.ts — what KIND of document, in the words people use.
//
// Nobody searching for a drawing types "2002-D 2001_SHT05". They type
// "crude P&ID sheet 5". So the finder has to know that P&ID, PID, "P and
// ID" and "piping and instrumentation" are one kind of drawing, that a
// folder called "P&ID's" holds that kind, and that "sheet 5", "sht 5",
// "SHT05" and "page 5" all mean the fifth sheet. Pure vocabulary, no I/O.

export interface DocType {
  key: string;
  label: string;
  /** Lower-case single words that name it ("pid", "pfd", "iso"). */
  words: string[];
  /** Lower-case phrases that name it ("piping and instrumentation"). */
  phrases: string[];
}

export const DOC_TYPES: DocType[] = [
  { key: "pid", label: "P&ID", words: ["pid", "pids", "pandid"], phrases: ["p and id", "piping and instrumentation", "piping instrumentation", "process and instrumentation"] },
  { key: "pfd", label: "PFD", words: ["pfd", "pfds"], phrases: ["process flow diagram", "process flow", "flow diagram"] },
  { key: "iso", label: "Isometric", words: ["iso", "isos", "isometric", "isometrics"], phrases: ["piping isometric", "pipe iso"] },
  { key: "plot", label: "Plot plan", words: ["plotplan"], phrases: ["plot plan", "plot plans", "site plan", "equipment location"] },
  { key: "ga", label: "General arrangement", words: ["ga", "gad"], phrases: ["general arrangement", "general arrangement drawing"] },
  { key: "oneline", label: "One-line", words: ["oneline", "singleline", "sld"], phrases: ["one line", "single line", "one line diagram", "single line diagram"] },
  { key: "loop", label: "Loop drawing", words: [], phrases: ["loop drawing", "loop sheet", "loop diagram", "instrument loop"] },
  { key: "datasheet", label: "Datasheet", words: ["datasheet", "datasheets", "dsht"], phrases: ["data sheet", "data sheets", "spec sheet"] },
  { key: "spec", label: "Specification", words: ["spec", "specs", "specification", "specifications"], phrases: [] },
  { key: "procedure", label: "Procedure", words: ["sop", "sops", "procedure", "procedures"], phrases: ["operating procedure", "work instruction"] },
  { key: "moc", label: "MOC", words: ["moc", "mocs"], phrases: ["management of change"] },
  { key: "manual", label: "Manual", words: ["manual", "manuals", "iom"], phrases: ["vendor manual", "operating manual", "instruction manual"] },
  { key: "asbuilt", label: "As-built", words: ["asbuilt", "asbuilts"], phrases: ["as built", "as builts"] },
  { key: "report", label: "Report", words: ["report", "reports"], phrases: ["inspection report", "test report"] },
  { key: "cert", label: "Certificate", words: ["cert", "certs", "certificate", "certificates", "mtr"], phrases: ["mill cert", "material test report"] },
];

const byWord = new Map<string, DocType>();
for (const t of DOC_TYPES) for (const w of t.words) byWord.set(w, t);

export function docTypeByKey(key: string): DocType | undefined {
  return DOC_TYPES.find((t) => t.key === key);
}

/** Doc-type keys named by a list of lower-case words (already stemmed or
 *  not — both plural and singular forms are in the vocabulary). Phrases are
 *  checked against the joined text. */
export function docTypesIn(words: string[]): string[] {
  const out = new Set<string>();
  for (const w of words) { const t = byWord.get(w); if (t) out.add(t.key); }
  const text = ` ${words.join(" ")} `;
  for (const t of DOC_TYPES) for (const p of t.phrases) if (text.includes(` ${p} `)) out.add(t.key);
  return [...out];
}

/** "sheet 5", "sht 5", "sh 05", "page 5", "pg5", "SHT05", "sheet5of12" → 5.
 *  Returns every sheet number mentioned, in order. */
export function sheetNumbersIn(text: string): number[] {
  const out: number[] = [];
  // Not \b: underscores are word characters, and "_SHT05_" is the common case.
  for (const m of text.matchAll(/(?<![A-Za-z0-9])(?:sheet|sht|sh|page|pg)\s*[-_.#]?\s*(\d{1,3})(?![0-9])/gi)) out.push(Number(m[1]));
  return out;
}

/** "rev 3", "revision C", "R3", "rev. 02", "RevA" → "3" / "C" / "02" / "A".
 *  A bare "R" + digits is only read as a revision when it is its own token. */
export function revisionsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![A-Za-z0-9])(?:rev(?:ision)?\.?\s*[-_#]?\s*|r)([A-Z]{1,2}|\d{1,3}[A-Z]?)(?![A-Za-z0-9])/gi)) out.push(m[1].toUpperCase());
  return out;
}

/** "3" and "03" are the same revision; "a" and "A" too. */
export const canonicalRev = (r: string) => r.toUpperCase().replace(/^0+(\d)/, "$1");
