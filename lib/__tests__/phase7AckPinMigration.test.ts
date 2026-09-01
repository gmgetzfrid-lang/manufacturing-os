// Phase 7 — acknowledgment and pin integrity at the database (DIST-3, PKG-5).
//
// Shape pins on 20261032 (rails) and 20261033 (guard patches) so neither
// migration can be quietly weakened:
//   · distribution_acks — rows cannot be born acknowledged, identity is
//     immutable, only the named recipient stamps acknowledged_at, and the
//     forensic acknowledged_by column is trigger-owned.
//   · work_package_documents — the pins behind the PUBLIC field verdict:
//     INSERT binds package AND document to the row's org, UPDATE/DELETE need
//     the package owner or a controller, and a pin may only name a revision
//     of the row's own document — enforced on INSERT and UPDATE alike.
//
// Every assertion is scoped to a SLICE of the file bounded by the next
// statement — the Phase-7a self-audit proved (by mutation) that unbounded
// regexes here were satisfied by the verification block at the bottom of the
// migration, letting a deleted guard go unnoticed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (name: string) =>
  readFileSync(join(process.cwd(), "supabase", "migrations", name), "utf8");

const sql = read("20261032_dc_phase7_ack_and_pin_integrity.sql");
const patch = read("20261033_dc_phase7b_guard_patches.sql");

/** The slice of `text` from `from` up to `to` — both must exist. */
function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}

// ── 20261032 slices ──────────────────────────────────────────────────────────
const ackInsertPolicy = between(sql, "CREATE POLICY distribution_acks_org_insert",
  "CREATE OR REPLACE FUNCTION enforce_distribution_ack_guard");
const ackGuardFn = between(sql, "CREATE OR REPLACE FUNCTION enforce_distribution_ack_guard",
  "DROP TRIGGER IF EXISTS trg_distribution_ack_guard");
const wpdInsertPolicy = between(sql, "CREATE POLICY work_package_documents_org_insert",
  "DROP POLICY IF EXISTS work_package_documents_org_update");
const wpdUpdatePolicy = between(sql, "CREATE POLICY work_package_documents_org_update",
  "DROP POLICY IF EXISTS work_package_documents_org_delete");
const wpdDeletePolicy = between(sql, "CREATE POLICY work_package_documents_org_delete",
  "CREATE OR REPLACE FUNCTION enforce_wpd_pin_guard");
const wpdGuardFn = between(sql, "CREATE OR REPLACE FUNCTION enforce_wpd_pin_guard",
  "DROP TRIGGER IF EXISTS trg_wpd_pin_guard");

describe("distribution_acks rails (DIST-3, 20261032)", () => {
  it("INSERT forbids rows born acknowledged — in the policy itself", () => {
    expect(ackInsertPolicy).toMatch(/acknowledged_at IS NULL/);
  });

  it("guard fires BEFORE UPDATE and lets service-role writes pass", () => {
    expect(sql).toMatch(/CREATE TRIGGER trg_distribution_ack_guard\s*\nBEFORE UPDATE ON distribution_acks/);
    expect(ackGuardFn).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
  });

  it("row identity is immutable — every identity column, in the guard body", () => {
    for (const col of ["recipient_user_id", "version_id", "document_id", "org_id"]) {
      expect(ackGuardFn).toMatch(new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM OLD\\.${col}`));
    }
    expect(ackGuardFn).toMatch(/immutable in identity/);
  });

  it("only the named recipient stamps, and the stamper is recorded", () => {
    expect(ackGuardFn).toMatch(/NEW\.acknowledged_at IS DISTINCT FROM OLD\.acknowledged_at/);
    expect(ackGuardFn).toMatch(/OLD\.recipient_user_id::text <> auth\.uid\(\)::text/);
    expect(ackGuardFn).toMatch(/NEW\.acknowledged_by := auth\.uid\(\)/);
  });
});

describe("work_package_documents rails (PKG-5, 20261032)", () => {
  it("INSERT binds the referenced package AND document to the row's org", () => {
    expect(wpdInsertPolicy).toMatch(/p\.id = work_package_documents\.package_id\s*\n\s*AND p\.org_id = work_package_documents\.org_id/);
    expect(wpdInsertPolicy).toMatch(/d\.id = work_package_documents\.document_id\s*\n\s*AND d\.org_id = work_package_documents\.org_id/);
  });

  it("UPDATE requires the package owner or Admin/DocCtrl — in the UPDATE policy itself", () => {
    expect(wpdUpdatePolicy).toMatch(/p\.owner_user_id = auth\.uid\(\)/);
    expect(wpdUpdatePolicy).toMatch(/ARRAY\['Admin','DocCtrl'\]/);
  });

  it("DELETE requires the package owner or Admin/DocCtrl — in the DELETE policy itself", () => {
    expect(wpdDeletePolicy).toMatch(/p\.owner_user_id = auth\.uid\(\)/);
    expect(wpdDeletePolicy).toMatch(/ARRAY\['Admin','DocCtrl'\]/);
  });

  it("a pin may only name a revision of this row's own document, in-org", () => {
    expect(wpdGuardFn).toMatch(/NEW\.pinned_version_id IS DISTINCT FROM OLD\.pinned_version_id/);
    expect(wpdGuardFn).toMatch(/v\.record_id = NEW\.document_id/);
    expect(wpdGuardFn).toMatch(/v\.org_id = NEW\.org_id/);
  });

  it("membership identity is immutable — every identity column, in the guard body", () => {
    for (const col of ["package_id", "document_id", "org_id"]) {
      expect(wpdGuardFn).toMatch(new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM OLD\\.${col}`));
    }
  });
});

