// document-control Round F wave 3 — P14 RECORDS & REVIEW REMAINDERS:
// migration 20261151 and the app's review promote.
//
//   RG-12   finalize_reviewed_promote (new, SECURITY INVOKER): the promote and
//           its bookkeeping in ONE transaction; finalizeReviewedRevision calls
//           it first and keeps the three checked writes only for a database
//           without it (PGRST202 / 42883).
//   REV-20  enforce_document_publish_guard re-created from its NEWEST earlier
//           body (scan — 20261144 today) and publish_revision from its NEWEST
//           earlier body (20261130 today), each with EXACTLY the REV-20 lines
//           added: a controller's pointer-and-issue write over an active hold
//           passes only under publish_revision's transaction-local flag (and
//           the force is recorded, REV_HOLD_OVERRIDDEN); an unstamped
//           retirement's exit into an issue is the new door for a controller.
//
// Byte fidelity: lineDiff (nothing removed; every new line is an addition)
// AND an exact cut (the re-created body minus the additions IS the base, byte
// for byte). The script was run on a throwaway PostgreSQL 16 (cases in RG-12
// and REV-20's records).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ─── migration shape ─────────────────────────────────────────────────────────
const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261151_dc_roundF_promote_transaction_and_hold_override.sql";
const M = mig(FILE);
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b + to.length);
}
function lineDiff(a: string, b: string) {
  const L = a.split("\n"), R = b.split("\n");
  return { onlyInA: L.filter((l) => !R.includes(l)), onlyInB: R.filter((l) => !L.includes(l)) };
}
const code = (lines: string[]) => lines.filter((l) => l.trim() !== "" && !l.trim().startsWith("--"));
/** The definition this migration re-creates from: the newest one BEFORE it. */
function base(head: RegExp, headText: string) {
  const defining = files.filter((f) => head.test(stripComments(mig(f))));
  expect(defining).toContain(FILE);
  const prev = defining[defining.indexOf(FILE) - 1];
  expect(prev).toBeDefined();
  return { prev, live: between(mig(prev), headText, "\n$$;"), next: between(M, headText, "\n$$;") };
}

