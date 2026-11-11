// projectEquipment - Setup › Unit & equipment: the units the project is on,
// and the registry equipment, unit and equipment type each work order is on.
//
// Each unit is a scope link from the project to a codebook unit
// (estate_edges project_scope, proj → cbunit), the same link Documents ›
// Scope draws and the Intelligence graph reads. Each work order's equipment,
// unit and type are kept on its task (milestones.attributes: lib/findings
// EQUIP_ID / EQUIP_TAG, lib/woClass EQUIP_UNIT / EQUIP_TYPE) and the
// equipment is linked to the project for the graph (project_scope, proj →
// asset). The unit and type are read from the site code first (lib/woClass).
//
// Matching respects units: a tag found under another unit is flagged, not
// quietly taken as this unit's (V-7 on the Crude Unit may be another V-7).
// Matching is pure; load and save talk to the database.

import { supabase } from "@/lib/supabase";
import type { Milestone } from "@/types/schema";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { workOrderGroupsOf } from "@/lib/workOrderGroups";
import { woOf } from "@/lib/workOrderCrew";
import { loadCodebook, EMPTY_CODEBOOK, type Codebook } from "@/lib/codebook";
import { classifyWorkOrder, EQUIP_UNIT, EQUIP_TYPE, type WoClass } from "@/lib/woClass";
import { listEdgesFor, declareEdge, removeEdge } from "@/lib/estate/client";
import { nid, type EstateEdge } from "@/lib/estate/ids";
import { createAsset, updateAsset } from "@/lib/assets";
import { EQUIP_ID, EQUIP_NONE, EQUIP_TAG, leadTag, tagsIn, tagKey, registryTagKey, type Equipment } from "@/lib/findings";
import { EQUIP_REQUEST, requestValue, sameEquipmentId, type EquipmentRequest } from "@/lib/equipmentPick";
import { readCallout } from "@/lib/equipmentSweep";
import { drawingLabel, drawingOf, sheetFromName, sheetKey } from "@/lib/drawingConnectors";

export interface RegistryAsset { id: string; tag: string; unitCode: string | null; code?: string | null; description?: string | null }
export interface UnitChoice { code: string; label: string }

export type MatchState =
  /** Saved: linked to this equipment. */
  | "linked"
  /** Saved: on no equipment. */
  | "none"
  /** Found in the registry, on this project's unit. */
  | "found"
  /** Found in the registry, under another unit. */
  | "other_unit"
  /** A tag, not in the registry yet. */
  | "not_in_registry"
  /** No tag in its name. */
  | "no_tag"
  /** Its name is one piece of equipment and its equipment ID another: a
   *  person picks, nothing is assumed. */
  | "two_answers";

export interface WorkOrderMatch {
  /** The task the work order is on. */
  ownerId: string;
  title: string;
  wo: string | null;
  /** The tag: saved, else read from the names. */
  tag: string | null;
  asset: RegistryAsset | null;
  state: MatchState;
  /** Linked, or found, under another unit than the work order's. */
  otherUnit: boolean;
  /** Its unit and equipment type, and where each came from. */
  cls: WoClass;
  /** Found by the equipment ID the work order carries (its Equipment
   *  column), not by its name: the ID decides. */
  byId?: boolean;
  /** The registry's name for that ID, when it is not the work order's
   *  ("V-5" for the 5510.19 the work order and the P&ID call V-7). */
  listedAs?: string | null;
  /** The two pieces the work order points at: one by its name, one by its
   *  equipment ID (state "two_answers"). */
  clash?: { byId: RegistryAsset; byName: RegistryAsset };
}

/** What a task has saved: equipment, "none", or nothing yet. */
export function savedEquipment(m: Milestone): Equipment | "none" | null {
  const a = m.attributes ?? {};
  if (a[EQUIP_NONE] === true) return "none";
  const tag = typeof a[EQUIP_TAG] === "string" ? (a[EQUIP_TAG] as string).trim() : "";
  return tag ? { assetId: typeof a[EQUIP_ID] === "string" && a[EQUIP_ID] ? (a[EQUIP_ID] as string) : null, tag } : null;
}

