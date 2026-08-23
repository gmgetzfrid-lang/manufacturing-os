// lib/protectedGate.ts
//
// The protected layout's gating decision, extracted as a pure function so the
// contract is testable and impossible to drift from the provider's model.
//
// RoleContext resolves membership through a four-state machine
// (`MembershipState`), and its docblock states the rule: "never a silent
// downgrade to Viewer". The layout used to consume only three of the four
// states — `resolving` fell through to the full app shell while `activeRole`
// still sat at its placeholder, so any forced spinner-clear rendered a
// signed-in Admin as a Viewer (audit finding SESS-1). Routing every render
// through this function makes the fourth state unrepresentable as "app".

export type MembershipState = "resolving" | "member" | "none" | "error";

export type ProtectedView =
  /** Auth/boot still in progress — full-screen "Authenticating…" spinner. */
  | "authenticating"
  /** Signed in, membership lookup still in flight. Must NEVER render the app:
   *  role state is still the placeholder. Shows the honest still-loading
   *  screen (SESS-3), not a fake Viewer app. */
  | "resolving"
  /** Signed in, genuinely admitted nowhere — the hard-stop screen. */
  | "no-membership"
  /** The lookup itself failed after retries — the retry screen. */
  | "membership-error"
  /** Safe to render the application shell. */
  | "app";

export function resolveProtectedView(args: {
  loading: boolean;
  uid: string | null;
  membershipState: MembershipState;
  /** Has the boot sequence settled (getSession returned, or the boot
   *  timeout gave up on it)? Before that, a null uid means "not known yet",
   *  not "signed out" — the 6s loading watchdog can clear the spinner while
   *  getSession is still refreshing an expired token, and rendering the app
   *  then is the same placeholder render SESS-1 closed. */
  booted: boolean;
}): ProtectedView {
  const { loading, uid, membershipState, booted } = args;
  if (loading) return "authenticating";
  // Boot hasn't identified anyone yet — keep the honest spinner. The boot
  // timeout still guarantees this cannot hang forever: it flips `booted`.
  if (!booted && !uid) return "authenticating";
  // The SESS-1 branch: a signed-in user whose membership answer hasn't landed
  // yet is "still working it out", regardless of the loading watchdogs having
  // force-cleared the spinner. The watchdogs stay — they only decide which
  // waiting screen shows, never what role renders.
  if (uid && membershipState === "resolving") return "resolving";
  if (uid && membershipState === "none") return "no-membership";
  if (uid && membershipState === "error") return "membership-error";
  return "app";
}
