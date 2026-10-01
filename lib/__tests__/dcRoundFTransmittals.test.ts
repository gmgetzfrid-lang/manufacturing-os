// document-control Round F wave 2 — P7 TRANSMITTALS: the app half.
//
//   TRX-1   transmit authority is the `transmittal.issue` capability (default
//           = the controller pair the policies named), evaluated per item
//           library (DEC-13); the page draws no role list (DEC-35); a
//           transmittal is created as a draft and issued by an UPDATE.
//   TRX-3   the composer / issue gate refuses withdrawn, held or file-less
//           items (fail closed on an unreadable hold set); a legal hold asks.
//   TRX-6   a receipt recorded on the register goes through the receipt route
//           (service role, transmit authority, the recorder named).
//   TRX-7   every mutation is checked: zero rows throws; audit only on change.
//   TRX-9   the per-document trail distinguishes "none" from "failed".
//   TRX-10  issueTransmittal returns the database's row and the email's real
//           outcome; the sheet is printed from that row.
//   TRX-13  the receipt evidence (IP, note, recorder) is mapped and rendered.
//   TRX-14 / XEDGE-5  the portal URL is built on the public origin and is
//           null (never hostless) on a server with no NEXT_PUBLIC_SITE_URL.
//   fix pass  status truth (only the CURRENT revision is issuable; a Rev
//           mismatch names its cause), the issued file's size on paper, the
//           combined delete rule (permissive AND the 20260818 restrictive
//           guard), the Inspector pill's unknown issued count.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

type Op = [string, unknown[]];
const db = vi.hoisted(() => ({
  calls: [] as Array<{ client: string; table: string; ops: Op[] }>,
  handlers: {} as Record<string, (ops: Op[]) => { data: unknown; error: unknown }>,
  audits: [] as Array<Record<string, unknown>>,
  auditError: null as string | null,
  user: { id: "u-dc", email: "dc@a" } as { id: string; email: string } | null,
}));

function chain(client: string, table: string) {
  const ops: Op[] = [];
  db.calls.push({ client, table, ops });
  const proxy: Record<string, unknown> = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") {
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
          const h = db.handlers[`${client}:${table}`];
          return Promise.resolve(h ? h(ops) : { data: null, error: null }).then(res, rej);
        };
      }
      return (...args: unknown[]) => { ops.push([prop, args]); return proxy; };
    },
  });
  return proxy;
}
const has = (ops: Op[], name: string) => ops.some(([n]) => n === name);
const arg = (ops: Op[], name: string, col?: string) => ops.find(([n, a]) => n === name && (col === undefined || a[0] === col))?.[1];

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => chain("browser", t),
    auth: { getSession: async () => ({ data: { session: { access_token: "jwt" } } }) },
  },
}));
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: (t: string) => chain("admin", t),
    auth: { getUser: async () => ({ data: { user: db.user }, error: db.user ? null : { message: "no" } }) },
  },
}));
vi.mock("@/lib/audit", () => ({
  logAuditAction: vi.fn(async (e: Record<string, unknown>) => { db.audits.push(e); return { error: db.auditError }; }),
}));

import {
  createTransmittal, issueTransmittal, updateTransmittalDraft, voidTransmittal, deleteTransmittal,
  revokeTransmittalLink, listTransmittalsForDocument, acknowledgeTransmittal, sendTransmittalEmail,
  itemIssueBlocker, isTransmittalIssuable, legalHoldNotice, mayTransmit, portalLinkState, portalRowRefusal,
  portalKeyAllowed, hashPrefix, itemAsSentLabel, receiptEvidence, renderTransmittalSheet, rowToTransmittal,
  transmittalPortalUrl, portalOriginConfigured, TRANSMIT_CAPABILITY, mayDeleteDraft, fileSizeLabel,
  DRAFT_DELETE_GUARD_ROLES, assertItemsIssuable, type Transmittal,
} from "@/lib/transmittals";
import { CAPABILITY_DEFS } from "@/lib/capabilityPolicy";

const ORG = "org-a";
const actor = { orgId: ORG, actorUserId: "u-dc", actorName: "dc@a", actorRole: "DocCtrl" };
const src = (p: string) => readFileSync(p, "utf8");

beforeEach(() => {
  db.calls = [];
  db.handlers = {};
  db.audits = [];
  db.auditError = null;
  db.user = { id: "u-dc", email: "dc@a" };
});

