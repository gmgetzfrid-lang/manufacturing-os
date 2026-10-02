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
import { S3Client, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runOrgExport, recordExportUndelivered, DataExportEnvelope } from "@/lib/dataExport";
import { decryptSecret, hmacSign } from "@/lib/serverCrypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import { lookup } from "node:dns/promises";

type DiagnosticStep = { ts: string; step: string; detail?: string };

/** The cap on full exports people may start in one workspace in an hour,
 *  counted on export_runs: the manual run (download or destination) and the
 *  JSON export (`structured` — the download and the first step of the
 *  browser-built Full ZIP; it opens a run row of its own so it is counted,
 *  admin-and-org BKP-8 / DEC-44 (A&O P3) Risk). */
export const MAX_EXPORT_RUNS_PER_HOUR = 12;

/** The export_runs a person's cap counts: the runs people started
 *  (trigger_type "manual"; "api" is the schema's other person-started
 *  value), whatever their outcome — a failed attempt still ran the export —
 *  except a cancelled row. Never the scheduled pushes, nor a scheduled run
 *  the gate skipped (a cancelled row): the fifth review fix pass found five
 *  daily destinations at 05:00 plus their gate skips refusing an Admin's
 *  JSON export or Full ZIP (429), which no cap refused before this
 *  package. */
export const RATE_LIMITED_TRIGGERS = ["manual", "api"] as const;
export const RATE_LIMITED_STATUSES = ["pending", "running", "succeeded", "failed"] as const;

/** A person's export start, held to MAX_EXPORT_RUNS_PER_HOUR (the runs
 *  RATE_LIMITED_TRIGGERS and RATE_LIMITED_STATUSES name). The count is read
 *  CHECKED: a count that cannot be read refuses (503) — read as 0, it would
 *  let a tight loop past the cap. Null when the export may start. */
export async function exportRateLimitRefusal(
  admin: Pick<SupabaseClient, "from">,
  orgId: string,
): Promise<{ error: string; status: number } | null> {
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
  const { count, error } = await admin
    .from("export_runs")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .in("trigger_type", [...RATE_LIMITED_TRIGGERS])
    .in("status", [...RATE_LIMITED_STATUSES])
    .gte("started_at", oneHourAgo);
  if (error || typeof count !== "number") {
    return {
      error: `Could not check this workspace's export rate limit (${error?.message ?? "no count returned"}) — nothing was run. Try again shortly.`,
      status: 503,
    };
  }
  if (count >= MAX_EXPORT_RUNS_PER_HOUR) {
    return { error: `Export rate limit reached (${MAX_EXPORT_RUNS_PER_HOUR}/hour for this workspace). Try again shortly.`, status: 429 };
  }
  return null;
}

// ─── SSRF guard ──────────────────────────────────────────────────
// Export destinations (webhook URL, custom S3 endpoint) are admin-supplied
// and fetched server-side, so a destination pointed at an internal address
// (e.g. 169.254.169.254 cloud metadata, localhost, RFC1918) would let an
// admin probe or reach internal infrastructure. Reject any destination whose
// host is — or resolves to — a private/loopback/link-local address.
function isPrivateIp(ip: string): boolean {
  const v = ip.replace(/^\[|\]$/g, "");
  if (net.isIPv4(v)) {
    const [a, b] = v.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;            // link-local + cloud metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
    return false;
  }
  if (net.isIPv6(v)) {
    const low = v.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe80") || low.startsWith("fc") || low.startsWith("fd")) return true;
    if (low.startsWith("::ffff:")) return isPrivateIp(low.slice("::ffff:".length));
    return false;
  }
  return false;
}

export async function assertSafeExternalUrl(raw: string): Promise<void> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("Invalid destination URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`Blocked destination protocol: ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error("Blocked internal destination host");
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("Blocked private-range destination address");
    return;
  }
  // XEDGE-9: check EVERY address the name resolves to, not the first — a
  // multi-record host with one private A record would otherwise pass on the
  // luck of the resolver's ordering.
  const addresses = await lookup(host, { all: true });
  if (addresses.length === 0) throw new Error("Destination host does not resolve");
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(`Blocked destination host resolving to private address ${address}`);
    }
  }
}

