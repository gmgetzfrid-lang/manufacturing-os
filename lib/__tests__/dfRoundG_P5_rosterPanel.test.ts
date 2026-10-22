// drafting-flow Round G, DF-P5 ROSTER — the roster panel on the request page
// (who must act, who did, who was told; FRIC-2 / FRIC-4 / TIER-8 / DCW-6),
// the routing editor beside the review policy (GAP-112, DEC-36), and the
// page's one mount. Rendered with react-dom/server (effects do not run, so
// what is asserted is the first paint from the ticket alone).

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Ticket, TicketReviewRoster } from "@/types/schema";

vi.mock("@/lib/supabase", () => ({ supabase: { from: () => ({}) , auth: { getSession: async () => ({ data: { session: null } }) } } }));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ uid: "u-1", activeRole: "Admin", roles: ["Admin"] }) }));
import TicketRosterPanel, { TWO_REVIEWS_NOTE, ENGINEERING_GATE_NOTE, slotQuestion, slotStateText, rosterSignStatement, postSignOffOnce } from "@/components/requests/TicketRosterPanel";
import { ISSUE_AS_IS_NOTE, ROUTED_NO_ROSTER_REASON, routedNoRosterReason } from "@/lib/workflow";
import { draftToControl, controlToDraft, keptNote, routingSavedNote, inFlightConfirmMessage } from "@/components/documents/RoutingControlSection";
import { parseRoutingControl } from "@/lib/routingControl";

const NOW = "2026-10-21T12:00:00.000Z";
const roster: TicketReviewRoster = {
  v: 1, id: "r-1", openedAt: NOW, openedBy: "d-1", level: "library", cycle: "1A", contentHash: "h".repeat(64),
  files: [{ id: "a-d", name: "iso_1A.pdf", url: "u", sha256: "f".repeat(64) }],
  slots: [
    { id: "r-1:accept", kind: "accept", label: "Requester acceptance", mode: "blocking", primaries: ["req-1"], alternates: [], overriders: [], independentOf: [], timeoutDays: null, fallback: false, status: "open" },
    { id: "r-1:check", kind: "check", label: "Engineering check", mode: "blocking", primaries: ["e-1", "e-2"], alternates: [], overriders: [], independentOf: ["drafter"], timeoutDays: null, fallback: false, status: "satisfied", satisfiedBy: "e-1", satisfiedByName: "Erin", satisfiedAt: NOW, signatureId: "s", via: "primary" },
    { id: "r-1:told", kind: "told", label: "Process safety", mode: "notify_only", primaries: ["q-1"], alternates: [], overriders: [], independentOf: [], timeoutDays: null, fallback: false, status: "told" },
  ],
};
const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: "t1", orgId: "o1", ticketId: "REQ-1", title: "x", unit: null, requestType: "ISO", status: "PENDING_REVIEW",
  requesterId: "req-1", requesterRole: "Requester", requesterName: "Rita", assignedDrafterId: "d-1", createdAt: NOW,
  history: [], attachments: [], comments: [], watchers: [], unreadBy: [], deliverableRev: "1A", libraryId: null, ...over,
});
const render = (t: Ticket, uid = "req-1") => renderToStaticMarkup(createElement(TicketRosterPanel, { ticket: t, orgId: "o1", uid, activeMemberCount: 5 }));

