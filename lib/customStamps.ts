// public-surfaces Round G, PS-P6 — where the full-screen viewer keeps the
// stamp images a person uploads (data URLs in localStorage, up to 12).
//
//   OFF-15  Per account: under manufacturingos.customStamps:<uid>, never one
//           device-wide list the next person on a shared tablet is offered.
//           CLIENT_STORAGE_INVENTORY (components/providers/RoleContext.tsx)
//           classes it "uid-scoped": never offered to another identity, and
//           kept across the person's own sign-out and across another
//           person's run of the app here, as their stamps were before.
//           The device-wide list of before OFF-15 (whose it is is unknown)
//           goes, once, to the first identity that signs in here after this
//           code arrives — claimLegacyStampsAtSignIn, which RoleContext's
//           noteIdentity runs BEFORE any purge, so a different identity's
//           arrival never drops it unread — and the device is then marked:
//           the legacy key is never read again.
//   OFF-16  A per-device bound: once a SECOND account keeps a list here, an
//           upload that would take every account's lists together past
//           DEVICE_STAMP_BUDGET is refused (the viewer says so), so the lists
//           of many people on a shared tablet cannot fill the browser's quota
//           and starve the app's other keys (the session, the layout).
//
// Every function here never throws: storage can be missing, full or
// forbidden.

export type CustomStamp = { id: string; name: string; src: string };

/** The device-wide list of before OFF-15. Never written now (only put back
 *  when its move is refused). CLIENT_STORAGE_INVENTORY: class "account",
 *  kind "identity" — kept across a sign-out; what is left in it once the
 *  device is marked (only a tab still running the code of before can write
 *  it) is never read, and ends when a different identity runs the app. */
export const LEGACY_CUSTOM_STAMPS_KEY = "manufacturingos.customStamps";
/** Set once this device's one-time stamp transition has run (the legacy list
 *  moved, or found absent, at the first sign-in since OFF-15): after it the
 *  legacy key is never read again. Holds no stamp and no uid. */
export const LEGACY_CUSTOM_STAMPS_MOVED_KEY = "manufacturingos.customStamps.moved";
const CUSTOM_STAMPS_PREFIX = "manufacturingos.customStamps:";
export const customStampsKey = (uid: string) => `manufacturingos.customStamps:${uid}`;

/** OFF-16: the room, in the UTF-16 code units a browser counts against its
 *  ~5,000,000-unit localStorage quota (a key and its value), that every
 *  account's stamp lists on this device may take together once more than one
 *  account keeps a list here — well over a dozen typical stamp images, and it
 *  leaves most of the quota to the app's other keys. */
export const DEVICE_STAMP_BUDGET = 1_500_000;

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
 *  The legacy key is removed FIRST (a dozen data-URL images can be most of
 *  the quota, so the write needs the room the original holds), then `list`
 *  is written under the uid. Landed: the device is marked, so the legacy key
 *  is never read again. Refused: the legacy value is put back exactly as it
 *  was, and the move stays pending. */
export function moveLegacyStamps(uid: string, list: CustomStamp[]): boolean {
  let legacy: string | null = null;
  try {
    legacy = window.localStorage.getItem(LEGACY_CUSTOM_STAMPS_KEY);
    window.localStorage.removeItem(LEGACY_CUSTOM_STAMPS_KEY);
    window.localStorage.setItem(customStampsKey(uid), JSON.stringify(list));
  } catch {
    if (legacy !== null) { try { window.localStorage.setItem(LEGACY_CUSTOM_STAMPS_KEY, legacy); } catch { /* the bytes it held a moment ago — not expected */ } }
    return false;
  }
  try { window.localStorage.setItem(LEGACY_CUSTOM_STAMPS_MOVED_KEY, "1"); } catch { /* full — the legacy key is gone all the same */ }
  return true;
}

/** OFF-15, the one-time transition: RoleContext's noteIdentity runs this for
 *  every identity it notes, BEFORE any purge. On a device not yet marked, the
 *  legacy device-wide list goes to THIS identity — the first to sign in here
 *  since this code arrived — when it has no list of its own (moveLegacyStamps),
 *  and the device is marked either way, so no later identity is ever offered
 *  the legacy key, and a different identity's arrival never drops it unread.
 *  A refused move leaves the list where it was and the device unmarked: the
 *  person's first viewer open offers it to them, pending (loadStampShelf). */
export function claimLegacyStampsAtSignIn(uid: string): void {
  if (!uid || typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(LEGACY_CUSTOM_STAMPS_MOVED_KEY) !== null) return;
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

/** OFF-16: would writing `next` as this person's list — an upload — take
 *  every account's stamp lists on this device past DEVICE_STAMP_BUDGET?
 *  - Only while ANOTHER account keeps a list here: one account's list alone
 *    is bounded by the store only, as the one device-wide list was before
 *    OFF-15 (a person on their own device is never refused by this).
 *  - A write that does not grow the person's list (a removal, or the 13th
 *    upload that drops a larger oldest one) is never refused: it frees room.
 *  So the device's stamp lists together never take more than the budget, or
 *  the one list a single account built here alone (no more than the one
 *  device-wide list could take before OFF-15). The legacy list is not
 *  counted: it never grows, and its move replaces it. */
export function stampUploadOverDeviceBudget(uid: string, next: CustomStamp[]): boolean {
  if (!uid || typeof window === "undefined") return false;
  try {
    const own = customStampsKey(uid);
    let others = 0;
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k !== own && k.startsWith(CUSTOM_STAMPS_PREFIX)) others += k.length + (window.localStorage.getItem(k)?.length ?? 0);
    }
    if (others === 0) return false;
    const stored = window.localStorage.getItem(own);
    const current = stored === null ? 0 : own.length + stored.length;
    const after = own.length + JSON.stringify(next).length;
    return after > current && others + after > DEVICE_STAMP_BUDGET;
  } catch { return false; }
}
