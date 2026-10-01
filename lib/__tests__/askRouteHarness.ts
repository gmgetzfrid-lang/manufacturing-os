// Test harness for /api/knowledge/ask (intelligence Round G, I-03).
//
// The route runs for real against the in-memory database of
// knowledgeFakeDb.ts behind a PostgREST stand-in that, like the real one,
// CAPS every response at max-rows without an error. The real knowledge ACL
// seam (lib/knowledgeAccess), the real AI gate stack (lib/ai/aiGates) and the
// real spend ledger (lib/ai/usageServer) run over it; the provider, the
// embeddings provider, the page renderer and the org playbooks are scripted.
//
// What the stand-in adds on top of knowledgeFakeDb (without editing that
// shared file): `.textSearch()` and `.ilike()` (applied after the read, on a
// column the builder adds to the projection and strips again), a `head`
// count, `.single()` after an insert returning one row, and the RPCs the
// route calls (knowledge_search, knowledge_search_document, semantic_search,
// semantic_coverage_detail).

import { fakeAdmin, db, type Row } from "./knowledgeFakeDb";
import { AGREEMENT_VERSION } from "@/lib/ai/pricing";

export type ScriptedCall = {
  text?: string;
  usage?: { inputTokens: number; outputTokens: number };
  stopReason?: string;
  throws?: { message: string; status?: number; usage?: { inputTokens: number; outputTokens: number } };
};

export const h = {
  maxRows: 1000,
  script: [] as ScriptedCall[],
  calls: [] as Array<{ system: string; user: string; maxTokens?: number; images: number }>,
  embedCalls: [] as Array<{ provider: string; model: string; passages: string[] }>,
  semanticCalls: [] as Array<{ library: string; limit: number; model: string | null }>,
  rpcMissing: new Set<string>(),
  /** Similarity per chunk id for semantic_search (higher = nearer). */
  similarity: new Map<string, number>(),
  legendDocIds: [] as string[],
  /** Texts embedded so far; a query vector's first component is its index
   *  here, so semantic_search can answer per query text. */
  embedTexts: [] as string[],
  /** semantic_search's answer for one query text: chunk ids, nearest first. */
  semanticFor: new Map<string, string[]>(),
  /** An embedding model the provider refuses (404 → AiCallError 400). */
  embedRefuses: null as string | null,
  skills: { block: "", skills: [] as Array<{ id: string | null; name: string; builtinKey: string | null }> },
};

export function resetHarness(): void {
  h.maxRows = 1000;
  h.script = [];
  h.calls = [];
  h.embedCalls = [];
  h.semanticCalls = [];
  h.rpcMissing = new Set();
  h.similarity = new Map();
  h.legendDocIds = [];
  h.embedTexts = [];
  h.semanticFor = new Map();
  h.embedRefuses = null;
  h.skills = { block: "", skills: [] };
}

type Res = { data: unknown; error: unknown; count?: number | null };

