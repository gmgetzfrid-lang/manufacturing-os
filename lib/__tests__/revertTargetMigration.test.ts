// Phase 7c — the revert-target gate inside publish_revision (REV-2).
//
// The RPC is SECURITY DEFINER and reachable directly, so the app-side
// assertRevertableTarget is not enough. These pins keep 20261034 from being
// weakened and prove the re-create carried the earlier gates forward.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "20261034_dc_phase7c_revert_target_gate.sql"),
  "utf8",
);

describe("Phase 7c revert-target gate (REV-2)", () => {
  it("a revert target must be a revision of THIS document", () => {
    expect(sql).toMatch(/t\.id = v_revert_target AND t\.record_id = p_doc/);
    expect(sql).toMatch(/revert target is not a revision of this document/);
  });

  it("an in-review/rejected draft or a branch can never be restored", () => {
    expect(sql).toMatch(/COALESCE\(t\.review_state, ''\) IN \('in_review', 'rejected'\)/);
    expect(sql).toMatch(/COALESCE\(t\.is_branch, FALSE\)/);
    expect(sql).toMatch(/only previously-issued revisions can be restored/);
  });

  it("the state check no-ops on a pre-review-schema database", () => {
    const gate = sql.slice(sql.indexOf("Revert-target gate"), sql.indexOf("v_label :="));
    expect(gate).toMatch(/EXCEPTION WHEN undefined_column THEN/);
  });

  it("the re-create carried the MOC gate and the stale-base check forward", () => {
    expect(sql).toMatch(/PSM requires an MOC reference/);
    expect(sql).toMatch(/'status', 'stale_base'/);
    expect(sql).toMatch(/v_doc\.current_version_id IS DISTINCT FROM p_expected_base/);
  });

  it("keeps the search_path pin on the re-created function", () => {
    expect(sql).toMatch(/SECURITY DEFINER SET search_path = public/);
  });
});
