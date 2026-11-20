// slidePictures - pictures on the review slides.
//
// The app puts them there itself: a slide that names a piece of equipment
// (E-12, PSV-021) shows that equipment's photo, when it has one. Photos
// taken during the event come first, then current ones, then the newest.
// The cover shows the equipment that held the finish most. A person can
// take any picture off, swap it, or add one (lib/postEventReview keeps
// their choice per slide in the review, and it wins).
//
// Tables come first: pictures go down the right while the table still
// reads beside them, else in a strip under it, else not at all
// (lib/reviewFiles picPlace).

import { picPlace, type DeckFit, type SlidePicture, type SlideSpec } from "@/lib/reviewFiles";
import { normalizeTag, tagNormForms } from "@/lib/assets";
import { parseEquipmentLabel, pickEquipment, type IdentityRecord } from "@/lib/equipmentIdentity";

/** A picture chosen for a slide, as saved with the review. */
export interface SlidePicChoice { path: string; caption: string; tag?: string }
/** A photo the slides can use: an equipment photo. */
export interface PhotoOption extends SlidePicChoice { tag: string; photoId: string; capturedAt: string | null }
/** A picture ready for a slide: small enough to carry, with its size. */
export interface ReadyPic extends SlidePicture { path: string }

/** How many pictures a slide has room for: the cover one (when it has a
 *  spot for it), a table slide two (when its table still reads beside or
 *  above them), anything else none. */
export const picRoom = (s: SlideSpec, coverSpot = true, area?: DeckFit) => (s.body.k === "cover" ? (coverSpot ? 1 : 0) : picPlace(s, area) ? 2 : 0);

const TAG = /\b([A-Z]{1,4}-?\d{1,4}[A-Z]?)\b/g;
/** Every equipment tag a slide names, in the order it matters: its title,
 *  the line above the table, then the rows. */
export function slideTags(s: SlideSpec): string[] {
  const b = s.body;
  const texts = [s.title, ...(b.k === "table" ? [b.lead ?? "", ...b.rows.map((r) => r.join(" "))] : b.k === "cover" ? [b.sub] : b.k === "asks" ? b.items.map((i) => `${i.ask} ${i.because}`) : [])];
  const out: string[] = [];
  for (const t of texts) for (const m of t.matchAll(TAG)) if (!out.some((x) => normalizeTag(x) === normalizeTag(m[1]))) out.push(m[1]);
  return out;
}

/** "E-12 · Oct 29, 2026": the equipment and when the photo was taken. */
export function captionOf(tag: string, capturedAt: string | null, caption?: string | null): string {
  const d = capturedAt ? new Date(capturedAt) : null;
  const when = d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";
  return [tag, when, caption?.trim()].filter(Boolean).join(" · ");
}

/** Each slide's pictures as the app would pick them (by slide key). */
export function autoPictures(specs: SlideSpec[], photos: Map<string, PhotoOption[]>, coverSpot = true, area?: DeckFit): Record<string, SlidePicChoice[]> {
  const out: Record<string, SlidePicChoice[]> = {};
  const firstPhoto = (tag: string) => photos.get(normalizeTag(tag))?.[0];
  const score = specs.find((s) => s.key === "score");
  for (const s of specs) {
    const room = picRoom(s, coverSpot, area);
    if (!room || !s.key) continue;
    // The cover: the equipment the score slide says held the finish.
    const tags = s.body.k === "cover" && score ? slideTags(score) : slideTags(s);
    const pics: SlidePicChoice[] = [];
    for (const t of tags) {
      const p = firstPhoto(t);
      if (p && !pics.some((x) => x.path === p.path)) pics.push({ path: p.path, caption: p.caption, tag: p.tag });
      if (pics.length >= room) break;
    }
    if (!pics.length) continue;
    out[s.key] = pics;
  }
  return out;
}

/** Equipment photos for these tags, best first per tag: taken during the
 *  event, then current, then newest. Keyed by the tag's plain form. */
export function rankPhotos(rows: Array<{ id: string; tag: string; file_url: string; captured_at: string | null; uploaded_at: string | null; status: string | null; caption: string | null }>, window: { from: number | null; to: number | null }): Map<string, PhotoOption[]> {
  const during = (r: (typeof rows)[number]) => { const t = Date.parse(r.captured_at ?? ""); return window.from != null && Number.isFinite(t) && t >= window.from - 86400000 && t <= (window.to ?? window.from) + 2 * 86400000; };
  const score = (r: (typeof rows)[number]) => (during(r) ? 2 : 0) + (r.status === "superseded" ? -3 : r.status === "needs_verification" ? -1 : 0);
  const by = new Map<string, PhotoOption[]>();
  const sorted = [...rows].sort((a, b) => score(b) - score(a) || String(b.captured_at ?? b.uploaded_at ?? "").localeCompare(String(a.captured_at ?? a.uploaded_at ?? "")));
  for (const r of sorted) {
    const k = normalizeTag(r.tag);
    const list = by.get(k) ?? [];
    list.push({ path: r.file_url, tag: r.tag, photoId: r.id, capturedAt: r.captured_at, caption: captionOf(r.tag, r.captured_at, r.caption) });
    by.set(k, list);
  }
  return by;
}

// ─── In the browser ─────────────────────────────────────────────

const ready = new Map<string, Promise<ReadyPic>>();
/** A picture made ready for slides: turned upright, at most 1600 px on its
 *  long side, as JPEG. Read once per visit. */
