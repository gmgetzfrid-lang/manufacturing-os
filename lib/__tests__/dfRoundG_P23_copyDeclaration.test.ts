// drafting-flow Round G, DF-P23 fix pass — GAP-101 acceptance 3, the
// deliverable limb, as the review found it:
//
//   * (major) the requester's statement is printed inside the footer's
//     sentence; on a copy with no QR the stamper cuts the footer at the first
//     scan instruction (lib/stamping.ts withoutScanInstruction), so a
//     statement saying "scan the code" took "not a controlled document
//     revision" (and "do not work from it") off the paper. The statement's
//     scan instruction is now bracketed and its spaced dashes are hyphens:
//     every safety clause survives the cut, on every standing.
//   * (minor) a failed combined read printed "declaration not available" on
//     requests that never had one: the declaration is now read once on its
//     own first, and "not available" printed only if that fails too.
//   * (minor) the stamp attributed a declaration the workflow itself rejects
//     (an empty statement; an e-signature known not to stand): a declaration
//     is a time AND a statement, and its signature is checked as the
//     workflow route checks it — not standing → "not relied on"; unreadable
//     → printed with "e-signature not checked". One rule for the route and
//     the request page (copyDeclarationFacts).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { PDFDocument } from "pdf-lib";

type Err = { code?: string; message?: string };
const st = vi.hoisted(() => ({
  ticket: null as Record<string, unknown> | null,
  member: null as Record<string, unknown> | null,
  /** tickets reads: the select string of each, in order. */
  ticketSelects: [] as string[],
  /** tickets reads: an error per read, in order (null = answered). */
  ticketSelectErrors: [] as Array<Err | null>,
  signature: null as Record<string, unknown> | null,
  signatureError: null as Err | null,
  signatureReads: 0,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  objects: {} as Record<string, Uint8Array>,
  footers: [] as Array<string | undefined>,
  user: { id: "u-drafter", email: "drafter@plant.test" } as { id: string; email: string } | null,
}));

function chain(table: string) {
  let head = false;
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, p: string) {
      if (p === "then") {
        const out = head ? { data: null, error: null, count: 0 } : { data: table === "ticket_comments" ? [] : null, error: null };
        return (resolve: (v: unknown) => void) => resolve(out);
      }
      return (...args: unknown[]) => {
        if (p === "select") {
          if ((args[1] as { head?: boolean } | undefined)?.head) head = true;
          else if (table === "tickets") st.ticketSelects.push(String(args[0]));
        }
        if (p === "insert") {
          st.inserts.push({ table, row: args[0] as Record<string, unknown> });
          return Promise.resolve({ error: null });
        }
        if (p === "maybeSingle") {
          if (table === "tickets") {
            const err = st.ticketSelectErrors.length ? st.ticketSelectErrors.shift() : null;
            return Promise.resolve(err ? { data: null, error: err } : { data: st.ticket ? { ...st.ticket } : null, error: null });
          }
          if (table === "org_members") return Promise.resolve({ data: st.member, error: null });
          if (table === "e_signatures") {
            st.signatureReads++;
            return Promise.resolve(st.signatureError ? { data: null, error: st.signatureError } : { data: st.signature, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: async () => (st.user ? { data: { user: st.user }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
    from: (t: string) => chain(t),
  },
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chain(t) }) }));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "bucket",
  r2: {
    send: async (cmd: { input: { Key: string } }) => {
      const b = st.objects[cmd.input.Key];
      if (!b) throw { name: "NoSuchKey" };
      return { Body: { transformToByteArray: async () => b } };
    },
  },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => {}) }));
vi.mock("@/lib/audit", () => ({
  logAuditAction: vi.fn(async () => ({ ok: true, error: null })),
  logRevisionEvent: vi.fn(async () => {}),
}));
vi.mock("@/lib/stamping", async (orig) => {
  const real = await orig<typeof import("@/lib/stamping")>();
  return {
    ...real,
    applyStampToPdfDoc: vi.fn(async (doc: Parameters<typeof real.applyStampToPdfDoc>[0], opts: Parameters<typeof real.applyStampToPdfDoc>[1]) => {
      st.footers.push(opts.footerNotice);
      return real.applyStampToPdfDoc(doc, opts);
    }),
  };
});

