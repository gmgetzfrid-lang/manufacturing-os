// Round E — package C-ownership: the ownership / publish surface.
//
//   OWN-16  ONE effective-owner chain (resolveEffectiveOwner carries the team
//           rung); the four notification / register consumers and the
//           knowledge boundary route through it; a census pins that no
//           second chain can appear.
//   OWN-13  the four ownership / policy writers are checked writes; a refused
//           write throws, records nothing, and EVERY UI caller surfaces it
//           (pinned per writer call site, catch-adjacent).
//   OWN-18  org-subject grants publish in every evaluator (index + SQL).
//   OWN-19  the Inspector's lifecycle affordances follow publish authority
//           (lifecycleAffordances, tested behaviourally); renumber takes the
//           same authority at the mutator; split / merge targets are born
//           owned by the actor so the rollback archive passes the guard.
//   OWN-20  the drawer's save is a checked write and re-indexes a library
//           subtree after it (pin here; the rebuild + route are driven in
//           roundEAclRebuild.test.ts).
//   OWN-21  branch resolution refusal is said out loud (policy in 20261061).
//   OWN-22  Save-As libraries: a CONTROLLER creator is stamped owner (audit
//           row); a non-controller's library is born unowned and the
//           controllers are told (the INSERT rail is 20261062).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ── a filter-aware PostgREST chain mock ─────────────────────────────────────
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  updateResults: [] as Array<{ data: unknown; error: unknown }>,
  insertResult: null as null | { data: unknown; error: unknown },
  writes: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));
function parseOr(expr: string): (r: Record<string, unknown>) => boolean {
  const parts = expr.split(/,(?![^(]*\))(?![^{]*\})/);
  const preds = parts.map((p) => {
    let m: RegExpExecArray | null;
    if ((m = /^(\w+)\.in\.\(([^)]*)\)$/.exec(p))) { const list = m[2].split(",").map((x) => x.replace(/"/g, "")); const col = m[1]; return (r: Record<string, unknown>) => list.includes(String(r[col])); }
    if ((m = /^(\w+)\.ov\.\{([^}]*)\}$/.exec(p))) { const list = m[2].split(",").map((x) => x.replace(/"/g, "")); const col = m[1]; return (r: Record<string, unknown>) => Array.isArray(r[col]) && (r[col] as string[]).some((x) => list.includes(x)); }
    if ((m = /^(\w+)\.is\.null$/.exec(p))) { const col = m[1]; return (r: Record<string, unknown>) => r[col] == null; }
    if ((m = /^(\w+)\.not\.in\.\(([^)]*)\)$/.exec(p))) { const list = m[2].split(","); const col = m[1]; return (r: Record<string, unknown>) => r[col] != null && !list.includes(String(r[col])); }
    return () => true;
  });
  return (r) => preds.some((p) => p(r));
}
function chain(table: string) {
  const preds: Array<(r: Record<string, unknown>) => boolean> = [];
  let pendingUpdate = false;
  let pendingInsert: unknown = null;
  const rows = () => (db.tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: pendingUpdate || pendingInsert ? null : rows(), error: null });
      return (...args: unknown[]) => {
        switch (prop) {
          case "eq": preds.push((r) => r[args[0] as string] === args[1]); break;
          case "in": preds.push((r) => (args[1] as unknown[]).includes(r[args[0] as string])); break;
          case "is": preds.push((r) => (args[1] === null ? r[args[0] as string] == null : r[args[0] as string] === args[1])); break;
          case "lte": preds.push((r) => String(r[args[0] as string] ?? "") <= String(args[1])); break;
          case "not": {
            const [col, op, val] = args as [string, string, unknown];
            if (op === "is") preds.push((r) => !(val === null ? r[col] == null : r[col] === val));
            else if (op === "in") { const list = String(val).replace(/^\(|\)$/g, "").split(","); preds.push((r) => !list.includes(String(r[col]))); }
            break;
          }
          case "or": preds.push(parseOr(String(args[0]))); break;
          case "update": pendingUpdate = true; db.writes.push({ table, method: prop, args }); break;
          case "insert": pendingInsert = args[0]; db.writes.push({ table, method: prop, args }); break;
          case "select":
            if (pendingUpdate) { pendingUpdate = false; return Promise.resolve(db.updateResults.shift() ?? { data: [], error: null }); }
            break;
          case "maybeSingle": case "single":
            if (pendingInsert) { const ins = pendingInsert as Record<string, unknown>; pendingInsert = null; return Promise.resolve(db.insertResult ?? { data: { id: "new-lib", ...ins }, error: null }); }
            return Promise.resolve({ data: rows()[0] ?? null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
const notified = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const audited = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t), rpc: async () => ({ data: null, error: null }) } }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async (n: Record<string, unknown>) => { notified.push(n); }) }));
vi.mock("@/lib/audit", () => ({
  logAuditAction: vi.fn(async (e: Record<string, unknown>) => { audited.push(e); }),
  logRevisionEvent: vi.fn(async (e: Record<string, unknown>) => { audited.push({ ...e, action: e.type }); }),
  logHoldEvent: vi.fn(async () => {}),
}));
vi.mock("@/lib/storage", () => ({
  uploadToPath: vi.fn(async () => ({ url: "https://files/x.pdf", size: 3 })),
  makeLibraryStoragePath: vi.fn(() => "org/lib/x.pdf"),
}));