export function readyPic(path: string, caption: string, url: () => Promise<string | null>): Promise<ReadyPic> {
  let p = ready.get(path);
  if (!p) {
    p = (async () => {
      const u = await url();
      if (!u) throw new Error("The picture couldn't be opened.");
      const res = await fetch(u);
      if (!res.ok) throw new Error(`The picture couldn't be read (${res.status}).`);
      const bmp = await createImageBitmap(await res.blob(), { imageOrientation: "from-image" });
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("This browser can't draw pictures.");
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close?.();
      const blob: Blob = await new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("The picture couldn't be made."))), "image/jpeg", 0.85));
      return { path, caption, url: URL.createObjectURL(blob), bytes: new Uint8Array(await blob.arrayBuffer()), w, h };
    })();
    p.catch(() => ready.delete(path));
    ready.set(path, p);
  }
  return p.then((r) => (r.caption === caption ? r : { ...r, caption }));
}

type Row = { id: string; tag: string; code: string | null; unit_code: string | null; origin: string | null; archived: boolean; created_at: string | null };

/** The registry rows these labels could mean: by ID, and by tag. */
async function equipmentRows(orgId: string, labels: string[]): Promise<Row[]> {
  const { supabase } = await import("@/lib/supabase");
  const parsed = labels.map(parseEquipmentLabel);
  const norms = [...new Set(parsed.flatMap((l) => (l.tag ? tagNormForms(l.tag) : [])))].slice(0, 600);
  const heads = [...new Set(parsed.flatMap((l) => (l.code ? [l.code.split(/[.-]/)[0]] : [])))].slice(0, 40);
  const cols = "id, tag, code, unit_code, origin, archived, created_at";
  const reads = [
    norms.length ? supabase.from("assets").select(cols).eq("org_id", orgId).in("tag_normalized", norms).limit(1000) : null,
    heads.length ? supabase.from("assets").select(cols).eq("org_id", orgId).or(heads.map((h) => `code.ilike."${h}%"`).join(",")).limit(1000) : null,
  ].filter((r) => r !== null);
  const out = new Map<string, Row>();
  for (const { data, error } of await Promise.all(reads)) {
    if (error) throw new Error(error.message);
    for (const a of (data ?? []) as Row[]) out.set(a.id, a);
  }
  return [...out.values()];
}

const record = (a: Row, photos: Map<string, number>): IdentityRecord & { row: Row } => ({
  id: a.id, tag: a.tag, code: a.code, unitCode: a.unit_code, origin: a.origin, archived: a.archived, createdAt: a.created_at, photos: photos.get(a.id) ?? 0, row: a,
});

/** The equipment photos for these tags in the workspace, best first per
 *  tag. "X-31 (2030.31)" is found by its ID; a tag on more than one unit is
 *  the project's unit's; copies of one piece count once, the one with an
 *  ID, then the one with photos (lib/equipmentIdentity). Keyed by the
 *  tag's plain form, as the slides name it. */
export async function loadEquipmentPhotos(orgId: string, tags: string[], unitCode: string | null, window: { from: number | null; to: number | null }): Promise<Map<string, PhotoOption[]>> {
  const wanted = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].slice(0, 200);
  if (!wanted.length) return new Map();
  const { supabase } = await import("@/lib/supabase");
  const rows = (await equipmentRows(orgId, wanted)).filter((a) => !a.archived);
  if (!rows.length) return new Map();
  const { data: photos, error: e2 } = await supabase.from("asset_photos").select("id, asset_id, file_url, captured_at, uploaded_at, status, caption").in("asset_id", rows.map((a) => a.id)).limit(1000);
  if (e2) throw new Error(e2.message);
  const list = (photos ?? []) as Array<{ id: string; asset_id: string; file_url: string; captured_at: string | null; uploaded_at: string | null; status: string | null; caption: string | null }>;
  const counts = new Map<string, number>();
  for (const p of list) counts.set(p.asset_id, (counts.get(p.asset_id) ?? 0) + 1);
  const recs = rows.map((a) => record(a, counts));
  // Each label's equipment, under the name the slide uses.
  const out: Array<(typeof list)[number] & { tag: string }> = [];
  const seen = new Set<string>();
  for (const label of wanted) {
    // The project's unit's; else the one piece of that name anywhere.
    let pick = pickEquipment(recs, { label, unitCode });
    if (!pick.asset && unitCode) pick = pickEquipment(recs, { label });
    if (!pick.asset) continue;
    const name = parseEquipmentLabel(label).tag ?? pick.asset.tag;
    if (seen.has(`${normalizeTag(name)}|${pick.asset.id}`)) continue;
    seen.add(`${normalizeTag(name)}|${pick.asset.id}`);
    for (const p of list) if (p.asset_id === pick.asset.id) out.push({ ...p, tag: name });
  }
  return rankPhotos(out, window);
}

/** The equipment a tag names, for filing a new photo under it (by its ID
 *  first, then the tag in the project's unit). */
export async function equipmentFor(orgId: string, tag: string, unitCode: string | null): Promise<{ id: string; tag: string } | null> {
  const rows = (await equipmentRows(orgId, [tag])).filter((a) => !a.archived);
  if (!rows.length) return null;
  let counts = new Map<string, number>();
  if (rows.length > 1) {
    const { supabase } = await import("@/lib/supabase");
    const { data } = await supabase.from("asset_photos").select("asset_id").in("asset_id", rows.map((a) => a.id)).limit(1000);
    counts = new Map<string, number>();
    for (const p of (data ?? []) as Array<{ asset_id: string }>) counts.set(p.asset_id, (counts.get(p.asset_id) ?? 0) + 1);
  }
  const recs = rows.map((a) => record(a, counts));
  const pick = pickEquipment(recs, { label: tag, unitCode }).asset ?? (unitCode ? pickEquipment(recs, { label: tag }).asset : null);
  return pick ? { id: pick.id, tag: pick.tag } : null;
}
