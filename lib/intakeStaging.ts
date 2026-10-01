// lib/intakeStaging.ts — SERVER-ONLY. The intake door's direct-upload
// staging (projects-and-cost INTK-15, projects Round G J11).
//
// The portal PUTs a contractor's bytes straight to storage on a URL the door
// presigned at `?step=begin`, and `?step=finalize` files them. Between the
// two the bytes sit in a STAGING object, and this module keeps that object
// accountable:
//
//   * ONE top-level prefix — intake-staging/<org>/<project>/<link>/<uuid> —
//     never inside an org's own tree, so nothing else (the orphan scan, the
//     org's storage figure) mistakes it for a filed upload, and one sweep (or
//     an R2 lifecycle rule on the prefix) reaches every staged object.
//   * a begin RESERVES its declared size against the link's lifetime storage
//     budget (INTK-8): an `intake_attempts` row (20261105) with outcome
//     'staged', the link, the bytes, and the staged object's UUID as its id.
//     The begin counts reserved bytes with bytes_received, so a link cannot
//     stage past its budget by never finalizing.
//   * a finalize — or the multipart fallback carrying its begin's key —
//     CLAIMS the reservation with one DELETE … RETURNING bound to the
//     presenting token's hash: exactly one request ever owns a staged object
//     (a second, concurrent finalize is refused before it reads a byte), and
//     the claim releases the reservation (bytes_received counts what is
//     filed). The owner deletes the object when it ends, whatever it answered.
//   * nothing is left behind: a begin first sweeps its own link's expired
//     reservations (the object, then the row — a row whose object could not
//     be removed keeps counting), and the maintenance cron sweeps the whole
//     prefix (every object older than STAGING_TTL_MS, then the reservations
//     as old).

import { ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { ATTEMPT_OUTCOME } from "@/lib/intakeRateLimit";

/** Every staged object lives under this prefix, and nothing else does. */
export const STAGING_ROOT = "intake-staging/";

/** How long a staged upload may wait for its finalize. The presigned PUT is
 *  valid for 10 minutes from the begin (a slow 100 MB PUT that started in
 *  time can run past that); after this a reservation is expired — its
 *  finalize is refused — and its object is swept. */
export const STAGING_TTL_MS = 2 * 3600 * 1000;

const STAGED_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Any client with `.from()` (the route's and the cron's service-role client). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StagingClient = { from: (table: string) => any };

/** The link's own staging prefix — a finalize names nothing outside it. */
export function stagingPrefix(orgId: string, projectId: string, linkId: string): string {
  return `${STAGING_ROOT}${orgId}/${projectId}/${linkId}/`;
}

/** The staged UUID of `key` when it is exactly `<prefix><uuid>`, else null. */
export function stagedIdUnder(key: string, prefix: string): string | null {
  if (!key.startsWith(prefix)) return null;
  const id = key.slice(prefix.length);
  return STAGED_ID_RE.test(id) ? id : null;
}

/** The staged UUID a multipart fallback names in its begun header, or null.
 *  Only the UUID is used: the claim binds it to the presenting token, and the
 *  route rebuilds the key from the link. */
export function begunIdOf(header: string | null): string | null {
  if (!header || header.length > 512 || !header.startsWith(STAGING_ROOT)) return null;
  const id = header.slice(header.lastIndexOf("/") + 1);
  return STAGED_ID_RE.test(id) ? id : null;
}

/** Begin: reserve `bytes` for the staged object `id`. Checked — a begin whose
 *  reservation did not land hands out no upload URL. */
export async function reserveStaged(client: StagingClient, input: {
  id: string; tokenHash: string; ip: string; linkId: string; bytes: number;
}): Promise<boolean> {
  try {
    const { error } = await client.from("intake_attempts").insert({
      id: input.id, token_hash: input.tokenHash, ip: input.ip, link_id: input.linkId,
      outcome: ATTEMPT_OUTCOME.staged, bytes: input.bytes,
    });
    if (error) console.error(`[intakeStaging] reservation for ${input.id} failed: ${error.message}`);
    return !error;
  } catch (e) {
    console.error(`[intakeStaging] reservation for ${input.id} threw: ${(e as Error).message}`);
    return false;
  }
}

export type StagedClaim = { claimed: boolean } | { error: string };

/** Finalize (or the multipart fallback): claim the reservation of staged
 *  object `id` for the presenting token — one DELETE … RETURNING, so of any
 *  number of concurrent requests exactly one gets the row. An expired
 *  reservation is not claimable (the sweep owns it). */
export async function claimStaged(client: StagingClient, input: { id: string; tokenHash: string; now?: number }): Promise<StagedClaim> {
  try {
    const since = new Date((input.now ?? Date.now()) - STAGING_TTL_MS).toISOString();
    const { data, error } = await client.from("intake_attempts").delete()
      .eq("id", input.id).eq("token_hash", input.tokenHash).eq("outcome", ATTEMPT_OUTCOME.staged)
      .gte("created_at", since)
      .select("id");
    if (error) return { error: error.message };
    return { claimed: ((data as unknown[] | null)?.length ?? 0) > 0 };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Begin: the bytes this link has staged and not yet had claimed. Expired
 *  reservations are swept first — the object through `removeObject`, then
 *  the row — so an abandoned begin stops counting once its object is gone;
 *  one whose object could not be removed keeps counting. An unreadable
 *  reservation set is an error (the caller refuses the direct door; the
 *  multipart door still counts the bytes it receives). */
export async function sweepAndReserved(client: StagingClient, input: {
  linkId: string; prefix: string; removeObject: (key: string) => Promise<boolean>; now?: number;
}): Promise<{ reservedBytes: number; swept: number } | { error: string }> {
  try {
    const { data, error } = await client.from("intake_attempts").select("id, bytes, created_at")
      .eq("link_id", input.linkId).eq("outcome", ATTEMPT_OUTCOME.staged)
      .limit(1000);
    if (error) return { error: error.message };
    const cutoff = (input.now ?? Date.now()) - STAGING_TTL_MS;
    let reservedBytes = 0;
    let swept = 0;
    for (const r of (data ?? []) as Array<{ id: string; bytes: number | string | null; created_at: string | null }>) {
      const bytes = Math.max(0, Number(r.bytes ?? 0)) || 0;
      const at = Date.parse(String(r.created_at ?? ""));
      if (!Number.isFinite(at) || at >= cutoff || !STAGED_ID_RE.test(String(r.id))) { reservedBytes += bytes; continue; }
      const gone = await input.removeObject(`${input.prefix}${r.id}`);
      const { error: rowErr } = gone
        ? await client.from("intake_attempts").delete().eq("id", r.id).eq("outcome", ATTEMPT_OUTCOME.staged)
        : { error: { message: "object not removed" } };
      if (rowErr) reservedBytes += bytes; else swept++;
    }
    return { reservedBytes, swept };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export interface StagingSweep {
  objectsDeleted: number;
  bytesFreed: number;
  reservationsExpired: number;
  /** The listing hit its page cap — the next run continues. */
  truncated: boolean;
  errors: string[];
}

/** The maintenance cron's step: every object under STAGING_ROOT older than
 *  STAGING_TTL_MS is deleted (an abandoned begin, a refused finalize whose
 *  own delete failed, a PUT that landed after its begin expired), then the
 *  reservations as old — only when every object delete succeeded, so a
 *  reservation never stops counting while its object might remain. Never
 *  throws: a failure is a line in `errors`. */
export async function sweepIntakeStaging(client: StagingClient, input: { now?: number; maxPages?: number } = {}): Promise<StagingSweep> {
  const out: StagingSweep = { objectsDeleted: 0, bytesFreed: 0, reservationsExpired: 0, truncated: false, errors: [] };
  const cutoff = (input.now ?? Date.now()) - STAGING_TTL_MS;
  const stale: Array<{ key: string; size: number }> = [];
  try {
    let token: string | undefined;
    let pages = 0;
    do {
      const res = await r2.send(new ListObjectsV2Command({
        Bucket: R2_BUCKET, Prefix: STAGING_ROOT, ContinuationToken: token, MaxKeys: 1000,
      }));
      for (const obj of res.Contents ?? []) {
        const key = obj.Key ?? "";
        if (!key.startsWith(STAGING_ROOT)) continue;   // belt and braces: never outside the prefix
        const at = obj.LastModified?.getTime();
        if (at == null || at >= cutoff) continue;
        stale.push({ key, size: obj.Size ?? 0 });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
      pages++;
    } while (token && pages < (input.maxPages ?? 50));
    out.truncated = !!token;
  } catch (e) {
    out.errors.push(`staging list failed: ${(e as Error).message}`);
    return out;
  }
  for (let i = 0; i < stale.length; i += 500) {
    const batch = stale.slice(i, i + 500);
    try {
      const res = await r2.send(new DeleteObjectsCommand({
        Bucket: R2_BUCKET, Delete: { Objects: batch.map((o) => ({ Key: o.key })), Quiet: true },
      }));
      const failed = new Set((res.Errors ?? []).map((e) => e.Key ?? ""));
      for (const e of res.Errors ?? []) out.errors.push(`staged object ${e.Key ?? "?"} not deleted: ${e.Message ?? "error"}`);
      for (const o of batch) if (!failed.has(o.key)) { out.objectsDeleted++; out.bytesFreed += o.size; }
    } catch (e) {
      out.errors.push(`staged object delete failed: ${(e as Error).message}`);
    }
  }
  if (out.errors.length > 0 || out.truncated) return out;
  try {
    const { data, error } = await client.from("intake_attempts").delete()
      .eq("outcome", ATTEMPT_OUTCOME.staged).lt("created_at", new Date(cutoff).toISOString())
      .select("id");
    if (error) out.errors.push(`expired staging reservations not removed: ${error.message}`);
    else out.reservationsExpired = (data as unknown[] | null)?.length ?? 0;
  } catch (e) {
    out.errors.push(`expired staging reservations not removed: ${(e as Error).message}`);
  }
  return out;
}
