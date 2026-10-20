// lib/areaWork.ts — WIRE-7 criteria 2-3 (intelligence Round G I-26): the
// work in flight on an operating area and on one piece of equipment.
//
//   * Criterion 2 — holds and work packages listed by operating area. Neither
//     carries a unit or an asset (document_holds has a document_id,
//     work_packages reach documents through work_package_documents); both are
//     listed through the unit's documents — lib/scope.ts resolveScope's one
//     unit identity (decoded number, filed folder, pinned library or folder,
//     governing documents) — so "everything on hold on the crude unit" is
//     the open holds on the unit's documents, and its work packages are those
//     that carry one of them.
//   * Criterion 3 — milestone.location ("where the work happens — area /
//     unit / equipment tag", free text) resolves to an asset or a unit when
//     it names one (resolveMilestoneLocation, pure — the one tag grammar,
//     lib/codebook tagKey; a unit by its code after "unit"/"area", or by its
//     Site Codebook name — only when no other unit is named, read against
//     every codebook unit), and the asset hub shows the open milestones whose
//     location names that asset (loadAssetScheduledWork).
//
// Every read is the reader's own (RLS): a hold, a package or a milestone the
// reader cannot see is not listed. Nothing is written — the location stays
// the planner's free text; a location that names nothing resolves to nothing
// (never a guess). A read that fails is said (`notes`, `complete: false`),
// never shown as "nothing in flight".

import { supabase } from "@/lib/supabase";
import { tagKey } from "@/lib/codebook";
import { resolveScope } from "@/lib/scope";

const CHUNK = 150;
const PAGE = 1000;
/** Milestones read at most (open ones with a location). */
export const MILESTONE_CAP = 5000;

export type MilestoneLocationMatch =
  | { kind: "asset"; assetId: string; tag: string }
  | { kind: "unit"; code: string };

export interface LocationContext {
  assets: ReadonlyArray<{ id: string; tag: string }>;
  units: ReadonlyArray<{ code: string; label?: string | null }>;
}

const TAG_TOKEN = /[A-Za-z]{1,4}-?\d{1,6}[A-Za-z]{0,2}/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "Unit 20", "area #3", "unit-025A": a unit / area designator that names a
 *  code (a token with a digit — never a word such as "area tie-in"). */