import { resolveEffectiveOwner, resolveOwnerForNode, teamSupervisorMap, type TeamSupervisor } from "@/lib/ownership";
import { effectiveOwnerFor } from "@/lib/knowledgeAccess";
import { scanAndNotifyReviews, setReviewPolicy } from "@/lib/reviewCycles";
import { scanReviews, setReviewControlPolicy } from "@/lib/reviewControl";
import { scanAndNotifyAcks } from "@/lib/acknowledgments";
import { loadDocControlRegister } from "@/lib/docControlRegister";
import { canPublishViaIndex, type Principal } from "@/lib/permissions";
import { createLibrary } from "@/lib/libraryCollections";
import { lifecycleAffordances } from "@/lib/lifecycleAffordances";
import { createNewDocWithFirstVersion, archiveRolledBackDoc } from "@/lib/documentLifecycle/common";
import { renumberDocument } from "@/lib/documentLifecycle/renumber";
import type { AclIndex, DocumentRecord } from "@/types/schema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

beforeEach(() => {
  db.tables = {}; db.updateResults = []; db.insertResult = null; db.writes = [];
  notified.length = 0; audited.length = 0;
});

// ── OWN-16 · the one chain ──────────────────────────────────────────────────
describe("OWN-16 — resolveEffectiveOwner carries the team rung", () => {
  const teams: ReadonlyMap<string, TeamSupervisor> = new Map([["t1", { userId: "sup", name: "Sue" }], ["t-empty", { userId: null }]]);
  it("a team-owned library resolves to its supervisor with source 'team'", () => {
    expect(resolveEffectiveOwner(null, null, { owner_user_id: null, owner_team_id: "t1" }, null, teams))
      .toEqual({ userId: "sup", name: "Sue", source: "team" });
  });
  it("an explicit owner at any level beats the team rung; a team without a supervisor is unowned", () => {
    expect(resolveEffectiveOwner(null, { owner_user_id: "f" }, { owner_team_id: "t1" }, null, teams).source).toBe("collection");
    expect(resolveEffectiveOwner(null, null, { owner_user_id: "l", owner_team_id: "t1" }, null, teams).source).toBe("library");
    expect(resolveEffectiveOwner(null, null, { owner_team_id: "t-empty" }, null, teams).userId).toBeNull();
    expect(resolveEffectiveOwner(null, null, { owner_team_id: "t1" }, null, null).userId).toBeNull();
  });
  it("GAP-5 gating applies to the supervisor too: an inactive supervisor is not an owner", () => {
    expect(resolveEffectiveOwner(null, null, { owner_team_id: "t1" }, new Set(["someone-else"]), teams).userId).toBeNull();
    expect(resolveEffectiveOwner(null, null, { owner_team_id: "t1" }, new Set(["sup"]), teams).userId).toBe("sup");
    // a departed library owner falls THROUGH to the active supervisor
    expect(resolveEffectiveOwner(null, null, { owner_user_id: "gone", owner_team_id: "t1" }, new Set(["sup"]), teams))
      .toEqual({ userId: "sup", name: "Sue", source: "team" });
  });
  it("legacy 3/4-argument callers are byte-for-byte unchanged in behaviour", () => {
    expect(resolveEffectiveOwner(null, { owner_user_id: "u-f", owner_name: "Fol Der" }, { owner_user_id: "u-l" }))
      .toEqual({ userId: "u-f", name: "Fol Der", source: "collection" });
    expect(resolveEffectiveOwner(null, null, null)).toEqual({ userId: null, name: null, source: null });
  });
  it("resolveOwnerForNode is an adapter over the same chain", () => {
    expect(resolveOwnerForNode(null, null, { owner_team_id: "t1" }, "u-sup")).toEqual({ userId: "u-sup", source: "team" });
    expect(resolveOwnerForNode({ owner_user_id: "d" }, null, { owner_team_id: "t1" }, "u-sup")).toEqual({ userId: "d", source: "document" });
    expect(resolveOwnerForNode(null, null, { owner_team_id: "t1" }, null)).toEqual({ userId: null, source: null });
  });
  it("the knowledge boundary's lineage walk feeds the same chain (team rung included)", () => {
    const landscape = {
      libraries: new Map([["L", { name: "L", acl: null, visibility: null, owner_user_id: null, owner_team_id: "t1" }]]),
      folders: new Map([
        ["root", { name: "root", library_id: "L", parent_id: null, acl: null, visibility: null, owner_user_id: "folder-owner", path_names: [] }],
        ["leaf", { name: "leaf", library_id: "L", parent_id: "root", acl: null, visibility: null, owner_user_id: null, path_names: [] }],
      ]),
      teamSupervisors: new Map([["t1", { userId: "sup" }]]),
    };
    expect(effectiveOwnerFor(null, "leaf", "L", landscape)).toBe("folder-owner");   // nearest owning ancestor
    expect(effectiveOwnerFor("doc-owner", "leaf", "L", landscape)).toBe("doc-owner");
    expect(effectiveOwnerFor(null, null, "L", landscape)).toBe("sup");              // team rung
    expect(effectiveOwnerFor(null, null, "nope", landscape)).toBeNull();
  });
  it("teamSupervisorMap resolves the supervisor's CURRENT name and fails empty on a read error", async () => {
    db.tables.teams = [{ id: "t1", org_id: "o1", supervisor_user_id: "sup" }, { id: "t2", org_id: "o1", supervisor_user_id: null }];
    db.tables.org_members = [{ uid: "sup", org_id: "o1", display_name: "Sue", email: "sue@x" }];
    const m = await teamSupervisorMap("o1");
    expect(m.get("t1")).toEqual({ userId: "sup", name: "Sue" });
    expect(m.get("t2")).toEqual({ userId: null, name: null });
    expect((await teamSupervisorMap(null)).size).toBe(0);
  });
});

