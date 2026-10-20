// @vitest-environment jsdom
//
// admin-and-org Round G — P5, BILL-10 / ORG-9 (enforcement half) / BILL-14
// (trial expiry): subscription enforcement is ONE server switch,
// SUBSCRIPTION_ENFORCE (DEC-18), and both of its states are pinned here.
//
//   OFF (unset — the default, and how every deployment runs until its
//   operator decides otherwise): every flow is exactly as before — uploads
//   sign, multipart opens, the curtain never shows; a lapsed workspace's
//   would-be refusal is only logged.
//   ON: a lapsed workspace — canceled, unpaid, paused, or a free trial whose
//   end has passed (past_due keeps its grace) — is refused by the SERVER on
//   the routes that mint a seat or new stored bytes (402, the reason in one
//   sentence); every page still RENDERS (reading, downloading and exporting
//   are never gated — DEC-90 ruling (2)), with a strip above it saying what
//   is paused in the server's own sentence. The strip shows the export link
//   only to the people who can export, and the billing link only to the
//   people who can pay. (Other row writes are not refused while lapsed:
//   BILL-10's Partial.)
// A database fault never locks anyone out (fail-open), in either state.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const s = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://sb.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "service";
  return {
    user: { id: "u1", email: "u1@example.com" } as { id: string; email?: string } | null,
    tables: {} as Record<string, { data?: unknown; error?: unknown; throws?: boolean }>,
    reads: [] as string[],
    signed: 0,
    r2Sent: [] as string[],
    // the browser side
    session: { access_token: "tok" } as { access_token: string } | null,
    verdict: { enforced: false, access: true, reason: null } as Record<string, unknown> | null,
    verdictStatus: 200,
    fetches: [] as string[],
    roles: ["Viewer"] as string[],
    pathname: "/documents",
    info: null as Record<string, unknown> | null,
  };
});

function chain(table: string) {
  const result = () => s.tables[table] ?? { data: null, error: null };
  const c: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        const r = result();
        return (resolve: (v: unknown) => void) => resolve({ data: r.data ?? null, error: r.error ?? null });
      }
      return (..._args: unknown[]) => {
        if (prop === "maybeSingle" || prop === "single") {
          const r = result();
          if (r.throws) return Promise.reject(new Error("fetch failed"));
          const d = Array.isArray(r.data) ? (r.data[0] ?? null) : (r.data ?? null);
          return Promise.resolve({ data: d, error: r.error ?? null });
        }
        return new Proxy(c, handler);
      };
    },
  };
  return new Proxy(c, handler);
}
const from = (t: string) => { s.reads.push(t); return chain(t); };

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: {
      getUser: vi.fn(async () =>
        s.user ? { data: { user: s.user }, error: null } : { data: { user: null }, error: { message: "bad" } }),
    },
    from: (t: string) => from(t),
  },
}));
// authorizeOrgRole (the access route) builds its own clients.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => (s.user ? { data: { user: s.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (t: string) => from(t),
  }),
}));
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async (cmd: { kind?: string }) => { s.r2Sent.push(cmd.kind ?? "?"); return { UploadId: "up-1" }; }) }, R2_BUCKET: "test-bucket" }));
vi.mock("@aws-sdk/client-s3", () => ({
  PutObjectCommand: class { kind = "put"; },
  CreateMultipartUploadCommand: class { kind = "create"; },
  UploadPartCommand: class { kind = "part"; },
  CompleteMultipartUploadCommand: class { kind = "complete"; },
  AbortMultipartUploadCommand: class { kind = "abort"; },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async () => { s.signed += 1; return "https://signed.example/put"; }),
}));
// The browser side of the curtain.
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: s.session } }) } },
  setPreferMicrosoft: () => undefined,
}));
vi.mock("@/lib/swSession", () => ({ signOutOfThisBrowser: async () => undefined }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({ usePathname: () => s.pathname }));
vi.mock("@/components/providers/SubscriptionProvider", () => ({ useSubscription: () => ({ info: s.info, loading: false, refresh: async () => {} }) }));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeOrgId: "org-1", hasAnyRole: (rs: string[]) => rs.some((r) => s.roles.includes(r)) }),
}));

