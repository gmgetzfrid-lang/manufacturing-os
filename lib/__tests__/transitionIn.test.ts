import { describe, it, expect, vi, beforeEach } from "vitest";

// A filter-aware PostgREST mock for the shared client (projects Round G J1:
// the scan, the candidate list and adoption are exercised against rows).
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  queries: [] as Array<{ table: string; ops: Array<[string, unknown[]]> }>,
  errors: {} as Record<string, Array<{ message: string; code?: string } | null>>,
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
  return { supabase: { from: chain } };
});

import {
  extractCandidateTags, likeExact, sameNumber, scanTransitionImpact, listTransitionCandidates, adoptDocument,
  type TransitionCandidate,
} from "@/lib/transitionIn";

beforeEach(() => { db.tables = {}; db.queries = []; db.errors = {}; });

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
    expect(i.numberCollision).toMatchObject({ id: "live", rev: "3" });
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
  it("drops a sheet whose latest intake submission was rejected; marks one still in review or never approved", async () => {
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
    expect(list.find((c) => c.docId === "ok")).toMatchObject({ awaitingReview: false, pendingReview: false });
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
  it("refuses a sheet whose latest submission was rejected", async () => {
    seedAdopt();
    db.tables.document_versions.push({ record_id: "sheet1", review_state: "rejected", intake_link_id: "l1", created_at: "2" });
    db.tables.document_versions.reverse();
    expect((await adopt()).error).toMatch(/was rejected/);
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
