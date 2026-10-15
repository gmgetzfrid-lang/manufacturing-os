// lib/thor/client.ts — the browser's side of THOR search.
//
// Everything goes through the signed-in user's own Supabase session: the
// thor_search / thor_overview RPCs check org membership, and the thor_*
// tables are readable only by active members (migration 20261022). Nothing
// here is reachable without a login.

import { supabase } from "@/lib/supabase";
import { THOR_KINDS, THOR_TYPES, type ThorQuery, type ThorSort } from "./query";

export interface ThorFile {
  file_id: string;
  root_id: string;
  unc_path: string;
  rel_path: string;
  folder_rel: string;
  filename: string;
  ext: string;
  size_bytes: number | null;
  modified_at: string | null;
  unit_folder: string | null;
  unit_code: string | null;
  category_folder: string | null;
  folder_role: string | null;
  equipment_numbers: string[];
  observation_state: string;
  rank: number;
}

/** What the person set by hand: quick filters and the advanced panel. */
export interface ThorFilters {
  types: string[];
  kinds: string[];
  units: string[];
  /** Extra extensions typed in the advanced panel ("plf, fmscan"). */
  exts: string[];
  equipment: string[];
  roles: string[];
  folder?: string;
  nameContains?: string;
  after?: string;
  before?: string;
  minSize?: number;
  maxSize?: number;
  includeExcluded?: boolean;
  sort?: ThorSort;
}

export const EMPTY_FILTERS: ThorFilters = { types: [], kinds: [], units: [], exts: [], equipment: [], roles: [] };

export function filtersActive(f: ThorFilters): number {
  return f.types.length + f.kinds.length + f.units.length + f.exts.length + f.equipment.length + f.roles.length
    + [f.folder, f.nameContains, f.after, f.before, f.minSize, f.maxSize, f.includeExcluded].filter((x) => x != null && x !== "" && x !== false).length;
}

