// Phase 7 build 4 / Round C2 — the drafting → document-control hand-back
// (GAP-6, DEC-22, DEC-26; LIFE-1, LIFE-5, LIFE-11). The ticket offers
// "Publish as revision of DOC-xxx" to PUBLISH authority on the document's
// library, pre-seeds the existing rev-up flow (Final file, issue purpose,
// the check-in's MOC position, a change log naming the ticket, provenance)
// and lets revUpDocument do everything else. Closing without a revision leaves
// a visible "not in the register" state. 20261049 writes the provenance.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import {
  latestFinalAttachment, mocOriginOf, handbackPreset, deliverableStateOf,
  publishedDeliverable, noteDeliverableNotInRegister, toMillis,
} from "@/lib/ticketHandback";
import type { TicketAttachment } from "@/types/schema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const att = (o: Partial<TicketAttachment>): TicketAttachment =>
  ({ id: "a", name: "f.pdf", url: "orgs/o/tickets/t/f.pdf", type: "Final", status: "submitted", ...o }) as TicketAttachment;

describe("lib/ticketHandback — pure pre-seeding and outcome helpers", () => {
  it("latestFinalAttachment picks the newest Final with a storage path", () => {
    expect(latestFinalAttachment([att({ type: "Draft" })])).toBeNull();
    expect(latestFinalAttachment(undefined)).toBeNull();
    const older = att({ id: "1", uploadedAt: "2026-09-01T00:00:00Z" as unknown as TicketAttachment["uploadedAt"] });
    const newer = att({ id: "2", uploadedAt: "2026-09-02T00:00:00Z" as unknown as TicketAttachment["uploadedAt"] });
    expect(latestFinalAttachment([older, newer, att({ id: "3", url: "" })])?.id).toBe("2");
    expect(toMillis({ seconds: 10 })).toBe(10_000);
    expect(toMillis("not a date")).toBe(0);
  });
  it("mocOriginOf reads the check-in's MOC position; a 'none' never carries a number", () => {
    expect(mocOriginOf({ moc: { status: "completed", number: " MOC-1 " } })).toEqual({ status: "completed", number: "MOC-1" });
    expect(mocOriginOf({ moc: { status: "none", number: "MOC-9" } })).toEqual({ status: "none", number: null });
    expect(mocOriginOf({ moc: { status: "weird" } })).toBeNull();
    expect(mocOriginOf({})).toBeNull();
  });
  it("handbackPreset: ASBUILT → As-Built (DEC-26), visibly noted; change log names the ticket", () => {
    const p = handbackPreset({ ticketId: "REQ-42", title: "Relief header as-built", requestType: "ASBUILT", metadata: { moc: { status: "in_progress", number: "MOC-7" } } });
    expect(p.issueType).toBe("As-Built");
    expect(p.issueTypeNote).toMatch(/request REQ-42 is an as-built request/);
    expect(p.mocOrigin).toEqual({ status: "in_progress", number: "MOC-7" });
    expect(p.changeLog).toBe("Deliverable of drafting request REQ-42 — Relief header as-built.");
    const r = handbackPreset({ ticketId: "REQ-1", title: "", requestType: "Revision", metadata: {} });
    expect(r.issueType).toBeUndefined();
    expect(r.mocOrigin).toBeNull();
  });
  it("outcome state: published merges into the bag; not-in-register never overwrites a publish", () => {
    const m = publishedDeliverable({ source_document: { id: "d1" }, moc: { status: "none" } }, { versionId: "v1", revisionLabel: "3", documentId: "d1", publishedBy: "u1", now: "2026-09-02T00:00:00Z" });
    expect(m.source_document).toEqual({ id: "d1" });
    expect(deliverableStateOf(m)).toMatchObject({ state: "published", version_id: "v1", revision_label: "3", document_id: "d1" });
    expect(noteDeliverableNotInRegister(m, { documentId: "d1", registerRev: "2" })).toBeNull();
    const n = noteDeliverableNotInRegister({ source_document: { id: "d1" } }, { documentId: "d1", registerRev: "2", now: "2026-09-02T00:00:00Z" })!;
    expect(deliverableStateOf(n)).toEqual({ state: "not_in_register", document_id: "d1", register_rev: "2", noted_at: "2026-09-02T00:00:00Z" });
    expect(deliverableStateOf({ deliverable: { state: "published" } })).toBeNull();
  });
});

