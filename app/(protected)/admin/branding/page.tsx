"use client";

// Admin → Branding. White-label the workspace: upload a logo and set an
// org-enforced color palette. Saved to org_configurations and applied to
// every member (light/dark mode stays personal). Admin only.

import React, { useRef, useState } from "react";
import { useRole } from "@/components/providers/RoleContext";
import { useOrgBranding } from "@/components/providers/OrgBrandingProvider";
import { PALETTE_PRESETS, type Palette } from "@/components/providers/ThemeProvider";
import { extractLogoColors } from "@/lib/logoTheme";
import { uploadToPath, getSignedUrlForPath } from "@/lib/storage";
import { Palette as PaletteIcon, Upload, Check, Loader2, ShieldAlert, Zap, Trash2 } from "lucide-react";
import { appAlert } from "@/components/providers/DialogProvider";

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", ""); const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const i = parseInt(n, 16); return [(i >> 16) & 255, (i >> 8) & 255, i & 255];
}
const dist = (a: string, b: string) => { const [r1, g1, b1] = hexToRgb(a); const [r2, g2, b2] = hexToRgb(b); return Math.hypot(r1 - r2, g1 - g2, b1 - b2); };
const isHex = (s: string) => /^#[0-9a-fA-F]{6}$/.test(s);

