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
import { useFileDrag } from "@/hooks/useFileDrag";
import FileThumb from "@/components/ui/FileThumb";
import { tryUpload } from "@/lib/uploadRetry";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary } from "@/components/ui/PageHero";

const formatBytes = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

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
  const [picked, setPicked] = useState<File | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const drag = useFileDrag((files) => {
    const f = files.find((x) => x.type.startsWith("image/"));
    if (f) void handleLogo(f); else setLogoError("Pick an image file for the logo.");
  }, uploading);

  const isAdmin = activeRole === "Admin";

  if (!isAdmin) {
    return (
      <PageShell width="work">
        <PageHero kicker="Admin · Branding" title="Admins only." overlap={false}
          sub={<span className="inline-flex items-center gap-2"><ShieldAlert className="w-4 h-4" /> Only Admins can manage workspace branding.</span>} />
      </PageShell>
    );
  }

  async function handleLogo(file: File) {
    if (!activeOrgId) return;
    setUploading(true);
    setPicked(file);
    setLogoError(null);
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
      // Same file, same place: safe to try again. Nothing is saved until Save.
      await tryUpload(file.name, () => uploadToPath(file, path, { contentType: file.type }), {
        onRetried: () => { setLogoPath(path); setPicked(null); setLogoError(null); },
      });
      setLogoPath(path);
      setPicked(null);
      try { setLogoPreview(await getSignedUrlForPath(path, 604800)); } catch { /* keep object url */ }
    } catch (e) {
      setLogoError(`The logo didn't upload: ${e instanceof Error ? e.message : "unknown"}`);
    } finally { setUploading(false); }
  }

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
    <PageShell width="work">
      <PageHero
        kicker="Admin · Branding"
        title={savedAt ? "Saved for everyone." : logoPreview ? "Your logo is set." : "No logo yet."}
        sub={savedAt ? "Everyone in the workspace sees it now." : `${palette.name} colors. Your logo and colors apply to everyone in this workspace; members keep their own light or dark preference.`}
        primary={
          <button type="button" onClick={handleSave} disabled={saving || uploading} className={heroPrimary}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save branding
          </button>
        }
      />

      <PageBody>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* LOGO */}
        <Card label="Logo">
          <div {...drag.bind} className={`rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-2)] h-28 flex items-center justify-center mb-3 overflow-hidden ${drag.ring}`}>
            {drag.over ? (
              <span className="text-sm font-bold text-[var(--color-text)]">{drag.say}</span>
            ) : logoPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoPreview} alt="Logo preview" className="max-h-20 max-w-[80%] object-contain" />
            ) : (
              <span className="text-sm text-[var(--color-text-muted)]">No logo yet. Drop one here.</span>
            )}
          </div>
          {picked && (
            <div className="mb-3 flex items-center gap-2.5">
              <FileThumb file={picked} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-bold text-[var(--color-text)] truncate">{picked.name}</span>
                <span className="block text-[11px] text-[var(--color-text-muted)]">
                  {formatBytes(picked.size)}{uploading && <span className="inline-flex items-center gap-1 ml-2"><Loader2 className="w-3 h-3 animate-spin" /> Uploading…</span>}
                </span>
              </span>
              {!uploading && logoError && (
                <button type="button" onClick={() => void handleLogo(picked)} className="shrink-0 px-2 py-1 rounded-md border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">Try again</button>
              )}
            </div>
          )}
          {logoError && <p role="alert" className="mb-3 text-[11px] text-red-700 dark:text-red-400">{logoError}</p>}
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleLogo(f); e.target.value = ""; }} />
            <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
              className="inline-flex items-center gap-2 h-9 px-3 rounded-lg text-[13px] font-semibold border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Upload logo
            </button>
            {logoPreview && (
              <button onClick={() => { setLogoPath(undefined); setLogoPreview(null); setPicked(null); setLogoError(null); }}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">
                <Trash2 className="w-4 h-4" /> Remove
              </button>
            )}
          </div>
          <div className="mt-4">
            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)] mb-1.5">Logo shape</div>
            <div className="flex gap-1.5">
              {(["full", "mark"] as const).map((s) => (
                <button key={s} onClick={() => setLogoShape(s)}
                  aria-pressed={logoShape === s}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold border capitalize ${logoShape === s ? "border-transparent bg-[var(--color-text)] text-[var(--color-surface)]" : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
                  {s === "full" ? "Wide wordmark" : "Square mark"}
                </button>
              ))}
            </div>
          </div>
          <p className="text-[12px] text-[var(--color-text-muted)] mt-3">Uploading a logo also suggests a palette from its colors.</p>
        </Card>

        {/* PALETTE */}
        <Card label={<span className="inline-flex items-center gap-1.5"><PaletteIcon className="w-3.5 h-3.5" /> Color palette</span>}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
            {PALETTE_PRESETS.map((p) => {
              const on = p.primary.toLowerCase() === palette.primary.toLowerCase() && p.secondary.toLowerCase() === palette.secondary.toLowerCase();
              return (
                <button key={p.id} type="button" onClick={() => setPalette(p)} title={p.name} aria-label={p.name} aria-pressed={on}
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
          <p className="text-[12px] text-[var(--color-text-muted)] mt-3 flex items-center gap-1.5"><Zap className="w-3 h-3" /> Saving applies these colors across the app for everyone.</p>
        </Card>
      </div>
      {savedAt && <p role="status" className="px-1 text-[14px] text-emerald-700 dark:text-emerald-400 font-semibold">Saved. Everyone in the workspace sees it now.</p>}
      </PageBody>
    </PageShell>
  );
}
