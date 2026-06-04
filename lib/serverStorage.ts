// lib/serverStorage.ts
//
// Server-side object storage with an automatic fallback.
//
// Cloudflare R2 is used when it's fully configured (R2_* env vars). Otherwise
// we fall back to Supabase Storage — which every deployment already has (the
// service-role client) — so file upload/download/delete work OUT OF THE BOX
// with no extra infrastructure or bucket setup. The bucket is created on first
// use.
//
// Both backends hand the browser a cross-origin signed URL to PUT/GET directly
// (the service worker leaves cross-origin requests alone). Supabase Storage
// also allows browser PUTs to signed upload URLs without any CORS config —
// unlike R2, which needs a bucket CORS policy.

import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2, R2_BUCKET, r2Configured } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const SUPABASE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "attachments";

/** R2 when configured, otherwise Supabase Storage. */
export function activeBackend(): "r2" | "supabase" {
  return r2Configured() ? "r2" : "supabase";
}

/** Storage is available if R2 is configured OR the Supabase service role is
 *  present (which the whole app already requires) — so in practice it's always
 *  available, and uploads work without Cloudflare. */
export function storageAvailable(): boolean {
  return r2Configured() || !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

/** Normalize a Supabase signed URL to an absolute URL the browser can hit
 *  directly. supabase-js has returned both absolute and storage-relative forms
 *  across versions; this handles either. */
function absolutize(signed: string): string {
  if (/^https?:\/\//i.test(signed)) return signed;
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const path = signed.startsWith("/") ? signed : `/${signed}`;
  return path.startsWith("/storage/") ? `${base}${path}` : `${base}/storage/v1${path}`;
}

let bucketEnsured = false;
async function ensureSupabaseBucket(): Promise<void> {
  if (bucketEnsured) return;
  // Idempotent: createBucket errors if it already exists, which we ignore.
  const { error } = await supabaseAdmin.storage.createBucket(SUPABASE_BUCKET, { public: false });
  if (error && !/exist/i.test(error.message)) {
    throw new Error(`Could not create storage bucket "${SUPABASE_BUCKET}": ${error.message}`);
  }
  bucketEnsured = true;
}

/** A signed URL the browser PUTs the file to. */
export async function presignUpload(path: string, contentType?: string): Promise<string> {
  if (activeBackend() === "r2") {
    const cmd = new PutObjectCommand({ Bucket: R2_BUCKET, Key: path, ContentType: contentType || "application/octet-stream" });
    return getSignedUrl(r2, cmd, { expiresIn: 900 });
  }
  await ensureSupabaseBucket();
  const make = () => supabaseAdmin.storage.from(SUPABASE_BUCKET).createSignedUploadUrl(path);
  let { data, error } = await make();
  if (error && /not found|exist/i.test(error.message)) {
    // Bucket vanished/raced — recreate and retry once.
    bucketEnsured = false;
    await ensureSupabaseBucket();
    ({ data, error } = await make());
  }
  if (error || !data?.signedUrl) throw new Error(error?.message || "Could not create an upload URL.");
  return absolutize(data.signedUrl);
}

/** A signed URL valid for `expiresIn` seconds to GET/view the object. */
export async function presignDownload(path: string, expiresIn: number): Promise<string> {
  if (activeBackend() === "r2") {
    const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: path });
    return getSignedUrl(r2, cmd, { expiresIn });
  }
  const { data, error } = await supabaseAdmin.storage.from(SUPABASE_BUCKET).createSignedUrl(path, expiresIn);
  if (error || !data?.signedUrl) throw new Error(error?.message || "Could not create a download URL.");
  return absolutize(data.signedUrl);
}

export async function removeObject(path: string): Promise<void> {
  if (activeBackend() === "r2") {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: path }));
    return;
  }
  const { error } = await supabaseAdmin.storage.from(SUPABASE_BUCKET).remove([path]);
  if (error) throw new Error(error.message);
}
