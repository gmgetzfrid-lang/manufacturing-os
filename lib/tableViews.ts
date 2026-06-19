// lib/tableViews.ts
// Supabase implementation — replaces Firestore version

import { supabase } from "@/lib/supabase";
import type { TableViewConfig, ViewColumn } from "@/types/schema";

const TABLE = "table_views";

type ViewScope = "user" | "org";

function safePart(v?: string | null) {
  const s = (v ?? "").trim();
  return s.length ? s.replaceAll("/", "_") : "none";
}

export function tableViewId(params: {
  scope: ViewScope;
  orgId?: string;
  ownerUserId?: string;
  libraryId?: string;
  collectionId?: string;
}) {
  const orgId = safePart(params.orgId);
  const libraryId = safePart(params.libraryId);
  const collectionId = safePart(params.collectionId);

  if (params.scope === "user") {
    const uid = safePart(params.ownerUserId);
    return `tv_user_${orgId}_${uid}_${libraryId}_${collectionId}`;
  }
  return `tv_org_${orgId}_org_${libraryId}_${collectionId}`;
}

export const BUILTIN_COLUMNS: { key: string; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "documentNumber", label: "Doc No." },
  { key: "rev", label: "Rev" },
  { key: "status", label: "Status" },
  { key: "updatedAt", label: "Updated" },
];

export function defaultColumnsFromSchema(opts?: {
  customColumns?: ViewColumn[];
  overrides?: ViewColumn[];
}) {
  const builtins = BUILTIN_COLUMNS.map((c) => c.key);
  const columns: string[] = [...builtins];
  const dynamic = (opts?.overrides?.length ? opts.overrides : opts?.customColumns) ?? [];

  for (const c of dynamic) {
    if (!c?.key) continue;
    if (c.visible !== false) columns.push(c.key);
  }

  return Array.from(new Set(columns));
}

export function mergeColumnsPreserveUserOrder(
  existing: string[],
  defaults: string[],
  opts?: { removeUnknown?: boolean }
) {
  const removeUnknown = opts?.removeUnknown ?? false;
  const existingSet = new Set(existing);
  const defaultsSet = new Set(defaults);

  let next = existing.slice();
  for (const d of defaults) {
    if (!existingSet.has(d)) next.push(d);
  }
  if (removeUnknown) {
    next = next.filter((k) => defaultsSet.has(k));
  }
  return Array.from(new Set(next));
}

function fromDb(row: Record<string, unknown>): TableViewConfig {
  return {
    id: row.id as string,
    orgId: row.org_id as string | undefined,
    ownerUserId: row.owner_user_id as string | undefined,
    name: (row.name as string) ?? '',
    libraryId: (row.library_id as string) ?? '',
    collectionId: row.collection_id as string | undefined,
    columns: (row.columns as string[]) ?? [],
    columnConfig: (row.column_config as TableViewConfig["columnConfig"]) ?? {},
    sort: (row.sort_config as TableViewConfig["sort"]) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string | undefined,
  };
}

export async function getTableView(params: {
  scope: ViewScope;
  orgId?: string;
  ownerUserId?: string;
  libraryId?: string;
  collectionId?: string;
}): Promise<TableViewConfig | null> {
  const id = tableViewId(params);
  // Use limit(1) array form instead of maybeSingle — some PostgREST versions
  // still respond 406 to maybeSingle when 0 rows match, polluting the console.
  const { data, error } = await supabase.from(TABLE).select("*").eq("id", id).limit(1);
  if (error || !data || data.length === 0) return null;
  return fromDb(data[0] as Record<string, unknown>);
}

export async function saveTableView(params: {
  scope: ViewScope;
  orgId?: string;
  ownerUserId?: string;
  name?: string;
  libraryId?: string;
  collectionId?: string;
  columns: string[];
  columnConfig?: TableViewConfig["columnConfig"];
  /** Per-folder default sort. Only written when provided, so a column-only
   *  save never clears an existing saved sort. Pass null to clear it. */
  sort?: TableViewConfig["sort"];
}): Promise<string> {
  const id = tableViewId(params);

  const payload: Record<string, unknown> = {
    id,
    org_id: params.orgId ?? null,
    owner_user_id: params.scope === "user" ? (params.ownerUserId ?? null) : null,
    name: params.name ?? (params.scope === "user" ? "My View" : "Org Default View"),
    library_id: params.libraryId ?? null,
    collection_id: params.collectionId ?? null,
    columns: params.columns,
    column_config: params.columnConfig ?? {},
    updated_at: new Date().toISOString(),
  };
  if (params.sort !== undefined) payload.sort_config = params.sort;

  let { error } = await supabase.from(TABLE).upsert(payload, { onConflict: "id" });
  // Pre-migration safety: if sort_config doesn't exist yet, retry without it so
  // column saves never break before the migration is applied.
  if (error && isMissingSortColumn(error)) {
    delete payload.sort_config;
    ({ error } = await supabase.from(TABLE).upsert(payload, { onConflict: "id" }));
  }
  if (error) throw new Error(error.message);
  return id;
}

