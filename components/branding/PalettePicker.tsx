"use client";

// Pick the workspace's colors the way the color video lays it out: a pair
// that covers the big areas (side menu and page band) and one action color
// kept small (buttons and links) so it stands out. A live preview shows
// each color where it will go. A logo can suggest all three.

import React from "react";
import { Check, Upload, Loader2 } from "lucide-react";
import { PALETTE_PRESETS, type Palette } from "@/components/providers/ThemeProvider";
import { rolesOf, rolesFromLogo, onColor, type ThemeRoles } from "@/lib/themeRoles";
import { extractLogoColors } from "@/lib/logoTheme";

const toPalette = (r: ThemeRoles, id: string, name: string): Palette =>
  ({ id, name, base: r.base, primary: r.main, accent: r.action, secondary: r.action });

const same = (a: ThemeRoles, b: ThemeRoles) =>
  a.base.toLowerCase() === b.base.toLowerCase() && a.main.toLowerCase() === b.main.toLowerCase() && a.action.toLowerCase() === b.action.toLowerCase();

/** A small picture of the app in these colors: menu, band, the one button. */
export function PalettePreview({ roles, className = "" }: { roles: ThemeRoles; className?: string }) {
  const sideText = onColor(roles.base);
  return (
    <div aria-hidden className={`flex h-24 rounded-xl overflow-hidden border border-[var(--color-border)] bg-[#f4f3f0] ${className}`}>
      <div className="w-[26%] p-2 flex flex-col gap-1.5" style={{ background: roles.base }}>
        <span className="h-1.5 w-8 rounded-full opacity-60" style={{ background: sideText }} />
        <span className="h-3 rounded" style={{ background: roles.main }} />
        <span className="h-1.5 w-10 rounded-full opacity-40" style={{ background: sideText }} />
        <span className="h-1.5 w-7 rounded-full opacity-40" style={{ background: sideText }} />
      </div>
      <div className="flex-1 p-2 flex flex-col gap-1.5">
        <div className="rounded-lg p-2 pb-4 flex items-end justify-between gap-2" style={{ background: roles.main }}>
          <span className="h-2.5 w-16 rounded-full bg-white" />
          <span className="h-3.5 w-9 rounded-md" style={{ background: roles.action }} />
        </div>
        <div className="-mt-3 mx-1.5 rounded-md bg-white h-8 shadow-sm flex items-center px-2 gap-1.5">
          <span className="h-1.5 w-14 rounded-full bg-slate-300" />
          <span className="h-1.5 w-6 rounded-full" style={{ background: roles.action }} />
        </div>
      </div>
    </div>
  );
}

export default function PalettePicker({ value, onChange, disabled = false, logoButton = true, lockedNote }: {
  value: Palette;
  onChange: (p: Palette) => void;
  disabled?: boolean;
  /** Offer "Suggest all three from a logo" (off where the page has its own logo upload). */
  logoButton?: boolean;
  /** Shown instead of the controls when the workspace sets the colors. */
  lockedNote?: React.ReactNode;
}) {
  const roles = rolesOf(value);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [reading, setReading] = React.useState(false);
  const [logoNote, setLogoNote] = React.useState<string | null>(null);

  const setRole = (k: keyof ThemeRoles, hex: string) =>
    onChange(toPalette({ ...roles, [k]: hex }, "custom", "Custom"));

  const fromLogo = async (file: File) => {
    setReading(true); setLogoNote(null);
    try {
      const colors = await extractLogoColors(file);
      const r = rolesFromLogo(colors.map((c) => c.hex));
      if (r) { onChange(toPalette(r, "logo", "From your logo")); setLogoNote(`Read ${colors.length} color${colors.length === 1 ? "" : "s"} from the logo.`); }
      else setLogoNote("No clear brand color in that logo. Pick the colors below.");
    } catch { setLogoNote("Couldn't read that image. Try a PNG or SVG."); }
    finally { setReading(false); }
  };

  return (
    <div className="space-y-4 @container">
      <PalettePreview roles={roles} />
      {lockedNote ? <p className="text-[12.5px] text-[var(--color-text-muted)]">{lockedNote}</p> : (
        <>
          <div>
            <div className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)] mb-2">Ready-made</div>
            <div className="grid grid-cols-1 @md:grid-cols-2 gap-1.5">
              {PALETTE_PRESETS.map((p) => {
                const r = rolesOf(p);
                const on = same(r, roles);
                return (
                  <button key={p.id} type="button" disabled={disabled} onClick={() => onChange(p)} aria-pressed={on}
                    className={`flex items-center gap-2.5 px-2.5 min-h-11 rounded-xl border text-left transition-colors disabled:opacity-50 ${on ? "border-[var(--color-text)] bg-[var(--color-surface-2)]" : "border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"}`}>
                    <span className="flex h-6 w-14 rounded-md overflow-hidden ring-1 ring-black/10 shrink-0">
                      <span className="w-[45%]" style={{ background: r.base }} />
                      <span className="flex-1" style={{ background: r.main }} />
                      <span className="w-[18%]" style={{ background: r.action }} />
                    </span>
                    <span className="flex-1 min-w-0 text-[12.5px] font-semibold text-[var(--color-text)] truncate">{p.name}</span>
                    {on && <Check className="w-4 h-4 text-[var(--color-text)] shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <div className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)] mb-2">Your own</div>
            <div className="grid grid-cols-1 @xs:grid-cols-3 gap-2">
              {([["base", "Side menu"], ["main", "Page band"], ["action", "Buttons, links"]] as const).map(([k, label]) => (
                <label key={k} className="flex flex-col gap-1 text-[12px] text-[var(--color-text-muted)]">
                  {label}
                  <span className="flex items-center gap-2 h-10 px-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
                    <input type="color" disabled={disabled} value={roles[k]} onChange={(e) => setRole(k, e.target.value)}
                      className="w-7 h-7 rounded border-0 bg-transparent p-0 cursor-pointer disabled:cursor-not-allowed" aria-label={label} />
                    <span className="font-mono text-[11.5px] text-[var(--color-text)]">{roles[k]}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-[12px] text-[var(--color-text-muted)]">The menu and band set the mood. The button color is the one that stands out, so it&apos;s only used on what you tap.</p>
          </div>
          {logoButton && <div>
            <button type="button" disabled={disabled || reading} onClick={() => fileRef.current?.click()}
              className="w-full inline-flex items-center justify-center gap-2 min-h-11 rounded-xl border border-dashed border-[var(--color-border-strong)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
              {reading ? <><Loader2 className="w-4 h-4 animate-spin" /> Reading the logo&apos;s colors…</> : <><Upload className="w-4 h-4" /> Suggest all three from a logo</>}
            </button>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void fromLogo(f); e.currentTarget.value = ""; }} />
            {logoNote && <p className="mt-1.5 text-[12px] text-[var(--color-text-muted)]">{logoNote}</p>}
          </div>}
        </>
      )}
    </div>
  );
}
