// lib/intents.ts
//
// INTENT LAYER — ambient "who is working on what, based on which revision".
//
// The checkout is a deliberate human act (a communication artifact with a
// purpose, a thread, a lock). Intent is the safety net UNDER it: captured
// automatically at every content touchpoint, so even people who never touch
// the checkout button leave a trail the publish contract and the overlap
// advisories can use.
//
//   viewer open (view)  → 'view'       decays 4h
//   download / print    → 'reference'  decays 72h ('edit' if the actor holds
//                         a checkout on the doc — their download is work)
//   markup mode         → 'edit'       decays 24h, refreshed on activity
//   checkout session    → 'edit'       long decay, refreshed while active
//   ticket → DRAFTING   → 'edit'       7d from last ticket touch
//
// Rules of the layer:
//   * Capture is FIRE-AND-FORGET. An intent write must never block or fail
//     a user action — every public function here swallows errors.
//   * Overlap signals consume edit×edit only. Views never ping anyone.
//   * base_version_id (documents.current_version_id at capture) is the key
//     fact — it's what makes "two people started from the same rev" and
//     "your copy is stale" computable.
//   * Pre-migration tolerance: if the 20260824 migration isn't applied,
//     every helper degrades to a silent no-op / empty result, same pattern
//     as checkoutEpisodes.

import { supabase } from "@/lib/supabase";

export type IntentKind = "view" | "reference" | "edit";
export type IntentSource =
  | "viewer" | "download" | "print" | "checkout" | "ticket" | "declared" | "source_pull";

export interface DocumentIntent {
  id: string;
  orgId: string;
  documentId: string;
  libraryId: string | null;
  userId: string;
  userName: string | null;
  kind: IntentKind;
  source: IntentSource;
  baseVersionId: string | null;
  ticketId: string | null;
  sessionId: string | null;
  createdAt: string;
  refreshedAt: string;
  expiresAt: string;
}

// Decay windows (ms). Exported for tests and for UI copy.
export const INTENT_TTL_MS: Record<IntentKind, number> = {
  view: 4 * 60 * 60 * 1000,        // 4h
  reference: 72 * 60 * 60 * 1000,  // 72h
  edit: 24 * 60 * 60 * 1000,       // 24h (checkout/ticket sources pass longer)
};
export const TICKET_INTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 7d
export const CHECKOUT_INTENT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // refreshed while active

/** Pure: expiry timestamp for a capture. Split out for unit tests. */
export function computeIntentExpiry(
  kind: IntentKind,
  source: IntentSource,
  nowMs: number,
): string {
  let ttl = INTENT_TTL_MS[kind];
  if (source === "ticket") ttl = TICKET_INTENT_TTL_MS;
  if (source === "checkout") ttl = CHECKOUT_INTENT_TTL_MS;
  return new Date(nowMs + ttl).toISOString();
}

/** Pure: is this intent row still live at `nowMs`? */
export function intentIsLive(intent: { expiresAt: string }, nowMs: number): boolean {
  const exp = Date.parse(intent.expiresAt);
  return Number.isFinite(exp) && exp > nowMs;
}

/**
 * Pure: given the live intents on one document, the edit×edit overlaps that
 * involve `userId` (or all pairs when userId is omitted). View/reference
 * intents never produce overlaps — that's the false-positive firewall.
 */
export function findEditOverlaps(
  intents: Array<Pick<DocumentIntent, "userId" | "userName" | "kind" | "expiresAt" | "baseVersionId" | "source">>,
  nowMs: number,
  userId?: string,
): Array<{ userId: string; userName: string | null; baseVersionId: string | null; source: IntentSource }> {
  const edits = intents.filter((i) => i.kind === "edit" && intentIsLive(i, nowMs));
  const byUser = new Map<string, (typeof edits)[number]>();
  for (const e of edits) if (!byUser.has(e.userId)) byUser.set(e.userId, e);
  const users = [...byUser.values()];
  if (users.length < 2) return [];
  const others = userId ? users.filter((u) => u.userId !== userId) : users;
  if (userId && others.length === users.length) return []; // caller isn't editing
  return others.map((o) => ({
    userId: o.userId,
    userName: o.userName ?? null,
    baseVersionId: o.baseVersionId ?? null,
    source: o.source,
  }));
}

// Pre-migration detection, same convention as checkoutEpisodes.
let intentSchemaMissing = false;
export function resetIntentSchemaFlag(): void { intentSchemaMissing = false; }

function isMissingIntentSchema(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  const code = e.code ?? "";
  if (code === "42P01" || code === "42703" || code === "PGRST204" || code === "PGRST205") return true;
  const msg = (e.message ?? "").toLowerCase();
  return msg.includes("document_intents") &&
    (msg.includes("does not exist") || msg.includes("schema cache") || msg.includes("could not find"));
}

export interface RecordIntentInput {
  orgId: string;
  documentId: string;
  libraryId?: string | null;
  userId: string;
  userName?: string | null;
  kind: IntentKind;
  source: IntentSource;
  /** documents.current_version_id at capture time. Pass what you have; when
   *  omitted we look it up (still fire-and-forget). */
  baseVersionId?: string | null;
  ticketId?: string | null;
  sessionId?: string | null;
}

/**
 * Capture (or refresh) an intent. NEVER throws, never blocks the caller's
 * main flow — call it without awaiting where latency matters.
 */