const GUARD_HEAD = "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()";
const PUB_HEAD = "CREATE OR REPLACE FUNCTION publish_revision(";
const G = base(/CREATE OR REPLACE FUNCTION enforce_document_publish_guard\(\)/, GUARD_HEAD);
const P = base(/CREATE OR REPLACE FUNCTION publish_revision\(/, PUB_HEAD);

/** The guard's three additions, as contiguous text. */
const G_DECL = "  v_unforced_issue boolean;\n";
const G_BLOCK = G.next.slice(
  G.next.indexOf("  -- REV-20 (document-control Round F wave 3, P14): two writes passed an"),
  G.next.indexOf("  v_advancing := v_advancing OR v_issuing;"),
);
const G_HOLD = G.next.slice(
  G.next.indexOf("    -- REV-20 (b): a controller's pointer-and-issue write over an active hold"),
  G.next.indexOf("    IF NOT is_org_controller(NEW.org_id)\n       AND NOT v_restoring"),
);
/** publish_revision's five additions. */
const P_DECL = "  v_hold_forced BOOLEAN := FALSE;\n";
const P_FORCE = P.next.slice(
  P.next.indexOf("  -- REV-20 (document-control Round F wave 3, P14): a controller's force"),
  P.next.indexOf("  IF p_op_class = 'content' AND NOT p_as_branch"),
);
const P_SET = "    IF v_hold_forced THEN\n      PERFORM set_config('app.publish_hold_override', p_doc::text, true);\n    END IF;\n";
const P_CLEAR = "    IF v_hold_forced THEN\n      PERFORM set_config('app.publish_hold_override', '', true);\n    END IF;\n";
const P_RECORD = P.next.slice(
  P.next.indexOf("\n  -- REV-20: the force past a hold is on the document's record in the same"),
  P.next.indexOf("\n  SELECT to_jsonb(dv) INTO v_new_row FROM document_versions dv WHERE dv.id = v_new_id;"),
);

describe("20261151 — the guard and publish_revision re-created from their NEWEST earlier bodies (found by scanning)", () => {
  it("the bases are the newest earlier definitions (today 20261144 and 20261130 — the scan, not this comment, decides)", () => {
    expect(G.prev < FILE && P.prev < FILE).toBe(true);
    expect(G.prev >= "20261144_dc_roundF_status_issue_transition.sql").toBe(true);
    expect(P.prev >= "20261130_dc_roundF_publish_override_reason.sql").toBe(true);
  });

  it("the guard: nothing removed, every new line is one of the REV-20 additions, and the body minus them IS the base byte for byte", () => {
    const { onlyInA, onlyInB } = lineDiff(G.live, G.next);
    expect(onlyInA).toEqual([]);
    const added = (G_DECL + G_BLOCK + G_HOLD).split("\n");
    for (const l of onlyInB) expect(added, l).toContain(l);
    for (const part of [G_DECL, G_BLOCK, G_HOLD]) expect(G.next.split(part).length, part.slice(0, 60)).toBe(2);
    expect(G.next.replace(G_DECL, "").replace(G_BLOCK, "").replace(G_HOLD, "")).toBe(G.live);
  });

  it("the guard's added code is exactly the two REV-20 limbs (both bound to a controller)", () => {
    expect(code((G_DECL + G_BLOCK + G_HOLD).split("\n"))).toEqual([
      "  v_unforced_issue boolean;",
      "  v_new_door := v_new_door",
      "                OR COALESCE(v_issuing",
      "                            AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id",
      "                            AND OLD.status IN ('Superseded', 'Archived', 'Void')",
      "                            AND OLD.retired_issue_status IS NULL",
      "                            AND is_org_controller(NEW.org_id), false);",
      "  v_unforced_issue := COALESCE(v_issuing",
      "                               AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id",
      "                               AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text",
      "                               AND is_org_controller(NEW.org_id), false);",
      "    IF v_unforced_issue AND EXISTS (",
      "         SELECT 1 FROM document_holds h",
      "          WHERE h.document_id = NEW.id AND h.released_at IS NULL",
      "       ) THEN",
      "      RAISE EXCEPTION",
      "        'Document has an active hold; release the hold before issuing it, or publish over it with Document Control''s recorded override.'",
      "        USING ERRCODE = 'check_violation';",
      "    END IF;",
    ]);
    // the limbs sit where they decide: (a) right after 20261144's v_new_door, (b) right after its new-door hold check
    expect(G.next.indexOf(G_BLOCK)).toBe(G.next.indexOf("                                 AND OLD.retired_issue_version_id IS NULL, false));\n") + "                                 AND OLD.retired_issue_version_id IS NULL, false));\n".length);
    expect(G.next.indexOf(G_HOLD)).toBeGreaterThan(G.next.indexOf("'Document has an active hold; release the hold before issuing it.'"));
    expect(G.next.indexOf(G_HOLD)).toBeLessThan(G.next.indexOf("  -- OWN-3/DEC-2: controllers are a property of the role COLLECTION."));
  });

  it("the new refusal says the 20261144 sentence the app recognises (isIssueRefusal) — the un-archive dialog reads it as the new-door hold", async () => {
    const { isIssueRefusal, ISSUE_REFUSAL } = await import("@/lib/issueStatus");
    const sentence = "Document has an active hold; release the hold before issuing it, or publish over it with Document Control's recorded override.";
    expect(isIssueRefusal(sentence)).toBe(true);
    expect(sentence).toContain(ISSUE_REFUSAL.newDoorHold);
  });

  it("publish_revision: nothing removed, every new line is one of the REV-20 additions, and the body minus them IS the base byte for byte", () => {
    const { onlyInA, onlyInB } = lineDiff(P.live, P.next);
    expect(onlyInA).toEqual([]);
    const added = (P_DECL + P_FORCE + P_SET + P_CLEAR + P_RECORD).split("\n");
    for (const l of onlyInB) expect(added, l).toContain(l);
    for (const part of [P_DECL, P_FORCE, P_SET, P_CLEAR, P_RECORD]) expect(P.next.split(part).length, part.slice(0, 60)).toBe(2);
    expect(P.next.replace(P_DECL, "").replace(P_FORCE, "").replace(P_SET, "").replace(P_CLEAR, "").replace(P_RECORD, "")).toBe(P.live);
  });

  it("publish_revision's additions: the force past a hold is a controller's, flagged ONLY around its own promote, and recorded in the same transaction", () => {
    expect(code(P_FORCE.split("\n"))).toEqual([
      "  IF p_force AND v_is_controller AND EXISTS (",
      "    SELECT 1 FROM document_holds",
      "    WHERE document_id = p_doc AND released_at IS NULL",
      "  ) THEN",
      "    v_hold_forced := TRUE;",
      "  END IF;",
    ]);
    // it follows the unchanged on_hold return (a non-forced call still answers on_hold)
    expect(P.next.indexOf(P_FORCE)).toBeGreaterThan(P.next.indexOf("RETURN jsonb_build_object('status', 'on_hold');"));
    // set immediately before the documents UPDATE, cleared immediately after it
    expect(P.next).toContain(P_SET + "    UPDATE documents SET\n      current_version_id = v_new_id,");
    expect(P.next).toContain("      updated_by = p_actor\n    WHERE id = p_doc;\n" + P_CLEAR);
    // the record: after the lock record, before the answer
    expect(P_RECORD).toContain("VALUES ('REV_HOLD_OVERRIDDEN', p_doc::text, 'document', v_doc.org_id, p_actor,");
    expect(P_RECORD).toMatch(/'holds', \(SELECT jsonb_agg\(jsonb_build_object\('id', h\.id, 'reason', h\.reason\) ORDER BY h\.opened_at\)/);
    expect(P.next.indexOf(P_RECORD)).toBeGreaterThan(P.next.indexOf("IF v_lock_via IS NOT NULL THEN"));
    // the flag is set by nothing else in the sequence
    for (const f of files.filter((x) => x !== FILE)) expect(stripComments(mig(f)), f).not.toMatch(/app\.publish_hold_override/);
  });

  it("DRLS-16: publish_revision's grants are restated after the re-create (anon revoked in this file); the guard executable by no client role", () => {
    const tail = M.slice(M.indexOf(PUB_HEAD));
    expect(tail).toContain("REVOKE ALL ON FUNCTION publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean, text) FROM PUBLIC, anon;");
    expect(tail).toContain("GRANT EXECUTE ON FUNCTION publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean, text) TO authenticated, service_role;");
    expect(M).toContain("REVOKE ALL ON FUNCTION enforce_document_publish_guard() FROM PUBLIC, anon, authenticated, service_role;");
    expect(P.next).toContain("LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(G.next).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    // no second overload is created: the 12-argument signature only
    expect(stripComments(M)).not.toMatch(/DROP FUNCTION/);
  });
});

describe("20261151 — RG-12: finalize_reviewed_promote, the promote and its bookkeeping in one transaction", () => {
  const F_HEAD = "CREATE OR REPLACE FUNCTION finalize_reviewed_promote(";
  const F = between(M, F_HEAD, "\n$$;");

  it("is new (no earlier migration defines it), runs as the caller, and pins its search_path", () => {
    for (const f of files.filter((x) => x < FILE)) expect(stripComments(mig(f)), f).not.toMatch(/finalize_reviewed_promote/);
    expect(F).toContain("LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$");
    expect(F).not.toMatch(/SECURITY DEFINER/);
    expect(M).toContain("REVOKE ALL ON FUNCTION finalize_reviewed_promote(uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon;");
    expect(M).toContain("GRANT EXECUTE ON FUNCTION finalize_reviewed_promote(uuid, uuid, uuid, text, uuid) TO authenticated, service_role;");
  });

  it("does the app's three writes, in the app's order, with the app's compare-and-set — and raises (rolling the promote back) when a bookkeeping write matches no row", () => {
    const promote = F.indexOf("  UPDATE documents\n     SET current_version_id = p_pending_id,");
    const relabel = F.indexOf("  UPDATE document_versions\n     SET review_state = 'approved',");
    const supersede = F.indexOf("    UPDATE document_versions SET superseded_at = v_now WHERE id = p_expected_current;");
    expect(promote).toBeGreaterThan(0);
    expect(relabel).toBeGreaterThan(promote);
    expect(supersede).toBeGreaterThan(relabel);
    expect(F).toContain("         status = 'Issued',\n         pending_version_id = NULL,");
    expect(F).toContain("   WHERE id = p_document_id\n     AND pending_version_id = p_pending_id\n     AND current_version_id IS NOT DISTINCT FROM p_expected_current;");
    expect(F).toContain("  IF v_n = 0 THEN\n    RETURN 'no_match';\n  END IF;");
    expect(F).toContain("         revision_label = p_base_rev,\n         released_at = v_now,\n         supersedes_version_id = p_expected_current,\n         updated_at = v_now");
    expect(F).toMatch(/IF v_n = 0 THEN\n\s+RAISE EXCEPTION 'The approved draft could not be relabeled to Rev %, so nothing was published; the document is unchanged\.'/);
    expect(F).toMatch(/IF v_n = 0 AND EXISTS \(SELECT 1 FROM document_versions v WHERE v\.id = p_expected_current\) THEN\n\s+RAISE EXCEPTION 'The prior revision could not be marked superseded/);
    expect(F).not.toMatch(/\bEXCEPTION\s+WHEN\b/); // no handler swallows a refusal
    // the caller's uid attributes the write; p_actor is read only without one (the service role)
    expect(F).toContain("updated_by = COALESCE(auth.uid(), p_actor)");
  });

  it("the column the relabel has always written exists (added IF NOT EXISTS; the inventory says which world it was)", () => {
    expect(M).toContain("ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;");
    expect(readFileSync(join(process.cwd(), "lib/reviewControl.ts"), "utf8")).toContain("supersedes_version_id: previousVersionId, updated_at: nowIso })");
  });
});

describe("20261151 — the one-paste shape", () => {
  const tail = M.slice(M.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);

  it("prerequisite check → inventory TEMP TABLE (counts only) → one BEGIN/COMMIT → ONE final SELECT (check, ok, n)", () => {
    const pre = M.indexOf("DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'publish_revision' AND pronargs = 12) THEN");
    expect(pre).toBeGreaterThan(0);
    expect(pre).toBeLessThan(M.indexOf("CREATE TEMP TABLE dc_round_f_151_before AS"));
    expect(M).toContain("RAISE EXCEPTION '20261151 needs 20261144 (the REV-18 publish guard) pasted first; nothing was changed.';");
    expect(M.indexOf("CREATE TEMP TABLE dc_round_f_151_before AS")).toBeLessThan(M.indexOf("\nBEGIN;"));
    expect((M.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((M.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    const inventory = stripComments(M.slice(M.indexOf("CREATE TEMP TABLE"), M.indexOf("\nBEGIN;")));
    expect((inventory.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(6);
    expect(inventory).not.toMatch(/SELECT \*|d\.id\s*,|document_number/);
    const c = stripComments(tail).replace(/'(?:[^']|'')*'/g, "''");
    expect((c.match(/;/g) ?? []).length).toBe(1); // one statement: the final SELECT
    expect(c).toMatch(/AS ok,\n\s+NULL::text AS n/);
    expect(c).toContain("UNION ALL\nSELECT inventory, NULL::boolean, n FROM dc_round_f_151_before;");
  });

  it("every prosrc LIKE probe matches the body of the function it names (prosrc verbatim), and none carries a cast", () => {
    const bodies: Record<string, string> = {
      finalize_reviewed_promote: between(M, "CREATE OR REPLACE FUNCTION finalize_reviewed_promote(", "\n$$;"),
      enforce_document_publish_guard: G.next,
      publish_revision: P.next,
    };
    const segments = tail.split(/\nUNION ALL\n/);
    let n = 0;
    for (const seg of segments) {
      const fn = /FROM pg_proc WHERE proname = '(\w+)'/.exec(seg)?.[1];
      for (const m of seg.matchAll(/prosrc (NOT )?LIKE '((?:[^']|'')*)'/g)) {
        expect(fn, seg.slice(0, 80)).toBeDefined();
        const pat = m[2].replace(/''/g, "'");
        expect(pat, pat).not.toMatch(/::/);
        const re = new RegExp("^" + pat.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, ".")).join("[\\s\\S]*") + "$");
        const body = bodies[fn!];
        expect(body, fn).toBeDefined();
        expect(re.test(body.slice(body.indexOf("$$") + 2)), `${fn}: ${pat}`).toBe(m[1] ? false : true);
        n += 1;
      }
    }
    expect(n).toBeGreaterThanOrEqual(30);
  });

  it("the header states the paste order: after 20261144 and 20261130; never re-paste a guard or publish_revision migration after it; independent of 20261131 / 20261143", () => {
    const head = M.slice(0, M.indexOf("DO $$"));
    expect(head).toMatch(/HOW TO APPLY: after 20261144 \(the guard's base\) and 20261130/);
    expect(head).toMatch(/Never re-paste 20261144, 20261139, 20261105 or any earlier guard\n-- migration after this one, nor 20261130 or any earlier publish_revision/);
    expect(head).toMatch(/Independent of 20261131/);
    expect(head).toMatch(/20261143, 20261149 and\n-- 20261150/);
  });
});

// ─── the app: finalizeReviewedRevision through the transactional promote ────
type Row = Record<string, unknown>;
const st = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  writes: [] as Array<{ table: string; op: string; payload: unknown; filters: Array<[string, unknown]> }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcAnswer: { data: "promoted", error: null } as { data: unknown; error: { code?: string; message: string } | null },
  /** Runs inside the RPC before it answers (a concurrent writer). */
  onRpc: null as null | (() => void),
  pipeline: 0,
  audits: [] as Array<Record<string, unknown>>,
}));

function chain(table: string) {
  let op = "select";
  let payload: unknown;
  const filters: Array<[string, unknown]> = [];
  const matches = (r: Row) => filters.every(([k, v]) => r[k] === v);
  const c: Row = {};
  const finish = () => {
    if (op !== "select") {
      st.writes.push({ table, op, payload, filters: [...filters] });
      const hit = (st.rows[table] ?? []).filter(matches);
      if (op === "update") for (const r of hit) Object.assign(r, payload as Row);
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    }
    return { data: (st.rows[table] ?? []).filter(matches), error: null };
  };
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(finish()).then(res, rej);
      return (...args: unknown[]) => {
        if (prop === "update" || prop === "insert" || prop === "delete") { op = prop; payload = args[0]; }
        if (prop === "eq") filters.push([String(args[0]), args[1]]);
        if (prop === "is") filters.push([String(args[0]), args[1]]);
        if (prop === "maybeSingle" || prop === "single") {
          const out = finish();
          return Promise.resolve({ data: (out.data as Row[])[0] ?? null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      st.rpcCalls.push({ fn, args });
      if (fn === "finalize_reviewed_promote") { st.onRpc?.(); return st.rpcAnswer; }
      return { data: null, error: null };
    },
  },
}));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async (a: Record<string, unknown>) => { st.audits.push(a); return { error: null }; }) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => undefined) }));
vi.mock("@/lib/postPublish", () => ({ runPostPublishSideEffects: vi.fn(async () => { st.pipeline += 1; }) }));
vi.mock("@/lib/effectiveDate", () => ({ applyEffectiveDate: vi.fn(async () => undefined) }));
vi.mock("@/lib/intents", () => ({ recordIntent: vi.fn(async () => undefined) }));
vi.mock("@/lib/checklists", () => ({ sweepEvidenceForDocument: vi.fn(async () => ({ projects: 0 })) }));

