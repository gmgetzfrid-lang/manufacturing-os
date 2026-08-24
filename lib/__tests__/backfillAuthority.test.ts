// backfillVersion authority gate (OWN-17).
//
// Backfilling injects a historical row — with caller-chosen released_at,
// approved_by_name and file_hash — into a controlled document's revision
// chain. It previously performed NO authority check of any kind, while its
// neighbour correctRevisionLabel gates on the publish-authority population.
// These tests pin the gate: per-library control OR effective ownership, and
// the refusal happens before any byte is hashed or uploaded.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  canControl: false,
  isOwner: false,
  uploads: 0,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));

vi.mock("@/lib/supabase", () => {
  const single = () =>
    Promise.resolve({
      data: {
        id: "v-backfill", record_id: "doc1", org_id: "org1",
        revision_label: "3", change_log: "historic", created_by: "u1",
      },
      error: null,
    });
  return {
    supabase: {
      from: (table: string) => ({
        insert: (row: Record<string, unknown>) => {
          state.inserts.push({ table, row });
          return { select: () => ({ single }) };
        },
      }),
    },
  };
});

vi.mock("@/lib/storage", () => ({
  uploadToPath: vi.fn(async () => {
    state.uploads += 1;
    return { url: "https://files/x.pdf", size: 3 };
  }),
  makeLibraryStoragePath: () => "org1/lib1/x.pdf",
}));

vi.mock("@/lib/documentGuards", () => ({
  resolveCanControlLibrary: async () => state.canControl,
  fetchPublishGuardState: async () => ({}),
  evaluatePublishGuard: () => ({ ok: true }),
  DocumentMutationBlockedError: class DocumentMutationBlockedError extends Error {},
}));

vi.mock("@/lib/ownership", () => ({
  isEffectiveOwnerOfDocument: async () => state.isOwner,
}));

vi.mock("@/lib/audit", () => ({
  logRevisionEvent: vi.fn(async () => {}),
  logAuditAction: vi.fn(async () => {}),
}));

import { backfillVersion } from "@/lib/revisions";
import type { DocumentRecord } from "@/types/schema";

const doc = { id: "doc1", documentNumber: "P-200-301" } as unknown as DocumentRecord;

const input = () => ({
  doc,
  libraryId: "lib1",
  file: new File(["historic bytes"], "P-200-301_Rev3.pdf", { type: "application/pdf" }),
  revisionLabel: "3",
  changeLog: "Backfilled from the flat archive",
  orgId: "org1",
  actorUserId: "u1",
  actorEmail: "u1@example.com",
  actorRole: "Drafter",
});

beforeEach(() => {
  state.canControl = false;
  state.isOwner = false;
  state.uploads = 0;
  state.inserts = [];
});

describe("backfillVersion authority (OWN-17)", () => {
  it("refuses a caller with neither library control nor ownership — before uploading anything", async () => {
    await expect(backfillVersion(input())).rejects.toThrow(/authority/i);
    expect(state.uploads).toBe(0);
    expect(state.inserts.length).toBe(0);
  });

  it("proceeds for a caller with per-library publish control", async () => {
    state.canControl = true;
    const v = await backfillVersion(input());
    expect(v.id).toBe("v-backfill");
    expect(state.uploads).toBe(1);
    expect(state.inserts[0]?.table).toBe("document_versions");
  });

  it("proceeds for the document's effective owner without library control", async () => {
    state.isOwner = true;
    const v = await backfillVersion(input());
    expect(v.id).toBe("v-backfill");
    expect(state.uploads).toBe(1);
  });
});
