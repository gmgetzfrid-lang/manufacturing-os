// projects Round G — J1 INTAKE-DOOR: the pure rules behind the door.
//   lib/fileSniff.ts        what a file IS (SEC-1 / SEC-6 / INTK-11)
//   lib/intakeLinks.ts      where the token travels, link lifetime, text
//                           limits, the revoke helper (SEC-5 / INTK-8 / PM-2)
//   lib/intakeRateLimit.ts  the window, fail-open, the per-link budget
//                           (SEC-8 / INTK-8)
//   lib/postPublish.ts      `settle` awaits every signal (INTK-2's server run)

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: { from: () => { throw new Error("shared client not used here"); } } }));

import { sniffKind, validateIntakeFile, acceptedLabel, KIND_CONTENT_TYPE } from "@/lib/fileSniff";
import {
  INTAKE_TOKEN_RE, intakeTokenFromRequest, validateIntakeText, intakeExpiryFor, REV_LABEL_RE,
  revokeProjectIntakeLinks, CLOSED_PROJECT_STATUSES,
} from "@/lib/intakeLinks";
import {
  intakeLimits, DEFAULT_INTAKE_LIMITS, checkIntakeRate, linkBudgetRefusal, clientIp, sha256Hex, noticeSentRecently,
} from "@/lib/intakeRateLimit";

const enc = (s: string) => new TextEncoder().encode(s);
const bytes = (...b: number[]) => new Uint8Array(b);

describe("fileSniff — the bytes decide", () => {
  it("recognises PDF, DWG (AC10nn), ZIP (local header) and DXF (ASCII and binary)", () => {
    expect(sniffKind(enc("%PDF-1.4\n"))).toBe("pdf");
    expect(sniffKind(enc("AC1018\0\0\0"))).toBe("dwg");
    expect(sniffKind(bytes(0x50, 0x4b, 0x03, 0x04, 0x14))).toBe("zip");
    expect(sniffKind(enc("  0\r\nSECTION\r\n  2\r\nHEADER"))).toBe("dxf");
    expect(sniffKind(enc("999\nmade by CAD\n0\nSECTION\n"))).toBe("dxf");
    expect(sniffKind(bytes(0xef, 0xbb, 0xbf, ...enc("0\nSECTION\n")))).toBe("dxf");
    expect(sniffKind(enc("AutoCAD Binary DXF\r\n\x1a\x00"))).toBe("dxf");
  });
  it("refuses everything else: HTML, SVG, script, text, an EXE, an empty zip, a PDF header not at offset 0", () => {
    for (const b of [
      enc("<!doctype html><html>"), enc("<svg xmlns='http://www.w3.org/2000/svg'>"), enc("alert(1)"),
      enc("just text"), enc("MZ\x90\x00"), bytes(0x50, 0x4b, 0x05, 0x06), enc(" %PDF-1.4"), new Uint8Array(0),
    ]) expect(sniffKind(b)).toBeNull();
  });
  it("the stored type is the sniffed kind's — the declared one never survives", () => {
    const v = validateIntakeFile({ branch: "document", fileName: "ga.dwg", declaredType: "application/octet-stream", head: enc("AC1032") });
    expect(v).toEqual({ ok: true, kind: "dwg", contentType: KIND_CONTENT_TYPE.dwg });
  });
  it("the extension must name the kind; the declared type must be one a real file of that kind is sent with", () => {
    expect(validateIntakeFile({ branch: "document", fileName: "ga.dwg", declaredType: "", head: enc("%PDF-1.7") }).ok).toBe(false);
    const html = validateIntakeFile({ branch: "document", fileName: "plan.pdf", declaredType: "text/html", head: enc("%PDF-1.7") });
    expect(html.ok).toBe(false);
    expect(validateIntakeFile({ branch: "document", fileName: "plan.PDF", declaredType: "application/pdf; charset=binary", head: enc("%PDF-1.7") }).ok).toBe(true);
    expect(validateIntakeFile({ branch: "document", fileName: "x.html.pdf", declaredType: "application/pdf", head: enc("%PDF-1.7") }).ok).toBe(true);
  });
  it("per-branch allowlists: quotes PDF only; drawings and redlines PDF, DWG, DXF or ZIP — refusals name the list", () => {
    expect(acceptedLabel("quote")).toBe("PDF");
    expect(acceptedLabel("document")).toBe("PDF, DWG, DXF or ZIP");
    const q = validateIntakeFile({ branch: "quote", fileName: "q.zip", declaredType: "application/zip", head: bytes(0x50, 0x4b, 0x03, 0x04) });
    expect(q).toEqual({ ok: false, message: "This file type isn't accepted here — upload a PDF file." });
    expect(validateIntakeFile({ branch: "redline", fileName: "m.zip", declaredType: "application/zip", head: bytes(0x50, 0x4b, 0x03, 0x04) }).ok).toBe(true);
  });
});

