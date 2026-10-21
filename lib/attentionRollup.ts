// lib/attentionRollup.ts
//
// The badge trail below the sidebar (notifications Round G, N11 TRAIL —
// TRAIL-1, TRAIL-6, TRAIL-11, TAX-10; GAP-202 step 3).
//
// The sidebar's Documents and Projects badges count the attention feed's
// notification rows by section (hooks/useTicketNotifications.ts). This file
// carries the same rows one level further down: to the library card, to the
// folders on the path to the document, to the document row and to the
// project card — so a "3" on Documents can be followed to the thing.
//
// SOURCE OF TRUTH: notification-derived — the same rows, the same section
// rule (KIND_META via sectionForKind) and the same action rule (isActionRow)
// as the sidebar badge, so a marker and the badge never disagree about what
// counts. A marker clears when its rows are read (visiting the document marks
// them read — lib/notificationTrail.ts, TRAIL-4) or retired by the reconcile
// pass. The register-state alternative (lib/docControlRegister.ts — a pill
// per document derived from obligations, as the requests queue derives its
// dots from ticket state) is the recorded future path for per-document
// compliance pills; it is not this.
//
// WHERE A DOCUMENT IS: never guessed (no link parsing, no metadata trust —
// GAP-202 "Never guess"; a browser-written row's metadata is the writer's
// word). Each document a row names is resolved ONCE per feed pass, in one
// batched read under the VIEWER's own client — documents' RESTRICTIVE
// node_visible SELECT policy is the ACL the library list itself reads under,
// so a document the viewer cannot read returns no row and is counted in no
// folder and no library (the permission trap, GAP-202). Its folder chain is
// the container-chain resolver's (lib/containerChain.ts folderChainFromMap,
// DEC-36): the folder, then collections.path_ids nearest first — never a
// third walk. A read that fails, or ids past the per-pass cap, leave the
// roll-up UNKNOWN — rendered as unknown, never as zero (GAP-202 acceptance 6).
// A missing row is not a failure: that document is simply not counted
// (containerChain's rule — "it defines nothing we can see"). Nor is an id
// that cannot name a document (resource_id is TEXT; documents.id is uuid):
// it is placed nowhere and never sent, so one legacy or browser-written
// row cannot fail the whole chunk's read (22P02) and turn the roll-up
// unknown (fix pass).
//
// NEVER IN THE COUNTS' WAY (second fix pass): the placement reads run
// AFTER the feed pass has applied its rows, counts and loading state — the
// sidebar badge and the bell never wait for them — in parallel chunks under
// one deadline (PLACE_TIMEOUT_MS). A read that times out or fails leaves its
// level UNKNOWN, never zero; a document whose placement is still on its way
// leaves the level `idle` (not read yet — no "all clear" claimed, no flash
// of the unknown line on every new row), and the provider drops a placement
// result older than the one it already holds.
//
// UNKNOWN IS SAID ONCE: a list surface draws a container's count, or
// nothing (listMarkFor); while the roll-up is incomplete the page says so
// in one line (AttentionUnknownNote, components/documents/AttentionDot.tsx)
// instead of a "?" on every library card and folder — GAP-202 "Do not":
// a mark on every row is wallpaper (fix pass).

import { folderChainFromMap } from "@/lib/containerChain";

/** What a marker shows for one container or row: how many feed rows land
 *  there, and how many of those ask for an action (red) — the sidebar
 *  badge's two numbers (SectionCount), one level down. */
export interface AttentionMark { total: number; action: number }

/** Whether the per-container counts are complete. `idle` — nothing to place
 *  (or not read yet); `ready` — every row was placed (or proven not
 *  visible); `unknown` — some row could not be placed (a read failed, or
 *  more documents than one pass resolves), so a container without a count
 *  may still hold one. */
export type RollupState = "idle" | "ready" | "unknown";

/** Where one document lives, as the viewer's own read answered: its library,
 *  and its folder chain nearest first (empty at the library root, or when
 *  the folder is not visible). */
export interface DocPlacement { libraryId: string; folderIds: string[] }

/** The roll-up the provider exposes alongside sectionCounts. */
export interface AttentionRollup {
  /** Library cards — documents placed by the viewer's read, plus rows about
   *  the library itself. */
  byLibrary: ReadonlyMap<string, AttentionMark>;
  /** Folders — a document's rows fanned up its folder chain, so every folder
   *  on the path to it carries the count (TRAIL-6 dw3). */
  byFolder: ReadonlyMap<string, AttentionMark>;
  /** Document rows — by the row's own resource id. A row shows only on a
   *  page that lists the document, which the viewer can already see. */
  byDocument: ReadonlyMap<string, AttentionMark>;
  /** Project cards — rows about the project itself. */
  byProject: ReadonlyMap<string, AttentionMark>;
  /** Completeness of byLibrary (documents placed in libraries). */
  libraries: RollupState;
  /** Completeness of byFolder (the folder chains). */
  folders: RollupState;
}