/** The tag a work order is most likely on: the one its task (or a task
 *  above it) starts with ("E-12 - Transmix Feed…"), else one written in its
 *  name, description or location ("Clean fuel gas supply header to H-1"). */
export function proposeTag(owner: Milestone, byId: Map<string, Milestone>): string | null {
  const chain: Milestone[] = [];
  const seen = new Set<string>();
  for (let x: Milestone | undefined = owner; x && !(x.id && seen.has(x.id)); x = x.parentId ? byId.get(x.parentId) : undefined) {
    if (x.id) seen.add(x.id);
    chain.push(x);
  }
  for (const x of chain) { const t = leadTag(x.name); if (t) return t; }
  return tagsIn([owner.name, owner.description, owner.location].filter(Boolean).join(" "))[0] ?? null;
}

/** The work orders to match: each one's task, lifted to the task above it
 *  that has the same work order number (four steps of WO 311388 under
 *  "Clean fuel gas supply header to H-1" are one work order), once each;
 *  jobs taken off the schedule left out. */
export function setupOrders(milestones: Milestone[]): Array<{ owner: Milestone; wo: string | null }> {
  const live = milestones.filter((m) => !m.cancelledAt);
  const byId = new Map<string, Milestone>();
  const kids = new Map<string, Milestone[]>();
  for (const m of live) { if (m.id) byId.set(m.id, m); if (m.parentId) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m]); }
  const out = new Map<string, { owner: Milestone; wo: string | null }>();
  for (const g of workOrderGroupsOf(live, kids).values()) {
    let owner = g.owner;
    const wo = g.wo ?? null;
    for (let p = owner.parentId ? byId.get(owner.parentId) : undefined; wo && p && woOf(p) === wo; p = p.parentId ? byId.get(p.parentId) : undefined) owner = p;
    if (owner.id && !out.has(owner.id)) out.set(owner.id, { owner, wo });
  }
  return [...out.values()].sort((a, b) => a.owner.name.localeCompare(b.owner.name, undefined, { numeric: true }));
}

/** Each work order's equipment, unit and type, as saved or as the site
 *  code, the names and the registry suggest. `units`: the project's units.
 *  A work order whose site code puts it on a unit is matched to that unit's
 *  equipment only: E-27 on the Crude Unit isn't the LRU's E-27. */
