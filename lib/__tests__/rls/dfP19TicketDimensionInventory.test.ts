// drafting-flow Round G, DF-P19 TICKET RESOURCE LIBRARY AND CLASS DIMENSION —
// 20261263, the counts-only inventory, run on the replayed PostgreSQL 16:
//   - it pastes cleanly twice (read-only: DEC-30 one paste), every probe true;
//   - its counts of stored request rules scoped to a library / work class /
//     code class, and its NARROW / GRANT / SAME classification, equal what
//     lib/capabilityPolicy.ts classifyTicketDimensionRule says for the same
//     stored policies (the console's and the evaluator's rule) — measured as
//     the change from a paste before the fixtures to a paste after them, so
//     other suites' rows in the shared database do not matter;
//   - it reads tickets.library_id / work_class / code_class through to_jsonb
//     (the replay has 20261250, so the class counts are live here);
//   - nothing is written (row counts and the policies are unchanged).

import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, mosDb, seedOrg, skipReason } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";
import { parseStoredCapabilityPolicy, ticketDimensionRules, type CapabilityPolicy } from "@/lib/capabilityPolicy";

const skip = skipReason();
const db = REPLAY_DB;
const FILE = join(process.cwd(), "supabase", "migrations", "20261263_df_roundG_ticket_dimension_inventory.sql");

function paste(): { probes: string[]; inventory: Map<string, string> } {
  const { conn } = mosDb();
  const r = runPsql(conn!, db, conn!.superuser, { file: FILE, stopOnError: true });
  expect(r.ok, r.error ?? r.stderr ?? "").toBe(true);
  const rows = r.stdout.split("\n").filter((l) => /\|[tf]?\|[^|]*$/.test(l));
  const inventory = new Map<string, string>();
  for (const l of rows.filter((x) => /\|\|.+$/.test(x))) {
    const parts = l.split("|");
    inventory.set(parts[0], parts[2]);
  }
  return { probes: rows.filter((l) => /\|[tf]\|$/.test(l)), inventory };
}
const n = (inv: Map<string, string>, prefix: string): number => {
  const hit = [...inv.entries()].find(([k]) => k.startsWith(`inventory (before apply): ${prefix}`));
  expect(hit, prefix).toBeDefined();
  return Number(hit![1]);
};