export const EMPTY_ROLLUP: AttentionRollup = Object.freeze({
  byLibrary: new Map(),
  byFolder: new Map(),
  byDocument: new Map(),
  byProject: new Map(),
  libraries: "idle",
  folders: "idle",
}) as AttentionRollup;

/** One feed row, as the roll-up reads it: its section (sectionForKind), its
 *  action flag (isActionRow) and the resource it names. */
export interface RollupRow {
  section: string | null;
  actionRequired: boolean;
  resourceType: string | null;
  resourceId: string | null;
}

/** The placements the provider resolved, and how complete they are. */
export interface Placements {
  /** Document id → where it lives. An id the read did not return (not
   *  visible, deleted) is absent: counted in no container. */
  docs: ReadonlyMap<string, DocPlacement>;
  /** The ids these placements answer for (asked, whether or not a row came
   *  back). A document row whose id is not here was not asked yet — its
   *  placement is on its way (second fix pass). Absent: every id was asked
   *  (a placements value built by hand). */
  asked?: ReadonlySet<string>;
  /** Every id in `docs` was asked and answered (no failed read, no cap). */
  libraries: RollupState;
  /** Every placed document's folder chain was read. */
  folders: RollupState;
}

export const NO_PLACEMENTS: Placements = Object.freeze({
  docs: new Map(),
  asked: new Set<string>(),
  libraries: "idle",
  folders: "idle",
}) as Placements;

const bump = (m: Map<string, AttentionMark>, key: string, action: boolean) => {
  const cur = m.get(key) ?? { total: 0, action: 0 };
  m.set(key, { total: cur.total + 1, action: cur.action + (action ? 1 : 0) });
};

/** The document ids a feed's rows name that a roll-up needs placed:
 *  document-scoped rows the Documents badge counts. Distinct, in feed order. */
export function documentIdsToPlace(rows: readonly RollupRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.section !== "documents" || r.resourceType !== "document" || !r.resourceId) continue;
    if (seen.has(r.resourceId)) continue;
    seen.add(r.resourceId);
    out.push(r.resourceId);
  }
  return out;
}

/** Build the roll-up from the feed's rows and the placements. Pure.
 *  Only rows the sidebar badge counts are rolled up (section documents /
 *  projects), so no marker counts what the badge does not. */
export function buildAttentionRollup(rows: readonly RollupRow[], placements: Placements): AttentionRollup {
  const byLibrary = new Map<string, AttentionMark>();
  const byFolder = new Map<string, AttentionMark>();
  const byDocument = new Map<string, AttentionMark>();
  const byProject = new Map<string, AttentionMark>();
  let anyDocument = false;
  // A document row whose placement was not asked yet (the provider applies a
  // pass's rows first and its placements after — second fix pass): the
  // containers may be short of it for that moment, so the level is `idle`
  // (not read yet), never `ready`. An id that cannot name a document is
  // never asked and never pending.
  let pending = false;
  for (const r of rows) {
    if (!r.resourceId) continue;
    if (r.section === "documents") {
      if (r.resourceType === "document") {
        anyDocument = true;
        bump(byDocument, r.resourceId, r.actionRequired);
        const at = placements.docs.get(r.resourceId);
        if (!at) {
          if (placements.asked && !placements.asked.has(r.resourceId) && canNameDocument(r.resourceId)) pending = true;
          continue;
        }
        bump(byLibrary, at.libraryId, r.actionRequired);
        for (const f of at.folderIds) bump(byFolder, f, r.actionRequired);
      } else if (r.resourceType === "library") {
        bump(byLibrary, r.resourceId, r.actionRequired);
      }
    } else if (r.section === "projects" && r.resourceType === "project") {
      bump(byProject, r.resourceId, r.actionRequired);
    }
  }
  // Nothing to place is not "unknown": with no document row there is
  // nothing a container could be missing.
  // A placement still on its way is `idle` unless the level is already
  // known to be incomplete (`unknown` wins).
  const level = (st: RollupState): RollupState => (!anyDocument ? "ready" : st === "unknown" ? "unknown" : pending ? "idle" : st);
  return { byLibrary, byFolder, byDocument, byProject, libraries: level(placements.libraries), folders: level(placements.folders) };
}

/** Per-pass bound on the documents resolved, and the chunk size of each
 *  `.in()` read (a URL stays well under PostgREST's limits). Past the cap
 *  the roll-up is UNKNOWN, never short. The feed's fetch fan-out stays
 *  bounded: at most ceil(cap / chunk) document reads and as many folder
 *  reads per pass, however many rows the feed holds. */
