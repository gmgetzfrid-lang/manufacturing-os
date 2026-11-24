"use client";

// Admin → Branding. White-label the workspace: upload a logo and set the
// workspace's colors. Saved to org_configurations and applied to every
// member (light or dark stays personal). The slide template saves on its
// own. Admin only.

import React, { useEffect, useRef, useState } from "react";
import { useRole } from "@/components/providers/RoleContext";
import { useOrgBranding } from "@/components/providers/OrgBrandingProvider";
import { PALETTE_PRESETS, useTheme, sideOf, type Palette } from "@/components/providers/ThemeProvider";
import { extractLogoColors } from "@/lib/logoTheme";
import { logoTriplets } from "@/lib/brandColors";
import PalettePicker, { paletteFromTriplet } from "@/components/branding/PalettePicker";
import { uploadToPath, getSignedUrlForPath } from "@/lib/storage";
import { Upload, Loader2 } from "lucide-react";
import { appAlert } from "@/components/providers/DialogProvider";
import { useFileDrag } from "@/hooks/useFileDrag";
import FileThumb from "@/components/ui/FileThumb";
import { tryUpload } from "@/lib/uploadRetry";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card } from "@/components/ui/PageHero";
import { Button, useActionFeedback } from "@/components/ui/Button";
import { btnQuiet, btnLink } from "@/components/admin/kit";
import { bandSeg, bandSegItem } from "@/components/admin/band";
import { said } from "@/components/admin/said";
import { formatBytes } from "@/lib/formatBytes";
import SlideTemplateSetup from "@/components/branding/SlideTemplateSetup";


