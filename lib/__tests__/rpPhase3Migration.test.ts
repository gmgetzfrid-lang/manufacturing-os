// Roles-and-permissions Phase 3 — the publish path at the database
// (OWN-1, OWN-2/DEC-6, OWN-5). Shape pins on 20261036, every assertion
// scoped to its own statement (the Phase-7a mutation lesson).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "20261036_rp_phase3_publish_path.sql"),
  "utf8",
);

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}

const libGuard = between(sql, "CREATE OR REPLACE FUNCTION enforce_library_sensitive_columns",
  "DROP TRIGGER IF EXISTS trg_library_sensitive_columns");
const docGuard = between(sql, "CREATE OR REPLACE FUNCTION documents_guard_access_change",
  "CREATE OR REPLACE FUNCTION publish_revision");
const rpc = between(sql, "CREATE OR REPLACE FUNCTION publish_revision", "COMMENT ON FUNCTION publish_revision");

const SENSITIVE = [
  "owner_user_id", "owner_name", "owner_team_id", "acl", "acl_index",
  "write_access", "admin_access", "read_access", "visible_to",
  "folder_security", "default_new_acl", "default_new_visibility",
  "review_control", "review_policy", "retention_policy", "ack_policy", "recert_policy",
];

describe("library sensitive-column guard (OWN-1)", () => {
  it("guards every sensitive column by name", () => {
    for (const col of SENSITIVE) {
      expect(libGuard, `missing column: ${col}`)
        .toMatch(new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM OLD\\.${col}`));
    }
  });

  it("authority is controller OR current owner OR ACL manage-grant, with service pass", () => {
    expect(libGuard).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
    expect(libGuard).toMatch(/is_org_controller\(OLD\.org_id\)/);
    expect(libGuard).toMatch(/OLD\.owner_user_id::text IS DISTINCT FROM auth\.uid\(\)::text/);
    expect(libGuard).toMatch(/can_manage_node\(OLD\.acl_index, OLD\.org_id\)/);
  });

  it("fires BEFORE UPDATE and DELETE is a RESTRICTIVE controllers-only policy", () => {
    expect(sql).toMatch(/CREATE TRIGGER trg_library_sensitive_columns\s*\nBEFORE UPDATE ON libraries/);
    const del = between(sql, "CREATE POLICY libraries_delete_controllers", ";");
    expect(del).toMatch(/AS RESTRICTIVE FOR DELETE USING \(is_org_controller\(org_id\)\)/);
  });
});

describe("documents ownership guard (OWN-2 / DEC-6)", () => {
  it("carries the original visibility/acl block unchanged", () => {
    expect(docGuard).toMatch(/NEW\.visibility IS DISTINCT FROM OLD\.visibility/);
    expect(docGuard).toMatch(/Not permitted to change document visibility or access control/);
  });

  it("owner changes need controller, manage-grant, or the CURRENT owner", () => {
    expect(docGuard).toMatch(/NEW\.owner_user_id IS DISTINCT FROM OLD\.owner_user_id/);
    expect(docGuard).toMatch(/NEW\.owner_name IS DISTINCT FROM OLD\.owner_name/);
    expect(docGuard).toMatch(/OLD\.owner_user_id::text IS DISTINCT FROM auth\.uid\(\)::text/);
    expect(docGuard).toMatch(/Not permitted to change this document''s owner/);
  });

  it("first assignment on an unowned, unrestricted document stays open (DEC-6)", () => {
    expect(docGuard).toMatch(/OLD\.owner_user_id IS NULL\s*\n\s*AND OLD\.acl_index IS NULL\s*\n\s*AND COALESCE\(OLD\.visibility, 'normal'\) = 'normal'/);
  });
});

describe("publish_revision actor + branch authority (OWN-5)", () => {
  it("derives the actor from the session and refuses a forged p_actor", () => {
    expect(rpc).toMatch(/p_actor := auth\.uid\(\);/);
    expect(rpc).toMatch(/p_actor does not match the calling session/);
    expect(rpc).toMatch(/a service-role call must name its actor/);
  });

  it("the branch insert carries the same publish-authority bar as a promote", () => {
    const branchGate = between(rpc, "IF p_as_branch AND auth.uid() IS NOT NULL", "END IF;");
    expect(branchGate).toMatch(/user_can_publish_on_library\(v_doc\.library_id, p_actor::text, v_doc\.org_id\)/);
    expect(branchGate).toMatch(/user_is_effective_owner\(v_doc\.owner_user_id, v_doc\.collection_id, v_doc\.library_id, p_actor\)/);
  });

  it("EXECUTE is revoked from PUBLIC and granted to authenticated + service_role", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION publish_revision[\s\S]{0,200}FROM PUBLIC;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION publish_revision[\s\S]{0,200}TO authenticated, service_role;/);
  });

  it("the earlier gates all survived the re-create", () => {
    expect(rpc).toMatch(/'status', 'stale_base'/);
    expect(rpc).toMatch(/PSM requires an MOC reference/);
    expect(rpc).toMatch(/only previously-issued revisions can be restored/);
    expect(rpc).toMatch(/SECURITY DEFINER SET search_path = public/);
  });
});

describe("app halves are wired (source pins)", () => {
  it("the v1 downgrade retry is retired — no override-to-force upgrade remains", () => {
    const src = readFileSync(join(process.cwd(), "lib", "revisions.ts"), "utf8");
    expect(src).not.toMatch(/p_force = args\.p_force === true \|\| p_override_lock/);
  });

  it("the intake route gates auto-supersede on holds, checkout and the creator's authority", () => {
    const src = readFileSync(join(process.cwd(), "app", "api", "intake", "upload", "route.ts"), "utf8");
    expect(src).toMatch(/document_holds/);
    expect(src).toMatch(/the hold status could not be verified/); // fail closed
    expect(src).toMatch(/checked_out_by/);
    expect(src).toMatch(/user_can_publish_on_library/);
    // A never-reviewed external upload is not "approved".
    expect(src).not.toMatch(/review_state: autoNow \? "approved"/);
    expect(src).toMatch(/review_state: autoNow \? null : "in_review"/);
  });
});
