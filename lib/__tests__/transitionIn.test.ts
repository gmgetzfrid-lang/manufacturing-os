import { describe, it, expect, vi, beforeEach } from "vitest";

// A filter-aware PostgREST mock for the shared client (projects Round G J1:
// the scan, the candidate list and adoption are exercised against rows).
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  queries: [] as Array<{ table: string; ops: Array<[string, unknown[]]> }>,
  errors: {} as Record<string, Array<{ message: string; code?: string } | null>>,
  /** INTK-16: the adopt_intake_document RPC. Unset = a database before
   *  20261141 (PGRST202), so the earlier cases exercise the direct-update path. */
  rpc: null as null | ((fn: string, args: Record<string, unknown>) => { data: unknown; error: { message: string; code?: string } | null }),
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string) => {
    const ops: Array<[string, unknown[]]> = [];
    db.queries.push({ table, ops });
    let write: { method: string; payload: unknown } | null = null;
    const matches = (r: Record<string, unknown>) => ops.every(([op, a]) => {
      const [col, val] = a as [string, unknown];
      switch (op) {
        case "eq": return r[col] === val;
        case "neq": return r[col] !== val;
        case "in": return (val as unknown[]).includes(r[col]);
        case "is": return val === null ? r[col] == null : r[col] === val;
        case "ilike": {
          const re = new RegExp("^" + String(val).replace(/\\([\\%_])/g, "\u0000$1").replace(/[.*+?^${}()|[\]]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".").replace(/\u0000(.)/g, (_m, c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) + "$", "i");
          return re.test(String(r[col] ?? ""));
        }
        case "not": { const [c, o, v] = a as [string, string, string]; if (o === "in") return !String(v).replace(/^\(|\)$/g, "").split(",").includes(String(r[c])); if (o === "is") return v === null ? r[c] != null : r[c] !== v; return true; }
        case "or": { const parts = String(a[0]).split(","); return parts.some((p) => { const m = /^(\w+)\.(is|neq)\.(.+)$/.exec(p); if (!m) return false; return m[2] === "is" ? r[m[1]] == null : r[m[1]] != null && String(r[m[1]]) !== m[3]; }); }
        default: return true;
      }
    });
    const run = () => {
      const errs = db.errors[`${table}.${write ? write.method : "select"}`];
      const err = errs?.shift() ?? null;
      if (err) return { data: null, error: err };
      const rows = (db.tables[table] ?? []).filter(matches);
      if (write?.method === "update") { rows.forEach((r) => Object.assign(r, write!.payload as object)); return { data: rows, error: null }; }
      if (write) return { data: null, error: null };
      const lim = ops.find(([o]) => o === "limit");
      return { data: lim ? rows.slice(0, Number(lim[1][0])) : rows, error: null };
    };
    const proxy: Record<string, unknown> = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (res: (v: unknown) => void, rej: (e: unknown) => void) => { try { res(run()); } catch (e) { rej(e); } };
        return (...args: unknown[]) => {
          if (prop === "update" || prop === "insert" || prop === "upsert") write = { method: prop, payload: args[0] };
          else if (prop === "maybeSingle" || prop === "single") { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }); }
          else if (prop !== "select") ops.push([prop, args]);
          return proxy;
        };
      },
    });
    return proxy;
  };
  return {
    supabase: {
      from: chain,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        db.rpcCalls.push({ fn, args });
        return db.rpc ? db.rpc(fn, args) : { data: null, error: { message: `Could not find the function public.${fn}`, code: "PGRST202" } };
      },
    },
  };
});

import {
  extractCandidateTags, likeExact, sameNumber, scanTransitionImpact, listTransitionCandidates, adoptDocument,
  blockingNumberCollision, candidateInReview, candidateReviewNote, pendingDraftRetired, RETIRED_PENDING_NOTE,
  type TransitionCandidate, type TransitionImpact,
} from "@/lib/transitionIn";

beforeEach(() => { db.tables = {}; db.queries = []; db.errors = {}; db.rpc = null; db.rpcCalls = []; });

describe("extractCandidateTags", () => {
  it("finds equipment tags across number and title fields", () => {
    expect(extractCandidateTags("D-25-1042", "P&ID DHT Feed — FE-201 to P-101A"))
      .toEqual(expect.arrayContaining(["FE-201", "P-101A"]));
  });

  it("does not emit phantom tags from multi-segment drawing numbers", () => {
    expect(extractCandidateTags("D-25-1042", null)).toEqual([]);
  });

  it("uppercases lowercase input before matching", () => {
    expect(extractCandidateTags(null, "tie-in at fe-201 and psv-1002")).toEqual(
      expect.arrayContaining(["FE-201", "PSV-1002"]),
    );
  });

  it("dedupes a tag that appears in both fields", () => {
    const tags = extractCandidateTags("FE-201", "Orifice run for FE-201");
    expect(tags.filter((t) => t === "FE-201")).toHaveLength(1);
  });

  it("ignores plain words, bare numbers, and null/undefined fields", () => {
    expect(extractCandidateTags("General Arrangement", "Sheet 2 of 3")).toEqual([]);
    expect(extractCandidateTags(null, undefined)).toEqual([]);
  });
});