export function matchWorkOrders(orders: Array<{ owner: Milestone; wo: string | null }>, all: Milestone[], registry: RegistryAsset[], units: string | string[] | null, book: Codebook = EMPTY_CODEBOOK): WorkOrderMatch[] {
  const projectUnits = Array.isArray(units) ? units : units ? [units] : [];
  const byId = new Map<string, Milestone>();
  const kids = new Map<string, Milestone[]>();
  for (const m of all) { if (m.id) byId.set(m.id, m); if (m.parentId) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m]); }
  const byTag = new Map<string, RegistryAsset[]>();
  for (const a of registry) { const k = registryTagKey(a.tag); if (k) byTag.set(k, [...(byTag.get(k) ?? []), a]); }
  const out: WorkOrderMatch[] = [];
  const done = new Set<string>();
  for (const { owner, wo } of orders) {
    if (!owner.id || done.has(owner.id)) continue;
    done.add(owner.id);
    const chain: Milestone[] = [];
    const seen = new Set<string>();
    for (let x: Milestone | undefined = owner; x?.id && !seen.has(x.id); x = x.parentId ? byId.get(x.parentId) : undefined) { seen.add(x.id); chain.push(x); }
    const saved = savedEquipment(owner);
    const base = { ownerId: owner.id, title: owner.name, wo };
    const classOf = (tag: string | null, asset: RegistryAsset | null) =>
      classifyWorkOrder({ owner, chain, kids: kids.get(owner.id!) ?? [], book, projectUnits, tag, asset: asset ? { unitCode: asset.unitCode, code: asset.code ?? null } : null });
    if (saved === "none") { out.push({ ...base, tag: null, asset: null, state: "none", otherUnit: false, cls: classOf(null, null) }); continue; }
    const tag = saved?.tag ?? proposeTag(owner, byId);
    const first = classOf(tag, null);
    // Sure of the unit (confirmed, or its site code): that unit's equipment only.
    const sure = first.unitFrom === "saved" || first.unitFrom === "code";
    const want = first.unit ?? projectUnits[0] ?? null;
    const hits = tag ? byTag.get(tagKey(tag)) ?? [] : [];
    const savedAsset = saved?.assetId ? registry.find((a) => a.id === saved.assetId) : undefined;
    // The equipment ID decides. A work order that carries one (the plant's
    // number in its Equipment column) is that equipment, whatever name the
    // registry lists it under; only then does the name look for it.
    const idAsset = !savedAsset && first.code ? registry.find((a) => sameEquipmentId(a.code, first.code)) : undefined;
    // Two pieces of one name in a unit (two V-5s): the ID says which.
    const nameAsset = (idAsset && hits.includes(idAsset) ? idAsset : undefined) ?? hits.find((a) => !!want && a.unitCode === want) ?? (sure ? undefined : hits[0]);
    // The name says one registered piece and the ID another ("at H-1" with
    // H-2's number): the work order is wrong in one of the two, and nothing
    // here can tell which. Neither is taken; a person picks.
    const clash = !savedAsset && idAsset && nameAsset && idAsset.id !== nameAsset.id ? { byId: idAsset, byName: nameAsset } : null;
    const asset = savedAsset ?? (clash ? null : idAsset ?? nameAsset) ?? null;
    const foundById = !!idAsset && !clash && asset === idAsset;
    const shown = asset ?? null;
    const listedAs = shown && tag && (foundById || !!savedAsset) && sameEquipmentId(shown.code, first.code) && registryTagKey(shown.tag) !== tagKey(tag) ? shown.tag.replace(/\s*\(.*$/, "") : null;
    // Only equipment already linked speaks for the unit and type.
    const cls = saved?.assetId && asset ? classOf(tag, asset) : first;
    const unit = cls.unit ?? want;
    const otherUnit = !!asset && !!unit && asset.unitCode !== unit;
    // Saved means decided: linked to its equipment, or a name kept with
    // nothing in the registry to link it to. A name kept that the unit's
    // registry can now answer (by the ID, or by the name) is asked again.
    const decided = !!saved && (!!savedAsset || !asset || otherUnit) && !clash;
    const state: MatchState = decided ? "linked" : !tag ? "no_tag" : clash ? "two_answers" : !asset ? "not_in_registry" : otherUnit ? "other_unit" : "found";
    out.push({ ...base, tag, asset, state, otherUnit, cls, ...(foundById ? { byId: true } : {}), ...(listedAs ? { listedAs } : {}), ...(clash ? { clash } : {}) });
  }
  return out;
}

/** The schedule with equipment just saved here laid over it (the schedule
 *  on screen was read before the save). null: on no equipment. */
export function withEquipment(milestones: Milestone[], saved: Map<string, Equipment | null | SavedHere> | undefined): Milestone[] {
  if (!saved?.size) return milestones;
  return milestones.map((m) => {
    if (!m.id || !saved.has(m.id)) return m;
    const v = saved.get(m.id);
    const s: SavedHere = v && typeof v === "object" && ("equipment" in v || "unit" in v || "type" in v) ? v as SavedHere : { equipment: v as Equipment | null };
    const a = { ...(m.attributes ?? {}) };
    if (s.equipment !== undefined) {
      delete a[EQUIP_ID]; delete a[EQUIP_TAG]; delete a[EQUIP_NONE];
      const e = s.equipment;
      if (e) { a[EQUIP_TAG] = e.tag; if (e.assetId) a[EQUIP_ID] = e.assetId; } else a[EQUIP_NONE] = true;
    }
    if (s.unit !== undefined) { if (s.unit) a[EQUIP_UNIT] = s.unit; else delete a[EQUIP_UNIT]; }
    if (s.type !== undefined) { if (s.type) a[EQUIP_TYPE] = s.type; else delete a[EQUIP_TYPE]; }
    return { ...m, attributes: a };
  });
}

