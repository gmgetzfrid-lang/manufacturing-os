// public-surfaces Round G, PS-P6 — where the full-screen viewer keeps the
// stamp images a person uploads (data URLs in localStorage, up to 12).
//
//   OFF-15  Per account: under manufacturingos.customStamps:<uid>, never one
//           device-wide list the next person on a shared tablet is offered.
//           CLIENT_STORAGE_INVENTORY (components/providers/RoleContext.tsx)
//           classes it "account", kind "identity", as the package brief
//           directs: the person's own work, kept across their sign-out and
//           an expiry, ended when a DIFFERENT identity next runs the app here
//           (noteIdentity's "all" purge), before that identity reads
//           anything. So a device keeps at most one identity's list, as it
//           kept one device-wide list before.
//           The device-wide list of before OFF-15 (whose it is is unknown)
//           goes, once, to the first identity that signs in here after this
//           code arrives — claimLegacyStampsAtSignIn, which noteIdentity runs
//           AFTER its purge (the legacy key is class "device", so no purge
//           drops it unread) — and the device is marked: the legacy key is
//           never read again. The moved list is that identity's list from
//           then on, so it ends at the next identity change: the one-time
//           transition IS-P1 recorded for OFF-8.
//
// Every function here never throws: storage can be missing, full or
// forbidden.

export type CustomStamp = { id: string; name: string; src: string };

/** The device-wide list of before OFF-15. Never written now (only put back
 *  when its move is refused). CLIENT_STORAGE_INVENTORY: class "device" — no
 *  purge takes it, so the first sign-in here since OFF-15 always finds it;
 *  once the device is marked it is never read, and what a tab still running
 *  the code of before writes to it is removed, unread, at the next sign-in. */
export const LEGACY_CUSTOM_STAMPS_KEY = "manufacturingos.customStamps";
/** Set once this device's one-time stamp transition has run (the legacy list
 *  moved, or found absent, at the first sign-in since OFF-15): after it the
 *  legacy key is never read again. Holds no stamp and no uid. */
export const LEGACY_CUSTOM_STAMPS_MOVED_KEY = "manufacturingos.customStamps.moved";
export const customStampsKey = (uid: string) => `manufacturingos.customStamps:${uid}`;

/** The stamps offered, with the uid they were read for. `legacyPending`: the
 *  legacy list is offered but the store refused its move — the person's
 *  first write that lands finishes it (the viewer's persistCustomStamps). */
export type StampShelf = { uid: string | null; stamps: CustomStamp[]; legacyPending: boolean };

export function parseCustomStamps(raw: string | null): CustomStamp[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as CustomStamp[]) : [];
  } catch { return []; }
}

/** Write `list` under the uid IN PLACE OF the legacy list — the move, at a
 *  sign-in (claimLegacyStampsAtSignIn), at a uid's first read
 *  (loadStampShelf) and, while it is pending, at that person's next write.
 *  1. The legacy key is removed FIRST: a dozen data-URL images can be most
 *     of the quota, so the writes below need the room the original holds.
 *  2. The device is marked BEFORE the list is written under the uid, so a
 *     move that lands has always marked the device: no later identity is
 *     offered the legacy key.
 *  3. The list is written under the uid.
 *  Refused at 2 or 3: the marker this call wrote is removed again and the
 *  legacy value put back exactly as it was; the move stays pending. */
export function moveLegacyStamps(uid: string, list: CustomStamp[]): boolean {
  let legacy: string | null = null;
  let marked = false;
  try {
    legacy = window.localStorage.getItem(LEGACY_CUSTOM_STAMPS_KEY);
    const wasMarked = window.localStorage.getItem(LEGACY_CUSTOM_STAMPS_MOVED_KEY) !== null;
    window.localStorage.removeItem(LEGACY_CUSTOM_STAMPS_KEY);
    if (!wasMarked) { window.localStorage.setItem(LEGACY_CUSTOM_STAMPS_MOVED_KEY, "1"); marked = true; }
    window.localStorage.setItem(customStampsKey(uid), JSON.stringify(list));
    return true;
  } catch {
    if (marked) { try { window.localStorage.removeItem(LEGACY_CUSTOM_STAMPS_MOVED_KEY); } catch { /* not expected where the write just landed */ } }
    if (legacy !== null) { try { window.localStorage.setItem(LEGACY_CUSTOM_STAMPS_KEY, legacy); } catch { /* the bytes it held a moment ago — not expected */ } }
    return false;
  }
}

/** OFF-15, the one-time transition: RoleContext's noteIdentity runs this for
 *  every identity it notes, AFTER its purge (the legacy key is class
 *  "device", so the purge for a different identity never drops it unread;
 *  the list this moves is the arriving identity's, so that purge must not
 *  follow it). On a device not yet marked, the legacy device-wide list goes
 *  to THIS identity — the first to sign in here since this code arrived —
 *  when it has no list of its own (moveLegacyStamps), and the device is
 *  marked either way, so no later identity is ever offered the legacy key.
 *  On a marked device the legacy key is removed unread: only a tab still
 *  running the code of before can have written it. A refused move leaves the
 *  list where it was and the device unmarked: the person's first viewer open
 *  offers it to them, pending (loadStampShelf). */
export function claimLegacyStampsAtSignIn(uid: string): void {
  if (!uid || typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(LEGACY_CUSTOM_STAMPS_MOVED_KEY) !== null) {
      window.localStorage.removeItem(LEGACY_CUSTOM_STAMPS_KEY);
      return;
    }
    const legacy = window.localStorage.getItem(LEGACY_CUSTOM_STAMPS_KEY);
    if (legacy !== null && window.localStorage.getItem(customStampsKey(uid)) === null) {
      moveLegacyStamps(uid, parseCustomStamps(legacy));
      return;
    }
    window.localStorage.setItem(LEGACY_CUSTOM_STAMPS_MOVED_KEY, "1");
  } catch { /* storage forbidden or full — the viewer's first read still applies the same rule */ }
}

/** The signed-in person's stamps. No uid (signed out): none. On a uid's
 *  first read — no list of its own yet, and the device not yet marked (the
 *  sign-in's move was refused, or never ran) — the legacy device-wide list
 *  is MOVED to it (moveLegacyStamps); a refused move leaves the legacy list
 *  where it was and offers it, pending, to this person only. */
export function loadStampShelf(uid: string | null): StampShelf {
  const none: StampShelf = { uid, stamps: [], legacyPending: false };
  if (!uid || typeof window === "undefined") return none;
  try {
    const own = window.localStorage.getItem(customStampsKey(uid));
    if (own !== null) return { uid, stamps: parseCustomStamps(own), legacyPending: false };
    if (window.localStorage.getItem(LEGACY_CUSTOM_STAMPS_MOVED_KEY) !== null) return none;
    const legacy = window.localStorage.getItem(LEGACY_CUSTOM_STAMPS_KEY);
    if (legacy === null) return none;
    const stamps = parseCustomStamps(legacy);
    return { uid, stamps, legacyPending: !moveLegacyStamps(uid, stamps) };
  } catch { return none; }
}

/** Write the person's list under their uid. False when the store refuses it
 *  (full or forbidden) — ignored by the viewer, as before OFF-15. */
export function writeStampList(uid: string, list: CustomStamp[]): boolean {
  try { window.localStorage.setItem(customStampsKey(uid), JSON.stringify(list)); return true; } catch { return false; }
}
