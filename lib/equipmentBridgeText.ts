// lib/equipmentBridgeText.ts — the Bridge's refusal sentences a browser
// caller also reads (projects-tab SAF-21). lib/equipmentBridgeServer.ts runs
// on the server; lib/transitionIn.ts runs in the browser and tells a
// changed-meanwhile refusal of the Bridge's 'adopt' from any other.

/** A person's review or link matched no 'drawing' row — someone adopted or
 *  removed the link meanwhile. */
export const LINKS_CHANGED = "the link changed meanwhile (someone else linked or removed it) — nothing was changed. Reload and try again.";
