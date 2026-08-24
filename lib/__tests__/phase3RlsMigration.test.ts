// Document-control Phase 3 permissive-RLS migration (DRLS-1, DCK-2, DCK-3).
//
// The enforcement is at the database (dropped policies + BEFORE UPDATE/DELETE
// trigger guards), so it can't be exercised from vitest without a live DB.
// These pins guard against the migration being weakened or removed, and
// against the exact regression the findings describe: the leftover permissive
// `*_member_all` policies must be dropped, and no migration may re-introduce
// one on these two tables.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const migDir = join(root, "supabase", "migrations");
const phase3 = readFileSync(join(migDir, "20261029_dc_phase3_permissive_rls.sql"), "utf8");

describe("Phase 3 RLS migration (DRLS-1 / DCK-2 / DCK-3)", () => {
  it("DRLS-1: drops both leftover permissive *_member_all policies", () => {
    expect(phase3).toMatch(/DROP POLICY IF EXISTS document_acknowledgments_member_all ON document_acknowledgments/);
    expect(phase3).toMatch(/DROP POLICY IF EXISTS document_review_signoffs_member_all ON document_review_signoffs/);
  });

  it("DCK-2: installs the checkout_sessions UPDATE/DELETE guard", () => {
    expect(phase3).toMatch(/CREATE TRIGGER trg_checkout_session_guard\s+BEFORE UPDATE OR DELETE ON checkout_sessions/);
    // The guard must gate outcome edits and deletes on the force_release cap.
    expect(phase3).toMatch(/checkout\.force_release/);
    expect(phase3).toMatch(/outcome\s+IS DISTINCT FROM OLD\.outcome/);
  });

  it("DCK-3: installs the documents lock-column guard", () => {
    expect(phase3).toMatch(/CREATE TRIGGER trg_document_lock_guard\s+BEFORE UPDATE ON documents/);
    expect(phase3).toMatch(/checked_out_by IS DISTINCT FROM OLD\.checked_out_by/);
    expect(phase3).toMatch(/current_lock_id IS DISTINCT FROM OLD\.current_lock_id/);
  });

  it("no NEW migration re-introduces a permissive member_all policy on the two hardened tables", () => {
    // The 20260819 loop is the historical source; any migration AFTER it that
    // creates a *_member_all policy on these tables would re-open DRLS-1.
    const offenders: string[] = [];
    for (const f of readdirSync(migDir).filter((n) => /^\d{8}/.test(n) && n.endsWith(".sql")).sort()) {
      // Only files strictly after the loop migration matter.
      if (f <= "20260819_orphan_tables_backfill.sql") continue;
      const txt = readFileSync(join(migDir, f), "utf8");
      for (const tbl of ["document_acknowledgments", "document_review_signoffs"]) {
        // A CREATE POLICY ... member_all ... ON <tbl> re-opens the hole.
        const re = new RegExp(`CREATE POLICY[^;]*${tbl}_member_all[^;]*ON ${tbl}`, "i");
        if (re.test(txt)) offenders.push(`${f}: ${tbl}`);
      }
    }
    expect(offenders, `A later migration re-created a permissive member_all policy:\n${offenders.join("\n")}`).toEqual([]);
  });
});
