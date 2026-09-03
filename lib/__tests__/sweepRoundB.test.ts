// Phase 6 severity sweep, Round B — the app halves that ship with migrations
// 20261046 / 20261047: OWN-8 (explicit deny wins in both TS evaluators),
// OWN-15 (unarchive restore-status allow-list), DEL-4 (supervisor swap is a
// controller act), DEL-9 (the app asks the DB's own ownership cascade),
// LIFE-6 (hold origin + the close gate), SURF-17 (server-side transmittal mail).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateAcl } from "@/lib/acl";
import { canPublishViaIndex } from "@/lib/permissions";
import { UNARCHIVE_RESTORE_STATUSES } from "@/lib/revisions";
import type { AccessControl, AclIndex } from "@/types/schema";

const src = (p: string) => readFileSync(process.cwd() + "/" + p, "utf8");
const ctx = { uid: "u1", role: "Engineer-1" as const, roles: ["Engineer-1" as const], orgId: "o", teamIds: [], isActiveMember: true };
const rule = (effect: "allow" | "deny", actions: string[]) => ({ id: `${effect}-${actions.join("-")}`, subject: { type: "user", id: "u1" }, effect, actions });

describe("OWN-8 — explicit deny wins in lib/acl.ts and canPublishViaIndex (DEC-8)", () => {
  it("{allow admin, deny publish} → publish DENIED; {allow admin, deny admin} → DENIED; {allow admin} alone → allowed", () => {
    const d1 = evaluateAcl({ rules: [rule("allow", ["admin"]), rule("deny", ["publish"])] } as unknown as AccessControl, ctx)!;
    expect(d1.can("publish")).toBe(false);
    expect(d1.can("read")).toBe(true);
    const d2 = evaluateAcl({ rules: [rule("allow", ["admin"]), rule("deny", ["admin"])] } as unknown as AccessControl, ctx)!;
    expect(d2.can("publish")).toBe(false);
    const d3 = evaluateAcl({ rules: [rule("allow", ["admin"])] } as unknown as AccessControl, ctx)!;
    expect(d3.can("publish")).toBe(true);
  });
  it("canPublishViaIndex agrees: an admin allow is gated on no admin deny, per subject bucket", () => {
    const p = { uid: "u1", role: "Engineer-1" as const, roles: ["Engineer-1" as const], orgId: "o", teamIds: ["t1"], isActiveMember: true };
    const idx = (allow: Record<string, Record<string, string[]>>, deny: Record<string, Record<string, string[]>> = {}) => ({ allow, deny } as unknown as AclIndex);
    expect(canPublishViaIndex(idx({ users: { admin: ["u1"] } }), p)).toBe(true);
    expect(canPublishViaIndex(idx({ users: { admin: ["u1"] } }, { users: { admin: ["u1"] } }), p)).toBe(false);
    expect(canPublishViaIndex(idx({ users: { admin: ["u1"] } }, { users: { publish: ["u1"] } }), p)).toBe(false);
    expect(canPublishViaIndex(idx({ roles: { admin: ["Engineer-1"] } }, { teams: { admin: ["t1"] } }), p)).toBe(false);
    expect(canPublishViaIndex(idx({ users: { publish: ["u1"] } }, { users: { admin: ["u1"] } }), p)).toBe(true);
  });
  it("the ordering is pinned at the source: deny of the action is tested before the admin short-circuit", () => {
    const a = src("lib/acl.ts");
    expect(a.indexOf('if (denied.has(action)) return false;')).toBeLessThan(a.indexOf('if (allowed.has("admin") && !denied.has("admin")) return true;'));
  });
});