// ── projects Round G J1 — INTK-7 / SAF-12 scan half ─────────────────────────
const INTAKE = "col-intake";
const cand = (over: Partial<TransitionCandidate> = {}): TransitionCandidate => ({
  docId: "sheet1", label: "D-25-1042", number: "D-25-1042", title: "Tie-in FE-201", rev: "A", status: "Draft",
  company: "Vendor", submittedAt: null, ...over,
});
const seedRegister = (docs: Array<Record<string, unknown>>) => {
  db.tables.documents = docs;
  db.tables.assets = [{ id: "a1", tag: "FE-201", tag_normalized: "fe201", org_id: "o1", archived: false }];
  db.tables.document_assets = [];
};

describe("INTK-7 — the collision scan checks every sheet, exactly", () => {
  it("likeExact escapes LIKE metacharacters (and PostgREST's * alias only ever broadens)", () => {
    expect(likeExact("P-101_")).toBe("P-101\\_");
    expect(likeExact("100%")).toBe("100\\%");
    expect(likeExact("a\\b")).toBe("a\\\\b");
    expect(likeExact("A*1")).toBe("A_1");
    expect(sameNumber(" d-25-1042 ", "D-25-1042")).toBe(true);
    expect(sameNumber("", "")).toBe(false);
  });
  it("a sheet with no number is UNVERIFIABLE, never clean", async () => {
    seedRegister([]);
    const i = await scanTransitionImpact("o1", cand({ number: null, label: "Untitled", title: "Tie-in FE-201" }), INTAKE);
    expect(i.unverifiable).toContain("no_number");
    expect(i.clean).toBe(false);
  });
  it("a sheet whose tags match no registry equipment is UNVERIFIABLE (the overlap check had nothing to check)", async () => {
    seedRegister([]);
    const i = await scanTransitionImpact("o1", cand({ title: "General arrangement" }), INTAKE);
    expect(i.unverifiable).toEqual(["no_equipment"]);
    expect(i.clean).toBe(false);
  });
  it("a numbered sheet with recognised equipment, no collision and no overlap is clean", async () => {
    seedRegister([]);
    const i = await scanTransitionImpact("o1", cand(), INTAKE);
    expect(i).toMatchObject({ unverifiable: [], clean: true, numberCollision: null });
  });
  it("the collision query filters status server-side, orders deterministically, and never takes an arbitrary 5-row window", async () => {
    seedRegister([]);
    await scanTransitionImpact("o1", cand(), INTAKE);
    const q = db.queries.find((x) => x.table === "documents" && x.ops.some(([o]) => o === "ilike"))!;
    expect(q.ops).toContainEqual(["not", ["status", "in", "(Archived,Superseded)"]]);
    expect(q.ops).toContainEqual(["order", ["id", { ascending: true }]]);
    expect(q.ops.find(([o]) => o === "limit")?.[1]).toEqual([25]);
    expect(q.ops).toContainEqual(["or", [`collection_id.is.null,collection_id.neq.${INTAKE}`]]);
  });
  it("finds a live collision hiding behind six superseded rows, a library-root document, and ignores a wildcard look-alike", async () => {
    seedRegister([
      ...Array.from({ length: 6 }, (_, k) => ({ id: `old${k}`, org_id: "o1", document_number: "D-25-1042", status: "Superseded", collection_id: "lib-col" })),
      { id: "decoy", org_id: "o1", document_number: "D-25-10420", status: "Issued", collection_id: "lib-col" },
      { id: "live", org_id: "o1", document_number: "d-25-1042", rev: "3", status: "Issued", collection_id: null },
    ]);
    const i = await scanTransitionImpact("o1", cand(), INTAKE);
    expect(i.numberCollision).toMatchObject({ id: "live", rev: "3", libraryId: null });
    expect(i.numberCollisions.map((c) => c.id)).toEqual(["live"]);
    expect(i.clean).toBe(false);
    const pct = await scanTransitionImpact("o1", cand({ number: "%" }), INTAKE);
    expect(pct.numberCollision).toBeNull(); // a bare % no longer matches everything
  });
  it("a check that errors is 'check_failed' — never read as no collision", async () => {
    seedRegister([]);
    db.errors["documents.select"] = [{ message: "boom" }];
    const i = await scanTransitionImpact("o1", cand(), INTAKE);
    expect(i.unverifiable).toContain("check_failed");
    expect(i.clean).toBe(false);
  });
});