export default function AdminBrandingPage() {
  const { activeOrgId, activeRole } = useRole();
  const { branding, logoUrl, save } = useOrgBranding();

  const [palette, setPalette] = useState<Palette>(branding?.palette ?? PALETTE_PRESETS[0]);
  const [logoPath, setLogoPath] = useState<string | undefined>(branding?.logoPath);
  const [logoPreview, setLogoPreview] = useState<string | null>(logoUrl);
  const [logoShape, setLogoShape] = useState<"mark" | "full">(branding?.logoShape ?? "full");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const isAdmin = activeRole === "Admin";

  if (!isAdmin) {
    return (
      <div className="p-8 max-w-2xl">
        <div className="flex items-center gap-3 p-4 rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-text)]">
          <ShieldAlert className="w-5 h-5" /> <span>Only Admins can manage workspace branding.</span>
        </div>
      </div>
    );
  }

  const handleLogo = async (file: File) => {
    if (!activeOrgId) return;
    setUploading(true);
    try {
      // Local preview immediately.
      setLogoPreview(URL.createObjectURL(file));
      // Derive a palette suggestion from the logo.
      try {
        const colors = await extractLogoColors(file);
        if (colors[0]) {
          const primary = colors[0].hex;
          const secondary = colors.slice(1).sort((a, b) => dist(primary, b.hex) - dist(primary, a.hex))[0]?.hex ?? primary;
          setPalette({ id: "logo", name: "From logo", primary, secondary });
        }
      } catch { /* keep current palette */ }
      // Upload to durable storage.
      const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
      const rand = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}`;
      const path = `orgs/${activeOrgId}/branding/logo-${rand}.${ext}`;
      await uploadToPath(file, path, { contentType: file.type });
      setLogoPath(path);
      try { setLogoPreview(await getSignedUrlForPath(path, 604800)); } catch { /* keep object url */ }
    } catch (e) {
      await appAlert({ message: `Logo upload failed: ${e instanceof Error ? e.message : "unknown"}`, tone: "danger" });
    } finally { setUploading(false); }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await save({ palette, logoPath, logoShape });
      setSavedAt(Date.now());
    } catch (e) {
      await appAlert({ message: `Save failed: ${e instanceof Error ? e.message : "unknown"}`, tone: "danger" });
    } finally { setSaving(false); }
  };

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-11 h-11 rounded-2xl grid place-items-center text-white" style={{ background: "var(--brand-gradient)" }}>
          <PaletteIcon className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-xl font-black text-[var(--color-text)]">Workspace branding</h1>
          <p className="text-sm text-[var(--color-text-muted)]">Your logo and colors, applied for everyone in this workspace. Members keep their own light/dark preference.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* LOGO */}
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <h2 className="text-sm font-black text-[var(--color-text)] mb-3">Logo</h2>
          <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-2)] h-28 flex items-center justify-center mb-3 overflow-hidden">
            {logoPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoPreview} alt="Logo preview" className="max-h-20 max-w-[80%] object-contain" />
            ) : (
              <span className="text-sm text-[var(--color-text-muted)]">No logo yet</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleLogo(f); e.target.value = ""; }} />
            <button onClick={() => fileRef.current?.click()} disabled={uploading}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-bold border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Upload logo
            </button>
            {logoPreview && (
              <button onClick={() => { setLogoPath(undefined); setLogoPreview(null); }}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">
                <Trash2 className="w-4 h-4" /> Remove
              </button>
            )}
          </div>
          <div className="mt-4">
            <div className="text-[11px] font-black uppercase tracking-widest text-[var(--color-text-faint)] mb-1.5">Logo shape</div>
            <div className="flex gap-1.5">
              {(["full", "mark"] as const).map((s) => (
                <button key={s} onClick={() => setLogoShape(s)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold border capitalize ${logoShape === s ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-text)]" : "border-[var(--color-border)] text-[var(--color-text-muted)]"}`}>
                  {s === "full" ? "Wide wordmark" : "Square mark"}
                </button>
              ))}
            </div>
          </div>
          <p className="text-[11px] text-[var(--color-text-muted)] mt-3">Uploading a logo also suggests a palette from its colors.</p>
        </section>

        {/* PALETTE */}
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <h2 className="text-sm font-black text-[var(--color-text)] mb-3">Color palette</h2>
          <div className="grid grid-cols-4 gap-2 mb-4">
            {PALETTE_PRESETS.map((p) => {
              const on = p.primary.toLowerCase() === palette.primary.toLowerCase() && p.secondary.toLowerCase() === palette.secondary.toLowerCase();
              return (
                <button key={p.id} onClick={() => setPalette(p)} title={p.name}
                  className={`h-10 rounded-lg border-2 overflow-hidden ${on ? "border-[var(--color-text)]" : "border-transparent"}`}
                  style={{ background: `linear-gradient(135deg, ${p.primary}, ${p.secondary})` }}>
                  {on && <Check className="w-4 h-4 text-white mx-auto drop-shadow" />}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs font-bold text-[var(--color-text-muted)]">
              Primary
              <input type="color" value={isHex(palette.primary) ? palette.primary : "#4f46e5"}
                onChange={(e) => setPalette((p) => ({ ...p, id: "custom", name: "Custom", primary: e.target.value }))}
                className="w-8 h-8 rounded border border-[var(--color-border)] bg-transparent" />
            </label>
            <label className="flex items-center gap-2 text-xs font-bold text-[var(--color-text-muted)]">
              Secondary
              <input type="color" value={isHex(palette.secondary) ? palette.secondary : "#a855f7"}
                onChange={(e) => setPalette((p) => ({ ...p, id: "custom", name: "Custom", secondary: e.target.value }))}
                className="w-8 h-8 rounded border border-[var(--color-border)] bg-transparent" />
            </label>
          </div>
          <div className="mt-4 rounded-lg h-12" style={{ background: `linear-gradient(135deg, ${palette.primary}, ${palette.secondary})` }} />
          <p className="text-[11px] text-[var(--color-text-muted)] mt-3 flex items-center gap-1.5"><Zap className="w-3 h-3" /> Saving applies these colors across the app for everyone.</p>
        </section>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button onClick={handleSave} disabled={saving}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-[var(--color-accent-fg)] disabled:opacity-50" style={{ background: "var(--color-accent)" }}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save branding
        </button>
        {savedAt && <span className="text-sm text-emerald-600 font-semibold">Saved — applied for everyone.</span>}
      </div>
    </div>
  );
}
