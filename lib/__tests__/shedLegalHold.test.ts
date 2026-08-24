// The space-saver honors LEGAL HOLD (RET-1).
//
// The hold triggers guard row DELETEs only; the shed deletes R2 BYTES, which
// they never see. Candidates must exclude held documents, and commit — the
// destructive step — must re-check, so a hold placed between produce and
// commit still protects the bytes. Both reads fail CLOSED.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  versions: [] as Array<Record<string, unknown>>,
  heldDocs: [] as Array<{ id: string }>,
  heldError: null as { message: string } | null,
  archiveNote: "saved" as string,
  stamps: [] as string[][],
  r2Deletes: [] as string[],
}));

function chain(table: string) {
  let pendingUpdate: Record<string, unknown> | null = null;
  const filters: Record<string, unknown> = {};
  const c: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => {
          if (table === "documents") {
            resolve(state.heldError
              ? { data: null, error: state.heldError }
              : { data: state.heldDocs, error: null });
          } else if (table === "document_versions") {
            resolve({ data: state.versions, error: null });
          } else resolve({ data: [], error: null });
        };
      }
      return (...args: unknown[]) => {
        if (prop === "update") pendingUpdate = args[0] as Record<string, unknown>;
        if (prop === "in") filters.in = args[1];
        if (prop === "select" && pendingUpdate) {
          // stamping call: record which ids were stamped, return their file_urls
          const ids = (filters.in as string[]) ?? [];
          state.stamps.push(ids);
          pendingUpdate = null;
          const stampedRows = state.versions.filter((v) => ids.includes(v.id as string));
          return Promise.resolve({ data: stampedRows.map((v) => ({ file_url: v.file_url })), error: null });
        }
        if (prop === "maybeSingle") {
          if (table === "archives") return Promise.resolve({ data: { note: state.archiveNote }, error: null });
          return Promise.resolve({ data: null, error: null });
        }
        return new Proxy(c, handler);
      };
    },
  };
  return new Proxy(c, handler);
}

vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: vi.fn(async () => ({ admin: { from: (t: string) => chain(t) }, userId: "admin1", email: "a@x" })),
}));
vi.mock("@/lib/r2", () => ({
  r2: {
    send: vi.fn(async (cmd: { input?: { Delete?: { Objects?: Array<{ Key: string }> } } }) => {
      for (const o of cmd.input?.Delete?.Objects ?? []) state.r2Deletes.push(o.Key);
      return { Errors: [] };
    }),
  },
  R2_BUCKET: "b",
}));

import { GET } from "@/app/api/admin/shed/route";
import { POST as COMMIT } from "@/app/api/admin/shed/commit/route";

const oldVersion = (id: string, recordId: string) => ({
  id, record_id: recordId, file_url: `orgs/o1/${id}.pdf`, size: 1000,
  superseded_at: "2026-01-01T00:00:00Z", archived_at: null, archive_id: null,
  created_at: "2026-01-01T00:00:00Z", revision_label: "1", file_hash: "h",
});

beforeEach(() => {
  state.versions = [];
  state.heldDocs = [];
  state.heldError = null;
  state.archiveNote = "saved";
  state.stamps = [];
  state.r2Deletes = [];
});

function candidates(): Promise<Response> {
  return GET(new NextRequest("https://app/api/admin/shed?orgId=o1&keep=1"));
}
function commit(): Promise<Response> {
  return COMMIT(new NextRequest("https://app/api/admin/shed/commit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ orgId: "o1", archiveId: "arch1", confirm: true }),
  }));
}

describe("shed candidates honor legal hold (RET-1)", () => {
  it("excludes every version whose parent document is under hold", async () => {
    // docHeld has 3 revisions (keep=1 → 2 would normally be eligible);
    // docFree has 2 (1 eligible). Only docFree's old revision may be offered.
    state.versions = [
      { ...oldVersion("h1", "docHeld") }, { ...oldVersion("h2", "docHeld") },
      { ...oldVersion("h3", "docHeld"), superseded_at: null },
      { ...oldVersion("f1", "docFree") },
      { ...oldVersion("f2", "docFree"), superseded_at: null },
    ];
    state.heldDocs = [{ id: "docHeld" }];
    const res = await candidates();
    const body = (await res.json()) as { selectedCount: number; sample: Array<{ id: string }> };
    expect(res.status).toBe(200);
    expect(body.selectedCount).toBe(1);
    expect(body.sample.map((s) => s.id)).toEqual(["f1"]);
  });

  it("fails CLOSED when the hold read errors — no candidates offered", async () => {
    state.versions = [{ ...oldVersion("v1", "doc1") }];
    state.heldError = { message: "db down" };
    const res = await candidates();
    expect(res.status).toBe(503);
  });
});

describe("shed commit honors a hold placed AFTER produce (RET-1)", () => {
  it("leaves held versions unstamped and undeleted, and says so", async () => {
    state.versions = [
      { ...oldVersion("h1", "docHeld") },   // linked at produce, NOW held
      { ...oldVersion("f1", "docFree") },
    ];
    state.heldDocs = [{ id: "docHeld" }];
    const res = await commit();
    const body = (await res.json()) as { ok: boolean; heldSkipped: number };
    expect(res.status).toBe(200);
    expect(body.heldSkipped).toBe(1);
    expect(state.stamps.flat()).toEqual(["f1"]);            // only the free one stamped
    expect(state.r2Deletes).toEqual(["orgs/o1/f1.pdf"]);    // only the free one deleted
  });

  it("frees NOTHING when every linked revision is now held", async () => {
    state.versions = [{ ...oldVersion("h1", "docHeld") }];
    state.heldDocs = [{ id: "docHeld" }];
    const res = await commit();
    const body = (await res.json()) as { ok: boolean; reclaimed: number; heldSkipped: number };
    expect(body.reclaimed).toBe(0);
    expect(body.heldSkipped).toBe(1);
    expect(state.r2Deletes).toEqual([]);
  });

  it("fails CLOSED when the hold read errors — nothing freed", async () => {
    state.versions = [{ ...oldVersion("v1", "doc1") }];
    state.heldError = { message: "db down" };
    const res = await commit();
    expect(res.status).toBe(503);
    expect(state.r2Deletes).toEqual([]);
    expect(state.stamps).toEqual([]);
  });
});