describe("INTK-3 / SAF-11 — the candidate list", () => {
  it("drops a NEVER-APPROVED sheet whose latest intake submission was rejected; marks one still in review or never approved", async () => {
    db.tables.documents = [
      { id: "rej", org_id: "o1", collection_id: INTAKE, status: "Draft", document_number: "R-1", current_version_id: null, pending_version_id: null, created_at: "3" },
      { id: "pend", org_id: "o1", collection_id: INTAKE, status: "Draft", document_number: "P-1", current_version_id: null, pending_version_id: "vp", created_at: "2" },
      { id: "ok", org_id: "o1", collection_id: INTAKE, status: "Issued", document_number: "K-1", current_version_id: "vk", pending_version_id: null, created_at: "1" },
    ];
    db.tables.document_versions = [
      { record_id: "rej", review_state: "rejected", intake_link_id: "l1", created_at: "9" },
      { record_id: "pend", review_state: "in_review", intake_link_id: "l1", created_at: "8" },
      { record_id: "ok", review_state: "approved", intake_link_id: "l1", created_at: "7" },
    ];
    const list = await listTransitionCandidates("o1", INTAKE);
    expect(list.map((c) => c.docId)).toEqual(["pend", "ok"]);
    expect(list.find((c) => c.docId === "pend")).toMatchObject({ awaitingReview: true, pendingReview: true });
    expect(list.find((c) => c.docId === "ok")).toMatchObject({ awaitingReview: false, pendingReview: false, latestRejected: false });
  });
  it("keeps an APPROVED sheet whose newest proposal was rejected — its approved revision is the controlled content (a note, not a block)", async () => {
    db.tables.documents = [
      { id: "appr", org_id: "o1", collection_id: INTAKE, status: "Issued", document_number: "A-1", rev: "A", current_version_id: "va", pending_version_id: null, created_at: "1" },
    ];
    db.tables.document_versions = [
      { record_id: "appr", review_state: "rejected", intake_link_id: "l1", created_at: "9" },
      { record_id: "appr", review_state: "approved", intake_link_id: "l1", created_at: "1" },
    ];
    const list = await listTransitionCandidates("o1", INTAKE);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ docId: "appr", awaitingReview: false, latestRejected: true });
  });
  it("an unreadable list throws — never an empty 'nothing to adopt'", async () => {
    db.errors["documents.select"] = [{ message: "boom" }];
    await expect(listTransitionCandidates("o1", INTAKE)).rejects.toThrow(/Couldn't list the intake sheets/);
  });
});

