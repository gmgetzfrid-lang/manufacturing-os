import { S3Client } from "@aws-sdk/client-s3";

// Server-side only — credentials never exposed to client
export const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

export const R2_BUCKET = process.env.R2_BUCKET_NAME!;

/** True only when every R2 credential is present. Routes use this to fail with
 *  a clear message instead of handing back bogus presigned URLs (which surface
 *  to the user as opaque network errors on the upload/download). */
export function r2Configured(): boolean {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME
  );
}

export const R2_NOT_CONFIGURED =
  "File storage isn't configured on the server (missing R2 credentials). Ask an admin to set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME.";