import { finalizeReviewedRevision, finalizeReasonMessage } from "@/lib/reviewControl";

/** An Issued document at v1 with an approved-to-be draft v2A in review —
 *  an intake approval (requireRosterComplete: false), so the roster read is
 *  not this test's subject. */
function seed() {
  st.rows = {
    documents: [{ id: "d1", library_id: "l1", rev: "1", status: "Issued", current_version_id: "v1", pending_version_id: "v2", document_number: "P-101" }],
    document_versions: [
      { id: "v1", record_id: "d1", revision_label: "1" },
      { id: "v2", record_id: "d1", revision_label: "2A", base_rev: "2", review_state: "in_review", supersedes_version_id: "v1", effective_date: null },
    ],
    document_review_signoffs: [],
  };
}
const fin = () => finalizeReviewedRevision({ orgId: "o1", documentId: "d1", actorId: "ctl1", actorName: "ctl@example.com", requireRosterComplete: false });
const legacyWrites = () => st.writes.filter((w) =>
  (w.table === "documents" && w.op === "update" && "current_version_id" in (w.payload as Row))
  || (w.table === "document_versions" && w.op === "update" && ("review_state" in (w.payload as Row) || "superseded_at" in (w.payload as Row))));

beforeEach(() => {
  seed();
  st.writes = []; st.rpcCalls = []; st.pipeline = 0; st.audits = [];
  st.rpcAnswer = { data: "promoted", error: null };
  st.onRpc = null;
});

