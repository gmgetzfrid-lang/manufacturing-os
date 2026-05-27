// lib/exportRunner.ts
//
// The engine that builds and delivers a full export. Handles three
// delivery modes off one shared build path:
//   1. inline-zip  — stream the ZIP back as a download response
//   2. s3-push     — upload the ZIP to a customer-owned S3/R2 bucket
//   3. webhook     — POST the ZIP body to a customer URL with HMAC signature
//
// The ZIP layout is intentionally portable:
//   /manifest.json
//   /README.md
//   /schema/schema.sql
//   /tables/<table>.json
//   /files/<storage-path>            (the actual binary, path preserved)
//
// Anyone who unzips it gets a self-describing, self-reconstructable
// archive with no proprietary tooling required.

import JSZip from "jszip";
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { runOrgExport, DataExportEnvelope } from "@/lib/dataExport";
import { decryptSecret, hmacSign } from "@/lib/serverCrypto";
import { promises as fs } from "node:fs";
import path from "node:path";

type DiagnosticStep = { ts: string; step: string; detail?: string };

export type ExportRunResult = {
  bytes: number;
  fileCount: number;
  tableCount: number;
  totalRows: number;
  destinationPath?: string;
  downloadUrl?: string;
  downloadUrlExpiresAt?: string;
  diagnostics: DiagnosticStep[];
};

type DeliveryMode =
  | { kind: "inline" }                              // return the ZIP bytes
  | { kind: "ourbucket"; bucket: string; prefix?: string }   // store in our R2/S3, return signed URL
  | { kind: "destination"; destination: ExportDestination };

export interface ExportDestination {
  id: string;
  org_id: string;
  destination_type: "s3" | "r2" | "webhook";
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  access_key_id_encrypted?: string;
  secret_access_key_encrypted?: string;
  webhook_url?: string;
  webhook_secret_encrypted?: string;
  include_files?: boolean;
  retention_days?: number;
}

