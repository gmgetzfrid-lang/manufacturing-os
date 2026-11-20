// slideTemplateStore - the workspace's PowerPoint template, in storage.
//
// Upload reads the file in the browser (lib/slideTemplate leanTemplate),
// stores what's left under the workspace's branding folder, and returns the
// small record the branding keeps. Download fetches it once per visit.

import JSZip from "jszip";
import { getSignedUrlForPath, uploadToPath } from "@/lib/storage";
import { layoutFor, leanTemplate, readTemplate, templateColors, templateFonts, type SlideTemplateRef, type TemplateInfo } from "@/lib/slideTemplate";
import { lookFromTemplate, type DeckLook } from "@/lib/deckLook";

export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const TEMPLATE_ACCEPT = ".pptx,.potx";
const MAX_UPLOAD = 80 * 1024 * 1024;

/** Read, trim and store a template. Nothing is saved to the branding here. */
export async function uploadSlideTemplate(orgId: string, file: File): Promise<SlideTemplateRef> {
  if (!/\.(pptx|potx)$/i.test(file.name)) throw new Error("Upload a PowerPoint file (.pptx or .potx).");
  if (file.size > MAX_UPLOAD) throw new Error(`That file is ${Math.round(file.size / 1048576)} MB. The limit is ${MAX_UPLOAD / 1048576} MB.`);
  const { data, info, thumb } = await leanTemplate(await file.arrayBuffer());
  const content = layoutFor(info, "content") ?? info.layouts[0];
  const rand = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;
  const path = `orgs/${orgId}/branding/slides-${rand}.pptx`;
  await uploadToPath(new File([data as BlobPart], file.name, { type: PPTX_MIME }), path, { contentType: PPTX_MIME });
  let thumbPath: string | undefined;
  if (thumb) {
    const png = thumb[0] === 0x89;
    thumbPath = `orgs/${orgId}/branding/slides-${rand}-cover.${png ? "png" : "jpg"}`;
    try { await uploadToPath(new File([thumb as BlobPart], `${file.name.replace(/\.(pptx|potx)$/i, "")} cover.${png ? "png" : "jpg"}`, { type: png ? "image/png" : "image/jpeg" }), thumbPath, { contentType: png ? "image/png" : "image/jpeg" }); }
    catch { thumbPath = undefined; }
  }
  cache.set(path, Promise.resolve({ data, info }));
  return {
    path, name: file.name, size: data.length, savedAt: new Date().toISOString(), thumbPath,
    layouts: info.layouts.map((l) => ({ file: l.file, name: l.name })).sort((a, b) => layoutNo(a.file) - layoutNo(b.file)),
    roles: info.roles, colors: templateColors(content), fonts: templateFonts(content),
  };
}
const layoutNo = (f: string) => Number(f.match(/(\d+)\.xml$/)?.[1] ?? 0);

const cache = new Map<string, Promise<{ data: Uint8Array; info: TemplateInfo }>>();
/** The stored template, measured. Read once per visit. */
export function loadSlideTemplate(ref: Pick<SlideTemplateRef, "path">): Promise<{ data: Uint8Array; info: TemplateInfo }> {
  let p = cache.get(ref.path);
  if (!p) {
    p = (async () => {
      const url = await getSignedUrlForPath(ref.path, 600);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`The slide template couldn't be read (${res.status}).`);
      const data = new Uint8Array(await res.arrayBuffer());
      return { data, info: await readTemplate(await JSZip.loadAsync(data)) };
    })();
    p.catch(() => cache.delete(ref.path));
    cache.set(ref.path, p);
  }
  return p;
}

/** The template's colors and fonts, from the layout the tables go on. */
export function templateLook(info: TemplateInfo, ref: Pick<SlideTemplateRef, "pick">): DeckLook {
  const l = layoutFor(info, "content", ref.pick) ?? info.layouts[0];
  return lookFromTemplate({ colors: templateColors(l), fonts: templateFonts(l) });
}