describe("RG-12 — finalizeReviewedRevision promotes through finalize_reviewed_promote (one transaction)", () => {
  it("promoted: the RPC is called with the compare-and-set and the base label; none of the three separate writes is issued; the rest of the publish runs (standby rows voided, the record, the pipeline)", async () => {
    const r = await fin();
    expect(r).toEqual({ published: true });
    expect(st.rpcCalls.filter((c) => c.fn === "finalize_reviewed_promote")).toEqual([{
      fn: "finalize_reviewed_promote",
      args: { p_document_id: "d1", p_pending_id: "v2", p_expected_current: "v1", p_base_rev: "2", p_actor: "ctl1" },
    }]);
    expect(legacyWrites()).toEqual([]);
    expect(st.writes.some((w) => w.table === "document_review_signoffs" && (w.payload as Row).status === "void")).toBe(true);
    expect(st.audits.map((a) => a.action)).toContain("REVISION_PUBLISHED_AFTER_REVIEW");
    expect(st.pipeline).toBe(1);
  });

  it("no_match with the draft still pending: a conflict — nothing written, no pipeline", async () => {
    st.rpcAnswer = { data: "no_match", error: null };
    expect(await fin()).toEqual({ published: false, reason: "conflict" });
    expect(legacyWrites()).toEqual([]);
    expect(st.pipeline).toBe(0);
  });

  it("no_match with the pointer already cleared: a concurrent finalizer published it — published, and the pipeline is NOT run twice", async () => {
    st.rpcAnswer = { data: "no_match", error: null };
    // the other finalizer's promote lands between this one's read and its call
    st.onRpc = () => { Object.assign(st.rows.documents[0], { pending_version_id: null, current_version_id: "v2" }); };
    expect(await fin()).toEqual({ published: true });
    expect(st.pipeline).toBe(0);
  });

  it("a refusal inside the call (the guard; a bookkeeping write that matched no row) is the answer — rolled back, never thrown, nothing else written", async () => {
    for (const message of [
      "Document has an active hold; release the hold before issuing it, or publish over it with Document Control's recorded override.",
      "The approved draft could not be relabeled to Rev 2, so nothing was published; the document is unchanged.",
    ]) {
      st.writes = [];
      st.rpcAnswer = { data: null, error: { code: "P0001", message } };
      const r = await fin();
      expect(r).toEqual({ published: false, reason: message });
      expect(st.writes).toEqual([]);
      expect(st.pipeline).toBe(0);
      // what the inspector shows (ReviewGateSection: finalizeReasonMessage(res.reason))
      expect(finalizeReasonMessage(r.reason)).toBe(`Couldn't publish: ${message}`);
    }
  });

  it("an answer the app does not recognise is never read as published", async () => {
    st.rpcAnswer = { data: null, error: null };
    const r = await fin();
    expect(r.published).toBe(false);
    expect(r.reason).toMatch(/could not be confirmed/);
    expect(st.pipeline).toBe(0);
  });

  it("regression — a database without the function (PGRST202 / 42883) takes the three checked writes, exactly as before the paste", async () => {
    for (const error of [{ code: "PGRST202", message: "Could not find the function public.finalize_reviewed_promote" }, { code: "42883", message: "function finalize_reviewed_promote does not exist" }]) {
      seed();
      st.writes = []; st.pipeline = 0;
      st.rpcAnswer = { data: null, error };
      expect(await fin()).toEqual({ published: true });
      const w = legacyWrites();
      expect(w.map((x) => `${x.table}:${Object.keys(x.payload as Row).includes("current_version_id") ? "promote" : "review_state" in (x.payload as Row) ? "relabel" : "supersede"}`))
        .toEqual(["documents:promote", "document_versions:relabel", "document_versions:supersede"]);
      expect(w[0].filters).toEqual([["id", "d1"], ["pending_version_id", "v2"], ["current_version_id", "v1"]]);
      expect(st.pipeline).toBe(1);
    }
  });

  it("the inspector's Publish button surfaces any refusal through finalizeReasonMessage (pinned by source)", () => {
    const src = readFileSync(join(process.cwd(), "components/documents/ReviewGateSection.tsx"), "utf8");
    expect(src).toContain("if (!res.published) { await appAlert({ tone: \"danger\", message: finalizeReasonMessage(res.reason) }); }");
  });
});
