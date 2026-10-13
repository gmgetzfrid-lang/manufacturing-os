// lib/orgBranding.ts
// Org-level white-label branding: a logo and an enforced color palette,
// stored in org_configurations under key='branding' (no schema change).
// Applied to every member of the org (see OrgBrandingProvider).

import { supabase } from "@/lib/supabase";
import { isHexColor, type Palette } from "@/components/providers/ThemeProvider";
import { checkedWrite } from "@/lib/checkedWrite";
import { logAuditAction } from "@/lib/audit";

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

/** ORG-11: a palette is two "#RRGGBB" colours — the shape the branding
 *  page's colour inputs emit and the theme accepts. */
export function brandingPaletteProblem(p: unknown): string | null {
  if (p == null) return null;
  const o = p as Partial<Palette>;
  if (typeof o !== "object" || !isHexColor(o.primary) || !isHexColor(o.secondary)) {
    return "The palette must be two colours written as #RRGGBB (for example #ea580c).";
  }
  return null;
}

/** Saves the org branding. ORG-11: a palette that is not two "#RRGGBB"
 *  colours is refused before anything is written. The write reads back the
 *  row it stored (a write RLS refused is an error, never a silent success),
 *  and ALOG-4 dw2: the change is audited (BRANDING_CHANGED, before and
 *  after) — a refused audit row is returned for the caller to say. */
export async function saveOrgBranding(
  orgId: string,
  branding: OrgBranding,
  actor?: { uid: string | null; email?: string | null },
): Promise<{ auditError: string | null }> {
  const problem = brandingPaletteProblem(branding.palette);
  if (problem) throw new Error(problem);
  const before = await getOrgBranding(orgId);
  const payload = { ...branding, updatedAt: new Date().toISOString() };
  const res = await checkedWrite(supabase
    .from("org_configurations")
    .upsert({ org_id: orgId, key: KEY, data: payload, updated_at: new Date().toISOString() }, { onConflict: "org_id,key" })
    .select("id"));
  if (!res.ok) throw new Error(res.code === "refused" ? "The branding was not saved — only an Admin can change it." : res.error);
  if (!actor?.uid) return { auditError: null };
  const pick = (b: OrgBranding | null) => b ? { palette: b.palette ?? null, logoPath: b.logoPath ?? null, logoShape: b.logoShape ?? null } : null;
  const audit = await logAuditAction({
    action: "BRANDING_CHANGED", resourceType: "org_branding", resourceId: orgId, orgId,
    userId: actor.uid, userEmail: actor.email ?? undefined, userRole: "Admin",
    details: { before: pick(before), after: pick(payload) },
  });
  return { auditError: audit.ok ? null : (audit.error ?? "audit insert refused") };
}
