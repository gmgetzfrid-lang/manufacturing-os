// document-control Round G — P33: DCK-15. A reviewed promote over another
// person's checkout (the publish guard's door (b), ratified under DEC-90 — a
// review stays finishable) tells the holder on their checkout thread and
// in-app, and records an audit row naming them (REVIEW_PROMOTED_OVER_CHECKOUT —
// routine, not publish_revision's destructive REV_LOCK_OVERRIDDEN), whichever door ran it
// (finalize_reviewed_promote, or promoteThreeStep before 20261151) — after
// the promote, never blocking it. A finalize the lock leg (20261245) refuses
// is answered in words that fit a review approver: ask the holder to check
// it in, then approve.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
const st = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  writes: [] as Array<{ table: string; op: string; payload: unknown }>,
  rpcAnswer: { data: "promoted", error: null } as { data: unknown; error: { code?: string; message: string } | null },
  audits: [] as Array<Record<string, unknown>>,
  notices: [] as Array<Record<string, unknown>>,
  threads: [] as Array<Record<string, unknown>>,
  notifyThrows: false,
  /** Runs inside the promote (e.g. the holder checks in meanwhile). */
  onPromote: null as null | (() => void),
  /** DCK-18 (P35): when set, answers each finalize_reviewed_promote call by its arguments
   *  (a database before 20261252 refuses the report flag). */
  rpcBy: null as null | ((args: Record<string, unknown>) => { data: unknown; error: { code?: string; message: string } | null }),
  rpcArgs: [] as Array<Record<string, unknown>>,
}));

function chain(table: string) {
  let op = "select";
  let payload: unknown;
  const filters: Array<[string, unknown]> = [];
  const matches = (r: Row) => filters.every(([k, v]) => r[k] === v);
  const c: Row = {};
  const finish = () => {
    if (op !== "select") {
      st.writes.push({ table, op, payload });
      const hit = (st.rows[table] ?? []).filter(matches);
      if (op === "update") for (const r of hit) Object.assign(r, payload as Row);
      if (table === "documents" && op === "update" && "current_version_id" in (payload as Row)) st.onPromote?.();
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    }
    return { data: (st.rows[table] ?? []).filter(matches), error: null };
  };
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(finish()).then(res, rej);
      return (...args: unknown[]) => {
        if (prop === "update" || prop === "insert" || prop === "delete") { op = prop; payload = args[0]; }
        if (prop === "eq" || prop === "is") filters.push([String(args[0]), args[1]]);
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
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      if (fn === "finalize_reviewed_promote") {
        st.rpcArgs.push(args);
        const answer = st.rpcBy ? st.rpcBy(args) : st.rpcAnswer;
        if (!answer.error && typeof answer.data === "string" && answer.data.startsWith("promoted")) {
          const d = (st.rows.documents ?? [])[0];
          if (d) { d.current_version_id = d.pending_version_id; d.pending_version_id = null; }
          st.onPromote?.();
        }
        return answer;
      }
      return { data: null, error: null };
    },
  },
}));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async (a: Record<string, unknown>) => { st.audits.push(a); return { error: null, ok: true }; }) }));
vi.mock("@/lib/inAppNotifications", () => ({
  notify: vi.fn(async (n: Record<string, unknown>) => {
    if (st.notifyThrows) throw new Error("notify down");
    st.notices.push(n);
    return true;
  }),
}));
vi.mock("@/lib/checkoutEpisodes", () => ({
  getActiveEpisode: vi.fn(async () => ({ id: "ep1" })),
  postEpisodeSystemMessage: vi.fn(async (m: Record<string, unknown>) => { st.threads.push(m); }),
}));
vi.mock("@/lib/postPublish", () => ({ runPostPublishSideEffects: vi.fn(async () => undefined) }));
vi.mock("@/lib/effectiveDate", () => ({ applyEffectiveDate: vi.fn(async () => undefined) }));
vi.mock("@/lib/intents", () => ({ recordIntent: vi.fn(async () => undefined) }));
vi.mock("@/lib/checklists", () => ({ sweepEvidenceForDocument: vi.fn(async () => ({ projects: 0 })) }));

import { finalizeReviewedRevision, finalizeReasonMessage, finalizeLockRefusalHolder, isFinalizeHoldRefusal, readPromoteReport } from "@/lib/reviewControl";
import { auditActionDef, isDestructiveAuditAction } from "@/lib/auditActions";
import { summarizeAudit } from "@/lib/timeline";

