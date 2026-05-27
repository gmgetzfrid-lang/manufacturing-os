// lib/libraryViews.ts
//
// Saved views for a library — admin defines defaults, users save
// their own. A view = snapshot of (filter + sort + display config)
// applied with one click.

import { supabase } from "@/lib/supabase";

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
  const { error } = await supabase.from("library_views").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function setDefault(id: string, scope: "org" | "user", ownerUserId?: string, libraryId?: string): Promise<void> {
  // Clear other defaults for this scope first
  if (scope === "org" && libraryId) {
    await supabase
      .from("library_views")
      .update({ is_default: false })
      .eq("library_id", libraryId)
      .eq("scope", "org");
  } else if (scope === "user" && ownerUserId) {
    await supabase
      .from("library_views")
      .update({ is_default: false })
      .eq("owner_user_id", ownerUserId)
      .eq("scope", "user");
  }
  const { error } = await supabase
    .from("library_views")
    .update({ is_default: true })
    .eq("id", id);
  if (error) throw new Error(error.message);
}
