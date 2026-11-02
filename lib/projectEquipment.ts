// projectEquipment - Setup › Unit & equipment: the unit the project is on,
// and the registry equipment each work order is on.
//
// The unit is the project's scope link to a codebook unit (estate_edges
// project_scope, proj → cbunit), the same link Documents › Scope draws and
// the Intelligence graph reads. Each work order's equipment is kept on its
// task (milestones.attributes, lib/findings EQUIP_ID / EQUIP_TAG) and linked
// to the project for the graph (project_scope, proj → asset).
//
// Matching respects units: a tag found under another unit is flagged, not
// quietly taken as this unit's (V-7 on the Crude Unit may be another V-7).
// Matching is pure; load and save talk to the database.

import { supabase } from "@/lib/supabase";
import type { Milestone } from "@/types/schema";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { workOrderGroupsOf } from "@/lib/workOrderGroups";
import { woOf } from "@/lib/workOrderCrew";
import { loadCodebook } from "@/lib/codebook";
import { listEdgesFor, declareEdge, removeEdge } from "@/lib/estate/client";
import { nid, type EstateEdge } from "@/lib/estate/ids";
import { createAsset, updateAsset } from "@/lib/assets";
import { EQUIP_ID, EQUIP_NONE, EQUIP_TAG, leadTag, tagsIn, tagKey, registryTagKey, type Equipment } from "@/lib/findings";

export interface RegistryAsset { id: string; tag: string; unitCode: string | null }
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
  | "no_tag";