import {
  subscriptionEnforced, lapsedWorkspaceMessage, assertOrgHasAccess, enforceOrgAccess, orgAccessVerdict,
} from "@/lib/serverAuth";
import { POST as uploadUrl } from "@/app/api/storage/upload-url/route";
import { POST as multipart } from "@/app/api/storage/multipart/route";
import { GET as accessGET } from "@/app/api/subscription/access/route";
import SubscriptionGate, { lapsedNoticeFor, LAPSED_FALLBACK } from "@/components/subscription/SubscriptionGate";
import TrialBanner from "@/components/subscription/TrialBanner";
import { adminSurface } from "@/lib/adminSurfaces";

const ORG = "12345678-1234-1234-1234-123456789abc";
const DAY = 86_400_000;
const LAPSED_ROWS: Array<[string, Record<string, unknown>]> = [
  ["an ended trial", { subscription_status: "trialing", trial_ends_at: new Date(Date.now() - DAY).toISOString() }],
  ["canceled", { subscription_status: "canceled", trial_ends_at: null }],
  ["unpaid", { subscription_status: "unpaid", trial_ends_at: null }],
  ["paused", { subscription_status: "paused", trial_ends_at: null }],
];
const GOOD_ROWS: Array<[string, Record<string, unknown>]> = [
  ["active", { subscription_status: "active", trial_ends_at: null }],
  ["past_due (grace)", { subscription_status: "past_due", trial_ends_at: null }],
  ["a trial in its window", { subscription_status: "trialing", trial_ends_at: new Date(Date.now() + 10 * DAY).toISOString() }],
];

const prevEnforce = process.env.SUBSCRIPTION_ENFORCE;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  delete process.env.SUBSCRIPTION_ENFORCE;
  s.user = { id: "u1", email: "u1@example.com" };
  s.tables = { org_members: { data: { uid: "u1", role: "Viewer", roles: ["Viewer"], status: "active" } } };
  s.reads = [];
  s.signed = 0;
  s.r2Sent = [];
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  if (prevEnforce === undefined) delete process.env.SUBSCRIPTION_ENFORCE; else process.env.SUBSCRIPTION_ENFORCE = prevEnforce;
});

const on = () => { process.env.SUBSCRIPTION_ENFORCE = "true"; };
const upload = (path = `orgs/${ORG}/documents/lib/${Date.now()}-new.pdf`) =>
  uploadUrl(new NextRequest("https://app/api/storage/upload-url", {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ path }),
  }));
const mp = (action: string, extra: Record<string, unknown> = {}) =>
  multipart(new NextRequest("https://app/api/storage/multipart", {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ action, path: `orgs/${ORG}/documents/lib/scan.e57`, ...extra }),
  }));

describe("the switch — ONE server variable, off unless exactly \"true\"", () => {
  it("unset, empty, \"1\", \"TRUE\" and \"false\" are off; only \"true\" is on", () => {
    for (const v of [undefined, "", "1", "TRUE", "false", "yes"]) {
      if (v === undefined) delete process.env.SUBSCRIPTION_ENFORCE; else process.env.SUBSCRIPTION_ENFORCE = v;
      expect(subscriptionEnforced(), String(v)).toBe(false);
    }
    on();
    expect(subscriptionEnforced()).toBe(true);
  });

  it("the old dead constant is gone: no `const ENFORCE = false` and no 'never a merely-expired trial' claim in the gate", () => {
    const gate = readFileSync(join(process.cwd(), "components/subscription/SubscriptionGate.tsx"), "utf8");
    expect(gate).not.toMatch(/const ENFORCE\b/);
    expect(gate).not.toMatch(/never a merely-expired trial/);
    expect(gate).toMatch(/\/api\/subscription\/access/);
    // review fix: the gate no longer replaces the page, so it no longer
    // carries an escape-hatch list or a sign-out of its own (the Sidebar and
    // /profile sign out, through the one helper — sw.test.ts)
    expect(gate).not.toMatch(/ALLOWED_WHEN_LAPSED|usePathname|signOutOfThisBrowser/);
  });
});