describe("INTK-3 / INTK-5 / SAF-12 — adoption re-checks at the click", () => {
  const seedAdopt = (over: Record<string, unknown> = {}, register: Array<Record<string, unknown>> = []) => {
    db.tables.documents = [
      { id: "sheet1", org_id: "o1", document_number: "D-25-1042", title: "Tie-in FE-201", rev: "A", status: "Issued", metadata: {}, library_id: "lib-intake", collection_id: INTAKE, current_version_id: "v1", pending_version_id: null, ...over },
      ...register,
    ];
    db.tables.document_versions = [{ record_id: "sheet1", review_state: "approved", intake_link_id: "l1", created_at: "1" }];
    db.tables.libraries = [{ id: "lib-dest", org_id: "o1", uniqueness_keys: null }];
    db.tables.assets = [];
    db.tables.document_assets = [];
  };
  const adopt = (newNumber: string | null = null) => adoptDocument({
    orgId: "o1", projectId: "p1", docId: "sheet1", libraryId: "lib-dest", collectionId: null,
    newNumber, linkAssets: [], actorId: "u1", actorEmail: "u1@x",
  });
  it("refuses a sheet still in review, or never approved", async () => {
    seedAdopt({ pending_version_id: "v2" });
    expect((await adopt()).error).toMatch(/still awaiting review/);
    seedAdopt({ current_version_id: null });
    expect((await adopt()).error).toMatch(/still awaiting review/);
  });
  it("refuses a never-approved sheet whose latest submission was rejected", async () => {
    seedAdopt({ current_version_id: null });
    db.tables.document_versions = [{ record_id: "sheet1", review_state: "rejected", intake_link_id: "l1", created_at: "2" }];
    expect((await adopt()).error).toMatch(/was rejected/);
  });
  it("adopts an APPROVED sheet at its approved revision even when a newer proposal was rejected (INTK-3 — the base allowed it)", async () => {
    seedAdopt();
    db.tables.document_versions.push({ record_id: "sheet1", review_state: "rejected", intake_link_id: "l1", created_at: "2" });
    db.tables.document_versions.reverse();
    expect(await adopt()).toEqual({ ok: true });
    expect(db.tables.documents[0]).toMatchObject({ library_id: "lib-dest", current_version_id: "v1" });
  });
  it("refuses a live collision; refuses a renumber onto another live number; accepts a clear renumber and writes its key", async () => {
    const live = { id: "live", org_id: "o1", document_number: "D-25-1042", rev: "3", status: "Issued", collection_id: "c-lib" };
    const other = { id: "other", org_id: "o1", document_number: "D-25-2000", rev: "1", status: "Issued", collection_id: "c-lib" };
    seedAdopt({}, [live, other]);
    expect((await adopt()).error).toMatch(/collides with D-25-1042 \(Rev 3\)/);
    expect((await adopt("D-25-2000")).error).toMatch(/already the number of D-25-2000/);
    const ok = await adopt("D-25-3000");
    expect(ok).toEqual({ ok: true });
    expect(db.tables.documents[0]).toMatchObject({ library_id: "lib-dest", document_number: "D-25-3000", uniqueness_key: "d-25-3000" });
  });
  it("a multi-sheet library (['documentNumber','sheet']): two same-numbered sheets with no sheet value are BOTH adopted, unkeyed, and the operator is told what to set (INTK-5)", async () => {
    seedAdopt({ id: "sheet1", document_number: "P-100", title: "P&ID sheet 1", metadata: {} }, [
      { id: "sheet2", org_id: "o1", document_number: "P-100", title: "P&ID sheet 2", rev: "A", status: "Issued", metadata: null, library_id: "lib-intake", collection_id: INTAKE, current_version_id: "v2", pending_version_id: null },
    ]);
    db.tables.document_versions.push({ record_id: "sheet2", review_state: "approved", intake_link_id: "l1", created_at: "1" });
    db.tables.libraries[0].uniqueness_keys = ["documentNumber", "sheet"];
    const first = await adopt();
    expect(first.ok).toBe(true);
    expect(first.note).toMatch(/adopted without a uniqueness key: that library identifies a document by number \+ sheet, and the sheet carries no sheet/);
    // sheet 1 now lives in the destination — the same number is NOT a
    // collision there, and no partial key ('p-100::') refuses sheet 2
    const second = await adoptDocument({
      orgId: "o1", projectId: "p1", docId: "sheet2", libraryId: "lib-dest", collectionId: null,
      newNumber: null, linkAssets: [], actorId: "u1", actorEmail: "u1@x",
    });
    expect(second.ok).toBe(true);
    expect(db.tables.documents.map((d) => [d.id, d.library_id, d.uniqueness_key])).toEqual([["sheet1", "lib-dest", null], ["sheet2", "lib-dest", null]]);
  });
  it("a multi-sheet library: a sheet that carries its sheet value is keyed in full, and the FULL key — not the number — decides a collision", async () => {
    const sibling = { id: "sib", org_id: "o1", document_number: "P-100", rev: "B", status: "Issued", library_id: "lib-dest", collection_id: null, uniqueness_key: "p-100::1" };
    seedAdopt({ document_number: "P-100", metadata: { sheet: "2" } }, [sibling]);
    db.tables.libraries[0].uniqueness_keys = ["documentNumber", "sheet"];
    expect(await adopt()).toEqual({ ok: true });
    expect(db.tables.documents[0]).toMatchObject({ uniqueness_key: "p-100::2" });
    seedAdopt({ document_number: "P-100", metadata: { sheet: "1" } }, [sibling]);
    db.tables.libraries[0].uniqueness_keys = ["documentNumber", "sheet"];
    const clash = await adopt();
    expect(clash.error).toMatch(/P-100 \(Rev B\) already carries the same number \+ sheet in that library/);
    expect(db.tables.documents[0]).toMatchObject({ library_id: "lib-intake" });
    // the database's refusal in a multi-part library names the tuple, not "renumber"
    seedAdopt({ document_number: "P-100", metadata: { sheet: "3" } });
    db.tables.libraries[0].uniqueness_keys = ["documentNumber", "sheet"];
    db.errors["documents.update"] = [{ message: "duplicate key value violates unique constraint", code: "23505" }];
    expect((await adopt()).error).toMatch(/already carries the same number \+ sheet — change the sheet's number \+ sheet/);
  });
  it("the default tuple keeps the number rule: a same-numbered live document is a collision", async () => {
    seedAdopt({}, [{ id: "live", org_id: "o1", document_number: "D-25-1042", rev: "3", status: "Issued", library_id: "lib-dest", collection_id: null }]);
    expect((await adopt()).error).toMatch(/collides with D-25-1042/);
  });
  it("the database's unique refusal and the move guard reach the operator as sentences", async () => {
    seedAdopt();
    db.errors["documents.update"] = [{ message: "duplicate key value violates unique constraint \"documents_library_uniqkey_uniq\"", code: "23505" }];
    expect((await adopt()).error).toMatch(/Another live document in that library already carries D-25-1042/);
    seedAdopt();
    db.errors["documents.update"] = [{ message: "Moving documents between folders requires Admin or Document Control." }];
    const res = await adopt();
    expect(res.error).toMatch(/needs Admin or Document Control/);
    expect(res.error).not.toMatch(/^Moving documents/);
  });
});

// ── projects Round G J1 fix pass 3 — a multi-part destination does not ────
// excuse a same-numbered live document in ANOTHER library (SAF-12 dw1 /
// INTK-3 dw1), and a sheet with a newer submission in review is not clean.
describe("SAF-12 / INTK-3 — blockingNumberCollision judges colliders against the destination", () => {
  const col = (id: string, libraryId: string | null) => ({ id, label: "P-100", rev: "3", libraryId });
  const imp = (...cs: Array<ReturnType<typeof col>>): Pick<TransitionImpact, "numberCollision" | "numberCollisions"> =>
    ({ numberCollision: cs[0] ?? null, numberCollisions: cs });
  it("the default tuple: ANY live same-numbered document blocks, wherever it lives", () => {
    expect(blockingNumberCollision(imp(col("a", "lib-dest")), "lib-dest", true)?.id).toBe("a");
    expect(blockingNumberCollision(imp(col("a", "lib-other")), "lib-dest", true)?.id).toBe("a");
  });
  it("a multi-part destination: a sibling INSIDE it is expected; one in another library — or in none — blocks", () => {
    expect(blockingNumberCollision(imp(col("sib", "lib-dest")), "lib-dest", false)).toBeNull();
    expect(blockingNumberCollision(imp(col("sib", "lib-dest"), col("x", "lib-L1")), "lib-dest", false)?.id).toBe("x");
    expect(blockingNumberCollision(imp(col("root", null)), "lib-dest", false)?.id).toBe("root");
  });
  it("no destination picked yet: the number rule applies; no collision: nothing blocks", () => {
    expect(blockingNumberCollision(imp(col("sib", "lib-dest")), null, false)?.id).toBe("sib");
    expect(blockingNumberCollision(imp(), "lib-dest", true)).toBeNull();
    expect(blockingNumberCollision(undefined, "lib-dest", false)).toBeNull();
  });
});

describe("SAF-12 / INTK-3 — adopting into a multi-part library over a live number elsewhere", () => {
  const seedCross = (register: Array<Record<string, unknown>>) => {
    db.tables.documents = [
      { id: "sheet1", org_id: "o1", document_number: "P-100", title: "Tie-in FE-201", rev: "A", status: "Issued", metadata: {}, library_id: "lib-intake", collection_id: INTAKE, current_version_id: "v1", pending_version_id: null },
      ...register,
    ];
    db.tables.document_versions = [{ record_id: "sheet1", review_state: "approved", intake_link_id: "l1", created_at: "1" }];
    db.tables.libraries = [
      { id: "lib-dest", org_id: "o1", uniqueness_keys: ["documentNumber", "sheet"] },
      { id: "lib-L1", org_id: "o1", uniqueness_keys: null },
    ];
    db.tables.assets = [{ id: "a1", tag: "FE-201", tag_normalized: "fe201", org_id: "o1", archived: false }];
    db.tables.document_assets = [];
  };
  const adopt = (newNumber: string | null = null) => adoptDocument({
    orgId: "o1", projectId: "p1", docId: "sheet1", libraryId: "lib-dest", collectionId: null,
    newNumber, linkAssets: [], actorId: "u1", actorEmail: "u1@x",
  });
  const issuedL1 = { id: "p100-l1", org_id: "o1", document_number: "P-100", rev: "3", status: "Issued", library_id: "lib-L1", collection_id: "c-l1" };

  it("the reviewer's case: P-100 Rev 3 Issued in L1 refuses adopting an intake P-100 into an ['documentNumber','sheet'] library — nothing moves", async () => {
    seedCross([issuedL1]);
    const scan = await scanTransitionImpact("o1", cand({ number: "P-100", label: "P-100" }), INTAKE);
    expect(scan.unverifiable).toEqual([]); // recognised equipment: nothing 'unverifiable' to confirm
    expect(scan.numberCollision).toMatchObject({ id: "p100-l1", libraryId: "lib-L1" });
    expect(blockingNumberCollision(scan, "lib-dest", false)?.id).toBe("p100-l1");
    const res = await adopt();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/P-100 collides with P-100 \(Rev 3\) in another library — renumber it/);
    expect(db.tables.documents[0]).toMatchObject({ library_id: "lib-intake", collection_id: INTAKE });
    expect(db.tables.documents[0].uniqueness_key).toBeUndefined();
  });
  it("a renumber onto the other library's live number is refused; a clear renumber is adopted", async () => {
    seedCross([issuedL1, { id: "q200", org_id: "o1", document_number: "Q-200", rev: "1", status: "Issued", library_id: "lib-L1", collection_id: "c-l1" }]);
    expect((await adopt("Q-200")).error).toMatch(/Q-200 is already the number of Q-200 \(Rev 1\) in another library/);
    const ok = await adopt("P-900");
    expect(ok.ok).toBe(true);
    expect(db.tables.documents[0]).toMatchObject({ library_id: "lib-dest", document_number: "P-900" });
  });
  it("a retired document elsewhere does not block; a sibling inside the destination still does not", async () => {
    seedCross([{ ...issuedL1, status: "Superseded" }, { id: "sib", org_id: "o1", document_number: "P-100", rev: "B", status: "Issued", library_id: "lib-dest", collection_id: null }]);
    const res = await adopt();
    expect(res.ok).toBe(true);
    expect(res.note).toMatch(/adopted without a uniqueness key/);
  });
  it("a live number elsewhere is found even behind a full window of same-numbered siblings inside the destination", async () => {
    const siblings = Array.from({ length: 30 }, (_, k) => ({
      id: `a-sib-${String(k).padStart(2, "0")}`, org_id: "o1", document_number: "P-100", rev: "A", status: "Issued", library_id: "lib-dest", collection_id: null,
    }));
    seedCross([...siblings, { ...issuedL1, id: "z-p100-l1" }]);
    const scan = await scanTransitionImpact("o1", cand({ number: "P-100", label: "P-100" }), INTAKE);
    expect(scan.numberCollisions).toHaveLength(25);
    expect(scan.numberCollisions.every((c) => c.libraryId === "lib-dest")).toBe(true);
    const res = await adopt();
    expect(res.error).toMatch(/collides with P-100 \(Rev 3\) in another library/);
    const q = db.queries.filter((x) => x.table === "documents" && x.ops.some(([o, a]) => o === "or" && String(a[0]).startsWith("library_id.")));
    expect(q.length).toBeGreaterThan(0);
    expect(q[0].ops).toContainEqual(["or", ["library_id.is.null,library_id.neq.lib-dest"]]);
    expect(q[0].ops).toContainEqual(["or", [`collection_id.is.null,collection_id.neq.${INTAKE}`]]);
  });
  it("an unreadable register outside the destination refuses — never read as free", async () => {
    seedCross([]);
    // reads, in order: the sheet, the org-wide scan (clean), then the
    // out-of-library look-up — which errors
    db.errors["documents.select"] = [null, null, { message: "boom" }];
    const res = await adopt();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Couldn't confirm P-100 is free in the other libraries/);
    expect(db.tables.documents[0]).toMatchObject({ library_id: "lib-intake" });
  });
});

