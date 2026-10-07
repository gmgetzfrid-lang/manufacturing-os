// lib/emailRender.ts
//
// THE render layer for notification email (notifications Round G, N6 —
// NEDGE-4, DELIV-5, NEDGE-10). Every email the system composes for a member
// leaves through one of these two functions:
//
//   renderNotificationEmail  an email the dispatcher sends (lib/notify/
//                            dispatch.ts) and the daily compliance digest
//                            (the maintenance cron):
//                            the message, its ABSOLUTE call to action, and
//                            the footer.
//   wrapEmailBody            a body a producer already composed (the two
//                            ticket routes' templates; the drain's backstop
//                            for a row nothing rendered — a row queued before
//                            this layer, or by a route outside it): the same
//                            mention rule and the same footer.
//
// The rules, each pinned by lib/__tests__/emailRender.test.ts:
//   * A link leaves the app, so it is absolute: an app-relative link ("/…")
//     is joined to the PUBLIC origin (lib/publicOrigin.ts), never sent as a
//     bare path a mail client cannot resolve (NEDGE-4 / DELIV-5). An already
//     absolute http(s) link is kept; anything else ("//host", a scheme that
//     is not http(s), a backslash) is dropped, never rendered.
//   * No origin, no email body (the XEDGE-5 lesson): the renderer THROWS
//     EmailOriginMissingError rather than defaulting to "" and mailing a
//     dead link. Callers catch it and say so; the email is still queued in
//     its pre-render form (a dropped notice is worse than one without a
//     button).
//   * Mention markup — @[Display Name](uuid) — renders as "@Display Name":
//     an internal user id never leaves the system (NEDGE-10 dw2).
//   * Every email carries a footer naming the workspace and linking the
//     member's notification settings (NEDGE-10 dw1); the drain adds the
//     one-click List-Unsubscribe header (app/api/notifications/send-queued).
//   * Every interpolation into HTML is escaped with the shared escaper
//     (lib/ticketTransitions.ts escapeHtml — report 08's "verified sound"
//     invariant, carried forward).
//
// Browser-safe: no node imports — queueEmail and the dispatcher run in the browser.

import { escapeHtml } from "@/lib/ticketTransitions";
import { publicOrigin } from "@/lib/publicOrigin";
import { tokenizeMentions } from "@/lib/notifications";

/** The renderer was asked for a body with no public origin to build its
 *  links on. Thrown, never defaulted (XEDGE-5). */
export class EmailOriginMissingError extends Error {
  constructor() {
    super("No public origin (NEXT_PUBLIC_SITE_URL) is configured, so an email link cannot be made absolute — the email is not rendered");
    this.name = "EmailOriginMissingError";
  }
}

/** The settings page a member changes their email preferences on. */
export const NOTIFICATION_SETTINGS_PATH = "/settings/notifications";

/** `origin` (or the deployment's public origin), trimmed, no trailing slash —
 *  or the error. Only an absolute http(s) origin is an origin. */
export function requireEmailOrigin(origin?: string | null): string {
  const o = (origin ?? publicOrigin() ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\\\s]+$/i.test(o)) throw new EmailOriginMissingError();
  return o;
}

/** A link fit for an email: an absolute http(s) URL kept as is; an
 *  app-relative path ("/requests/…", one leading slash) joined to `origin`;
 *  anything else (no link, "//host", "/\\host", another scheme, a bare word)
 *  → null, and the email carries no button rather than a dead or foreign one. */
export function absoluteEmailLink(link: string | null | undefined, origin: string): string | null {
  const l = (link ?? "").trim();
  if (!l || /[\s\\]/.test(l)) return null;
  if (/^https?:\/\//i.test(l)) return l;
  if (l.startsWith("/") && !l.startsWith("//")) return `${origin}${l}`;
  return null;
}

/** Mention markup as readable names: "@[Mike Leonard](3f2b…)" → "@Mike Leonard"
 *  (tokenizeMentions — the in-app renderer's own parser). */
export function plainMentions(text: string): string {
  if (!text) return text ?? "";
  return tokenizeMentions(text).map((t) => (t.kind === "mention" ? `@${t.name}` : t.value)).join("");
}

/** Plain text as HTML paragraphs: blank lines split paragraphs, single line
 *  breaks become <br>, every character escaped. */
export function textToHtml(text: string): string {
  return (text ?? "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function footerText(origin: string, orgName?: string | null): string {
  const who = orgName?.trim() ? `${orgName.trim()} sent this notification.` : "Your workspace sent this notification.";
  return `\n\n—\n${who} To change which emails you get, open ${origin}${NOTIFICATION_SETTINGS_PATH}`;
}

function footerHtml(origin: string, orgName?: string | null): string {
  const who = orgName?.trim() ? `${escapeHtml(orgName.trim())} sent this notification.` : "Your workspace sent this notification.";
  return `\n<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0 8px">\n<p style="font-size:12px;color:#64748b">${who} <a href="${escapeHtml(`${origin}${NOTIFICATION_SETTINGS_PATH}`)}">Change which emails you get</a></p>`;
}

export interface RenderedEmail {
  subject: string;
  bodyText: string;
  bodyHtml: string;
  /** The absolute call to action the body carries, or null (no link, or one
   *  that could not be made safe). */
  link: string | null;
}

/** An email the dispatcher sends, or the compliance digest: `body` (plain
 *  text; mention markup allowed), an optional call to action, the footer. Throws
 *  EmailOriginMissingError when there is no public origin. */
export function renderNotificationEmail(input: {
  subject: string;
  body: string;
  link?: string | null;
  linkLabel?: string;
  orgName?: string | null;
  /** Defaults to publicOrigin(). */
  origin?: string | null;
}): RenderedEmail {
  const origin = requireEmailOrigin(input.origin);
  const body = plainMentions(input.body ?? "");
  const action = absoluteEmailLink(input.link, origin);
  const label = input.linkLabel?.trim() || "Open in the app";
  const org = input.orgName?.trim() || null;
  const text = `${body}${action ? `\n\n${label}: ${action}` : ""}${footerText(origin, org)}`;
  const html =
    (org ? `<p style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">${escapeHtml(org)}</p>\n` : "") +
    textToHtml(body) +
    (action ? `\n<p><a href="${escapeHtml(action)}">${escapeHtml(label)}</a></p>` : "") +
    footerHtml(origin, org);
  return { subject: plainMentions(input.subject), bodyText: text, bodyHtml: html, link: action };
}

/** A body its producer already composed (text, and HTML or none): mention
 *  markup as names, and the footer. Its own links must already be absolute
 *  (the ticket routes build them on the public origin — EDGE-9). Throws
 *  EmailOriginMissingError when there is no public origin. */
export function wrapEmailBody(input: {
  text: string;
  html?: string | null;
  orgName?: string | null;
  origin?: string | null;
}): { bodyText: string; bodyHtml: string } {
  const origin = requireEmailOrigin(input.origin);
  const org = input.orgName?.trim() || null;
  const text = plainMentions(input.text ?? "");
  const html = input.html ? plainMentions(input.html) : textToHtml(text);
  return { bodyText: `${text}${footerText(origin, org)}`, bodyHtml: `${html}${footerHtml(origin, org)}` };
}

/** Every href in an HTML body — for the "no bare '/' link" checks. */
export function hrefsOf(html: string): string[] {
  return [...(html ?? "").matchAll(/href\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
}