/** What was just saved on a work order here: its equipment, unit, type
 *  (undefined: left as it was). */
export interface SavedHere { equipment?: Equipment | null; unit?: string | null; type?: string | null }

/** A unit or type read from the site code, the registry or the tag, not
 *  confirmed yet (the project's own unit needs no confirming). */
export const classToConfirm = (c: WoClass) => (!!c.unit && c.unitFrom !== "saved" && c.unitFrom !== "project" && c.unitFrom !== "main") || (!!c.type && c.typeFrom !== "saved");

/** Still to decide: a match not saved yet (no tag to go on doesn't count),
 *  or a unit or type not confirmed. */
export const undecided = (ms: WorkOrderMatch[]) => ms.filter((m) => m.state === "found" || m.state === "other_unit" || m.state === "not_in_registry" || m.state === "two_answers" || classToConfirm(m.cls));

// ─── Database ──────────────────────────────────────────────────────

export interface ProjectEquipmentData {
  units: UnitChoice[];
  registry: RegistryAsset[];
  /** The project's first unit (kept for what reads one). */
  unit: UnitChoice | null;
  /** Every unit the project is on, in the order linked. */
  projectUnits: UnitChoice[];
  /** The Site Codebook: unit and equipment type names, and the numbering. */
  book: Codebook;
  /** Its scope links (to remove ones a change leaves behind). */
  edges: EstateEdge[];
}

export async function loadProjectEquipment(orgId: string, projectId: string): Promise<ProjectEquipmentData> {
  const [book, assets, edges] = await Promise.all([
    loadCodebook(orgId),
    fetchAllRows<{ id: string; tag: string; unit_code: string | null; code: string | null; description: string | null }>((from, to) => supabase.from("assets")
      .select("id, tag, unit_code, code, description").eq("org_id", orgId).eq("archived", false).order("id").range(from, to) as unknown as PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>),
    listEdgesFor(orgId, [nid.proj(projectId)]).catch(() => [] as EstateEdge[]),
  ]);
  const units = book.units.map((u) => ({ code: u.code, label: u.label }));
  const scope = edges.filter((e) => e.type === "project_scope" && e.status === "applied" && e.a === nid.proj(projectId));
  const codes = [...new Set(scope.filter((e) => e.b.startsWith("cbunit:")).sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""))).map((e) => e.b.slice("cbunit:".length)))];
  const projectUnits = codes.map((code) => units.find((u) => u.code === code) ?? { code, label: `Unit ${code}` });
  return {
    units,
    registry: assets.rows.map((a) => ({ id: a.id, tag: a.tag, unitCode: a.unit_code, code: a.code, description: a.description })),
    unit: projectUnits[0] ?? null,
    projectUnits,
    book,
    edges: scope,
  };
}

export const unitName = (u: UnitChoice | null | undefined) => (u ? `${u.label} (${u.code})` : "");
const actorOf = (a: { id: string | null; name: string | null }) => ({ userId: a.id, name: a.name });

/** Put the project on a unit too (a scope link to it), or take it off one
 *  (only a link set here; one drawn by hand in Documents › Scope stays). */
export async function setProjectUnitOn(input: { orgId: string; projectId: string; projectName: string; unit: UnitChoice; on: boolean; before: EstateEdge[]; actor: { id: string | null; name: string | null } }): Promise<void> {
  const node = nid.cbunit(input.unit.code);
  if (input.on) {
    if (input.before.some((e) => e.b === node && e.status === "applied")) return;
    await declareEdge({
      orgId: input.orgId, a: nid.proj(input.projectId), b: node, type: "project_scope",
      summary: `Project "${input.projectName}" is on ${unitName(input.unit)} - set in Setup`,
      evidence: { source: "setup" }, actor: actorOf(input.actor),
    });
    return;
  }
  for (const e of input.before) if (e.b === node && e.evidence?.source === "setup") await removeEdge(e.id);
}

