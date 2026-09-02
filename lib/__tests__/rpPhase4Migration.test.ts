// Roles-and-permissions Phase 4 — the ticket workflow's database rails
// (WF-2, WF-5, WF-15, WF-23 + the tickets DELETE rail). Shape pins on
// 20261038, every assertion scoped to its own statement (the Phase-7a
// mutation lesson), plus the WF-23 census: the SQL fallback CASE must agree
// with lib/capabilityPolicy.ts CAPABILITY_DEFS capability-for-capability.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITY_DEFS } from "@/lib/capabilityPolicy";

const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "20261038_rp_phase4_ticket_workflow_rails.sql"),
  "utf8",
);

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}

const capFn = between(sql, "CREATE OR REPLACE FUNCTION org_capability_allows",
  "CREATE OR REPLACE FUNCTION ticket_insert_integrity");
const insertFn = between(sql, "CREATE OR REPLACE FUNCTION ticket_insert_integrity",
  "DROP TRIGGER IF EXISTS trg_ticket_insert_integrity");
const updateFn = between(sql, "CREATE OR REPLACE FUNCTION ticket_update_guard",
  "DROP TRIGGER IF EXISTS trg_ticket_update_guard");

describe("WF-23 — org_capability_allows fallback mirrors CAPABILITY_DEFS", () => {
  // Parse WHEN '<cap>' THEN '<json>'::jsonb pairs out of the fallback CASE.
  const caseBlock = between(capFn, "v_tokens := CASE p_cap", "END;");
  const sqlDefaults = new Map<string, string[]>();
  for (const m of caseBlock.matchAll(/WHEN '([^']+)'\s+THEN '(\[[^\]]*\])'::jsonb/g)) {
    sqlDefaults.set(m[1], JSON.parse(m[2]) as string[]);
  }

  it("every TS capability appears in the SQL CASE with IDENTICAL role tokens", () => {
    for (const def of CAPABILITY_DEFS) {
      expect(sqlDefaults.has(def.id), `SQL fallback missing capability: ${def.id}`).toBe(true);
      expect(sqlDefaults.get(def.id), `SQL default for ${def.id} diverges from TS`)
        .toEqual(def.defaultRoles);
    }
  });

  it("the SQL CASE has no capabilities TS doesn't know (and still denies unknowns)", () => {
    const tsIds = new Set(CAPABILITY_DEFS.map((d) => d.id));
    for (const cap of sqlDefaults.keys()) {
      expect(tsIds.has(cap as never), `SQL knows a capability TS doesn't: ${cap}`).toBe(true);
    }
    expect(caseBlock).toMatch(/ELSE '\[\]'::jsonb/);
  });

  it("keeps the 20261025 semantics: data column, roles collection, Engineer token, grants", () => {
    expect(capFn).toMatch(/SELECT data INTO v_val FROM org_configurations/);
    expect(capFn).toMatch(/COALESCE\(roles, ARRAY\[role\]\)/);
    expect(capFn).toMatch(/t = 'Engineer' AND EXISTS/);
    expect(capFn).toMatch(/v_val \? 'grants'/);
    expect(capFn).toMatch(/SECURITY DEFINER SET search_path = public/);
  });
});

describe("WF-5 — ticket birth integrity", () => {
  it("passes service-role writes and requires active membership", () => {
    expect(insertFn).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
    expect(insertFn).toMatch(/status = 'active'/);
    expect(insertFn).toMatch(/only active members of the workspace can create requests/);
  });

  it("forces requester identity, held role, queue-entry status", () => {
    expect(insertFn).toMatch(/NEW\.requester_id := auth\.uid\(\);/);
    expect(insertFn).toMatch(/NOT \(NEW\.requester_role = ANY\(v_roles\)\)/);
    expect(insertFn).toMatch(/NEW\.requester_role := v_role;/);
    expect(insertFn).toMatch(/NEW\.status := 'PENDING_ASSIGNMENT';/);
  });

  it("nulls every mid-workflow field at birth", () => {
    for (const col of [
      "assigned_drafter_id", "assigned_drafter_name", "assigned_engineer_id",
      "assigned_engineer_name", "assigned_engineer_email", "engineer_approved_at",
      "closed_at", "archived_at", "archive_id",
    ]) {
      expect(insertFn, `missing birth-null: ${col}`)
        .toMatch(new RegExp(`NEW\\.${col} := NULL;`));
    }
  });

  it("WF-15: request_type must be configured, keeping the built-in vocabulary union", () => {
    expect(insertFn).toMatch(/c\.data->'requestTypes'->'options'/);
    expect(insertFn).toMatch(/NOT \(NEW\.request_type = ANY\(v_types\)\)/);
    expect(insertFn).toMatch(/NEW\.request_type NOT IN \('Revision', 'ASBUILT', 'RFI'\)/);
    // Unconfigured orgs keep free vocabulary — the raise is conditional on a
    // non-empty configured list.
    expect(insertFn).toMatch(/v_types IS NOT NULL AND array_length\(v_types, 1\) > 0/);
  });

  it("installs as BEFORE INSERT", () => {
    const trg = between(sql, "CREATE TRIGGER trg_ticket_insert_integrity", ";");
    expect(trg).toMatch(/BEFORE INSERT ON tickets/);
  });
});

