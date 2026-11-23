// lib/equipmentStartOverServer.ts - SERVER-ONLY. Start the equipment over
// from the drawings: preview, run, read again (lib/equipmentStartOver plans
// it). Runs with the service role behind an Admin-only route.
//
// Safe to run twice: the run re-reads everything and does what the preview
// showed, or refuses when the list changed. Records a person added, and
// anything with photos or files, are never deleted; photos, files and links
// on a merged copy move onto the record that stays.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { planStartOver, planKey, columnList, journalAdditions, withoutReaderEntries, type StartOverAsset, type StartOverPlan } from "@/lib/equipmentStartOver";

/** Links the drawing reader draws (it reads sheets and IDs). */
const READER = ["bridge", "vision"];
/** Links any machine draws: the reader's and the resolver's. */
const MACHINE = [...READER, "resolver"];

type Admin = SupabaseClient;
type Page = (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
const all = async <T,>(page: Page): Promise<{ rows: T[]; ok: boolean; error: string | null }> => {
  const r = await fetchAllRows<T>(page, 200_000);
  return { rows: r.rows, ok: !r.error, error: r.error };
};
/** A table an older schema doesn't have yet (it holds nothing). */
const missingTable = (e: string | null) => !!e && /does not exist|schema cache|42P01/i.test(e);
const count = (ids: string[]) => { const m = new Map<string, number>(); for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1); return m; };
const chunks = <T,>(list: T[], n = 200): T[][] => { const out: T[][] = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

export interface DrawingCleanup { documentId: string; label: string; key: string | null; removed: string[]; links: string[] }

export interface StartOverPreview {
  planKey: string;
  plan: StartOverPlan;
  drawings: {
    /** Drawings that lose entries or links, with what comes off. */
    list: Array<{ documentId: string; label: string; removed: string[]; links: number }>;
    entries: number;
    links: number;
    /** Drawings whose reading is forgotten, to be matched again. */
    suggestions: number;
    /** False before migration 20261121: only entries the run journal saw are known. */
    tracked: boolean;
  };
  totals: { assets: number; reader: number; edited: number };
}

interface Gathered {
  assets: Array<StartOverAsset & { coverPhotoId: string | null }>;
  drawings: DrawingCleanup[];
  suggestions: number;
  tracked: boolean;
}

async function gather(admin: Admin, orgId: string): Promise<Gathered> {
  type A = { id: string; tag: string; code: string | null; unit_code: string | null; origin: string | null; archived: boolean | null; created_at: string | null; updated_by: string | null; cover_photo_id: string | null };
  const assets = await all<A>((f, t) => admin.from("assets").select("id, tag, code, unit_code, origin, archived, created_at, updated_by, cover_photo_id").eq("org_id", orgId).order("id").range(f, t));
  if (!assets.ok) throw new Error("Couldn't read the equipment list.");
  const ids = (rows: Array<{ asset_id: string | null }>) => rows.map((r) => r.asset_id).filter((x): x is string => !!x);
  const [photos, files, notes, aliases, typed, findings, works, personToB, personFromA] = await Promise.all([
    all<{ asset_id: string }>((f, t) => admin.from("asset_photos").select("asset_id").eq("org_id", orgId).order("id").range(f, t)),
    all<{ asset_id: string }>((f, t) => admin.from("asset_files").select("asset_id").eq("org_id", orgId).order("id").range(f, t)),
    all<{ asset_id: string | null }>((f, t) => admin.from("notes").select("asset_id").eq("org_id", orgId).not("asset_id", "is", null).order("id").range(f, t)),
    all<{ asset_id: string }>((f, t) => admin.from("asset_aliases").select("asset_id").eq("org_id", orgId).order("id").range(f, t)),
    all<{ asset_id: string }>((f, t) => admin.from("document_assets").select("asset_id").eq("org_id", orgId).eq("source", "manual").order("id").range(f, t)),
    all<{ asset_id: string | null }>((f, t) => admin.from("project_findings").select("asset_id").eq("org_id", orgId).not("asset_id", "is", null).order("id").range(f, t)),
    all<{ id: string; attributes: Record<string, unknown> | null }>((f, t) => admin.from("milestones").select("id, attributes").eq("org_id", orgId).not("attributes->>equipment_asset_id", "is", null).order("id").range(f, t)),
    // Links a person drew, or accepted: they hold the equipment.
    all<{ a: string; b: string }>((f, t) => admin.from("estate_edges").select("a, b").eq("org_id", orgId).neq("status", "dismissed").like("b", "asset:%")
      .or("origin.in.(human,person),decided_by.not.is.null").order("id").range(f, t)),
    all<{ a: string; b: string }>((f, t) => admin.from("estate_edges").select("a, b").eq("org_id", orgId).neq("status", "dismissed").like("a", "asset:%")
      .or("origin.in.(human,person),decided_by.not.is.null").order("id").range(f, t)),
  ]);
  // A table an older schema lacks holds nothing; one that can't be read is a
  // reason to stop: nothing is removed on a guess.
  const reads = [["photos", photos], ["files", files], ["notes", notes], ["nicknames", aliases], ["typed document tags", typed], ["findings", findings], ["work orders", works], ["links", personToB], ["links", personFromA]] as const;
  for (const [name, r] of reads) if (r.error && (name === "photos" || name === "files" || !missingTable(r.error))) throw new Error(`Couldn't read the equipment's ${name}, so nothing was changed. Try again.`);
  const photoN = count(ids(photos.rows));
  const fileN = count(ids(files.rows));
  const refs = count([
    ...ids(notes.rows), ...ids(aliases.rows), ...ids(typed.rows), ...ids(findings.rows),
    ...works.rows.map((m) => String((m.attributes ?? {}).equipment_asset_id ?? "")).filter(Boolean),
    ...[...personToB.rows, ...personFromA.rows].flatMap((e) => [e.a, e.b]).filter((n) => n.startsWith("asset:")).map((n) => n.slice(6)),
  ]);
  const list = assets.rows.map((a) => ({
    id: a.id, tag: a.tag, code: a.code, unitCode: a.unit_code, origin: a.origin, archived: a.archived, createdAt: a.created_at,
    photos: photoN.get(a.id) ?? 0, files: fileN.get(a.id) ?? 0, refs: refs.get(a.id) ?? 0, edited: !!a.updated_by, coverPhotoId: a.cover_photo_id,
  }));

  // ── Drawings: what the reader wrote, and the links it drew ──────────
  const [sugg, readerAdded, journal, libs, readerEdges] = await Promise.all([
    all<{ document_id: string; status: string }>((f, t) => admin.from("document_equipment_suggestions").select("document_id, status").eq("org_id", orgId).order("document_id").range(f, t)),
    all<{ document_id: string; reader_added: unknown }>((f, t) => admin.from("document_equipment_suggestions").select("document_id, reader_added").eq("org_id", orgId).order("document_id").range(f, t)),
    all<{ document_id: string | null; change: Record<string, unknown> | null }>((f, t) => admin.from("estate_run_changes").select("document_id, change").eq("org_id", orgId).eq("kind", "doc").is("undone_at", null).order("id").range(f, t)),
    admin.from("libraries").select("id, equipment_bridge").eq("org_id", orgId).limit(500),
    all<{ id: string; a: string }>((f, t) => admin.from("estate_edges").select("id, a").eq("org_id", orgId).eq("type", "tagged_to").like("a", "doc:%").like("b", "asset:%")
      .in("origin", READER).is("decided_by", null).neq("status", "dismissed").order("id").range(f, t)),
  ]);
  const keyOf = new Map(((libs.data ?? []) as Array<{ id: string; equipment_bridge: { targetColumnKey?: string } | null }>).map((l) => [l.id, l.equipment_bridge?.targetColumnKey ?? null]));
  const proven = new Map<string, string[]>();
  const add = (doc: string, tags: string[]) => { if (tags.length) proven.set(doc, [...(proven.get(doc) ?? []), ...tags]); };
  for (const r of readerAdded.rows) add(r.document_id, columnList(r.reader_added));
  const byDoc = new Map<string, Array<{ key: string | null; before: unknown; after: unknown }>>();
  for (const r of journal.rows) {
    const col = (r.change?.column ?? null) as { before?: unknown; after?: unknown } | null;
    if (!r.document_id || !col) continue;
    byDoc.set(r.document_id, [...(byDoc.get(r.document_id) ?? []), { key: (r.change?.key as string | null) ?? null, before: col.before, after: col.after }]);
  }
  const linksOf = new Map<string, string[]>();
  for (const e of readerEdges.rows) { const d = e.a.slice(4); linksOf.set(d, [...(linksOf.get(d) ?? []), e.id]); }
  const docIds = [...new Set([...proven.keys(), ...byDoc.keys(), ...linksOf.keys()])];
  const drawings: DrawingCleanup[] = [];
  for (const slice of chunks(docIds)) {
    const { data } = await admin.from("documents").select("id, library_id, metadata, document_number, title, name").eq("org_id", orgId).in("id", slice);
    for (const d of (data ?? []) as Array<{ id: string; library_id: string | null; metadata: Record<string, unknown> | null; document_number: string | null; title: string | null; name: string | null }>) {
      const key = d.library_id ? keyOf.get(d.library_id) ?? null : null;
      const ran = (byDoc.get(d.id) ?? []).filter((c) => !c.key || c.key === key);
      const known = [...(proven.get(d.id) ?? []), ...journalAdditions(ran)];
      const { removed } = key ? withoutReaderEntries(columnList(d.metadata?.[key]), known) : { removed: [] as string[] };
      const links = linksOf.get(d.id) ?? [];
      if (!removed.length && !links.length) continue;
      drawings.push({ documentId: d.id, label: d.document_number || d.title || d.name || d.id.slice(0, 8), key, removed, links });
    }
  }
  drawings.sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true }));
  return { assets: list, drawings, suggestions: sugg.rows.filter((r) => r.status !== "dismissed").length, tracked: readerAdded.ok };
}