// ─── TRX-1: the capability ─────────────────────────────────────────────────
describe("TRX-1 — transmit authority is a capability, default the controller pair, per library", () => {
  it("CAPABILITY_DEFS carries transmittal.issue with the default the policies named (Admin, DocCtrl)", () => {
    const def = CAPABILITY_DEFS.find((d) => d.id === TRANSMIT_CAPABILITY)!;
    expect(def).toBeTruthy();
    expect(def.defaultRoles).toEqual(["Admin", "DocCtrl"]);
    expect(def.area).toBe("Transmittals");
  });
  it("an unconfigured org: Admin / DocCtrl (by the role collection) may transmit; Viewer, Engineer, Manager may not", () => {
    expect(mayTransmit({}, { role: "DocCtrl", roles: ["DocCtrl"] }, ["lib1"])).toBe(true);
    expect(mayTransmit({}, { role: "Admin", roles: [] }, [])).toBe(true);
    expect(mayTransmit({}, { role: "Manager", roles: ["Manager", "DocCtrl"] }, ["lib1"])).toBe(true);
    expect(mayTransmit({}, { role: "Viewer", roles: ["Viewer"] }, ["lib1"])).toBe(false);
    expect(mayTransmit({}, { role: "Engineer-2", roles: ["Engineer-2"] }, [])).toBe(false);
    expect(mayTransmit({}, { role: "Manager", roles: ["Manager"] }, [])).toBe(false);
  });
  it("a library rule replaces the base list for THAT library only — every item's library must admit", () => {
    const policy = { caps: { "transmittal.issue": [{ tokens: ["Admin", "DocCtrl", "Engineer"] }, { tokens: ["DocCtrl"], when: { libraryId: ["ifc"] } }] } };
    const eng = { role: "Engineer-1", roles: ["Engineer-1"] };
    expect(mayTransmit(policy, eng, ["general"])).toBe(true);
    expect(mayTransmit(policy, eng, ["general", "ifc"])).toBe(false);
    expect(mayTransmit(policy, { role: "DocCtrl", roles: ["DocCtrl"] }, ["general", "ifc"])).toBe(true);
    // an item whose library is unknown is judged on the base list
    expect(mayTransmit(policy, eng, [null])).toBe(true);
  });
  it("a personal grant of transmittal.issue admits", () => {
    const policy = { grants: [{ cap: "transmittal.issue" as const, uid: "u-v" }] };
    expect(mayTransmit(policy, { role: "Viewer", roles: [], uid: "u-v" }, ["x"])).toBe(true);
  });
  it("the register page draws no role list — authority comes from the policy (DEC-35)", () => {
    const page = src("app/(protected)/transmittals/page.tsx");
    expect(page).not.toMatch(/"Admin"|"DocCtrl"|'Admin'|'DocCtrl'/);
    expect(page).toMatch(/mayTransmit\(policy, principal, t\.items\.map/);
    expect(page).toMatch(/loadCapabilityPolicy\(activeOrgId\)/);
    // Issue is disabled for a principal without transmit authority
    expect(page).toMatch(/disabled=\{!!saving \|\| !issuable \|\| !canIssue\}/);
    // receipt / revoke / void render only for a transmit authority
    expect(page).toMatch(/t\.status === "issued" && transmitter &&/);
    expect(page).toMatch(/\(t\.status === "issued" \|\| t\.status === "acknowledged"\) && transmitter &&/);
  });
  it("createTransmittal inserts a DRAFT only — no status issued, no portal token, no issue time", async () => {
    const inserts: Record<string, unknown>[] = [];
    db.handlers["browser:transmittals"] = (ops) => {
      if (has(ops, "insert")) { inserts.push(arg(ops, "insert")![0] as Record<string, unknown>); return { data: { id: "t1", org_id: ORG, seq: 1, number: "TR-0001", status: "draft", items: [] }, error: null }; }
      return { data: [], error: null };
    };
    const t = await createTransmittal({ orgId: ORG, items: [], actorUserId: "u-v", recipientName: "Acme" });
    expect(t.status).toBe("draft");
    expect(inserts[0].status).toBe("draft");
    expect(inserts[0]).not.toHaveProperty("portal_token");
    expect(inserts[0]).not.toHaveProperty("issued_at");
    expect(db.audits.map((a) => a.action)).toEqual(["TRANSMITTAL_CREATED"]);
  });
});

// ─── TRX-3: the issue gate ─────────────────────────────────────────────────
describe("TRX-3 — withdrawn, held or file-less items cannot be issued", () => {
  const it1 = { documentId: "d1", number: "P-1", versionId: "v1" };
  it("itemIssueBlocker names the reason; an unreadable hold set blocks (fail closed)", () => {
    expect(itemIssueBlocker(it1, { found: true, status: "Issued", holds: [], currentVersionId: "v1" })).toBeNull();
    expect(itemIssueBlocker(it1, { found: true, status: "Superseded", holds: [] })).toMatch(/withdrawn \(superseded\)/);
    expect(itemIssueBlocker(it1, { found: true, status: "Void", holds: [] })).toMatch(/withdrawn \(void\)/);
    expect(itemIssueBlocker(it1, { found: true, status: "Issued", archivedAt: "2026-01-01", holds: [] })).toMatch(/withdrawn \(archived\)/);
    expect(itemIssueBlocker(it1, { found: true, status: "Issued", holds: ["Missing Vendor Data"] })).toMatch(/active hold \(Missing Vendor Data\)/);
    expect(itemIssueBlocker(it1, { found: true, status: "Issued", holds: null })).toMatch(/treated as held/);
    expect(itemIssueBlocker(it1, { found: false })).toMatch(/could not be read/);
    expect(itemIssueBlocker({ documentId: "d2", number: "P-2" }, { found: true, status: "Issued", holds: [], currentVersionId: null })).toMatch(/no published file/);
    // a Draft may go out (for review / approval); its status is recorded as sent
    expect(itemIssueBlocker(it1, { found: true, status: "Draft", holds: [], currentVersionId: "v1" })).toBeNull();
  });
  it("isTransmittalIssuable honours the facts when given, and keeps its two-field rule without them", () => {
    const t = { items: [it1], recipientName: "Acme" };
    expect(isTransmittalIssuable(t)).toBe(true);
    expect(isTransmittalIssuable(t, new Map([["d1", { found: true, status: "Issued", holds: [], currentVersionId: "v1" }]]))).toBe(true);
    expect(isTransmittalIssuable(t, new Map([["d1", { found: true, status: "Issued", holds: ["X"] }]]))).toBe(false);
    expect(isTransmittalIssuable(t, new Map())).toBe(false); // facts not loaded for the item → not yet
  });
  it("a legal hold asks for confirmation rather than blocking", () => {
    const facts = new Map([["d1", { found: true, status: "Issued", holds: [], legalHold: true, currentVersionId: "v1" }]]);
    expect(itemIssueBlocker(it1, facts.get("d1"))).toBeNull();
    expect(legalHoldNotice([it1], facts)).toMatch(/P-1 is under a legal hold/);
    expect(legalHoldNotice([it1], new Map([["d1", { found: true, holds: [] }]]))).toBeNull();
  });
  it("issueTransmittal refuses a held item through the shared hold gate (HLD-1) — nothing is written", async () => {
    db.handlers["browser:transmittals"] = (ops) => has(ops, "update")
      ? { data: null, error: null }
      : { data: { id: "t1", org_id: ORG, seq: 1, number: "TR-0001", status: "draft", recipient_name: "Acme", items: [{ documentId: "d1", number: "P-1", versionId: "v1" }] }, error: null };
    db.handlers["browser:documents"] = () => ({ data: [{ id: "d1", status: "Issued", archived_at: null, current_version_id: "v1" }], error: null });
    db.handlers["browser:document_holds"] = () => ({ data: [{ id: "h1", reason: "Missing Vendor Data" }], error: null });
    await expect(issueTransmittal("t1", actor)).rejects.toThrow(/active hold \(Missing Vendor Data\).*issuing it on a transmittal/);
    expect(db.calls.some((c) => c.table === "transmittals" && has(c.ops, "update"))).toBe(false);
    expect(db.audits).toEqual([]);
  });
  it("issueTransmittal refuses a withdrawn item before any write", async () => {
    db.handlers["browser:transmittals"] = () => ({ data: { id: "t1", org_id: ORG, seq: 1, number: "TR-0001", status: "draft", recipient_name: "Acme", items: [{ documentId: "d1", number: "P-1", versionId: "v1" }] }, error: null });
    db.handlers["browser:documents"] = () => ({ data: [{ id: "d1", status: "Superseded", archived_at: null, current_version_id: "v1" }], error: null });
    await expect(issueTransmittal("t1", actor)).rejects.toThrow(/withdrawn \(superseded\)/);
    expect(db.calls.some((c) => c.table === "transmittals" && has(c.ops, "update"))).toBe(false);
  });
  it("status truth: an item pinned to a revision that is no longer current is refused, naming the revision that superseded it", () => {
    const stale = { documentId: "d1", number: "P-200-001", rev: "C", versionId: "vC" };
    const facts = { found: true, status: "Issued", holds: [], currentVersionId: "vD", rev: "D", currentRevisionLabel: "D" };
    expect(itemIssueBlocker(stale, facts)).toBe("P-200-001 Rev C has been superseded by Rev D — remove P-200-001 and add it again to send the current revision.");
    // re-added at the current revision it is issuable
    expect(itemIssueBlocker({ ...stale, rev: "D", versionId: "vD" }, facts)).toBeNull();
    // the label of the current file unread → still refused (the pin is not current), the label just unnamed
    expect(itemIssueBlocker(stale, { ...facts, currentRevisionLabel: undefined })).toMatch(/superseded by Rev a newer revision/);
    // a pin on a document with no current file at all
    expect(itemIssueBlocker(stale, { ...facts, currentVersionId: null })).toMatch(/no published file to send/);
  });
  it("a Rev mismatch names its cause: the document's Rev field drifted from its file (correct the document) vs a stale item (re-add it)", () => {
    const facts = { found: true, status: "Issued", holds: [], currentVersionId: "vA", rev: "B", currentRevisionLabel: "A" };
    // the composer built the item from documents.rev (B) and the current version (labelled A): re-adding cannot help
    expect(itemIssueBlocker({ documentId: "d2", number: "P-300", rev: "B", versionId: "vA" }, facts))
      .toBe("P-300: the document's Rev field (B) does not match its current file (Rev A) — correct the document's revision before issuing it.");
    // an item whose rev matches neither is stale
    expect(itemIssueBlocker({ documentId: "d2", number: "P-300", rev: "X" }, { ...facts, rev: "A" }))
      .toBe("P-300 is listed at Rev X, but its current file is Rev A — remove P-300 and add it again.");
    // labels compared trimmed; an unread label leaves it to the database
    expect(itemIssueBlocker({ documentId: "d2", number: "P-300", rev: " A ", versionId: "vA" }, { ...facts, rev: "A" })).toBeNull();
    expect(itemIssueBlocker({ documentId: "d2", number: "P-300", rev: "B", versionId: "vA" }, { ...facts, currentRevisionLabel: undefined })).toBeNull();
  });
  it("assertItemsIssuable reads the current files' labels and refuses a superseded pin before any write", async () => {
    db.handlers["browser:documents"] = () => ({ data: [{ id: "d1", status: "Issued", archived_at: null, current_version_id: "vD", rev: "D" }], error: null });
    db.handlers["browser:document_versions"] = () => ({ data: [{ id: "vD", revision_label: "D" }], error: null });
    db.handlers["browser:document_holds"] = () => ({ data: [], error: null });
    await expect(assertItemsIssuable(ORG, [{ documentId: "d1", number: "P-200-001", rev: "C", versionId: "vC" }]))
      .rejects.toThrow("P-200-001 Rev C has been superseded by Rev D");
    const docRead = db.calls.find((c) => c.table === "documents")!;
    expect(String(arg(docRead.ops, "select")![0])).toContain("rev");
    const verRead = db.calls.find((c) => c.table === "document_versions")!;
    expect(arg(verRead.ops, "in", "id")).toEqual(["id", ["vD"]]);
    expect(arg(verRead.ops, "eq", "org_id")).toEqual(["org_id", ORG]);
    // the current pin passes
    await expect(assertItemsIssuable(ORG, [{ documentId: "d1", number: "P-200-001", rev: "D", versionId: "vD" }])).resolves.toBeUndefined();
  });
  it("the composer reads the current file's label and the document's Rev field into its facts", () => {
    const page = src("app/(protected)/transmittals/page.tsx");
    expect(page).toContain('select("id, status, archived_at, current_version_id, legal_hold, library_id, rev")');
    expect(page).toContain('supabase.from("document_versions").select("id, revision_label").eq("org_id", orgId).in("id", currentIds)');
    expect(page).toMatch(/currentRevisionLabel: d\.current_version_id && labelOf\.has\(String\(d\.current_version_id\)\) \? labelOf\.get\(String\(d\.current_version_id\)\) : undefined,/);
  });
  it("the composer's picker excludes the shared not-current set and archived documents; a withdrawn deep link is not pre-loaded", () => {
    const page = src("app/(protected)/transmittals/page.tsx");
    expect(page).toMatch(/const NOT_CURRENT_FILTER = `\(\$\{\[\.\.\.NOT_CURRENT_STATUSES\]\.join\(","\)\}\)`;/);
    expect(page).toMatch(/\.not\("status", "in", NOT_CURRENT_FILTER\)\s*\n\s*\.is\("archived_at", null\)/);
    expect(page).toMatch(/if \(data && !withdrawn\) \{/);
  });
});

// ─── TRX-7 / TRX-10: checked writes and the truthful issue outcome ─────────
describe("TRX-7 / TRX-10 — every mutation is checked; issue returns the row the database wrote", () => {
  const draftRow = { id: "t1", org_id: ORG, seq: 1, number: "TR-0001", status: "draft", recipient_name: "Acme", recipient_email: "jane@buildco.com", items: [{ documentId: "d1", number: "P-1", versionId: "v1" }] };
  beforeEach(() => {
    db.handlers["browser:documents"] = () => ({ data: [{ id: "d1", status: "Issued", archived_at: null, current_version_id: "v1" }], error: null });
    db.handlers["browser:document_holds"] = () => ({ data: [], error: null });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("an issue that changed no row throws and writes NO audit row (it used to log TRANSMITTAL_ISSUED regardless)", async () => {
    db.handlers["browser:transmittals"] = (ops) => has(ops, "update") ? { data: null, error: null } : { data: draftRow, error: null };
    await expect(issueTransmittal("t1", actor)).rejects.toThrow(/was not issued — it is no longer a draft, or you do not hold transmit authority/);
    expect(db.audits).toEqual([]);
  });

  it("a confirmed issue returns the DB row (portal token + snapshot), audits once, and reports the email's real outcome", async () => {
    db.handlers["browser:transmittals"] = (ops) => has(ops, "update")
      ? { data: { ...draftRow, status: "issued", issued_at: "2026-10-01T00:00:00Z", portal_token: "tok", portal_expires_at: "2026-12-30T00:00:00Z", items: [{ documentId: "d1", number: "P-1", versionId: "v1", fileHash: "abc", statusAsSent: "Issued" }] }, error: null }
      : { data: draftRow, error: null };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, sent: false, reason: "this deployment has no public site URL" }), { status: 200 })));
    const out = await issueTransmittal("t1", actor);
    expect(out.transmittal.portalToken).toBe("tok");
    expect(out.transmittal.items[0].fileHash).toBe("abc");
    expect(out.portal).toBe("ready");
    expect(out.email).toEqual({ sent: false, reason: "this deployment has no public site URL" });
    expect(db.audits.map((a) => a.action)).toEqual(["TRANSMITTAL_ISSUED"]);
    // the client never sends a portal token any more — the database mints it
    const upd = db.calls.find((c) => c.table === "transmittals" && has(c.ops, "update"))!;
    expect(arg(upd.ops, "update")![0]).not.toHaveProperty("portal_token");
  });

  it("a row with no portal token reports portal: missing (pre-20260910), and no email is attempted", async () => {
    db.handlers["browser:transmittals"] = (ops) => has(ops, "update") ? { data: { ...draftRow, status: "issued" }, error: null } : { data: draftRow, error: null };
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const out = await issueTransmittal("t1", actor);
    expect(out.portal).toBe("missing");
    expect(out.email.sent).toBe(false);
    expect(out.email.reason).toMatch(/predates 20260910/);
    expect(f).not.toHaveBeenCalled();
  });

  it("the composer prints the cover sheet from the outcome's row, not a synthesized object", () => {
    const page = src("app/(protected)/transmittals/page.tsx");
    expect(page).toMatch(/void openTransmittalSheet\(result\.outcome\.transmittal\);/);
    expect(page).not.toMatch(/status: "issued", issuedAt: new Date\(\)\.toISOString\(\)/);
    expect(page).not.toMatch(/portal link emailed to \$\{t\.recipientEmail\.trim\(\)\} and /);
  });

  it("updateTransmittalDraft / voidTransmittal / deleteTransmittal / revokeTransmittalLink throw on zero rows and audit only on change", async () => {
    db.handlers["browser:transmittals"] = () => ({ data: [], error: null });
    await expect(updateTransmittalDraft("t1", { subject: "x" })).rejects.toThrow(/was not saved/);
    await expect(voidTransmittal("t1", actor)).rejects.toThrow(/was not voided/);
    await expect(deleteTransmittal("t1")).rejects.toThrow(/was not deleted/);
    await expect(revokeTransmittalLink("t1", actor)).rejects.toThrow(/was not revoked/);
    expect(db.audits).toEqual([]);
    db.handlers["browser:transmittals"] = () => ({ data: [{ id: "t1" }], error: null });
    await voidTransmittal("t1", actor);
    await revokeTransmittalLink("t1", actor);
    expect(db.audits.map((a) => a.action)).toEqual(["TRANSMITTAL_VOIDED", "TRANSMITTAL_LINK_REVOKED"]);
  });

  it("Delete is drawn from BOTH delete policies: the author; otherwise a controller who is also Admin / Manager or manages the draft's project", () => {
    const draft = { status: "draft" as const, createdBy: "u-eng", projectId: "p1" };
    // the author, whatever their roles
    expect(mayDeleteDraft(draft, { role: "Engineer-1", roles: ["Engineer-1"], uid: "u-eng" })).toBe(true);
    // a DocCtrl who is not Admin / Manager: the RESTRICTIVE 20260818 guard refuses — not shown
    expect(mayDeleteDraft(draft, { role: "DocCtrl", roles: ["DocCtrl"], uid: "u-dc" })).toBe(false);
    // ... unless they manage the draft's project
    expect(mayDeleteDraft(draft, { role: "DocCtrl", roles: ["DocCtrl"], uid: "u-dc" }, new Set(["p1"]))).toBe(true);
    expect(mayDeleteDraft({ ...draft, projectId: null }, { role: "DocCtrl", roles: ["DocCtrl"], uid: "u-dc" }, new Set(["p1"]))).toBe(false);
    // Admin (a controller, and Admin) — and a DocCtrl who also holds Manager (additive)
    expect(mayDeleteDraft(draft, { role: "Admin", roles: ["Admin"], uid: "u-a" })).toBe(true);
    expect(mayDeleteDraft(draft, { role: "Manager", roles: ["Manager", "DocCtrl"], uid: "u-m" })).toBe(true);
    // a Manager who is not a controller: the permissive policy refuses
    expect(mayDeleteDraft(draft, { role: "Manager", roles: ["Manager"], uid: "u-m" })).toBe(false);
    // never an issued record
    expect(mayDeleteDraft({ ...draft, status: "issued" as const }, { role: "Admin", roles: ["Admin"], uid: "u-eng" })).toBe(false);
    expect(DRAFT_DELETE_GUARD_ROLES).toEqual(["Admin", "Manager"]);
  });
  it("the register draws Delete from mayDeleteDraft (with the projects the controller manages), and the refusal names the real rule", async () => {
    const page = src("app/(protected)/transmittals/page.tsx");
    expect(page).toContain("const canDeleteDraft = (t: Transmittal) => mayDeleteDraft(t, principal, managedProjects);");
    expect(page).not.toContain("const canDeleteDraft = (t: Transmittal) => isController || (!!uid && t.createdBy === uid);");
    expect(page).toContain('supabase.from("project_members").select("project_id, role").eq("user_id", uid)');
    db.handlers["browser:transmittals"] = () => ({ data: [], error: null });
    await expect(deleteTransmittal("t1")).rejects.toThrow(/its author can; otherwise a Document Controller who is also an Admin or Manager, or who manages the draft's project/);
    expect(src("lib/transmittals.ts")).not.toContain("only its author or a Document Controller can delete it");
  });
  it("void is constrained to issued / acknowledged (TRX-2 dw3); revoke to a live link", async () => {
    db.handlers["browser:transmittals"] = () => ({ data: [{ id: "t1" }], error: null });
    await voidTransmittal("t1", actor);
    await revokeTransmittalLink("t1", actor);
    const [v, r] = db.calls.filter((c) => c.table === "transmittals");
    expect(arg(v.ops, "in", "status")).toEqual(["status", ["issued", "acknowledged"]]);
    expect(has(v.ops, "neq")).toBe(false);
    expect(arg(r.ops, "is", "portal_revoked_at")).toEqual(["portal_revoked_at", null]);
  });

  it("a refused audit row is surfaced, not swallowed (the change stands)", async () => {
    db.handlers["browser:transmittals"] = () => ({ data: [{ id: "t1" }], error: null });
    db.auditError = "permission denied";
    expect(await voidTransmittal("t1", actor)).toEqual({ auditError: "permission denied" });
  });

  it("sendTransmittalEmail reports why it did not send", async () => {
    const t = rowToTransmittal({ ...draftRow, status: "issued", portal_token: "tok" });
    expect(await sendTransmittalEmail({ ...t, recipientEmail: null }, actor)).toEqual({ sent: false, reason: "no recipient email on the transmittal" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Only a transmit authority…" }), { status: 403 })));
    expect(await sendTransmittalEmail(t, actor)).toEqual({ sent: false, reason: "Only a transmit authority…" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, sent: true }), { status: 200 })));
    expect(await sendTransmittalEmail(t, actor)).toEqual({ sent: true, reason: null });
  });
});

