// notifications Round G, N2 KIND-REGISTRY — PROD-8 done-when 2: the checkout
// thread's notification keeps a handoff and a markup post apart from chat
// (checkout_handoff / markup_request), instead of collapsing all six post
// kinds to checkout_message. Every one of them stays a 'documents' kind, so no
// badge moves; the channel stays in-app (notifyMany — no email).

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  notified: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase", () => {
  const rows: Record<string, unknown> = {
    checkout_sessions: [{ user_id: "holder" }],
    subscriptions: [{ user_id: "watcher" }],
  };
  const from = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order"]) q[m] = () => q;
    q.insert = (row: Record<string, unknown>) => {
      const inserted = { id: "m1", created_at: "2026-10-01T00:00:00Z", ...row };
      return { select: () => ({ single: async () => ({ data: inserted, error: null }) }) };
    };
    q.maybeSingle = async () => ({ data: table === "documents" ? { library_id: "L1", document_number: "P-101" } : null, error: null });
    q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve({ data: table === "checkout_messages" ? [{ user_id: "participant" }] : rows[table] ?? [], error: null }).then(ok, ko);
    return q;
  };
  return { supabase: { from } };
});
vi.mock("@/lib/inAppNotifications", () => ({
  notifyMany: vi.fn(async (input: Record<string, unknown>) => { db.notified.push(input); }),
}));
vi.mock("@/lib/checkoutEpisodes", () => ({
  getActiveEpisode: async () => null,
  isMissingEpisodeSchema: () => false,
}));

import { postActivity, postChat, postHandoff, postMarkupRef, postProposal, askIsLatest, answerQuestion } from "@/lib/activityThread";
import { sectionForKind } from "@/hooks/useTicketNotifications";
import { KIND_META } from "@/lib/notificationKinds";

const base = { orgId: "o1", documentId: "d1", episodeId: "e1", userId: "author", userName: "alice" };
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const lastKind = () => db.notified[db.notified.length - 1]?.kind;

beforeEach(() => { db.notified.length = 0; });

describe("PROD-8 — the thread's notification kind follows the post", () => {
  it("a handoff is checkout_handoff", async () => {
    await postHandoff({ ...base, text: "over to you" });
    await settle();
    expect(lastKind()).toBe("checkout_handoff");
    expect(db.notified[0]).toMatchObject({ title: "alice left a handoff on P-101", link: "/documents/L1?doc=d1", resourceType: "document" });
  });

  it("a markup post is markup_request", async () => {
    await postMarkupRef({ ...base, markupRequestId: "mr1", summary: "Markups shared" });
    await settle();
    expect(lastKind()).toBe("markup_request");
  });

  it("chat, a proposal, a question and an answer stay checkout_message, as before", async () => {
    for (const post of [
      () => postChat({ ...base, text: "hi" }),
      () => postProposal({ ...base, text: "move the valve" }),
      () => askIsLatest({ ...base }),
      () => answerQuestion({ ...base, text: "yes", parentMessageId: "m0" }),
    ]) {
      db.notified.length = 0;
      await post();
      await settle();
      expect(lastKind()).toBe("checkout_message");
    }
  });

  it("a system post notifies nobody (unchanged)", async () => {
    await postActivity({ ...base, kind: "system", text: "checked out" });
    await settle();
    expect(db.notified).toEqual([]);
  });

  it("all three kinds badge the Documents row, as checkout_message did — no badge moves", () => {
    for (const k of ["checkout_message", "checkout_handoff", "markup_request"] as const) {
      expect(sectionForKind(k), k).toBe("documents");
      expect(KIND_META[k].actionRequired, k).toBe(false);
    }
  });
});