const DESIGNATOR = /\b(?:unit|area)\s*[-#:]?\s*([A-Za-z]{0,4}\d[A-Za-z0-9]*)(?![A-Za-z0-9])/gi;

/** Pure: what a milestone's free-text location names — an asset first (any
 *  tag-shaped token, or the whole location, whose tagKey is a registry
 *  tag's), else a unit named by its CODE (the whole location being the code,
 *  or the code after "unit" / "area" — a code beats any name), else a unit
 *  named by its Site Codebook name as whole words — but only when no other
 *  unit is named: a location that also designates another unit by code
 *  ("Unit 20 utilities tie-in" is unit 20's, never the unit named
 *  "Utilities"), or whose words are more than one unit's name, resolves by
 *  name to nothing. null: it names nothing the context holds unambiguously —
 *  never a guess. */
export function resolveMilestoneLocation(location: string | null | undefined, ctx: LocationContext): MilestoneLocationMatch | null {
  const text = String(location ?? "").trim();
  if (!text) return null;
  const byKey = new Map<string, { id: string; tag: string }>();
  for (const a of ctx.assets) { const k = tagKey(a.tag); if (k && !byKey.has(k)) byKey.set(k, a); }
  const candidates = [...(text.match(TAG_TOKEN) ?? []), text];
  for (const c of candidates) {
    const hit = byKey.get(tagKey(c));
    if (hit) return { kind: "asset", assetId: hit.id, tag: hit.tag };
  }
  // A unit named by its code — over every unit before any name.
  for (const u of ctx.units) {
    const code = String(u.code ?? "").trim();
    if (!code) continue;
    if (text.toLowerCase() === code.toLowerCase()) return { kind: "unit", code };
    if (new RegExp(`\\b(?:unit|area)\\s*[-#:]?\\s*${escapeRe(code)}(?![A-Za-z0-9])`, "i").test(text)) return { kind: "unit", code };
  }
  // A unit named by its name — refused when the location designates a unit
  // by a code (one this context does not hold: the work is that unit's), or
  // when more than one unit's name is in it.
  if ([...text.matchAll(DESIGNATOR)].length > 0) return null;
  const named: string[] = [];
  for (const u of ctx.units) {
    const code = String(u.code ?? "").trim();
    const label = String(u.label ?? "").trim();
    if (!code || label.length < 3) continue;
    if (new RegExp(`(?<![A-Za-z0-9])${escapeRe(label)}(?![A-Za-z0-9])`, "i").test(text) && !named.includes(code)) named.push(code);
  }
  return named.length === 1 ? { kind: "unit", code: named[0] } : null;
}

export interface LocatedMilestone {
  id: string;
  name: string;
  status: string;
  plannedAt: string | null;
  location: string;
  projectId: string | null;
  match: MilestoneLocationMatch;
}

type Raw = { id: string; name: string | null; status: string | null; planned_at: string | null; location: string | null; project_id: string | null };

/** Pure: an ILIKE pattern every location resolveMilestoneLocation could
 *  match to this tag satisfies — a SUPERSET, so the server narrows the read
 *  and the client match stays the final word (I-26 review, DEC-90). That
 *  match takes the location (or a tag-shaped token in it) whose tagKey —
 *  lowercased, everything but [a-z0-9] removed — equals the tag's; so the
 *  key's characters appear in the location in order, with anything between
 *  them: `%c1%c2%…%` (ILIKE: case-blind; `%` spans any run, newlines
 *  included). 'i' and 'k' are written `_` (any one character): two
 *  non-ASCII capitals lowercase to them in JavaScript (U+0130 → "i̇",
 *  U+212A KELVIN SIGN → "k") and a database's case folding (a Turkish
 *  collation's I) need not agree, so the pattern never drops one. null:
 *  the tag has no key, and the client match takes nothing. */
export function assetLocationPattern(tag: string): string | null {
  const key = tagKey(tag);
  if (!key) return null;
  return `%${[...key].map((c) => (c === "i" || c === "k" ? "_" : c)).join("%")}%`;
}

/** The org's open milestones that carry a location, keyset-paged to an
 *  empty page (or the cap) — with `locationLike`, only those whose location
 *  matches that ILIKE pattern. null + why when the read failed. */
async function readOpenLocatedMilestones(orgId: string, locationLike?: string): Promise<{ rows: Raw[]; capped: boolean; error: string | null }> {
  const rows: Raw[] = [];
  for (let after: string | null = null; rows.length < MILESTONE_CAP;) {
    let q = supabase.from("milestones").select("id, name, status, planned_at, location, project_id")
      .eq("org_id", orgId).not("location", "is", null).neq("status", "completed");
    if (locationLike) q = q.ilike("location", locationLike);
    q = q.order("id", { ascending: true }).limit(PAGE);
    if (after) q = q.gt("id", after);
    const { data, error } = await q;
    if (error) return { rows, capped: false, error: error.message || "the read failed" };
    const batch = (data ?? []) as Raw[];
    if (batch.length === 0) return { rows, capped: false, error: null };
    rows.push(...batch);
    after = batch[batch.length - 1].id;
  }
  return { rows, capped: true, error: null };
}

function locate(rows: Raw[], ctx: LocationContext, keep: (m: MilestoneLocationMatch) => boolean): LocatedMilestone[] {
  const out: LocatedMilestone[] = [];
  for (const r of rows) {
    const match = resolveMilestoneLocation(r.location, ctx);
    if (!match || !keep(match)) continue;
    out.push({ id: r.id, name: r.name || "Untitled milestone", status: r.status || "planned", plannedAt: r.planned_at, location: String(r.location), projectId: r.project_id, match });
  }
  return out.sort((a, b) => String(a.plannedAt ?? "").localeCompare(String(b.plannedAt ?? "")));
}

export interface AreaHold {
  id: string; documentId: string; documentLabel: string; libraryId: string | null;
  reason: string; openedAt: string | null; expectedReleaseAt: string | null;
}
export interface AreaWorkPackage { id: string; name: string; status: string; documents: number }
export interface AreaWork {
  holds: AreaHold[];
  workPackages: AreaWorkPackage[];
  milestones: LocatedMilestone[];
  /** false when a read failed or a list was cut at its cap. */
  complete: boolean;
  notes: string[];
}

/** WIRE-7 criteria 2-3 for one operating area: its documents' open holds,
 *  the open work packages that carry one of its documents, and the open
 *  milestones whose location names the unit or one of its equipment. */
export async function loadAreaWork(orgId: string, unitCode: string): Promise<AreaWork> {
  const notes: string[] = [];
  let complete = true;
  const scope = await resolveScope(orgId, { kind: "unit", code: unitCode });
  if (!scope.complete) { complete = false; notes.push("This area's documents could not all be placed — the lists below may be short."); }
  const docIds = scope.documents;

  // Open holds on the area's documents.
  const holdsRaw: Array<{ id: string; document_id: string; reason: string | null; opened_at: string | null; expected_release_at: string | null }> = [];
  let holdsFailed: string | null = null;
  for (let i = 0; i < docIds.length && !holdsFailed; i += CHUNK) {
    const { data, error } = await supabase.from("document_holds")
      .select("id, document_id, reason, opened_at, expected_release_at")
      .eq("org_id", orgId).in("document_id", docIds.slice(i, i + CHUNK)).is("released_at", null);
    if (error) { holdsFailed = error.message || "the read failed"; break; }
    holdsRaw.push(...((data ?? []) as typeof holdsRaw));
  }
  if (holdsFailed) { complete = false; notes.push(`The open holds could not be read (${holdsFailed}).`); }

  // Work packages carrying one of the area's documents.
  const perPackage = new Map<string, number>();
  let packagesFailed: string | null = null;
  for (let i = 0; i < docIds.length && !packagesFailed; i += CHUNK) {
    const { data, error } = await supabase.from("work_package_documents")
      .select("package_id, document_id").eq("org_id", orgId).in("document_id", docIds.slice(i, i + CHUNK));
    if (error) { packagesFailed = error.message || "the read failed"; break; }
    for (const r of (data ?? []) as Array<{ package_id: string }>) perPackage.set(r.package_id, (perPackage.get(r.package_id) ?? 0) + 1);
  }
  const workPackages: AreaWorkPackage[] = [];
  const pkgIds = [...perPackage.keys()];
  for (let i = 0; i < pkgIds.length && !packagesFailed; i += CHUNK) {
    const { data, error } = await supabase.from("work_packages").select("id, name, status")
      .eq("org_id", orgId).in("id", pkgIds.slice(i, i + CHUNK)).neq("status", "closed");
    if (error) { packagesFailed = error.message || "the read failed"; break; }
    for (const p of (data ?? []) as Array<{ id: string; name: string | null; status: string | null }>) {
      workPackages.push({ id: p.id, name: p.name || "Untitled package", status: p.status || "open", documents: perPackage.get(p.id) ?? 0 });
    }
  }
  if (packagesFailed) { complete = false; notes.push(`The work packages could not be read (${packagesFailed}).`); }

  // The held documents' labels.
  const label = new Map<string, { label: string; libraryId: string | null }>();
  const heldIds = [...new Set(holdsRaw.map((h) => h.document_id))];
  for (let i = 0; i < heldIds.length; i += CHUNK) {
    const { data } = await supabase.from("documents").select("id, document_number, title, name, library_id")
      .eq("org_id", orgId).in("id", heldIds.slice(i, i + CHUNK));
    for (const d of (data ?? []) as Array<{ id: string; document_number: string | null; title: string | null; name: string | null; library_id: string | null }>) {
      label.set(d.id, { label: d.document_number || d.title || d.name || d.id.slice(0, 8), libraryId: d.library_id });
    }
  }
  const holds: AreaHold[] = holdsRaw.map((h) => ({
    id: h.id, documentId: h.document_id, documentLabel: label.get(h.document_id)?.label ?? h.document_id.slice(0, 8),
    libraryId: label.get(h.document_id)?.libraryId ?? null, reason: h.reason || "On hold",
    openedAt: h.opened_at, expectedReleaseAt: h.expected_release_at,
  })).sort((a, b) => String(a.openedAt ?? "").localeCompare(String(b.openedAt ?? "")));

  // Milestones whose location names the unit or one of its equipment.
  const assets: Array<{ id: string; tag: string }> = [];
  let assetsFailed: string | null = null;
  for (let i = 0; i < scope.assets.length; i += CHUNK) {
    const { data, error } = await supabase.from("assets").select("id, tag").eq("org_id", orgId).in("id", scope.assets.slice(i, i + CHUNK));
    if (error) { assetsFailed = error.message || "the read failed"; break; }
    for (const a of (data ?? []) as Array<{ id: string; tag: string | null }>) if (a.tag) assets.push({ id: a.id, tag: a.tag });
  }
  if (assetsFailed) { complete = false; notes.push(`The area's equipment could not be read (${assetsFailed}) — milestones are matched to the area by name only.`); }
  const ms = await readOpenLocatedMilestones(orgId);
  if (ms.error) { complete = false; notes.push(`The scheduled milestones could not be read (${ms.error}).`); }
  if (ms.capped) { complete = false; notes.push(`Only the first ${MILESTONE_CAP} open milestones with a location were read.`); }
  // The other areas' codes and names, so a location that names another unit
  // — or more than one unit's name — is never this area's by a shared word.
  const units: Array<{ code: string; label: string | null }> = [{ code: unitCode, label: scope.label }];
  const others = await supabase.from("codebook_entries").select("code, label").eq("org_id", orgId).eq("kind", "unit").limit(PAGE);
  if (others.error) {
    complete = false;
    notes.push(`The other areas' names could not be read (${others.error.message || "the read failed"}) — a milestone matched to this area by name alone may belong to another area.`);
  } else {
    for (const u of (others.data ?? []) as Array<{ code: string | null; label: string | null }>) {
      if (u.code && u.code !== unitCode) units.push({ code: u.code, label: u.label });
    }
  }
  const milestones = locate(ms.rows, { assets, units }, (m) => m.kind === "asset" || m.code === unitCode);

  return { holds, workPackages: workPackages.sort((a, b) => a.name.localeCompare(b.name)), milestones, complete, notes };
}

/** WIRE-7 criterion 3: the open milestones whose location names this asset.
 *  The server reads only the locations that could name it
 *  (assetLocationPattern, a superset of the match — I-26 review: the hub no
 *  longer reads every open located milestone in the workspace on each
 *  open); resolveMilestoneLocation decides, as before. */
export async function loadAssetScheduledWork(orgId: string, asset: { id: string; tag: string }): Promise<{ milestones: LocatedMilestone[]; note: string | null }> {
  const like = assetLocationPattern(asset.tag);
  if (!like) return { milestones: [], note: null };
  const ms = await readOpenLocatedMilestones(orgId, like);
  const milestones = locate(ms.rows, { assets: [asset], units: [] }, (m) => m.kind === "asset");
  const note = ms.error ? `Scheduled work could not be read (${ms.error}).`
    : ms.capped ? `Only the first ${MILESTONE_CAP} open milestones with a location were read.` : null;
  return { milestones, note };
}