export interface WorkOrderMatch {
  /** The task the work order is on. */
  ownerId: string;
  title: string;
  wo: string | null;
  /** The tag: saved, else read from the names. */
  tag: string | null;
  asset: RegistryAsset | null;
  state: MatchState;
  /** Linked, or found, under another unit than the project's. */
  otherUnit: boolean;
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

/** Each work order's equipment, as saved or as the names and the registry
 *  suggest. */
export function matchWorkOrders(orders: Array<{ owner: Milestone; wo: string | null }>, all: Milestone[], registry: RegistryAsset[], unitCode: string | null): WorkOrderMatch[] {
  const byId = new Map<string, Milestone>();
  for (const m of all) if (m.id) byId.set(m.id, m);
  const byTag = new Map<string, RegistryAsset[]>();
  for (const a of registry) { const k = registryTagKey(a.tag); if (k) byTag.set(k, [...(byTag.get(k) ?? []), a]); }
  const out: WorkOrderMatch[] = [];
  const done = new Set<string>();
  for (const { owner, wo } of orders) {
    if (!owner.id || done.has(owner.id)) continue;
    done.add(owner.id);
    const saved = savedEquipment(owner);
    const base = { ownerId: owner.id, title: owner.name, wo };
    if (saved === "none") { out.push({ ...base, tag: null, asset: null, state: "none", otherUnit: false }); continue; }
    const tag = saved?.tag ?? proposeTag(owner, byId);
    const hits = tag ? byTag.get(tagKey(tag)) ?? [] : [];
    const asset = (saved?.assetId ? registry.find((a) => a.id === saved.assetId) : undefined)
      ?? hits.find((a) => !!unitCode && a.unitCode === unitCode) ?? hits[0] ?? null;
    const otherUnit = !!asset && !!unitCode && asset.unitCode !== unitCode;
    const state: MatchState = saved ? "linked" : !tag ? "no_tag" : !asset ? "not_in_registry" : otherUnit ? "other_unit" : "found";
    out.push({ ...base, tag, asset, state, otherUnit });
  }
  return out;
}

/** The schedule with equipment just saved here laid over it (the schedule
 *  on screen was read before the save). null: on no equipment. */
export function withEquipment(milestones: Milestone[], saved: Map<string, Equipment | null> | undefined): Milestone[] {
  if (!saved?.size) return milestones;
  return milestones.map((m) => {
    if (!m.id || !saved.has(m.id)) return m;
    const e = saved.get(m.id);
    const a = { ...(m.attributes ?? {}) };
    delete a[EQUIP_ID]; delete a[EQUIP_TAG]; delete a[EQUIP_NONE];
    if (e) { a[EQUIP_TAG] = e.tag; if (e.assetId) a[EQUIP_ID] = e.assetId; } else a[EQUIP_NONE] = true;
    return { ...m, attributes: a };
  });
}

/** Still to decide: a match not saved yet (no tag to go on doesn't count). */
export const undecided = (ms: WorkOrderMatch[]) => ms.filter((m) => m.state === "found" || m.state === "other_unit" || m.state === "not_in_registry");

// ─── Database ──────────────────────────────────────────────────────

export interface ProjectEquipmentData {
  units: UnitChoice[];
  registry: RegistryAsset[];
  /** The project's unit (its first scope link to a codebook unit). */
  unit: UnitChoice | null;
  /** Its scope links (to remove ones a change leaves behind). */
  edges: EstateEdge[];
}

export async function loadProjectEquipment(orgId: string, projectId: string): Promise<ProjectEquipmentData> {
  const [book, assets, edges] = await Promise.all([
    loadCodebook(orgId),
    fetchAllRows<{ id: string; tag: string; unit_code: string | null }>((from, to) => supabase.from("assets")
      .select("id, tag, unit_code").eq("org_id", orgId).eq("archived", false).order("id").range(from, to) as unknown as PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>),
    listEdgesFor(orgId, [nid.proj(projectId)]).catch(() => [] as EstateEdge[]),
  ]);
  const units = book.units.map((u) => ({ code: u.code, label: u.label }));
  const scope = edges.filter((e) => e.type === "project_scope" && e.status === "applied" && e.a === nid.proj(projectId));
  const unitEdge = scope.find((e) => e.b.startsWith("cbunit:"));
  const code = unitEdge ? unitEdge.b.slice("cbunit:".length) : null;
  return {
    units,
    registry: assets.rows.map((a) => ({ id: a.id, tag: a.tag, unitCode: a.unit_code })),
    unit: code ? units.find((u) => u.code === code) ?? { code, label: `Unit ${code}` } : null,
    edges: scope,
  };
}

export const unitName = (u: UnitChoice | null | undefined) => (u ? `${u.label} (${u.code})` : "");
const actorOf = (a: { id: string | null; name: string | null }) => ({ userId: a.id, name: a.name });

/** Set the project's unit: one scope link to it (the one set here before
 *  is taken off). */
export async function setProjectUnit(input: { orgId: string; projectId: string; projectName: string; unit: UnitChoice; before: EstateEdge[]; actor: { id: string | null; name: string | null } }): Promise<void> {
  await declareEdge({
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
export async function setWorkOrderEquipment(input: { orgId: string; projectId: string; projectName: string; ownerId: string; title: string; equipment: Equipment | null; actor: { id: string | null; name: string | null } }): Promise<void> {
  const { data, error } = await supabase.from("milestones").select("attributes").eq("id", input.ownerId).maybeSingle();
  if (error) throw new Error(error.message);
  const attrs = { ...(((data as { attributes?: Record<string, unknown> | null } | null)?.attributes) ?? {}) };
  delete attrs[EQUIP_ID]; delete attrs[EQUIP_TAG]; delete attrs[EQUIP_NONE];
  if (input.equipment) {
    attrs[EQUIP_TAG] = input.equipment.tag.trim();
    if (input.equipment.assetId) attrs[EQUIP_ID] = input.equipment.assetId;
  } else attrs[EQUIP_NONE] = true;
  const { error: e2 } = await supabase.from("milestones").update({ attributes: attrs, updated_at: new Date().toISOString(), updated_by: input.actor.id }).eq("id", input.ownerId);
  if (e2) throw new Error(e2.message);
  if (input.equipment?.assetId) {
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
export async function addToRegistry(input: { orgId: string; tag: string; unitCode: string; createdBy: string }): Promise<RegistryAsset> {
  const a = await createAsset({ orgId: input.orgId, tag: input.tag.trim(), unitCode: input.unitCode, createdBy: input.createdBy });
  return { id: a.id, tag: a.tag, unitCode: (a as { unit_code?: string | null }).unit_code ?? input.unitCode };
}

/** Move registry equipment to the project's unit (the registry had it
 *  under another one). */
export async function moveToUnit(assetId: string, unitCode: string, by: string): Promise<void> {
  await updateAsset(assetId, { unit_code: unitCode }, by);
}

/** Fired after a change, so every open view re-reads. */
export const EQUIPMENT_CHANGED = "project-equipment:changed";