describe("OWN-16 — the four consumers route a team-owned library to its supervisor", () => {
  const seedOrg = () => {
    db.tables.libraries = [{ id: "L", org_id: "o1", name: "Drawings", owner_user_id: null, owner_name: null, owner_team_id: "t1", review_policy: null, review_control: null }];
    db.tables.collections = [];
    db.tables.teams = [{ id: "t1", org_id: "o1", supervisor_user_id: "sup" }];
    db.tables.org_members = [
      { uid: "sup", org_id: "o1", status: "active", role: "Supervisor", roles: ["Supervisor"], display_name: "Sue", email: "sue@x" },
      { uid: "ctrl", org_id: "o1", status: "active", role: "DocCtrl", roles: ["DocCtrl"], display_name: "Cal", email: "cal@x" },
      { uid: "rev", org_id: "o1", status: "active", role: "Engineer-1", roles: ["Engineer-1"], display_name: "Rae", email: "rae@x" },
    ];
  };
  it("scanAndNotifyReviews: the periodic-review nudge goes to the supervisor, not the controllers", async () => {
    seedOrg();
    db.tables.documents = [{ id: "d1", org_id: "o1", library_id: "L", collection_id: null, document_number: "P-1", title: null, name: null, review_policy: null, next_review_date: "2000-01-01", review_notified_at: null, owner_user_id: null, owner_name: null }];
    const n = await scanAndNotifyReviews("o1");
    expect(n).toBe(1);
    const due = notified.filter((x) => x.kind === "review_due").map((x) => x.userId);
    expect(due).toEqual(["sup"]);
    expect(due).not.toContain("ctrl");
  });
  it("scanReviews: the review-timeout escalation reaches the supervisor", async () => {
    seedOrg();
    db.tables.documents = [{ id: "d1", org_id: "o1", library_id: "L", collection_id: null, review_control: null, owner_user_id: null, owner_name: null }];
    db.tables.document_review_signoffs = [{ id: "s1", org_id: "o1", status: "pending", document_id: "d1", document_version_id: "v1", reviewer_user_id: "rev", reviewer_name: "Rae", revision_label: "B", slot: "primary", activated: true, notified_at: null, assigned_at: daysAgo(30) }];
    await scanReviews("o1");
    const overdue = notified.filter((x) => x.kind === "review_overdue").map((x) => x.userId);
    expect(overdue).toContain("sup");
    expect(overdue).toContain("ctrl");
  });
  it("scanAndNotifyAcks: the ack-overdue escalation reaches the supervisor", async () => {
    seedOrg();
    db.tables.documents = [{ id: "d1", org_id: "o1", library_id: "L", collection_id: null, document_number: "P-1", title: null, name: null, owner_user_id: null, owner_name: null }];
    db.tables.document_acknowledgments = [{ id: "a1", org_id: "o1", status: "pending", document_id: "d1", assignee_user_id: "rev", assignee_name: "Rae", revision_label: "B", notified_at: null, assigned_at: daysAgo(40) }];
    await scanAndNotifyAcks("o1");
    const overdue = notified.filter((x) => x.kind === "ack_overdue").map((x) => x.userId);
    expect(overdue).toContain("sup");
  });
  it("loadDocControlRegister: the register names the supervisor as owner — the same answer the scans give", async () => {
    seedOrg();
    db.tables.documents = [{ id: "d1", org_id: "o1", library_id: "L", collection_id: null, status: "Issued", document_number: "P-1", title: null, name: null, rev: "B", updated_at: daysAgo(1), owner_user_id: null, owner_name: null, next_review_date: null, pending_version_id: null, effective_date: null, retention_until: null, disposition_state: null, legal_hold: false, origin: null, external_source: null, external_reference: null, current_version_id: "v1" }];
    db.tables.document_acknowledgments = []; db.tables.document_review_signoffs = []; db.tables.distribution_acks = [];
    const { rows } = await loadDocControlRegister("o1");
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerUserId).toBe("sup");
    expect(rows[0].ownerName).toBe("Sue");
    expect(rows[0].owned).toBe(true);
  });
  it("an inactive supervisor leaves the team-owned document UNOWNED everywhere (controllers take it)", async () => {
    seedOrg();
    db.tables.org_members = db.tables.org_members.filter((m) => m.uid !== "sup");
    db.tables.documents = [{ id: "d1", org_id: "o1", library_id: "L", collection_id: null, document_number: "P-1", title: null, name: null, review_policy: null, next_review_date: "2000-01-01", review_notified_at: null, owner_user_id: null, owner_name: null }];
    await scanAndNotifyReviews("o1");
    expect(notified.filter((x) => x.kind === "review_due").map((x) => x.userId)).toEqual(["ctrl"]);
  });
});