describe.skipIf(skip !== null)("DF-P19 — 20261263 counts and classifies stored library / class request rules (runtime)", () => {
  const policies: CapabilityPolicy[] = [];
  let before: Map<string, string>;
  let after: Map<string, string>;
  let lib = "";

  beforeAll(() => {
    before = paste().inventory;
    const a = seedOrg(db, { admin: { role: "Admin" }, req: { role: "Viewer" } });
    const b = seedOrg(db, { admin: { role: "Admin" } });
    const c = seedOrg(db, { admin: { role: "Admin" } });
    lib = randomUUID();
    admin(db, `INSERT INTO libraries (id, org_id, name, type) VALUES ('${lib}', '${a.orgId}', 'P&IDs', 'documents')`);
    // Workspace A: canonical shape; a narrowing library rule, a granting class rule, a same rule, a confirmed narrowing code rule,
    // a request-type rule (not counted), a library rule on a non-request capability (not counted).
    const pa = {
      caps: {
        "ticket.direct_approve": [{ tokens: ["Engineer-3"], when: { libraryId: [lib] } }, { tokens: ["Engineer"] }],
        "ticket.assign": [{ tokens: ["Admin", "Manager", "Supervisor", "DraftingSupervisor", "Drafter"], when: { workClass: ["w-new"] } }, { tokens: ["DocCtrl"], when: { requestType: ["ISO"] } }, { tokens: ["Admin", "Manager", "Supervisor", "DraftingSupervisor"] }],
        "ticket.reopen": [{ tokens: ["Admin", "Manager", "Supervisor"], when: { codeClass: ["c-1"] } }],
        "ticket.self_assign": [{ tokens: ["DraftingSupervisor"], when: { codeClass: ["c-1"] }, confirmedAt: "2026-10-22T00:00:00.000Z" }, { tokens: ["Drafter"] }],
        "transmittal.issue": [{ tokens: ["Admin"], when: { libraryId: [lib] } }, { tokens: ["Admin", "DocCtrl"] }],
        // fix pass (review major 2): on the engineer-gate exemption a widening (Viewers in the library skip
        // engineer sign-off) is NARROW — never a GRANT; the exact base list (any order) is SAME.
        "ticket.engineer_gate_exempt": [
          { tokens: ["Admin", "Manager", "Supervisor", "Engineer", "DocCtrl", "Viewer"], when: { libraryId: [lib] } },
          { tokens: ["DocCtrl", "Engineer", "Supervisor", "Manager", "Admin"], when: { codeClass: ["c-1"] } },
          { tokens: ["Admin", "Manager", "Supervisor", "Engineer", "DocCtrl"] },
        ],
      },
      grants: [],
    };
    // Workspace B: the legacy flat shape, one "*" rule (a grant) on direct approval.
    const pb = { "ticket.direct_approve": [{ tokens: ["*"], when: { libraryId: [randomUUID()] } }, { tokens: ["Engineer"] }] };
    // Workspace C: nothing scoped (a plain bare list).
    const pc = { caps: { "ticket.assign": ["Admin", "DocCtrl"] } };
    for (const [org, data] of [[a.orgId, pa], [b.orgId, pb], [c.orgId, pc]] as const) {
      admin(db, `INSERT INTO org_configurations (org_id, key, data) VALUES ('${org}', 'capability_policy', '${JSON.stringify(data).replace(/'/g, "''")}'::jsonb)`);
      policies.push(parseStoredCapabilityPolicy(data));
    }
    // Open requests: one in the library, one of class w-new, one of code c-1, one closed in the library (not counted), one plain.
    const t = (over: string, cols: string) => admin(db, `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id${cols}) VALUES ('${randomUUID()}', '${a.orgId}', 'P19-${randomUUID().slice(0, 6)}', 'T', 'New Drawing', ${over})`);
    t(`'PENDING_REVIEW', '${a.m.req.uid}', '${lib}'`, ", library_id");
    t(`'DRAFTING', '${a.m.req.uid}', 'w-new'`, ", work_class");
    t(`'DRAFTING', '${a.m.req.uid}', 'c-1'`, ", code_class");
    t(`'CLOSED', '${a.m.req.uid}', '${lib}'`, ", library_id");
    t(`'DRAFTING', '${a.m.req.uid}'`, "");
    after = paste().inventory;
  });

  it("pastes cleanly (again), every probe true", () => {
    const again = paste();
    expect(again.probes.length).toBe(3);
    expect(again.probes.filter((l) => l.endsWith("|f|"))).toEqual([]);
  });

  it("the counts and the NARROW / GRANT / SAME split equal the app's classification of the same stored policies", () => {
    const states = policies.flatMap((p) => ticketDimensionRules(p));
    const d = (prefix: string) => n(after, prefix) - n(before, prefix);
    expect(d("stored request (ticket.*) rules scoped")).toBe(states.length);
    expect(states.length).toBe(7);
    expect(d("… of them scoped to a library")).toBe(3);
    expect(d("… of them scoped to a work class")).toBe(1);
    expect(d("… of them scoped to a code class")).toBe(3);
    expect(d("… of them already confirmed")).toBe(states.filter((s) => s.inForce).length);
    expect(d("would newly NARROW")).toBe(states.filter((s) => s.effect === "narrow").length);
    expect(d("would newly GRANT")).toBe(states.filter((s) => s.effect === "grant").length);
    expect(d("name exactly what already applies")).toBe(states.filter((s) => s.effect === "same").length);
    expect(states.map((s) => `${s.cap}:${s.effect}`).sort()).toEqual([
      "ticket.assign:narrow",          // replaces the ISO rule's DocCtrl where both could match
      "ticket.direct_approve:grant",   // "*"
      "ticket.direct_approve:narrow",
      "ticket.engineer_gate_exempt:narrow", // a widening there removes an engineering review
      "ticket.engineer_gate_exempt:same",
      "ticket.reopen:same",
      "ticket.self_assign:narrow",
    ]);
    expect(d("workspaces holding at least one such rule")).toBe(2);
    expect(d("workspaces holding at least one that would NARROW")).toBe(1);
    expect(d("workspaces storing a capability policy")).toBe(3);
  });

  it("the open requests the rules would start to match (closed ones never), read through to_jsonb", () => {
    const d = (prefix: string) => n(after, prefix) - n(before, prefix);
    expect(d("open requests whose library a library-scoped rule")).toBe(1);
    expect(d("open requests whose work class or code class")).toBe(2);
  });

  it("nothing was written: the stored policies are unchanged", () => {
    const stored = admin(db, `SELECT COUNT(*)::text FROM org_configurations WHERE key = 'capability_policy' AND data::text LIKE '%confirmedAt%'`);
    expect(Number(stored)).toBeGreaterThanOrEqual(1);
    const per = admin(db, `SELECT data->'caps'->'ticket.direct_approve'->0->>'tokens' FROM org_configurations WHERE key = 'capability_policy' AND data->'caps'->'ticket.direct_approve'->0->'when'->'libraryId' ? '${lib}'`);
    expect(per).toBe('["Engineer-3"]');
  });
});
