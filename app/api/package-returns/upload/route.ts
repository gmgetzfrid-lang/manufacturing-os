// POST /api/package-returns/upload  (multipart)
//   c (package code) or t (returns link token), key (the package),
//   itemId (the blank form it replaces, or "add" for pages to add),
//   title (for added pages), file (PDF, JPEG or PNG; a phone scan is a PDF)
//
// No account: the code or token is the key, and it only uploads. A signed
// form takes its blank's place in the package (a second scan of the same
// form replaces the first, and the first is deleted: these are working
// copies until the package is filed). The project team is told.

import { NextRequest, NextResponse } from "next/server";
import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import { PDFDocument } from "pdf-lib";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openReturns, readPackagesAdmin, updatePackageAdmin, visiblePackages } from "@/lib/packageReturnsServer";
import { newItemId } from "@/lib/woPackagesCore";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX = 50 * 1024 * 1024;
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function POST(req: NextRequest) {
  let form: FormData;
  try { form = await req.formData(); } catch { return bad("Expected a file."); }
  const opened = await openReturns({ code: String(form.get("c") ?? "") || null, token: String(form.get("t") ?? "") || null });
  if ("error" in opened) return bad(opened.error, opened.status);
  const { link, only } = opened;

  const key = String(form.get("key") ?? "");
  const itemId = String(form.get("itemId") ?? "");
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) return bad("Choose or scan the file first.");
  if (file.size > MAX) return bad("That file is over 50 MB. Scan it again, or send fewer pages at once.");
  const mime = file.type === "application/pdf" || /\.pdf$/i.test(file.name) ? "application/pdf"
    : file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name) ? "image/jpeg"
    : file.type === "image/png" || /\.png$/i.test(file.name) ? "image/png" : null;
  if (!mime) return bad("Send a PDF or a photo (JPEG or PNG).");

  // The package must be one this link may see, and the form one of its blanks.
  const { data: all } = await readPackagesAdmin(link.org_id, link.project_id);
  const pkg = visiblePackages(all, only).find((p) => p.key === key);
  if (!pkg) return bad("That package isn't open for returns.", 404);
  const target = itemId === "add" ? null : pkg.items.find((i) => i.id === itemId && i.kind === "form");
  if (itemId !== "add" && !target) return bad("That form isn't in the package.", 404);

  const bytes = new Uint8Array(await file.arrayBuffer());
  let pages = 1;
  if (mime === "application/pdf") {
    try { pages = (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount(); }
    catch { return bad("That PDF couldn't be read. Scan it again."); }
  }
  const ext = mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : "jpg";
  const path = `orgs/${link.org_id}/packages/${link.project_id}/${encodeURIComponent(key)}/returned-${randomUUID()}.${ext}`;
  await r2.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: path, Body: bytes, ContentType: mime }));

  const at = new Date().toISOString();
  const by = link.company_name;
  const signed = { path, pages, at, by, via: "link" as const, mime };
  const title = itemId === "add" ? (String(form.get("title") ?? "").trim().slice(0, 120) || "Added pages") : target!.title;
  let replaced: string | null = null;
  try {
    await updatePackageAdmin(link.org_id, link.project_id, key, (p) => {
      if (itemId === "add") return { ...p, items: [...p.items, { id: newItemId(), kind: "file", title, path, mime, pages, signed }] };
      return { ...p, items: p.items.map((i) => { if (i.id !== itemId) return i; replaced = i.signed?.path ?? null; return { ...i, signed }; }) };
    });
  } catch (e) {
    // Not recorded: don't leave the file behind.
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: path })).catch(() => undefined);
    return bad((e as Error).message || "Couldn't save it. Try again.", 500);
  }
  // The earlier scan of the same form: replaced, so deleted.
  if (replaced && replaced !== path) await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: replaced })).catch(() => undefined);

  await supabaseAdmin.rpc("bump_intake_use", { p_link: link.id }).then(() => undefined, () => undefined);
  const { data: project } = await supabaseAdmin.from("projects").select("name, owner_user_id").eq("id", link.project_id).maybeSingle();
  const { data: controllers } = await supabaseAdmin.from("org_members").select("uid").eq("org_id", link.org_id).eq("status", "active").in("role", ["Admin", "DocCtrl"]);
  const targets = [...new Set([...((controllers ?? []) as Array<{ uid: string }>).map((c) => c.uid), ...(project?.owner_user_id ? [String(project.owner_user_id)] : [])])];
  const woWords = pkg.wos.length ? `WO ${pkg.wos.join(", ")}` : pkg.equipment;
  if (targets.length) {
    await supabaseAdmin.from("notifications").insert(targets.map((uid) => ({
      org_id: link.org_id, user_id: uid, kind: "package_return",
      title: itemId === "add" ? `Pages added to ${woWords}: ${title}` : `Signed form back: ${title}, ${woWords}`,
      body: `${by} sent it for ${pkg.equipment} on ${String(project?.name ?? "the project")}. It's in the package in place of the blank.`,
      link: `/projects/${link.project_id}?tab=plan&package=${encodeURIComponent(key)}`,
      resource_type: "project", resource_id: link.project_id, actor_name: by,
      metadata: { packageKey: key, itemId },
    }))).then(() => undefined, () => undefined);
  }
  await supabaseAdmin.from("audit_logs").insert({
    action: "PACKAGE_RETURN", resource_type: "project", resource_id: link.project_id, org_id: link.org_id,
    user_id: null, user_email: null, details: { key, itemId, title, by, pages },
  }).then(() => undefined, () => undefined);

  return NextResponse.json({ ok: true, message: itemId === "add" ? `${title} added to the package.` : `${title} is in. It replaced the blank.` });
}
