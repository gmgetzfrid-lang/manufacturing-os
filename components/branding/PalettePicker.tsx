"use client";

// Pick the workspace's colors: three, each shown by what it paints. The
// side menu (a deep shade), the header band and links (the main color),
// and the one main button per screen (the accent, kept small so it pops).
// From a logo the app offers ways to place its colors, best first: Try
// another moves to the next, and tapping two colors swaps them. Whatever
// comes in, the app tunes its lightness so every text reads. The preview
// shows where it lands.

import React from "react";
import { Check, Upload, Loader2, RefreshCw, ArrowLeftRight } from "lucide-react";
import { PALETTE_PRESETS, sideOf, deepOf, type Palette } from "@/components/providers/ThemeProvider";
import { signalScale, isColorful, deepFor, accentFor, accentUsesOwn, logoTriplets, tripletGap, paintTriplet, type Triplet } from "@/lib/brandColors";
import { extractLogoColors } from "@/lib/logoTheme";
import { btnQuiet } from "@/components/admin/kit";
import { bandSeg, bandSegItem } from "@/components/admin/band";

type Role = keyof Triplet;
const ROLES: { role: Role; label: string }[] = [
  { role: "deep", label: "Side menu" },
  { role: "main", label: "Header and links" },
  { role: "accent", label: "Main button" },
];

/** A palette's three colors as picked. The button's is its own color, or
 *  the brand's opposite (as painted) when it has none. */
export function tripletOf(p: Palette): Triplet {
  return { deep: deepOf(p), main: p.primary, accent: accentUsesOwn(p.primary, p.secondary) ? p.secondary : accentFor(p.primary, p.secondary).fill };
}

/** A palette from three colors: a logo suggestion, a swap, or a pick. */
export function paletteFromTriplet(t: Triplet, side: "deep" | "light", fromLogo = true): Palette {
  return { id: fromLogo ? "logo" : "custom", name: fromLogo ? "From your logo" : "Custom", primary: t.main, secondary: t.accent, deep: t.deep, side };
}

