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
    // PROD-17 (N15): the one recall first, then the watchers' FYI (fix pass 3)
    const recalls = state.emits.filter((x) => x.category === "recall");
    expect(recalls).toHaveLength(1);
    const e = recalls[0] as { audience: { involved: string[] }; title: string; body: string };
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
    // no recall (nobody holds a copy) and no recall audit row — only PROD-17's watcher FYI (N15)
    expect(state.emits.filter((x) => x.category === "recall")).toHaveLength(0);
    expect(state.emits).toHaveLength(1);
    // DIST-16 done-when 2 (document-control P28, the integrator's fix pass):
    // the FYI is on the record — one watchers-only row naming nobody
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({ type: "DISTRIBUTION_RECALL", documentId: "d1", details: { retirement: true, newStatus: "Void", recipientCount: 0, recipients: [], watchersOnly: true } });
  });

  it("PROD-17 (notifications N15): the document's followers are told it was retired, in a watcher's words, minus the copy holders the recall tells", async () => {
    state.tables.download_audits = [{ user_id: "u1" }, { user_id: "actor" }];
    await recallRetiredDocument({
      orgId: "org1", documentId: "d1", libraryId: "lib1", docLabel: "P-101",
      newStatus: "Void", replacementNote: "Replaced by P-101A.", actorUserId: "actor", actorName: "doccontrol",
    });
    const f = state.emits.find((x) => (x.audience as { followers?: boolean }).followers) as Record<string, unknown>;
    expect(f).toMatchObject({
      // fix pass: its own NON-compliance kind (doc_recalled is a compliance
      // kind — the digest, dismiss-only, retried as an obligation)
      kind: "doc_retired", category: "watched",
      title: "P-101 was retired (Void)",
      resource: { type: "document", id: "d1" }, actorUserId: "actor",
      audience: { followers: true, exclude: ["u1"] },
      metadata: { retirement: true, followerNotice: true, newStatus: "Void" },
      // fix pass 2: doc_retired is declared by 20261206 — if that paste is
      // late, a refused bell row sends no email either
      emailOnlyWithBell: true,
    });
    expect(String(f.body)).toContain("doccontrol retired P-101 (void)");
    expect(String(f.body)).not.toMatch(/your copy/i);
    expect(String(f.body)).toContain("Replaced by P-101A.");
  });

  it("PROD-17 (fix pass): the watchers' FYI also leaves out the checkout holder and the open packages' owners — the people the supersede door's personal notices told", async () => {
    state.tables.download_audits = [{ user_id: "u1" }];
    // the supersede leaves the checkout open: documents.checked_out_by still names the holder
    (state.tables as Record<string, unknown>).documents = { checked_out_by: "holder" };
    state.tables.work_package_documents = [{ package_id: "pk1" }, { package_id: "pk2" }];
    state.tables.work_packages = [{ owner_user_id: "pkowner" }, { owner_user_id: "actor" }, { owner_user_id: null }];
    await recallRetiredDocument({
      orgId: "org1", documentId: "d1", libraryId: "lib1", docLabel: "P-101",
      newStatus: "Superseded", actorUserId: "actor", actorName: "doccontrol",
    });
    const f = state.emits.find((x) => (x.audience as { followers?: boolean }).followers) as { kind: string; audience: { exclude: string[] } };
    expect(f.kind).toBe("doc_retired");
    expect([...f.audience.exclude].sort()).toEqual(["holder", "pkowner", "u1"]);
    // the copy holders' recall is unchanged
    const recall = state.emits.find((x) => x.category === "recall") as { kind: string; audience: { involved: string[] } };
    expect(recall).toMatchObject({ kind: "doc_recalled", audience: { involved: ["u1"] } });
  });

  it("PROD-17 (fix pass): a door that sends neither personal notice says so, and those people stay in the watchers' audience", async () => {
    state.tables.download_audits = [];
    (state.tables as Record<string, unknown>).documents = { checked_out_by: "holder" };
    state.tables.work_package_documents = [{ package_id: "pk1" }];
    state.tables.work_packages = [{ owner_user_id: "pkowner" }];
    await recallRetiredDocument({
      orgId: "org1", documentId: "d1", docLabel: "P-101", newStatus: "Void", actorUserId: "actor",
      personallyToldElsewhere: { checkoutHolder: false, packageOwners: false },
    });
    expect(state.emits).toHaveLength(1);
    expect((state.emits[0] as { audience: { exclude: string[] } }).audience.exclude).toEqual([]);
  });

  it("fix pass 3 (the review's major): the copy holders' recall and its DIST-10 audit row go out BEFORE the watchers' FYI — an FYI that never finishes (a hung discover check) cannot hold them back", async () => {
    const { emit } = await import("@/lib/notify/dispatch");
    vi.mocked(emit).mockImplementation(async (p) => {
      state.emits.push(p as unknown as Record<string, unknown>);
      if ((p as { kind?: string }).kind === "doc_retired") await new Promise(() => undefined); // never resolves
      return { recipients: 1 };
    });
    try {
      state.tables.download_audits = [{ user_id: "u1" }, { user_id: "u2" }];
      void recallRetiredDocument({
        orgId: "org1", documentId: "d1", libraryId: "lib1", docLabel: "P-101",
        newStatus: "Superseded", actorUserId: "actor", actorName: "doccontrol",
      });
      await vi.waitFor(() => expect(state.emits.map((e) => e.kind)).toEqual(["doc_recalled", "doc_retired"]));
      expect(state.audits).toHaveLength(1);
      expect(state.audits[0]).toMatchObject({ type: "DISTRIBUTION_RECALL", details: { recipientCount: 2 } });
    } finally {
      vi.mocked(emit).mockImplementation(async (p) => { state.emits.push(p as unknown as Record<string, unknown>); return { recipients: 1 }; });
    }
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