import { withoutScanInstruction } from "@/lib/stamping";
import {
  ticketCopyPlan, copyDeclarationFacts, declarationFooterClause,
  DECLARATION_NOT_AVAILABLE, DECLARATION_NOT_RELIED_ON, DECLARATION_SIGNATURE_UNCHECKED,
} from "@/lib/ticketDeliverableCopy";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const T = "77777777-7777-7777-7777-777777777777";
const ORG = "11111111-1111-1111-1111-111111111111";
const SIG = "99999999-9999-4999-8999-999999999999";
const KEY = `orgs/${ORG}/tickets/KE-9/ifc-rev1.pdf`;
const issued = (n: number) => ({ action: `Approve (Issue for Construction) — issued Rev ${n}`, user: "eng@plant.test" });

// ── (major) the statement never takes a safety clause off a QR-less copy ────
describe("GAP-101 acceptance 3 (DF-P23 fix pass, review major) — a statement with a scan instruction, on a copy with no QR", () => {
  const FINAL = { id: "f-1", name: "ifc.pdf", url: "k", type: "Final", rev: "2" } as never;
  const live = (over: Record<string, unknown>, statement: string) => ({
    status: "PENDING_IFC", deliverableRev: "2", history: [issued(1), issued(2)], revisionCount: 1,
    declaration: { by: "Pat Requester", declaredAt: "2026-10-01T09:30:00.000Z", statement },
    ...over,
  });
  const footer = (over: Record<string, unknown>, statement: string) =>
    ticketCopyPlan({ file: FINAL, ticketNumber: "KE-1", ticketRowId: T, origin: "", channel: "download", live: live(over, statement) as never }).footerNotice;
  const STATEMENTS = [
    "Same model; scan the code on the nameplate to confirm",
    "Scan this QR on the old pump - identical. Same rating",
    "Identical gasket — scan to verify the part number",
    "Like for like – scan the QR. Same flange! Same bolts?",
  ];
  const STANDINGS: Array<[string, Record<string, unknown>]> = [
    ["current", {}],
    ["withdrawn", { status: "CANCELED" }],
    ["superseded", { deliverableRev: "3", history: [issued(1), issued(2), issued(3)], revisionCount: 2 }],
    ["in progress", { status: "DRAFTING", revisionCount: 2 }],
  ];
  it("every standing keeps 'not a controlled document revision' after the stamper's cut (and 'do not work from it' when withdrawn); the statement's scan instruction is bracketed, nothing else of it changed but its spaced dashes", () => {
    for (const statement of STATEMENTS) {
      for (const [label, over] of STANDINGS) {
        const raw = footer(over, statement);
        expect(raw, `${label}: ${statement}`).toMatch(/declared like-in-kind by Pat Requester on 2026-10-01/);
        const printed = withoutScanInstruction(raw);
        expect(printed, `${label}: ${statement}`).toContain("not a controlled document revision");
        expect(printed, `${label}: ${statement}`).not.toMatch(/\bscan\s+(?:the\s+|this\s+)?(?:qr\b|code\b|to\s+verify\b)/i);
        expect(printed, `${label}: ${statement}`).toMatch(/\[[Ss]can\]/);
        if (label === "withdrawn") expect(printed).toContain("do not work from it");
        expect(raw).toMatch({ current: /^This file is KE-1 \(/, withdrawn: /^REQUEST WITHDRAWN/, superseded: /^SUPERSEDED by Rev 3/, "in progress": /a newer revision is in progress/ }[label]!);
      }
    }
    expect(footer({}, STATEMENTS[0])).toContain('"Same model; [scan] the code on the nameplate to confirm"');
    expect(footer({}, STATEMENTS[2])).toContain('"Identical gasket - [scan] to verify the part number"');
    expect(footer({}, STATEMENTS[1])).toContain('"[Scan] this QR on the old pump - identical. Same rating"');
  });
  it("REGRESSION: a statement with no scan instruction is printed as before; WITH a QR the footer's own scan clause is kept", () => {
    expect(declarationFooterClause({ by: "P", declaredAt: "2026-10-01T00:00:00Z", statement: "Replacing the gasket with an identical one" }))
      .toBe(' (declared like-in-kind by P on 2026-10-01: "Replacing the gasket with an identical one")');
    expect(footer({}, "Same scanner model")).toMatch(/scan the QR to confirm it is still the latest\.$/);
    expect(footer({}, "Same scanner model")).toContain('"Same scanner model"');
  });
});

// ── (minor) one rule for what a copy prints ─────────────────────────────────
describe("GAP-101 acceptance 3 (DF-P23 fix pass, review minor) — copyDeclarationFacts", () => {
  const base = { declaredAt: "2026-10-01T09:30:00Z", statement: "Identical gasket", declaredBy: "u-req", requesterId: "u-req", requesterName: "Pat", requesterEmail: "pat@plant.test" };
  it("a declaration is a time AND a statement — an empty statement is no declaration (as isDeclaredLikeInKind)", () => {
    expect(copyDeclarationFacts({ ...base, statement: "   ", signature: "verified" })).toBeNull();
    expect(copyDeclarationFacts({ ...base, statement: null, signature: "verified" })).toBeNull();
    expect(copyDeclarationFacts({ ...base, declaredAt: null, signature: "verified" })).toBeNull();
  });
  it("its e-signature: standing → attributed; known not to stand → 'unsigned' (not relied on); unread or unknown → attributed, 'e-signature not checked'", () => {
    expect(copyDeclarationFacts({ ...base, signature: "verified" })).toEqual({ by: "Pat", declaredAt: "2026-10-01T09:30:00.000Z", statement: "Identical gasket" });
    expect(copyDeclarationFacts({ ...base, signature: "missing" })).toBe("unsigned");
    expect(copyDeclarationFacts({ ...base, signature: "unchecked" })).toMatchObject({ signatureUnchecked: true });
    expect(copyDeclarationFacts({ ...base, signature: "pending" })).toMatchObject({ signatureUnchecked: true });
    expect(declarationFooterClause("unsigned")).toBe(` (${DECLARATION_NOT_RELIED_ON})`);
    expect(declarationFooterClause({ by: "Pat", declaredAt: null, statement: "Identical gasket", signatureUnchecked: true }))
      .toBe(` (declared like-in-kind by Pat: "Identical gasket"; ${DECLARATION_SIGNATURE_UNCHECKED})`);
  });
  it("the declarer is named only when the declaration is the requester's own", () => {
    expect(copyDeclarationFacts({ ...base, declaredBy: "u-other", signature: "verified" })).toMatchObject({ by: null });
  });
  it("the request page passes its Declaration card's signature check through the same rule (source pin)", () => {
    const page = src("app/(protected)/requests/[id]/page.tsx");
    expect(page).toContain("declaration: copyDeclarationFacts({");
    expect(page).toContain("requesterId: ticket.requesterId, requesterName: ticket.requesterName, requesterEmail: ticket.requesterEmail, signature: declarationCheck,");
  });
});

// ── the server copy route ───────────────────────────────────────────────────
async function pdfBytes(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.addPage([612, 792]);
  return new Uint8Array(await d.save());
}
describe("GAP-101 acceptance 3 (DF-P23 fix pass) — POST /api/tickets/copy prints only what the request's record supports", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: T, org_id: ORG, ticket_id: "KE-9", status: "PENDING_IFC", deliverable_rev: "1", revision_count: 0, history: [issued(1)],
    attachments: [{ id: "f-1", name: "ifc-rev1.pdf", url: KEY, type: "Final", status: "submitted", rev: "1" }],
    archived_at: null, requester_id: "u-req", assigned_drafter_id: "u-drafter", assigned_engineer_id: null, watchers: [],
    requester_name: "Pat Requester", requester_email: "pat@plant.test",
    like_in_kind_statement: null, like_in_kind_declared_by: null, like_in_kind_declared_at: null, like_in_kind_signature_id: null,
    ...over,
  });
  const declared = { like_in_kind_statement: "Identical gasket", like_in_kind_declared_by: "u-req", like_in_kind_declared_at: "2026-10-01T09:30:00Z", like_in_kind_signature_id: SIG };
  const standing = { id: SIG, org_id: ORG, resource_type: "ticket", resource_id: T, signer_user_id: "u-req" };
  beforeEach(async () => {
    vi.resetModules();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    st.user = { id: "u-drafter", email: "drafter@plant.test" };
    st.member = { uid: "u-drafter", role: "Drafter", roles: ["Drafter"], email: "drafter@plant.test" };
    st.ticket = row();
    st.ticketSelects = []; st.ticketSelectErrors = []; st.inserts = []; st.footers = [];
    st.signature = null; st.signatureError = null; st.signatureReads = 0;
    st.objects = { [KEY]: await pdfBytes() };
    process.env.NEXT_PUBLIC_SITE_URL = "https://plant.example.com";
  });
  const post = async () => {
    const { POST } = await import("@/app/api/tickets/copy/route");
    return POST(new NextRequest("https://app.example.com/api/tickets/copy", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer good" }, body: JSON.stringify({ ticketId: T, attachmentId: "f-1", channel: "download" }),
    }));
  };
  const transient = { code: "57014", message: "canceling statement due to statement timeout" };

  it("a transient failure of the combined read, then a declaration read that answers: an engineered request (no declaration) prints NOTHING — never 'not available'", async () => {
    st.ticketSelectErrors = [transient, null, null];
    expect((await post()).status).toBe(200);
    expect(st.footers[0]).toBe("This file is KE-9 deliverable Rev 1 — not a controlled document revision — scan the QR to confirm it is still the latest.");
    expect(st.ticketSelects.at(-1)).toMatch(/^requester_name, requester_email, like_in_kind_statement/);
  });
  it("the same, on a declared request whose signature stands: the declaration is printed, attributed", async () => {
    st.ticket = row(declared);
    st.signature = standing;
    st.ticketSelectErrors = [transient, null, null];
    expect((await post()).status).toBe(200);
    expect(st.footers[0]).toContain('KE-9 (declared like-in-kind by Pat Requester on 2026-10-01: "Identical gasket") deliverable Rev 1');
  });
  it("only when the declaration's own read fails too is 'not available' printed — and the copy still goes out", async () => {
    st.ticket = row(declared);
    st.ticketSelectErrors = [transient, null, transient];
    expect((await post()).status).toBe(200);
    expect(st.footers[0]).toContain(`KE-9 (${DECLARATION_NOT_AVAILABLE}) deliverable Rev 1`);
    expect(st.signatureReads).toBe(0);
  });
  it("a declaration whose e-signature does not stand (another signer, or none) is not attributed — the copy says it was not relied on", async () => {
    st.ticket = row(declared);
    st.signature = { ...standing, signer_user_id: "u-someone-else" };
    expect((await post()).status).toBe(200);
    expect(st.footers[0]).toContain(`KE-9 (${DECLARATION_NOT_RELIED_ON}) deliverable Rev 1`);
    expect(st.footers[0]).not.toContain("Identical gasket");
    st.footers = []; st.signature = null;
    expect((await post()).status).toBe(200);
    expect(st.footers[0]).toContain(DECLARATION_NOT_RELIED_ON);
  });
  it("a signature read that fails prints the declaration with 'e-signature not checked' — never blocks the copy", async () => {
    st.ticket = row(declared);
    st.signatureError = transient;
    expect((await post()).status).toBe(200);
    expect(st.footers[0]).toContain(`"Identical gasket"; ${DECLARATION_SIGNATURE_UNCHECKED}) deliverable Rev 1`);
  });
  it("REGRESSION: an empty statement is no declaration (no clause, no signature read); before 20261250 nothing is added", async () => {
    st.ticket = row({ ...declared, like_in_kind_statement: "  " });
    expect((await post()).status).toBe(200);
    expect(st.footers[0]).toBe("This file is KE-9 deliverable Rev 1 — not a controlled document revision — scan the QR to confirm it is still the latest.");
    expect(st.signatureReads).toBe(0);
    st.footers = [];
    st.ticket = row(declared);
    st.ticketSelectErrors = [{ code: "42703", message: "column tickets.like_in_kind_statement does not exist" }, null];
    expect((await post()).status).toBe(200);
    expect(st.footers[0]).toBe("This file is KE-9 deliverable Rev 1 — not a controlled document revision — scan the QR to confirm it is still the latest.");
  });
});
