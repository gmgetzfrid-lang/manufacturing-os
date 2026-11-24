// The sending company's logo on the pages someone outside opens (a shared
// link, an upload link, a transmittal): read from the workspace's upload,
// its empty margin cut off, set on its own background color so it reads on
// any page. The app's own logo (MOS) is a static file, not this.
//
// Server only. Read with the service role: the person opening the link has
// no account. Only ever serves a workspace's branding logo.

import sharp from "sharp";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isOrgId = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export interface Brand {
  orgId: string;
  name: string | null;
  /** null: this workspace has no logo uploaded. */
  logoPath: string | null;
  shape: "mark" | "full";
  /** Changes when the logo changes (cache key). */
  version: string;
}

const TTL = 5 * 60_000;
const brands = new Map<string, { at: number; brand: Brand | null }>();
const images = new Map<string, { at: number; png: Buffer }>();
const prepared = new Map<string, { at: number; logo: Buffer; bg: string }>();

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

/** The workspace a logo request names (?ws=). */
export async function brandFor(req: Request): Promise<Brand | null> {
  const ws = new URL(req.url).searchParams.get("ws");
  return isOrgId(ws) ? brandOf(ws) : null;
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
