// lib/r2Bytes.ts — SERVER-ONLY. Pull a stored object out of R2 as bytes.
// Shared by every server path that needs the raw file (template rendering,
// spreadsheet parsing, PDF ingestion) so the streaming dance lives once.

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";

export async function fetchBytes(fileKey: string): Promise<Buffer> {
  const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: fileKey }));
  return Buffer.from(await new Response(obj.Body as ReadableStream).arrayBuffer());
}