const words = (q: string) => q.toLowerCase().split(/[^a-z0-9#.-]+/i).filter((w) => w.length >= 2);
/** websearch_to_tsquery, near enough for a test: every word must appear
 *  (an " or " query: any). */
export function textMatches(text: string, query: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (/\sor\s/i.test(query)) return query.split(/\s+or\s+/i).some((p) => words(p).every((w) => t.includes(w)));
  const ws = words(query);
  return ws.length > 0 && ws.every((w) => t.includes(w));
}
const termHits = (text: string, query: string) =>
  words(query.replace(/\sor\s/gi, " ")).filter((w) => String(text ?? "").toLowerCase().includes(w)).length;

/** Wrap a knowledgeFakeDb builder with what the route needs and the shared
 *  stand-in lacks. */
function wrap(table: string) {
  const b = fakeAdmin.from(table) as unknown as Record<string, (...a: unknown[]) => unknown> & PromiseLike<Res>;
  let cols = "*";
  let headCount = false;
  let unwrapOne = false;
  let unwrapMaybe = false;
  const post: Array<(r: Row) => boolean> = [];
  const extraCols: string[] = [];
  const reselect = () => {
    if (cols.trim() === "*") return;
    (b.select as (c: string) => unknown)([cols, ...extraCols].join(", "));
  };
  const proxy: unknown = new Proxy(b, {
    get(target, prop) {
      if (prop === "select") {
        return (c = "*", opts?: { count?: string; head?: boolean }) => {
          if ((target as { __kind?: string }).__kind === undefined) cols = c;
          headCount = !!opts?.head;
          (target.select as (c: string) => unknown)(c);
          return proxy;
        };
      }
      if (prop === "textSearch" || prop === "ilike") {
        return (col: string, q: string) => {
          if (!extraCols.includes(col)) { extraCols.push(col); reselect(); }
          if (prop === "textSearch") post.push((r) => textMatches(String(r[col] ?? ""), q));
          else {
            const needle = q.replace(/^%|%$/g, "").toLowerCase();
            post.push((r) => String(r[col] ?? "").toLowerCase().includes(needle));
          }
          return proxy;
        };
      }
      if (prop === "single") {
        return () => { unwrapOne = true; return proxy; };
      }
      if (prop === "maybeSingle") {
        return () => { unwrapMaybe = true; (target.maybeSingle as () => unknown)(); return proxy; };
      }
      if (prop === "then") {
        return (f?: (r: Res) => unknown, rj?: (e: unknown) => unknown) =>
          target.then((res: Res) => {
            let data = res.data;
            if (Array.isArray(data)) {
              if (post.length > 0) data = (data as Row[]).filter((r) => post.every((p) => p(r)));
              if (extraCols.length > 0 && cols.trim() !== "*") {
                const keep = cols.split(",").map((c) => c.trim()).filter(Boolean);
                data = (data as Row[]).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.includes(k) || !extraCols.includes(k))));
              }
              data = (data as unknown[]).slice(0, h.maxRows);
            }
            let out: Res = { ...res, data };
            if (headCount) out = { ...out, count: Array.isArray(data) ? (data as unknown[]).length : 0, data: null };
            if (unwrapMaybe && Array.isArray(out.data)) out = { ...out, data: (out.data as unknown[])[0] ?? null };
            if (unwrapOne && Array.isArray(out.data)) {
              const arr = out.data as unknown[];
              out = arr.length === 1 ? { ...out, data: arr[0] } : { data: null, error: out.error ?? { code: "PGRST116", message: "not one row" } };
            }
            return f ? f(out) : out;
          }, rj);
      }
      const v = (target as Record<string | symbol, unknown>)[prop];
      if (typeof v === "function") {
        return (...a: unknown[]) => {
          const out = (v as (...x: unknown[]) => unknown).apply(target, a);
          return out === target ? proxy : out;
        };
      }
      return v;
    },
  });
  return proxy;
}

const readyDoc = (id: unknown) => {
  const d = (db.tables.knowledge_documents ?? []).find((x) => x.id === id);
  return !!d && (d.status === "ready" || d.status === "indexing");
};

function rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res> {
  const run = (): Res => {
    if (h.rpcMissing.has(fn)) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } };
    const chunks = db.tables.knowledge_chunks ?? [];
    if (fn === "knowledge_search" || fn === "knowledge_search_document") {
      const q = String(args.p_query ?? "");
      const rows = chunks.filter((c) => c.org_id === args.p_org
        && (fn === "knowledge_search" ? c.library_id === args.p_library : c.document_id === args.p_document)
        && readyDoc(c.document_id) && textMatches(String(c.content ?? ""), q))
        .map((c) => ({ id: c.id, document_id: c.document_id, page: c.page, content: c.content, section: c.section ?? null, rank: termHits(String(c.content), q) }))
        .sort((a, b) => b.rank - a.rank || String(a.id).localeCompare(String(b.id)))
        .slice(0, Math.min(Math.max(Number(args.p_limit) || 12, 1), 40));
      return { data: rows, error: null };
    }
    if (fn === "semantic_search") {
      const lib = String(args.p_library_id);
      const model = (args.p_model as string | null) ?? null;
      h.semanticCalls.push({ library: lib, limit: Number(args.p_limit), model });
      const inLib = chunks.filter((c) => c.org_id === args.p_org_id && c.library_id === lib && c.embedding != null);
      // 20261121: a library holding a vector under another model returns nothing.
      if (model && inLib.some((c) => c.embedding_model !== model)) return { data: [], error: null };
      const k = Number(String(args.p_embedding ?? "[").slice(1).split(",")[0]);
      const text = Number.isInteger(k) ? h.embedTexts[k] : undefined;
      const scripted = text !== undefined ? h.semanticFor.get(text) : undefined;
      if (scripted) {
        const byId = new Map(inLib.map((c) => [String(c.id), c]));
        const rows = scripted.map((id) => byId.get(id)).filter((c): c is Row => !!c && readyDoc(c.document_id))
          .map((c, i) => ({ chunk_id: c.id, document_id: c.document_id, document_name: null, page: c.page, content: c.content, similarity: 0.99 - i * 0.001, eligible: inLib.length }))
          .slice(0, Number(args.p_limit) || 20);
        return { data: rows, error: null };
      }
      const rows = inLib.filter((c) => readyDoc(c.document_id) && (!model || c.embedding_model === model))
        .map((c) => ({
          chunk_id: c.id, document_id: c.document_id, document_name: null, page: c.page, content: c.content,
          similarity: h.similarity.get(String(c.id)) ?? 0.5, eligible: inLib.length,
        }))
        .sort((a, b) => b.similarity - a.similarity || String(a.chunk_id).localeCompare(String(b.chunk_id)))
        .slice(0, Number(args.p_limit) || 20);
      return { data: rows, error: null };
    }
    if (fn === "semantic_coverage_detail") {
      const pop = chunks.filter((c) => c.org_id === args.p_org_id && c.library_id === args.p_library_id && readyDoc(c.document_id));
      const models: Record<string, number> = {};
      for (const c of chunks) {
        if (c.org_id !== args.p_org_id || c.library_id !== args.p_library_id || c.embedding == null) continue;
        const m = String(c.embedding_model ?? "(unrecorded)");
        models[m] = (models[m] ?? 0) + 1;
      }
      return {
        data: [{
          total: pop.length, embedded: pop.filter((c) => c.embedding != null).length, remaining: 0, failed: 0,
          leased: 0, waiting: 0, remaining_chars: 0, total_chars: 0, models,
        }],
        error: null,
      };
    }
    return { data: null, error: { code: "PGRST202", message: `unknown function ${fn}` } };
  };
  return { then: (f, r) => Promise.resolve().then(run).then(f, r) };
}

export const adminStandIn = {
  from: (t: string) => wrap(t),
  rpc,
  auth: {
    // "as:<uid>" signs in as any member; "good" / "viewer" as knowledgeFakeDb does.
    getUser: async (token: string) => token.startsWith("as:")
      ? { data: { user: { id: token.slice(3) } }, error: null }
      : fakeAdmin.auth.getUser(token),
  },
};

/** The scripted chat provider: one entry per call, in order. */
export async function scriptedCall(input: { system: string; user: string; maxTokens?: number; images?: unknown[] }) {
  h.calls.push({ system: input.system, user: input.user, maxTokens: input.maxTokens, images: input.images?.length ?? 0 });
  const next = h.script.shift();
  if (!next) throw new Error("no scripted answer");
  if (next.throws) {
    const { AiCallError } = await import("@/lib/ai/providerCall");
    const e = new AiCallError(next.throws.message, next.throws.status ?? 502);
    if (next.throws.usage) Object.assign(e, { usage: next.throws.usage });
    throw e;
  }
  return {
    text: next.text ?? "",
    usage: next.usage ?? { inputTokens: 1000, outputTokens: 100 },
    webSources: [],
    liveWeb: false,
    ...(next.stopReason ? { stopReason: next.stopReason } : {}),
  };
}