/** A small picture of a screen in these colors. */
export function PalettePreview({ palette, className = "" }: { palette: Palette; className?: string }) {
  const sc = signalScale(palette.primary);
  const acc = accentFor(palette.primary, palette.secondary);
  const deep = sideOf(palette) === "deep";
  const menuBg = deep ? deepFor(deepOf(palette)) : "#ffffff";
  const menuLine = deep ? "rgba(255,255,255,.35)" : "#c7ced7";
  return (
    <div aria-hidden className={`flex h-36 rounded-lg overflow-hidden border border-[var(--color-border-strong)] bg-[#eef1f7] ${className}`}>
      <div className="w-[24%] p-2.5 flex flex-col gap-2" style={{ background: menuBg, borderRight: deep ? "none" : "1px solid #e0e4e9" }}>
        <span className="h-3 w-12 rounded-sm" style={{ background: deep ? "#ffffff" : "#1f2733" }} />
        <span className="h-4 rounded" style={{ background: sc[600] }} />
        <span className="h-1.5 w-10 rounded-full" style={{ background: menuLine }} />
        <span className="h-1.5 w-7 rounded-full" style={{ background: menuLine }} />
      </div>
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-3 py-2.5 flex items-center justify-between gap-2" style={{ background: sc[600] }}>
          <span className="h-3 w-20 rounded-sm" style={{ background: "#ffffff" }} />
          <span className="h-5 w-12 rounded" style={{ background: acc.fill }} />
        </div>
        <div className="flex-1 p-2.5 flex flex-col gap-1.5">
          <span className="h-2 w-14 rounded-sm" style={{ background: sc[900] }} />
          <div className="flex-1 rounded border border-[#e0e4e9] overflow-hidden" style={{ background: "#ffffff" }}>
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
  const usable = React.useMemo(() => (fromLogo ?? []).filter(isColorful).slice(0, 6), [fromLogo]);
  const suggestions = React.useMemo(() => logoTriplets(fromLogo ?? []), [fromLogo]);
  const side = sideOf(value);
  // The swatch tapped first (to swap with the next one tapped, or to pick
  // a color for), and the last suggestion shown.
  const [sel, setSel] = React.useState<Role | null>(null);
  const [at, setAt] = React.useState(-1);

  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const current = tripletOf(value);
  const painted = paintTriplet(current);
  const acc = accentFor(value.primary, value.secondary);
  const match = suggestions.findIndex((t) => tripletGap(t, current) < 0.012);
  const onLogo = usable.length > 0;
  // A button color too close to the header's hue gives way to the
  // header's opposite; say so, or the swap looks like it did nothing.
  const [tooClose, setTooClose] = React.useState(false);

  const pick = (primary: string, name: string, id: string, secondary?: string) => {
    setSel(null); setTooClose(false);
    onChange({ id, name, primary, secondary: secondary ?? primary, side });
  };
  const show = (i: number) => { setAt(i); setSel(null); setTooClose(false); onChange(paletteFromTriplet(suggestions[i], side)); };
  const tryAnother = () => show(((match >= 0 ? match : at) + 1) % suggestions.length);
  const apply = (t: Triplet) => {
    setTooClose(isColorful(t.accent) && !accentUsesOwn(t.main, t.accent));
    onChange(paletteFromTriplet(t, side, onLogo));
  };
  const setRole = (r: Role, hex: string) => apply({ ...current, [r]: hex });
  const tap = (r: Role) => {
    if (sel === null) { setSel(r); setTooClose(false); return; }
    if (sel !== r) apply({ ...current, [sel]: current[r], [r]: current[sel] });
    setSel(null);
  };

  const readLogo = async (file: File) => {
    setReading(true); setNote(null);
    try {
      const colors = (await extractLogoColors(file)).map((c) => c.hex);
      setFound(colors);
      const best = logoTriplets(colors)[0];
      if (best) { setAt(0); setSel(null); setTooClose(false); onChange(paletteFromTriplet(best, side)); }
      else setNote("That logo has no strong color (only black, white or grey), so the colors stay as they are.");
    } catch { setNote("Couldn't read that image. Try a PNG or SVG."); }
    finally { setReading(false); }
  };

  const swatch = ({ role, label }: { role: Role; label: string }) => {
    const off = role === "deep" && side === "light";
    const on = sel === role;
    const target = sel !== null && !on && !off;
    const hex = painted[role];
    return (
      <button key={role} type="button" disabled={disabled || off} onClick={() => tap(role)} aria-pressed={on}
        aria-label={off ? `${label}: not used with the light menu` : `${label}, ${hex}`}
        className="group flex flex-col min-w-0 text-left rounded-lg disabled:cursor-not-allowed">
        <span className={`relative h-16 w-full rounded-lg grid place-items-center transition-shadow ${on ? "ring-[3px] ring-[var(--color-text)] ring-offset-2 ring-offset-[var(--color-surface)]" : off ? "ring-1 ring-black/10 opacity-30" : "ring-1 ring-black/10 group-hover:ring-2 group-hover:ring-[var(--color-text-faint)]"}`}
          style={{ background: hex, color: role === "accent" ? acc.fg : "#ffffff" }}>
          {on && <span className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full grid place-items-center shadow-sm" style={{ background: "#ffffff", color: "#1f2733" }}><Check className="w-4 h-4" strokeWidth={3} /></span>}
          {target && <span className="inline-flex items-center gap-1 text-body font-medium"><ArrowLeftRight className="w-4 h-4" /> Swap</span>}
        </span>
        <span className={`mt-1.5 text-body font-medium leading-tight ${off ? "text-[var(--color-text-muted)]" : "text-[var(--color-text)]"}`}>{label}</span>
        <span className="mt-0.5 text-caption leading-tight text-[var(--color-text-muted)] tabular-nums">{off ? "Light menu" : hex}</span>
      </button>
    );
  };

  const pairSwatch = (p: Palette) => {
    const on = same(p.primary, value.primary) && same(p.secondary, value.secondary) && same(deepOf(value), p.primary);
    const pa = accentFor(p.primary, p.secondary);
    return (
      <button key={p.id} type="button" disabled={disabled} onClick={() => pick(p.primary, p.name, p.id, p.secondary)} aria-pressed={on} title={p.name}
        className={`flex items-center gap-2.5 px-2.5 min-h-11 rounded-md border text-left disabled:opacity-50 ${on ? "border-[var(--color-text)] bg-[var(--color-surface-2)]" : "border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"}`}>
        <span className="flex h-7 w-16 rounded overflow-hidden ring-1 ring-black/10 shrink-0">
          <span className="w-[30%]" style={{ background: deepFor(p.primary) }} />
          <span className="flex-1" style={{ background: signalScale(p.primary)[600] }} />
          <span className="w-[24%]" style={{ background: pa.fill }} />
        </span>
        <span className="flex-1 min-w-0 text-body font-medium text-[var(--color-text)] truncate">{p.name}</span>
        {on && <Check className="w-4 h-4 text-[var(--color-text)] shrink-0" />}
      </button>
    );
  };

  const selLabel = ROLES.find((r) => r.role === sel)?.label ?? "";

  return (
    <div className="space-y-5">
      <PalettePreview palette={value} />
      {lockedNote ? <p className="text-body text-[var(--color-text-muted)]">{lockedNote}</p> : (
        <>
          <div onKeyDown={(e) => { if (e.key === "Escape" && sel) { e.stopPropagation(); setSel(null); } }}>
            <h3 className="text-body font-medium text-[var(--color-text)] mb-2">{onLogo ? "From your logo" : "Your colors"}</h3>
            <div className="grid grid-cols-3 gap-2.5">
              {ROLES.map(swatch)}
            </div>
            <p aria-live="polite" className="mt-2.5 text-body text-[var(--color-text-muted)]">
              {tooClose ? "Too close to the header color, so the button uses the opposite."
                : sel ? "Tap another color to swap, or pick one here."
                : "Tap a color to change it, or tap two to swap."}
            </p>
            {sel && (
              <div role="group" aria-label={`Color for ${selLabel.toLowerCase()}`} className="mt-2 flex flex-wrap items-center gap-2">
                {usable.map((hex) => {
                  const on = same(hex, current[sel]);
                  return (
                    <button key={hex} type="button" disabled={disabled} onClick={() => setRole(sel, hex)} aria-pressed={on} aria-label={`Use ${hex}`} title={hex}
                      className={`w-10 h-10 rounded-full grid place-items-center ring-offset-2 ring-offset-[var(--color-surface)] ${on ? "ring-2 ring-[var(--color-text)]" : "ring-1 ring-black/15 hover:ring-2 hover:ring-[var(--color-text-faint)]"}`}
                      style={{ background: hex }}>
                      {on && <Check className="w-4 h-4 text-white drop-shadow" strokeWidth={3} />}
                    </button>
                  );
                })}
                <label className={`${btnQuiet} h-10 cursor-pointer pl-1.5`}>
                  <input type="color" disabled={disabled} value={painted[sel]} onChange={(e) => setRole(sel, e.target.value)}
                    className="w-7 h-7 rounded border-0 bg-transparent p-0 cursor-pointer" aria-label={`Any color for ${selLabel.toLowerCase()}`} />
                  Any color
                </label>
                <button type="button" onClick={() => setSel(null)} className={`${btnQuiet} h-10`}>Done</button>
              </div>
            )}
            {suggestions.length > 1 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" disabled={disabled} onClick={tryAnother} className={`${btnQuiet} h-10`}>
                  <RefreshCw className="w-4 h-4" /> Try another
                </button>
                {match >= 0 && <span aria-live="polite" className="px-1 text-body font-medium tabular-nums text-[var(--color-text-muted)]">{match + 1} of {suggestions.length}</span>}
                {match !== 0 && <button type="button" disabled={disabled} onClick={() => show(0)} className={`${btnQuiet} h-10`}>Best fit</button>}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-body font-medium text-[var(--color-text)]">Side menu</span>
            <div role="radiogroup" aria-label="Side menu" className={bandSeg}>
              {(["deep", "light"] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={side === k} disabled={disabled}
                  onClick={() => { setSel(null); onChange({ ...value, side: k }); }}
                  className={bandSegItem(side === k)}>
                  {k === "deep" ? "Deep" : "Light"}
                </button>
              ))}
            </div>
          </div>
          <div className="@container">
            <h3 className="text-body font-medium text-[var(--color-text)] mb-2">Ready-made pairs</h3>
            <div className="grid grid-cols-1 @md:grid-cols-2 gap-1.5">
              {PALETTE_PRESETS.map(pairSwatch)}
            </div>
          </div>
          {logoButton && (
            <div>
              <button type="button" disabled={disabled || reading} onClick={() => fileRef.current?.click()} className={`${btnQuiet} h-10`}>
                {reading ? <><Loader2 className="w-4 h-4 animate-spin" /> Reading the logo</> : <><Upload className="w-4 h-4" /> Use colors from a logo</>}
              </button>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void readLogo(f); e.currentTarget.value = ""; }} />
            </div>
          )}
          {note && <p role="status" className="text-body text-[var(--color-text-muted)]">{note}</p>}
        </>
      )}
    </div>
  );
}