// ── the census: one chain, no seventh ───────────────────────────────────────
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
/** The argument text of every `resolveEffectiveOwner(` call in `text` (paren-balanced). */
function callArgs(text: string): string[] {
  const out: string[] = [];
  const needle = "resolveEffectiveOwner(";
  let i = text.indexOf(needle);
  while (i >= 0) {
    if (!/function\s*$/.test(text.slice(Math.max(0, i - 12), i))) {
      let depth = 1, j = i + needle.length;
      while (j < text.length && depth > 0) { if (text[j] === "(") depth++; else if (text[j] === ")") depth--; j++; }
      out.push(text.slice(i + needle.length, j - 1));
    }
    i = text.indexOf(needle, i + needle.length);
  }
  return out;
}
const topLevelCommas = (s: string) => { let d = 0, n = 0; for (const ch of s) { if ("([{".includes(ch)) d++; else if (")]}".includes(ch)) d--; else if (ch === "," && d === 0) n++; } return n; };

describe("OWN-16 census — the chain is implemented once, and every caller supplies the team rung", () => {
  const root = process.cwd();
  const files = ["lib", "app", "components"].flatMap((d) => walk(join(root, d))).map((p) => p.slice(root.length + 1));
  const CANON = "lib/ownership.ts";
  it("no file outside lib/ownership.ts produces an owner `source` or branches on owner_team_id", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f === CANON) continue;
      const s = src(f);
      // the EffectiveOwner shape (userId + source) — reviewer-pool rows carry uid/role/source and are not a chain
      if (/userId:[^\n]*\bsource:\s*["'](document|collection|library|team)["']|\bsource:\s*["'](document|collection|library|team)["'][^\n]*userId:/.test(s)) offenders.push(`${f}: literal owner source`);
      if (/if\s*\([^)\n]*owner_team_id[^)\n]*\)/.test(s)) offenders.push(`${f}: branches on owner_team_id`);
      if (/\?\.owner_user_id\)\s*return\b/.test(s)) offenders.push(`${f}: chain-style owner return`);
    }
    expect(offenders).toEqual([]);
  });
  it("the resolver's call sites are exactly the known consumers, and each passes the 5th (team) argument", () => {
    const callers = files.filter((f) => f !== CANON && src(f).includes("resolveEffectiveOwner(")).sort();
    expect(callers).toEqual([
      "app/api/acl/rebuild/route.ts",
      "lib/acknowledgments.ts",
      "lib/docControlRegister.ts",
      "lib/knowledgeAccess.ts",
      "lib/reviewControl.ts",
      "lib/reviewCycles.ts",
    ]);
    for (const f of callers) {
      const calls = callArgs(src(f));
      expect(calls.length, f).toBeGreaterThan(0);
      for (const a of calls) expect(topLevelCommas(a.replace(/,\s*$/, "")), `${f}: resolveEffectiveOwner(${a.slice(0, 60)}…) must pass the team lookup`).toBe(4);
    }
  });
  it("every scan / register consumer selects owner_team_id on the library row and loads the supervisor map", () => {
    for (const f of ["lib/acknowledgments.ts", "lib/docControlRegister.ts", "lib/reviewControl.ts", "lib/reviewCycles.ts"]) {
      const s = src(f);
      expect(s, f).toMatch(/from\("libraries"\)\.select\("[^"]*owner_team_id[^"]*"\)/);
      expect(s, f).toMatch(/teamSupervisorMap\(orgId\)/);
    }
    expect(src("lib/knowledgeAccess.ts")).toMatch(/landscape\.teamSupervisors,\s*\n\s*\)\.userId;/);
    expect(src("lib/docControlRegister.ts")).not.toMatch(/source: "library"/);
  });
});