function preview(g: Gathered, keepEdited: boolean): StartOverPreview {
  const plan = planStartOver(g.assets, { keepEdited });
  const docs = g.drawings.map((d) => ({ documentId: d.documentId, removed: d.removed, links: d.links.length }));
  return {
    planKey: planKey(plan, docs),
    plan,
    drawings: {
      list: g.drawings.map((d) => ({ documentId: d.documentId, label: d.label, removed: d.removed, links: d.links.length })),
      entries: g.drawings.reduce((n, d) => n + d.removed.length, 0),
      links: g.drawings.reduce((n, d) => n + d.links.length, 0),
      suggestions: g.suggestions,
      tracked: g.tracked,
    },
    totals: {
      assets: g.assets.length,
      reader: g.assets.filter((a) => a.origin === "drawing").length,
      edited: g.assets.filter((a) => a.origin === "drawing" && a.edited && !a.photos && !a.files && !a.refs).length,
    },
  };
}

export async function previewStartOver(admin: Admin, orgId: string, opts: { keepEdited?: boolean } = {}): Promise<StartOverPreview> {
  return preview(await gather(admin, orgId), !!opts.keepEdited);
}

export class PlanChanged extends Error {
  constructor(public preview: StartOverPreview) { super("The equipment changed since the preview. Look at it again before starting over."); }
}