describe("OWN-15 — unarchive restores only to an allow-listed status", () => {
  it("the list is Issued / Draft / In Review and unarchiveDocument refuses anything else", () => {
    expect([...UNARCHIVE_RESTORE_STATUSES]).toEqual(["Issued", "Draft", "In Review"]);
    const r = src("lib/revisions.ts");
    expect(r).toMatch(/if \(restoreStatus && !\(UNARCHIVE_RESTORE_STATUSES as readonly string\[\]\)\.includes\(restoreStatus\)\) \{/);
  });
});

describe("DEL-4 — the supervisor swap is a controller act on the page too", () => {
  it("the supervisor select, the outside-team override and the library chips are disabled for non-controllers with a reason", () => {
    const p = src("app/(protected)/admin/teams/page.tsx");
    expect(p).toMatch(/const isController = hasAnyRole\(\["Admin", "DocCtrl"\]\);/);
    expect((p.match(/disabled=\{!isController\}/g) ?? []).length).toBe(2);
    expect(p).toMatch(/disabled=\{otherTeam \|\| !isController\}/);
    expect(p).toMatch(/it transfers publish authority/);
  });
});

describe("DEL-9 — the app asks the database's own ownership cascade", () => {
  it("isEffectiveOwnerOfDocument calls the user_is_effective_owner RPC and falls back only when it is unavailable", () => {
    const o = src("lib/ownership.ts");
    const fn = o.slice(o.indexOf("export async function isEffectiveOwnerOfDocument"));
    expect(fn).toMatch(/supabase\.rpc\("user_is_effective_owner", \{/);
    expect(fn).toMatch(/if \(!error && typeof viaDb === "boolean"\) return viaDb;/);
  });
});

describe("LIFE-6 — the hold knows its ticket; a close cannot be silent over it", () => {
  it("openHold writes origin_ticket_id, the check-in passes it, the type carries it", () => {
    expect(src("lib/holds.ts")).toMatch(/\.\.\.\(input\.originTicketId \? \{ origin_ticket_id: input\.originTicketId \} : \{\}\),/);
    expect(src("components/documents/CheckInPanel.tsx")).toMatch(/originTicketId: ticket\.id,/);
    expect(src("types/schema.ts")).toMatch(/originTicketId\?: string \| null;/);
  });
  it("the workflow-action route refuses a close over an open originating hold unless the closer releases it or records why it stays", () => {
    const r = src("app/api/tickets/workflow-action/route.ts");
    const gate = r.slice(r.indexOf('if (body.actionType === "close_ticket" || body.actionType === "close_rfi") {'), r.indexOf("let baseQuery = supabaseAdmin"));
    expect(gate).toMatch(/\.eq\("origin_ticket_id", body\.ticketId\)\s*\n\s*\.is\("released_at", null\)/);
    expect(gate).toMatch(/code: "holds_open"/);
    expect(gate).toMatch(/if \(!resolution \|\| \(resolution\.action === "keep" && !reason\)\) \{/);
    expect(gate).toMatch(/action: "HOLD_RELEASED"/);
    expect(gate).toMatch(/action: "HOLD_KEPT_ON_CLOSE"/);
    // Never auto-release: the release branch runs only on an explicit resolution.
    expect(gate).toMatch(/if \(resolution\.action === "release"\) \{/);
    // The gate sits inside the enforcement frame, before the CAS update.
    expect(r.indexOf("code: \"holds_open\"")).toBeGreaterThan(r.indexOf("computeTransition(ticket, input)"));
  });
  it("the ticket page handles 409 holds_open with release-or-keep and re-sends with the resolution", () => {
    const p = src("app/(protected)/requests/[id]/page.tsx");
    expect(p).toMatch(/if \(j\.code === 'holds_open'\) \{/);
    expect(p).toMatch(/confirmLabel: 'Release the hold',\s*\n\s*cancelLabel: 'Keep it open',/);
    expect(p).toMatch(/holdResolution = \{ action: 'keep', reason \};/);
    expect(p).toMatch(/if \(reason === null \|\| !reason\.trim\(\)\) \{ setActionLoading\(null\); return; \}/);
  });
});

describe("SURF-17 — external mail is queued server-side from the row", () => {
  it("the route renders from the transmittal row, checks issuer-or-controller, and marks the queue row external", () => {
    const r = src("app/api/transmittal/send-email/route.ts");
    expect(r).toMatch(/renderTransmittalEmail\(t, transmittalPortalUrl\(t\.portalToken\)\)/);
    expect(r).toMatch(/if \(t\.createdBy !== user\.id && !isController\) \{/);
    expect(r).toMatch(/metadata: \{ number: t\.number, purpose: t\.purpose, external: true, sentVia: "server" \}/);
    expect(r).not.toMatch(/body\.(subject|bodyHtml|html|to)/);
  });
  it("the browser no longer inserts external mail: sendTransmittalEmail calls the route and queueExternalEmail is gone", () => {
    const t = src("lib/transmittals.ts");
    expect(t).toMatch(/fetch\("\/api\/transmittal\/send-email"/);
    expect(t).not.toMatch(/queueExternalEmail/);
    expect(src("lib/notifications.ts")).not.toMatch(/export async function queueExternalEmail/);
  });
});