/** Set the project's unit: one scope link to it (the one set here before
 *  is taken off). */
export async function setProjectUnit(input: { orgId: string; projectId: string; projectName: string; unit: UnitChoice; before: EstateEdge[]; actor: { id: string | null; name: string | null } }): Promise<void> {
  // Linked already (by hand in Documents › Scope, or here): left as it is,
  // so a link someone drew is never taken over and later removed.
  const had = input.before.some((e) => e.b === nid.cbunit(input.unit.code) && e.status === "applied");
  if (!had) await declareEdge({
    orgId: input.orgId, a: nid.proj(input.projectId), b: nid.cbunit(input.unit.code), type: "project_scope",
    summary: `Project "${input.projectName}" is on ${unitName(input.unit)} - set in Setup`,
    evidence: { source: "setup" }, actor: actorOf(input.actor),
  });
  for (const e of input.before) {
    if (e.b.startsWith("cbunit:") && e.b !== nid.cbunit(input.unit.code) && e.evidence?.source === "setup") await removeEdge(e.id);
  }
}

/** Save a work order's equipment (null: on no equipment) and link the
 *  equipment to the project for the graph. */
export async function setWorkOrderEquipment(input: { orgId: string; projectId: string; projectName: string; ownerId: string; title: string;
  /** undefined: its equipment left as it is. */
  equipment: Equipment | null | undefined;
  /** Its unit and equipment type (undefined: left as they are; null: taken off). */
  unit?: string | null; type?: string | null;
  actor: { id: string | null; name: string | null };
  /** The project's scope links now: one to this equipment already (drawn by
   *  hand or here) is left as it is. */
  existing?: EstateEdge[] }): Promise<void> {
  const { data, error } = await supabase.from("milestones").select("attributes").eq("id", input.ownerId).maybeSingle();
  if (error) throw new Error(error.message);
  const attrs = { ...(((data as { attributes?: Record<string, unknown> | null } | null)?.attributes) ?? {}) };
  if (input.equipment !== undefined) {
    delete attrs[EQUIP_ID]; delete attrs[EQUIP_TAG]; delete attrs[EQUIP_NONE];
    // Linked (or settled as on none): an ask waiting on it is answered.
    if (input.equipment === null || input.equipment.assetId) delete attrs[EQUIP_REQUEST];
    if (input.equipment) {
      attrs[EQUIP_TAG] = input.equipment.tag.trim();
      if (input.equipment.assetId) attrs[EQUIP_ID] = input.equipment.assetId;
    } else attrs[EQUIP_NONE] = true;
  }
  if (input.unit !== undefined) { if (input.unit) attrs[EQUIP_UNIT] = input.unit; else delete attrs[EQUIP_UNIT]; }
  if (input.type !== undefined) { if (input.type) attrs[EQUIP_TYPE] = input.type; else delete attrs[EQUIP_TYPE]; }
  const { error: e2 } = await supabase.from("milestones").update({ attributes: attrs, updated_at: new Date().toISOString(), updated_by: input.actor.id }).eq("id", input.ownerId);
  if (e2) throw new Error(e2.message);
  const assetNode = input.equipment?.assetId ? nid.asset(input.equipment.assetId) : null;
  if (input.equipment?.assetId && !(input.existing ?? []).some((e) => e.b === assetNode && e.status === "applied")) {
    await declareEdge({
      orgId: input.orgId, a: nid.proj(input.projectId), b: nid.asset(input.equipment.assetId), type: "project_scope",
      summary: `Work order "${input.title}" on project "${input.projectName}" is on ${input.equipment.tag}`,
      evidence: { source: "work_orders" }, actor: actorOf(input.actor),
    });
  }
}

/** Take off the graph links to equipment no work order is on any more
 *  (only the ones this step drew). */
export async function pruneEquipmentLinks(edges: EstateEdge[], inUse: Set<string>): Promise<void> {
  for (const e of edges) {
    if (e.b.startsWith("asset:") && e.evidence?.source === "work_orders" && !inUse.has(e.b.slice("asset:".length))) await removeEdge(e.id);
  }
}