/** XEDGE-9: the most hops a destination may redirect through. */
export const MAX_REDIRECT_HOPS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** fetch() for an admin-supplied destination URL. Redirects are NOT followed
 *  by the runtime: every Location is re-checked by assertSafeExternalUrl
 *  before the next request, the chain is bounded, and a redirect that would
 *  make the runtime drop a POST body (301/302/303 → GET) is refused rather
 *  than silently delivering nothing. Without this, a public host answering
 *  307 → http://169.254.169.254/… would receive the whole org ZIP with the
 *  guard never re-run (the runtime follows redirects and re-resolves DNS on
 *  its own). Residual: the CONNECTED address is still the runtime's own
 *  resolution of the checked host (no custom dispatcher without undici). */
export async function fetchExternalGuarded(url: string, init: RequestInit & { method: string }): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    await assertSafeExternalUrl(current);
    const res = await fetch(current, { ...init, redirect: "manual" });
    const location = res.headers.get("location");
    if (!REDIRECT_STATUSES.has(res.status) || !location) return res;
    if (hop >= MAX_REDIRECT_HOPS) {
      throw new Error(`Destination redirected more than ${MAX_REDIRECT_HOPS} times`);
    }
    if (init.method === "POST" && res.status !== 307 && res.status !== 308) {
      throw new Error(`Destination answered with an HTTP ${res.status} redirect, which would drop the export body — point the destination at its final URL`);
    }
    let next: string;
    try { next = new URL(location, current).toString(); } catch { throw new Error("Destination redirected to an invalid URL"); }
    // The redirect body is never read: release the socket before the next hop.
    await res.body?.cancel().catch(() => undefined);
    current = next;
  }
}

export type ExportRunResult = {
  bytes: number;
  fileCount: number;
  tableCount: number;
  totalRows: number;
  destinationPath?: string;
  downloadUrl?: string;
  downloadUrlExpiresAt?: string;
  diagnostics: DiagnosticStep[];
  /** BKP-6: what a bucket push's retention purge did — set whenever one ran
   *  (or was refused), so the route can put a failure on the run row. */
  retention?: RetentionOutcome;
};

/** BKP-6 Done-when 3: a retention purge's outcome. `failed` counts archives
 *  the purge chose but storage did not delete; `error` is why the purge
 *  stopped (a refusal, a listing or delete call that threw). */
export interface RetentionOutcome {
  keepDays: number;
  scanned: number;
  deleted: number;
  failed: number;
  error?: string;
}

/** The run row's line for a purge that did not do all it set out to — null
 *  when it did. The backup itself was delivered and verified either way. */
export function retentionProblem(r: RetentionOutcome | undefined): string | null {
  if (!r || (!r.error && r.failed === 0)) return null;
  const did = `deleted ${r.deleted} archive(s) older than ${r.keepDays} day(s)`;
  return `Backup delivered and verified, but the retention purge did not finish: ${did}` +
    (r.failed > 0 ? `, ${r.failed} could not be deleted` : "") +
    (r.error ? ` — ${r.error}` : "") + ".";
}

type DeliveryMode =
  | { kind: "inline" }                              // return the ZIP bytes
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

/** BKP-11 Done-when 3: what a destination lacks before it may fire, as the
 *  sentence a 409 carries, or null. An s3 / r2 destination needs both access
 *  keys (without them the push cannot authenticate at all). A webhook needs
 *  its signing secret when `requireWebhookSecret`: whenever the act would
 *  open or move a channel a person has not yet confirmed here — enabling a
 *  disabled destination, re-pointing an enabled one, or running a disabled
 *  one by hand (a restored row arrives disabled and with no secret, still
 *  naming the backup owner's URL). An enabled webhook an Admin created here
 *  may stay unsigned (the secret is optional at create). `have` says which
 *  credentials are stored or arrive with the request; `then` ends the
 *  sentence ("enable it again", "run it again", "save it again"). */
