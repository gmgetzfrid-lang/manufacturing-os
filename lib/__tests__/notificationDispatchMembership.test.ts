// notifications Round G — N5 DISPATCH-AND-WRITE-HOLES, the dispatcher half.
//
// NEDGE-3: emit() resolved recipients from involved[], the follow stores
// (subscriptions, tickets.watchers), role pools and project membership, and
// only the role pool asked org_members for status = 'active'. A suspended,
// inactive (a restore's placeholder) or removed member who watched a ticket,
// subscribed to a document, sat on a project roster or was named in
// involved[] kept receiving both the bell row and the email — emailsFor()
// read the address without a status filter.
//
// NEDGE-6 (egress half): every emit() email's subject was input.title, so a
// hold's free-text reason ("HOLD placed on PID-4412-R3 — litigation hold …")
// became the subject line of mail sent to the follower list and the release
// pool.
//
// Driven through the REAL lib/notify/dispatch, lib/notify/recipients and
// lib/inAppNotifications over the in-memory PostgREST stand-in
// (helpers/memoryDb); queueEmail (N1's path, pinned by its own tests) is
// recorded so each test sees exactly which addresses an event mails, with
// which subject and body.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resetState, type MemoryState } from "./helpers/memoryDb";

const h = vi.hoisted(() => ({
  state: null as unknown as MemoryState,
  emails: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase", async () => {
  const mem = await import("./helpers/memoryDb");
  h.state = mem.freshState();
  return { supabase: mem.makeSupabase(h.state) };
});
vi.mock("@/lib/notifications", () => ({
  queueEmail: vi.fn(async (input: Record<string, unknown>) => { h.emails.push(input); }),
}));

import { emit, resolveRecipients, broadcastSubject, type EmitInput, type NotifCategory } from "@/lib/notify/dispatch";
import { resolveRoleRecipients } from "@/lib/notify/recipients";

const ORG = "o-1";
const OTHER_ORG = "o-2";
type Member = { uid: string; status: string; role?: string; roles?: string[]; org?: string };

const MEMBERS: Member[] = [
  { uid: "actor", status: "active", role: "Engineer" },
  { uid: "w-active", status: "active", role: "Engineer" },
  { uid: "w-suspended", status: "suspended", role: "Engineer" },
  { uid: "w-inactive", status: "inactive", role: "Engineer" },          // a restore's placeholder
  { uid: "admin", status: "active", role: "Admin" },
  { uid: "dc-additive", status: "active", role: "Manager", roles: ["Manager", "DocCtrl"] },
  { uid: "dc-suspended", status: "suspended", role: "DocCtrl" },
  { uid: "pm-active", status: "active", role: "Requester" },
  { uid: "pm-suspended", status: "suspended", role: "Requester" },
  { uid: "outsider", status: "active", role: "Admin", org: OTHER_ORG },   // a member of ANOTHER org only
  // "w-removed" has no org_members row at all (removed through revoke_member)
];

function seed(members: Member[] = MEMBERS) {
  resetState(h.state);
  h.emails.length = 0;
  h.state.tables.org_members = members.map((m) => ({
    org_id: m.org ?? ORG, uid: m.uid, status: m.status, role: m.role ?? null, roles: m.roles ?? null,
    email: `${m.uid}@example.com`,
  }));
  h.state.tables.subscriptions = [
    { org_id: ORG, user_id: "w-active", resource_type: "document", resource_id: "doc-1" },
    { org_id: ORG, user_id: "w-suspended", resource_type: "document", resource_id: "doc-1" },
    { org_id: ORG, user_id: "w-removed", resource_type: "document", resource_id: "doc-1" },
    { org_id: ORG, user_id: "w-inactive", resource_type: "document", resource_id: "doc-1" },
  ];
  h.state.tables.tickets = [
    { id: "t-1", org_id: ORG, watchers: ["w-active", "w-suspended", "w-removed", "w-inactive"] },
  ];
  h.state.tables.project_members = [
    { project_id: "p-1", user_id: "pm-active" },
    { project_id: "p-1", user_id: "pm-suspended" },
    { project_id: "p-1", user_id: "w-removed" },
  ];
  h.state.tables.notifications = [];
}

const bellRecipients = () => (h.state.tables.notifications ?? []).map((r) => r.user_id as string).sort();
const mailed = () => h.emails.map((e) => e.toUserId as string).sort();

function ev(over: Partial<EmitInput> = {}): EmitInput {
  return {
    orgId: ORG,
    category: "status",
    kind: "hold_opened",
    title: "HOLD placed on PID-4412-R3 — litigation hold, Baytown incident, do not distribute",
    body: "Dana placed a \"litigation hold\" hold. Work from this document should stop until it's released.",
    link: "/documents/lib-1?doc=doc-1",
    resource: { type: "document", id: "doc-1" },
    actorUserId: "actor",
    actorName: "Dana",
    audience: { involved: [] },
    ...over,
  };
}

beforeEach(() => seed());

describe("NEDGE-3 — a suspended, inactive or removed member gets neither the bell row nor the email", () => {
  it("document followers: the active subscriber gets both; suspended, inactive and removed subscribers get neither", async () => {
    await emit(ev({ audience: { followers: true } }));
    expect(bellRecipients()).toEqual(["w-active"]);
    expect(mailed()).toEqual(["w-active"]);
  });

  it("ticket watchers (tickets.watchers ∪ subscriptions): the same, through the watchers array", async () => {
    await emit(ev({
      kind: "ticket_status", category: "watched", title: "REQ-12 advanced", body: "Moved to drafting.",
      link: "/requests/t-1", resource: { type: "ticket", id: "t-1" }, audience: { followers: true },
    }));
    expect(bellRecipients()).toEqual(["w-active"]);
    expect(mailed()).toEqual(["w-active"]);
  });

  it("involved[] is membership-checked too — once, centrally (a suspended stakeholder and another org's member are dropped)", async () => {
    await emit(ev({ audience: { involved: ["w-active", "w-suspended", "w-removed", "outsider", "w-inactive"] } }));
    expect(bellRecipients()).toEqual(["w-active"]);
    expect(mailed()).toEqual(["w-active"]);
  });

  it("project members: the suspended and the removed are dropped", async () => {
    await emit(ev({ kind: "project_status", resource: { type: "project", id: "p-1" }, audience: { projectId: "p-1" } }));
    expect(bellRecipients()).toEqual(["pm-active"]);
    expect(mailed()).toEqual(["pm-active"]);
  });

  it("role pools (DEC-43: Admin / DocCtrl stay unscoped): every ACTIVE controller — an additive DocCtrl included — is reached; a suspended one is not", async () => {
    await emit(ev({ kind: "branch_open", audience: { roles: ["Admin", "DocCtrl"] } }));
    expect(bellRecipients()).toEqual(["admin", "dc-additive"]);
    expect(mailed()).toEqual(["admin", "dc-additive"]);
    // resolveRoleRecipients itself is unchanged (it was already right — the NEDGE-3 correction)
    expect((await resolveRoleRecipients(ORG, ["DocCtrl"])).sort()).toEqual(["dc-additive"]);
  });

  it("the actor is never a recipient, even when named and active", async () => {
    await emit(ev({ audience: { involved: ["actor", "w-active"], followers: true } }));
    expect(bellRecipients()).toEqual(["w-active"]);
  });

  it("resolveRecipients (the preview) answers the same filtered set the send uses", async () => {
    const out = await resolveRecipients(ev({ audience: { involved: ["w-suspended", "admin"], followers: true, roles: ["DocCtrl"], projectId: "p-1" } }));
    expect(out.sort()).toEqual(["admin", "dc-additive", "pm-active", "w-active"]);
  });

  it("a membership read that FAILS keeps today's delivery (fail-open, logged) — a transient error never drops a compliance notice; the database rail is the backstop", async () => {
    h.state.readError.org_members = { message: "statement timeout", code: "57014" };
    // the filter's read fails; the email lookup (a later read) succeeds again
    let reads = 0;
    h.state.onRead = (t) => { if (t === "org_members" && ++reads === 1) delete h.state.readError.org_members; };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await emit(ev({ audience: { involved: ["w-active", "w-suspended"] } }));
    expect(warn.mock.calls.some((c) => String(c[0]).includes("active-membership read failed"))).toBe(true);
    warn.mockRestore();
    expect(bellRecipients()).toEqual(["w-active", "w-suspended"]);
    // …and emailsFor's own status filter (NEDGE-3 done-when 2) still keeps the suspended member's inbox out
    expect(mailed()).toEqual(["w-active"]);
  });

  it("source pins: emailsFor filters status = 'active'; resolveFollowers carries the same membership filter (defence in depth)", () => {
    const d = readFileSync(join(process.cwd(), "lib/notify/dispatch.ts"), "utf8");
    const emailsFor = d.slice(d.indexOf("async function emailsFor"));
    expect(emailsFor).toMatch(/\.from\("org_members"\)\s*\n\s*\.select\("uid, email"\)\s*\n\s*\.eq\("org_id", orgId\)\s*\n\s*\.eq\("status", "active"\)/);
    const r = readFileSync(join(process.cwd(), "lib/notify/recipients.ts"), "utf8");
    const followers = r.slice(r.indexOf("export async function resolveFollowers"), r.indexOf("export async function resolveRoleRecipients"));
    expect(followers).toMatch(/return activeMembersOf\(orgId, Array\.from\(ids\)\);/);
  });
});

describe("REGRESSION — with every member active, the same inputs reach the same people on both channels", () => {
  // The resolver as it stood on f1ac550 (dispatch.ts:77-89 + recipients.ts),
  // reimplemented over the same tables: the union of every source, minus the
  // actor. With nobody suspended or removed the new filter must change nothing.
  async function todaysRecipients(input: EmitInput): Promise<string[]> {
    const t = h.state.tables;
    const ids = new Set<string>((input.audience.involved ?? []).filter(Boolean));
    if (input.audience.followers) {
      for (const s of t.subscriptions ?? []) if (s.resource_type === input.resource.type && s.resource_id === input.resource.id) ids.add(s.user_id as string);
      if (input.resource.type === "ticket") for (const u of ((t.tickets ?? []).find((x) => x.id === input.resource.id)?.watchers as string[] | undefined) ?? []) ids.add(u);
    }
    if (input.audience.roles?.length) {
      for (const m of t.org_members ?? []) {
        if (m.org_id !== input.orgId || m.status !== "active") continue;
        const held = (m.roles as string[] | null)?.length ? (m.roles as string[]) : m.role ? [m.role as string] : [];
        if (held.some((r) => input.audience.roles!.includes(r))) ids.add(m.uid as string);
      }
    }
    if (input.audience.projectId) for (const p of t.project_members ?? []) if (p.project_id === input.audience.projectId) ids.add(p.user_id as string);
    if (input.actorUserId) ids.delete(input.actorUserId);
    return [...ids].sort();
  }

  const allActive = () => seed([
    ...MEMBERS.filter((m) => m.org !== OTHER_ORG).map((m) => ({ ...m, status: "active" })),
    { uid: "w-removed", status: "active", role: "Engineer" },
  ]);

  const audiences: EmitInput["audience"][] = [
    { involved: ["w-active", "w-suspended"] },
    { followers: true },
    { roles: ["Admin", "DocCtrl"] },
    { projectId: "p-1" },
    { involved: ["admin", "pm-active", "actor"], followers: true, roles: ["DocCtrl"], projectId: "p-1" },
  ];

  for (const [i, audience] of audiences.entries()) {
    it(`audience #${i + 1}: bell rows and queued emails go to exactly today's recipients`, async () => {
      allActive();
      const input = ev({ audience });
      const want = await todaysRecipients(input);
      expect(want.length).toBeGreaterThan(0);
      expect((await resolveRecipients(input)).sort()).toEqual(want);
      await emit(input);
      expect(bellRecipients()).toEqual(want);
      expect(mailed()).toEqual(want);
      // the bell row itself is unchanged: title, body, link, kind, actor, resource
      for (const r of h.state.tables.notifications) {
        expect(r).toMatchObject({
          org_id: ORG, kind: "hold_opened", title: input.title, body: input.body, link: input.link,
          resource_type: "document", resource_id: "doc-1", actor_user_id: "actor", actor_name: "Dana",
        });
      }
    });
  }

  it("an involved-only event keeps today's email exactly: subject = title, body = body, event type and resource unchanged", async () => {
    allActive();
    await emit(ev({ category: "recall", kind: "doc_superseded", audience: { involved: ["w-active"] } }));
    expect(h.emails).toEqual([expect.objectContaining({
      orgId: ORG, toUserId: "w-active", toEmail: "w-active@example.com",
      subject: ev().title, bodyText: ev().body, resourceType: "document", resourceId: "doc-1", eventType: "safety_recall",
    })]);
  });

  it("channels: an in-app-only event writes bell rows and queues no email; an email-only event the reverse", async () => {
    allActive();
    await emit(ev({ audience: { involved: ["w-active"] }, channels: ["inapp"] }));
    expect(bellRecipients()).toEqual(["w-active"]);
    expect(h.emails).toEqual([]);
    seed();
    await emit(ev({ audience: { involved: ["w-active"] }, channels: ["email"] }));
    expect(bellRecipients()).toEqual([]);
    expect(mailed()).toEqual(["w-active"]);
  });
});

describe("NEDGE-6 (egress) — a broadcast email's subject is derived from its category, never from the title", () => {
  it("a hold to the follower list: the subject carries no document label and no free-text reason; the title leads the body", async () => {
    await emit(ev({ audience: { followers: true } }));
    expect(h.emails).toHaveLength(1);
    const [m] = h.emails;
    expect(m.subject).toBe(broadcastSubject("status", "document"));
    expect(String(m.subject)).not.toMatch(/PID-4412|litigation|Baytown/);
    expect(m.bodyText).toBe(`${ev().title}\n\n${ev().body}`);
    // the bell row is unchanged (DEC-43: in-app disclosure to the audience is policy)
    expect(h.state.tables.notifications[0].title).toBe(ev().title);
  });

  it("a role broadcast (Admin / DocCtrl) is a broadcast too", async () => {
    await emit(ev({ kind: "branch_open", title: "Unreconciled branch opened on PID-3301", body: undefined, audience: { roles: ["Admin", "DocCtrl"] } }));
    expect(h.emails.map((m) => m.subject)).toEqual([broadcastSubject("status", "document"), broadcastSubject("status", "document")]);
    // no body: the title alone is the body, as before
    expect(h.emails.every((m) => m.bodyText === "Unreconciled branch opened on PID-3301")).toBe(true);
  });

  it("an explicit email subject and body are the producer's choice and are sent as given", async () => {
    await emit(ev({ audience: { followers: true }, email: { subject: "A hold was placed", bodyText: "Open the document." } }));
    expect(h.emails[0]).toMatchObject({ subject: "A hold was placed", bodyText: "Open the document." });
  });

  it("every category has a fixed subject that names the resource kind and nothing else", () => {
    const cats: NotifCategory[] = ["mention", "assignment", "status", "watched", "sla", "system", "recall", "safety"];
    const types = ["ticket", "document", "project", "asset", "library"] as const;
    const seen = new Set<string>();
    for (const c of cats) for (const t of types) {
      const s = broadcastSubject(c, t);
      expect(s.length).toBeGreaterThan(8);
      expect(s).not.toMatch(/\$\{|undefined|null/);
      seen.add(s);
    }
    expect(seen.size).toBe(cats.length * types.length);
  });
});