/** Put a tag in the registry under the project's unit. */
export async function addToRegistry(input: { orgId: string; tag: string; unitCode: string; createdBy: string; code?: string | null; description?: string | null }): Promise<RegistryAsset> {
  const a = await createAsset({ orgId: input.orgId, tag: input.tag.trim(), unitCode: input.unitCode, createdBy: input.createdBy, ...(input.code ? { code: input.code } : {}), ...(input.description?.trim() ? { description: input.description.trim() } : {}) });
  return { id: a.id, tag: a.tag, unitCode: (a as { unit_code?: string | null }).unit_code ?? input.unitCode, code: input.code ?? null, description: input.description?.trim() || null };
}

/** Ask an admin to add equipment that isn't in the unit's list: kept on the
 *  work order (or step) with its name, so the work order says what it's on
 *  meanwhile, and admins are told. */
export async function requestEquipment(input: { orgId: string; projectId: string; projectName: string; ownerId: string; title: string;
  tag: string; unit: UnitChoice | null; actor: { id: string | null; name: string | null } }): Promise<void> {
  const tag = input.tag.trim();
  const { data, error } = await supabase.from("milestones").select("attributes").eq("id", input.ownerId).maybeSingle();
  if (error) throw new Error(error.message);
  const attrs = { ...(((data as { attributes?: Record<string, unknown> | null } | null)?.attributes) ?? {}) };
  delete attrs[EQUIP_ID]; delete attrs[EQUIP_NONE];
  attrs[EQUIP_TAG] = tag;
  const req: EquipmentRequest = { tag, unit: input.unit?.code ?? null, by: input.actor.id, byName: input.actor.name, at: new Date().toISOString() };
  attrs[EQUIP_REQUEST] = requestValue(req);
  const { error: e2 } = await supabase.from("milestones").update({ attributes: attrs, updated_at: new Date().toISOString(), updated_by: input.actor.id }).eq("id", input.ownerId);
  if (e2) throw new Error(e2.message);
  try {
    const { emit } = await import("@/lib/notify/dispatch");
    const where = input.unit ? unitName(input.unit) : "its unit";
    await emit({
      orgId: input.orgId, category: "assignment", kind: "equipment_request",
      title: `Add ${tag} to ${where}?`,
      body: `${input.actor.name || "Someone"} asked for ${tag} on ${input.title} (${input.projectName}). Only admins add equipment: add it on the work order and it links itself.`,
      link: `/projects/${input.projectId}`,
      resource: { type: "project", id: input.projectId },
      actorUserId: input.actor.id ?? undefined, actorName: input.actor.name ?? undefined,
      audience: { roles: ["Admin"] },
    });
  } catch { /* the ask is saved on the work order either way */ }
}

/** Take an ask off a work order (an admin turned it down, or it was a mistake). */
export async function clearEquipmentRequest(ownerId: string, by: string | null): Promise<void> {
  const { data, error } = await supabase.from("milestones").select("attributes").eq("id", ownerId).maybeSingle();
  if (error) throw new Error(error.message);
  const attrs = { ...(((data as { attributes?: Record<string, unknown> | null } | null)?.attributes) ?? {}) };
  if (!(EQUIP_REQUEST in attrs)) return;
  delete attrs[EQUIP_REQUEST];
  const { error: e2 } = await supabase.from("milestones").update({ attributes: attrs, updated_at: new Date().toISOString(), updated_by: by }).eq("id", ownerId);
  if (e2) throw new Error(e2.message);
}

/** Move registry equipment to the project's unit (the registry had it
 *  under another one). */
export async function moveToUnit(assetId: string, unitCode: string, by: string): Promise<void> {
  await updateAsset(assetId, { unit_code: unitCode }, by);
}

/** Every project's units, for the projects list (its scope links to
 *  codebook units), with the unit names. */