export async function scriptedEmbed(req: { provider: string; model: string; passages: readonly string[] }) {
  h.embedCalls.push({ provider: req.provider, model: req.model, passages: [...req.passages] });
  if (h.embedRefuses && req.model === h.embedRefuses) {
    const { AiCallError } = await import("@/lib/ai/providerCall");
    throw new AiCallError("Voyage AI doesn't recognise that embedding model.", 400);
  }
  const vectors = req.passages.map((p) => {
    let k = h.embedTexts.indexOf(p);
    if (k < 0) { h.embedTexts.push(p); k = h.embedTexts.length - 1; }
    const v = new Array(1024).fill(0.01);
    v[0] = k;
    return v;
  });
  return { vectors, usage: { inputTokens: 7 * req.passages.length, outputTokens: 0 } };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

export const ORG = "00000000-0000-4000-8000-000000000001";
export const LIB = "00000000-0000-4000-8000-0000000000a1";
export const LIB2 = "00000000-0000-4000-8000-0000000000a2";
export const DCLIB = "00000000-0000-4000-8000-0000000000d1";
export const CTRL = "u-ctrl";
export const VIEWER = "u-viewer";

let seq = 0;
export const uid = (prefix: string) => `${prefix}-${String(++seq).padStart(4, "0")}`;

export const kdoc = (id: string, over: Row = {}): Row => ({
  id, org_id: ORG, library_id: LIB, name: `${id}.pdf`, file_key: `orgs/${ORG}/knowledge/${id}.pdf`, status: "ready",
  page_count: 1, pages_indexed: 1, vision_pages: 0, source_document_id: null, source_version_id: null, source_rev: null,
  ...over,
});
export const kchunk = (document_id: string, content: string, over: Row = {}): Row => ({
  id: uid("c"), org_id: ORG, library_id: LIB, document_id, page: 1, seq: ++seq, content, section: null,
  embedding: null, embedding_model: null, ...over,
});
export const dcDoc = (id: string, over: Row = {}): Row => ({
  id, org_id: ORG, library_id: DCLIB, collection_id: null, acl: null, visibility: "normal", is_private: false,
  scope: null, created_by: "someone", owner_user_id: null, ai_excluded: false, status: "Issued", archived_at: null,
  current_version_id: `v-${id}`, ...over,
});

/** A Viewer denied read on one controlled document by its own ACL. */
export const DENY_VIEWER_ACL = { inherit: true, rules: [{ effect: "deny", subject: { type: "role", id: "Viewer" }, actions: ["read", "discover"] }] };

export function baseTables(): Record<string, Row[]> {
  return {
    org_members: [
      { org_id: ORG, uid: CTRL, role: "Admin", roles: ["Admin"], status: "active", display_name: "Ada Admin", email: "ada@x" },
      { org_id: ORG, uid: VIEWER, role: "Viewer", roles: ["Viewer"], status: "active", display_name: "Vic Viewer", email: "vic@x" },
    ],
    team_members: [],
    teams: [],
    libraries: [{ id: DCLIB, org_id: ORG, name: "Engineering", acl: null, visibility: "normal", owner_user_id: null, owner_team_id: null }],
    collections: [],
    documents: [],
    knowledge_libraries: [{ id: LIB, org_id: ORG, name: "Site standards", ai_features: {}, ai_instructions: null }],
    knowledge_library_links: [],
    knowledge_documents: [],
    knowledge_chunks: [],
    knowledge_page_entities: [],
    knowledge_questions: [],
    ai_connections: [
      { org_id: ORG, user_id: CTRL, provider: "anthropic", model: "chat-model-a", api_key: "k-ctrl", embedding_provider: null, embedding_model: null, embedding_api_key: null },
      { org_id: ORG, user_id: VIEWER, provider: "anthropic", model: "chat-model-a", api_key: "k-viewer", embedding_provider: null, embedding_model: null, embedding_api_key: null },
    ],
    ai_key_agreements: [
      { id: "ag-1", org_id: ORG, user_id: CTRL, scope: "use", agreement_version: AGREEMENT_VERSION },
      { id: "ag-2", org_id: ORG, user_id: VIEWER, scope: "use", agreement_version: AGREEMENT_VERSION },
    ],
    ai_usage_events: [],
    ai_usage_limits: [],
    asset_aliases: [],
    assets: [],
    audit_logs: [],
  };
}