export interface ThorSearchArgs {
  p_org: string;
  p_terms: string[];
  p_tags: string[];
  p_kind_exts: string[] | null;
  p_kind_roles: string[] | null;
  p_exts: string[] | null;
  p_units: string[] | null;
  p_equipment: string[] | null;
  p_folder: string | null;
  p_roles: string[] | null;
  p_min_size: number | null;
  p_max_size: number | null;
  p_after: string | null;
  p_before: string | null;
  p_name_contains: string | null;
  p_include_excluded: boolean;
  p_sort: ThorSort;
  p_limit: number;
  p_offset: number;
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const orNull = <T,>(xs: T[]) => (xs.length ? xs : null);

/** Query words + hand-set filters → the RPC's arguments. Hand-set wins on scalars. */
export function buildArgs(orgId: string, q: ThorQuery | null, f: ThorFilters, page: { limit: number; offset: number }): ThorSearchArgs {
  const kinds = uniq([...(q?.kinds ?? []), ...f.kinds]).map((k) => THOR_KINDS.find((x) => x.key === k)).filter((k): k is NonNullable<typeof k> => !!k);
  const typeExts = uniq([...(q?.types ?? []), ...f.types]).flatMap((t) => THOR_TYPES.find((x) => x.key === t)?.exts ?? []);
  const exts = uniq([...typeExts, ...f.exts.map((e) => e.toLowerCase().replace(/^\./, "").trim()).filter(Boolean)]);
  const kindExts = uniq(kinds.flatMap((k) => k.exts ?? []));
  const kindRoles = uniq(kinds.flatMap((k) => k.roles ?? []));
  const terms = q?.terms ?? [];
  const sort = f.sort ?? q?.sort ?? (terms.length || q?.tags.length ? "relevance" : "newest");
  return {
    p_org: orgId,
    p_terms: terms,
    p_tags: q?.tags ?? [],
    p_kind_exts: kinds.length ? kindExts : null,
    p_kind_roles: kinds.length ? kindRoles : null,
    p_exts: orNull(exts),
    p_units: orNull(uniq([...(q?.units ?? []), ...f.units])),
    p_equipment: orNull(f.equipment),
    p_folder: f.folder || null,
    p_roles: orNull(f.roles),
    p_min_size: f.minSize ?? q?.minSize ?? null,
    p_max_size: f.maxSize ?? q?.maxSize ?? null,
    p_after: f.after ?? q?.after ?? null,
    p_before: f.before ?? q?.before ?? null,
    p_name_contains: f.nameContains?.trim() || null,
    p_include_excluded: !!f.includeExcluded,
    p_sort: sort,
    p_limit: page.limit,
    p_offset: page.offset,
  };
}

export interface ThorPage {
  rows: ThorFile[];
  /** Matches, counted up to 10,000. */
  total: number;
  /** More than `total` match. */
  capped: boolean;
  /** Equipment numbers the query's tags resolved to (null: no tags). */
  resolvedEquipment: string[] | null;
}

export async function thorSearch(args: ThorSearchArgs, signal?: AbortSignal): Promise<ThorPage> {
  let req = supabase.rpc("thor_search", args);
  if (signal) req = req.abortSignal(signal);
  const { data, error } = await req;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<ThorFile & { total_count: number; total_capped: boolean; resolved_equipment: string[] | null }>;
  return {
    rows,
    total: rows.length ? Number(rows[0].total_count) : (args.p_offset > 0 ? args.p_offset : 0),
    capped: !!rows[0]?.total_capped,
    resolvedEquipment: rows[0]?.resolved_equipment ?? null,
  };
}

export interface ThorOverview {
  roots: Array<{ root_id: string; source: string; unc_path: string; last_crawl_at: string | null; explorer_completed_at: string | null; indexer_version: string | null; imported_at: string }>;
  crawls: Array<{ crawl_id: string; started_at: string | null; completed_at: string | null; status: string; files_seen: number; dirs_seen: number; issues: number }>;
  files: number;
  directories: number;
  units: Array<{ code: string | null; folder: string; files: number; bytes: number; indexed_at: string | null }>;
  exts: Record<string, number>;
}

/** Null when THOR is not set up for this org (migration not applied / nothing imported). */
export async function thorOverview(orgId: string): Promise<ThorOverview | null> {
  const { data, error } = await supabase.rpc("thor_overview", { p_org: orgId });
  if (error) {
    if (/function .*thor_overview|does not exist|schema cache/i.test(error.message)) return null;
    throw new Error(error.message);
  }
  const o = data as ThorOverview;
  return o && o.files > 0 ? o : null;
}

export interface ThorDirectory {
  rel_path: string;
  unc_path: string;
  name: string;
  depth: number;
  role: string | null;
  indexed_at: string | null;
  crawl_state: string | null;
  file_count: number;
  total_files: number;
  total_bytes: number;
  latest_modified_at: string | null;
}

/** Folders directly under `parent` ('' = the share root), as the crawl walked them. */
export async function thorChildren(orgId: string, parent: string): Promise<ThorDirectory[]> {
  const { data, error } = await supabase.from("thor_directories")
    .select("rel_path, unc_path, name, depth, role, indexed_at, crawl_state, file_count, total_files, total_bytes, latest_modified_at")
    .eq("org_id", orgId).eq("parent_rel", parent).order("name").limit(2000);
  if (error) throw new Error(error.message);
  return (data ?? []) as ThorDirectory[];
}

export interface ThorFileDetail {
  equipment: Array<{ number: string; names: string[]; link: { basis: string; confidence: number } | null }>;
  families: Array<{ base: string; type: string; sheet: string | null; revision: string | null; confidence: number }>;
  identifiers: Array<{ type: string; value: string; source: string }>;
}

/** What the indexer knew about one file: equipment (with how it decided), drawing family, identifiers. */
export async function thorFileDetail(orgId: string, f: Pick<ThorFile, "file_id" | "equipment_numbers">): Promise<ThorFileDetail> {
  const [links, ents, members, idents] = await Promise.all([
    supabase.from("thor_file_entities").select("entity_id, link_type, basis, confidence").eq("org_id", orgId).eq("file_id", f.file_id),
    f.equipment_numbers.length
      ? supabase.from("thor_entities").select("entity_id, canonical_name").eq("org_id", orgId).eq("entity_type", "equipment").in("canonical_name", f.equipment_numbers)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("thor_doc_members").select("family_id, sheet, revision, confidence").eq("org_id", orgId).eq("file_id", f.file_id),
    supabase.from("thor_identifiers").select("type, value, source").eq("org_id", orgId).eq("file_id", f.file_id).limit(50),
  ]);
  const entRows = (ents.data ?? []) as Array<{ entity_id: string; canonical_name: string }>;
  const ids = entRows.map((e) => e.entity_id);
  const pairs = ids.length
    ? ((await supabase.from("thor_alias_entities").select("alias_id, entity_id").eq("org_id", orgId).in("entity_id", ids)).data ?? []) as Array<{ alias_id: string; entity_id: string }>
    : [];
  const aliasById = new Map(
    (pairs.length
      ? ((await supabase.from("thor_aliases").select("alias_id, value, alias_type").eq("org_id", orgId).in("alias_id", pairs.map((p) => p.alias_id))).data ?? [])
      : []).map((a: { alias_id: string; value: string; alias_type: string }) => [a.alias_id, a]),
  );
  const aliasRows = pairs.flatMap((p) => { const a = aliasById.get(p.alias_id); return a ? [{ entity_id: p.entity_id, thor_aliases: a }] : []; });
  const famIds = ((members.data ?? []) as Array<{ family_id: string }>).map((m) => m.family_id);
  const fams = famIds.length
    ? ((await supabase.from("thor_doc_families").select("family_id, base_identifier, family_type").eq("org_id", orgId).in("family_id", famIds)).data ?? []) as Array<{ family_id: string; base_identifier: string; family_type: string }>
    : [];
  const linkRows = (links.data ?? []) as Array<{ entity_id: string; link_type: string; basis: string; confidence: number }>;
  return {
    equipment: f.equipment_numbers.map((n) => {
      const e = entRows.find((x) => x.canonical_name === n);
      const names = aliasRows.filter((a) => a.entity_id === e?.entity_id && a.thor_aliases.alias_type !== "equipment_number")
        .sort((a, b) => (a.thor_aliases.alias_type === "equipment_tag" ? -1 : 1) - (b.thor_aliases.alias_type === "equipment_tag" ? -1 : 1))
        .map((a) => a.thor_aliases.value);
      const l = linkRows.find((x) => x.entity_id === e?.entity_id);
      return { number: n, names: [...new Set(names)].slice(0, 4), link: l ? { basis: l.basis, confidence: l.confidence } : null };
    }),
    families: ((members.data ?? []) as Array<{ family_id: string; sheet: string | null; revision: string | null; confidence: number }>).map((m) => {
      const fam = fams.find((x) => x.family_id === m.family_id);
      return { base: fam?.base_identifier ?? m.family_id, type: fam?.family_type ?? "", sheet: m.sheet, revision: m.revision, confidence: m.confidence };
    }),
    identifiers: (idents.data ?? []) as ThorFileDetail["identifiers"],
  };
}
