// lib/logoTheme.ts
//
// Extract a brand palette from an uploaded logo, in the browser, via
// canvas — instant, free, offline, and more reliable than asking an
// LLM to guess hex codes from an image. We downsample the logo, bucket
// pixels into coarse color cells, ignore near-white/near-black/低-sat
// background pixels, and return the most prominent, usable accent
// candidates (sorted by a saliency score = frequency × saturation).
//
// The theme picker feeds a chosen hex straight into ThemeProvider, so
// "brand from logo" reuses the single source of truth.

export interface ExtractedColor { hex: string; weight: number }

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0; const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60; if (h < 0) h += 360;
  }
  return [h, s, l];
}
function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => v.toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Load an image file and return prominent brand-accent candidates. */
export async function extractLogoColors(file: File, max = 6): Promise<ExtractedColor[]> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const W = 80, H = Math.max(1, Math.round((img.height / img.width) * 80)) || 80;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return [];
    ctx.drawImage(img, 0, 0, W, H);
    const { data } = ctx.getImageData(0, 0, W, H);

    // Bucket by quantized hue+lightness; score by saturation so a brand
    // color beats a large bland background.
    const buckets = new Map<string, { r: number; g: number; b: number; n: number; score: number }>();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 128) continue;                                  // transparent
      const [h, s, l] = rgbToHsl(r, g, b);
      if (l > 0.93 || l < 0.07) continue;                     // near white/black
      if (s < 0.18) continue;                                 // greys
      const key = `${Math.round(h / 24)}_${Math.round(l * 6)}`; // coarse cells
      const cur = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0, score: 0 };
      cur.r += r; cur.g += g; cur.b += b; cur.n += 1; cur.score += s;
      buckets.set(key, cur);
    }
    const out = Array.from(buckets.values())
      .map((c) => ({
        hex: toHex(Math.round(c.r / c.n), Math.round(c.g / c.n), Math.round(c.b / c.n)),
        weight: c.score,
      }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, max);

    // De-dupe visually-close hexes.
    const dedup: ExtractedColor[] = [];
    for (const c of out) {
      if (!dedup.some((d) => closeHex(d.hex, c.hex))) dedup.push(c);
    }
    return dedup;
  } catch {
    return [];
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function closeHex(a: string, b: string): boolean {
  const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
  const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
  const dist = Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]) + Math.abs(pa[2] - pb[2]);
  return dist < 48;
}