// ─── TRX-6: the receipt route ──────────────────────────────────────────────
describe("TRX-6 — a register receipt goes through the server, by a transmit authority, naming the recorder", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("acknowledgeTransmittal posts to the receipt route and never writes the row itself", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, acknowledgedAt: "2026-10-01T00:00:00Z" }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await acknowledgeTransmittal("t1", "Jane", actor, "signed sheet returned");
    expect(f).toHaveBeenCalledWith("/api/transmittal/receipt", expect.objectContaining({ method: "POST" }));
    expect(db.calls.some((c) => c.table === "transmittals")).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Only a transmit authority" }), { status: 403 })));
    await expect(acknowledgeTransmittal("t1", "Jane", actor)).rejects.toThrow(/Only a transmit authority/);
  });

  const issued = { id: "t1", org_id: ORG, seq: 1, number: "TR-0001", status: "issued", items: [{ documentId: "d1", number: "P-1", versionId: "v1" }] };
  function receiptReq(body: Record<string, unknown>) {
    return new NextRequest("https://app/api/transmittal/receipt", { method: "POST", body: JSON.stringify(body), headers: { authorization: "Bearer jwt", "content-type": "application/json" } });
  }
  function seat(role: string, roles: string[]) {
    db.handlers["admin:org_members"] = () => ({ data: { role, roles, email: `${role}@a` }, error: null });
    db.handlers["admin:org_configurations"] = () => ({ data: null, error: null });
    db.handlers["admin:documents"] = () => ({ data: [{ id: "d1", library_id: "lib1" }], error: null });
  }

  it("a Viewer is refused (403) and nothing is written", async () => {
    const { POST } = await import("@/app/api/transmittal/receipt/route");
    seat("Viewer", ["Viewer"]);
    db.handlers["admin:transmittals"] = (ops) => has(ops, "update") ? { data: [{ id: "t1" }], error: null } : { data: issued, error: null };
    const res = await POST(receiptReq({ transmittalId: "t1", name: "Jane" }));
    expect(res.status).toBe(403);
    expect(db.calls.some((c) => c.table === "transmittals" && has(c.ops, "update"))).toBe(false);
  });

  it("a Document Controller records it: acknowledged_via manual, the recorder in acknowledged_meta, a checked write, a server audit row", async () => {
    const { POST } = await import("@/app/api/transmittal/receipt/route");
    seat("DocCtrl", ["DocCtrl"]);
    const audits: Record<string, unknown>[] = [];
    db.handlers["admin:audit_logs"] = (ops) => { audits.push(arg(ops, "insert")![0] as Record<string, unknown>); return { data: null, error: null }; };
    db.handlers["admin:transmittals"] = (ops) => has(ops, "update") ? { data: [{ id: "t1" }], error: null } : { data: issued, error: null };
    const res = await POST(receiptReq({ transmittalId: "t1", name: "Jane", note: "signed sheet back" }));
    expect(res.status).toBe(200);
    const upd = db.calls.find((c) => c.table === "transmittals" && has(c.ops, "update"))!;
    expect(arg(upd.ops, "update")![0]).toMatchObject({
      status: "acknowledged", acknowledged_by_name: "Jane", acknowledged_via: "manual",
      acknowledged_meta: { recordedBy: "u-dc", recordedByEmail: "DocCtrl@a", note: "signed sheet back" },
    });
    expect(arg(upd.ops, "eq", "status")).toEqual(["status", "issued"]);
    expect(audits[0]).toMatchObject({ action: "TRANSMITTAL_ACKNOWLEDGED", user_id: "u-dc" });
  });

  it("a write that changed no row is a 409, not a success", async () => {
    const { POST } = await import("@/app/api/transmittal/receipt/route");
    seat("DocCtrl", ["DocCtrl"]);
    db.handlers["admin:transmittals"] = (ops) => has(ops, "update") ? { data: [], error: null } : { data: issued, error: null };
    expect((await POST(receiptReq({ transmittalId: "t1", name: "Jane" }))).status).toBe(409);
  });

  it("an unreadable capability policy denies (fail closed, 503)", async () => {
    const { POST } = await import("@/app/api/transmittal/receipt/route");
    seat("DocCtrl", ["DocCtrl"]);
    db.handlers["admin:org_configurations"] = () => ({ data: null, error: { message: "boom" } });
    db.handlers["admin:transmittals"] = () => ({ data: issued, error: null });
    expect((await POST(receiptReq({ transmittalId: "t1", name: "Jane" }))).status).toBe(503);
  });
});

