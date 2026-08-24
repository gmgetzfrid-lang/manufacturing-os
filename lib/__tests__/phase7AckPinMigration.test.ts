// Phase 7 — acknowledgment and pin integrity at the database (DIST-3, PKG-5).
//
// Shape pins on 20261032 so the migration cannot be quietly weakened:
//   · distribution_acks — rows cannot be born acknowledged, identity is
//     immutable, only the named recipient stamps acknowledged_at, and the row
//     records WHO stamped it.
//   · work_package_documents — the pins behind the PUBLIC field verdict:
//     INSERT binds package AND document to the row's org, UPDATE/DELETE need
//     the package owner or a controller, and a pin may only name a revision
//     of the row's own document.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "20261032_dc_phase7_ack_and_pin_integrity.sql"),
  "utf8",
);

describe("distribution_acks rails (DIST-3)", () => {
  it("INSERT forbids rows born acknowledged", () => {
    expect(sql).toMatch(/distribution_acks_org_insert[\s\S]*?acknowledged_at IS NULL/);
  });

  it("guard fires BEFORE UPDATE and lets service-role writes pass", () => {
    expect(sql).toMatch(/CREATE TRIGGER trg_distribution_ack_guard\s*\nBEFORE UPDATE ON distribution_acks/);
    expect(sql).toMatch(/enforce_distribution_ack_guard[\s\S]*?IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
  });

  it("row identity is immutable", () => {
    expect(sql).toMatch(/NEW\.recipient_user_id IS DISTINCT FROM OLD\.recipient_user_id/);
    expect(sql).toMatch(/immutable in identity/);
  });

  it("only the named recipient stamps, and the stamper is recorded", () => {
    expect(sql).toMatch(/NEW\.acknowledged_at IS DISTINCT FROM OLD\.acknowledged_at/);
    expect(sql).toMatch(/OLD\.recipient_user_id::text <> auth\.uid\(\)::text/);
    expect(sql).toMatch(/NEW\.acknowledged_by := auth\.uid\(\)/);
  });
});

describe("work_package_documents rails (PKG-5)", () => {
  it("INSERT binds the referenced package AND document to the row's org", () => {
    expect(sql).toMatch(/p\.id = work_package_documents\.package_id\s*\n\s*AND p\.org_id = work_package_documents\.org_id/);
    expect(sql).toMatch(/d\.id = work_package_documents\.document_id\s*\n\s*AND d\.org_id = work_package_documents\.org_id/);
  });

  it("UPDATE and DELETE require the package owner or Admin/DocCtrl", () => {
    const updBody = sql.slice(sql.indexOf("work_package_documents_org_update ON"));
    expect(updBody).toMatch(/p\.owner_user_id = auth\.uid\(\)/);
    expect(updBody).toMatch(/ARRAY\['Admin','DocCtrl'\]/);
    const delBody = sql.slice(sql.indexOf("work_package_documents_org_delete ON"));
    expect(delBody).toMatch(/p\.owner_user_id = auth\.uid\(\)/);
    expect(delBody).toMatch(/ARRAY\['Admin','DocCtrl'\]/);
  });

  it("a pin may only name a revision of this row's own document, in-org", () => {
    expect(sql).toMatch(/NEW\.pinned_version_id IS DISTINCT FROM OLD\.pinned_version_id/);
    expect(sql).toMatch(/v\.record_id = NEW\.document_id/);
    expect(sql).toMatch(/v\.org_id = NEW\.org_id/);
  });

  it("membership identity is immutable and the guard fires BEFORE UPDATE", () => {
    expect(sql).toMatch(/NEW\.package_id IS DISTINCT FROM OLD\.package_id/);
    expect(sql).toMatch(/CREATE TRIGGER trg_wpd_pin_guard\s*\nBEFORE UPDATE ON work_package_documents/);
  });
});

describe("shared discipline", () => {
  it("both guard functions keep the search_path pin", () => {
    const pins = sql.match(/SECURITY DEFINER SET search_path = public/g) ?? [];
    expect(pins.length).toBe(2);
  });

  it("service-role passthrough exists in both guards", () => {
    const passes = sql.match(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/g) ?? [];
    expect(passes.length).toBe(2);
  });
});
