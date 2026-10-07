// lib/untrustedContent.ts — projects-tab GAP-401 (owed item 2, package J16):
// the origin a contractor's upload is served from.
//
// Everything the external door stores — a drawing or redline under
// orgs/<org>/project-intake/<project>/, a quote under
// orgs/<org>/project-costs/<project>/quote-… — came from outside the org.
// The door already admits only sniffed PDF / DWG / DXF / ZIP (+ PNG / JPEG for
// a redline; SEC-6, DEC-56 item 4) and every presigned GET is an attachment
// unless a viewer asks and the type cannot be a page (DEC-49). This module is
// the next layer: when UNTRUSTED_CONTENT_ORIGIN is set, a presigned GET of a
// door upload is signed for THAT origin instead of the one every controlled
// document is served from — so even a file that somehow got past the sniff
// and the disposition could run nowhere near the app's cookies or script, nor
// on the origin the org's controlled drawings are fetched from.
//
// What the setting is. Storage serves a bucket at two signed addresses:
//   https://<bucket>.<account>.r2.cloudflarestorage.com/<key>   (how lib/r2.ts
//                                                                signs today)
//   https://<account>.r2.cloudflarestorage.com/<bucket>/<key>   (path style)
// Both are storage's own hosts (no app cookie, no app page, no app script),
// but they are DIFFERENT origins. UNTRUSTED_CONTENT_ORIGIN names the second —
// an S3-compatible endpoint that answers SIGNED requests for the same bucket
// with the same credentials — and door uploads are signed path-style against
// it. A custom domain cannot be used: storage refuses presigned requests on
// one (and a public custom domain would serve the files to anyone). The
// operator step is docs/UNTRUSTED_CONTENT_ORIGIN.md.
//
// Refused settings (the app then signs exactly as before and logs why, once
// per runtime): not https; carries a path, query, credentials or a port; the
// app's own host or a host under it (cookies set for the app's domain could
// reach it); the host lib/r2.ts already serves the bucket from (no
// separation).
//
// Who calls it. A presigned-GET issuer replaces
//   getSignedUrl(r2, command, { expiresIn })
// with
//   signStorageGet(command, { expiresIn })
// — app/api/storage/download-url/route.ts and app/api/storage/resolve/route.ts
// are the issuers a person's browser receives a door upload's URL from. Both
// are owned by another package in this wave (admin-and-org P6), so J16 did
// not edit them: their adoption is handed over on GAP-401 (until then the
// setting changes nothing).

import { S3Client, type GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2 } from "@/lib/r2";
import { configuredPublicOrigin } from "@/lib/publicOrigin";

/** The environment variable the operator sets. */
export const UNTRUSTED_CONTENT_ORIGIN_ENV = "UNTRUSTED_CONTENT_ORIGIN";

/** A key the contractor door wrote: a drawing or redline under the project's
 *  intake prefix, or a quote the door filed (`quote-` — a quote a member
 *  uploads on the Costs tab is `<uuid>-<name>` under the same folder and is
 *  not a door upload). The staging root is never served. */
export function isDoorUploadKey(key: string): boolean {
  return /^orgs\/[^/]+\/project-intake\/[^/]+\/.+/.test(key)
    || /^orgs\/[^/]+\/project-costs\/[^/]+\/quote-[^/]+$/.test(key);
}

/** The host lib/r2.ts serves the bucket from (virtual-hosted style), or null
 *  when the storage settings are not there to say. */
function bucketHost(env: Record<string, string | undefined>): string | null {
  const account = (env.R2_ACCOUNT_ID ?? "").trim().toLowerCase();
  const bucket = (env.R2_BUCKET_NAME ?? "").trim().toLowerCase();
  return account && bucket ? `${bucket}.${account}.r2.cloudflarestorage.com` : null;
}

export type UntrustedOriginSetting =
  | { origin: string }
  | { origin: null; problem: string | null };

/** The configured untrusted origin, validated — or null with the reason it
 *  was refused (`problem` null: simply not set). */
export function untrustedContentOrigin(env: Record<string, string | undefined> = process.env): UntrustedOriginSetting {
  const raw = (env[UNTRUSTED_CONTENT_ORIGIN_ENV] ?? "").trim();
  if (!raw) return { origin: null, problem: null };
  let u: URL;
  try { u = new URL(raw); } catch { return { origin: null, problem: `${UNTRUSTED_CONTENT_ORIGIN_ENV} is not an address` }; }
  if (u.protocol !== "https:") return { origin: null, problem: `${UNTRUSTED_CONTENT_ORIGIN_ENV} must start with https://` };
  if (u.username || u.password || u.port || u.search || u.hash || (u.pathname && u.pathname !== "/")) {
    return { origin: null, problem: `${UNTRUSTED_CONTENT_ORIGIN_ENV} must be an origin only — https://host, nothing after it` };
  }
  const host = u.hostname.toLowerCase();
  const appOrigin = (env.NEXT_PUBLIC_SITE_URL ?? "").trim() || configuredPublicOrigin();
  if (appOrigin) {
    try {
      const appHost = new URL(appOrigin).hostname.toLowerCase();
      if (host === appHost || host.endsWith(`.${appHost}`) || appHost.endsWith(`.${host}`)) {
        return { origin: null, problem: `${UNTRUSTED_CONTENT_ORIGIN_ENV} must not be the app's own address or one under it` };
      }
    } catch { /* an unparseable app origin is lib/publicOrigin's to report */ }
  }
  const served = bucketHost(env);
  if (served && host === served) {
    return { origin: null, problem: `${UNTRUSTED_CONTENT_ORIGIN_ENV} names the address controlled documents are already served from — use https://<account>.r2.cloudflarestorage.com` };
  }
  return { origin: `https://${host}` };
}

let warned = false;
let client: { origin: string; s3: S3Client } | null = null;

/** The signer for the untrusted origin: the same credentials, path style. */
function untrustedClient(origin: string): S3Client {
  if (client?.origin === origin) return client.s3;
  const s3 = new S3Client({
    region: "auto",
    endpoint: origin,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    // As lib/r2.ts: no checksum baked into a presigned URL.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  client = { origin, s3 };
  return s3;
}

/** Sign a presigned GET. A door upload is signed for UNTRUSTED_CONTENT_ORIGIN
 *  when one is set and valid; every other key — and a door upload when none
 *  is set — exactly as before (lib/r2.ts). The command carries its
 *  disposition overrides (lib/presignedDisposition.ts, DEC-49) either way. */
export async function signStorageGet(command: GetObjectCommand, opts: { expiresIn: number }): Promise<string> {
  const key = String(command.input.Key ?? "");
  if (isDoorUploadKey(key)) {
    const setting = untrustedContentOrigin();
    if (setting.origin !== null) return getSignedUrl(untrustedClient(setting.origin), command, opts);
    if (setting.problem && !warned) {
      warned = true;
      console.error(`[untrustedContent] ${setting.problem}; door uploads are served from the usual storage address until it is fixed.`);
    }
  }
  return getSignedUrl(r2, command, opts);
}