describe("intakeLinks — the credential's rules", () => {
  it("the token comes from the header or the query string, never anything else", () => {
    const h = new Headers({ "x-intake-token": " abcdefghijklmnopqrst " });
    expect(intakeTokenFromRequest({ headers: h, url: "http://x/api/intake/upload" })).toBe("abcdefghijklmnopqrst");
    expect(intakeTokenFromRequest({ headers: new Headers(), url: "http://x/api/intake/upload?token=zzzzzzzzzzzzzzzz" })).toBe("zzzzzzzzzzzzzzzz");
    expect(intakeTokenFromRequest({ headers: new Headers(), url: "http://x/api/intake/upload" })).toBe("");
    expect(INTAKE_TOKEN_RE.test("short")).toBe(false);
  });
  it("text limits are refusals, not truncations; a revision label is a label", () => {
    expect(validateIntakeText({ title: "x".repeat(200), number: "N".repeat(64), revLabel: "IFC-1" })).toBeNull();
    expect(validateIntakeText({ title: "x".repeat(201), number: null, revLabel: null })).toMatch(/200 characters/);
    expect(validateIntakeText({ title: null, number: "N".repeat(65), revLabel: null })).toMatch(/64 characters/);
    for (const ok of ["A", "0", "2A", "IFC-1", "3.1", "B"]) expect(REV_LABEL_RE.test(ok), ok).toBe(true);
    for (const bad of ["", "-A", "A-", "C <b>", "A B", "x".repeat(25), "Rev​C"]) expect(REV_LABEL_RE.test(bad), bad).toBe(false);
  });
  it("a link's expiry is required, in the future, and at most 90 days away", () => {
    const now = new Date("2026-09-30T12:00:00");
    expect(intakeExpiryFor("", now).ok).toBe(false);
    expect(intakeExpiryFor("2026-09-29", now).ok).toBe(false);
    expect(intakeExpiryFor("2026-10-14", now)).toMatchObject({ ok: true });
    expect(intakeExpiryFor("2026-12-29", now).ok).toBe(true);
    expect(intakeExpiryFor("2027-01-15", now)).toMatchObject({ ok: false, message: expect.stringMatching(/at most 90 days/) });
  });
  it("closed projects: completed, cancelled, archived — not paused", () => {
    expect([...CLOSED_PROJECT_STATUSES].sort()).toEqual(["archived", "cancelled", "completed"]);
  });
  it("revokeProjectIntakeLinks revokes only live links of that project, reads them back, and audits by id", async () => {
    const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
    const fake = {
      from: (table: string) => {
        const q: Record<string, unknown> = {};
        const self = new Proxy(q, {
          get(_t, prop: string) {
            if (prop === "then") {
              const res = table === "project_intake_links" ? { data: [{ id: "l1" }, { id: "l2" }], error: null } : { data: null, error: null };
              return (r: (v: unknown) => void) => r(res);
            }
            return (...args: unknown[]) => { calls.push({ table, op: prop, args }); return self; };
          },
        });
        return self;
      },
    };
    const res = await revokeProjectIntakeLinks({ orgId: "o1", projectId: "p1", actorId: "u1", reason: "project deleted", client: fake as never });
    expect(res).toEqual({ ok: true, revoked: ["l1", "l2"] });
    const upd = calls.filter((c) => c.table === "project_intake_links");
    expect(upd.map((c) => c.op)).toEqual(["update", "eq", "eq", "is", "select"]);
    expect(upd[3].args).toEqual(["revoked_at", null]);
    const audit = calls.find((c) => c.table === "audit_logs" && c.op === "insert");
    expect(audit?.args[0]).toMatchObject({ action: "INTAKE_LINKS_REVOKED_WITH_PROJECT", resource_id: "p1", details: { linkIds: ["l1", "l2"], reason: "project deleted" } });
    expect(JSON.stringify(audit?.args[0])).not.toMatch(/token/);
  });
});

