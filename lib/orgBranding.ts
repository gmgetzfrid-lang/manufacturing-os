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

/** The stored branding, read CHECKED: "no row" (`branding: null`) is told
 *  apart from "the read failed" (`ok: false`) — the save below decides and
 *  audits from it, so a failure must never pass for "nothing stored". */
export async function readOrgBrandingChecked(orgId: string): Promise<{ ok: true; branding: OrgBranding | null } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from("org_configurations")
    .select("data")
    .eq("org_id", orgId)
    .eq("key", KEY)
    .maybeSingle();
  if (error) return { ok: false, error: error.message ?? "read failed" };
  return { ok: true, branding: ((data?.data as OrgBranding | undefined) ?? null) };
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
 *  colours is refused before anything is written — but only a palette the
 *  caller is changing. A save that carries the stored palette along
 *  unchanged (the logo modal's logo-only save) is never refused for a
 *  palette written before ORG-11 or brought in by a restore; the theme
 *  sanitizes that one on the way in (sanitizeOrgPalette). The write reads back the
 *  row it stored (a write RLS refused is an error, never a silent success),
 *  and ALOG-4 dw2: the change is audited (BRANDING_CHANGED, before and
 *  after) — a refused audit row is returned for the caller to say. */
export async function saveOrgBranding(
  orgId: string,
  branding: OrgBranding,
  actor?: { uid: string | null; email?: string | null },
): Promise<{ auditError: string | null }> {
  // Review fix: a failed read of the stored branding is not "nothing
  // stored". The palette check then cannot tell a changed palette from one
  // carried along: a valid palette saves as before, an invalid one is
  // refused naming the read failure (it may be a stored pre-ORG-11 palette —
  // try again once the read works). The audit row says the "before" is
  // unknown (beforeReadError), never that there was no branding.
  const stored = await readOrgBrandingChecked(orgId);
  const before = stored.ok ? stored.branding : null;
  const beforeReadError = stored.ok ? null : stored.error;
  const paletteChanged = !stored.ok || JSON.stringify(branding.palette ?? null) !== JSON.stringify(before?.palette ?? null);
  const problem = paletteChanged ? brandingPaletteProblem(branding.palette) : null;
  if (problem) {
    throw new Error(beforeReadError
      ? `Couldn't read the stored branding (${beforeReadError}), so this palette can't be checked against it: ${problem} Nothing was saved — try again.`
      : problem);
  }
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
    details: beforeReadError
      ? { before: null, beforeUnknown: true, beforeReadError, after: pick(payload) }
      : { before: pick(before), after: pick(payload) },
  });
  return { auditError: audit.ok ? null : (audit.error ?? "audit insert refused") };
}