describe("assertOrgHasAccess — who is lapsed, the sentence, and fail-open", () => {
  const sb = { from } as never;
  for (const [label, row] of LAPSED_ROWS) {
    it(`${label}: 402 with a sentence that names why and says the data is safe and exportable`, async () => {
      s.tables.orgs = { data: row };
      const r = await assertOrgHasAccess(sb, ORG);
      expect(r?.status).toBe(402);
      expect(r?.error).toMatch(/adding members and uploading new files are paused/);
      expect(r?.error).toMatch(/Nothing has been deleted, and an Admin can still export the whole workspace/);
    });
  }
  it("the sentence names the reason per status (BILL-14: an ended trial is lapsed, said as such)", () => {
    expect(lapsedWorkspaceMessage({ status: "trialing" })).toMatch(/^This workspace's free trial has ended,/);
    expect(lapsedWorkspaceMessage({ status: "canceled" })).toMatch(/^This workspace's subscription was canceled,/);
    expect(lapsedWorkspaceMessage({ status: "unpaid" })).toMatch(/^This workspace has an unpaid invoice,/);
    expect(lapsedWorkspaceMessage({ status: "paused" })).toMatch(/^This workspace's subscription is paused,/);
  });
  for (const [label, row] of GOOD_ROWS) {
    it(`${label}: access`, async () => {
      s.tables.orgs = { data: row };
      expect(await assertOrgHasAccess(sb, ORG)).toBeNull();
    });
  }
  it("fail-open: a read error, no row, or a thrown read never refuses", async () => {
    s.tables.orgs = { data: null, error: { message: "timeout" } };
    expect(await assertOrgHasAccess(sb, ORG)).toBeNull();
    s.tables.orgs = { data: null };
    expect(await assertOrgHasAccess(sb, ORG)).toBeNull();
    s.tables.orgs = { throws: true };
    expect(await assertOrgHasAccess(sb, ORG)).toBeNull();
  });
  it("enforceOrgAccess: off — never refuses, logs the would-be refusal; on — the 402", async () => {
    s.tables.orgs = { data: LAPSED_ROWS[1][1] };
    expect(await enforceOrgAccess(sb, ORG, "test-route")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[test-route\] subscription gate would refuse org .* \(SUBSCRIPTION_ENFORCE off\): This workspace's subscription was canceled/));
    on();
    expect((await enforceOrgAccess(sb, ORG, "test-route"))?.status).toBe(402);
  });
  it("orgAccessVerdict: off reads nothing; on reads the workspace", async () => {
    s.tables.orgs = { data: LAPSED_ROWS[0][1] };
    expect(await orgAccessVerdict(sb, ORG)).toEqual({ enforced: false, access: true, reason: null });
    expect(s.reads).not.toContain("orgs");
    on();
    const v = await orgAccessVerdict(sb, ORG);
    expect(v).toMatchObject({ enforced: true, access: false });
    expect(v.reason).toMatch(/free trial has ended/);
  });
});

describe("OFF (the default) — every flow exactly as before", () => {
  for (const [label, row] of LAPSED_ROWS) {
    it(`a ${label} workspace: upload-url signs; multipart opens, signs, completes, aborts`, async () => {
      s.tables.orgs = { data: row };
      const res = await upload();
      expect(res.status).toBe(200);
      expect(s.signed).toBe(1);
      expect((await mp("create", { contentType: "application/octet-stream" })).status).toBe(200);
      expect((await mp("sign", { uploadId: "up-1", partNumber: 1 })).status).toBe(200);
      expect((await mp("complete", { uploadId: "up-1", parts: [{ partNumber: 1, etag: "e" }] })).status).toBe(200);
      expect((await mp("abort", { uploadId: "up-1" })).status).toBe(200);
      expect(s.r2Sent).toEqual(["create", "complete", "abort"]);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[storage\/upload-url\] subscription gate would refuse/));
    });
  }
  it("the access route answers 'not enforced' without reading the workspace", async () => {
    s.tables.orgs = { data: LAPSED_ROWS[1][1] };
    const res = await accessGET(new NextRequest(`https://app/api/subscription/access?orgId=${ORG}`, { headers: { authorization: "Bearer t" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enforced: false, access: true, reason: null });
    expect(s.reads).not.toContain("orgs");
  });
});

describe("ON — a lapsed workspace is refused by the server, with a clear sentence, and can still get its data out", () => {
  for (const [label, row] of LAPSED_ROWS) {
    it(`a ${label} workspace: upload-url 402 (nothing signed); multipart create 402 (nothing opened); an open upload may still sign, complete and abort`, async () => {
      on();
      s.tables.orgs = { data: row };
      const res = await upload();
      expect(res.status).toBe(402);
      expect((await res.json()).error).toMatch(/uploading new files are paused until billing is renewed/);
      expect(s.signed).toBe(0);
      const c = await mp("create", { contentType: "application/octet-stream" });
      expect(c.status).toBe(402);
      expect(s.r2Sent).toEqual([]);
      expect((await mp("sign", { uploadId: "up-0", partNumber: 1 })).status).toBe(200);
      expect((await mp("complete", { uploadId: "up-0", parts: [{ partNumber: 1, etag: "e" }] })).status).toBe(200);
      expect((await mp("abort", { uploadId: "up-0" })).status).toBe(200);
    });
  }
  for (const [label, row] of GOOD_ROWS) {
    it(`a workspace in good standing (${label}) uploads as before`, async () => {
      on();
      s.tables.orgs = { data: row };
      expect((await upload()).status).toBe(200);
      expect((await mp("create", { contentType: "application/octet-stream" })).status).toBe(200);
    });
  }
  it("fail-open: a workspace row that cannot be read never refuses an upload", async () => {
    on();
    s.tables.orgs = { data: null, error: { message: "timeout" } };
    expect((await upload()).status).toBe(200);
  });
  it("the access route tells the curtain: lapsed (with the sentence) or in good standing; a non-member is refused", async () => {
    on();
    const ask = () => accessGET(new NextRequest(`https://app/api/subscription/access?orgId=${ORG}`, { headers: { authorization: "Bearer t" } }));
    s.tables.orgs = { data: LAPSED_ROWS[2][1] };
    const lapsed = await (await ask()).json();
    expect(lapsed).toMatchObject({ enforced: true, access: false });
    expect(lapsed.reason).toMatch(/unpaid invoice/);
    s.tables.orgs = { data: GOOD_ROWS[0][1] };
    expect(await (await ask()).json()).toEqual({ enforced: true, access: true, reason: null });
    s.tables.org_members = { data: null };
    expect((await ask()).status).toBe(403);
  });

  // The escape hatches on the server: nothing that gets data OUT, and nothing
  // that lets a workspace pay, passes the subscription gate.
  it("no data-export route, no download, no Stripe route and no storage-page backup route calls the gate", () => {
    const root = process.cwd();
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });
    const files = [
      ...walk(join(root, "app/api/data-export")),
      ...walk(join(root, "app/api/stripe")),
      join(root, "app/api/storage/download-url/route.ts"),
      join(root, "app/api/storage/resolve/route.ts"),
      join(root, "app/api/admin/storage-stats/route.ts"),
    ];
    expect(files.length).toBeGreaterThan(8);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/enforceOrgAccess|assertOrgHasAccess|orgAccessVerdict/);
    }
    // and the two routes that mint new stored bytes do call it
    for (const f of ["app/api/storage/upload-url/route.ts", "app/api/storage/multipart/route.ts"]) {
      expect(readFileSync(join(root, f), "utf8"), f).toMatch(/await enforceOrgAccess\(supabaseAdmin, orgMatch\[1\], "storage\/(upload-url|multipart)"\)/);
    }
    // review fix: so does the seat route, through the same one switch — no
    // second spelling of SUBSCRIPTION_ENFORCE on any seat / file route
    const cu = readFileSync(join(root, "app/api/admin/create-user/route.ts"), "utf8");
    expect(cu).toMatch(/const gate = await enforceOrgAccess\(supabaseAdmin, orgId, "create-user"\);/);
    for (const f of ["app/api/admin/create-user/route.ts", "app/api/storage/upload-url/route.ts", "app/api/storage/multipart/route.ts"]) {
      expect(readFileSync(join(root, f), "utf8"), f).not.toMatch(/assertOrgHasAccess|process\.env\.SUBSCRIPTION_ENFORCE/);
    }
  });
});

