// lib/assetSignIn.ts
//
// public-surfaces PHYS-7 / document-control HLD-13 (option (b)) — the
// equipment label's /assets/<tag> page is a STAFF page, and a scan with no
// session is sent to sign-in carrying the tag. This module holds the two
// rules that redirect depends on, pure, so they are unit-tested rather than
// read off the page's JSX:
//
//   * where the scan goes — the sign-in page with the tag in `next`;
//   * WHEN it goes — only on a DEFINITIVE no-session answer. RoleContext's
//     `booted` also turns true when its 8 s boot watchdog gives up while
//     getSession is still refreshing a token on a slow plant network; a
//     redirect on that signal ejected signed-in staff (and the sign-in page
//     then sent them to the dashboard, the tag lost). So the page asks
//     getSession itself: it redirects only when the answer RESOLVES with no
//     session and no error. A pending answer does nothing (the page keeps its
//     spinner); an ERRORED one (a refresh that failed on the network) is
//     "unknown" — the page offers the sign-in link but does not navigate away,
//     so a session that recovers a moment later still lands on the tag; an
//     answer that arrives after the effect was cleaned up does nothing.

/** The sign-in URL a no-session scan of an equipment label is sent to. */
export function assetSignInHref(tag: string): string {
  return `/?next=${encodeURIComponent(`/assets/${encodeURIComponent(tag)}`)}`;
}

/** "none" — getSession resolved with no session and no error (signed out);
 *  "unknown" — it errored, so whether anyone is signed in is not known. */
export type NoSessionAnswer = "none" | "unknown";

type SessionAnswer = { data: { session: unknown } | null; error?: unknown };

/** Ask for the session and report a missing one: `onAnswer("none")` only for
 *  a definitive no-session answer, `onAnswer("unknown")` for an errored read,
 *  nothing at all while pending or when a session exists. Returns a cancel
 *  function for the effect's cleanup — after it runs, a late answer is
 *  ignored. */
export function watchForNoSession(
  getSession: () => Promise<SessionAnswer>,
  onAnswer: (answer: NoSessionAnswer) => void,
): () => void {
  let cancelled = false;
  void getSession().then(
    (answer) => {
      if (cancelled || answer?.data?.session != null) return;
      onAnswer(answer?.error || !answer?.data ? "unknown" : "none");
    },
    () => { if (!cancelled) onAnswer("unknown"); },
  );
  return () => { cancelled = true; };
}