describe("WF-2 — workflow-owned columns guarded on UPDATE", () => {
  const GUARDED = [
    "org_id", "ticket_id", "status", "requester_id", "requester_role",
    "requester_name", "requester_email", "assigned_drafter_id",
    "assigned_drafter_name", "assigned_engineer_id", "assigned_engineer_name",
    "assigned_engineer_email", "engineer_review_requested_at",
    "engineer_approved_at", "engineer_review_reason", "deliverable_rev",
    "draft_iteration", "revision_count", "closed_at", "archived_at",
    "archive_id", "created_at",
  ];

  it("guards every workflow-owned column by name", () => {
    for (const col of GUARDED) {
      expect(updateFn, `missing guard: ${col}`)
        .toMatch(new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM OLD\\.${col}`));
    }
  });

  it("service pass + history shrink-block", () => {
    expect(updateFn).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
    expect(updateFn).toMatch(/jsonb_array_length\(COALESCE\(NEW\.history, '\[\]'::jsonb\)\)/);
    expect(updateFn).toMatch(/the history log cannot shrink/);
  });

  it("installs as BEFORE UPDATE, and DELETE is a RESTRICTIVE controllers-only rail", () => {
    const trg = between(sql, "CREATE TRIGGER trg_ticket_update_guard", ";");
    expect(trg).toMatch(/BEFORE UPDATE ON tickets/);
    const del = between(sql, "CREATE POLICY tickets_delete_controllers", ";");
    expect(del).toMatch(/AS RESTRICTIVE FOR DELETE/);
    expect(del).toMatch(/is_org_controller\(org_id\)/);
  });

  it("does NOT guard the columns clients legitimately write", () => {
    // priority, comments, attachments, watchers, unread_by, last_modified,
    // metadata and history APPENDS are the census'd client writes — none may
    // appear in the guard list or every comment/upload would 500.
    for (const col of ["priority", "comments", "attachments", "watchers", "unread_by", "last_modified", "metadata"]) {
      expect(updateFn, `over-guarded client column: ${col}`)
        .not.toMatch(new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM`));
    }
  });
});

