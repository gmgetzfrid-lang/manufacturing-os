// lib/estate/resolver.ts — what is this thing, and what is it connected to?
//
// Pure. Given a folder or a document (its name, the folder chain above it,
// what its name decodes to, what was read off its pages) plus the org's
// vocabulary (codebook units, aliases, projects, assets), emit the edges a
// careful person would draw, each with a tier and a one-sentence reason:
//
//   "20 - Crude"              → belongs_to_unit cbunit:20     provable (codebook)
//   "Born" (alias → Crude)    → belongs_to_unit cbunit:20     strong   (alias)
//   "2002-D-2001_SHT05.pdf"   → belongs_to_unit cbunit:20     provable (drawing number)
//   "AFE200155 heater"        → in_project proj:<id>          strong   (project named)
//   folder "X-35"             → about_asset asset:<id>        strong   (registry tag)
//   "born-u1a.pdf"            → tagged_to asset:<U1A id>      strong   (code in name)
//
// Nothing here writes. The server shell decides what applies (provable) and
// what waits for a human (strong, inferred), and never overwrites a human
// decision. Everything is unit-tested in lib/__tests__/estateResolver.test.ts.

import { canonicalForm, findCodes } from "@/lib/fileFinder/tagForms";
import { words, isStopword } from "@/lib/fileFinder/tokens";
import { docTypesIn } from "@/lib/fileFinder/docTypes";
import { wordNamesUnit, type UnitLike } from "@/lib/fileFinder/queryParse";
import { aliasConfidence, type FinderAlias } from "@/lib/fileFinder/aliasTypes";
import { nid, type EdgeType, type EdgeTier, type EdgeOrigin } from "./ids";

export interface ResolveTarget {
  kind: "folder" | "document";
  id: string;
  name: string;
  /** Folder names above it, root first (NOT including itself). */
  path: string[];
  /** Folder ids matching `path`. */
  pathIds: string[];
  libraryName?: string;
  documentNumber?: string | null;
  /** Equipment tags read off its pages (canonical), when it has been read. */
  pageTags?: string[];
  versionId?: string | null;
}

export interface ResolveContext {
  units: UnitLike[];
  aliases: FinderAlias[];
  projects: Array<{ id: string; name: string }>;
  /** canonical tag → asset id */
  assets: Map<string, { id: string; tag: string }>;
  /** Decodes a drawing number to a unit code through the Site Codebook, or null. */
  unitFromDrawingNumber?: (raw: string) => string | null;
  /** Folder id → unit code already linked (applied edges), so children inherit. */
  folderUnits?: Map<string, string>;
  /** Folder id → project id already linked, so children inherit. */
  folderProjects?: Map<string, string>;
  /** Folder id → asset id it is the folder for (applied), so documents inherit. */
  folderAssets?: Map<string, string>;
}

export interface ProposedEdge {
  a: string;
  b: string;
  type: EdgeType;
  origin: EdgeOrigin;
  tier: EdgeTier;
  confidence: number;
  summary: string;
  evidence: Record<string, unknown>;
  versionId?: string | null;
}

function unitByCode(units: UnitLike[], code: string) { return units.find((u) => u.code === code); }

/** Which codebook unit does a single name point at, and how surely? */
export function unitFromName(name: string, ctx: ResolveContext): { code: string; via: "codebook" | "alias"; alias?: FinderAlias } | null {
  const ws = words(name);
  for (const w of ws) for (const u of ctx.units) if (wordNamesUnit(w, u)) return { code: u.code, via: "codebook" };
  // A bare leading code: "20 - Crude", "20_PIDs", "Unit 20".
  const lead = name.match(/^\s*(?:unit\s*)?(\d{1,4})\b/i);
  if (lead && unitByCode(ctx.units, lead[1])) return { code: lead[1], via: "codebook" };
  const canon = new Set(ws.map(canonicalForm));
  for (const a of ctx.aliases) {
    if (a.kind !== "unit") continue;
    if (!canon.has(a.termCanonical)) continue;
    const u = ctx.units.find((x) => canonicalForm(x.code) === a.meansCanonical || canonicalForm(x.label) === a.meansCanonical
      || words(x.label).some((lw) => canonicalForm(lw) === a.meansCanonical));
    if (u) return { code: u.code, via: "alias", alias: a };
  }
  return null;
}

/** The nearest unit above a target: its own linked folder, else the closest ancestor. */
function inheritedUnit(t: ResolveTarget, ctx: ResolveContext): { code: string; fromFolderId: string } | null {
  for (let i = t.pathIds.length - 1; i >= 0; i--) {
    const code = ctx.folderUnits?.get(t.pathIds[i]);
    if (code) return { code, fromFolderId: t.pathIds[i] };
  }
  return null;
}
function inheritedProject(t: ResolveTarget, ctx: ResolveContext): { id: string; fromFolderId: string } | null {
  for (let i = t.pathIds.length - 1; i >= 0; i--) {
    const id = ctx.folderProjects?.get(t.pathIds[i]);
    if (id) return { id, fromFolderId: t.pathIds[i] };
  }
  return null;
}

