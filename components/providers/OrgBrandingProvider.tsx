"use client";

// OrgBrandingProvider — loads the active org's white-label branding (logo
// + enforced palette) and applies it. Mounted inside RoleProvider (needs
// activeOrgId) and under ThemeProvider (calls applyOrgPalette). The org
// palette overrides each member's personal palette ("org-locked"); light/
// dark mode stays a personal choice.

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRole } from "@/components/providers/RoleContext";
import { useTheme } from "@/components/providers/ThemeProvider";
import { getOrgBranding, saveOrgBranding, type OrgBranding } from "@/lib/orgBranding";
import { getSignedUrlForPath } from "@/lib/storage";

interface OrgBrandingCtx {
  branding: OrgBranding | null;
  logoUrl: string | null;       // resolved (signed) URL for the logo
  loading: boolean;
  canEdit: boolean;             // Admin only
  save: (b: OrgBranding) => Promise<void>;
  reload: () => Promise<void>;
}

const Ctx = createContext<OrgBrandingCtx | null>(null);

export function OrgBrandingProvider({ children }: { children: React.ReactNode }) {
  const { activeOrgId, activeRole } = useRole();
  const { applyOrgPalette } = useTheme();
  const [branding, setBranding] = useState<OrgBranding | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const canEdit = activeRole === "Admin";

  const applyBranding = useCallback(async (b: OrgBranding | null) => {
    setBranding(b);
    applyOrgPalette(b?.palette ?? null);
    if (b?.logoPath) {
      try { setLogoUrl(await getSignedUrlForPath(b.logoPath, 604800)); }
      catch { setLogoUrl(null); }
    } else {
      setLogoUrl(null);
    }
  }, [applyOrgPalette]);

  const load = useCallback(async () => {
    if (!activeOrgId) { void applyBranding(null); return; }
    setLoading(true);
    try { await applyBranding(await getOrgBranding(activeOrgId)); }
    finally { setLoading(false); }
  }, [activeOrgId, applyBranding]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (b: OrgBranding) => {
    if (!activeOrgId) return;
    await saveOrgBranding(activeOrgId, b);
    await applyBranding(b);
  }, [activeOrgId, applyBranding]);

  return (
    <Ctx.Provider value={{ branding, logoUrl, loading, canEdit, save, reload: load }}>
      {children}
    </Ctx.Provider>
  );
}

export function useOrgBranding(): OrgBrandingCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useOrgBranding must be used within OrgBrandingProvider");
  return c;
}