// ── 20261033 slices (the definitions actually live after the patch) ──────────
const ackGuardFn2 = between(patch, "CREATE OR REPLACE FUNCTION enforce_distribution_ack_guard",
  "CREATE OR REPLACE FUNCTION enforce_wpd_pin_guard");
const wpdGuardFn2 = between(patch, "CREATE OR REPLACE FUNCTION enforce_wpd_pin_guard",
  "DROP TRIGGER IF EXISTS trg_wpd_pin_guard");

describe("guard patches (Phase 7b, 20261033)", () => {
  it("acknowledged_by is trigger-owned: every user-path write starts from OLD", () => {
    expect(ackGuardFn2).toMatch(/NEW\.acknowledged_by := OLD\.acknowledged_by/);
    // …and the freeze comes BEFORE the transition branch that legitimately sets it.
    expect(ackGuardFn2.indexOf("NEW.acknowledged_by := OLD.acknowledged_by"))
      .toBeLessThan(ackGuardFn2.indexOf("NEW.acknowledged_by := auth.uid()"));
  });

  it("the patched ack guard keeps recipient-only stamping and full identity immutability", () => {
    expect(ackGuardFn2).toMatch(/OLD\.recipient_user_id::text <> auth\.uid\(\)::text/);
    for (const col of ["recipient_user_id", "version_id", "document_id", "org_id"]) {
      expect(ackGuardFn2).toMatch(new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM OLD\\.${col}`));
    }
  });

  it("the pin guard now fires BEFORE INSERT OR UPDATE and validates inserted pins", () => {
    expect(patch).toMatch(/CREATE TRIGGER trg_wpd_pin_guard\s*\nBEFORE INSERT OR UPDATE ON work_package_documents/);
    expect(wpdGuardFn2).toMatch(/TG_OP = 'INSERT'/);
    expect(wpdGuardFn2).toMatch(/v\.record_id = NEW\.document_id/);
    expect(wpdGuardFn2).toMatch(/v\.org_id = NEW\.org_id/);
  });

  it("identity immutability survives on the UPDATE path", () => {
    expect(wpdGuardFn2).toMatch(/IF TG_OP = 'UPDATE' THEN/);
    for (const col of ["package_id", "document_id", "org_id"]) {
      expect(wpdGuardFn2).toMatch(new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM OLD\\.${col}`));
    }
  });

  it("both patched guards keep the search_path pin and the service-role pass", () => {
    for (const body of [ackGuardFn2, wpdGuardFn2]) {
      expect(body).toMatch(/SECURITY DEFINER SET search_path = public/);
      expect(body).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
    }
  });
});

describe("shared discipline (20261032)", () => {
  it("both guard functions keep the search_path pin", () => {
    expect(ackGuardFn).toMatch(/SECURITY DEFINER SET search_path = public/);
    expect(wpdGuardFn).toMatch(/SECURITY DEFINER SET search_path = public/);
  });

  it("service-role passthrough exists in both guards", () => {
    expect(ackGuardFn).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
    expect(wpdGuardFn).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
  });
});