/** True when an error is "column table_views.sort_config does not exist"
 *  (Postgres 42703 / PostgREST schema-cache miss) — migration not yet applied. */
function isMissingSortColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "42703" || error.code === "PGRST204" || /sort_config/i.test(error.message ?? "");
}

/** Resolve the effective per-folder default sort: a user's own pinned sort
 *  wins, else the org/folder default, else null (use the app default). */
export async function resolveEffectiveSort(params: {
  orgId?: string;
  ownerUserId?: string;
  libraryId?: string;
  collectionId?: string;
}): Promise<TableViewConfig["sort"]> {
  if (params.ownerUserId) {
    const userView = await getTableView({ scope: "user", ...params });
    if (userView?.sort) return userView.sort;
  }
  const orgView = await getTableView({ scope: "org", ...params });
  if (orgView?.sort) return orgView.sort;
  return null;
}

export async function resolveEffectiveColumns(params: {
  orgId?: string;
  ownerUserId?: string;
  libraryId?: string;
  collectionId?: string;
  defaultColumns: string[];
}): Promise<string[]> {
  if (params.ownerUserId) {
    const userView = await getTableView({ scope: "user", ...params });
    if (userView?.columns?.length) return userView.columns;
  }

  const orgView = await getTableView({ scope: "org", ...params });
  if (orgView?.columns?.length) return orgView.columns;

  return params.defaultColumns;
}

export async function deleteTableView(params: {
  scope: ViewScope;
  orgId?: string;
  ownerUserId?: string;
  libraryId?: string;
  collectionId?: string;
}) {
  const id = tableViewId(params);
  await supabase.from(TABLE).delete().eq("id", id);
}

export function listenTableView(
  params: {
    scope: ViewScope;
    orgId?: string;
    ownerUserId?: string;
    libraryId?: string;
    collectionId?: string;
  },
  cb: (view: TableViewConfig | null) => void
): () => void {
  let alive = true;
  const id = tableViewId(params);

  const fetch = async () => {
    const { data } = await supabase.from(TABLE).select("*").eq("id", id).limit(1);
    if (alive) cb(data && data.length > 0 ? fromDb(data[0] as Record<string, unknown>) : null);
  };

  fetch();

  const channel = supabase
    .channel(`table-view-${id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: TABLE, filter: `id=eq.${id}` }, () => {
      if (alive) fetch();
    })
    .subscribe();

  return () => {
    alive = false;
    supabase.removeChannel(channel);
  };
}

export function listenEffectiveColumns(
  params: {
    orgId?: string;
    ownerUserId?: string;
    libraryId?: string;
    collectionId?: string;
    defaultColumns: string[];
  },
  cb: (result: {
    scopeUsed: "user" | "org" | "default";
    columns: string[];
    userView: TableViewConfig | null;
    orgView: TableViewConfig | null;
  }) => void
): () => void {
  let userView: TableViewConfig | null = null;
  let orgView: TableViewConfig | null = null;

  const emit = () => {
    if (params.ownerUserId && userView?.columns?.length) {
      cb({ scopeUsed: "user", columns: userView.columns, userView, orgView });
      return;
    }
    if (orgView?.columns?.length) {
      cb({ scopeUsed: "org", columns: orgView.columns, userView, orgView });
      return;
    }
    cb({ scopeUsed: "default", columns: params.defaultColumns, userView, orgView });
  };

  const unsubs: Array<() => void> = [];

  unsubs.push(listenTableView({ scope: "org", ...params }, (v) => { orgView = v; emit(); }));

  if (params.ownerUserId) {
    unsubs.push(listenTableView({ scope: "user", ...params }, (v) => { userView = v; emit(); }));
  }

  emit();

  return () => { for (const u of unsubs) u(); };
}