export async function loadProjectUnits(orgId: string): Promise<{ byProject: Map<string, string[]>; units: UnitChoice[] }> {
  const [book, edges] = await Promise.all([
    loadCodebook(orgId),
    fetchAllRows<{ a: string; b: string }>((from, to) => supabase.from("estate_edges").select("a, b").eq("org_id", orgId).eq("type", "project_scope").eq("status", "applied")
      .like("a", "proj:%").like("b", "cbunit:%").order("id").range(from, to) as unknown as PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>),
  ]);
  const byProject = new Map<string, string[]>();
  for (const e of edges.rows) {
    const pid = e.a.slice("proj:".length), code = e.b.slice("cbunit:".length);
    const list = byProject.get(pid) ?? [];
    if (!list.includes(code)) list.push(code);
    byProject.set(pid, list);
  }
  return { byProject, units: book.units.map((u) => ({ code: u.code, label: u.label })) };
}

/** Fired after a change, so every open view re-reads. */
export const EQUIPMENT_CHANGED = "project-equipment:changed";

/** What a drawing prints for an equipment ID: the tag and name beside it,
 *  and the sheet. */
export interface DrawnName { tag: string; name: string | null; sheet: string; documentId: string; libraryId: string }

/** Every sheet that prints this equipment ID, with the tag and name it
 *  prints beside it ("5502-D 2000 sheet 2 prints V-7 (5510.19) TRANSMIX
 *  FRACTIONATOR"). For settling a registry name the drawings disagree with. */
export async function drawnNamesForId(orgId: string, code: string): Promise<DrawnName[]> {
  const id = code.trim();
  if (!id) return [];
  const { data: ents } = await supabase.from("knowledge_page_entities").select("document_id, page, tag, raw")
    .eq("org_id", orgId).eq("kind", "equipment").ilike("raw", `%(${id.replace(/[%_]/g, "")})%`).limit(60);
  const rows = ((ents ?? []) as Array<{ document_id: string; page: number; tag: string; raw: string | null }>)
    .filter((r) => sameEquipmentId(readCallout(r.tag, r.raw).code, id));
  if (!rows.length) return [];
  const { data: mirrors } = await supabase.from("knowledge_documents").select("id, source_document_id").in("id", [...new Set(rows.map((r) => r.document_id))]);
  const toDoc = new Map(((mirrors ?? []) as Array<{ id: string; source_document_id: string | null }>).filter((m) => m.source_document_id).map((m) => [m.id, m.source_document_id!]));
  const docIds = [...new Set([...toDoc.values()])];
  if (!docIds.length) return [];
  const { data: docs } = await supabase.from("documents").select("id, library_id, document_number, name, sheet:metadata->>sheet").in("id", docIds);
  const byId = new Map(((docs ?? []) as unknown as Array<{ id: string; library_id: string; document_number: string | null; name: string | null; sheet: string | null }>).map((d) => [d.id, d]));
  const out = new Map<string, DrawnName>();
  for (const r of rows) {
    const d = byId.get(toDoc.get(r.document_id) ?? "");
    if (!d) continue;
    const number = d.document_number ?? d.name ?? "a drawing";
    const sh = d.sheet && /\d/.test(d.sheet) ? sheetKey(d.sheet) : sheetFromName(d.name ?? "");
    // A set kept in one file (a PFD book) is told apart by its page.
    const sheet = `${drawingLabel(drawingOf(number) ?? number)}${sh ? ` sheet ${sh}` : ` page ${r.page}`}`;
    const name = String(r.raw ?? "").replace(/^\S+\s*(\([^)]*\))?\s*/, "").split("·")[0].trim() || null;
    out.set(`${d.id}|${r.tag}`, { tag: r.tag, name, sheet, documentId: d.id, libraryId: d.library_id });
  }
  return [...out.values()].sort((a, b) => a.sheet.localeCompare(b.sheet, undefined, { numeric: true }));
}

/** Give a registry entry the name the plant uses for its ID (admins only:
 *  the database refuses anyone else). */
export async function renameEquipment(assetId: string, tag: string, userId: string): Promise<void> {
  await updateAsset(assetId, { tag: tag.trim() }, userId);
}
