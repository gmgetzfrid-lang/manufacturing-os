// lib/estate/watchdog.ts — "that looks like it belongs somewhere else."
//
// Pure. At upload or folder-creation time, work out what a thing is (its
// unit, its document type) and where the estate already keeps things like
// it, then say so — once, politely, with the reason. Never blocks, never
// moves: the person files it there or keeps it here AND links it there
// (a filed_under edge, the symbolic link). Users are the wild card; this is
// the system actively resisting drift without getting in the way.

import { words } from "@/lib/fileFinder/tokens";
import { docTypesIn, docTypeByKey } from "@/lib/fileFinder/docTypes";
import { unitFromName, type ResolveContext } from "./resolver";

export interface HomeFolder {
  id: string;
  libraryId: string;
  libraryName: string;
  /** Names from the library root down to and including this folder. */
  chain: string[];
  chainIds: string[];
  /** Unit linked or named anywhere on the chain. */
  unitCode?: string;
}

export interface HomeTarget {
  kind: "document" | "folder";
  id: string;
  name: string;
  documentNumber?: string | null;
  /** Current folder chain ids (root first). */
  pathIds: string[];
  libraryId: string;
}

export interface HomeSuggestion {
  targetId: string;
  targetName: string;
  unitCode?: string;
  unitLabel?: string;
  docType?: string;
  docTypeLabel?: string;
  home: HomeFolder;
  reason: string;
  /** True when the thing is already somewhere that fits (no action needed). */
  alreadyHome: boolean;
}

function folderDocTypes(f: HomeFolder): Set<string> {
  const out = new Set<string>();
  for (const name of f.chain.slice(-2)) for (const t of docTypesIn(words(name))) out.add(t);
  return out;
}

/** What is it, and where do things like it live? */
export function suggestHome(t: HomeTarget, folders: HomeFolder[], ctx: ResolveContext): HomeSuggestion | null {
  const own = unitFromName(t.name, ctx);
  const dn = t.documentNumber ?? (t.kind === "document" ? t.name : null);
  const fromDrawing = dn && ctx.unitFromDrawingNumber ? ctx.unitFromDrawingNumber(dn) : null;
  const unitCode = fromDrawing ?? own?.code ?? null;
  const types = docTypesIn(words(t.name));
  const docType = types[0] ?? null;
  if (!unitCode && !docType) return null; // nothing to go on; silence beats a guess

  const unitLabel = unitCode ? ctx.units.find((u) => u.code === unitCode)?.label ?? unitCode : undefined;
  const typeLabel = docType ? docTypeByKey(docType)?.label ?? docType : undefined;

  // Score every folder as a possible home.
  let best: { f: HomeFolder; score: number; why: string[] } | null = null;
  for (const f of folders) {
    if (f.chainIds.includes(t.id)) continue; // never suggest a folder inside the thing itself
    const why: string[] = [];
    let score = 0;
    const fUnit = f.unitCode ?? unitFromName(f.chain[f.chain.length - 1], ctx)?.code;
    if (unitCode) {
      if (fUnit === unitCode) { score += 10; why.push(`it is the ${unitLabel} folder`); }
      else if (fUnit && fUnit !== unitCode) continue; // a different unit's folder is never the home
    }
    const ft = folderDocTypes(f);
    if (docType) {
      if (ft.has(docType)) { score += 8; why.push(`it holds ${typeLabel}s`); }
      else if (ft.size) continue; // a folder for another type is not the home
    }
    if (!score) continue;
    // Prefer the deeper, more specific match; prefer the same library.
    score += Math.min(3, f.chain.length) * 0.3;
    if (f.libraryId === t.libraryId) score += 0.5;
    if (!best || score > best.score) best = { f, score, why };
  }
  if (!best) return null;
  // Already somewhere that fits as well?
  const current = folders.find((f) => f.id === t.pathIds[t.pathIds.length - 1]);
  let alreadyHome = false;
  if (current) {
    const cUnit = current.unitCode ?? unitFromName(current.chain[current.chain.length - 1], ctx)?.code;
    const cTypes = folderDocTypes(current);
    alreadyHome = (!unitCode || cUnit === unitCode) && (!docType || cTypes.has(docType) || cTypes.size === 0);
  }
  if (best.f.id === current?.id) alreadyHome = true;
  const what = [typeLabel ? `a ${typeLabel}` : t.kind === "folder" ? "a folder" : "a file", unitLabel ? `for ${unitLabel}` : ""].filter(Boolean).join(" ");
  return {
    targetId: t.id, targetName: t.name, unitCode: unitCode ?? undefined, unitLabel, docType: docType ?? undefined, docTypeLabel: typeLabel,
    home: best.f, alreadyHome,
    reason: `"${t.name}" looks like ${what}; ${[best.f.libraryName, ...best.f.chain].join(" / ")} is where those live (${best.why.join(", ")}).`,
  };
}