export function destinationCredentialGap(
  destinationType: string | null | undefined,
  have: { accessKey: boolean; secretKey: boolean; webhookSecret: boolean },
  opts: { requireWebhookSecret: boolean; then: string },
): string | null {
  const type = String(destinationType ?? "").trim();
  if (type === "webhook" && opts.requireWebhookSecret && !have.webhookSecret) {
    return `This webhook destination has no signing secret. Check its URL is yours, enter a signing secret, and ${opts.then} — a destination restored from a backup arrives without one.`;
  }
  if ((type === "s3" || type === "r2") && (!have.accessKey || !have.secretKey)) {
    return `This destination has no access key and secret. Enter them, and ${opts.then} — a destination restored from a backup arrives without credentials.`;
  }
  return null;
}

/** Held back from a ZIP route's `maxDuration` (app/api/data-export/run and
 *  run-scheduled: 300 s) for what follows the embed loop: compressing the
 *  ZIP, delivering it (the download, the bucket push and its read-back, the
 *  webhook) and closing the run row. */
export const EMBED_HEADROOM_MS = 90_000;

/** The instant (epoch ms) after which the server ZIP embeds no more files
 *  (and the export starts no more storage checks), for a route that started
 *  at `routeStart` with `maxDurationSeconds`. */
export function exportEmbedDeadline(routeStart: number, maxDurationSeconds: number): number {
  return routeStart + maxDurationSeconds * 1000 - EMBED_HEADROOM_MS;
}

/** files-omitted.json reasons the embed-cap path does not cover. */
const OMITTED_AT_DEADLINE = "not embedded: the export reached its time limit";
const OMITTED_SIZE_UNKNOWN = "not embedded: storage did not report its size, so it could not be held to the embed cap";

type BuildAndDeliverParams = {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  /** null for the scheduled push (no person) — DEC-44 (A&O P3). */
  exporterUserId: string | null;
  exporterEmail: string;
  /** Recorded on the DATA_EXPORT audit row (lib/dataExport.ts recordExport). */
  exporterRole?: string | null;
  auditDetails?: Record<string, unknown>;
  includeFiles: boolean;
  delivery: DeliveryMode;
  /** The route's own deadline (exportEmbedDeadline(routeStart, maxDuration)):
   *  past it no file is embedded and no storage check starts, so the archive
   *  is always built and delivered. Default: this call's start, as a 300 s
   *  route. */
  deadlineAt?: number;
};

/** Build the export and deliver it. DEC-44 (A&O P3) §3: once the export's
 *  DATA_EXPORT row is written the audit trail says it left, so a failure
 *  after that — its file list refused, the ZIP not built, the destination
 *  refusing the delivery (a webhook's 500, a failed bucket put) — writes a
 *  DATA_EXPORT_UNDELIVERED row against the export's record id
 *  (recordExportUndelivered) before the error goes back to the route, which
 *  marks the run failed. A refused UNDELIVERED row is named in that error
 *  (checked), so the run row says the record is incomplete. */
export async function buildAndDeliverExport(params: BuildAndDeliverParams): Promise<ExportRunResult & { zipBytes?: Uint8Array }> {
  const recordId = randomUUID();
  let recorded = false;
  try {
    return await buildAndDeliver(params, recordId, () => { recorded = true; });
  } catch (e) {
    if (!recorded) throw e;
    const err = e instanceof Error ? e : new Error(String(e));
    const unwritten = await recordExportUndelivered(
      createClient(params.supabaseUrl, params.serviceRoleKey, { auth: { persistSession: false } }),
      {
        orgId: params.orgId, recordId,
        destinationId: params.delivery.kind === "destination" ? params.delivery.destination.id : null,
        exporterUserId: params.exporterUserId, exporterEmail: params.exporterEmail, error: err.message,
      },
    ).catch((x) => (x as Error).message || String(x));
    if (unwritten) {
      err.message = `${err.message} — and the record that this export did not leave could not be written (${unwritten})`;
    }
    throw err;
  }
}

