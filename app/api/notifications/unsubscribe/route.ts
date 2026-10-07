// /api/notifications/unsubscribe — the one-click opt-out a member email names
// in its List-Unsubscribe header (notifications Round G, N6 —
// NEDGE-10 done-when 1 and 3; RFC 8058).
//
//   GET  ?u=<uid>&t=<token>  → a page that says what the button does and
//                              offers it. Changes nothing: mail scanners and
//                              link previews fetch GET.
//   POST ?u=<uid>&t=<token>  → turns that member's email off
//                              (notification_preferences.email_enabled =
//                              false, the master switch) — the mail client's
//                              one-click POST ("List-Unsubscribe=One-Click"),
//                              or the page's button.
//
// The token is an HMAC of the uid and the address the link was mailed to
// (lib/unsubscribeToken.ts). This route re-reads the uid's own profile
// address (public.users.email) and re-derives the token from it, so a link
// minted for any other address — a forged queue row naming the victim's uid
// with the forger's address — turns nothing off (N6 fix pass). The write is
// an upsert on the member's own row: a member who never saved preferences
// gets a row with every other column at its default (the CHECK accepts them —
// NEDGE-2's fix is what makes this row savable). A drawing recall and a PSM
// alert still pass the switch (DEC-74 §9), and the transmittal route's
// notices to an issuer do not read it yet (notifications N9); the page names
// both.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { verifyUnsubscribe } from "@/lib/unsubscribeToken";
import { escapeHtml } from "@/lib/ticketTransitions";

export const runtime = "nodejs";

const page = (title: string, body: string, status = 200) =>
  new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#0f172a">` +
    `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1>${body}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );

const SAFETY_NOTE =
  "<p style=\"color:#475569\">Some email still arrives whatever this setting says: drawing recalls and safety alerts, " +
  "and the notices a transmittal sends the person who issued it (a recipient's acknowledgment, and a PDF that could " +
  "not be stamped or was refused). " +
  "You can turn email back on, or choose which emails you get, on your <a href=\"/settings/notifications\">notification settings page</a>.</p>";

const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The link's member, when its token is theirs for the address they hold
 *  now; "invalid" for any other link; "unchecked" when their address could
 *  not be read (nothing is changed either way). */
async function credentials(req: NextRequest): Promise<{ uid: string; token: string } | "invalid" | "unchecked"> {
  const uid = req.nextUrl.searchParams.get("u") ?? "";
  const token = req.nextUrl.searchParams.get("t") ?? "";
  if (!UID_RE.test(uid) || !token) return "invalid";
  const { data, error } = await supabaseAdmin.from("users").select("email").eq("id", uid).maybeSingle();
  if (error) {
    console.error("[unsubscribe] the member's address could not be read", error.message);
    return "unchecked";
  }
  const address = ((data as { email?: string | null } | null)?.email ?? null);
  return verifyUnsubscribe(uid, address, token) ? { uid, token } : "invalid";
}

const UNCHECKED = "<p>The link could not be checked just now, so your email settings were not changed. Please try it again in a moment.</p>";

export async function GET(req: NextRequest) {
  const c = await credentials(req);
  if (c === "unchecked") return page("That did not work", UNCHECKED, 500);
  if (c === "invalid") return page("This link is not valid", "<p>It may have been copied incompletely, or your email address has changed since it was sent. Your email settings were not changed.</p>", 400);
  const action = `/api/notifications/unsubscribe?u=${encodeURIComponent(c.uid)}&t=${encodeURIComponent(c.token)}`;
  return page(
    "Turn off notification email?",
    `<p>This turns off the notification emails sent to you from this app.</p>${SAFETY_NOTE}` +
    `<form method="post" action="${escapeHtml(action)}"><button type="submit" style="padding:.5rem 1rem;font-weight:600">Turn off notification email</button></form>`,
  );
}

export async function POST(req: NextRequest) {
  const c = await credentials(req);
  const fromPage = (req.headers.get("accept") ?? "").includes("text/html");
  if (c === "unchecked") {
    return fromPage
      ? page("That did not work", UNCHECKED, 500)
      : NextResponse.json({ error: "the link could not be checked; nothing was changed" }, { status: 500 });
  }
  if (c === "invalid") {
    return fromPage
      ? page("This link is not valid", "<p>Your email settings were not changed.</p>", 400)
      : NextResponse.json({ error: "invalid unsubscribe link" }, { status: 400 });
  }
  const { error } = await supabaseAdmin
    .from("notification_preferences")
    .upsert({ user_id: c.uid, email_enabled: false, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) {
    console.error("[unsubscribe] the opt-out could not be saved", error.message);
    return fromPage
      ? page("That did not work", "<p>Your email settings could not be saved just now. Please try the link again in a moment.</p>", 500)
      : NextResponse.json({ error: "the opt-out could not be saved" }, { status: 500 });
  }
  return fromPage
    ? page("Notification email is off", `<p>The notification emails this setting controls will no longer be sent to you.</p>${SAFETY_NOTE}`)
    : NextResponse.json({ ok: true });
}
