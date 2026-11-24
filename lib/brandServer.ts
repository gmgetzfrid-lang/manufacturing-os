// The workspace's own logo as the app's face: the home-screen icon, the
// browser tab, the sign-in page and the pages someone outside opens.
//
// Server only. Read with the service role, because the browser fetches
// icons and the manifest by itself, often before anyone signs in.
//
// Which workspace: the one named in the request (a link's workspace, or
// ?ws=), else the one this device last used (the mos_ws cookie, set after
// sign-in), else BRAND_ORG_ID, else the only workspace there is. A
// workspace without a logo never borrows another one's: it gets the plain
// fallback (the initial M, no mark).

import sharp from "sharp";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const WS_COOKIE = "mos_ws";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isOrgId = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export interface Brand {
  orgId: string;
  name: string | null;
  /** null: this workspace has no logo uploaded. */
  logoPath: string | null;
  shape: "mark" | "full";
  /** Changes when the logo changes (cache key for icons). */
  version: string;
}

const TTL = 5 * 60_000;
const brands = new Map<string, { at: number; brand: Brand | null }>();
const images = new Map<string, { at: number; png: Buffer }>();
const prepared = new Map<string, { at: number; logo: Buffer; bg: string }>();
let only: { at: number; orgId: string | null } | null = null;

function short(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** One workspace's name and logo, or null when it doesn't exist. */
export async function brandOf(orgId: string): Promise<Brand | null> {
  if (!isOrgId(orgId)) return null;
  const hit = brands.get(orgId);
  if (hit && Date.now() - hit.at < TTL) return hit.brand;
  const [{ data: org }, { data: cfg }] = await Promise.all([
    supabaseAdmin.from("orgs").select("id, name").eq("id", orgId).maybeSingle(),
    supabaseAdmin.from("org_configurations").select("data").eq("org_id", orgId).eq("key", "branding").maybeSingle(),
  ]);
  let brand: Brand | null = null;
  if (org) {
    const b = (cfg?.data ?? {}) as { logoPath?: string; logoShape?: "mark" | "full"; updatedAt?: string };
    const logoPath = typeof b.logoPath === "string" && b.logoPath.startsWith(`orgs/${orgId}/`) ? b.logoPath : null;
    brand = {
      orgId,
      name: (org as { name?: string | null }).name ?? null,
      logoPath,
      shape: b.logoShape === "full" ? "full" : "mark",
      version: short(`${logoPath ?? ""}|${b.updatedAt ?? ""}`),
    };
  }
  brands.set(orgId, { at: Date.now(), brand });
  return brand;
}

/** The deployment's workspace when nothing else says which: BRAND_ORG_ID,
 *  else the single workspace when there is exactly one. */
async function defaultOrgId(): Promise<string | null> {
  const env = process.env.BRAND_ORG_ID;
  if (isOrgId(env)) return env;
  if (only && Date.now() - only.at < TTL) return only.orgId;
  const { data } = await supabaseAdmin.from("orgs").select("id").limit(2);
  const rows = (data ?? []) as { id: string }[];
  only = { at: Date.now(), orgId: rows.length === 1 ? rows[0].id : null };
  return only.orgId;
}

/** Which workspace a request is about, and whether that came from the
 *  request itself (safe to cache for everyone) or from this device. */
export async function brandFor(req: Request): Promise<{ brand: Brand | null; shared: boolean }> {
  const url = new URL(req.url);
  const ws = url.searchParams.get("ws");
  if (isOrgId(ws)) return { brand: await brandOf(ws), shared: true };
  const cookie = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${WS_COOKIE}=([^;]+)`))?.[1];
  if (isOrgId(cookie)) return { brand: await brandOf(cookie), shared: false };
  const id = await defaultOrgId();
  return { brand: id ? await brandOf(id) : null, shared: false };
}

/** The logo link for a workspace, for a page someone outside opens. */
export async function logoLinkFor(orgId: string | null | undefined): Promise<string | null> {
  if (!orgId) return null;
  try {
    const b = await brandOf(orgId);
    return b?.logoPath ? `/api/brand/logo?ws=${b.orgId}&v=${b.version}&plate=1` : null;
  } catch { return null; }
}

async function readObject(path: string): Promise<Buffer> {
  const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: path }));
  const bytes = await obj.Body?.transformToByteArray();
  if (!bytes) throw new Error("empty logo");
  return Buffer.from(bytes);
}

const luminance = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** The logo with its empty margin cut off, and the color it should sit
 *  on: its own background when the file has one, white for a dark logo
 *  on a clear background, near-black for a light one. */
async function prepare(bytes: Buffer): Promise<{ logo: Buffer; bg: string }> {
  const src = () => sharp(bytes, { density: 384, failOn: "none" }).rotate();
  const { data, info } = await src().resize(64, 64, { fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => {
    const i = (y * info.width + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]] as const;
  };
  const corners = [px(0, 0), px(info.width - 1, 0), px(0, info.height - 1), px(info.width - 1, info.height - 1)];
  const solid = corners.every((c) => c[3] > 250)
    && corners.every((c) => Math.abs(c[0] - corners[0][0]) + Math.abs(c[1] - corners[0][1]) + Math.abs(c[2] - corners[0][2]) < 30);
  let bg = "#ffffff";
  if (solid) {
    bg = hex(corners[0][0], corners[0][1], corners[0][2]);
  } else {
    let sum = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 128) { sum += luminance(data[i], data[i + 1], data[i + 2]); n++; }
    }
    if (n > 0 && sum / n > 0.82) bg = "#16181d";
  }
  let logo: Buffer;
  try {
    logo = await src().trim({ threshold: 12 }).png().toBuffer();
  } catch {
    logo = await src().png().toBuffer();
  }
  return { logo, bg };
}

/** The plain fallback: the initial M, white on graphite. */
function fallbackSvg(size: number, rounded: boolean): Buffer {
  const r = rounded ? Math.round(size * 0.22) : 0;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">`
    + `<rect width="100" height="100" rx="${(r / size) * 100}" fill="#16181d"/>`
    + `<path d="M28 70V30h9l13 19 13-19h9v40h-9V45L50 63 37 45v25z" fill="#ffffff"/></svg>`,
  );
}