export interface StartOverResult { removed: number; merged: number; moved: { photos: number; files: number; links: number }; entries: number; drawings: number; links: number; suggestions: number; skipped: string[] }

/** Every row of `table` that points at `from` moves to `to`; one `to`
 *  already has (the same document, alias or page) is dropped instead. */
async function moveRows(admin: Admin, table: string, from: string, to: string, sameAs: string[]): Promise<number> {
  const cols = ["id", ...sameAs].join(", ");
  const { rows: mine, ok } = await all<Record<string, unknown>>((f, t) => admin.from(table).select(cols).eq("asset_id", from).order("id").range(f, t));
  if (!ok || !mine.length) return 0;
  const { rows: theirs } = await all<Record<string, unknown>>((f, t) => admin.from(table).select(cols).eq("asset_id", to).order("id").range(f, t));
  const sig = (r: Record<string, unknown>) => sameAs.map((c) => String(r[c] ?? "")).join("|");
  const held = new Set(theirs.map(sig));
  const rows = mine as Array<Record<string, unknown> & { id: string }>;
  const dup = rows.filter((r) => held.has(sig(r))).map((r) => r.id);
  const move = rows.filter((r) => !held.has(sig(r))).map((r) => r.id);
  for (const s of chunks(dup)) await admin.from(table).delete().in("id", s);
  for (const s of chunks(move)) await admin.from(table).update({ asset_id: to }).in("id", s);
  return move.length;
}