// ─── TRX-1 / TRX-14: the email route ───────────────────────────────────────
describe("send-email — transmit authority by capability; never a hostless link", () => {
  const issued = { id: "t1", org_id: ORG, seq: 1, number: "TR-0001", status: "issued", recipient_email: "jane@buildco.com", portal_token: "tok123", items: [{ documentId: "d1", number: "P-1" }] };
  function req() {
    return new NextRequest("https://app/api/transmittal/send-email", { method: "POST", body: JSON.stringify({ transmittalId: "t1" }), headers: { authorization: "Bearer jwt", "content-type": "application/json" } });
  }
  beforeEach(() => {
    db.handlers["admin:org_configurations"] = () => ({ data: null, error: null });
    db.handlers["admin:documents"] = () => ({ data: [{ id: "d1", library_id: "lib1" }], error: null });
    db.handlers["admin:transmittals"] = () => ({ data: issued, error: null });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("the creator WITHOUT the capability is refused (the old issuer arm is gone)", async () => {
    const { POST } = await import("@/app/api/transmittal/send-email/route");
    db.handlers["admin:transmittals"] = () => ({ data: { ...issued, created_by: "u-dc" }, error: null });
    db.handlers["admin:org_members"] = () => ({ data: { role: "Engineer-1", roles: ["Engineer-1"], email: "e@a" }, error: null });
    expect((await POST(req())).status).toBe(403);
  });

  it("with NEXT_PUBLIC_SITE_URL unset the server refuses to email (sent: false, the reason) and queues nothing", async () => {
    const { POST } = await import("@/app/api/transmittal/send-email/route");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    db.handlers["admin:org_members"] = () => ({ data: { role: "DocCtrl", roles: ["DocCtrl"], email: "dc@a" }, error: null });
    const res = await POST(req());
    expect(await res.json()).toMatchObject({ sent: false, reason: expect.stringMatching(/no public site URL/) });
    expect(db.calls.some((c) => c.table === "email_notifications")).toBe(false);
  });

  it("with it set, the email carries the absolute public link", async () => {
    const { POST } = await import("@/app/api/transmittal/send-email/route");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example.com/");
    db.handlers["admin:org_members"] = () => ({ data: { role: "DocCtrl", roles: ["DocCtrl"], email: "dc@a" }, error: null });
    const queued: Record<string, unknown>[] = [];
    db.handlers["admin:email_notifications"] = (ops) => { queued.push(arg(ops, "insert")![0] as Record<string, unknown>); return { data: null, error: null }; };
    const res = await POST(req());
    expect(await res.json()).toMatchObject({ sent: true });
    expect(String(queued[0].body_text)).toContain("https://app.example.com/transmittal/tok123");
  });

  it("a revoked link is not emailed", async () => {
    const { POST } = await import("@/app/api/transmittal/send-email/route");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example.com");
    db.handlers["admin:transmittals"] = () => ({ data: { ...issued, portal_revoked_at: "2026-09-30T00:00:00Z" }, error: null });
    db.handlers["admin:org_members"] = () => ({ data: { role: "DocCtrl", roles: ["DocCtrl"], email: "dc@a" }, error: null });
    expect(await (await POST(req())).json()).toMatchObject({ sent: false, reason: "the portal link is revoked" });
  });
});

// ─── TRX-14 / XEDGE-5: the portal URL ──────────────────────────────────────
describe("TRX-14 / XEDGE-5 — the portal URL is built on the public origin, never hostless", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it("with NEXT_PUBLIC_SITE_URL set and no window (the server), the URL is absolute and rooted there", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example.com/");
    expect(typeof window).toBe("undefined");
    expect(transmittalPortalUrl("tok")).toBe("https://app.example.com/transmittal/tok");
    expect(portalOriginConfigured()).toBe(true);
  });
  it("with it unset on the server, there is no link at all (null) — never `/transmittal/<token>`", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    vi.stubEnv("NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL", "");
    expect(transmittalPortalUrl("tok")).toBeNull();
    expect(portalOriginConfigured()).toBe(false);
  });
  it("lib/transmittals no longer reads window.location.origin itself", () => {
    expect(src("lib/transmittals.ts")).not.toMatch(/window\.location\.origin/);
  });
});