async function buildAndDeliver(
  params: BuildAndDeliverParams,
  recordId: string,
  onRecorded: () => void,
): Promise<ExportRunResult & { zipBytes?: Uint8Array }> {
  const diagnostics: DiagnosticStep[] = [];
  const step = (s: string, d?: string) => diagnostics.push({ ts: new Date().toISOString(), step: s, detail: d });
  const deadlineAt = params.deadlineAt ?? exportEmbedDeadline(Date.now(), 300);

  step("envelope:start");
  const envelope = await runOrgExport({
    supabaseUrl: params.supabaseUrl,
    serviceRoleKey: params.serviceRoleKey,
    orgId: params.orgId,
    exporterUserId: params.exporterUserId,
    exporterEmail: params.exporterEmail,
    exporterRole: params.exporterRole,
    auditDetails: params.auditDetails,
    // DEC-44 (A&O P3) §3: every file that leaves is named, against a ledger
    // (what was added or removed since its previous record): a ZIP handed to
    // a person against the workspace's, a push to a destination — a bucket
    // or a webhook, scheduled or Run Now — against that destination's. So no
    // export grows the audit trail (itself exported, and read whole by every
    // later export) by the whole list.
    fileRecord: params.delivery.kind === "destination"
      ? { destinationId: params.delivery.destination.id }
      : "workspace",
    recordId,
    onRecorded,
    deadlineAt,
  });
  step("envelope:done", `${envelope.manifest.tables.length} tables, ${envelope.files.length} files`);

  step("zip:build");
  const zip = new JSZip();

  zip.file("manifest.json", JSON.stringify(envelope.manifest, null, 2));

  // Schema DDL bundled inline so the archive is self-contained. The live
  // database is base schema + migrations, so BOTH are bundled — schema.sql
  // alone predates newer tables and cannot rebuild them.
  try {
    const schemaSql = await readBundledFile("supabase/schema.sql");
    zip.folder("schema")?.file("schema.sql", schemaSql);
  } catch {
    zip.folder("schema")?.file("schema.sql", "-- (schema.sql could not be bundled at build time)");
  }
  try {
    const migrationsDir = path.join(process.cwd(), "supabase", "migrations");
    const names = (await fs.readdir(migrationsDir)).filter((n) => n.endsWith(".sql")).sort();
    const migFolder = zip.folder("schema")?.folder("migrations");
    for (const n of names) {
      migFolder?.file(n, await fs.readFile(path.join(migrationsDir, n), "utf8"));
    }
    step("schema:migrations", `${names.length} bundled`);
  } catch (e) {
    zip.folder("schema")?.file("migrations/README.txt", "-- (migrations could not be bundled at build time)");
    step("schema:migrations:err", (e as Error).message);
  }

  // One table file per data type — small files unzip nicely
  const tableFolder = zip.folder("tables");
  for (const [name, rows] of Object.entries(envelope.tables)) {
    tableFolder?.file(`${name}.json`, JSON.stringify(rows, null, 2));
  }

  // Embed binary files inline. Each file's path mirrors its storage key, and
  // files-manifest.json records the SHA-256 of the exact bytes bundled so a
  // re-opened backup can be verified.
  //
  // MEMORY CEILING: the whole zip is built in RAM, so embedded bytes are
  // capped (env-tunable). Files beyond the cap are NOT silently dropped —
  // they're listed in files-omitted.json and flagged in the README, and every
  // omitted file remains individually downloadable via the JSON export's
  // presigned URLs.
  const MAX_EMBED_BYTES = Number(process.env.EXPORT_MAX_EMBED_BYTES || 1_500_000_000);
  let fileBytes = 0;
  const omitted: Array<{ path: string; size?: number | null; reason?: string }> = [];
  // Of `omitted`: the files left out at the deadline, and the size-unknown ones.
  const late = { atDeadline: 0, sizeUnknown: 0 };
  if (params.includeFiles && envelope.files.length > 0) {
    step("files:fetch", `${envelope.files.length} files`);
    const filesFolder = zip.folder("files");
    const fileManifest: Record<string, { sha256: string; size: number }> = {};
    for (const f of envelope.files) {
      if (!f.presignedUrl) continue;
      // The embed loop's ceiling: past the route's deadline every remaining
      // file is listed omitted, so the ZIP is still built and delivered.
      if (Date.now() >= deadlineAt) {
        omitted.push({ path: f.path, size: f.size ?? null, reason: OMITTED_AT_DEADLINE });
        late.atDeadline++;
        continue;
      }
      if (fileBytes >= MAX_EMBED_BYTES || (f.size != null && fileBytes + Number(f.size) > MAX_EMBED_BYTES)) {
        omitted.push({ path: f.path, size: f.size ?? null });
        continue;
      }
      try {
        // A download still running at the deadline is stopped there.
        const res = await fetch(f.presignedUrl, { signal: AbortSignal.timeout(Math.min(Math.max(1, deadlineAt - Date.now()), 2_147_483_647)) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (f.size == null) {
          // A file the export could not size-check (its URL, no size) is held
          // to the same cap by the length storage reports, BEFORE its body is
          // buffered; with no length it is not embedded at all.
          const header = res.headers.get("content-length");
          const length = header != null && /^\d+$/.test(header.trim()) ? Number(header) : null;
          if (length == null || fileBytes + length > MAX_EMBED_BYTES) {
            await res.body?.cancel().catch(() => undefined);
            if (length == null) {
              omitted.push({ path: f.path, size: null, reason: OMITTED_SIZE_UNKNOWN });
              late.sizeUnknown++;
            } else {
              omitted.push({ path: f.path, size: length });
            }
            continue;
          }
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        filesFolder?.file(f.path, buf);
        fileManifest[f.path] = { sha256: createHash("sha256").update(buf).digest("hex"), size: buf.byteLength };
        fileBytes += buf.byteLength;
      } catch (e) {
        if (Date.now() >= deadlineAt || (e as Error)?.name === "TimeoutError") {
          omitted.push({ path: f.path, size: f.size ?? null, reason: OMITTED_AT_DEADLINE });
          late.atDeadline++;
          continue;
        }
        step("files:miss", `${f.path}: ${(e as Error).message}`);
        omitted.push({ path: f.path, reason: (e as Error).message });
      }
    }
    zip.file("files-manifest.json", JSON.stringify(fileManifest, null, 2));
    if (omitted.length > 0) {
      const capReason = `Embedded binaries are capped at ${formatBytes(MAX_EMBED_BYTES)} per ZIP to protect the export runtime. `;
      zip.file("files-omitted.json", JSON.stringify({
        reason: (late.atDeadline > 0
          ? `This export stopped embedding binaries when it neared its time limit, so the archive is delivered rather than lost; ` +
            `${late.atDeadline} file(s) here say so in their reason. `
          : "") +
          capReason +
          (late.sizeUnknown > 0 ? `A file whose size storage did not report is not embedded, since it cannot be held to that cap (${late.sizeUnknown} here). ` : "") +
          "These files are NOT in this ZIP. Download them via the JSON export's presigned URLs, or shed old history first to shrink the set.",
        files: omitted,
      }, null, 2));
      step("files:omitted", late.atDeadline + late.sizeUnknown === 0
        ? `${omitted.length} over the ${formatBytes(MAX_EMBED_BYTES)} cap`
        : `${omitted.length} omitted: ${late.atDeadline} at the time limit, ${late.sizeUnknown} of unknown size, the rest over the ${formatBytes(MAX_EMBED_BYTES)} cap or not downloaded`);
    }
    step("files:done", `${formatBytes(fileBytes)} bundled`);
  } else {
    step("files:skipped", "include_files=false");
  }

  // README last — it names any omitted-file shortfall from the loop above.
  zip.file("README.md", buildReadme(envelope, omitted.length, late));

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
    case "destination": {
      const dest = params.delivery.destination;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const orgSlug = (envelope.manifest.orgName || dest.org_id).replace(/[^\w.\-]+/g, "_");
      const filename = `manufacturing-os-export-${orgSlug}-${stamp}.zip`;
      const fullKey = dest.prefix
        ? `${dest.prefix.replace(/^\/+|\/+$/g, "")}/${filename}`
        : filename;

      if (dest.destination_type === "s3" || dest.destination_type === "r2") {
        if (dest.endpoint) await assertSafeExternalUrl(dest.endpoint);
        step("s3:push", `${dest.bucket}/${fullKey}`);
        await s3Put({
          dest,
          key: fullKey,
          body: zipBytes,
          contentType: "application/zip",
        });
        step("s3:done");

        // Enforce retention if configured. The purge's outcome — including a
        // refusal (no prefix) — lands in diagnostics, so a purge that did
        // nothing is visible, never a silent "succeeded" (XEDGE-4), and is
        // returned (BKP-6) so the route puts a failure on the run row and
        // the destination card, where the admin looks.
        let retention: RetentionOutcome | undefined;
        if (dest.retention_days && dest.retention_days > 0) {
          step("s3:retention", `purge older than ${dest.retention_days}d`);
          try {
            const purge = await s3PurgeOlderThan({
              dest,
              prefix: dest.prefix || "",
              keepDays: dest.retention_days,
            });
            retention = { keepDays: dest.retention_days, scanned: purge.scanned, deleted: purge.deleted, failed: purge.failed, ...(purge.error ? { error: purge.error } : {}) };
            step(
              purge.failed > 0 || purge.error ? "s3:retention:err" : "s3:retention:done",
              `scanned ${purge.scanned}, deleted ${purge.deleted} app archive(s)` +
                (purge.failed > 0 ? `, ${purge.failed} could not be deleted` : "") +
                (purge.error ? ` — ${purge.error}` : ""),
            );
          } catch (e) {
            retention = { keepDays: dest.retention_days, scanned: 0, deleted: 0, failed: 0, error: (e as Error).message };
            step("s3:retention:err", (e as Error).message);
          }
        }

        return {
          bytes: zipBytes.byteLength,
          fileCount: envelope.files.length,
          tableCount: envelope.manifest.tables.length,
          totalRows,
          destinationPath: `${dest.bucket}/${fullKey}`,
          diagnostics,
          ...(retention ? { retention } : {}),
        };
      }

      if (dest.destination_type === "webhook") {
        step("webhook:push", dest.webhook_url || "");
        if (!dest.webhook_url) throw new Error("Webhook URL missing");
        await assertSafeExternalUrl(dest.webhook_url);
        const signingSecret = dest.webhook_secret_encrypted
          ? decryptSecret(dest.webhook_secret_encrypted)
          : "";
        // Integrity over the PAYLOAD, not the filename. The old signature
        // covered only `filename`, so a MITM (or a compromised relay) could
        // swap the ZIP body and still verify, and any past delivery could be
        // replayed byte-for-byte. Sign `<timestamp>.<sha256(zip)>`: the
        // receiver recomputes sha256 of the body, rebuilds the string with
        // the X-MOS-Timestamp header, HMACs it with the shared secret, and
        // rejects a stale timestamp to kill replays. The content hash is
        // published in its own header so the receiver can also check
        // at-rest integrity without recomputing the HMAC.
        const bodyHash = createHash("sha256").update(zipBytes).digest("hex");
        const timestamp = new Date().toISOString();
        const headers: Record<string, string> = {
          "Content-Type": "application/zip",
          "X-MOS-Export-Filename": filename,
          "X-MOS-Export-Org-Id": dest.org_id,
          "X-MOS-Export-Bytes": String(zipBytes.byteLength),
          "X-MOS-Content-SHA256": bodyHash,
          "X-MOS-Timestamp": timestamp,
        };
        if (signingSecret) {
          headers["X-MOS-Signature"] = "sha256=" + hmacSign(signingSecret, `${timestamp}.${bodyHash}`);
        }
        // zipBytes is a Uint8Array; cast through unknown to BodyInit so
        // Next.js 16's stricter fetch typing accepts it. XEDGE-9: guarded
        // redirects — every hop is re-checked before the body goes anywhere.
        const res = await fetchExternalGuarded(dest.webhook_url, {
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
  // READ-BACK VERIFY: a backup that isn't checked after writing isn't a
  // backup. HEAD the object and require the stored size to match what we
  // sent — a truncated or zero-byte upload must fail the run, not record
  // "succeeded" with a plausible byte count.
  const head = await client.send(new HeadObjectCommand({
    Bucket: params.dest.bucket || "",
    Key: params.key,
  }));
  const storedSize = Number(head.ContentLength ?? -1);
  if (storedSize !== params.body.byteLength) {
    throw new Error(
      `Backup verification failed: wrote ${params.body.byteLength} bytes to ${params.key} but the destination reports ${storedSize}. The run is marked failed — do NOT trust this backup.`,
    );
  }
}

/** Matches only the archives THIS APP writes (see the filename built in
 *  deliverExport): retention must never touch anything else living in the
 *  customer's bucket. */
export const EXPORT_ARCHIVE_RE = /(^|\/)manufacturing-os-export-[\w.\-]+\.zip$/;

export async function s3PurgeOlderThan(params: {
  dest: ExportDestination;
  prefix: string;
  keepDays: number;
}): Promise<{ deleted: number; scanned: number; failed: number; error?: string }> {
  // XEDGE-4: with no prefix, ListObjectsV2 enumerates the WHOLE bucket and an
  // age-only test would delete the customer's own unrelated objects — a
  // shared corporate bucket's entire history, permanently, while the run
  // records "succeeded". Retention without a prefix is refused outright, and
  // the age test alone is never sufficient: only keys matching the archive
  // name pattern this app writes are ever deletion candidates.
  const prefix = params.prefix.replace(/^\/+|\/+$/g, "");
  if (!prefix) {
    throw new Error(
      "Retention purge refused: this destination has no prefix, so the purge would scan the whole bucket. Set a prefix on the destination to enable retention.",
    );
  }
  const client = buildS3ClientFromDestination(params.dest);
  const cutoff = new Date(Date.now() - params.keepDays * 24 * 60 * 60 * 1000);
  let token: string | undefined;
  let scanned = 0;
  const toDelete: { Key: string }[] = [];
  do {
    const out = await client.send(new ListObjectsV2Command({
      Bucket: params.dest.bucket || "",
      Prefix: prefix + "/",
      ContinuationToken: token,
    }));
    for (const obj of out.Contents ?? []) {
      scanned += 1;
      if (obj.Key && obj.LastModified && obj.LastModified < cutoff
          && EXPORT_ARCHIVE_RE.test(obj.Key)) {
        toDelete.push({ Key: obj.Key });
      }
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);

  // S3 DeleteObjects supports max 1000 keys per call. BKP-6: what was
  // DELETED is counted from each call's answer — a key storage reports in
  // `Errors` was not deleted — and a call that throws stops the purge with
  // the rest counted as not deleted, never as deleted.
  let deleted = 0;
  let failed = 0;
  let error: string | undefined;
  while (toDelete.length > 0) {
    const batch = toDelete.splice(0, 1000);
    try {
      const out = await client.send(new DeleteObjectsCommand({
        Bucket: params.dest.bucket || "",
        Delete: { Objects: batch },
      }));
      const errs = (out as { Errors?: Array<{ Key?: string; Message?: string }> } | undefined)?.Errors ?? [];
      failed += errs.length;
      deleted += batch.length - errs.length;
      if (errs.length > 0 && !error) error = `storage refused ${errs[0].Key ?? "a key"}: ${errs[0].Message ?? "unknown error"}`;
    } catch (e) {
      failed += batch.length + toDelete.length;
      error = (e as Error).message;
      break;
    }
  }
  return { deleted, scanned, failed, ...(error ? { error } : {}) };
}

// ─── Connection test ────────────────────────────────────────────

export async function testDestinationConnection(dest: ExportDestination): Promise<{ ok: boolean; error?: string }> {
  try {
    if (dest.destination_type === "s3" || dest.destination_type === "r2") {
      if (dest.endpoint) await assertSafeExternalUrl(dest.endpoint);
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
      await assertSafeExternalUrl(dest.webhook_url);
      // Send a HEAD probe; customers can short-circuit and 200 it. XEDGE-9:
      // redirects are re-checked per hop, and the verdict is a boolean — the
      // upstream status code is never echoed, so the probe cannot be used as
      // a liveness / port oracle for whatever a redirect points at.
      let r: Response;
      try {
        r = await fetchExternalGuarded(dest.webhook_url, { method: "HEAD" });
      } catch (e) {
        const msg = (e as Error).message;
        return { ok: false, error: /^(Blocked|Destination)/.test(msg) ? msg : "Webhook endpoint unreachable" };
      }
      if (r.status >= 400 && r.status !== 405) {
        return { ok: false, error: "Webhook endpoint did not accept the probe (it must answer HEAD with a 2xx/3xx or 405)" };
      }
      return { ok: true };
    }
    return { ok: false, error: "Unsupported destination_type" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function buildReadme(envelope: DataExportEnvelope, omittedCount = 0, late = { atDeadline: 0, sizeUnknown: 0 }): string {
  const m = envelope.manifest;
  const totalRows = m.tables.reduce((s, t) => s + t.rowCount, 0);
  const omittedNote = omittedCount === 0
    ? ""
    : late.atDeadline + late.sizeUnknown === 0
      ? `\n## ⚠ Omitted binaries\n\n${omittedCount} file(s) exceeded this ZIP's embedded-bytes cap and are NOT inside — see files-omitted.json for the list and how to fetch them.\n`
      : `\n## ⚠ Omitted binaries\n\n${omittedCount} file(s) are NOT inside this ZIP — see files-omitted.json for the list, the reason for each, and how to fetch them.` +
        (late.atDeadline > 0
          ? ` ${late.atDeadline} were left out because the export reached its time limit while embedding (the archive is delivered rather than lost).`
          : "") +
        (late.sizeUnknown > 0 ? ` ${late.sizeUnknown} were left out because storage did not report their size.` : "") +
        "\n";
  const shedNote = (m.spaceArchives?.length ?? 0) > 0
    ? `\n## Offline space archives\n\n${m.files.archivedOffline ?? 0} file(s) were archived offline before this export to reclaim cloud storage.\nTheir records are in tables/, but their binaries live ONLY in these space archive zip(s):\n${(m.spaceArchives ?? []).map((id) => `- <archive root>/data/${id}.zip`).join("\n")}\nKeep those zips with this backup for full binary coverage.\n`
    : "";
  // EGR-7 / XEDGE-10: say which columns are NOT in this archive and why, so
  // a restore knows the links must be re-issued rather than arriving dead.
  const redacted = Object.entries(m.redactedColumns ?? {});
  const redactedNote = redacted.length > 0
    ? `\n## Redacted credential columns\n\nSecrets never leave the database. These columns are exported as null:\n${redacted.map(([t, cols]) => `- ${t}: ${cols.join(", ")}`).join("\n")}\nAfter a restore, share links and vendor intake links must be RE-ISSUED (restored rows arrive revoked), a restored transmittal has no portal link (an issued one arrives VOIDED on the register; issue a new transmittal to send again), and export destinations must have their credentials re-entered (restored rows arrive disabled).\n`
    : "";
  return `# manufacturing-os export

Organization: ${m.orgName || m.orgId}
Exported at: ${m.exportedAt}
Exported by: ${m.exportedBy.email}
Schema version: ${m.schemaVersion}

## Contents

- ${m.tables.length} tables, ${totalRows} total rows
- ${m.files.count} files, ${formatBytes(m.files.totalBytes)} of binary data

## Layout

- manifest.json             — full export metadata
- README.md                 — this file
- schema/schema.sql         — base database DDL
- schema/migrations/*.sql   — every schema migration, in order (base + migrations = the exact live schema)
- tables/<name>.json        — one file per table; JSON array of rows
- files/<storage-path>      — every binary file, path-preserved
${omittedNote}${shedNote}${redactedNote}
To rebuild elsewhere: apply schema.sql, then each migration in filename order,
then import tables/*.json (parents before children), then upload files/* to
your storage under the same keys.
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
    // Allow any day 1..31 and clamp to the actual last day of the target
    // month, so a month-end schedule (29/30/31) fires on the real month-end
    // instead of silently collapsing to the 28th.
    const targetDom = clamp(opts.schedule_day_of_month ?? 1, 1, 31);
    const clampToMonth = (d: Date) => {
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(targetDom, lastDay));
    };
    clampToMonth(next);
    if (next <= base) {
      next.setUTCDate(1);
      next.setUTCMonth(next.getUTCMonth() + 1);
      clampToMonth(next);
    }
    return next.toISOString();
  }

  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