export default function AdminBrandingPage() {
  const { activeOrgId, activeRole } = useRole();
  const { branding, logoUrl, save } = useOrgBranding();
  const { applyOrgPalette, palette: showing } = useTheme();

  // Start from what the app shows now: the workspace's saved colors, or
  // your own if the workspace has none yet.
  const [palette, setPaletteState] = useState<Palette>(branding?.palette ?? showing ?? PALETTE_PRESETS[0]);
  const [touched, setTouched] = useState(false);
  const [logoNote, setLogoNote] = useState<string | null>(null);
  const [logoColors, setLogoColors] = useState<string[] | undefined>(undefined);
  // Read the saved logo's colors so you can pick from them.
  useEffect(() => {
    if (!logoUrl || logoColors) return;
    let alive = true;
    (async () => {
      try {
        const blob = await (await fetch(logoUrl)).blob();
        const colors = (await extractLogoColors(new File([blob], "logo", { type: blob.type }))).map((c) => c.hex);
        if (alive) setLogoColors(colors);
      } catch { /* the logo can't be read here; presets still work */ }
    })();
    return () => { alive = false; };
  }, [logoUrl, logoColors]);
  // The whole app shows the colors while you pick; leaving without saving
  // puts the saved ones back.
  const setPalette = (p: Palette) => { setPaletteState(p); setTouched(true); applyOrgPalette(p); };
  const savedPalette = useRef<Palette | null>(branding?.palette ?? null);
  useEffect(() => { savedPalette.current = branding?.palette ?? null; }, [branding]);
  useEffect(() => {
    if (!touched && branding?.palette) setPaletteState(branding.palette);
  }, [branding, touched]);
  useEffect(() => () => applyOrgPalette(savedPalette.current), [applyOrgPalette]);
  const [logoPath, setLogoPath] = useState<string | undefined>(branding?.logoPath);
  const [logoPreview, setLogoPreview] = useState<string | null>(logoUrl);
  const [logoShape, setLogoShape] = useState<"mark" | "full">(branding?.logoShape ?? "full");
  // The saved logo can arrive after the page opens: follow it until you
  // change the logo here, so Save never drops it.
  const [logoTouched, setLogoTouched] = useState(false);
  useEffect(() => {
    if (logoTouched) return;
    setLogoPath(branding?.logoPath);
    setLogoShape(branding?.logoShape ?? "full");
    setLogoPreview(logoUrl);
  }, [branding, logoUrl, logoTouched]);
  const [uploading, setUploading] = useState(false);
  const saving = useActionFeedback();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const drag = useFileDrag((files) => {
    const f = files.find((x) => x.type.startsWith("image/"));
    if (f) void handleLogo(f); else setLogoError("Pick an image file for the logo (PNG, SVG or JPG).");
  }, uploading);

  const isAdmin = activeRole === "Admin";

  if (!isAdmin) {
    return (
      <PageShell width="work">
        <PageHero kicker="Admin · Branding" title="Admins only." sub="Only an admin can change the workspace's logo and colors." />
      </PageShell>
    );
  }

  async function handleLogo(file: File) {
    if (!activeOrgId) return;
    setLogoTouched(true);
    setUploading(true);
    setPicked(file);
    setLogoError(null);
    try {
      // Local preview immediately.
      setLogoPreview(URL.createObjectURL(file));
      // Suggest all three colors from the logo: the best fit now, the
      // others under Try another in Colors.
      try {
        const colors = (await extractLogoColors(file)).map((c) => c.hex);
        setLogoColors(colors);
        const best = logoTriplets(colors)[0];
        if (best) { setPalette(paletteFromTriplet(best, sideOf(palette))); setLogoNote("Colors set from your logo. Try another under Colors."); }
        else setLogoNote("The logo has no strong color (only black, white or grey), so the colors stay as they are.");
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
      setLogoError(said(e, "The logo didn't upload."));
    } finally { setUploading(false); }
  }

  const handleSave = async () => {
    try {
      await saving.run(() => save({ ...(branding ?? {}), palette, logoPath, logoShape }));
      savedPalette.current = palette;
      setTouched(false);
      setLogoTouched(false);
      setSavedAt(Date.now());
    } catch (e) {
      await appAlert({ message: said(e, "Couldn't save the branding."), tone: "danger" });
    }
  };

  const dirty = touched || logoTouched;
  const justSaved = !!savedAt && !dirty;

  return (
    <PageShell width="work">
      <PageHero
        kicker="Admin · Branding"
        title={justSaved ? "Saved for everyone." : dirty ? "Not saved yet." : logoPreview ? "Your logo is set." : "No logo yet."}
        sub={justSaved ? "Everyone in the workspace sees it now." : dirty ? "Only you see these colors until you save." : "The logo and colors everyone in this workspace sees. Light or dark stays each person's choice."}
        primary={
          <Button {...saving.state} doneLabel="Saved" onClick={() => void handleSave()} disabled={uploading || (!dirty && !saving.done)}
            title={!dirty ? "Nothing changed yet" : undefined}>
            Save for everyone
          </Button>
        }
      />

      <PageBody>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,38fr)_minmax(0,62fr)] gap-x-6 gap-y-8 items-start">
        {/* LOGO */}
        <Card label="Logo">
          <div {...drag.bind} className={`rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-2)] h-28 flex items-center justify-center mb-3 overflow-hidden ${drag.ring}`}>
            {drag.over ? (
              <span className="text-body font-medium text-[var(--color-text)]">{drag.say}</span>
            ) : logoPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoPreview} alt="Logo preview" className="max-h-20 max-w-[80%] object-contain" />
            ) : (
              <span className="text-body text-[var(--color-text-muted)]">No logo yet. Drop one here.</span>
            )}
          </div>
          {picked && (
            <div className="mb-3 flex items-center gap-2.5">
              <FileThumb file={picked} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium text-[var(--color-text)] truncate">{picked.name}</span>
                <span className="block text-body text-[var(--color-text-muted)]">
                  {formatBytes(picked.size)}{uploading && <span className="inline-flex items-center gap-1 ml-2"><Loader2 aria-hidden className="w-3 h-3 animate-spin" /> Uploading</span>}
                </span>
              </span>
              {!uploading && logoError && (
                <Button size="sm" variant="secondary" onClick={() => void handleLogo(picked)}>Try again</Button>
              )}
            </div>
          )}
          {logoError && <p role="alert" className="mb-3 text-body font-medium text-[var(--state-overdue-text)]">{logoError}</p>}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleLogo(f); e.target.value = ""; }} />
            <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} className={btnQuiet}>
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} {logoPreview ? "Replace logo" : "Upload logo"}
            </button>
            {logoPreview && (
              // Takes the logo off the page; nothing changes for anyone until Save.
              <button type="button" onClick={() => { setLogoTouched(true); setLogoPath(undefined); setLogoPreview(null); setPicked(null); setLogoError(null); setLogoColors([]); setLogoNote(null); }}
                className={`${btnLink} !text-[var(--color-text-muted)] hover:!text-[var(--state-overdue-text)]`}>
                Remove
              </button>
            )}
          </div>
          <div className="mt-5">
            <div className="text-body font-medium text-[var(--color-text)] mb-1.5">Logo shape</div>
            <div role="radiogroup" aria-label="Logo shape" className={bandSeg}>
              {(["full", "mark"] as const).map((s) => (
                <button key={s} type="button" role="radio" aria-checked={logoShape === s} onClick={() => { setLogoTouched(true); setLogoShape(s); }}
                  className={bandSegItem(logoShape === s)}>
                  {s === "full" ? "Wide wordmark" : "Square mark"}
                </button>
              ))}
            </div>
          </div>
          <p className="text-body text-[var(--color-text-muted)] mt-3">{logoNote ?? "Uploading a logo also sets the colors from it."}</p>
        </Card>

        {/* COLORS */}
        <Card label="Colors">
          <PalettePicker value={palette} onChange={setPalette} logoButton={false} logoColors={logoColors} />
        </Card>

        {/* SLIDES: the company's PowerPoint template; saves on its own */}
        <div id="slides" className="scroll-mt-20 lg:col-span-2"><SlideTemplateSetup /></div>
      </div>
      </PageBody>
    </PageShell>
  );
}
