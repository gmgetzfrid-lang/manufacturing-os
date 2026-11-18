// lib/libraryViews.ts
//
// Saved views for a library — admin defines defaults, users save
// their own. A view = snapshot of (filter + sort + display config)
// applied with one click.

import { supabase } from "@/lib/supabase";
// SAF-18 (J15a): every update/delete here reads its matched rows.
import { checkedWrite, CHECKED_WRITE_REFUSED, type CheckedWriteResult } from "@/lib/checkedWrite";

export interface LibraryView {
  id: string;
  org_id: string;
  library_id: string | null;
  name: string;
  description: string | null;
  scope: "org" | "user";
  owner_user_id: string | null;
  filter_config: ViewFilterConfig;
  sort_config: ViewSortConfig;
  display_config: ViewDisplayConfig;
  is_default: boolean;
  pinned: boolean;
  created_by: string;
  created_at: string;
}

export interface ViewFilterConfig {
  search?: string;
  status?: string[];
  type?: string;
  customFilters?: Record<string, string | string[]>;
}

export interface ViewSortConfig {
  key: string;          // e.g. "updatedAt", "documentNumber", "sort_order"
  dir: "asc" | "desc";
}

export interface ViewDisplayConfig {
  density?: "compact" | "comfy";
  visibleColumns?: string[];
}

export async function listViews(params: {
  orgId: string;
  libraryId: string;
  userId: string;
}): Promise<LibraryView[]> {
  const { data, error } = await supabase
    .from("library_views")
    .select("*")
    .eq("org_id", params.orgId)
    .eq("library_id", params.libraryId)
    .or(`scope.eq.org,owner_user_id.eq.${params.userId}`)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as LibraryView[]) ?? [];
}

export async function createView(input: {
  orgId: string;
  libraryId: string;
  name: string;
  description?: string;
  scope: "org" | "user";
  ownerUserId?: string;
  filterConfig: ViewFilterConfig;
  sortConfig: ViewSortConfig;
  displayConfig: ViewDisplayConfig;
  isDefault?: boolean;
  pinned?: boolean;
  createdBy: string;
}): Promise<LibraryView> {
  const { data, error } = await supabase
    .from("library_views")
    .insert({
      org_id: input.orgId,
      library_id: input.libraryId,
      name: input.name,
      description: input.description ?? null,
      scope: input.scope,
      owner_user_id: input.scope === "user" ? input.ownerUserId : null,
      filter_config: input.filterConfig,
      sort_config: input.sortConfig,
      display_config: input.displayConfig,
      is_default: input.isDefault ?? false,
      pinned: input.pinned ?? false,
      created_by: input.createdBy,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as LibraryView;
}

export async function deleteView(id: string): Promise<void> {
  // SAF-18 class (a): a delete that matched no row throws the typed refusal
  // (ViewSelector shows it) — never "deleted".
  const { data: deleted, error } = await supabase.from("library_views").delete().eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (!deleted || deleted.length === 0) throw new Error(`The view was not deleted. ${CHECKED_WRITE_REFUSED}`);
}

export async function setDefault(id: string, scope: "org" | "user", ownerUserId?: string, libraryId?: string): Promise<void> {
  // Clear other defaults for this scope first.
  // SAF-18 class (c): no other default to clear matches no row — a success;
  // a database error is said (the new default is still written, as before).
  let cleared: CheckedWriteResult | null = null;
  if (scope === "org" && libraryId) {
    cleared = await checkedWrite(supabase
      .from("library_views")
      .update({ is_default: false })
      .eq("library_id", libraryId)
      .eq("scope", "org")
      .select("id"));
  } else if (scope === "user" && ownerUserId) {
    cleared = await checkedWrite(supabase
      .from("library_views")
      .update({ is_default: false })
      .eq("owner_user_id", ownerUserId)
      .eq("scope", "user")
      .select("id"));
  }
  if (cleared && !cleared.ok && cleared.code === "db") console.warn(`[libraryViews] the previous default view could not be cleared: ${cleared.error}`);
  // SAF-18 class (a): the new default IS the decision — one that matched no
  // row throws the typed refusal.
  const { data: made, error } = await supabase
    .from("library_views")
    .update({ is_default: true })
    .eq("id", id)
    .select("id");
  if (error) throw new Error(error.message);
  if (!made || made.length === 0) throw new Error(`The view was not made the default. ${CHECKED_WRITE_REFUSED}`);
}
