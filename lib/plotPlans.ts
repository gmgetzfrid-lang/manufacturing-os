// lib/plotPlans.ts
//
// CRUD for spatial plot plans — a background image (plot plan / P&ID / unit
// layout) with asset markers placed on it in percentage coordinates. Markers
// are stored as JSONB on the row; the canonical equipment state they're
// colored by lives on the asset (lib/whiteboard.ts).

import { supabase } from "@/lib/supabase";
import { uploadToPath, getSignedUrlForPath } from "@/lib/storage";
import type { PlotPlan, PlotPlanMarker } from "@/types/schema";

function rowToPlotPlan(r: Record<string, unknown>): PlotPlan {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    name: (r.name as string) ?? "",
    description: (r.description as string) ?? null,
    plantId: (r.plant_id as string) ?? null,
    unitId: (r.unit_id as string) ?? null,
    systemId: (r.system_id as string) ?? null,
    imagePath: (r.image_path as string) ?? null,
    imageWidth: (r.image_width as number) ?? null,
    imageHeight: (r.image_height as number) ?? null,
    markers: Array.isArray(r.markers) ? (r.markers as PlotPlanMarker[]) : [],
    createdBy: (r.created_by as string) ?? null,
    createdByName: (r.created_by_name as string) ?? null,
    createdAt: (r.created_at as string) ?? undefined,
    updatedAt: (r.updated_at as string) ?? undefined,
    updatedBy: (r.updated_by as string) ?? null,
  };
}

export async function listPlotPlans(orgId: string): Promise<PlotPlan[]> {
  const { data, error } = await supabase
    .from("plot_plans")
    .select("*")
    .eq("org_id", orgId)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data as Array<Record<string, unknown>>) ?? []).map(rowToPlotPlan);
}

export async function getPlotPlan(id: string): Promise<PlotPlan | null> {
  const { data, error } = await supabase.from("plot_plans").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? rowToPlotPlan(data as Record<string, unknown>) : null;
}

/** Upload a background image to R2 and create the plot plan row. */
export async function createPlotPlan(input: {
  orgId: string;
  name: string;
  description?: string;
  plantId?: string | null;
  unitId?: string | null;
  systemId?: string | null;
  image?: File;
  imageWidth?: number;
  imageHeight?: number;
  actorUserId: string;
  actorName?: string;
}): Promise<PlotPlan> {
  let imagePath: string | null = null;
  if (input.image) {
    const safe = input.image.name.replace(/[^\w.\-]+/g, "_");
    const path = `orgs/${input.orgId}/plot-plans/${crypto.randomUUID()}-${safe}`;
    const res = await uploadToPath(input.image, path, { contentType: input.image.type || undefined });
    imagePath = res.path;
  }

  const { data, error } = await supabase
    .from("plot_plans")
    .insert({
      org_id: input.orgId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      plant_id: input.plantId ?? null,
      unit_id: input.unitId ?? null,
      system_id: input.systemId ?? null,
      image_path: imagePath,
      image_width: input.imageWidth ?? null,
      image_height: input.imageHeight ?? null,
      markers: [],
      created_by: input.actorUserId,
      created_by_name: input.actorName ?? null,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to create plot plan");
  return rowToPlotPlan(data as Record<string, unknown>);
}

/** Replace the full marker set (the editor is the authority for placement). */
export async function saveMarkers(input: {
  id: string;
  markers: PlotPlanMarker[];
  actorUserId: string;
}): Promise<void> {
  const { error } = await supabase
    .from("plot_plans")
    .update({ markers: input.markers, updated_at: new Date().toISOString(), updated_by: input.actorUserId })
    .eq("id", input.id);
  if (error) throw new Error(error.message);
}

export async function deletePlotPlan(id: string): Promise<void> {
  const { error } = await supabase.from("plot_plans").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Presign the background image path for display. */
export async function resolvePlotPlanImage(imagePath: string | null | undefined): Promise<string | null> {
  if (!imagePath) return null;
  try { return await getSignedUrlForPath(imagePath); } catch { return null; }
}
