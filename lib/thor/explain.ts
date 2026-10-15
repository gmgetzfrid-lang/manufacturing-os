// lib/thor/explain.ts — why a THOR file came up, in plain words.
//
// The search returns, per file, each word it hit and where ("tray:name",
// "prefrac:equipment", "drawing:folder"). This turns that, plus what the
// query required, into reasons a person can check at a glance:
//
//   "tray" in the file name
//   "prefrac" — equipment 2010.03 V-3 PREFRACTIONATOR TOWER
//   "drawing" — folder DRAWINGS
//   not: "tower"
//   in Crude Unit · PDF · equipment 2010.03 (V-3)

import { tokens } from "./tokens";
import { unitName, THOR_TYPES, type ThorQuery } from "./query";
import type { ThorFile, ThorVocabulary } from "./client";

export interface ThorReason {
  word?: string;
  where: "name" | "equipment" | "folder" | "missing" | "required" | "backup";
  text: string;
}

/** Backup and lock files: real files, but rarely what is wanted (ranked lower by the search too). */
export const BACKUP_EXTS = ["bak", "tmp", "dwl", "dwl2", "sv$"];

const ORDER: Record<ThorReason["where"], number> = { name: 0, equipment: 1, folder: 2, missing: 3, required: 4, backup: 5 };

/** The deepest folder whose name holds a token starting with `word`. */
function folderWith(folderRel: string, word: string): string | null {
  const segs = folderRel ? folderRel.split("/") : [];
  for (let i = segs.length - 1; i >= 0; i--) {
    if (tokens(segs[i]).some((t) => t.startsWith(word))) return segs[i];
  }
  return null;
}

export function explainThor(f: ThorFile, q: ThorQuery | null, vocab: ThorVocabulary | null, resolvedEquipment?: string[] | null): ThorReason[] {
  const out: ThorReason[] = [];
  const hit = new Map<string, string>();
  for (const m of f.matched_terms ?? []) {
    const i = m.lastIndexOf(":");
    if (i > 0) hit.set(m.slice(0, i), m.slice(i + 1));
  }
  const eqName = (n: string) => {
    const e = vocab?.equipment.find((x) => x.number === n);
    return e?.description ? `${n} ${e.description}` : n;
  };
  for (const [w, where] of hit) {
    if (where === "name") out.push({ word: w, where: "name", text: `"${w}" in the file name` });
    else if (where === "equipment") {
      const n = f.equipment_numbers[0];
      out.push({ word: w, where: "equipment", text: n ? `"${w}" — equipment ${eqName(n)}` : `"${w}" — its equipment's name` });
    } else {
      const seg = folderWith(f.folder_rel, w);
      out.push({ word: w, where: "folder", text: seg ? `"${w}" — folder ${seg}` : `"${w}" — in its folders` });
    }
  }
  for (const w of q?.terms ?? []) if (!hit.has(w)) out.push({ word: w, where: "missing", text: `not "${w}"` });

  // What it had to be, and is.
  const req: string[] = [];
  if (q?.units.length && f.unit_folder) req.push(`in ${unitName(f.unit_folder)}`);
  if (q?.types.length) {
    const t = THOR_TYPES.find((x) => x.exts.includes(f.ext));
    if (t) req.push(t.label);
  }
  if (resolvedEquipment?.length) {
    const n = f.equipment_numbers.find((x) => resolvedEquipment.includes(x));
    if (n) {
      const e = vocab?.equipment.find((x) => x.number === n);
      req.push(`equipment ${n}${e?.tags.length ? ` (${e.tags.join(", ")})` : ""}`);
    }
  }
  if (q?.after || q?.before) req.push(`modified ${q.after ? `after ${q.after}` : ""}${q.after && q.before ? " and " : ""}${q.before ? `before ${q.before}` : ""}`);
  if (req.length) out.push({ where: "required", text: req.join(" · ") });
  if (BACKUP_EXTS.includes(f.ext)) out.push({ where: "backup", text: `a backup copy (.${f.ext}) — ranked lower` });
  return out.sort((a, b) => ORDER[a.where] - ORDER[b.where]);
}

export const STRENGTH_LABEL = ["Weak", "Partial", "Strong"] as const;