export async function buildAndDeliverExport(params: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  exporterUserId: string;
  exporterEmail: string;
  includeFiles: boolean;
  delivery: DeliveryMode;
}): Promise<ExportRunResult & { zipBytes?: Uint8Array }> {
  const diagnostics: DiagnosticStep[] = [];
  const step = (s: string, d?: string) => diagnostics.push({ ts: new Date().toISOString(), step: s, detail: d });

  step("envelope:start");
  const envelope = await runOrgExport({
    supabaseUrl: params.supabaseUrl,
    serviceRoleKey: params.serviceRoleKey,
    orgId: params.orgId,
    exporterUserId: params.exporterUserId,
    exporterEmail: params.exporterEmail,
  });
  step("envelope:done", `${envelope.manifest.tables.length} tables, ${envelope.files.length} files`);

  step("zip:build");
  const zip = new JSZip();

  zip.file("manifest.json", JSON.stringify(envelope.manifest, null, 2));
  zip.file("README.md", buildReadme(envelope));

  // Schema DDL bundled inline so the archive is self-contained.
  try {
    const schemaSql = await readBundledFile("supabase/schema.sql");
    zip.folder("schema")?.file("schema.sql", schemaSql);
  } catch {
    zip.folder("schema")?.file("schema.sql", "-- (schema.sql could not be bundled at build time)");
  }

  // One table file per data type — small files unzip nicely
  const tableFolder = zip.folder("tables");
  for (const [name, rows] of Object.entries(envelope.tables)) {
    tableFolder?.file(`${name}.json`, JSON.stringify(rows, null, 2));
  }

  // Embed binary files inline. Each file's path mirrors its storage key.
  let fileBytes = 0;
  if (params.includeFiles && envelope.files.length > 0) {
    step("files:fetch", `${envelope.files.length} files`);
    const sb = createClient(params.supabaseUrl, params.serviceRoleKey, { auth: { persistSession: false } });
    const filesFolder = zip.folder("files");
    let i = 0;
    for (const f of envelope.files) {
      i++;
      if (!f.presignedUrl) continue;
      try {
        const res = await fetch(f.presignedUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        filesFolder?.file(f.path, buf);
        fileBytes += buf.byteLength;
      } catch (e) {
        step("files:miss", `${f.path}: ${(e as Error).message}`);
      }
    }
    step("files:done", `${formatBytes(fileBytes)} bundled`);
  } else {
    step("files:skipped", "include_files=false");
  }

  step("zip:compress");
  const zipBytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  step("zip:ready", formatBytes(zipBytes.byteLength));

  const totalRows = envelope.manifest.tables.reduce((s, t) => s + t.rowCount, 0);

  // Deliver
  switch (params.delivery.kind) {
    case "inline": {
      return {
        bytes: zipBytes.byteLength,
        fileCount: envelope.files.length,
        tableCount: envelope.manifest.tables.length,
        totalRows,
        diagnostics,
        zipBytes,
      };
    }
    case "ourbucket": {
      // Future: stash zips in our own bucket with a TTL signed URL. Not
      // wired in this push because we want customers' bytes off our infra
      // by default. The async-email-with-link flow plugs in here.
      throw new Error("ourbucket delivery not yet implemented");
    }
    case "destination": {
      const dest = params.delivery.destination;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const orgSlug = (envelope.manifest.orgName || dest.org_id).replace(/[^\w.\-]+/g, "_");
      const filename = `manufacturing-os-export-${orgSlug}-${stamp}.zip`;
      const fullKey = dest.prefix
        ? `${dest.prefix.replace(/^\/+|\/+$/g, "")}/${filename}`
        : filename;

      if (dest.destination_type === "s3" || dest.destination_type === "r2") {
        step("s3:push", `${dest.bucket}/${fullKey}`);
        await s3Put({
          dest,
          key: fullKey,
          body: zipBytes,
          contentType: "application/zip",
        });
        step("s3:done");

        // Enforce retention if configured
        if (dest.retention_days && dest.retention_days > 0) {
          step("s3:retention", `purge older than ${dest.retention_days}d`);
          await s3PurgeOlderThan({
            dest,
            prefix: dest.prefix || "",
            keepDays: dest.retention_days,
          }).catch((e) => step("s3:retention:err", (e as Error).message));
        }

        return {
          bytes: zipBytes.byteLength,
          fileCount: envelope.files.length,
          tableCount: envelope.manifest.tables.length,
          totalRows,
          destinationPath: `${dest.bucket}/${fullKey}`,
          diagnostics,
        };
      }

      if (dest.destination_type === "webhook") {
        step("webhook:push", dest.webhook_url || "");
        if (!dest.webhook_url) throw new Error("Webhook URL missing");
        const signingSecret = dest.webhook_secret_encrypted
          ? decryptSecret(dest.webhook_secret_encrypted)
          : "";
        const headers: Record<string, string> = {
          "Content-Type": "application/zip",
          "X-MOS-Export-Filename": filename,
          "X-MOS-Export-Org-Id": dest.org_id,
          "X-MOS-Export-Bytes": String(zipBytes.byteLength),
        };
        if (signingSecret) {
          headers["X-MOS-Signature"] = "sha256=" + hmacSign(signingSecret, filename);
        }
        // zipBytes is a Uint8Array; cast through unknown to BodyInit so
        // Next.js 16's stricter fetch typing accepts it.
        const res = await fetch(dest.webhook_url, {
          method: "POST",
          headers,
          body: zipBytes as unknown as BodyInit,
        });
        if (!res.ok) throw new Error(`Webhook ${res.status}: ${await res.text()}`);
        step("webhook:done");

        return {
          bytes: zipBytes.byteLength,
          fileCount: envelope.files.length,
          tableCount: envelope.manifest.tables.length,
          totalRows,
          destinationPath: dest.webhook_url,
          diagnostics,
        };
      }

      throw new Error(`Unsupported destination type: ${dest.destination_type}`);
    }
  }
}

// ─── S3 helpers ──────────────────────────────────────────────────

export function buildS3ClientFromDestination(dest: ExportDestination): S3Client {
  const accessKeyId = dest.access_key_id_encrypted ? decryptSecret(dest.access_key_id_encrypted) : "";
  const secretAccessKey = dest.secret_access_key_encrypted ? decryptSecret(dest.secret_access_key_encrypted) : "";
  if (!accessKeyId || !secretAccessKey) throw new Error("Destination credentials are missing");
  return new S3Client({
    endpoint: dest.endpoint || undefined,
    region: dest.region || "us-east-1",
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}

async function s3Put(params: {
  dest: ExportDestination;
  key: string;
  body: Uint8Array;
  contentType: string;
}): Promise<void> {
  const client = buildS3ClientFromDestination(params.dest);
  await client.send(new PutObjectCommand({
    Bucket: params.dest.bucket || "",
    Key: params.key,
    Body: params.body,
    ContentType: params.contentType,
  }));
}

async function s3PurgeOlderThan(params: {
  dest: ExportDestination;
  prefix: string;
  keepDays: number;
}): Promise<void> {
  const client = buildS3ClientFromDestination(params.dest);
  const cutoff = new Date(Date.now() - params.keepDays * 24 * 60 * 60 * 1000);
  let token: string | undefined;
  const toDelete: { Key: string }[] = [];
  do {
    const out = await client.send(new ListObjectsV2Command({
      Bucket: params.dest.bucket || "",
      Prefix: params.prefix ? params.prefix.replace(/^\/+|\/+$/g, "") + "/" : undefined,
      ContinuationToken: token,
    }));
    for (const obj of out.Contents ?? []) {
      if (obj.Key && obj.LastModified && obj.LastModified < cutoff) {
        toDelete.push({ Key: obj.Key });
      }
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);

  // S3 DeleteObjects supports max 1000 keys per call
  while (toDelete.length > 0) {
    const batch = toDelete.splice(0, 1000);
    await client.send(new DeleteObjectsCommand({
      Bucket: params.dest.bucket || "",
      Delete: { Objects: batch },
    }));
  }
}

// ─── Connection test ────────────────────────────────────────────

export async function testDestinationConnection(dest: ExportDestination): Promise<{ ok: boolean; error?: string }> {
  try {
    if (dest.destination_type === "s3" || dest.destination_type === "r2") {
      const client = buildS3ClientFromDestination(dest);
      const testKey = `${dest.prefix ? dest.prefix.replace(/^\/+|\/+$/g, "") + "/" : ""}__connection_test__${Date.now()}.txt`;
      const body = `manufacturing-os connection test ${new Date().toISOString()}`;
      await client.send(new PutObjectCommand({
        Bucket: dest.bucket || "",
        Key: testKey,
        Body: body,
        ContentType: "text/plain",
      }));
      // Clean up the test object so we don't leave litter behind
      await client.send(new DeleteObjectsCommand({
        Bucket: dest.bucket || "",
        Delete: { Objects: [{ Key: testKey }] },
      })).catch(() => {});
      return { ok: true };
    }
    if (dest.destination_type === "webhook") {
      if (!dest.webhook_url) return { ok: false, error: "webhook_url is required" };
      // Send a HEAD probe; customers can short-circuit and 200 it
      const r = await fetch(dest.webhook_url, { method: "HEAD" }).catch(() => null);
      if (!r) return { ok: false, error: "Webhook endpoint unreachable" };
      if (r.status >= 400 && r.status !== 405) {
        return { ok: false, error: `Webhook returned HTTP ${r.status}` };
      }
      return { ok: true };
    }
    return { ok: false, error: "Unsupported destination_type" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function buildReadme(envelope: DataExportEnvelope): string {
  const m = envelope.manifest;
  const totalRows = m.tables.reduce((s, t) => s + t.rowCount, 0);
  return `# manufacturing-os export

Organization: ${m.orgName || m.orgId}
Exported at: ${m.exportedAt}
Exported by: ${m.exportedBy.email}
Schema version: ${m.schemaVersion}

## Contents

- ${m.tables.length} tables, ${totalRows} total rows
- ${m.files.count} files, ${formatBytes(m.files.totalBytes)} of binary data

## Layout

- manifest.json        — full export metadata
- README.md            — this file
- schema/schema.sql    — the database DDL used to generate this export
- tables/<name>.json   — one file per table; JSON array of rows
- files/<storage-path> — every binary file, path-preserved

The schema DDL is the source of truth for what every column means.
`;
}

async function readBundledFile(relativePath: string): Promise<string> {
  const full = path.join(process.cwd(), relativePath);
  return await fs.readFile(full, "utf8");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ─── Schedule helpers ────────────────────────────────────────────

export function computeNextRunAt(opts: {
  schedule_kind: "manual" | "daily" | "weekly" | "monthly";
  schedule_hour_utc?: number | null;
  schedule_day_of_week?: number | null;
  schedule_day_of_month?: number | null;
  from?: Date;
}): string | null {
  if (opts.schedule_kind === "manual") return null;
  const hour = clamp(opts.schedule_hour_utc ?? 5, 0, 23);
  const base = opts.from ?? new Date();
  const next = new Date(Date.UTC(
    base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(),
    hour, 0, 0, 0
  ));
  if (next <= base) next.setUTCDate(next.getUTCDate() + 1);

  if (opts.schedule_kind === "daily") return next.toISOString();

  if (opts.schedule_kind === "weekly") {
    const targetDow = clamp(opts.schedule_day_of_week ?? 1, 0, 6);
    while (next.getUTCDay() !== targetDow) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next.toISOString();
  }

  if (opts.schedule_kind === "monthly") {
    const targetDom = clamp(opts.schedule_day_of_month ?? 1, 1, 28);
    next.setUTCDate(targetDom);
    if (next <= base) {
      next.setUTCMonth(next.getUTCMonth() + 1);
      next.setUTCDate(targetDom);
    }
    return next.toISOString();
  }

  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
