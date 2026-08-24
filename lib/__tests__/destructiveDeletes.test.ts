// The two scheduled-job delete hazards (XEDGE-4, XEDGE-13).
//
// XEDGE-4: the export retention purge must never scan a bucket without a
// prefix, and must only ever delete THIS APP's export archives.
// XEDGE-13: the orphan sweep's reference scan must page with a stable order
// and abort loudly when the paged rows disagree with the table's count — an
// incomplete reference set must never masquerade as a complete one.

import { describe, it, expect, vi, beforeEach } from "vitest";

const s3 = vi.hoisted(() => ({ sends: 0 }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { send() { s3.sends += 1; return Promise.resolve({ Contents: [], IsTruncated: false }); } },
  PutObjectCommand: class {}, HeadObjectCommand: class {},
  ListObjectsV2Command: class {}, DeleteObjectsCommand: class {},
  GetObjectCommand: class {},
}));

import { s3PurgeOlderThan, EXPORT_ARCHIVE_RE } from "@/lib/exportRunner";
import { collectReferencedKeys } from "@/lib/storageOrphans";
import type { ExportDestination } from "@/lib/exportRunner";
import type { SupabaseClient } from "@supabase/supabase-js";

beforeEach(() => { s3.sends = 0; });

describe("s3PurgeOlderThan (XEDGE-4)", () => {
  const dest = { bucket: "acme-eng-archive", destination_type: "s3" } as unknown as ExportDestination;

  it("refuses an empty prefix outright — zero bucket calls", async () => {
    await expect(s3PurgeOlderThan({ dest, prefix: "", keepDays: 30 }))
      .rejects.toThrow(/Retention purge refused/);
    expect(s3.sends).toBe(0);
  });

  it("a prefix of only slashes is still empty", async () => {
    await expect(s3PurgeOlderThan({ dest, prefix: "///", keepDays: 30 }))
      .rejects.toThrow(/Retention purge refused/);
    expect(s3.sends).toBe(0);
  });

  it("only this app's export archives ever match the deletion pattern", () => {
    expect(EXPORT_ARCHIVE_RE.test("backups/manufacturing-os-export-Acme_Refining-2026-08-24T05-00-00-000Z.zip")).toBe(true);
    expect(EXPORT_ARCHIVE_RE.test("manufacturing-os-export-acme-2026.zip")).toBe(true);
    // The customer's own objects in a shared bucket must NEVER match:
    expect(EXPORT_ARCHIVE_RE.test("backups/vendor-drawings-2019.zip")).toBe(false);
    expect(EXPORT_ARCHIVE_RE.test("archive/P-101-RevD.pdf")).toBe(false);
    expect(EXPORT_ARCHIVE_RE.test("backups/manufacturing-os-export-notes.txt")).toBe(false);
  });
});

describe("collectReferencedKeys (XEDGE-13)", () => {
  function sbWith(opts: { rows: Array<Record<string, unknown>>; count: number; ordered: { value: boolean } }) {
    return {
      from: () => {
        const c: Record<string, unknown> = {};
        const h: ProxyHandler<Record<string, unknown>> = {
          get(_t, prop: string) {
            return (...args: unknown[]) => {
              if (prop === "order") opts.ordered.value = true;
              if (prop === "range") return Promise.resolve({ data: opts.rows, error: null });
              if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) {
                return Promise.resolve({ count: opts.count, error: null });
              }
              return new Proxy(c, h);
            };
          },
        };
        return new Proxy(c, h);
      },
    } as unknown as SupabaseClient;
  }

  it("pages with a stable order and passes when counts agree", async () => {
    const ordered = { value: false };
    const sb = sbWith({ rows: [{ id: "1", file_url: "orgs/o/a.pdf" }], count: 1, ordered });
    const keys = await collectReferencedKeys(sb);
    expect(ordered.value).toBe(true); // .order() applied to the paged scan
    expect(keys.has("orgs/o/a.pdf")).toBe(true);
  });

  it("aborts fail-closed when paged rows disagree with the table count", async () => {
    const ordered = { value: false };
    const sb = sbWith({ rows: [{ id: "1", file_url: "orgs/o/a.pdf" }], count: 2, ordered });
    await expect(collectReferencedKeys(sb)).rejects.toThrow(/may be incomplete/);
  });
});
