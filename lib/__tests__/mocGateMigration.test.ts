// Phase 5 — the PSM MOC gate at the database (DCK-1).
//
// The enforcement is a plpgsql block inside publish_revision; these pins keep
// the migration from being weakened and document the three load-bearing rules:
// only DECLARED drawings are gated, the Minor/Correction exemption is decided
// server-side, and a REVERT is never minor-like (revertToVersion hardcodes
// change_type 'Correction' — a naive exemption would waive every revert).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "20261031_dc_phase5_moc_gate.sql"),
  "utf8",
);

describe("Phase 5 MOC-gate migration (DCK-1)", () => {
  it("gates content publishes of drawing-class documents on moc_reference", () => {
    expect(sql).toMatch(/IF p_op_class = 'content' THEN/);
    expect(sql).toMatch(/v_doc_class = 'drawing' AND NOT v_minor_like/);
    expect(sql).toMatch(/PSM requires an MOC reference/);
  });

  it("resolves doc_class through the document → folder → library cascade", () => {
    expect(sql).toMatch(/NULLIF\(v_doc\.doc_class, ''\)/);
    expect(sql).toMatch(/FROM collections c WHERE c\.id = v_doc\.collection_id/);
    expect(sql).toMatch(/FROM libraries l WHERE l\.id = v_doc\.library_id/);
  });

  it("a revert is never minor-like, whatever change_type it declares", () => {
    expect(sql).toMatch(/v_is_revert := NULLIF\(p_version->>'reverted_from_version_id', ''\) IS NOT NULL/);
    expect(sql).toMatch(/AND NOT v_is_revert/);
  });

  it("tolerates a pre-20261012 database (no doc_class columns) by no-opping", () => {
    expect(sql).toMatch(/EXCEPTION WHEN undefined_column THEN/);
  });

  it("keeps the search_path pin on the re-created function", () => {
    expect(sql).toMatch(/SECURITY DEFINER SET search_path = public/);
  });
});
