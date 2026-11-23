// An error on an admin screen, in plain words. A message the app wrote for
// people ("jane@x.com is already in this workspace under another account.
// Remove that one first.") is said as written; anything machine-made (a
// database or network message, a bare status) becomes what happened and
// what to do next (lib/friendlyError).

import { explainError } from "@/lib/friendlyError";

/** `said(err, "Couldn't remove Sam Lee.")` → "Couldn't remove Sam Lee. No
 *  connection to the server. Check your connection, then try again." */
export function said(e: unknown, lead?: string): string {
  const f = explainError(e);
  const generic = f.kind === "unknown" && f.message === "Something went wrong.";
  const body = f.kind === "unknown" && !generic ? f.message : `${f.message} ${f.next}`;
  if (!lead) return body;
  return generic ? `${lead} ${f.next}` : `${lead} ${body}`;
}

/** The error a fetch() answered with: the route's own words when it sent
 *  some ({ error: "…" }), else its status, so `said` can explain it. */
export async function responseError(res: Response, fallback = "It didn't go through."): Promise<Error & { status?: number }> {
  let words = "";
  try {
    const text = await res.text();
    try { const j = JSON.parse(text) as { error?: unknown; message?: unknown }; words = String(j.error ?? j.message ?? ""); }
    catch { words = text.length < 200 && !/<[a-z!]/i.test(text) ? text : ""; }
  } catch { /* no body */ }
  const err = new Error(words || fallback) as Error & { status?: number };
  // A status explains machine failures; the route's own sentence wins.
  if (!words) err.status = res.status;
  return err;
}
