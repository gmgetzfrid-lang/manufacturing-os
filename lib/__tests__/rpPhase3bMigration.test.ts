// Roles-and-permissions Phase 3b — ownership carries read access (GAP-15 /
// DEC-7) and the document_versions integrity overlay (EGRESS-6). Shape pins
// on 20261037, every assertion scoped to its own statement.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations",
    "20261037_rp_phase3b_read_ownership_and_version_integrity.sql"),
  "utf8",
);

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}

const sixArg = between(sql, "CREATE OR REPLACE FUNCTION node_visible(\n  p_visibility text,\n  p_acl_index  jsonb,\n  p_org        uuid,\n  p_owner",
  "-- The 3-arg form stays");
const insertOverlay = between(sql, "CREATE POLICY document_versions_insert_integrity",
  "DROP POLICY IF EXISTS document_versions_update_integrity");
const updateOverlay = between(sql, "CREATE POLICY document_versions_update_integrity", "COMMIT;");

describe("node_visible ownership branch (GAP-15 / DEC-7)", () => {
  it("the branch sits AFTER the controller short-circuit and BEFORE the acl_index check", () => {
    const controller = sixArg.indexOf("IF v_role IN ('Admin', 'DocCtrl') THEN");
    const owner = sixArg.indexOf("user_is_effective_owner(p_owner, p_collection, p_library");
    const aclNull = sixArg.indexOf("IF p_acl_index IS NULL THEN");
    expect(controller).toBeGreaterThan(-1);
    expect(owner).toBeGreaterThan(controller);
    expect(aclNull).toBeGreaterThan(owner);
  });

  it("the 3-arg wrapper delegates — one body to maintain", () => {
    const wrapper = between(sql, "-- The 3-arg form stays", "doc_is_visible");
    expect(wrapper).toMatch(/SELECT node_visible\(p_visibility, p_acl_index, p_org, NULL::uuid, NULL::uuid, NULL::uuid\);/);
  });

  it("doc_is_visible forwards the owner cascade (the file_url gate)", () => {
    const f = between(sql, "CREATE OR REPLACE FUNCTION doc_is_visible", "DROP POLICY IF EXISTS documents_acl_select");
    expect(f).toMatch(/d\.owner_user_id, d\.collection_id, d\.library_id/);
  });

  it("documents, collections and shares policies all pass owner columns", () => {
    const docs = between(sql, "CREATE POLICY documents_acl_select", ";");
    expect(docs).toMatch(/owner_user_id, collection_id, library_id/);
    const cols = between(sql, "CREATE POLICY collections_acl_select", ";");
    expect(cols).toMatch(/owner_user_id, NULL, library_id/);
    const shares = between(sql, "CREATE POLICY document_shares_insert", "-- ── EGRESS-6");
    expect(shares).toMatch(/d\.owner_user_id, d\.collection_id, d\.library_id/);
    // The 20261026 anchor stays byte-carried.
    expect(shares).toMatch(/document_shares\.created_by = auth\.uid\(\)/);
  });
});

describe("document_versions integrity overlay (EGRESS-6)", () => {
  it("publisher-grade arm uses the same three authorities as the publish guard", () => {
    const helper = between(sql, "CREATE OR REPLACE FUNCTION user_can_publish_doc", "-- INSERT:");
    expect(helper).toMatch(/is_org_controller\(p_org\)/);
    expect(helper).toMatch(/user_can_publish_on_library\(d\.library_id, auth\.uid\(\)::text, p_org\)/);
    expect(helper).toMatch(/user_is_effective_owner\(d\.owner_user_id, d\.collection_id, d\.library_id, auth\.uid\(\)\)/);
  });

  it("INSERT: author arm admits only an unreleased draft or a FIRST version", () => {
    expect(insertOverlay).toMatch(/AS RESTRICTIVE FOR INSERT/);
    expect(insertOverlay).toMatch(/created_by = auth\.uid\(\)/);
    expect(insertOverlay).toMatch(/review_state = 'in_review' AND released_at IS NULL/);
    expect(insertOverlay).toMatch(/NOT EXISTS \(SELECT 1 FROM document_versions v2/);
  });

  it("UPDATE: the author arm can never leave review, and the external arm can reject but never release", () => {
    expect(updateOverlay).toMatch(/AS RESTRICTIVE FOR UPDATE/);
    // Author WITH CHECK: still in_review, still unreleased.
    expect(updateOverlay).toMatch(/created_by = auth\.uid\(\) AND review_state = 'in_review' AND released_at IS NULL/);
    // External arm: in_review → rejected only, unreleased, intake-anchored.
    expect(updateOverlay).toMatch(/review_state IN \('in_review', 'rejected'\) AND provenance = 'external'/);
    expect(updateOverlay).toMatch(/intake_link_id IS NOT NULL AND released_at IS NULL/);
  });

  it("search_path pinned on all four (re)created functions", () => {
    const pins = sql.match(/SECURITY DEFINER SET search_path = public/g) ?? [];
    expect(pins.length).toBe(4);
  });
});

describe("the loud-writer prerequisites are in place (source pins)", () => {
  it("finalize relabel and supersede stamps are checked", () => {
    const src = readFileSync(join(process.cwd(), "lib", "reviewControl.ts"), "utf8");
    expect(src).toMatch(/could not be relabeled to Rev/);
    expect(src).toMatch(/could not be marked superseded/);
  });

  it("label correction and intake rejection refuse zero rows", () => {
    const rev = readFileSync(join(process.cwd(), "lib", "revisions.ts"), "utf8");
    expect(rev).toMatch(/The label was NOT corrected/);
    const intake = readFileSync(join(process.cwd(), "components", "projects", "IntakePanel.tsx"), "utf8");
    expect(intake).toMatch(/the write was refused/);
  });

  it("provenance verification surfaces refusal", () => {
    const q = readFileSync(join(process.cwd(), "components", "documents", "DocControlQueue.tsx"), "utf8");
    expect(q).toMatch(/Verification was refused/);
  });
});