// ── the recording route, driven with a mocked admin client ─────────────────
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  tables: {} as Record<string, unknown>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  emitted: [] as Array<Record<string, unknown>>,
}));
function chain(table: string) {
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: state.tables[table] ?? null, error: null });
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "maybeSingle") return Promise.resolve({ data: state.tables[table] ?? null, error: null });
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (t: string) => chain(t),
  },
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async (e: Record<string, unknown>) => { state.emitted.push(e); }) }));
import { POST as handback } from "@/app/api/tickets/handback/route";

const post = (body: unknown, auth = "Bearer t") => handback(new NextRequest("http://x/api/tickets/handback", {
  method: "POST", headers: auth ? { authorization: auth, "content-type": "application/json" } : { "content-type": "application/json" }, body: JSON.stringify(body),
}));
const ticketRow = (metadata: Record<string, unknown>) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-42", title: "x", status: "FINAL_DRAFT", requester_id: "req", watchers: ["w1"],
  history: [{ action: "Created", date: "2026-09-01T00:00:00Z" }], metadata, last_modified: "2026-09-02T00:00:00Z",
});

beforeEach(() => { state.user = { id: "u1", email: "pat@x.io" }; state.tables = {}; state.calls = []; state.emitted = []; });

describe("/api/tickets/handback — records an outcome it can prove, nothing else", () => {
  it("401 without a bearer; 404 unknown ticket; 403 non-member; 400 no source document", async () => {
    expect((await post({ ticketId: "t1", versionId: "v1" }, "")).status).toBe(401);
    expect((await post({ ticketId: "t1", versionId: "v1" })).status).toBe(404);
    state.tables.tickets = ticketRow({ source_document: { id: "d1", document_number: "P-1" } });
    expect((await post({ ticketId: "t1", versionId: "v1" })).status).toBe(403);
    state.tables.org_members = { uid: "u1", email: "pat@x.io", role: "DocCtrl" };
    state.tables.tickets = ticketRow({});
    expect((await post({ ticketId: "t1", versionId: "v1" })).status).toBe(400);
  });
  it("409 when the version is not THIS ticket's deliverable of THIS source document", async () => {
    state.tables.org_members = { uid: "u1", email: "pat@x.io", role: "DocCtrl" };
    state.tables.tickets = ticketRow({ source_document: { id: "d1", document_number: "P-1" } });
    state.tables.document_versions = { id: "v1", org_id: "o1", record_id: "d1", revision_label: "3", related_ticket_id: "OTHER", review_state: null };
    expect((await post({ ticketId: "t1", versionId: "v1" })).status).toBe(409);
    state.tables.document_versions = { id: "v1", org_id: "o1", record_id: "d9", revision_label: "3", related_ticket_id: "t1", review_state: null };
    expect((await post({ ticketId: "t1", versionId: "v1" })).status).toBe(409);
    expect(state.calls.filter((c) => c.table === "tickets" && c.method === "update")).toHaveLength(0);
  });
  it("200: merges metadata.deliverable, appends history, writes the audit row, tells the requester and watchers", async () => {
    state.tables.org_members = { uid: "u1", email: "pat@x.io", role: "DocCtrl" };
    state.tables.tickets = ticketRow({ source_document: { id: "d1", document_number: "P-1" }, moc: { status: "none" } });
    state.tables.document_versions = { id: "v1", org_id: "o1", record_id: "d1", revision_label: "3", related_ticket_id: "t1", review_state: null };
    const res = await post({ ticketId: "t1", versionId: "v1" });
    expect(res.status).toBe(200);
    const out = await res.json() as { metadata: Record<string, unknown>; history: Array<{ action: string; details?: string }> };
    expect(out.metadata.moc).toEqual({ status: "none" });
    expect(out.metadata.deliverable).toMatchObject({ state: "published", version_id: "v1", revision_label: "3", document_id: "d1", published_by: "u1" });
    expect(out.history.at(-1)).toMatchObject({ action: "Deliverable published to the register" });
    expect(out.history.at(-1)?.details).toContain("Rev 3 of P-1");
    const upd = state.calls.find((c) => c.table === "tickets" && c.method === "update")!;
    expect((upd.args[0] as Record<string, unknown>).metadata).toEqual(out.metadata);
    const audit = state.calls.find((c) => c.table === "audit_logs" && c.method === "insert")!;
    expect(audit.args[0]).toMatchObject({ action: "TICKET_HANDBACK_PUBLISHED", resource_id: "t1", org_id: "o1", user_id: "u1" });
    expect(state.emitted).toHaveLength(1);
    expect((state.emitted[0].audience as { involved: string[] }).involved).toEqual(expect.arrayContaining(["req", "w1"]));
  });
  it("a review-gated draft is recorded as in review, not as published", async () => {
    state.tables.org_members = { uid: "u1", email: "pat@x.io", role: "DocCtrl" };
    state.tables.tickets = ticketRow({ source_document: { id: "d1", document_number: "P-1" } });
    state.tables.document_versions = { id: "v1", org_id: "o1", record_id: "d1", revision_label: "3A", related_ticket_id: "t1", review_state: "in_review" };
    const out = await (await post({ ticketId: "t1", versionId: "v1" })).json() as { metadata: { deliverable: Record<string, unknown> }; history: Array<{ action: string }> };
    expect(out.metadata.deliverable).toMatchObject({ state: "published", in_review: true, revision_label: "3A" });
    expect(out.history.at(-1)?.action).toBe("Deliverable submitted for document review");
    expect((state.calls.find((c) => c.table === "audit_logs")!.args[0] as { action: string }).action).toBe("TICKET_HANDBACK_REVIEW_OPENED");
  });
});