describe("INTK-3 dw2 — a sheet with an open pending_version_id is never clean", () => {
  it("candidateInReview: never approved, or approved with a newer submission in review", () => {
    expect(candidateInReview({ awaitingReview: true, pendingReview: true })).toBe(true);
    expect(candidateInReview({ awaitingReview: true, pendingReview: false })).toBe(true);
    expect(candidateInReview({ awaitingReview: false, pendingReview: true })).toBe(true);
    expect(candidateInReview({ awaitingReview: false, pendingReview: false })).toBe(false);
  });
  it("an approved sheet whose Rev B is in review lists as pendingReview, is marked in review, and adoption refuses it", async () => {
    db.tables.documents = [
      { id: "s", org_id: "o1", collection_id: INTAKE, library_id: "lib-intake", status: "Issued", document_number: "S-1", title: "Tie-in FE-201", rev: "A", metadata: {}, current_version_id: "vA", pending_version_id: "vB", created_at: "1" },
    ];
    db.tables.document_versions = [
      { record_id: "s", review_state: "in_review", intake_link_id: "l1", created_at: "2" },
      { record_id: "s", review_state: "approved", intake_link_id: "l1", created_at: "1" },
    ];
    db.tables.libraries = [{ id: "lib-dest", org_id: "o1", uniqueness_keys: null }];
    db.tables.assets = [];
    db.tables.document_assets = [];
    const [c] = await listTransitionCandidates("o1", INTAKE);
    expect(c).toMatchObject({ awaitingReview: false, pendingReview: true });
    expect(candidateInReview(c)).toBe(true);
    const res = await adoptDocument({
      orgId: "o1", projectId: "p1", docId: "s", libraryId: "lib-dest", collectionId: null,
      newNumber: null, linkAssets: [], actorId: "u1", actorEmail: null,
    });
    expect(res.error).toMatch(/still awaiting review/);
  });
});