/** Projects whose name shares a code (AFE200155, P-1234) or a distinctive word with the text. */
function projectsNamed(text: string, ctx: ResolveContext): Array<{ id: string; name: string; via: string }> {
  const codes = new Set(findCodes(text).map((c) => c.canon));
  const out: Array<{ id: string; name: string; via: string }> = [];
  for (const p of ctx.projects) {
    const pcodes = findCodes(p.name).map((c) => c.canon);
    const hit = pcodes.find((c) => codes.has(c));
    if (hit) out.push({ id: p.id, name: p.name, via: hit });
  }
  return out;
}

export function resolveTarget(t: ResolveTarget, ctx: ResolveContext): ProposedEdge[] {
  const out: ProposedEdge[] = [];
  const self = t.kind === "folder" ? nid.folder(t.id) : nid.doc(t.id);
  const label = t.kind === "folder" ? `Folder "${t.name}"` : `"${t.name}"`;

  // ── Unit ────────────────────────────────────────────────────────────────
  const own = unitFromName(t.name, ctx);
  const dn = t.documentNumber ?? (t.kind === "document" ? t.name : null);
  const fromDrawing = dn && ctx.unitFromDrawingNumber ? ctx.unitFromDrawingNumber(dn) : null;
  const above = inheritedUnit(t, ctx);
  if (fromDrawing && unitByCode(ctx.units, fromDrawing)) {
    const u = unitByCode(ctx.units, fromDrawing)!;
    out.push({ a: self, b: nid.cbunit(u.code), type: "belongs_to_unit", origin: "codebook", tier: "provable", confidence: 1,
      summary: `Drawing number ${dn} decodes to ${u.label} (${u.code}) through the Site Codebook`,
      evidence: { drawingNumber: dn, unit: u.code }, versionId: t.versionId ?? null });
  } else if (own) {
    const u = unitByCode(ctx.units, own.code)!;
    if (own.via === "codebook") {
      out.push({ a: self, b: nid.cbunit(u.code), type: "belongs_to_unit", origin: "codebook", tier: "provable", confidence: 1,
        summary: `${label} names ${u.label} (${u.code})`, evidence: { name: t.name, unit: u.code } });
    } else {
      const conf = aliasConfidence(own.alias!);
      out.push({ a: self, b: nid.cbunit(u.code), type: "belongs_to_unit", origin: "resolver", tier: conf >= 0.85 ? "strong" : "inferred", confidence: conf,
        summary: `${label} says "${own.alias!.term}", which people use for ${u.label} (${u.code})`,
        evidence: { name: t.name, alias: own.alias!.term, unit: u.code, aliasId: own.alias!.id } });
    }
  } else if (above) {
    const u = unitByCode(ctx.units, above.code);
    if (u) out.push({ a: self, b: nid.cbunit(u.code), type: "belongs_to_unit", origin: "resolver", tier: "provable", confidence: 1,
      summary: `${label} sits under a folder linked to ${u.label} (${u.code})`, evidence: { inheritedFrom: nid.folder(above.fromFolderId), unit: u.code } });
  }
  // A different unit named in the name than the one above it is worth a human look, not a silent override.
  if (own && above && own.code !== above.code) {
    const u = unitByCode(ctx.units, own.code), a = unitByCode(ctx.units, above.code);
    if (u && a) out.push({ a: self, b: nid.cbunit(a.code), type: "belongs_to_unit", origin: "resolver", tier: "inferred", confidence: 0.3,
      summary: `${label} names ${u.label} but is filed under ${a.label} — one of them is wrong`, evidence: { named: u.code, filedUnder: a.code } });
  }

  // ── Alias proposal ──────────────────────────────────────────────────────
  // A folder whose name names nothing we know, sitting under a unit, is how
  // nicknames surface: "Born" under "20 - Crude" is probably what people call
  // the crude heater area. Proposed only (inferred); a human makes it an alias.
  if (t.kind === "folder" && !own && !fromDrawing && above) {
    const ws = words(t.name).filter((w) => !isStopword(w));
    const plain = ws.length >= 1 && ws.length <= 2 && !/\d/.test(t.name) && docTypesIn(ws).length === 0
      && !ws.some((w) => ctx.units.some((u) => words(u.label).includes(w)))
      && !["equipment", "drawing", "drawings", "file", "files", "misc", "old", "new", "archive", "temp", "scan", "scans", "general", "photo", "photos", "vendor", "project", "projects"].includes(ws.join(" "));
    const u = unitByCode(ctx.units, above.code);
    if (plain && u) {
      const term = ws.join(" ");
      const known = ctx.aliases.some((a) => a.kind === "unit" && a.termCanonical === canonicalForm(term));
      if (!known) out.push({ a: `term:${canonicalForm(term)}`, b: nid.cbunit(u.code), type: "alias_of", origin: "resolver", tier: "inferred", confidence: 0.4,
        summary: `People may say "${term}" for ${u.label} (${u.code}) — folder "${t.name}" sits under it`, evidence: { term, folder: nid.folder(t.id), unit: u.code } });
    }
  }

  // ── Project ─────────────────────────────────────────────────────────────
  const text = [t.name, ...t.path].join(" ");
  const named = projectsNamed(t.kind === "folder" ? t.name : t.name + " " + t.path.join(" "), ctx);
  const seenProj = new Set<string>();
  for (const p of named) {
    seenProj.add(p.id);
    out.push({ a: self, b: nid.proj(p.id), type: "in_project", origin: "resolver", tier: "strong", confidence: 0.85,
      summary: `${label} carries ${p.via}, which names project "${p.name}"`, evidence: { code: p.via, project: p.id } });
    // The project itself inherits the unit named alongside.
    const unitCode = fromDrawing ?? own?.code ?? above?.code;
    if (unitCode && unitByCode(ctx.units, unitCode)) {
      const u = unitByCode(ctx.units, unitCode)!;
      out.push({ a: nid.proj(p.id), b: nid.cbunit(u.code), type: "project_scope", origin: "resolver", tier: "strong", confidence: 0.8,
        summary: `Project "${p.name}" appears alongside ${u.label} (${u.code}) in ${label.toLowerCase()}`, evidence: { from: self, unit: u.code } });
    }
  }
  const projAbove = inheritedProject(t, ctx);
  if (projAbove && !seenProj.has(projAbove.id)) {
    const p = ctx.projects.find((x) => x.id === projAbove.id);
    if (p) out.push({ a: self, b: nid.proj(p.id), type: "in_project", origin: "resolver", tier: "provable", confidence: 1,
      summary: `${label} sits under a folder linked to project "${p.name}"`, evidence: { inheritedFrom: nid.folder(projAbove.fromFolderId) } });
  }

  // ── Equipment ───────────────────────────────────────────────────────────
  const nameCodes = findCodes(t.name).map((c) => c.canon);
  if (t.kind === "folder") {
    // A folder named for one tag is that asset's folder.
    const exact = nameCodes.length === 1 && words(t.name).length <= 2 ? ctx.assets.get(nameCodes[0]) : undefined;
    if (exact) out.push({ a: self, b: nid.asset(exact.id), type: "about_asset", origin: "resolver", tier: "strong", confidence: 0.9,
      summary: `Folder "${t.name}" is named for ${exact.tag}`, evidence: { tag: exact.tag } });
  } else {
    const seen = new Set<string>();
    for (const c of nameCodes) {
      const a = ctx.assets.get(c);
      if (!a || seen.has(a.id)) continue;
      seen.add(a.id);
      out.push({ a: self, b: nid.asset(a.id), type: "tagged_to", origin: "resolver", tier: "strong", confidence: 0.85,
        summary: `"${t.name}" names ${a.tag}`, evidence: { tag: a.tag, where: "name" }, versionId: t.versionId ?? null });
    }
    for (const c of t.pageTags ?? []) {
      const a = ctx.assets.get(canonicalForm(c));
      if (!a || seen.has(a.id)) continue;
      seen.add(a.id);
      out.push({ a: self, b: nid.asset(a.id), type: "tagged_to", origin: "vision", tier: "provable", confidence: 1,
        summary: `${a.tag} was read on a page of "${t.name}"`, evidence: { tag: a.tag, where: "page" }, versionId: t.versionId ?? null });
    }
    // A folder a person marked as this equipment's folder.
    for (let i = t.pathIds.length - 1; i >= 0; i--) {
      const id = ctx.folderAssets?.get(t.pathIds[i]);
      if (!id) continue;
      if (!seen.has(id)) {
        seen.add(id);
        const tag = [...ctx.assets.values()].find((x) => x.id === id)?.tag ?? "its equipment";
        out.push({ a: self, b: nid.asset(id), type: "tagged_to", origin: "resolver", tier: "provable", confidence: 1,
          summary: `"${t.name}" is filed in the folder marked for ${tag}`, evidence: { where: "marked folder", folder: nid.folder(t.pathIds[i]) }, versionId: t.versionId ?? null });
      }
      break;
    }
    // The equipment folder it sits in.
    for (let i = t.path.length - 1; i >= 0; i--) {
      const fc = findCodes(t.path[i]).map((x) => x.canon);
      if (fc.length === 1 && words(t.path[i]).length <= 2) {
        const a = ctx.assets.get(fc[0]);
        if (a && !seen.has(a.id)) {
          seen.add(a.id);
          out.push({ a: self, b: nid.asset(a.id), type: "tagged_to", origin: "resolver", tier: "strong", confidence: 0.8,
            summary: `"${t.name}" is filed in ${a.tag}'s folder "${t.path[i]}"`, evidence: { tag: a.tag, where: "folder", folder: t.path[i] } });
        }
        break;
      }
    }
  }
  void text;
  return out;
}