describe("pinned at the source — the publish path is reused, never reimplemented", () => {
  it("revUpDocument carries relatedTicketId to the version row (direct, review-draft and legacy paths) and the audit", () => {
    const r = src("lib/revisions.ts");
    expect(r).toMatch(/relatedTicketId\?: string \| null;/);
    expect((r.match(/related_ticket_id: input\.relatedTicketId \?\? null,/g) ?? []).length).toBe(2);
    expect(r).toContain("relatedTicketId: input.relatedTicketId ?? null,");
    expect(r).toContain('msg.includes("related_ticket_id")');
    expect(r).toContain("delete insertBody.related_ticket_id;");
  });
  it("RevUpModal: presetFile / presetMocOrigin / relatedTicketId; a recorded 'no MOC' needs an explicit acknowledgement written into the change log", () => {
    const m = src("components/documents/RevUpModal.tsx");
    expect(m).toContain("if (presetFile) setFile(presetFile);");
    expect(m).toContain("if (presetMocOrigin?.number) setMocReference(presetMocOrigin.number);");
    expect(m).toMatch(/const mocContradictsOrigin = presetMocOrigin\?\.status === "none" && mocReference\.trim\(\)\.length > 0;/);
    expect(m).toMatch(/if \(mocContradictsOrigin && !mocOriginAck\) \{\s*\n\s*return setError\(/);
    expect(m).toContain("revisionLabel, changeLog: effectiveChangeLog,");
    expect(m).toContain("relatedTicketId: relatedTicketId ?? null,");
    expect((m.match(/\{mocOriginNote\}/g) ?? []).length).toBe(2);
    expect(m).not.toMatch(/supabase\.from\("document_versions"\)\.insert/);
  });
  it("the ticket page gates the action on library publish authority or effective ownership — never on ticket authority — and routes through RevUpModal", () => {
    const t = src("app/(protected)/requests/[id]/page.tsx");
    expect(t).toContain("resolveCanControlLibrary(libId, principal),");
    expect(t).toContain("isEffectiveOwnerOfDocument(docId, uid).catch(() => false),");
    expect(t).toMatch(/const canOfferHandback = !!handback && canPublishSource && !!latestFinalAttachment\(ticket\.attachments\) && deliverable\?\.state !== 'published';/);
    expect(t).toContain("Publish as revision of ${sourceRef.documentNumber || sourceDoc.doc.documentNumber || 'document'}");
    expect(t).toContain("relatedTicketId={handback.ticketId}");
    expect(t).toContain("presetFile={handbackFile}");
    expect(t).toContain("presetMocOrigin={handback.mocOrigin ? { ...handback.mocOrigin, label: handback.label } : null}");
    expect(t).toContain("fetch('/api/tickets/handback'");
    expect(t).not.toMatch(/canOfferHandback[^\n]*isAdmin/);
    expect(t).not.toMatch(/revUpDocument\(/);
  });
  it("rowToTicket maps the metadata bag — the server-side readers of source_document depend on it", () => {
    expect(src("lib/ticketTransitions.ts")).toContain("metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,");
  });
  it("closing a ticket with a source document and no revision records 'not_in_register' and tells the people notified", () => {
    const r = src("app/api/tickets/workflow-action/route.ts");
    expect(r).toContain('import { noteDeliverableNotInRegister, deliverableStateOf } from "@/lib/ticketHandback";');
    expect(r).toMatch(/if \(newStatus === "CLOSED"\) \{/);
    expect(r).toContain('deliverableStateOf(ticket.metadata)?.state !== "published"');
    expect(r).toContain("updates.metadata = merged;");
    expect(r).toContain('action: "Closed — deliverable not in the register"');
    expect(r).toContain("comment: fanOutComment });");
    expect(r).not.toMatch(/revUpDocument|publish_revision/);
  });
});

describe("20261049 — publish_revision writes related_ticket_id; nothing else in the body moves", () => {
  const m49 = src("supabase/migrations/20261049_rp_phase7_handback_related_ticket.sql");
  const m40 = src("supabase/migrations/20261040_rp_phase5_additive_publish_path.sql");
  const fn = (t: string) => { const a = t.indexOf("CREATE OR REPLACE FUNCTION publish_revision("); const b = t.indexOf("\n$$;", a); return t.slice(a, b + 4); };
  it("line-diff against the live 20261040 body is exactly the INSERT-list column and the VALUES expression", () => {
    const A = fn(m49).split("\n"), B = fn(m40).split("\n");
    const onlyInNew = A.filter((l) => !B.includes(l)), onlyInOld = B.filter((l) => !A.includes(l));
    expect(onlyInNew).toEqual([
      "      is_branch, published_base_version_id, provenance, related_ticket_id",
      "      p_as_branch, p_expected_base, NULLIF(p_version->>'provenance',''),",
      "      NULLIF(p_version->>'related_ticket_id','')::uuid",
    ]);
    expect(onlyInOld).toEqual([
      "      is_branch, published_base_version_id, provenance",
      "      p_as_branch, p_expected_base, NULLIF(p_version->>'provenance','')",
    ]);
  });
  it("column added idempotently, GRANT/REVOKE carried, COMMIT before verification, probes escape apostrophes", () => {
    expect(m49).toContain("ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS related_ticket_id UUID;");
    expect(m49).toContain("REVOKE ALL ON FUNCTION publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean) FROM PUBLIC;");
    expect(m49).toContain("GRANT EXECUTE ON FUNCTION publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean) TO authenticated, service_role;");
    expect(m49.indexOf("COMMIT;")).toBeLessThan(m49.indexOf("── Verification"));
    const v = m49.slice(m49.indexOf("── Verification"));
    expect(v).toContain("prosrc LIKE '%NULLIF(p_version->>''related_ticket_id'','''')::uuid%'");
    for (const x of v.matchAll(/(?:qual|with_check) LIKE '((?:[^']|'')*)'/g)) expect(x[1]).not.toMatch(/\w::\w/);
  });
});