/** Everything hung on `from` moves onto `to`: photos, files, typed tags,
 *  nicknames, mentions, notes, findings, work orders and links. */
async function moveAll(admin: Admin, orgId: string, from: string, to: string): Promise<{ photos: number; files: number; links: number }> {
  const { data: ph } = await admin.from("asset_photos").update({ asset_id: to }).eq("asset_id", from).select("id");
  const files = await moveRows(admin, "asset_files", from, to, ["document_id"]);
  await moveRows(admin, "document_assets", from, to, ["document_id"]);
  await moveRows(admin, "asset_aliases", from, to, ["alias_normalized"]);
  await moveRows(admin, "entity_mentions", from, to, ["knowledge_document_id", "document_id", "page"]);
  await admin.from("notes").update({ asset_id: to }).eq("asset_id", from).then(() => undefined, () => undefined);
  await admin.from("project_findings").update({ asset_id: to }).eq("asset_id", from).then(() => undefined, () => undefined);
  const { rows: works } = await all<{ id: string; attributes: Record<string, unknown> }>((f, t) => admin.from("milestones").select("id, attributes").eq("org_id", orgId).eq("attributes->>equipment_asset_id", from).order("id").range(f, t));
  for (const m of works) {
    await admin.from("milestones").update({ attributes: { ...m.attributes, equipment_asset_id: to } }).eq("id", m.id);
  }
  // Links: re-pointed, or dropped where the kept record already has the same one.
  let links = 0;
  const node = (n: string) => (n === `asset:${from}` ? `asset:${to}` : n);
  const { rows: edges } = await all<{ id: string; a: string; b: string; type: string }>((f, t) => admin.from("estate_edges").select("id, a, b, type").eq("org_id", orgId).or(`a.eq.asset:${from},b.eq.asset:${from}`).order("id").range(f, t));
  for (const e of edges) {
    const a = node(e.a), b = node(e.b);
    const { data: twin } = await admin.from("estate_edges").select("id").eq("org_id", orgId).eq("a", a).eq("b", b).eq("type", e.type).limit(1);
    if ((twin ?? []).length || a === b) await admin.from("estate_edges").delete().eq("id", e.id);
    else { const { error } = await admin.from("estate_edges").update({ a, b }).eq("id", e.id); if (!error) links++; }
  }
  return { photos: (ph ?? []).length, files, links };
}

