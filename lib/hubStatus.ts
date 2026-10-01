// lib/hubStatus.ts — pure rules behind the Intelligence Overview's status
// board (app/(protected)/intelligence/page.tsx). Kept out of the page so the
// tests can hold each card to what it claims (intelligence Round G, I-05).
//
//   HUB-10  the instant-paint snapshot is keyed by user AND org, carries the
//           uid it was written under, and is discarded on a mismatch — one
//           person's per-user AI status is never painted for the next
//   HUB-7   a source that failed is a stated "couldn't check" state, never a
//           permanent shimmer, and a failure is never persisted as known
//   HUB-9   the Meaning-index card is green only above a coverage threshold,
//           and reads "not built" — not green — when nothing is indexed
//   HUB-5   a fix CTA lands on the control that fixes it, or the card says
//           who can fix it instead of offering a button that dead-ends
//   HUB-3   a workspace missing its first setup steps is pointed at Facility
//           setup from the front door — from counts that were actually read
//           (a failed count is never "not started", HUB-7's rule)
//   I-02    knowledge_questions is readable by the asker and controllers
//           (20261120), so the hub's list is "your" questions for a member

/** Below this share of embedded passages the meaning index is not "on". */
export const MEANING_INDEX_OK_PCT = 95;

export const hubSnapshotKey = (uid: string, orgId: string) => `intel-status-${uid}-${orgId}`;
export const hubGapsKey = (uid: string, orgId: string) => `schema-gaps-${uid}-${orgId}`;
/** The org-only keys used before HUB-10 — removed on sight, never read. */
export const legacyHubKeys = (orgId: string) => [`intel-status-${orgId}`, `schema-gaps-${orgId}`];

/** Serialize a snapshot for localStorage: the data plus the uid it belongs
 *  to. Failure flags are never persisted — a failure is not "last known". */
export function writeHubSnapshot<T extends object>(uid: string, status: T): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(status)) if (!k.endsWith("Failed")) clean[k] = v;
  return JSON.stringify({ uid, status: clean });
}

/** Read a snapshot back — only when it was written for THIS uid. Anything
 *  else (another account's, an older org-only shape, junk) reads as none. */
export function readHubSnapshot<T>(raw: string | null | undefined, uid: string): T | null {
  if (!raw || !uid) return null;
  try {
    const parsed = JSON.parse(raw) as { uid?: unknown; status?: unknown };
    if (!parsed || parsed.uid !== uid || !parsed.status || typeof parsed.status !== "object") return null;
    return parsed.status as T;
  } catch {
    return null;
  }
}

export interface CardView {
  ok: boolean;
  text: string;
}

/** HUB-9: the Meaning-index card. */
export function meaningIndexCard(chunksTotal: number, chunksEmbedded: number): CardView & { pct: number } {
  if (chunksTotal <= 0) return { ok: false, pct: 0, text: "Not built — nothing has been indexed yet" };
  const pct = Math.floor((Math.max(0, chunksEmbedded) / chunksTotal) * 100);
  if (pct >= MEANING_INDEX_OK_PCT) return { ok: true, pct, text: `${pct}% of passages embedded` };
  if (chunksEmbedded <= 0) return { ok: false, pct, text: "Index not built yet — meaning-based search is off" };
  return { ok: false, pct, text: `Only ${pct}% of passages embedded — meaning-based search misses the rest` };
}

export interface FixView {
  /** Where the fix lives — absent when the viewer cannot perform it. */
  href?: string;
  cta?: string;
  /** Who can fix it, said instead of a dead-end button. */
  whoCan?: string;
}

/** HUB-5: "Nothing indexed" → create the first library, or upload into one. */
export function knowledgeFix(input: { isController: boolean; libraries: number; firstLibraryId: string | null }): FixView {
  if (!input.isController) return { whoCan: "Admin or Doc Control adds documents to a knowledge library." };
  if (input.libraries <= 0 || !input.firstLibraryId) return { href: "/knowledge?create=1", cta: "Create a library" };
  return { href: `/knowledge/${input.firstLibraryId}`, cta: "Upload documents" };
}

/** HUB-5: "Index not built" → the library page, where Build index lives. */
export function meaningIndexFix(input: { isController: boolean; chunksTotal: number; libraries: number; firstLibraryId: string | null }): FixView {
  if (input.chunksTotal <= 0) return knowledgeFix(input);
  if (!input.isController) return { whoCan: "Admin or Doc Control builds the meaning index from a library's page." };
  if (!input.firstLibraryId) return { href: "/knowledge", cta: "Open a library" };
  return { href: `/knowledge/${input.firstLibraryId}`, cta: "Build index" };
}

/** The recent-questions panel says whose questions it shows: knowledge_questions
 *  returns a member's own rows and a controller's whole org (20261120). */
export function recentQuestionsCopy(isController: boolean): { title: string; empty: string } {
  return isController
    ? { title: "Recent questions — everyone", empty: "Nobody has asked anything yet." }
    : { title: "Your recent questions", empty: "You haven't asked anything yet." };
}

/** HUB-3: the first Facility setup stage a workspace has not started, in the
 *  navigator's own order (codebook → registry → … → knowledge), or null. */
export function firstSetupStep(counts: { codebookEntries: number; assets: number; libraries: number }):
  { stage: string; why: string } | null {
  if (counts.codebookEntries <= 0) return { stage: "Site codebook", why: "your numbering language — units, equipment prefixes, drawing types — so everything after it decodes" };
  if (counts.assets <= 0) return { stage: "Equipment registry", why: "the equipment the drawings and answers point at" };
  if (counts.libraries <= 0) return { stage: "Knowledge", why: "a library of documents for the AI to read" };
  return null;
}

/** A head-count read as supabase-js resolves it. */
export interface CountRead {
  count?: number | null;
  error?: { code?: string | null; message: string } | null;
}

/** A table that is not there yet (raw Postgres 42P01, or PostgREST's schema
 *  cache PGRST205) — a setup step genuinely not started. */
const tableMissing = (e: { code?: string | null; message: string }) =>
  e.code === "42P01" || e.code === "PGRST205" || /relation "[^"]+" does not exist/i.test(e.message ?? "");

/** HUB-3 / HUB-7: the patch the "Start here — Facility setup" card reads from
 *  the codebook and registry counts. Each count comes only from a read that
 *  succeeded (a missing table is 0 — not started, which is what it is). Any
 *  other error is `setupFailed` — never persisted (writeHubSnapshot drops
 *  *Failed) — and `setupKnown` is left alone, so a timeout on one table
 *  never paints, or saves as last-known, a false "Next step: Site codebook". */
export function setupCountsPatch(codebook: CountRead, assets: CountRead): {
  codebookEntries?: number; assets?: number; setupKnown?: true; setupFailed?: string;
} {
  const out: { codebookEntries?: number; assets?: number; setupKnown?: true; setupFailed?: string } = {};
  const failed: string[] = [];
  const read = (r: CountRead, label: string): number | undefined => {
    if (!r.error) return r.count ?? 0;
    if (tableMissing(r.error)) return 0;
    failed.push(`${label}: ${r.error.message}`);
    return undefined;
  };
  const cb = read(codebook, "codebook");
  const as = read(assets, "equipment registry");
  if (cb !== undefined) out.codebookEntries = cb;
  if (as !== undefined) out.assets = as;
  if (failed.length > 0) out.setupFailed = failed.join("; ");
  else out.setupKnown = true;
  return out;
}