// ─── TRX-9: the per-document trail ─────────────────────────────────────────
describe("TRX-9 — the transmittal trail says when it could not be read", () => {
  it("listTransmittalsForDocument throws on a real error and answers [] only for a missing table", async () => {
    db.handlers["browser:transmittals"] = () => ({ data: null, error: { code: "42501", message: "permission denied" } });
    await expect(listTransmittalsForDocument(ORG, "d1")).rejects.toThrow(/Couldn't read the transmittal trail: permission denied/);
    db.handlers["browser:transmittals"] = () => ({ data: null, error: { code: "42P01", message: "relation transmittals does not exist" } });
    expect(await listTransmittalsForDocument(ORG, "d1")).toEqual([]);
  });
  it("the Inspector's distribution pill marks the issued count unknown on a failed read and still shows the acks counts", () => {
    const panel = src("components/documents/InspectorPanel.tsx");
    expect(panel).toContain("useState<{ issued: number | null; issuedCapped: boolean; ackDone: number; ackTotal: number } | null>(null)");
    // the transmittal read is caught on its own …
    expect(panel).toMatch(/issuedCapped = list\.length >= 50;\s*\n\s*\} catch \{ issued = null; \}\s*\n\s*try \{\s*\n\s*let ackDone = 0;/);
    // … and the pill renders the unknown count beside the acks
    expect(panel).toContain("distSummary && (distSummary.issued === null || distSummary.issued > 0 || distSummary.ackTotal > 0)");
    expect(panel).toContain('{distSummary.issued === null ? "? issued" :');
    expect(panel).not.toMatch(/\} catch \{ if \(alive\) setDistSummary\(null\); \}/);
  });
  it("the Inspector's TransmittalTrail renders the failure instead of an empty trail", () => {
    const panel = src("components/documents/InspectorPanel.tsx");
    const trail = panel.slice(panel.indexOf("function TransmittalTrail("));
    expect(trail).toMatch(/\}\)\(\)\.catch\(\(e: unknown\) => \{/);
    expect(trail).toMatch(/if \(failed\) \{/);
    expect(trail).toMatch(/it is not &quot;never transmitted&quot;/);
  });
});

// ─── TRX-4: link state ─────────────────────────────────────────────────────
describe("TRX-4 — the portal link's own state", () => {
  const base = { status: "issued" as const, portalToken: "tok", portalRevokedAt: null, portalExpiresAt: null };
  it("portalLinkState separates the link from the record", () => {
    expect(portalLinkState({ ...base })).toBe("live");
    expect(portalLinkState({ ...base, portalToken: null })).toBe("none");
    expect(portalLinkState({ ...base, status: "voided" })).toBe("voided");
    expect(portalLinkState({ ...base, portalRevokedAt: "2026-09-01" })).toBe("revoked");
    expect(portalLinkState({ ...base, portalExpiresAt: "2026-01-01T00:00:00Z" }, Date.parse("2026-02-01"))).toBe("expired");
    expect(portalLinkState({ ...base, portalExpiresAt: "2026-03-01T00:00:00Z" }, Date.parse("2026-02-01"))).toBe("live");
  });
  it("portalRowRefusal answers voided / revoked / expired distinctly, and never serves a draft", () => {
    expect(portalRowRefusal({ status: "voided" })).toEqual({ status: 410, error: "voided" });
    expect(portalRowRefusal({ status: "draft" })).toEqual({ status: 404, error: "notfound" });
    expect(portalRowRefusal({ status: "acknowledged", portal_revoked_at: "x" })).toEqual({ status: 410, error: "revoked" });
    expect(portalRowRefusal({ status: "issued", portal_expires_at: "2020-01-01T00:00:00Z" })).toEqual({ status: 410, error: "expired" });
    expect(portalRowRefusal({ status: "issued", portal_expires_at: null })).toBeNull();
  });
  it("portalKeyAllowed refuses another workspace's prefix and unsafe keys; a legacy un-prefixed key stays readable", () => {
    expect(portalKeyAllowed("orgs/o1/d/a.pdf", "o1")).toBe(true);
    expect(portalKeyAllowed("orgs/o2/d/a.pdf", "o1")).toBe(false);
    expect(portalKeyAllowed("orgs/o1/../o2/a.pdf", "o1")).toBe(false);
    expect(portalKeyAllowed("legacy/a.pdf", "o1")).toBe(true);
  });
});

// ─── TRX-8 / TRX-3 / TRX-13: what the paper says ───────────────────────────
describe("TRX-8 / TRX-3 / TRX-13 — the cover sheet and evidence carry the as-sent snapshot and the receipt's evidence", () => {
  const t: Transmittal = {
    id: "t1", orgId: ORG, seq: 7, number: "TR-0007", status: "acknowledged",
    recipientName: "Jane Doe", recipientCompany: "BuildCo",
    acknowledgedByName: "Jane Doe", acknowledgedAt: "2026-10-01T09:00:00Z", acknowledgedVia: "portal",
    acknowledgedMeta: { ip: "203.0.113.9", note: "received, distributing", userAgent: "UA" },
    items: [{ documentId: "d1", number: "P-101", title: "Plot", rev: "C", versionId: "v1", fileHash: "0123456789abcdef0123", fileSize: 2516582, statusAsSent: "Issued", effectiveDate: "2099-01-01" }],
  };
  it("hashPrefix / itemAsSentLabel", () => {
    expect(hashPrefix("0123456789abcdef")).toBe("0123456789ab");
    expect(hashPrefix(null)).toBeNull();
    expect(itemAsSentLabel({ statusAsSent: "Issued", effectiveDate: "2099-01-01" }, new Date("2026-10-01"))).toBe("Issued · effective 2099-01-01 (not yet in force)");
    expect(itemAsSentLabel({ statusAsSent: "Draft" })).toBe("Draft");
    expect(itemAsSentLabel({})).toBeNull();
  });
  it("the sheet prints status-as-sent, the effective date and a SHA-256 prefix per document", () => {
    const html = renderTransmittalSheet(t);
    expect(html).toContain("Status as sent");
    expect(html).toContain("SHA-256");
    expect(html).toContain("0123456789ab");
    expect(html).toContain("effective 2099-01-01 (not yet in force)");
    // TRX-8 dw1: the issued file's size beside the hash prefix
    expect(html).toContain("SHA-256 · size");
    expect(html).toContain('0123456789ab<div class="muted">2.4 MB</div>');
  });
  it("fileSizeLabel", () => {
    expect(fileSizeLabel(512)).toBe("512 B");
    expect(fileSizeLabel(2516582)).toBe("2.4 MB");
    expect(fileSizeLabel(39845888)).toBe("38.0 MB");
    expect(fileSizeLabel(150 * 1024 * 1024)).toBe("150 MB");
    expect(fileSizeLabel(null)).toBeNull();
    expect(fileSizeLabel(Number.NaN)).toBeNull();
  });
  it("the sheet's receipt block shows the portal-side evidence (time, source address, the recipient's note)", () => {
    const html = renderTransmittalSheet(t);
    expect(html).toContain("through the recipient portal from 203.0.113.9");
    expect(html).toContain("Their note: &quot;received, distributing&quot;");
  });
  it("a register receipt names who recorded it", () => {
    expect(receiptEvidence({ ...t, acknowledgedVia: "manual", acknowledgedMeta: { recordedByEmail: "dc@a" } })).toMatch(/recorded on the register by dc@a/);
  });
  it("rowToTransmittal maps acknowledged_meta and the portal lifecycle columns", () => {
    const r = rowToTransmittal({
      id: "t", org_id: "o", seq: 1, number: "TR-0001", status: "acknowledged",
      acknowledged_meta: { ip: "1.2.3.4", note: "ok", userAgent: "UA" },
      portal_expires_at: "2026-12-30", portal_revoked_at: null, portal_open_count: 3, portal_download_count: 2, portal_last_used_at: "2026-10-01",
      items: [{ documentId: "d1", number: "P", rev: "A", versionId: "v", fileHash: "h", fileSize: 1234, statusAsSent: "Issued", effectiveDate: "2026-11-01" }],
    });
    expect(r.acknowledgedMeta).toMatchObject({ ip: "1.2.3.4", note: "ok", userAgent: "UA" });
    expect(r.portalExpiresAt).toBe("2026-12-30");
    expect(r.portalOpenCount).toBe(3);
    expect(r.portalDownloadCount).toBe(2);
    expect(r.items[0]).toMatchObject({ fileHash: "h", fileSize: 1234, statusAsSent: "Issued", effectiveDate: "2026-11-01" });
    // a database without 20261133 has no usage trail — it reads as unknown, never as "not opened"
    const legacy = rowToTransmittal({ id: "t", org_id: "o", seq: 1, number: "TR-0001", status: "issued" });
    expect(legacy.portalOpenCount).toBeNull();
    expect(legacy.portalDownloadCount).toBeNull();
    expect(src("app/(protected)/transmittals/page.tsx")).toContain('t.portalToken && t.status !== "draft" && t.portalOpenCount != null && (');
  });
  it("the project evidence pack prints the hash prefix, the status as sent and the receipt's evidence", async () => {
    const { renderProjectEvidenceHtml } = await import("@/lib/evidencePack");
    const html = renderProjectEvidenceHtml({
      project: { name: "P" }, members: [], milestones: [], audit: [],
      transmittals: [{
        number: "TR-0007", status: "acknowledged", acknowledged_by_name: "Jane", acknowledged_at: "2026-10-01T09:00:00Z",
        acknowledged_via: "portal", acknowledged_meta: { ip: "203.0.113.9", note: "<b>ok</b>" },
        items: [{ number: "P-101", rev: "C", fileHash: "0123456789abcdef", fileSize: 2516582, statusAsSent: "Issued" }],
      }],
    });
    expect(html).toContain("P-101 RC (Issued) #0123456789ab 2.4 MB");
    expect(html).toContain("portal · from 203.0.113.9 · note: “&lt;b&gt;ok&lt;/b&gt;”");
  });
  it("the portal page discloses what the receipt records and renders the as-sent fields", () => {
    const portal = src("app/transmittal/[token]/page.tsx");
    expect(portal).toMatch(/the network address you confirm from are recorded/);
    expect(portal).toMatch(/i\.statusAsSent && <span/);
    expect(portal).toContain("`SHA-256 ${i.fileHash.slice(0, 12)}…`");
    expect(portal).toContain("{sizeLabel(i.fileSize) ?? \"\"}");
    // a file released without the UNCONTROLLED marking is said to be so —
    // since TRX-15 (document-control P8) the page saves a download without
    // reading it (no response headers), so the route flags the item (up
    // front for a non-PDF; from the record once a copy left unmarked) and
    // the page says so beside the item
    expect(portal).toContain("{unmarkedLine(i) && (");
    expect(portal).toContain("if (i.releasedUnmarked !== true) return null;");
    expect(portal).toMatch(/Not a PDF — released as issued, WITHOUT the UNCONTROLLED marking/);
    expect(portal).toMatch(/state === "revoked" \?/);
    expect(portal).toMatch(/state === "expired" \?/);
    expect(portal).not.toMatch(/window\.open\(body\.url/);
  });
});
