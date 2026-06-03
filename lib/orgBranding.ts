// lib/orgBranding.ts
// Org-level white-label branding: a logo and an enforced color palette,
// stored in org_configurations under key='branding' (no schema change).
// Applied to every member of the org (see OrgBrandingProvider).

import { supabase } from "@/lib/supabase";
import type { Palette } from "@/components/providers/ThemeProvider";

export interface OrgBranding {
  /** Enforced palette for the whole org. */
  palette?: Palette;
  /** R2 storage path to the org logo (signed for display). */
  logoPath?: string;
  /** How the logo sits in the sidebar: 'mark' = square glyph, 'full' = wide wordmark. */
  logoShape?: "mark" | "full";
  updatedAt?: string;
}

const KEY = "branding";

export async function getOrgBranding(orgId: string): Promise<OrgBranding | null> {
  const { data, error } = await supabase
    .from("org_configurations")
    .select("data")
    .eq("org_id", orgId)
    .eq("key", KEY)
    .maybeSingle();
  if (error || !data) return null;
  return (data.data as OrgBranding) ?? null;
}

export async function saveOrgBranding(orgId: string, branding: OrgBranding): Promise<void> {
  const payload = { ...branding, updatedAt: new Date().toISOString() };
  const { error } = await supabase
    .from("org_configurations")
    .upsert({ org_id: orgId, key: KEY, data: payload, updated_at: new Date().toISOString() }, { onConflict: "org_id,key" });
  if (error) throw error;
}