describe("workflow-action route — the server half of the Phase 4 guards", () => {
  // No route-handler test harness exists in this repo, so the enforcement
  // order is pinned by source shape: every guard must sit BEFORE the
  // computeTransition call that applies the transition.
  const route = readFileSync(
    join(process.cwd(), "app", "api", "tickets", "workflow-action", "route.ts"),
    "utf8",
  );
  const beforeTransition = between(route, "const allowed = WorkflowEngine.getActions", "computeTransition(ticket, input)");

  it("GAP-2: a disabledReason action is refused with the same message the UI shows", () => {
    expect(beforeTransition).toMatch(/if \(action\.disabledReason\)/);
    expect(beforeTransition).toMatch(/\{ error: action\.disabledReason \}, \{ status: 403 \}/);
  });

  it("WF-6: submit_final without the deliverable file is a 400", () => {
    expect(beforeTransition).toMatch(/action\.requiresFile && action\.action === "submit_final" && !body\.finalAttachment\?\.url/);
  });

  it("WF-22: assign without an assignee is a 400 (no more silent no-op audit rows)", () => {
    expect(beforeTransition).toMatch(/action\.action === "assign" && !body\.assignment\?\.id/);
  });

  it("WF-14: at 3+ members the picked engineer may not be requester, drafter, or caller", () => {
    expect(beforeTransition).toMatch(/ref === ticket\.requesterId/);
    expect(beforeTransition).toMatch(/ref === ticket\.assignedDrafterId/);
    expect(beforeTransition).toMatch(/ref === caller\.id/);
    expect(beforeTransition).toMatch(/if \(sodActive\)/);
  });

  it("WF-14 done-when 3: the assignee must hold ticket.draft_work; requester can't draft own request", () => {
    expect(beforeTransition).toMatch(/policyAllows\(capPolicy, "ticket\.draft_work",/);
    expect(beforeTransition).toMatch(/sodActive && ref === ticket\.requesterId/);
  });

  it("WF-7: the engine is evaluated with the caller's full role collection and org context", () => {
    expect(route).toMatch(/userRoles: callerRoles,/);
    expect(route).toMatch(/activeMemberCount: activeMemberCount \?\? 0,/);
    expect(route).toMatch(/closeWithoutReviewTypes,/);
  });
});

describe("20261039 — the guarded-column repair covers everything 20261038 references", () => {
  // Live finding 2026-09-01: the archive migrations (20260809/20260811) had
  // never been hand-applied, so closed_at/archived_at/archive_id were absent
  // and every client ticket write would have raised at trigger time. The
  // repair must add (idempotently) every guarded column that is not a
  // NOT NULL base-schema column — this pins the two files to each other.
  const repair = readFileSync(
    join(process.cwd(), "supabase", "migrations", "20261039_tickets_guarded_column_repair.sql"),
    "utf8",
  );
  const BASE_NOT_NULL = new Set(["org_id", "ticket_id", "status", "requester_id", "created_at"]);
  const guarded = [...updateFn.matchAll(/NEW\.(\w+)\s+IS DISTINCT FROM OLD\.\1/g)].map((m) => m[1]);

  it("every guarded column outside the base schema has an ADD COLUMN IF NOT EXISTS", () => {
    expect(guarded.length).toBe(22);
    for (const col of guarded) {
      if (BASE_NOT_NULL.has(col)) continue;
      expect(repair, `repair missing: ${col}`)
        .toMatch(new RegExp(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ${col} `));
    }
  });

  it("the birth-nulled INSERT columns are covered too, and the report lists all 22", () => {
    for (const m of insertFn.matchAll(/NEW\.(\w+) := NULL;/g)) {
      expect(repair, `repair missing insert-referenced column: ${m[1]}`)
        .toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${m[1]} `));
    }
    const report = between(repair, "FROM unnest(ARRAY[", "]) AS c(col)");
    for (const col of guarded) expect(report, `report missing: ${col}`).toContain(`'${col}'`);
  });

  it("uses the canonical types from the originating migrations", () => {
    expect(repair).toMatch(/draft_iteration INT NOT NULL DEFAULT 0;/);
    expect(repair).toMatch(/revision_count INT DEFAULT 0;/);
    expect(repair).toMatch(/closed_at TIMESTAMPTZ;/);
    expect(repair).toMatch(/archived_at TIMESTAMPTZ;/);
    expect(repair).toMatch(/archive_id TEXT;/);
    expect(repair).toMatch(/assigned_engineer_id UUID;/);
  });
});

describe("migration hygiene", () => {
  it("verification block checks both triggers, the DELETE rail, and search_path pins", () => {
    const verify = between(sql, "── Verification", "── Inventory");
    expect(verify).toMatch(/trg_ticket_insert_integrity/);
    expect(verify).toMatch(/trg_ticket_update_guard/);
    expect(verify).toMatch(/tickets_delete_controllers/);
    expect(verify).toMatch(/search_path=public/);
    // The late-binding safety: plpgsql only resolves NEW.<col> at run time,
    // so the verification must prove every guarded column exists.
    expect(verify).toMatch(/COUNT\(\*\) = 22 FROM information_schema\.columns/);
  });

  it("the DDL is transactional (BEGIN before the first CREATE, COMMIT before verification)", () => {
    expect(sql.indexOf("BEGIN;")).toBeGreaterThanOrEqual(0);
    expect(sql.indexOf("BEGIN;")).toBeLessThan(sql.indexOf("CREATE OR REPLACE FUNCTION org_capability_allows"));
    expect(sql.indexOf("COMMIT;")).toBeLessThan(sql.indexOf("── Verification"));
    expect(sql.indexOf("COMMIT;")).toBeGreaterThan(sql.indexOf("CREATE POLICY tickets_delete_controllers"));
  });
});