function seed(holder: string | null = "drafter1") {
  st.rows = {
    documents: [{
      id: "d1", library_id: "l1", rev: "1", status: "Issued", current_version_id: "v1", pending_version_id: "v2", document_number: "P-101",
      checked_out_by: holder, checked_out_by_name: holder ? "Dana Drafter" : null,
    }],
    document_versions: [
      { id: "v1", record_id: "d1", revision_label: "1" },
      { id: "v2", record_id: "d1", revision_label: "2A", base_rev: "2", review_state: "in_review", supersedes_version_id: "v1", effective_date: null },
    ],
    document_review_signoffs: [],
  };
}
const fin = (actorId = "ctl1") => finalizeReviewedRevision({ orgId: "o1", documentId: "d1", actorId, actorName: "ctl@example.com", actorEmail: "ctl@example.com", requireRosterComplete: false });
const passes = () => st.audits.filter((a) => a.action === "REVIEW_PROMOTED_OVER_CHECKOUT");

beforeEach(() => {
  seed();
  st.writes = []; st.audits = []; st.notices = []; st.threads = [];
  st.rpcAnswer = { data: "promoted", error: null };
  st.notifyThrows = false;
  st.onPromote = null;
  st.rpcBy = null;
  st.rpcArgs = [];
});

describe("DCK-15 — a reviewed promote over someone else's checkout tells the holder and records the pass", () => {
  it("through finalize_reviewed_promote: the holder gets a thread note and an in-app notice (the existing kind), and a REVIEW_PROMOTED_OVER_CHECKOUT row (via review_promote, with the actor's email) names them — the publish lands as before", async () => {
    const r = await fin();
    expect(r).toEqual({ published: true });
    expect(st.threads).toHaveLength(1);
    expect(st.threads[0]).toMatchObject({ orgId: "o1", documentId: "d1", episodeId: "ep1" });
    expect(String(st.threads[0].text)).toContain("ctl@example.com published the reviewed Rev 2 (reviewed as 2A) while you have this checked out — your checkout stays open.");
    expect(st.notices).toHaveLength(1);
    expect(st.notices[0]).toMatchObject({
      orgId: "o1", userId: "drafter1", kind: "revision_published_over_checkout", resourceType: "document", resourceId: "d1",
      link: "/documents/l1?doc=d1", actorUserId: "ctl1", metadata: { newVersionId: "v2", newRev: "2", via: "review_promote" },
    });
    expect(passes()).toHaveLength(1);
    expect(passes()[0]).toMatchObject({
      resourceType: "document", resourceId: "d1", orgId: "o1", userId: "ctl1", userEmail: "ctl@example.com",
      details: { via: "review_promote", holderUserId: "drafter1", holderName: "Dana Drafter", versionId: "v2", previousVersionId: "v1", revisionLabel: "2" },
    });
    expect(st.audits.map((a) => a.action)).toContain("REVISION_PUBLISHED_AFTER_REVIEW");
    // the routine door (b) is not publish_revision's override / force
    expect(st.audits.map((a) => a.action)).not.toContain("REV_LOCK_OVERRIDDEN");
  });

  it("the record is a routine revisions event, not a 'Destructive / undo / force' one, and the history reads it in words", () => {
    expect(auditActionDef("REVIEW_PROMOTED_OVER_CHECKOUT")).toMatchObject({ category: "revisions", destructive: false });
    expect(isDestructiveAuditAction("REVIEW_PROMOTED_OVER_CHECKOUT")).toBe(false);
    // REGRESSION: publish_revision's override / force keeps its destructive class
    expect(isDestructiveAuditAction("REV_LOCK_OVERRIDDEN")).toBe(true);
    expect(summarizeAudit({ action: "REVIEW_PROMOTED_OVER_CHECKOUT", details: { revisionLabel: "2", holderName: "Dana Drafter", via: "review_promote" } }))
      .toBe("Reviewed Rev 2 published while Dana Drafter had it checked out (their checkout stays open)");
    expect(summarizeAudit({ action: "REVIEW_PROMOTED_OVER_CHECKOUT", details: {} }))
      .toBe("Reviewed revision published while another person had it checked out (their checkout stays open)");
  });

  it("through promoteThreeStep (a database without finalize_reviewed_promote, PGRST202): the same notice and the same record", async () => {
    st.rpcAnswer = { data: null, error: { code: "PGRST202", message: "Could not find the function public.finalize_reviewed_promote" } };
    const r = await fin();
    expect(r).toEqual({ published: true });
    expect(st.writes.some((w) => w.table === "documents" && w.op === "update" && (w.payload as Row).current_version_id === "v2")).toBe(true);
    expect(st.notices).toHaveLength(1);
    expect(st.notices[0]).toMatchObject({ userId: "drafter1", kind: "revision_published_over_checkout" });
    expect(passes()).toHaveLength(1);
    expect(passes()[0].details).toMatchObject({ via: "review_promote", holderUserId: "drafter1" });
  });

  it("REGRESSION: the holder's own promote, an unlocked document, and a checkout released before the promote landed are not reported — and nothing else changes", async () => {
    expect(await fin("drafter1")).toEqual({ published: true });
    seed(null);
    expect(await fin()).toEqual({ published: true });
    seed("drafter1");
    st.onPromote = () => { const d = st.rows.documents[0]; d.checked_out_by = null; d.checked_out_by_name = null; };
    expect(await fin()).toEqual({ published: true });
    expect(st.notices).toEqual([]);
    expect(st.threads).toEqual([]);
    expect(passes()).toEqual([]);
  });

  it("never blocks: a notice that cannot be sent leaves the publish landed (and logged)", async () => {
    st.notifyThrows = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await fin();
    expect(r).toEqual({ published: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a refused or conflicting promote tells nobody (nothing passed the checkout)", async () => {
    st.rpcAnswer = { data: null, error: { code: "42501", message: "This document is checked out by Dana Drafter, so a new revision can't be made current here; publish it from the revision flow with an override reason (shown to them and recorded), or ask them to check it in first." } };
    const r = await fin();
    expect(r.published).toBe(false);
    st.rpcAnswer = { data: "no_match", error: null };
    expect((await fin()).published).toBe(false);
    expect(st.notices).toEqual([]);
    expect(passes()).toEqual([]);
  });
});

describe("DCK-15 — the lock leg's refusal, in words that fit the door", () => {
  // the guard's sentence, read from 20261245 itself ('' → ', the holder substituted for %)
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "20261245_dc_roundG_publish_guard_lock_leg.sql"), "utf8");
  const raw = /'(This document is checked out by %[^']*(?:''[^']*)*)'/.exec(sql)![1].replace(/''/g, "'");
  const sentence = raw.replace("%", "Dana Drafter");

  it("the guard's sentence is recognised, the holder read out of it", () => {
    expect(finalizeLockRefusalHolder(sentence)).toBe("Dana Drafter");
    expect(finalizeLockRefusalHolder(raw.replace("%", "another user"))).toBe("another user");
    expect(finalizeLockRefusalHolder("Document has an active hold; release the hold before publishing a new revision.")).toBeNull();
    expect(finalizeLockRefusalHolder(undefined)).toBeNull();
  });

  it("finalizeReasonMessage (shared by ReviewGateSection and the Intake tab) says: ask the holder to check it in, then approve — never the revision flow's override", () => {
    const msg = finalizeReasonMessage(sentence);
    expect(msg).toBe("This document is checked out by Dana Drafter, so the reviewed revision was not published and nothing was changed. Ask the holder to check it in, then approve it again — the review stands.");
    expect(msg).not.toMatch(/override/);
    expect(isFinalizeHoldRefusal(sentence)).toBe(false);
  });

  it("REGRESSION: the other refusals read as before", () => {
    expect(finalizeReasonMessage("incomplete")).toBe("Not all required reviewers have signed off yet.");
    expect(finalizeReasonMessage("Document has an active hold; release the hold before publishing a new revision.")).toContain("Release the hold, then publish the reviewed revision");
    expect(finalizeReasonMessage("something else")).toBe("Couldn't publish: something else");
  });

  it("the Intake tab answers its refused approve through finalizeReasonMessage (no copy of its own to drift)", () => {
    const panel = readFileSync(join(process.cwd(), "components", "projects", "IntakePanel.tsx"), "utf8");
    expect(panel).toContain("throw new Error(finalizeReasonMessage(res.reason));");
  });
});

describe("DCK-18 (P35) — the database records the pass and tells the holder; the app writes only what it did not", () => {
  it("the app asks for the report (p_report_over_checkout) on every finalize", async () => {
    await fin();
    expect(st.rpcArgs[0]).toMatchObject({ p_document_id: "d1", p_pending_id: "v2", p_expected_current: "v1", p_base_rev: "2", p_actor: "ctl1", p_report_over_checkout: true });
  });

  it("both written by the database ('promoted_over_checkout_recorded_told'): no second notice, no second record — the holder's thread note (which the database does not write) is still posted, and the publish lands as before", async () => {
    st.rpcAnswer = { data: "promoted_over_checkout_recorded_told", error: null };
    expect(await fin()).toEqual({ published: true });
    expect(st.notices).toEqual([]);
    expect(passes()).toEqual([]);
    expect(st.threads).toHaveLength(1);
    expect(st.audits.map((a) => a.action)).toContain("REVISION_PUBLISHED_AFTER_REVIEW");
  });

  it("one of the two missing: the app writes exactly that one (a notice the database could not write; a record it could not write); neither: the app writes both, as since P33", async () => {
    st.rpcAnswer = { data: "promoted_over_checkout_recorded", error: null };
    expect(await fin()).toEqual({ published: true });
    expect(st.notices).toHaveLength(1);
    expect(st.notices[0]).toMatchObject({ userId: "drafter1", kind: "revision_published_over_checkout", metadata: { via: "review_promote" } });
    expect(passes()).toEqual([]);

    seed(); st.notices = []; st.audits = []; st.threads = [];
    st.rpcAnswer = { data: "promoted_over_checkout_told", error: null };
    expect(await fin()).toEqual({ published: true });
    expect(st.notices).toEqual([]);
    expect(passes()).toHaveLength(1);
    expect(passes()[0].details).toMatchObject({ via: "review_promote", holderUserId: "drafter1" });

    seed(); st.notices = []; st.audits = []; st.threads = [];
    st.rpcAnswer = { data: "promoted_over_checkout", error: null };
    expect(await fin()).toEqual({ published: true });
    expect(st.notices).toHaveLength(1);
    expect(passes()).toHaveLength(1);
    expect(st.threads).toHaveLength(1);
  });

  it("'promoted_clear' — the database read the checkout in the promote and nobody else held it: nothing is told or recorded, even if the app's earlier read named a holder", async () => {
    st.rpcAnswer = { data: "promoted_clear", error: null };
    expect(await fin()).toEqual({ published: true });
    expect(st.notices).toEqual([]);
    expect(st.threads).toEqual([]);
    expect(passes()).toEqual([]);
  });

  it("a checkout the database saw but the app's earlier read did not (taken between the read and the promote): the app re-reads the holder and writes what the database did not", async () => {
    seed(null);
    st.onPromote = () => { const d = st.rows.documents[0]; d.checked_out_by = "drafter2"; d.checked_out_by_name = "Dee Drafter"; };
    st.rpcAnswer = { data: "promoted_over_checkout_told", error: null };
    expect(await fin()).toEqual({ published: true });
    expect(st.notices).toEqual([]);
    expect(passes()).toHaveLength(1);
    expect(passes()[0].details).toMatchObject({ holderUserId: "drafter2", holderName: "Dee Drafter" });
  });

  it("REGRESSION — before 20261252 (the report flag unknown: PGRST202 / 42883): the call is made again without it, exactly as before, and the app tells and records as since P33", async () => {
    for (const code of ["PGRST202", "42883"]) {
      seed(); st.notices = []; st.audits = []; st.threads = []; st.rpcArgs = [];
      st.rpcBy = (args) => ("p_report_over_checkout" in args
        ? { data: null, error: { code, message: "Could not find the function public.finalize_reviewed_promote(p_actor, p_base_rev, p_document_id, p_expected_current, p_pending_id, p_report_over_checkout) in the schema cache" } }
        : { data: "promoted", error: null });
      expect(await fin()).toEqual({ published: true });
      expect(st.rpcArgs).toHaveLength(2);
      expect(Object.keys(st.rpcArgs[1]).sort()).toEqual(["p_actor", "p_base_rev", "p_document_id", "p_expected_current", "p_pending_id"]);
      expect(st.notices).toHaveLength(1);
      expect(passes()).toHaveLength(1);
      expect(st.threads).toHaveLength(1);
    }
  });

  it("an app before P35 after the paste (a plain 'promoted' — no report): the app writes both, as it always did (the deploy order is stated: app with or before the paste)", async () => {
    st.rpcAnswer = { data: "promoted", error: null };
    expect(await fin()).toEqual({ published: true });
    expect(st.notices).toHaveLength(1);
    expect(passes()).toHaveLength(1);
  });

  it("readPromoteReport: the five reporting answers of 20261252 (read from the migration), nothing else — the plain 'promoted' is no report, and an unknown answer is never read as published", async () => {
    const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "20261252_dc_roundG_door_b_record.sql"), "utf8");
    expect(sql).toContain("RETURN CASE WHEN NOT v_over THEN 'promoted_clear'");
    expect(sql).toContain("ELSE 'promoted_over_checkout'\n                     || CASE WHEN v_recorded THEN '_recorded' ELSE '' END\n                     || CASE WHEN v_told THEN '_told' ELSE '' END");
    expect(readPromoteReport("promoted_clear")).toEqual({ overCheckout: false, recorded: false, told: false });
    expect(readPromoteReport("promoted_over_checkout")).toEqual({ overCheckout: true, recorded: false, told: false });
    expect(readPromoteReport("promoted_over_checkout_recorded")).toEqual({ overCheckout: true, recorded: true, told: false });
    expect(readPromoteReport("promoted_over_checkout_told")).toEqual({ overCheckout: true, recorded: false, told: true });
    expect(readPromoteReport("promoted_over_checkout_recorded_told")).toEqual({ overCheckout: true, recorded: true, told: true });
    for (const x of ["promoted", "no_match", "promoted_over_checkout_told_recorded", "promoted_over", null, 1]) expect(readPromoteReport(x)).toBeNull();
    st.rpcAnswer = { data: "promoted_over_checkout_told_recorded", error: null };
    const r = await fin();
    expect(r.published).toBe(false);
    expect(r.reason).toMatch(/could not be confirmed/);
  });
});