describe("the lapsed-workspace strip — when it shows, what it offers whom, and that the page always renders", () => {
  it("lapsedNoticeFor: never without a server answer, never with the switch off, never for a workspace with access", () => {
    expect(lapsedNoticeFor(null)).toBe(false);
    expect(lapsedNoticeFor({ enforced: false, access: false, reason: "x" })).toBe(false);
    expect(lapsedNoticeFor({ enforced: true, access: true, reason: null })).toBe(false);
    expect(lapsedNoticeFor({ enforced: true, access: false, reason: "x" })).toBe(true);
  });
  it("the fallback sentence names what the server pauses — and never claims more", () => {
    expect(LAPSED_FALLBACK).toMatch(/adding members and uploading new files are paused/);
    expect(LAPSED_FALLBACK).toMatch(/documents can still be opened, downloaded and exported/);
    expect(LAPSED_FALLBACK).not.toMatch(/read-only|Subscription required/i);
  });

  let container: HTMLDivElement;
  let root: Root;
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    s.session = { access_token: "tok" };
    s.verdictStatus = 200;
    s.fetches = [];
    s.pathname = "/documents";
    globalThis.fetch = vi.fn(async (url: string) => {
      s.fetches.push(String(url));
      return new Response(JSON.stringify(s.verdict), { status: s.verdictStatus, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
  });
  const render = async () => {
    await act(async () => { root.render(React.createElement(SubscriptionGate, null, React.createElement("p", { id: "page" }, "the page"))); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };

  const strip = () => container.querySelector("[data-subscription-lapsed]");

  it("OFF: the page renders, exactly as before (the server is asked once, with the session); no strip", async () => {
    s.verdict = { enforced: false, access: true, reason: null };
    await render();
    expect(container.querySelector("#page")?.textContent).toBe("the page");
    expect(strip()).toBeNull();
    expect(container.textContent).toBe("the page");
    expect(s.fetches).toEqual([`/api/subscription/access?orgId=org-1`]);
  });
  it("ON, in good standing: the page, no strip", async () => {
    s.verdict = { enforced: true, access: true, reason: null };
    await render();
    expect(container.textContent).toBe("the page");
  });
  it("fail-open: a failed answer, or no session, renders the page with no strip", async () => {
    s.verdict = { error: "boom" };
    s.verdictStatus = 500;
    await render();
    expect(container.querySelector("#page")).not.toBeNull();
    expect(strip()).toBeNull();
    s.session = null;
    await render();
    expect(container.querySelector("#page")).not.toBeNull();
    expect(strip()).toBeNull();
  });
  it("REVIEW FIX (DEC-90 ruling 2): ON and lapsed, a controlled document page STILL RENDERS — opened, read and downloaded — on every path, with the strip above it", async () => {
    // the server's own sentence, as the access route returns it
    s.verdict = { enforced: true, access: false, reason: lapsedWorkspaceMessage({ status: "canceled" }) };
    s.roles = ["Viewer"];
    const docPage = React.createElement("article", { id: "doc" },
      React.createElement("h1", null, "SOP-114 Lockout / Tagout, Rev C"),
      React.createElement("a", { href: "/api/storage/download-url?key=sop-114.pdf", id: "download" }, "Download"));
    for (const path of ["/documents/lib-1/doc-1", "/", "/admin/users", "/admin/storage", "/admin/billing", "/profile"]) {
      s.pathname = path;
      await act(async () => { root.render(React.createElement(SubscriptionGate, null, docPage)); });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(container.querySelector("#doc h1")?.textContent, path).toBe("SOP-114 Lockout / Tagout, Rev C");
      expect(container.querySelector("#download"), path).not.toBeNull();
      expect(strip(), path).not.toBeNull();
      // the strip comes first, the page after it — never instead of it
      expect(container.firstElementChild?.hasAttribute("data-subscription-lapsed"), path).toBe(true);
    }
    expect(container.textContent).not.toMatch(/Subscription required/);
  });
  it("ON, lapsed, a Viewer: the strip says what the server pauses, in its own sentence; no billing link and no export link (they can use neither)", async () => {
    s.verdict = { enforced: true, access: false, reason: lapsedWorkspaceMessage({ status: "trialing" }) };
    s.roles = ["Viewer"];
    await render();
    expect(container.querySelector("#page")).not.toBeNull();
    const text = strip()?.textContent ?? "";
    expect(text).toMatch(/^Subscription inactive\. This workspace's free trial has ended, so adding members and uploading new files are paused until billing is renewed/);
    expect(text).toMatch(/an Admin or Manager can do that under Admin → Billing/);
    expect(text).not.toMatch(/read-only/i);
    expect(container.querySelector('a[href="/admin/billing"]')).toBeNull();
    expect(container.querySelector('a[href="/admin/data-export"]')).toBeNull();
  });
  it("ON, lapsed, no sentence from the server: the fallback names the same paused limbs", async () => {
    s.verdict = { enforced: true, access: false, reason: null };
    await render();
    expect(strip()?.textContent).toContain(LAPSED_FALLBACK);
    expect(container.querySelector("#page")).not.toBeNull();
  });
  it("ON, lapsed: an Admin is offered both; a Manager billing only; a DocCtrl neither — by the registry's sets", async () => {
    s.verdict = { enforced: true, access: false, reason: "lapsed" };
    expect(adminSurface("billing")!.writes).toEqual(["Admin", "Manager"]);
    expect(adminSurface("data-export")!.entry).toEqual(["Admin"]);
    for (const [roles, billing, exp] of [
      [["Admin"], true, true],
      [["Viewer", "Admin"], true, true],                 // the additive collection counts
      [["Manager"], true, false],
      [["DocCtrl"], false, false],
    ] as Array<[string[], boolean, boolean]>) {
      s.roles = roles;
      await render();
      expect(!!container.querySelector('a[href="/admin/billing"]'), `${roles} billing`).toBe(billing);
      expect(!!container.querySelector('a[href="/admin/data-export"]'), `${roles} export`).toBe(exp);
      expect(container.querySelector("#page"), `${roles} page`).not.toBeNull();
    }
  });

  // BILL-14: with enforcement off, an ended trial's only consequence is a
  // notice to the people who can renew; the countdown before it is unchanged.
  const banner = async () => {
    await act(async () => { root.render(React.createElement(TrialBanner)); });
    return container.textContent ?? "";
  };
  it("TrialBanner: an ENDED trial is shown to the billing writers (Admin, Manager) only — no one else is nagged", async () => {
    s.info = { status: "trialing", trialEndsAt: new Date(Date.now() - DAY).toISOString() };
    for (const [roles, shown] of [[["Admin"], true], [["Manager"], true], [["Viewer", "Admin"], true], [["DocCtrl"], false], [["Viewer"], false]] as Array<[string[], boolean]>) {
      s.roles = roles;
      expect((await banner()).includes("Your free trial has ended"), `${roles}`).toBe(shown);
    }
  });
  it("TrialBanner REGRESSION: the countdown during the trial is shown to every member, as before; a paying workspace sees none", async () => {
    s.info = { status: "trialing", trialEndsAt: new Date(Date.now() + 10 * DAY).toISOString() };
    for (const roles of [["Viewer"], ["DocCtrl"], ["Admin"]]) {
      s.roles = roles;
      expect(await banner(), `${roles}`).toMatch(/days? left in your free trial/);
    }
    s.info = { status: "active" };
    expect(await banner()).toBe("");
  });
});