// ── OWN-13 · checked writes, visible refusals ───────────────────────────────
describe("OWN-13 — a refused ownership / policy write throws and records nothing", () => {
  it("setReviewControlPolicy: zero rows → throws, no REVIEW_CONTROL_SET audit row", async () => {
    db.updateResults = [{ data: [], error: null }];
    await expect(setReviewControlPolicy({ level: "library", id: "L", orgId: "o1", control: { mode: "none" } as never, actorId: "u" }))
      .rejects.toThrow(/NOT saved/);
    expect(audited).toHaveLength(0);
  });
  it("setReviewPolicy: zero rows → throws, no policy_set event and no recompute", async () => {
    db.updateResults = [{ data: [], error: null }];
    await expect(setReviewPolicy({ level: "document", id: "d1", orgId: "o1", policy: { intervalMonths: 12 } as never, userId: "u" }))
      .rejects.toThrow(/NOT saved/);
    expect(db.writes.filter((w) => w.table === "document_review_events")).toHaveLength(0);
    expect(db.writes.filter((w) => w.method === "update")).toHaveLength(1);
  });
  it("a database error surfaces verbatim", async () => {
    db.updateResults = [{ data: null, error: { message: "Not permitted to change this library's ownership, access control, or compliance policy." } }];
    await expect(setReviewControlPolicy({ level: "library", id: "L", orgId: "o1", control: null, actorId: "u" })).rejects.toThrow(/Not permitted/);
  });
  it("all four writers are checked (`.select(\"id\")` after the update, zero rows throws) — pinned by source", () => {
    const o = src("lib/ownership.ts"), rc = src("lib/reviewControl.ts"), ry = src("lib/reviewCycles.ts");
    for (const [s, fn] of [[o, "setOwner"], [o, "setLibraryOwnerTeam"], [rc, "setReviewControlPolicy"], [ry, "setReviewPolicy"]] as const) {
      const body = s.slice(s.indexOf(`export async function ${fn}(`));
      const upd = body.slice(body.indexOf(".update("), body.indexOf("length === 0)") + 80);
      expect(upd, fn).toMatch(/\.select\("id"\)/);
      expect(upd, fn).toMatch(/length === 0\) \{\s*\n\s*throw new Error\(/);
    }
  });
  it("every UI caller surfaces the refusal (no swallowed catch)", () => {
    const teams = src("app/(protected)/admin/teams/page.tsx");
    expect(teams).not.toMatch(/catch \{ void refresh\(\); \}/);
    expect(teams).toMatch(/await setLibraryOwnerTeam\([\s\S]{0,200}?catch \(e\) \{[\s\S]{0,400}?appAlert\(\{ message: \(e as Error\)\.message, tone: "danger" \}\);/);
  });
  // Per writer CALL SITE: the try block that awaits the writer must end in a
  // `catch (e)` whose body alerts `(e as Error).message` — a bare `finally`
  // (what four of these sites had) turns a refusal into an unhandled
  // rejection with the form silently left as it was.
  const surfacing = (file: string, writer: string, expected: number) => {
    const text = src(file);
    const re = new RegExp(`await ${writer}\\(`, "g");
    const sites = [...text.matchAll(re)].map((m) => m.index as number);
    expect(sites, `${file}: ${writer} call sites`).toHaveLength(expected);
    for (const at of sites) {
      const catchAt = text.indexOf("catch (e) {", at);
      const finallyAt = text.indexOf("finally {", at);
      expect(catchAt, `${file}:${writer}@${at} has a catch`).toBeGreaterThan(-1);
      expect(catchAt, `${file}:${writer}@${at} catch comes before finally`).toBeLessThan(finallyAt === -1 ? Number.MAX_SAFE_INTEGER : finallyAt);
      const catchBody = text.slice(catchAt, finallyAt === -1 ? catchAt + 400 : finallyAt);
      expect(catchBody, `${file}:${writer}@${at} alerts the message`).toMatch(/appAlert\(\{ message: \(e as Error\)\.message, tone: "danger" \}\)/);
    }
  };
  it("ReviewSection: setOwner ×1 and setReviewPolicy ×2 each surface a refusal", () => {
    surfacing("components/documents/ReviewSection.tsx", "setOwner", 1);
    surfacing("components/documents/ReviewSection.tsx", "setReviewPolicy", 2);
  });
  it("ReviewPolicyModal: setOwner ×1 and setReviewPolicy ×2 each surface a refusal", () => {
    surfacing("components/documents/ReviewPolicyModal.tsx", "setOwner", 1);
    surfacing("components/documents/ReviewPolicyModal.tsx", "setReviewPolicy", 2);
  });
  it("ReviewControlModal: setReviewControlPolicy ×2 each surface a refusal", () => {
    surfacing("components/documents/ReviewControlModal.tsx", "setReviewControlPolicy", 2);
  });
});

// ── OWN-18 · org-subject grants publish everywhere ──────────────────────────
describe("OWN-18 — canPublishViaIndex honours the org bucket like users / roles / teams", () => {
  const p: Principal = { uid: "u1", role: "Drafter", roles: ["Drafter"], orgId: "o1", teamIds: [], isActiveMember: true };
  const idx = (over: { allow?: Partial<AclIndex["allow"]>; deny?: Partial<AclIndex["deny"]> }): AclIndex =>
    ({ allow: { users: {}, roles: {}, ...(over.allow ?? {}) }, deny: { users: {}, roles: {}, ...(over.deny ?? {}) } } as unknown as AclIndex);
  it("allow.orgs.publish grants; allow.orgs.admin grants unless admin is denied", () => {
    expect(canPublishViaIndex(idx({ allow: { orgs: { publish: ["o1"] } as never } }), p)).toBe(true);
    expect(canPublishViaIndex(idx({ allow: { orgs: { admin: ["o1"] } as never } }), p)).toBe(true);
    expect(canPublishViaIndex(idx({ allow: { orgs: { admin: ["o1"] } as never }, deny: { orgs: { admin: ["o1"] } as never } }), p)).toBe(false);
  });
  it("deny.orgs.publish wins over every allow; a different org or no org never matches", () => {
    expect(canPublishViaIndex(idx({ allow: { users: { publish: ["u1"] } as never }, deny: { orgs: { publish: ["o1"] } as never } }), p)).toBe(false);
    expect(canPublishViaIndex(idx({ allow: { orgs: { publish: ["other-org"] } as never } }), p)).toBe(false);
    expect(canPublishViaIndex(idx({ allow: { orgs: { publish: ["o1"] } as never } }), { ...p, orgId: undefined })).toBe(false);
  });
  it("the SQL evaluator agrees (20261059 body) and the role-model tree lists org grants", () => {
    const m = src("supabase/migrations/20261059_rp_roundE_org_subject_publish.sql");
    expect(m).toMatch(/OR \(v_idx->'allow'->'orgs'->'publish'\) \? p_org::text/);
    expect(m).toMatch(/OR \(NOT v_admin_denied AND \(v_idx->'allow'->'orgs'->'admin'\) \? p_org::text\)/);
    expect(m).toMatch(/OR COALESCE\(\(v_idx->'deny'->'orgs'->'publish'\) \? p_org::text, false\)/);
    expect(m).toMatch(/OR COALESCE\(\(v_idx->'deny'->'orgs'->'admin'\) \? p_org::text, false\)/);
    expect(src("components/permissions/RoleModelTree.tsx")).toMatch(/allow\?\.orgs\?\.publish/);
  });
});

// ── OWN-19 · lifecycle affordances follow publish authority ─────────────────
describe("OWN-19 — the Inspector's lifecycle acts are gated on publish authority", () => {
  const gates = (isController: boolean, isOwner: boolean, canPublish: boolean) => lifecycleAffordances({ isController, isOwner, canPublish });
  it("a granted publisher (no controller role, not the owner) gets the lifecycle acts but not Move / Permissions", () => {
    expect(gates(false, false, true)).toEqual({ canManage: false, canPublishEff: true, canLifecycle: true, canMove: false, sectionOpen: true });
  });
  it("the effective owner gets lifecycle acts and Permissions, never Move", () => {
    expect(gates(false, true, false)).toEqual({ canManage: true, canPublishEff: true, canLifecycle: true, canMove: false, sectionOpen: true });
  });
  it("a controller gets everything; a plain member gets nothing and the section stays closed", () => {
    expect(gates(true, false, true)).toEqual({ canManage: true, canPublishEff: true, canLifecycle: true, canMove: true, sectionOpen: true });
    // the lifecycle acts and Move never depend on the host's publish flag for a controller
    expect(gates(true, false, false)).toMatchObject({ canManage: true, canLifecycle: true, canMove: true, sectionOpen: true });
    expect(gates(false, false, false)).toEqual({ canManage: false, canPublishEff: false, canLifecycle: false, canMove: false, sectionOpen: false });
  });
  it("the Inspector renders from that one helper (the router / Supersede / Archive on canLifecycle, Move on canMove, Permissions on canManage)", () => {
    const i = src("components/documents/InspectorPanel.tsx");
    expect(i).toMatch(/const \{ canManage, canPublishEff, canLifecycle, canMove, sectionOpen \} = lifecycleAffordances\(\{ isController, isOwner, canPublish \}\);/);
    expect(i).not.toMatch(/const canLifecycle =/);
    expect(i).toMatch(/\{sectionOpen && \(\s*\n\s*<CollapsibleSection id="manage"/);
    expect(i).toMatch(/\{canLifecycle && selectedDoc\.id && selectedDoc\.orgId && selectedDoc\.libraryId && uid && \(/);
    expect(i).toMatch(/\{canLifecycle && onSupersede && \(/);
    expect(i).toMatch(/\{canLifecycle && onArchive && \(/);
    expect(i).toMatch(/\{canMove && \(\s*\n\s*<button onClick=\{onMove\}/);
    expect(i).toMatch(/\{canManage && \(\s*\n\s*<button onClick=\{onPermissions\}/);
    expect(src("app/api/documents/move/route.ts")).toMatch(/Only Admins and Document Controllers can move documents/);
  });
  it("the database takes the same authority for an archive (20261060: → 'Archived' is advancing)", () => {
    const m = src("supabase/migrations/20261060_rp_roundE_archive_publish_authority.sql");
    expect(m).toMatch(/OR \(NEW\.status = 'Archived' AND COALESCE\(OLD\.status, ''\) <> 'Archived'\);/);
  });
});

describe("OWN-19 — renumber takes publish authority at the mutator (same population as backfillVersion)", () => {
  const doc = { id: "d1", libraryId: "L", documentNumber: "P-100" } as DocumentRecord;
  it("a member with no library authority and no ownership is refused before any write", async () => {
    db.tables.org_members = [{ org_id: "o1", uid: "u1", status: "active", role: "Drafter", roles: ["Drafter"] }];
    await expect(renumberDocument({ doc, newDocumentNumber: "P-101", reason: "typo", orgId: "o1", actorUserId: "u1" }))
      .rejects.toThrow(/authority to renumber/);
    expect(db.writes.filter((w) => w.table === "documents")).toHaveLength(0);
    expect(audited).toHaveLength(0);
  });
  it("a controller (by the role collection) renumbers and the DOC_RENUMBERED event follows", async () => {
    db.tables.org_members = [{ org_id: "o1", uid: "u1", status: "active", role: "Manager", roles: ["Manager", "DocCtrl"] }];
    await renumberDocument({ doc, newDocumentNumber: " P-101 ", reason: "typo", orgId: "o1", actorUserId: "u1" });
    const upd = db.writes.find((w) => w.table === "documents" && w.method === "update")!.args[0] as Record<string, unknown>;
    expect(upd.document_number).toBe("P-101");
    expect(audited[0]).toMatchObject({ action: "DOC_RENUMBERED", documentId: "d1" });
  });
});

describe("OWN-19 — split / merge targets are born owned by the actor, so the rollback archive passes the guard", () => {
  const actor = { orgId: "o1", actorUserId: "u1", actorEmail: "u1@x", actorRole: "Drafter" };
  it("createNewDocWithFirstVersion stamps owner_user_id = actor and owner_name on the documents INSERT", async () => {
    const r = await createNewDocWithFirstVersion({
      orgId: "o1", libraryId: "L", documentNumber: "P-100-1", title: "Sheet 1", initialRevLabel: "A", changeLog: "split",
      assetTags: [], file: new File([new Uint8Array([1, 2, 3])], "s1.pdf", { type: "application/pdf" }),
      actor, actorName: "Uma", creationAuditAction: "CREATED_FROM_SPLIT", creationDetails: { sourceDocumentId: "src" },
    });
    expect(r.documentId).toBe("new-lib");
    const ins = db.writes.find((w) => w.table === "documents" && w.method === "insert")!.args[0] as Record<string, unknown>;
    expect(ins).toMatchObject({ owner_user_id: "u1", owner_name: "Uma", status: "Issued", created_by: "u1" });
    expect(audited.some((a) => a.action === "CREATED_FROM_SPLIT")).toBe(true);
  });
  it("without a display name the actor's email is the owner-name cache; the version row and promote still land", async () => {
    await createNewDocWithFirstVersion({
      orgId: "o1", libraryId: "L", documentNumber: "P-200", title: "Merged", initialRevLabel: "0", changeLog: "merge",
      assetTags: [], file: new File([new Uint8Array([1])], "m.pdf"), actor, creationAuditAction: "CREATED_FROM_MERGE", creationDetails: {},
    });
    const ins = db.writes.find((w) => w.table === "documents" && w.method === "insert")!.args[0] as Record<string, unknown>;
    expect(ins.owner_user_id).toBe("u1");
    expect(ins.owner_name).toBe("u1@x");
    expect(db.writes.some((w) => w.table === "document_versions" && w.method === "insert")).toBe(true);
    expect(db.writes.some((w) => w.table === "documents" && w.method === "update")).toBe(true);
  });
  it("archiveRolledBackDoc is the client-session UPDATE the guard's owner arm admits for the stamped owner", async () => {
    await archiveRolledBackDoc("new-lib", actor);
    const upd = db.writes.find((w) => w.table === "documents" && w.method === "update")!.args[0] as Record<string, unknown>;
    expect(upd.status).toBe("Archived");
    expect(upd.updated_by).toBe("u1");
    // user_is_effective_owner: an ACTIVE document-level owner short-circuits to p_doc_owner = p_uid
    const fn = src("supabase/migrations/20261042_rp_phase6_revocation_and_succession.sql");
    expect(fn).toMatch(/IF p_doc_owner IS NOT NULL AND member_is_active\(v_org, p_doc_owner\) THEN\s*\n\s*RETURN p_doc_owner = p_uid;/);
    // and the guard's publisher-or-owner arm reads exactly that
    expect(src("supabase/migrations/20261060_rp_roundE_archive_publish_authority.sql"))
      .toMatch(/OR user_is_effective_owner\(NEW\.owner_user_id, NEW\.collection_id, NEW\.library_id, v_actor\);/);
  });
});

// ── OWN-20 · the drawer re-indexes descendants ──────────────────────────────
describe("OWN-20 — a library / folder ACL save re-indexes its subtree through /api/acl/rebuild", () => {
  it("the drawer posts the library id after a library or folder save, and says so if it fails", () => {
    const d = src("components/permissions/PermissionDrawer.tsx");
    expect(d).toMatch(/const rebuildLibraryId = nodeType === "library" \? nodeId : nodeType === "collection" \? props\.libraryId : undefined;/);
    expect(d).toMatch(/fetch\("\/api\/acl\/rebuild", \{/);
    expect(d).toMatch(/body: JSON\.stringify\(\{ orgId: activeOrgId, libraryId: rebuildLibraryId, \.\.\.\(nodeType === "collection" \? \{ collectionId: nodeId \} : \{\}\) \}\)/);
    expect(d).toMatch(/title: "Permissions saved — descendants not yet re-indexed"/);
    expect(d).toMatch(/libraryId\?: string;/);
  });
  it("the save is a checked write: zero rows throws BEFORE the audit row and the rebuild, and the message is surfaced", () => {
    const d = src("components/permissions/PermissionDrawer.tsx");
    const save = d.slice(d.indexOf("const save = async () => {"), d.indexOf("if (!isOpen) return null;"));
    expect(save).toMatch(/\.update\(payload\)\.eq\("id", nodeId\)\.select\("id"\);/);
    expect(save).toMatch(/if \(!saved \|\| saved\.length === 0\) \{\s*\n\s*throw new Error\(`Permissions were NOT saved/);
    expect(save.indexOf("Permissions were NOT saved")).toBeLessThan(save.indexOf('action: "NODE_ACL_CHANGED"'));
    expect(save.indexOf("Permissions were NOT saved")).toBeLessThan(save.indexOf('fetch("/api/acl/rebuild"'));
    expect(save).toMatch(/appAlert\(\{ message: `Failed to save permissions: \$\{\(e as Error\)\.message\}`, tone: "danger" \}\)/);
  });
  it("both drawer hosts hand the folder's library to the drawer", () => {
    expect(src("app/(protected)/documents/[libraryId]/page.tsx")).toMatch(/nodeId=\{\(selectedDoc\?\.id \?\? renameFolderId\) as string\}\s*\n\s*libraryId=\{libraryId\}/);
    const c = src("app/(protected)/admin/permissions/page.tsx");
    expect(c).toMatch(/openDrawer\("collection", f, f\.name, \[lib\.acl \?\? undefined\], lib\.id\)/);
    expect(c).toMatch(/libraryId=\{drawer\.libraryId\}/);
  });
});

// ── OWN-21 · branch resolution ──────────────────────────────────────────────
describe("OWN-21 — branch resolution is a controller-or-owner act", () => {
  it("resolveBranch reads zero rows as a refusal-or-race and says both", () => {
    expect(src("lib/branches.ts")).toMatch(/Branch was not resolved — it was already resolved by someone else, or resolving it takes a controller or the document's owner\./);
  });
  it("the policy (20261061) requires is_org_controller OR the document's effective owner, on top of membership", () => {
    const m = src("supabase/migrations/20261061_rp_roundE_branch_resolution_authority.sql");
    const pol = m.slice(m.indexOf("CREATE POLICY revision_branches_org_update"), m.indexOf("COMMIT;"));
    expect(pol).toMatch(/org_members\.status = 'active'\)\s*\n\s*AND \(\s*\n\s*is_org_controller\(org_id\)\s*\n\s*OR EXISTS \(SELECT 1 FROM documents d/);
    expect(pol).toMatch(/user_is_effective_owner\(d\.owner_user_id, d\.collection_id, d\.library_id, auth\.uid\(\)\)/);
  });
  it("the DEC-11 removals stay removed", () => {
    const p = src("lib/permissions.ts");
    expect(p).not.toMatch(/export function canBlindDrillAccess/);
    expect(p).not.toMatch(/export function filterDiscoverable/);
    expect(src("lib/revisions.ts")).not.toMatch(/p_actor_role/);
  });
});

// ── OWN-22 · Save-As libraries: owned by a controller creator, else unowned ─
describe("OWN-22 — createLibrary stamps a CONTROLLER creator as owner; a non-controller's library is born unowned", () => {
  const member = (role: string, roles: string[]) => ({ org_id: "o1", uid: "u1", status: "active", role, roles });
  it("a controller creator (by the role collection) is stamped owner and an OWNER_ASSIGNED audit row follows", async () => {
    db.tables.org_members = [member("Manager", ["Manager", "DocCtrl"])];
    const lib = await createLibrary({ orgId: "o1", name: "  Sketches ", createdBy: "u1", createdByName: "Uma" });
    expect(lib).toEqual({ id: "new-lib", name: "Sketches", ownerUserId: "u1" });
    const ins = db.writes.find((w) => w.table === "libraries" && w.method === "insert")!.args[0] as Record<string, unknown>;
    expect(ins.owner_user_id).toBe("u1");
    expect(ins.owner_name).toBe("Uma");
    expect(ins.acl).toBeNull();
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ action: "OWNER_ASSIGNED", resourceType: "library", resourceId: "new-lib", orgId: "o1", userId: "u1" });
    expect((audited[0].details as Record<string, unknown>).at_creation).toBe(true);
    expect(notified).toHaveLength(0);
  });
  it("a Supervisor / Manager creator is NOT stamped: owner columns null, no OWNER_ASSIGNED, the controllers are told", async () => {
    db.tables.org_members = [
      member("Supervisor", ["Supervisor"]),
      { org_id: "o1", uid: "dc", status: "active", role: "DocCtrl", roles: ["DocCtrl"] },
      { org_id: "o1", uid: "adm", status: "active", role: "Manager", roles: ["Manager", "Admin"] },
      { org_id: "o1", uid: "gone", status: "suspended", role: "Admin", roles: ["Admin"] },
    ];
    const lib = await createLibrary({ orgId: "o1", name: "Field sketches", createdBy: "u1", createdByName: "Sam" });
    expect(lib.ownerUserId).toBeNull();
    const ins = db.writes.find((w) => w.table === "libraries" && w.method === "insert")!.args[0] as Record<string, unknown>;
    expect(ins.owner_user_id).toBeNull();
    expect(ins.owner_name).toBeNull();
    expect(audited).toHaveLength(0);
    expect(notified.map((n) => n.userId).sort()).toEqual(["adm", "dc"]);
    expect(notified[0]).toMatchObject({ kind: "library_unowned", resourceType: "library", resourceId: "new-lib", actorUserId: "u1" });
    expect(String(notified[0].title)).toMatch(/has no owner/);
  });
  it("an unreadable membership never widens: unknown principal → unowned", async () => {
    db.tables.org_members = [];
    const lib = await createLibrary({ orgId: "o1", name: "X", createdBy: "u1" });
    expect(lib.ownerUserId).toBeNull();
    expect(audited).toHaveLength(0);
  });
  it("a refused insert throws and writes no audit row and no notification", async () => {
    db.tables.org_members = [member("Admin", ["Admin"])];
    db.insertResult = { data: null, error: { message: "new row violates row-level security policy" } };
    await expect(createLibrary({ orgId: "o1", name: "X", createdBy: "u1" })).rejects.toThrow(/row-level security/);
    expect(audited).toHaveLength(0);
    expect(notified).toHaveLength(0);
  });
  it("the Save-As prompt states both outcomes and the picker passes the creator's name", () => {
    const p = src("components/documents/DocumentLinkPicker.tsx");
    expect(p).toMatch(/Admins and Document Control are recorded as the new library's accountable owner\. Otherwise it is created unowned/);
    expect(p).toMatch(/createdByName: member\?\.displayName \?\? userEmail \?\? null/);
  });
  it("the INSERT rail (20261062) refuses a non-controller row born with an owner, ACL or policy — the app half cannot be the only rail", () => {
    const m = src("supabase/migrations/20261062_rp_roundE_library_insert_ownership_rail.sql");
    expect(m).toMatch(/BEFORE INSERT ON libraries\s*\n\s*FOR EACH ROW EXECUTE FUNCTION enforce_library_insert_sensitive_columns\(\);/);
    expect(m).toMatch(/IF NOT is_org_controller\(NEW\.org_id\) THEN/);
    expect(src("lib/libraryCollections.ts")).toMatch(/owner_user_id: creatorOwns \? input\.createdBy : null,/);
  });
});