describe("TicketRosterPanel — who must act, who did, who was told", () => {
  it("a routed request lists every slot: the question it asks, who signed and how, who was told; the viewer's open slot gets ONE sign-off", () => {
    const html = render(ticket({ metadata: { review_roster: roster } }));
    expect(html).toContain("Sign-offs in any order · Rev 1A");
    expect(html).toContain("Requester acceptance");
    expect(html).toContain("Is this what you asked for?"); // FRIC-2: the requester's own question
    expect(html).toContain("Is it correct?");
    expect(html).toContain("Signed by Erin");
    expect(html).toContain("Told — 1 person");
    expect(html).toContain("Sign off — Requester acceptance");
    expect(html).toContain(TWO_REVIEWS_NOTE.slice(0, 60)); // TIER-8, said plainly
  });
  it("someone who occupies nothing open sees the roster and no sign-off button", () => {
    const html = render(ticket({ metadata: { review_roster: roster } }), "x-9");
    expect(html).not.toContain("Sign off —");
  });
  it("an unconfigured request in review shows the seeded default, read-only (today's serial steps)", () => {
    const html = render(ticket({ requesterRole: "Maintenance" as never }));
    expect(html).toContain('data-testid="seeded-slots"');
    expect(html).toContain("Requester acceptance");
    expect(html).toContain("waiting now");
    expect(html).toContain("Engineering sign-off");
    expect(html).not.toContain("Sign off —");
  });
  it("nothing to show (drafting, no library) renders nothing", () => {
    expect(render(ticket({ status: "DRAFTING" }))).toBe("");
  });
  it("DCW-6 (source pin — effects do not run server-side): the panel resolves the request library's review policy through the one resolver and names its reviewers by CALLING lib/reviewControl.ts", () => {
    const src = readFileSync(join(process.cwd(), "components", "requests", "TicketRosterPanel.tsx"), "utf8");
    expect(src).toContain("const control = await effectiveReviewControlForDocument({ libraryId: ticket.libraryId as string });");
    expect(src).toContain("const { primaries } = await expandReviewers(orgId, control);");
    expect(src).toContain("This request&apos;s library reviews revisions before they publish");
  });
  it("slot words: waiting on any one of N, the management fallback said, alternates' date", () => {
    const open = roster.slots[0];
    expect(slotStateText({ ...open, primaries: ["a", "b"], fallback: true }, new Map())).toMatch(/any one of 2 people \(the management tier/);
    expect(slotStateText({ ...open, alternates: ["z"], timeoutDays: 3 }, new Map(), Date.parse(NOW) + 4 * 86_400_000, NOW)).toMatch(/alternates may sign now/);
    expect(slotQuestion({ kind: "x", primaries: ["e-1"] }, { requesterId: "req-1" })).toBe("Is it correct?");
  });
});

describe("RoutingControlSection — the editor writes the stored shape the resolver accepts", () => {
  it("draft slots become a routing table parseRoutingControl accepts (facility words, any fill, independence, alternates)", () => {
    const control = draftToControl([
      { kind: "insp", label: "Inspection", mode: "blocking", fillKind: "roles", roles: ["Supervisor"], users: [], capability: "", independentOf: ["drafter"], timeoutDays: "3", alternateRoles: ["Manager"] },
      { kind: "accept", label: "", mode: "blocking", fillKind: "requester", roles: [], users: [], capability: "", independentOf: [], timeoutDays: "", alternateRoles: [] },
      { kind: "told", label: "Told", mode: "notify_only", fillKind: "capability", roles: [], users: [], capability: "ticket.manage", independentOf: [], timeoutDays: "", alternateRoles: [] },
    ]);
    expect(control.slots[0]).toEqual({ kind: "insp", label: "Inspection", mode: "blocking", fill: { roles: ["Supervisor"] }, independent_of: ["drafter"], alternates: { roles: ["Manager"] }, timeoutDays: 3 });
    expect(control.slots[1].fill).toEqual({ identity: "requester" });
    expect(parseRoutingControl(control)).toMatchObject({ ok: true });
  });
  it("DF-P5 fix: a stored table round-trips through the editor unchanged — waivable_by, named alternates and a multi-source fill are kept, and the slot says so", () => {
    const stored = { slots: [
      { kind: "check", label: "Check", mode: "blocking", fill: { roles: ["Engineer"], users: ["e-9"] }, independent_of: ["drafter"],
        alternates: { roles: ["Manager"], users: ["m-1"] }, timeoutDays: 2, waivable_by: { roles: ["Admin"], capability: "ticket.manage" } },
      { kind: "accept", mode: "blocking", fill: { identity: "requester" } },
    ] };
    const parsed = parseRoutingControl(stored);
    if (!parsed || !parsed.ok) throw new Error("bad");
    const drafts = controlToDraft(parsed.control);
    expect(draftToControl(drafts)).toEqual(parsed.control);
    expect(keptNote(drafts[0])).toMatch(/also filled by roles: Engineer.*override.*1 named alternate person.*Saving keeps them as they are/);
    expect(keptNote(drafts[1])).toBeNull();
  });
  it("mounted beside the review policy (DEC-36: per container), not on /admin/requests", () => {
    const modal = readFileSync(join(process.cwd(), "components", "documents", "ReviewControlModal.tsx"), "utf8");
    expect(modal).toContain("<RoutingControlSection level={level} id={id} orgId={orgId} />");
    expect(readFileSync(join(process.cwd(), "app", "(protected)", "admin", "requests", "page.tsx"), "utf8")).not.toContain("RoutingControl");
  });
});

describe("the request page — one mount; the signature-carrying action is the panel's", () => {
  const page = readFileSync(join(process.cwd(), "app", "(protected)", "requests", "[id]", "page.tsx"), "utf8");
  it("mounts TicketRosterPanel once and leaves sign_slot (requiresSignature) to it; the engineer picker gets the policy and resource", () => {
    expect(page.match(/<TicketRosterPanel /g)).toHaveLength(1);
    expect(page).toContain("a.action !== 'reassign_drafter' && !a.requiresSignature);");
    expect(page).toContain("resource={ticketResource(ticket)}");
  });
});

describe("DF-P5 fix pass 2 — FRIC-5 in front of every approver; the engineering gate and the unfingerprinted files named", () => {
  const page = readFileSync(join(process.cwd(), "app", "(protected)", "requests", "[id]", "page.tsx"), "utf8");
  it("the roster panel shows the issue-as-is note above the sign-off while the draft is marked, and not otherwise", () => {
    const marked = render(ticket({ metadata: { review_roster: roster, issue_ready: { rev: "1A" } } }));
    expect(marked).toContain('data-testid="roster-issue-as-is"');
    expect(marked).toContain(ISSUE_AS_IS_NOTE);
    expect(marked.indexOf('data-testid="roster-issue-as-is"')).toBeLessThan(marked.indexOf("Sign off"));
    expect(render(ticket({ metadata: { review_roster: roster } }))).not.toContain('data-testid="roster-issue-as-is"');
  });
  it("the signed statement carries the issue-as-is note and names every file bound by identity, not content", () => {
    const base = { userName: "Rita", ticketLabel: "REQ-1", labels: ["Requester acceptance"] };
    expect(rosterSignStatement({ ...base, roster, issueReady: false })).not.toContain(ISSUE_AS_IS_NOTE);
    expect(rosterSignStatement({ ...base, roster, issueReady: true })).toContain(` ${ISSUE_AS_IS_NOTE}`);
    const un = { ...roster, files: [...roster.files, { id: "b", name: "big.pdf", url: "k", sha256: null, size: 3e8, unhashed: "not hashed (byte budget)" }] };
    expect(rosterSignStatement({ ...base, roster: un, issueReady: false })).toMatch(/Bound by name, storage location and size only — .*big\.pdf \(not hashed \(byte budget\)\)/);
    expect(render(ticket({ metadata: { review_roster: un } }))).toContain('data-testid="roster-unhashed-files"');
  });
  it("an appended engineering gate is said on the panel", () => {
    expect(render(ticket({ metadata: { review_roster: { ...roster, engineeringGateAdded: true } } }))).toContain(ENGINEERING_GATE_NOTE);
    expect(render(ticket({ metadata: { review_roster: roster } }))).not.toContain(ENGINEERING_GATE_NOTE);
  });
  it("the request page: an approval that issues as-is goes through a confirm; the serial banner; the UI-4 note survives the optional mark", () => {
    expect(page).toContain("const asIs = issueAsIsConfirmation(action, ticket);");
    expect(page).toContain("if (asIs && !(await appConfirm({ title: 'Approve and issue as-is?', message: asIs }))) return;");
    // the confirm runs before any branch that would send the action
    expect(page.indexOf("const asIs = issueAsIsConfirmation(action, ticket);")).toBeLessThan(page.indexOf("else { executeWorkflowAction(action); }"));
    expect(page).toContain('data-testid="issue-as-is-banner"');
    expect(page).toContain("const asIsBanner = issueAsIsBanner(ticket);");
    expect(page).toContain("const awaitedButtons = buttonActions.filter((a) => !ISSUE_MARK_ACTIONS.has(a.action));");
    expect(page).toContain("const noActionsWhy = awaitedButtons.length === 0 && !policyFault");
    expect(page.match(/data-testid="no-actions-why"/g)).toHaveLength(2);
  });
});

describe("DF-P5 fix pass 3 — the signature is minted only for a sign-off the route would take; the signer's name; the as-is acknowledgement; the routed-without-roster check", () => {
  const page = readFileSync(join(process.cwd(), "app", "(protected)", "requests", "[id]", "page.tsx"), "utf8");
  const panel = readFileSync(join(process.cwd(), "components", "requests", "TicketRosterPanel.tsx"), "utf8");
  it("the Sign off button asks the route first (a dry run) and opens the ceremony only on its yes; the ceremony is never opened directly", () => {
    // DF-P18 (HAND-7 dw3): the dry run carries the drift acknowledgement only when the panel asked for it
    // (fix pass: asked from the page's labels, or from the route's 409 and resent once).
    expect(panel).toContain('body: JSON.stringify({ ticketId: ticket.id, actionType: "sign_slot", dryRun: true, ...(ack ? { sourceDriftAcknowledged: true } : {}) }),');
    expect(panel).toContain("const acked = !!driftNote && driftAck;");
    expect(panel).toContain("onClick={() => { void openCeremony(); }}");
    expect(panel).not.toContain("onClick={() => setSigning(true)}");
    const dry = panel.indexOf("dryRun: true");
    expect(dry).toBeLessThan(panel.indexOf("setSigning(true);", dry));
  });
  it("the panel's signer name is the member's display name (RG-9), never the email", () => {
    expect(page).not.toContain("userName={userEmail}");
    expect(page).toContain("userName={(member?.displayName ?? '').trim() || (userEmail?.split('@')[0] ?? '').trim() || null}");
  });
  it("the page sends issueAsIsAcknowledged only for the approval its confirm asked about", () => {
    expect(page).toContain("if (asIs) asIsAckRef.current = action.action;");
    expect(page).toContain("...(asIsAckRef.current === action.action ? { issueAsIsAcknowledged: true } : {}),");
    expect(page.indexOf("asIsAckRef.current = null;")).toBeLessThan(page.indexOf("if (asIs) asIsAckRef.current = action.action;"));
  });
  it("the page tells the engine when a rosterless review is routed (ticketReviewRouting), so the serial approvals render disabled with the reason", () => {
    expect(page).toContain("void ticketReviewRouting({ id: ticket.id, orgId: ticketOrgId, libraryId: ticket.libraryId ?? null, sourceDocumentId: sourceRefId })");
    // DF-P6 fix pass 4 re-pin: the engine sees the ticket as its declaration check leaves it (ticketAsDeclarationChecked).
    expect(page).toContain("getActions(ticketAsDeclarationChecked(ticket, declarationCheck), activeRole, uid ?? undefined, capPolicy, {\n    reviewRouted, // TIER-5");
  });
});

describe("DF-P5 fix pass 4 — the page says the route's refusal; the panel and the editor say what is true of a routed review without a roster", () => {
  const page = readFileSync(join(process.cwd(), "app", "(protected)", "requests", "[id]", "page.tsx"), "utf8");
  const editor = readFileSync(join(process.cwd(), "components", "documents", "RoutingControlSection.tsx"), "utf8");
  const renderRouted = (over: Record<string, unknown>) => renderToStaticMarkup(createElement(TicketRosterPanel, { ticket: ticket({ libraryId: "lib-1" }), orgId: "o1", uid: "req-1", activeMemberCount: 5, ...over }));

  it("major 1: the page's 409 branch says the route's coded refusal (workflowRefusalMessage) and keeps 'someone else updated it' for the conflict only", () => {
    // fix pass 5: setActionLoading(null) stays the branch's FIRST statement
    // (DF-P9's PERS-7 ordering pin reads that exact pair of lines).
    const at = page.indexOf("      if (res.status === 409) {\n        setActionLoading(null);");
    expect(at).toBeGreaterThan(0);
    expect(page.indexOf("// DF-P5 fix pass 4", at)).toBeGreaterThan(at);
    const branch = page.slice(at, page.indexOf("return;", at));
    expect(branch).toContain("const refusal = workflowRefusalMessage(await res.clone().json().catch(() => null));");
    expect(branch).toContain('? { title: "Your action wasn\'t applied", message: refusal, tone: "danger" }');
    expect(branch).toContain("This request was just updated by someone else");
  });

  it("minor 6: a routed review with no roster shows 'No sign-off roster' with the way forward — not the unconfigured seed", () => {
    const html = renderRouted({ reviewRouted: true });
    expect(html).toContain('data-testid="routed-no-roster"');
    expect(html).toContain("No sign-off roster");
    expect(html).toContain("Request a revision so the drafter resubmits");
    expect(html).not.toContain('data-testid="seeded-slots"');
    expect(html).not.toContain("waiting now");
    // a routing table that cannot be used names the document controller instead
    const broken = routedNoRosterReason({ state: "invalid", level: "library", error: "slot 1 has no key" });
    const html2 = renderRouted({ reviewRouted: true, reviewRoutedReason: broken });
    expect(html2).toContain("Ask a document controller to correct the routing.");
    expect(html2).not.toContain("Request a revision");
    // REGRESSION: not routed — the seed, as before
    expect(renderRouted({})).toContain('data-testid="seeded-slots"');
    expect(ROUTED_NO_ROSTER_REASON).toMatch(/Request a revision/);
  });

  it("minor 6: the page passes the routing answer (and its reason) to the panel and the engine", () => {
    expect(page).toContain("reviewRouted={reviewRouted} reviewRoutedReason={reviewRoutedReason} /></div>");
    expect(page).toContain("setReviewRoutedReason(r.routed ? routedNoRosterReason(r.routing) : null);");
    expect(page).toMatch(/reviewRouted, \/\/ TIER-5[^\n]*\n\s*reviewRoutedReason,\n\s*userRoles: roles,/);
  });

  it("major 2: the save confirmation says what a saved table does to requests already in review — never 'applies from the next submission'", () => {
    const note = routingSavedNote("library");
    expect(note).toMatch(/already in review here without a roster can no longer be approved the usual way/);
    expect(note).toMatch(/needs a revision/);
    expect(editor).not.toContain("It applies from each request's next submission for review.");
    expect(editor).toContain('setMsg({ tone: "ok", text: inherit ? "Routing cleared — this level inherits." : routingSavedNote(levelWord) });');
  });

  it("major 2: declaring a table where there was none counts the requests in review it stops and asks first; nothing to ask when there are none", () => {
    expect(inFlightConfirmMessage("library", { ok: true, n: 0, capped: false })).toBeNull();
    expect(inFlightConfirmMessage("folder", { ok: true, n: 3, capped: false })).toMatch(/^3 requests are in review in this folder \(that you can see\) without a sign-off roster\. They can no longer be approved the usual way/);
    expect(inFlightConfirmMessage("library", { ok: true, n: 1, capped: false })).toMatch(/^1 request is in review .* It can no longer/);
    expect(inFlightConfirmMessage("library", { ok: true, n: 500, capped: true })).toMatch(/^At least 500 requests are/);
    expect(inFlightConfirmMessage("document", { ok: false, error: "boom" })).toMatch(/could not be counted \(boom\)/);
    // the save path: counted BEFORE the write, asked, and a "no" writes nothing
    const save = editor.slice(editor.indexOf("const save = async () => {"), editor.indexOf("await setRoutingControl({ level, id, control: draft });"));
    expect(save).toContain("if (!inherit && !storedDeclared) {");
    expect(save).toContain("const question = inFlightConfirmMessage(levelWord, await reviewsInFlightUnder(level, id));");
    expect(save).toContain("if (question && !(await appConfirm({");
    expect(save).toContain("return;");
  });
});

describe("DF-P5 fix pass 5 — the panel retries a sign-off only on the compare-and-set conflict", () => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  it("conflict: true → one retry on the fresh row; its answer is what is said", async () => {
    const post = vi.fn()
      .mockResolvedValueOnce(reply(409, { error: "The ticket changed while you were acting — refresh and try again", conflict: true }))
      .mockResolvedValueOnce(reply(200, { ok: true }));
    const { res } = await postSignOffOnce(post);
    expect(post).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });
  it("a 409 refusal without the conflict flag (no review open, a coded refusal) is NOT re-posted — the route records it once", async () => {
    for (const body of [{ error: "This request has no review open." }, { error: "x", code: "roster_stale" }]) {
      const post = vi.fn().mockResolvedValueOnce(reply(409, body)).mockResolvedValueOnce(reply(200, { ok: true }));
      const { res, out } = await postSignOffOnce(post);
      expect(post).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(409);
      expect(out.error).toBe(body.error);
    }
  });
  it("the panel's sign() goes through it (no bare re-post on any 409)", () => {
    const panel = readFileSync(join(process.cwd(), "components", "requests", "TicketRosterPanel.tsx"), "utf8");
    expect(panel).toContain("const { res, out } = await postSignOffOnce(post);");
    expect(panel).not.toContain("if (res.status === 409) res = await post();");
  });
});