describe("intakeRateLimit — the window", () => {
  it("defaults 30 per token and 60 per IP per hour, one notice per 15 minutes; configurable without a code change", () => {
    expect(DEFAULT_INTAKE_LIMITS).toEqual({ perTokenPerHour: 30, perIpPerHour: 60, noticeWindowMinutes: 15 });
    expect(intakeLimits({ INTAKE_MAX_PER_TOKEN_HOUR: "5", INTAKE_MAX_PER_IP_HOUR: "9", INTAKE_NOTICE_WINDOW_MIN: "1" }))
      .toEqual({ perTokenPerHour: 5, perIpPerHour: 9, noticeWindowMinutes: 1 });
    expect(intakeLimits({ INTAKE_MAX_PER_TOKEN_HOUR: "-1", INTAKE_MAX_PER_IP_HOUR: "abc" })).toEqual(DEFAULT_INTAKE_LIMITS);
  });
  it("fails OPEN when the attempt log throws or errors", async () => {
    const throwing = { from: () => { throw new Error("down"); } };
    expect(await checkIntakeRate(throwing, { tokenHash: "h", ip: "1.2.3.4", limits: DEFAULT_INTAKE_LIMITS })).toEqual({ limited: false });
    const erroring = { from: () => new Proxy({}, { get: (_t, p) => p === "then" ? (r: (v: unknown) => void) => r({ count: null, error: { message: "x" } }) : () => erroring.from() }) };
    expect(await checkIntakeRate(erroring, { tokenHash: "h", ip: "1.2.3.4", limits: DEFAULT_INTAKE_LIMITS })).toEqual({ limited: false });
    expect(await noticeSentRecently(throwing, { tokenHash: "h", windowMinutes: 15 })).toBe(false);
  });
  it("the per-link budget: submissions, then bytes", () => {
    const b = { submissionCount: 10, maxSubmissions: 10, bytesReceived: 0, maxTotalBytes: 100 };
    expect(linkBudgetRefusal(b, null)).toMatch(/limit of 10 submissions/);
    expect(linkBudgetRefusal({ ...b, submissionCount: 1 }, 101)).toMatch(/storage allowance/);
    expect(linkBudgetRefusal({ ...b, submissionCount: 1 }, 100)).toBeNull();
    expect(linkBudgetRefusal(null, 10 ** 12)).toBeNull();
  });
  it("the first forwarded address is the client; the token is only ever stored hashed", () => {
    expect(clientIp({ headers: new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }) })).toBe("203.0.113.5");
    expect(clientIp({ headers: new Headers() })).toBe("unknown");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("postPublish settle — a server caller can wait for every signal", () => {
  it("settle:true awaits the fire-and-forget signals (including the one started from inside the recall block)", async () => {
    vi.resetModules();
    const order: string[] = [];
    const later = (name: string) => new Promise<void>((r) => setTimeout(() => { order.push(name); r(); }, 5));
    vi.doMock("@/lib/supabase", () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { current_version_id: "v2" } }) }) }) }) } }));
    vi.doMock("@/lib/notify/dispatch", () => ({ emit: vi.fn(() => later("emit")) }));
    vi.doMock("@/lib/intents", () => ({ listLiveIntents: vi.fn(async () => []) }));
    vi.doMock("@/lib/reviewCycles", () => ({ onDocumentIssued: vi.fn(async () => { order.push("clock"); }) }));
    vi.doMock("@/lib/acknowledgments", () => ({ onDocumentIssuedAck: vi.fn(async () => undefined) }));
    vi.doMock("@/lib/retention", () => ({ recomputeRetention: vi.fn(async () => undefined) }));
    vi.doMock("@/lib/distributionAcks", () => ({ closeStaleAcksForDocument: vi.fn(() => later("acks")) }));
    vi.doMock("@/lib/staleCopies", () => ({ getDocumentRecall: vi.fn(async () => ({ holders: [], unavailable: false })), nudgeStaleHolders: vi.fn(() => later("recall")) }));
    vi.doMock("@/lib/workPackages", () => ({ notifyPackagesOfRevUp: vi.fn(() => later("packages")) }));
    vi.doMock("@/lib/revisionImpact", () => ({ notifyConnectedWork: vi.fn(() => later("impact")) }));
    vi.doMock("@/lib/linkProposals", () => ({ staleProposalsForDocument: vi.fn(() => later("proposals")) }));
    const { runPostPublishSideEffects } = await import("@/lib/postPublish");
    await runPostPublishSideEffects({
      orgId: "o1", documentId: "d1", libraryId: "lib1", docLabel: "D", newRev: "C",
      actorUserId: "u1", actorName: "Vendor (intake)", settle: true,
    });
    expect(new Set(order)).toEqual(new Set(["clock", "emit", "acks", "recall", "packages", "impact", "proposals"]));
    vi.resetModules();
  });
});
