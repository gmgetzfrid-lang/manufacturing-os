// DIST-1: retirement is the loudest recall event in document control.
//
//   · listMyStaleCopies must treat a RETIRED document as MORE urgent, never
//     filter it out — the pre-fix `if retired continue` silenced exactly the
//     holders of the most dangerous copies, including the final revision
//     (which the "still current" check would also have skipped).
//   · recallRetiredDocument tells every download-audit holder, once each,
//     excluding the actor.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  emits: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase", () => {
  function chain(table: string) {
    const c: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) =>
            resolve({ data: state.tables[table] ?? [], error: null });
        }
        return () => new Proxy(c, handler);
      },
    };
    return new Proxy(c, handler);
  }
  return { supabase: { from: (t: string) => chain(t) } };
});
vi.mock("@/lib/notify/dispatch", () => ({
  emit: vi.fn(async (payload: Record<string, unknown>) => { state.emits.push(payload); }),
}));
vi.mock("@/lib/audit", () => ({
  logRevisionEvent: vi.fn(async (params: Record<string, unknown>) => { state.audits.push(params); }),
}));

import { listMyStaleCopies, recallRetiredDocument, getDocumentRecall, nudgeStaleHolders } from "@/lib/staleCopies";

beforeEach(() => {
  state.tables = {};
  state.emits = [];
  state.audits = [];
});

const download = (docId: string, versionId: string) => ({
  document_id: docId, version_id: versionId, created_at: "2026-08-20T00:00:00Z", user_id: "u1",
});

describe("listMyStaleCopies (DIST-1)", () => {
  it("flags a copy of a RETIRED document even when it is the final revision", () => {
    state.tables.download_audits = [download("d1", "v1")];
    state.tables.documents = [{
      id: "d1", document_number: "P-101", rev: "3", library_id: "lib1",
      current_version_id: "v1",          // the FINAL rev — "still current" pre-fix skip
      status: "Superseded",
    }];
    state.tables.document_versions = [{ id: "v1", superseded_at: null, revision_label: "3" }];
    return listMyStaleCopies("u1", "org1").then((out) => {
      expect(out).toHaveLength(1);
      expect(out[0].retiredStatus).toBe("Superseded");
      expect(out[0].docLabel).toBe("P-101");
    });
  });

  it("still skips a copy that IS the current revision of a living document", async () => {
    state.tables.download_audits = [download("d1", "v1")];
    state.tables.documents = [{
      id: "d1", document_number: "P-101", rev: "3",
      current_version_id: "v1", status: "Issued",
    }];
    state.tables.document_versions = [{ id: "v1", superseded_at: null, revision_label: "3" }];
    expect(await listMyStaleCopies("u1", "org1")).toHaveLength(0);
  });

  it("flags a stale copy of a living document with retiredStatus null", async () => {
    state.tables.download_audits = [download("d1", "v1")];
    state.tables.documents = [{
      id: "d1", document_number: "P-101", rev: "4",
      current_version_id: "v2", status: "Issued",
    }];
    state.tables.document_versions = [{ id: "v1", superseded_at: null, revision_label: "3" }];
    const out = await listMyStaleCopies("u1", "org1");
    expect(out).toHaveLength(1);
    expect(out[0].retiredStatus).toBeNull();
    expect(out[0].downloadedRev).toBe("3");
  });
});

describe("recallRetiredDocument (DIST-1)", () => {
  it("tells every distinct holder once, excluding the actor", async () => {
    state.tables.download_audits = [
      { user_id: "u1" }, { user_id: "u2" }, { user_id: "u1" }, { user_id: "actor" }, { user_id: null },
    ];
    const n = await recallRetiredDocument({
      orgId: "org1", documentId: "d1", libraryId: "lib1", docLabel: "P-101",
      newStatus: "Superseded", replacementNote: "Replaced by P-101A.",
      actorUserId: "actor", actorName: "doccontrol",
    });
    expect(n).toBe(2);
    expect(state.emits).toHaveLength(1);
    const e = state.emits[0] as { audience: { involved: string[] }; title: string; body: string };
    expect(e.audience.involved.sort()).toEqual(["u1", "u2"]);
    expect(e.title).toContain("Superseded");
    expect(e.body).toContain("Replaced by P-101A.");
  });

  it("emits nothing when no one holds a copy", async () => {
    state.tables.download_audits = [];
    const n = await recallRetiredDocument({
      orgId: "org1", documentId: "d1", docLabel: "P-101",
      newStatus: "Void", actorUserId: "actor",
    });
    expect(n).toBe(0);
    expect(state.emits).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it("puts the retirement recall on the audit trail (DIST-10)", async () => {
    state.tables.download_audits = [{ user_id: "u1" }];
    await recallRetiredDocument({
      orgId: "org1", documentId: "d1", docLabel: "P-101",
      newStatus: "Superseded", actorUserId: "actor",
    });
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0].type).toBe("DISTRIBUTION_RECALL");
    expect((state.audits[0].details as Record<string, unknown>).retirement).toBe(true);
  });
});

describe("nudgeStaleHolders audit record (DIST-10)", () => {
  const holder = (userId: string, hasCurrent: boolean) => ({
    userId, userEmail: `${userId}@x.co`, lastDownloadedRev: "3",
    lastDownloadedAt: "2026-08-01T00:00:00Z", hasCurrent,
  });

  it("records actor, version, source, and the exact recipient list", async () => {
    const n = await nudgeStaleHolders({
      orgId: "org1", documentId: "d1", docLabel: "P-101", currentRev: "5",
      currentVersionId: "v5", holders: [holder("u1", false), holder("u2", true)],
      actorUserId: "ctrl", actorName: "doccontrol", source: "manual",
    });
    expect(n).toBe(1);
    expect(state.audits).toHaveLength(1);
    const a = state.audits[0];
    expect(a.type).toBe("DISTRIBUTION_RECALL");
    expect(a.versionId).toBe("v5");
    const details = a.details as { source: string; recipients: Array<{ userId: string }> };
    expect(details.source).toBe("manual");
    expect(details.recipients.map((r) => r.userId)).toEqual(["u1"]);
  });

  it("writes no audit row when nobody is outdated", async () => {
    const n = await nudgeStaleHolders({
      orgId: "org1", documentId: "d1", docLabel: "P-101", currentRev: "5",
      holders: [holder("u1", true)], actorUserId: "ctrl",
    });
    expect(n).toBe(0);
    expect(state.audits).toHaveLength(0);
    expect(state.emits).toHaveLength(0);
  });
});

describe("getDocumentRecall capped flag (DIST-11)", () => {
  it("flags a truncated list instead of asserting completeness", async () => {
    state.tables.download_audits = Array.from({ length: 1000 }, (_, i) => ({
      user_id: `u${i}`, user_email: null, version_id: "v1", created_at: "2026-08-01T00:00:00Z",
    }));
    state.tables.document_versions = [{ id: "v1", revision_label: "3" }];
    const { capped, holders } = await getDocumentRecall("d1", "v2");
    expect(capped).toBe(true);
    expect(holders.length).toBe(1000);
  });

  it("stays un-capped for a small list", async () => {
    state.tables.download_audits = [{ user_id: "u1", user_email: null, version_id: "v1", created_at: "2026-08-01T00:00:00Z" }];
    state.tables.document_versions = [{ id: "v1", revision_label: "3" }];
    const { capped } = await getDocumentRecall("d1", "v2");
    expect(capped).toBe(false);
  });
});