export const PLACE_CAP = 500;
export const PLACE_CHUNK = 100;

/** The one deadline for a pass's placement reads (second fix pass): the
 *  chunks run in parallel, and whatever has not answered by then is
 *  aborted and leaves its level UNKNOWN — a hung read never holds the
 *  roll-up, and never anything else (the provider applies the feed's rows
 *  and counts before it starts these reads). */
export const PLACE_TIMEOUT_MS = 8_000;

/** Ask a Supabase query builder to abort with `signal` when it can
 *  (`.abortSignal`); a builder without it (a test double) is returned as is
 *  — the deadline still holds, because resolvePlacements races every read
 *  against it. */
export function withAbortSignal<Q>(query: Q, signal: AbortSignal): Q {
  const f = (query as { abortSignal?: (s: AbortSignal) => Q } | null)?.abortSignal;
  return typeof f === "function" ? f.call(query, signal) : query;
}

/** documents.id is a uuid; notifications.resource_id is TEXT. An id of any
 *  other shape names no document (a legacy row, a browser-written row). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const canNameDocument = (id: string): boolean => UUID_RE.test(id);

type ReadResult = { data: unknown; error: { message?: string } | null };

/** Documents the caller already read under the same client and filters
 *  (`{ id, library_id, collection_id }` rows for `ids`) — used as answered
 *  and never read again. */
export interface KnownDocuments { ids: readonly string[]; rows: unknown }

const TIMED_OUT: unique symbol = Symbol("placement read timed out");

/**
 * Resolve where each document lives, through the viewer's own reads:
 * `readDocs(ids, signal)` returns `{ id, library_id, collection_id }` rows
 * for the ids the viewer can read (RLS); `readFolders(ids, signal)` returns
 * `{ id, path_ids }` for the folders. Each chunk is one read, the chunks of a
 * level run in parallel, and every read races ONE deadline (`timeoutMs`,
 * PLACE_TIMEOUT_MS) whose signal aborts what is still running; a read that
 * fails, throws or misses the deadline leaves its level UNKNOWN (the others
 * still count). An id that cannot name a document (not uuid-shaped) is
 * placed nowhere and never sent — it is not a failed read. `known` documents
 * are used as answered and not read again. Never throws.
 */
export async function resolvePlacements(
  ids: readonly string[],
  readDocs: (ids: string[], signal: AbortSignal) => PromiseLike<ReadResult>,
  readFolders: (ids: string[], signal: AbortSignal) => PromiseLike<ReadResult>,
  opts: { timeoutMs?: number; known?: KnownDocuments | null } = {},
): Promise<Placements> {
  const named = [...new Set(ids.filter(canNameDocument))];
  if (named.length === 0) return { docs: new Map(), asked: new Set(), libraries: "ready", folders: "ready" };
  const asked = named.slice(0, PLACE_CAP);
  let libraries: RollupState = named.length > PLACE_CAP ? "unknown" : "ready";
  let folders: RollupState = libraries;
  const rows: Array<{ id: string; libraryId: string; collectionId: string | null }> = [];
  const take = (data: unknown) => {
    for (const d of (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>) {
      if (!d || typeof d.id !== "string" || typeof d.library_id !== "string" || !d.library_id) continue;
      rows.push({ id: d.id, libraryId: d.library_id, collectionId: typeof d.collection_id === "string" && d.collection_id ? d.collection_id : null });
    }
  };
  const knownIds = new Set(opts.known?.ids ?? []);
  if (opts.known) take((opts.known.rows as unknown[] | null) ?? []);
  const toRead = asked.filter((id) => !knownIds.has(id));

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(TIMED_OUT); }, opts.timeoutMs ?? PLACE_TIMEOUT_MS);
  });
  /** One read, raced against the deadline: its result, or null when it
   *  failed, threw or did not answer in time. */
  const within = async (read: (ids: string[], signal: AbortSignal) => PromiseLike<ReadResult>, chunk: string[]): Promise<ReadResult | null> => {
    try {
      const got = await Promise.race([Promise.resolve(read(chunk, controller.signal)), deadline]);
      if (got === TIMED_OUT || !got || got.error) return null;
      return got;
    } catch {
      return null;
    }
  };
  const chunks = (list: string[]): string[][] => {
    const out: string[][] = [];
    for (let i = 0; i < list.length; i += PLACE_CHUNK) out.push(list.slice(i, i + PLACE_CHUNK));
    return out;
  };

  try {
    for (const got of await Promise.all(chunks(toRead).map((c) => within(readDocs, c)))) {
      if (!got) { libraries = "unknown"; folders = "unknown"; continue; }
      take(got.data);
    }

  // The folder chains: one read of the documents' own folders (their
  // path_ids), then the resolver's walk over that map — the folder, then its
  // ancestors nearest first. An ancestor needs no read of its own: the rail
  // renders only the folders the viewer can see, so a count kept under a
  // folder id it does not show is never displayed.
    const leafIds = [...new Set(rows.map((r) => r.collectionId).filter((x): x is string => !!x))];
    const folderMap = new Map<string, { path_ids?: unknown; value: null }>();
    for (const got of await Promise.all(chunks(leafIds).map((c) => within(readFolders, c)))) {
      if (!got) { folders = "unknown"; continue; }
      for (const f of (Array.isArray(got.data) ? got.data : []) as Array<Record<string, unknown>>) {
        if (f && typeof f.id === "string") folderMap.set(f.id, { path_ids: f.path_ids, value: null });
      }
    }
    for (const node of [...folderMap.values()]) {
      for (const a of Array.isArray(node.path_ids) ? (node.path_ids as unknown[]) : []) {
        if (typeof a === "string" && a && !folderMap.has(a)) folderMap.set(a, { value: null });
      }
    }

    const docs = new Map<string, DocPlacement>();
    for (const r of rows) {
      docs.set(r.id, {
        libraryId: r.libraryId,
        folderIds: folderChainFromMap(r.collectionId, folderMap).map((f) => f.id),
      });
    }
    return { docs, asked: new Set(asked), libraries, folders };
  } finally {
    clearTimeout(timer);
  }
}

