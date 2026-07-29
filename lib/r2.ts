import { S3Client } from "@aws-sdk/client-s3";

// Server-side only — credentials never exposed to client
export const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  // AWS SDK ≥3.729 defaults to WHEN_SUPPORTED, which bakes a CRC32 checksum
  // of the EMPTY body into presigned PUT URLs (x-amz-checksum-crc32=AAAAAA==).
  // R2 then rejects the real upload with 400 BadDigest — every browser
  // presigned upload breaks. WHEN_REQUIRED keeps checksums off unless an
  // operation demands them.
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

export const R2_BUCKET = process.env.R2_BUCKET_NAME!;
