"use client";

// Pick the workspace's brand color. The app decides where it goes: pages
// stay grey and white, and the brand color marks only what you can do
// (buttons, links, the current tab and menu item). Whatever color comes in,
// from a logo or picked, the app tunes its lightness so buttons and links
// always read. The preview shows exactly where it lands.

import React from "react";
import { Check, Upload, Loader2 } from "lucide-react";
import { PALETTE_PRESETS, type Palette } from "@/components/providers/ThemeProvider";
import { signalScale, signalFromLogo, chartColor, isColorful } from "@/lib/brandColors";
import { extractLogoColors } from "@/lib/logoTheme";

/** A small picture of a screen in these colors. */
export function PalettePreview({ palette, className = "" }: { palette: Palette; className?: string }) {
  const sc = signalScale(palette.primary);
  const dark = palette.side === "dark";
  const menuBg = dark ? "#29303b" : "#f7f8fa";
  const menuLine = dark ? "rgba(255,255,255,.28)" : "#c7ced7";
  const second = isColorful(palette.secondary) && palette.secondary.toLowerCase() !== palette.primary.toLowerCase() ? chartColor(palette.secondary) : "#c7ced7";
  return (
    <div aria-hidden className={`flex h-32 rounded-lg overflow-hidden border border-[var(--color-border-strong)] bg-[#eef0f3] ${className}`}>
      <div className="w-[24%] p-2.5 flex flex-col gap-2 border-r border-[#e0e4e9]" style={{ background: menuBg }}>
        <span className="h-1.5 w-9 rounded-full" style={{ background: menuLine }} />
        <span className="h-4 rounded flex items-center px-1.5" style={{ background: dark ? "rgba(255,255,255,.12)" : sc[100] }}>
          <span className="h-1.5 w-8 rounded-full" style={{ background: dark ? sc[200] : sc[700] }} />
        </span>
        <span className="h-1.5 w-10 rounded-full" style={{ background: menuLine }} />
        <span className="h-1.5 w-7 rounded-full" style={{ background: menuLine }} />
      </div>
      <div className="flex-1 p-3 flex flex-col gap-2 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="h-3 w-24 rounded-sm bg-[#1f2733]" />
          <span className="h-5 w-14 rounded" style={{ background: sc[600] }} />
        </div>
        <div className="relative flex gap-3 border-b border-[#c7ced7]">
          <span className="h-1.5 w-8 rounded-full mb-1.5 bg-[#1f2733]" />
          <span className="h-1.5 w-8 rounded-full mb-1.5 bg-[#c7ced7]" />
          <span className="absolute left-0 -bottom-px h-0.5 w-8" style={{ background: sc[600] }} />
        </div>
        <div className="flex-1 rounded bg-white border border-[#e0e4e9] flex items-end gap-1.5 px-2 pb-2 pt-3">
          <span className="w-3 h-[60%] rounded-sm" style={{ background: sc[600] }} />
          <span className="w-3 h-[35%] rounded-sm" style={{ background: second }} />
          <span className="w-3 h-[80%] rounded-sm" style={{ background: sc[600] }} />
          <span className="w-3 h-[45%] rounded-sm" style={{ background: second }} />
          <span className="flex-1" />
          <span className="h-1.5 w-10 rounded-full self-center" style={{ background: sc[700] }} />
        </div>
      </div>
    </div>
  );
}

export default function PalettePicker({ value, onChange, disabled = false, logoButton = true, logoColors, lockedNote }: {
  value: Palette;
  onChange: (p: Palette) => void;
  disabled?: boolean;
  /** Offer "Use colors from a logo" (off where the page has its own logo upload). */
  logoButton?: boolean;
  /** Colors already read from the workspace logo, to pick from. */
  logoColors?: string[];
  /** Shown instead of the controls when the workspace sets the colors. */
  lockedNote?: React.ReactNode;
}) {
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [reading, setReading] = React.useState(false);
  const [found, setFound] = React.useState<string[] | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const fromLogo = found ?? logoColors ?? null;
  const usable = fromLogo ? fromLogo.filter(isColorful) : [];
  const suggested = fromLogo ? signalFromLogo(fromLogo) : null;
  const side = value.side ?? "light";

  const pick = (primary: string, name: string, id: string, secondary?: string) =>
    onChange({ id, name, primary, secondary: secondary ?? primary, side });

  const readLogo = async (file: File) => {
    setReading(true); setNote(null);
    try {
      const colors = (await extractLogoColors(file)).map((c) => c.hex);
      setFound(colors);
      const r = signalFromLogo(colors);
      if (r) onChange({ id: "logo", name: "From your logo", primary: r.signal, secondary: r.second ?? r.signal, side });
      else setNote("That logo has no strong color (only black, white or grey), so the colors stay as they are.");
    } catch { setNote("Couldn't read that image. Try a PNG or SVG."); }
    finally { setReading(false); }
  };

  const same = (a: string) => a.toLowerCase() === value.primary.toLowerCase();
  const swatch = (hex: string, label: string, on: boolean, onClick: () => void, tag?: string) => (
    <button key={label + hex} type="button" disabled={disabled} onClick={onClick} aria-pressed={on} title={label}
      className="group flex flex-col items-center gap-1 w-[64px] disabled:opacity-50">
      <span className={`w-11 h-11 rounded-md grid place-items-center ring-offset-2 ring-offset-[var(--color-surface)] ${on ? "ring-2 ring-[var(--color-text)]" : "ring-1 ring-black/10 group-hover:ring-[var(--color-border-strong)]"}`}
        style={{ background: signalScale(hex)[600] }}>
        {on && <Check className="w-4 h-4 text-white" />}
      </span>
      <span className="text-[12px] text-[var(--color-text-muted)] leading-tight text-center">{label}</span>
      {tag && <span className="text-[11px] font-semibold text-[var(--color-accent-text)] leading-none">{tag}</span>}
    </button>
  );

  return (
    <div className="space-y-5">
      <PalettePreview palette={value} />
      <p className="text-[13px] text-[var(--color-text-muted)]">
        Pages stay grey and white so the work reads. Your color goes only on buttons, links, the current tab and the current menu item.
      </p>
      {lockedNote ? <p className="text-[13px] text-[var(--color-text-muted)]">{lockedNote}</p> : (
        <>
          {usable.length > 0 && (
            <div>
              <h3 className="font-display text-[15px] font-semibold text-[var(--color-text)] mb-2">From your logo</h3>
              <div className="flex flex-wrap gap-2">
                {usable.slice(0, 6).map((hex, i) => swatch(hex, `Color ${i + 1}`, same(hex), () => pick(hex, "From your logo", "logo", suggested?.second ?? undefined), suggested?.signal === hex ? "Best fit" : undefined))}
              </div>
            </div>
          )}
          <div>
            <h3 className="font-display text-[15px] font-semibold text-[var(--color-text)] mb-2">Ready-made</h3>
            <div className="flex flex-wrap gap-2">
              {PALETTE_PRESETS.map((p) => swatch(p.primary, p.name, same(p.primary), () => pick(p.primary, p.name, p.id)))}
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
            <label className="flex flex-col gap-1.5 text-[13px] font-medium text-[var(--color-text-muted)]">
              Any color
              <span className="flex items-center gap-2 h-10 pl-1.5 pr-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)]">
                <input type="color" disabled={disabled} value={value.primary} onChange={(e) => pick(e.target.value, "Custom", "custom")}
                  className="w-7 h-7 rounded border-0 bg-transparent p-0 cursor-pointer disabled:cursor-not-allowed" aria-label="Pick any color" />
                <span className="text-[13px] tabular-nums text-[var(--color-text)]">{value.primary}</span>
              </span>
            </label>
            <div className="flex flex-col gap-1.5 text-[13px] font-medium text-[var(--color-text-muted)]">
              Side menu
              <div role="radiogroup" aria-label="Side menu" className="inline-flex h-10 rounded-md border border-[var(--color-border-strong)] overflow-hidden">
                {(["light", "dark"] as const).map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={side === k} disabled={disabled}
                    onClick={() => onChange({ ...value, side: k })}
                    className={`px-4 text-[14px] font-semibold ${side === k ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
                    {k === "light" ? "Light" : "Graphite"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {logoButton && (
            <div>
              <button type="button" disabled={disabled || reading} onClick={() => fileRef.current?.click()}
                className="inline-flex items-center justify-center gap-2 h-10 px-4 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
                {reading ? <><Loader2 className="w-4 h-4 animate-spin" /> Reading the logo…</> : <><Upload className="w-4 h-4" /> Use colors from a logo</>}
              </button>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void readLogo(f); e.currentTarget.value = ""; }} />
            </div>
          )}
          {note && <p role="status" className="text-[13px] text-[var(--color-text-muted)]">{note}</p>}
        </>
      )}
    </div>
  );
}