/** What one container or row shows: its mark, `unknown` (no count is known
 *  and the roll-up is incomplete — render "?", never nothing), or null
 *  (nothing to mark — render nothing, exactly as before). */
export type AttentionMarkState = AttentionMark | "unknown" | null;

/** A target the selector answers for (TAX-10 dw1's useAttentionFor). */
export type AttentionTarget =
  | { libraryId: string }
  | { folderId: string }
  | { documentId: string }
  | { projectId: string };

/** The mark for one target. A document row and a project card never read
 *  as unknown: their marks need no placement. A library or folder with a
 *  count shows it (a lower bound while the roll-up is unknown — `partial`);
 *  one without a count shows unknown while the roll-up is incomplete. */
export function attentionFor(rollup: AttentionRollup, target: AttentionTarget): AttentionMarkState {
  if ("documentId" in target) return rollup.byDocument.get(target.documentId) ?? null;
  if ("projectId" in target) return rollup.byProject.get(target.projectId) ?? null;
  if ("libraryId" in target) {
    const m = rollup.byLibrary.get(target.libraryId);
    if (m) return m;
    return rollup.libraries === "unknown" ? "unknown" : null;
  }
  const m = rollup.byFolder.get(target.folderId);
  if (m) return m;
  return rollup.folders === "unknown" ? "unknown" : null;
}

/** What a LIST surface draws for a library or folder: its count, or nothing.
 *  While the roll-up is incomplete a container without a count draws
 *  nothing — the page says the unknown ONCE (rollupIncomplete +
 *  AttentionUnknownNote) rather than a "?" on every card and folder; a count
 *  it does know is a lower bound (the surface's `partial` → "3+"). A document
 *  row and a project card answer as attentionFor does. */
export function listMarkFor(rollup: AttentionRollup, target: AttentionTarget): AttentionMarkState {
  const m = attentionFor(rollup, target);
  return m === "unknown" ? null : m;
}

/** Whether the per-container counts at this level may be short — the one
 *  thing a page with list marks must say, once. */
export function rollupIncomplete(rollup: AttentionRollup, level: "libraries" | "folders"): boolean {
  return rollup[level] === "unknown";
}

const sameMarks = (a: ReadonlyMap<string, AttentionMark>, b: ReadonlyMap<string, AttentionMark>): boolean => {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [k, m] of a) {
    const o = b.get(k);
    if (!o || o.total !== m.total || o.action !== m.action) return false;
  }
  return true;
};

/** Two roll-ups mark exactly the same things. The provider keeps the
 *  previous roll-up object while this holds, so a feed pass that changed no
 *  mark re-renders no page that reads the marks (fix pass). */
export function sameRollup(a: AttentionRollup, b: AttentionRollup): boolean {
  return a === b || (
    a.libraries === b.libraries && a.folders === b.folders
    && sameMarks(a.byLibrary, b.byLibrary) && sameMarks(a.byFolder, b.byFolder)
    && sameMarks(a.byDocument, b.byDocument) && sameMarks(a.byProject, b.byProject)
  );
}