export async function runStartOver(admin: Admin, orgId: string, input: { planKey: string; keepEdited?: boolean; actor: { userId: string; name: string | null } }): Promise<StartOverResult> {
  const g = await gather(admin, orgId);
  const p = preview(g, !!input.keepEdited);
  if (p.planKey !== input.planKey) throw new PlanChanged(p);
  const out: StartOverResult = { removed: 0, merged: 0, moved: { photos: 0, files: 0, links: 0 }, entries: 0, drawings: 0, links: 0, suggestions: 0, skipped: [] };
  const byId = new Map(g.assets.map((a) => [a.id, a]));

  // 1. Copies of one piece become one.
  for (const m of p.plan.merges) {
    const { data: keepRow } = await admin.from("assets").select("id, code, description, type_id, location, unit_code, cover_photo_id").eq("id", m.keep.id).eq("org_id", orgId).maybeSingle();
    if (!keepRow) { out.skipped.push(`${m.keep.tag}: gone before it could be kept`); continue; }
    const keep = keepRow as { id: string; code: string | null; description: string | null; type_id: string | null; location: string | null; unit_code: string | null; cover_photo_id: string | null };
    for (const d of m.drop) {
      const { data: dropRow } = await admin.from("assets").select("id, origin, code, description, type_id, location, unit_code, cover_photo_id").eq("id", d.id).eq("org_id", orgId).maybeSingle();
      const drop = dropRow as { id: string; origin: string | null; code: string | null; description: string | null; type_id: string | null; location: string | null; unit_code: string | null; cover_photo_id: string | null } | null;
      if (!drop) continue;
      if (drop.origin === "manual") { out.skipped.push(`${d.tag}: added by a person, left as it is`); continue; }
      const moved = await moveAll(admin, orgId, drop.id, keep.id);
      out.moved.photos += moved.photos; out.moved.files += moved.files; out.moved.links += moved.links;
      // What the kept record lacks, the copy fills in (never overwrites).
      const patch: Record<string, unknown> = {};
      if (!keep.description && drop.description) patch.description = keep.description = drop.description;
      if (!keep.type_id && drop.type_id) patch.type_id = keep.type_id = drop.type_id;
      if (!keep.location && drop.location) patch.location = keep.location = drop.location;
      if (!keep.unit_code && drop.unit_code) patch.unit_code = keep.unit_code = drop.unit_code;
      if (!keep.cover_photo_id && drop.cover_photo_id) patch.cover_photo_id = keep.cover_photo_id = drop.cover_photo_id;
      // The ID last, once the copy that holds it is gone (an ID is one piece).
      const code = !keep.code && drop.code ? drop.code : null;
      if (Object.keys(patch).length) await admin.from("assets").update(patch).eq("id", keep.id).eq("org_id", orgId);
      // Nothing left on it: then, and only then, the copy goes.
      const [{ count: ph }, { count: fl }] = await Promise.all([
        admin.from("asset_photos").select("id", { count: "exact", head: true }).eq("asset_id", drop.id),
        admin.from("asset_files").select("id", { count: "exact", head: true }).eq("asset_id", drop.id),
      ]);
      if ((ph ?? 0) > 0 || (fl ?? 0) > 0) { out.skipped.push(`${d.tag}: its photos or files didn't move, left as it is`); continue; }
      const { data: del } = await admin.from("assets").delete().eq("id", drop.id).eq("org_id", orgId).neq("origin", "manual").select("id");
      if ((del ?? []).length) {
        out.merged++;
        if (code) { const { error } = await admin.from("assets").update({ code }).eq("id", keep.id).eq("org_id", orgId); if (!error) keep.code = code; }
      }
    }
  }

  // 2. What the reader made that nothing holds on to.
  const go = p.plan.remove.map((a) => a.id).filter((id) => byId.get(id)?.origin === "drawing");
  for (const s of chunks(go)) {
    const nodes = s.map((id) => `asset:${id}`);
    await admin.from("estate_edges").delete().eq("org_id", orgId).in("b", nodes).in("origin", MACHINE).is("decided_by", null);
    await admin.from("estate_edges").delete().eq("org_id", orgId).in("a", nodes).in("origin", MACHINE).is("decided_by", null);
    const { data: del, error } = await admin.from("assets").delete().eq("org_id", orgId).eq("origin", "drawing").in("id", s).select("id");
    if (error) out.skipped.push(`Couldn't remove ${s.length} records: ${error.message}`);
    out.removed += (del ?? []).length;
  }

  // 3. Drawings: the reader's entries and links come off; typed ones stay.
  for (const d of g.drawings) {
    let touched = false;
    if (d.key && d.removed.length) {
      // Read fresh, so an edit made a moment ago is kept.
      const { data: doc } = await admin.from("documents").select("metadata").eq("id", d.documentId).eq("org_id", orgId).maybeSingle();
      const md = ((doc as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}) as Record<string, unknown>;
      const { keep, removed } = withoutReaderEntries(columnList(md[d.key]), d.removed);
      if (removed.length) {
        const { error } = await admin.from("documents").update({ metadata: { ...md, [d.key]: keep } }).eq("id", d.documentId).eq("org_id", orgId);
        if (!error) { out.entries += removed.length; touched = true; }
      }
    }
    for (const s of chunks(d.links)) {
      const { data: del } = await admin.from("estate_edges").delete().in("id", s).in("origin", READER).is("decided_by", null).select("id");
      out.links += (del ?? []).length;
      if ((del ?? []).length) touched = true;
    }
    if (touched) out.drawings++;
  }
  // The reader's memory of each sheet: read again from scratch. A sheet a
  // person dismissed stays dismissed.
  const { data: cleared } = await admin.from("document_equipment_suggestions").delete().eq("org_id", orgId).neq("status", "dismissed").select("document_id");
  out.suggestions = (cleared ?? []).length;

  await admin.from("audit_logs").insert({
    action: "EQUIPMENT_START_OVER", resource_type: "asset", resource_id: orgId, org_id: orgId, user_id: input.actor.userId,
    details: {
      by: input.actor.name, removed: out.removed, merged: out.merged, moved: out.moved, entries: out.entries, drawings: out.drawings, links: out.links, suggestions: out.suggestions,
      removedTags: p.plan.remove.map((a) => `${a.tag}${a.code ? ` (${a.code})` : ""}${a.unitCode ? ` u${a.unitCode}` : ""}`).slice(0, 2000),
      merges: p.plan.merges.map((m) => ({ keep: m.keep.id, tag: m.keep.tag, drop: m.drop.map((x) => x.id) })),
      skipped: out.skipped.slice(0, 200), keepEdited: !!input.keepEdited,
    },
  }).then(() => undefined, () => undefined);
  return out;
}

