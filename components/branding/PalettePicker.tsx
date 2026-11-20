"use client";

// Pick the workspace's colors: a brand color and an accent. The app decides
// where they go: the brand's deep shade on the side menu, the brand on the
// header band, links and tabs, and the accent only on the one main button
// per screen, so it pops. Whatever comes in, from a logo or picked, the app
// tunes its lightness so every text reads. The preview shows where it lands.

import React from "react";
import { Check, Upload, Loader2 } from "lucide-react";
import { PALETTE_PRESETS, sideOf, type Palette } from "@/components/providers/ThemeProvider";
import { signalScale, signalFromLogo, isColorful, deepFor, accentFor } from "@/lib/brandColors";
import { extractLogoColors } from "@/lib/logoTheme";

/** A small picture of a screen in these colors. */
export function PalettePreview({ palette, className = "" }: { palette: Palette; className?: string }) {
  const sc = signalScale(palette.primary);
  const acc = accentFor(palette.primary, palette.secondary);
  const deep = sideOf(palette) === "deep";
  const menuBg = deep ? deepFor(palette.primary) : "#ffffff";
  const menuLine = deep ? "rgba(255,255,255,.35)" : "#c7ced7";
  return (
    <div aria-hidden className={`flex h-36 rounded-lg overflow-hidden border border-[var(--color-border-strong)] bg-[#eef1f7] ${className}`}>
      <div className="w-[24%] p-2.5 flex flex-col gap-2" style={{ background: menuBg, borderRight: deep ? "none" : "1px solid #e0e4e9" }}>
        <span className="h-3 w-12 rounded-sm bg-white/90" style={{ background: deep ? "#ffffff" : "#1f2733" }} />
        <span className="h-4 rounded" style={{ background: sc[600] }} />
        <span className="h-1.5 w-10 rounded-full" style={{ background: menuLine }} />
        <span className="h-1.5 w-7 rounded-full" style={{ background: menuLine }} />
      </div>
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-3 py-2.5 flex items-center justify-between gap-2" style={{ background: sc[600] }}>
          <span className="h-3 w-20 rounded-sm bg-white" />
          <span className="h-5 w-12 rounded" style={{ background: acc.fill }} />
        </div>
        <div className="flex-1 p-2.5 flex flex-col gap-1.5">
          <span className="h-2 w-14 rounded-sm" style={{ background: sc[900] }} />
          <div className="flex-1 rounded bg-white border border-[#e0e4e9] overflow-hidden">
            <div className="h-3" style={{ background: sc[50] }} />
            <div className="px-2 pt-1.5 flex items-center gap-2">
              <span className="h-1.5 w-10 rounded-full bg-[#c7ced7]" />
              <span className="h-1.5 flex-1 rounded-full" style={{ background: sc[100] }}><span className="block h-full w-2/3 rounded-full" style={{ background: sc[600] }} /></span>
              <span className="h-1.5 w-8 rounded-full" style={{ background: sc[700] }} />
            </div>
          </div>
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
  const side = sideOf(value);
  const [which, setWhich] = React.useState<"brand" | "accent">("brand");

  const pick = (primary: string, name: string, id: string, secondary?: string) =>
    onChange({ id, name, primary, secondary: secondary ?? primary, side });
  const pickLogo = (hex: string) => which === "brand"
    ? onChange({ ...value, id: "logo", name: "From your logo", primary: hex, side })
    : onChange({ ...value, id: "logo", name: "From your logo", secondary: hex, side });

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

  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const logoOn = (hex: string) => same(hex, which === "brand" ? value.primary : value.secondary);
  const swatch = (hex: string, label: string, on: boolean, onClick: () => void, tag?: string) => (
    <button key={label + hex} type="button" disabled={disabled} onClick={onClick} aria-pressed={on} title={label}
      className="group flex flex-col items-center gap-1 w-[64px] disabled:opacity-50">
      <span className={`w-11 h-11 rounded-md grid place-items-center ring-offset-2 ring-offset-[var(--color-surface)] ${on ? "ring-2 ring-[var(--color-text)]" : "ring-1 ring-black/10 group-hover:ring-[var(--color-border-strong)]"}`}
        style={{ background: which === "brand" ? signalScale(hex)[600] : accentFor(value.primary, hex).fill }}>
        {on && <Check className="w-4 h-4 text-white" />}
      </span>
      <span className="text-[12px] text-[var(--color-text-muted)] leading-tight text-center">{label}</span>
      {tag && <span className="text-[11px] font-semibold text-[var(--color-accent-text)] leading-none">{tag}</span>}
    </button>
  );
  const pairSwatch = (p: Palette) => {
    const on = same(p.primary, value.primary) && same(p.secondary, value.secondary);
    const acc = accentFor(p.primary, p.secondary);
    return (
      <button key={p.id} type="button" disabled={disabled} onClick={() => pick(p.primary, p.name, p.id, p.secondary)} aria-pressed={on} title={p.name}
        className={`flex items-center gap-2.5 px-2.5 min-h-11 rounded-md border text-left disabled:opacity-50 ${on ? "border-[var(--color-text)] bg-[var(--color-surface-2)]" : "border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"}`}>
        <span className="flex h-7 w-16 rounded overflow-hidden ring-1 ring-black/10 shrink-0">
          <span className="w-[30%]" style={{ background: deepFor(p.primary) }} />
          <span className="flex-1" style={{ background: signalScale(p.primary)[600] }} />
          <span className="w-[24%]" style={{ background: acc.fill }} />
        </span>
        <span className="flex-1 min-w-0 text-[14px] font-semibold text-[var(--color-text)] truncate">{p.name}</span>
        {on && <Check className="w-4 h-4 text-[var(--color-text)] shrink-0" />}
      </button>
    );
  };

  return (
    <div className="space-y-5">
      <PalettePreview palette={value} />
      <p className="text-[13px] text-[var(--color-text-muted)]">
        Your brand color fills the header band and marks links and tabs; its deep shade is the side menu. The accent goes only on the one main button, so it stands out.
      </p>
      {lockedNote ? <p className="text-[13px] text-[var(--color-text-muted)]">{lockedNote}</p> : (
        <>
          {usable.length > 0 && (
            <div>
              <div className="flex items-center gap-3 mb-2">
                <h3 className="font-display text-[15px] font-semibold">From your logo</h3>
                <div role="radiogroup" aria-label="Logo color for" className="inline-flex h-8 rounded-md border border-[var(--color-border-strong)] overflow-hidden text-[13px] font-semibold">
                  {(["brand", "accent"] as const).map((k) => (
                    <button key={k} type="button" role="radio" aria-checked={which === k} onClick={() => setWhich(k)}
                      className={`px-3 ${which === k ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
                      {k === "brand" ? "Brand" : "Accent"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {usable.slice(0, 6).map((hex, i) => swatch(hex, `Color ${i + 1}`, logoOn(hex), () => pickLogo(hex),
                  which === "brand" ? (suggested?.signal === hex ? "Best fit" : undefined) : (suggested?.second === hex ? "Best fit" : undefined)))}
              </div>
            </div>
          )}
          <div>
            <h3 className="font-display text-[15px] font-semibold mb-2">Ready-made pairs</h3>
            <div className="grid grid-cols-1 @md:grid-cols-2 gap-1.5 @container">
              {PALETTE_PRESETS.map(pairSwatch)}
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
            {([["primary", "Brand"], ["secondary", "Accent"]] as const).map(([k, label]) => (
              <label key={k} className="flex flex-col gap-1.5 text-[13px] font-medium text-[var(--color-text-muted)]">
                {label}
                <span className="flex items-center gap-2 h-10 pl-1.5 pr-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)]">
                  <input type="color" disabled={disabled} value={value[k]} onChange={(e) => onChange({ ...value, id: "custom", name: "Custom", [k]: e.target.value, side })}
                    className="w-7 h-7 rounded border-0 bg-transparent p-0 cursor-pointer disabled:cursor-not-allowed" aria-label={`Pick the ${label.toLowerCase()} color`} />
                  <span className="text-[13px] tabular-nums text-[var(--color-text)]">{value[k]}</span>
                </span>
              </label>
            ))}
            <div className="flex flex-col gap-1.5 text-[13px] font-medium text-[var(--color-text-muted)]">
              Side menu
              <div role="radiogroup" aria-label="Side menu" className="inline-flex h-10 rounded-md border border-[var(--color-border-strong)] overflow-hidden">
                {(["deep", "light"] as const).map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={side === k} disabled={disabled}
                    onClick={() => onChange({ ...value, side: k })}
                    className={`px-4 text-[14px] font-semibold ${side === k ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
                    {k === "deep" ? "Deep" : "Light"}
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