/** The workspace's logo, prepared once per version. */
export async function preparedLogo(brand: Brand): Promise<{ logo: Buffer; bg: string } | null> {
  if (!brand.logoPath) return null;
  const key = `${brand.orgId}|${brand.version}`;
  const hit = prepared.get(key);
  if (hit && Date.now() - hit.at < TTL * 6) return hit;
  const p = await prepare(await readObject(brand.logoPath));
  prepared.set(key, { at: Date.now(), ...p });
  return p;
}

export type IconKind = "any" | "mask" | "apple";

/** A square PNG icon of the workspace's logo. `any` has rounded corners;
 *  `mask` and `apple` are full squares (the phone cuts the shape), and
 *  `mask` keeps the logo inside the circle Android may cut. */
export async function iconPng(brand: Brand | null, size: number, kind: IconKind): Promise<Buffer> {
  const key = `${brand?.orgId ?? "-"}|${brand?.version ?? "-"}|${size}|${kind}`;
  const hit = images.get(key);
  if (hit && Date.now() - hit.at < TTL * 6) return hit.png;
  const rounded = kind === "any";
  let png: Buffer;
  try {
    const p = brand ? await preparedLogo(brand) : null;
    if (!p) throw new Error("no logo");
    const { logo, bg } = p;
    const k = kind === "mask" ? 0.6 : size <= 64 ? 0.84 : 0.72;
    const box = Math.max(8, Math.round(size * k));
    const fitted = await sharp(logo).resize(box, box, { fit: "inside" }).png().toBuffer();
    const r = rounded ? Math.round(size * 0.22) : 0;
    const base = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" fill="${bg}"/></svg>`);
    png = await sharp(base).composite([{ input: fitted, gravity: "centre" }]).png().toBuffer();
  } catch {
    png = await sharp(fallbackSvg(size, rounded)).resize(size, size).png().toBuffer();
  }
  images.set(key, { at: Date.now(), png });
  return png;
}

/** The logo alone, margin cut off, at most 480 px on its long side.
 *  `plated`: on its own background color with a margin and rounded
 *  corners, so it reads on any page (a white logo on a white page would
 *  vanish). */
export async function logoPng(brand: Brand, plated = false): Promise<Buffer | null> {
  const key = `${brand.orgId}|${brand.version}|logo|${plated ? 1 : 0}`;
  const hit = images.get(key);
  if (hit && Date.now() - hit.at < TTL * 6) return hit.png;
  const p = await preparedLogo(brand);
  if (!p) return null;
  const { data: fitted, info } = await sharp(p.logo).resize(480, 480, { fit: "inside", withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
  let png = fitted;
  if (plated) {
    const pad = Math.max(12, Math.round(Math.min(info.width, info.height) * 0.2));
    const w = info.width + pad * 2, h = info.height + pad * 2;
    const r = Math.round(Math.min(w, h) * 0.14);
    const base = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" fill="${p.bg}"/></svg>`);
    png = await sharp(base).composite([{ input: fitted, gravity: "centre" }]).png().toBuffer();
  }
  images.set(key, { at: Date.now(), png });
  return png;
}

/** Cache headers: a request that names its workspace is the same for
 *  everyone; one decided by this device's cookie is private. */
export function cacheFor(shared: boolean): string {
  return shared
    ? "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"
    : "private, max-age=3600";
}
