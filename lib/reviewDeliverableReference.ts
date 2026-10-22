// lib/reviewDeliverableReference.ts
//
// drafting-flow PROJ-1 (projects-joint J21; GAP-114; DEC-40 — reference, never
// copy): when a document review completes (lib/reviewControl.ts
// finalizeReviewedRevision) on a version a drafting request published into
// review, the request's project references the document on its register —
// the same project_documents reference, by the same register policy, that
// DF-P8's hand-back writes for a deliverable published outside review
// (POST /api/projects/deliverable-reference; lib/ticketProject.ts
// referenceDeliverableInProject).
//
// Fail-safe (DEC-90 ruling (1) for J21): this runs AFTER the publish landed,
// is started and never awaited by it, and never throws — a review completes
// exactly as before whatever happens here.
//   * A version no request produced (no related_ticket_id) makes no call.
//   * A request with no project: the route answers that nothing was owed.
//   * A transport failure or a retryable answer (5xx) is retried once.
//   * A reference not written (no register authority, a refused write) is
//     recorded by the route on the request's audit trail and said here —
//     to `onNote` when the caller passed one, else the console.

import { supabase } from "@/lib/supabase";

export const DELIVERABLE_REFERENCE_ROUTE = "/api/projects/deliverable-reference";
/** The wait before the one retry of an unreachable / 5xx route. */
export const DELIVERABLE_REFERENCE_RETRY_MS = 2_000;
/** How long one POST may take before it is abandoned (never awaited by the publish). */
export const DELIVERABLE_REFERENCE_TIMEOUT_MS = 10_000;

export type DeliverableReferenceAnswer = {
  ok: boolean;
  /** true when this call put the document on the register; absent when unknown. */
  referenced?: boolean;
  /** Why nothing was owed: not_from_request / no_project / not_current / not_finalizer / detached_since / not_migrated / already_referenced.
   *  Absent (with `referenced`) for a caller who cannot read the request (AUTHZ-13), or when the register could not be re-read. */
  skipped?: string;
  warning?: string;
  error?: string;
};

export type DeliverableReferenceOutcome =
  | { kind: "not_from_request" }
  | { kind: "answered"; answer: DeliverableReferenceAnswer }
  | { kind: "unreachable"; error: string };

async function postOnce(token: string, body: string): Promise<{ status: number; answer: DeliverableReferenceAnswer | null } | { status: 0; error: string }> {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), DELIVERABLE_REFERENCE_TIMEOUT_MS) : null;
  try {
    const res = await fetch(DELIVERABLE_REFERENCE_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body,
      keepalive: true,
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    const answer = (await res.json().catch(() => null)) as DeliverableReferenceAnswer | null;
    return { status: res.status, answer };
  } catch (e) {
    return { status: 0, error: (e as Error)?.message ?? String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** PROJ-1: reference a reviewed request deliverable on the request's project.
 *  Never throws; answers what happened (for tests and callers that await it —
 *  finalizeReviewedRevision does not). */
export async function referenceReviewedRequestDeliverable(input: {
  orgId: string;
  documentId: string;
  versionId: string;
  onNote?: (note: string) => void;
}): Promise<DeliverableReferenceOutcome> {
  const say = (note: string) => {
    try {
      if (input.onNote) input.onNote(note);
      else console.warn(`[reviewControl] ${note}`);
    } catch { /* a caller's note handler never fails this */ }
  };
  try {
    // Which request produced the version, read as the finalizer. No request:
    // no call. A read that fails is not "no request" — the server decides.
    const { data, error } = await supabase.from("document_versions").select("related_ticket_id").eq("id", input.versionId).maybeSingle();
    if (!error && !(data as { related_ticket_id?: string | null } | null)?.related_ticket_id) return { kind: "not_from_request" };

    const { data: sess } = await supabase.auth.getSession();
    const token = sess?.session?.access_token;
    if (!token) {
      say("The reviewed revision was published, but whether its drafting request's project should reference it could not be checked (no signed-in session) — a project manager can attach it from the project's Documents card.");
      return { kind: "unreachable", error: "no session" };
    }
    const body = JSON.stringify({ orgId: input.orgId, documentId: input.documentId, versionId: input.versionId });
    let last = await postOnce(token, body);
    if (last.status === 0 || last.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, DELIVERABLE_REFERENCE_RETRY_MS));
      last = await postOnce(token, body);
    }
    if (last.status === 0) {
      const err = "error" in last ? last.error : "unreachable";
      say(`The reviewed revision was published, but its drafting request's project register could not be reached to reference it (${err}) — a project manager can attach it from the project's Documents card.`);
      return { kind: "unreachable", error: err };
    }
    const answer: DeliverableReferenceAnswer = ("answer" in last && last.answer) ? last.answer : { ok: false, error: `HTTP ${last.status}` };
    if (answer.warning) say(answer.warning);
    else if (!answer.ok) say(`The reviewed revision was published, but it was not put on its drafting request's project register: ${answer.error ?? `HTTP ${last.status}`} — a project manager can attach it from the project's Documents card.`);
    return { kind: "answered", answer };
  } catch (e) {
    say(`The reviewed revision was published, but its drafting request's project reference could not be attempted (${(e as Error)?.message ?? String(e)}).`);
    return { kind: "unreachable", error: (e as Error)?.message ?? String(e) };
  }
}