export async function recordIntent(input: RecordIntentInput): Promise<void> {
  if (intentSchemaMissing) return;
  try {
    let base = input.baseVersionId;
    if (base === undefined) {
      const { data } = await supabase
        .from("documents")
        .select("current_version_id")
        .eq("id", input.documentId)
        .maybeSingle();
      base = (data as { current_version_id?: string | null } | null)?.current_version_id ?? null;
    }
    const now = Date.now();
    const { error } = await supabase
      .from("document_intents")
      .upsert(
        {
          org_id: input.orgId,
          document_id: input.documentId,
          library_id: input.libraryId ?? null,
          user_id: input.userId,
          user_name: input.userName ?? null,
          kind: input.kind,
          source: input.source,
          base_version_id: base ?? null,
          ticket_id: input.ticketId ?? null,
          session_id: input.sessionId ?? null,
          refreshed_at: new Date(now).toISOString(),
          expires_at: computeIntentExpiry(input.kind, input.source, now),
        },
        { onConflict: "document_id,user_id,kind,source" },
      );
    if (error) {
      if (isMissingIntentSchema(error)) { intentSchemaMissing = true; return; }
      console.warn("[intents] capture failed (non-blocking)", error.message);
    }
  } catch (e) {
    console.warn("[intents] capture threw (non-blocking)", e);
  }
}

/** End my intents on a document (e.g. explicit check-in). Fire-and-forget. */
export async function endMyIntents(input: {
  documentId: string;
  userId: string;
  sources?: IntentSource[];
}): Promise<void> {
  if (intentSchemaMissing) return;
  try {
    let q = supabase
      .from("document_intents")
      .delete()
      .eq("document_id", input.documentId)
      .eq("user_id", input.userId);
    if (input.sources?.length) q = q.in("source", input.sources);
    const { error } = await q;
    if (error && isMissingIntentSchema(error)) intentSchemaMissing = true;
  } catch { /* non-blocking */ }
}

function rowToIntent(r: Record<string, unknown>): DocumentIntent {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    documentId: r.document_id as string,
    libraryId: (r.library_id as string | null) ?? null,
    userId: String(r.user_id),
    userName: (r.user_name as string | null) ?? null,
    kind: r.kind as IntentKind,
    source: r.source as IntentSource,
    baseVersionId: (r.base_version_id as string | null) ?? null,
    ticketId: (r.ticket_id as string | null) ?? null,
    sessionId: (r.session_id as string | null) ?? null,
    createdAt: r.created_at as string,
    refreshedAt: r.refreshed_at as string,
    expiresAt: r.expires_at as string,
  };
}

/** Live intents on one document (all kinds). Empty on pre-migration envs. */
export async function listLiveIntents(documentId: string): Promise<DocumentIntent[]> {
  if (intentSchemaMissing) return [];
  try {
    const { data, error } = await supabase
      .from("document_intents")
      .select("*")
      .eq("document_id", documentId)
      .gt("expires_at", new Date().toISOString());
    if (error) {
      if (isMissingIntentSchema(error)) { intentSchemaMissing = true; return []; }
      throw new Error(error.message);
    }
    return ((data as Record<string, unknown>[]) ?? []).map(rowToIntent);
  } catch {
    return [];
  }
}

/** Live EDIT intents on one document — the overlap-advisory feed. */
export async function listLiveEditIntents(documentId: string): Promise<DocumentIntent[]> {
  return (await listLiveIntents(documentId)).filter((i) => i.kind === "edit");
}

/**
 * The freshest edit-intent base for a user on a document — the publish
 * contract's fallback expected-base when there's no checkout session.
 * Returns undefined when no live edit intent exists (caller then falls back
 * to an explicit "based on rev" declaration).
 */
export async function getMyEditBase(
  documentId: string,
  userId: string,
): Promise<string | null | undefined> {
  const intents = (await listLiveIntents(documentId)).filter(
    (i) => i.kind === "edit" && i.userId === userId,
  );
  if (intents.length === 0) return undefined;
  const freshest = [...intents].sort(
    (a, b) => Date.parse(b.refreshedAt) - Date.parse(a.refreshedAt),
  )[0];
  return freshest.baseVersionId;
}

/**
 * Org-wide edit×edit overlap sweep for the coordination surfaces: documents
 * with 2+ distinct users holding live edit intents. Grouped per document.
 */
export async function listOrgEditOverlaps(orgId: string): Promise<Array<{
  documentId: string;
  libraryId: string | null;
  intents: DocumentIntent[];
}>> {
  if (intentSchemaMissing) return [];
  try {
    const { data, error } = await supabase
      .from("document_intents")
      .select("*")
      .eq("org_id", orgId)
      .eq("kind", "edit")
      .gt("expires_at", new Date().toISOString());
    if (error) {
      if (isMissingIntentSchema(error)) { intentSchemaMissing = true; return []; }
      throw new Error(error.message);
    }
    const byDoc = new Map<string, DocumentIntent[]>();
    for (const r of (data as Record<string, unknown>[]) ?? []) {
      const intent = rowToIntent(r);
      const list = byDoc.get(intent.documentId) ?? [];
      list.push(intent);
      byDoc.set(intent.documentId, list);
    }
    const out: Array<{ documentId: string; libraryId: string | null; intents: DocumentIntent[] }> = [];
    for (const [documentId, intents] of byDoc) {
      const distinctUsers = new Set(intents.map((i) => i.userId));
      if (distinctUsers.size >= 2) {
        out.push({ documentId, libraryId: intents[0].libraryId, intents });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Prune expired rows. Called from the maintenance cron (service role). */
export async function pruneExpiredIntents(client?: typeof supabase): Promise<number> {
  const db = client ?? supabase;
  try {
    const { data, error } = await db
      .from("document_intents")
      .delete()
      .lt("expires_at", new Date().toISOString())
      .select("id");
    if (error) return 0;
    return ((data as unknown[]) ?? []).length;
  } catch {
    return 0;
  }
}
