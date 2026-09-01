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

import { listMyStaleCopies, recallRetiredDocument } from "@/lib/staleCopies";

beforeEach(() => {
  state.tables = {};
  state.emits = [];
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
  });
});
