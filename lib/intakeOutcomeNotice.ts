// lib/intakeOutcomeNotice.ts — the contractor's notice of a decision
// (projects-tab SAF-9, projects Round G J12).
//
// The words of the email /api/intake/outcome-notice sends to the contact the
// org entered on an intake link, and the one call the Intake tab makes after
// it approves or rejects a submission (and, since projects Round G J14 —
// MON-10 — the Costs tab's after it awards or declines a quote that came
// through a quote link). The route reads the outcome from the
// database; this module only words it. No static import of the browser
// client: the route (server) imports the wording from here.

export type IntakeOutcome = "approved" | "rejected";
/** MON-10 (projects Round G J14): a quote's decision, as the portal shows it. */
export type QuoteOutcome = "awarded" | "declined";

/** How long the mail provider gets to answer the route before the send is
 *  abandoned (and recorded as failed, freeing the next attempt). */
export const OUTCOME_SEND_TIMEOUT_MS = 15_000;
/** A claim with no outcome row this old belongs to a function that died
 *  (the route's maxDuration is 30 s): the attempt is recorded as failed and
 *  the next one may go. */
export const OUTCOME_STALE_CLAIM_MS = 10 * 60_000;

export function intakeOutcomeEmail(input: {
  outcome: IntakeOutcome;
  company: string | null;
  projectName: string | null;
  document: string;
  revision: string | null;
  reason: string | null;
}): { subject: string; text: string } {
  const rev = input.revision ? ` Rev ${input.revision}` : "";
  const what = `${input.document}${rev}`;
  const project = input.projectName ? ` for ${input.projectName}` : "";
  const greeting = input.company ? `Hello ${input.company},` : "Hello,";
  if (input.outcome === "approved") {
    return {
      subject: `Accepted: ${what}${project}`,
      text: [
        greeting,
        "",
        `Your submission ${what}${project} was reviewed and accepted.`,
        "",
        "Its status is also shown on your submission portal (the link you were sent).",
      ].join("\n"),
    };
  }
  const reason = (input.reason ?? "").trim();
  return {
    subject: `Not accepted — resubmit: ${what}${project}`,
    text: [
      greeting,
      "",
      `Your submission ${what}${project} was reviewed and not accepted.`,
      "",
      reason ? `Reviewer's reason: ${reason}` : "The reviewer recorded no reason with this decision — ask your project contact what needs to change.",
      "",
      "Please correct it and resubmit through your submission portal (the link you were sent). The outcome and the reason are also shown there.",
    ].join("\n"),
  };
}

/** MON-10 (projects Round G J14): the words of a QUOTE's notice — selected
 *  or not, as the submission portal shows it (the resolve route: "the
 *  company sees whether their price was picked — not the numbers"). Never
 *  the price, the rivals or the internal decline reason. */
export function quoteOutcomeEmail(input: {
  outcome: QuoteOutcome;
  company: string | null;
  projectName: string | null;
  vendorName: string | null;
  rfqGroup: string | null;
}): { subject: string; text: string } {
  const scope = input.rfqGroup?.trim() ? ` for "${input.rfqGroup.trim()}"` : "";
  const project = input.projectName ? ` on ${input.projectName}` : "";
  const what = `your quote${scope}${project}`;
  const greeting = input.company ? `Hello ${input.company},` : "Hello,";
  if (input.outcome === "awarded") {
    return {
      subject: `Selected: ${input.rfqGroup?.trim() ? `${input.rfqGroup.trim()} — ` : ""}${input.projectName ?? "your quote"}`,
      text: [
        greeting,
        "",
        `Thank you — ${what} was selected.`,
        "",
        "Your project contact will follow up with the next steps. The outcome is also shown on your submission portal (the link you were sent).",
      ].join("\n"),
    };
  }
  return {
    subject: `Not selected: ${input.rfqGroup?.trim() ? `${input.rfqGroup.trim()} — ` : ""}${input.projectName ?? "your quote"}`,
    text: [
      greeting,
      "",
      `Thank you for ${what}. It was not selected this time.`,
      "",
      "The outcome is also shown on your submission portal (the link you were sent).",
    ].join("\n"),
  };
}

/** The Intake tab's call after a decision lands: asks the server to email
 *  the link's contact. Best effort — the portal shows the outcome whatever
 *  happens here — and the answer says what happened (sent, no contact on
 *  the link, already told, email not configured, refused). */
export async function notifyIntakeOutcome(orgId: string, versionId: string): Promise<
  { sent: true } | { sent: false; reason: string }
> {
  try {
    const { supabase } = await import("@/lib/supabase");
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return { sent: false, reason: "not_signed_in" };
    const res = await fetch("/api/intake/outcome-notice", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ orgId, versionId }),
    });
    const body = (await res.json().catch(() => null)) as { sent?: boolean; reason?: string; error?: string } | null;
    if (body?.sent) return { sent: true };
    return { sent: false, reason: body?.reason ?? body?.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { sent: false, reason: (e as Error)?.message ?? "network" };
  }
}

/** MON-10 (projects Round G J14): the Costs tab's call after a quote is
 *  awarded or declined — the same route and the same answers as
 *  `notifyIntakeOutcome`, naming the quote instead of a version. */
export async function notifyQuoteOutcome(orgId: string, costDocumentId: string): Promise<
  { sent: true } | { sent: false; reason: string }
> {
  try {
    const { supabase } = await import("@/lib/supabase");
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return { sent: false, reason: "not_signed_in" };
    const res = await fetch("/api/intake/outcome-notice", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ orgId, costDocumentId }),
    });
    const body = (await res.json().catch(() => null)) as { sent?: boolean; reason?: string; error?: string } | null;
    if (body?.sent) return { sent: true };
    return { sent: false, reason: body?.reason ?? body?.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { sent: false, reason: (e as Error)?.message ?? "network" };
  }
}