export interface RereadResult { drawings: number; applied: number; assets: number; left: number; libraries: number; linked: boolean }

/** Read the drawings again: every read sheet is matched to the registry
 *  with today's rules (by ID, then tag in the unit), from the readings
 *  already stored, so no AI is paid twice. Bounded by a deadline: call
 *  again while `left` > 0. Journaled under `runId`, so it can be undone. */
export async function rereadDrawings(admin: Admin, orgId: string, input: { runId: string; actor: { userId: string; name: string | null }; deadlineMs: number }): Promise<RereadResult> {
  const { buildRegistry } = await import("@/lib/estate/connectServer");
  const { data: libs } = await admin.from("knowledge_libraries").select("id, ai_features").eq("org_id", orgId).limit(200);
  const drawingLibs = ((libs ?? []) as Array<{ id: string; ai_features: Record<string, unknown> | null }>).filter((l) => (l.ai_features ?? {}).drawingIntel === true);
  const out: RereadResult = { drawings: 0, applied: 0, assets: 0, left: 0, libraries: drawingLibs.length, linked: false };
  const run = { runId: input.runId, label: "Start over: read the drawings again", actor: input.actor };
  for (const l of drawingLibs) {
    if (Date.now() > input.deadlineMs) { out.left += 1; continue; }
    const r = await buildRegistry(admin, orgId, l.id, input.actor.userId, input.deadlineMs, run);
    out.drawings += r.drawings; out.applied += r.applied; out.assets += r.assets; out.left += r.left;
  }
  // Then the links between files, folders and equipment, once all are read.
  if (out.left === 0 && Date.now() < input.deadlineMs - 5_000) {
    try {
      const { resolveEstate } = await import("@/lib/estate/resolverServer");
      await resolveEstate(admin, { orgId, all: true, actor: input.actor });
      out.linked = true;
    } catch { /* the links catch up on the next Connect */ }
  }
  await admin.from("audit_logs").insert({
    action: "EQUIPMENT_REREAD", resource_type: "asset", resource_id: input.runId, org_id: orgId, user_id: input.actor.userId,
    details: { runId: input.runId, ...out, by: input.actor.name },
  }).then(() => undefined, () => undefined);
  return out;
}