describe("INTK-3 / INTK-4 (verification fix) — a pending pointer on a RETIRED draft is never sent to the review queue", () => {
  const seedStuck = (pending: Record<string, unknown>) => {
    db.tables.documents = [
      { id: "s", org_id: "o1", collection_id: INTAKE, library_id: "lib-intake", status: "Issued", document_number: "S-1", title: "Tie-in FE-201", rev: "A", metadata: {}, current_version_id: "vA", pending_version_id: "vB", created_at: "1" },
    ];
    db.tables.document_versions = [
      { id: "vB", record_id: "s", intake_link_id: "l1", created_at: "2", ...pending },
      { id: "vA", record_id: "s", review_state: "approved", intake_link_id: "l1", created_at: "1", superseded_at: null },
    ];
    db.tables.libraries = [{ id: "lib-dest", org_id: "o1", uniqueness_keys: null }];
    db.tables.assets = [];
    db.tables.document_assets = [];
  };
  it("pendingDraftRetired: superseded_at stamped, or review_state 'superseded' — the state pending_on_retired_version_count() counts", () => {
    expect(pendingDraftRetired({ review_state: "superseded", superseded_at: null })).toBe(true);
    expect(pendingDraftRetired({ review_state: "in_review", superseded_at: "2026-09-30T00:00:00Z" })).toBe(true);
    expect(pendingDraftRetired({ review_state: "in_review", superseded_at: null })).toBe(false);
    expect(pendingDraftRetired(null)).toBe(false);
  });
  it("the reviewer's case: an approved sheet whose displaced draft could not be restored lists as pendingRetired, and the panel's note says Document Control must clear it — not the queue", async () => {
    for (const retired of [{ review_state: "superseded", superseded_at: "2026-09-30T00:00:00Z" }, { review_state: "in_review", superseded_at: "2026-09-30T00:00:00Z" }]) {
      seedStuck(retired);
      const [c] = await listTransitionCandidates("o1", INTAKE);
      expect(c).toMatchObject({ awaitingReview: false, pendingReview: true, pendingRetired: true });
      expect(candidateInReview(c)).toBe(true); // still blocked from adoption
      const note = candidateReviewNote(c)!;
      expect(note).toBe(RETIRED_PENDING_NOTE);
      expect(note).toMatch(/names a retired draft, which the review queue does not list — Document Control must clear/);
      expect(note).not.toMatch(/review queue above/);
      const res = await adoptDocument({
        orgId: "o1", projectId: "p1", docId: "s", libraryId: "lib-dest", collectionId: null,
        newNumber: null, linkAssets: [], actorId: "u1", actorEmail: null,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe(`S-1: ${RETIRED_PENDING_NOTE}`);
    }
  });
  it("a LIVE pending draft still points at the review queue, as before", async () => {
    seedStuck({ review_state: "in_review", superseded_at: null });
    const [c] = await listTransitionCandidates("o1", INTAKE);
    expect(c).toMatchObject({ pendingReview: true, pendingRetired: false });
    expect(candidateReviewNote(c)).toBe("A newer submission for this sheet is still in review (Rev A is approved) — approve or reject it in the review queue above before it can be adopted.");
    expect(candidateReviewNote({ awaitingReview: true, pendingReview: true, rev: null })).toBe("This submission is still in review — approve or reject it in the review queue above before it can be adopted.");
    expect(candidateReviewNote({ awaitingReview: false, pendingReview: false, rev: "A" })).toBeNull();
    const res = await adoptDocument({
      orgId: "o1", projectId: "p1", docId: "s", libraryId: "lib-dest", collectionId: null,
      newNumber: null, linkAssets: [], actorId: "u1", actorEmail: null,
    });
    expect(res.error).toMatch(/still awaiting review — approve or reject its submission on the Intake tab/);
  });
  it("an unreadable pending-draft read throws — never a sheet silently shown without its state", async () => {
    seedStuck({ review_state: "superseded", superseded_at: null });
    db.errors["document_versions.select"] = [{ message: "boom" }];
    await expect(listTransitionCandidates("o1", INTAKE)).rejects.toThrow(/Couldn't read the pending submissions/);
  });
});

// projects Round G (J11) — projects-and-cost INTK-16: the move, its number
// rule and its audit row run in the database (adopt_intake_document +
// trg_documents_intake_adoption_guard, 20261141). The client's checks above
// stay for the sentences; the database decides. Exercised end to end on a
// scratch PostgreSQL 16 cluster (see the record); here: the client half.
describe("INTK-16 — adoption goes through adopt_intake_document", () => {
  const seed = () => {
    db.tables.documents = [
      { id: "sheet1", org_id: "o1", document_number: "D-25-1042", title: "Tie-in", rev: "A", status: "Issued", metadata: {}, library_id: "lib-intake", collection_id: INTAKE, current_version_id: "v1", pending_version_id: null },
    ];
    db.tables.document_versions = [{ record_id: "sheet1", review_state: "approved", intake_link_id: "l1", created_at: "1" }];
    db.tables.libraries = [{ id: "lib-dest", org_id: "o1", uniqueness_keys: null }];
    db.tables.assets = [];
    db.tables.document_assets = [];
  };
  const adopt = (newNumber: string | null = null) => adoptDocument({
    orgId: "o1", projectId: "p1", docId: "sheet1", libraryId: "lib-dest", collectionId: "col-dest",
    newNumber, linkAssets: [{ id: "a1", tag: "FE-201" }], actorId: "u1", actorEmail: "u1@x",
  });
  const docWrites = () => db.queries.filter((q) => q.table === "documents" && q.ops.some(([o]) => o === "eq") && q.ops.length > 0)
    .filter((q) => q.ops.some(([o, a]) => o === "eq" && a[0] === "id" && a[1] === "sheet1") && !q.ops.some(([o]) => o === "maybeSingle"));
  const auditInserts = () => db.queries.filter((q) => q.table === "audit_logs");

  it("the database moves the sheet: the RPC carries the destination, the renumber and the audit details; the client writes no documents row and no audit row of its own", async () => {
    seed();
    db.rpc = (fn) => (fn === "adopt_intake_document" ? { data: { ok: true }, error: null } : { data: null, error: null });
    expect(await adopt("D-25-3000")).toEqual({ ok: true });
    expect(db.rpcCalls).toEqual([{
      fn: "adopt_intake_document",
      args: {
        p_doc: "sheet1", p_library: "lib-dest", p_collection: "col-dest", p_new_number: "D-25-3000",
        p_details: { projectId: "p1", linkedAssetTags: ["FE-201"], unverifiable: ["no_equipment"] },
      },
    }]);
    // The sheet row was not updated by the client (the mock RPC did nothing).
    expect(db.tables.documents[0]).toMatchObject({ library_id: "lib-intake", document_number: "D-25-1042" });
    expect(auditInserts()).toEqual([]);
  });

  it("the database's refusal reaches the operator as its sentence — the cross-library number rule, a sheet in review", async () => {
    seed();
    const msg = "P-100 (Rev 3) is already a live document with this number — an intake sheet is adopted only under a number no other live document carries (renumber it, or resolve which one is the source of truth first). Nothing was changed. INTK-16, 20261141";
    db.rpc = () => ({ data: null, error: { message: msg, code: "23514" } });
    expect(await adopt()).toEqual({ ok: false, error: msg });
    expect(auditInserts()).toEqual([]);
  });

  it("the tier and the unique index answer in the module's sentences", async () => {
    seed();
    db.rpc = () => ({ data: null, error: { message: "Adopting into the controlled register moves the document between folders, which needs Admin or Document Control.", code: "42501" } });
    expect((await adopt()).error).toMatch(/needs Admin or Document Control/);
    db.rpc = () => ({ data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } });
    expect((await adopt()).error).toMatch(/Another live document in that library already carries D-25-1042/);
    db.rpc = () => ({ data: null, error: { message: "boom", code: "XX000" } });
    expect((await adopt()).error).toMatch(/Couldn't adopt D-25-1042 — try again/);
  });

  it("before 20261141 (no function): the direct update and the client's audit row, as before", async () => {
    seed();
    expect(await adopt("D-25-3000")).toEqual({ ok: true });
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(["adopt_intake_document"]);
    expect(db.tables.documents[0]).toMatchObject({ library_id: "lib-dest", collection_id: "col-dest", document_number: "D-25-3000", uniqueness_key: "d-25-3000" });
    expect(auditInserts()).toHaveLength(1);
    expect(docWrites().length).toBeGreaterThan(0);
  });

  it("TransitionInPanel adopts through adoptDocument (the database path) — it writes no documents row itself", async () => {
    const { readFileSync } = await import("node:fs");
    const panel = readFileSync("components/projects/TransitionInPanel.tsx", "utf8");
    expect(panel).toMatch(/await adoptDocument\(\{/);
    expect(panel).not.toMatch(/from\("documents"\)\s*\.update/);
    const lib = readFileSync("lib/transitionIn.ts", "utf8");
    expect(lib).toMatch(/supabase\.rpc\("adopt_intake_document", \{/);
  });
});
