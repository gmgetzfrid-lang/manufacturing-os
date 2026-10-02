// lib/embedKeyOverview.ts — what a member's embeddings key is doing, across
// every library of the workspace (intelligence Round G, I-20).
//
// Two questions AI settings answers from one read of /api/knowledge/embed's
// `key-overview` action:
//
//   * GOV-14 — which background builds are running on MY key? One place
//     lists every one, each with a Stop (the route's `release` action, sent
//     with `onlyMine`: a row read before another member's build replaced
//     the consent never stops theirs).
//   * SEM-1 — what happens to the meaning indexes if I switch my embedding
//     model or provider? A meaning index lives in ONE model's vector space
//     (DEC-59 (3)). A question is embedded with each index's own model on
//     the asker's key, so an index answers whoever holds a key for the
//     provider that built it (planQueryEmbedding). Switching PROVIDER stops
//     every index the old provider built from answering for this member;
//     switching MODEL within a provider keeps them answering, but no build
//     with the new model can add to them, and the background builds on this
//     key hold, until each library is rebuilt with the new model. The switch
//     is confirmed with the libraries named, and each one's Rebuild offered.
//     A member whose meaning search runs on their OpenAI CHAT key (no
//     embeddings key saved) loses it when the chat key moves to another
//     provider or is removed. Removing the chat key deletes the member's
//     whole connection, so a saved embeddings key goes with it; removing the
//     embeddings key leaves the OpenAI chat key's default model, or nothing.
//     Each of those changes is confirmed the same way (embeddingLossImpact,
//     or embeddingSwitchImpact when the chat key takes over).
//
// The impact functions are pure; the fetches are the only side effects here.

import { supabase } from "@/lib/supabase";
import {
  EMBEDDING_PROVIDERS, defaultEmbeddingModel, resolveCorpusModel, type EmbeddingProviderId,
} from "@/lib/ai/embeddings";

/** A background build the member's key pays for (the library's consent marker names them). */
export interface EmbedKeyBuild {
  libraryId: string;
  libraryName: string;
  /** A standing consent: keep this index current as documents arrive. */
  standing: boolean;
  startedAt: string | null;
  lastDrainAt: string | null;
  blockedUntil: string | null;
  blockedReason: string | null;
  lastError: string | null;
  completedAt: string | null;
}

/** A library's vectors per embedding model; null = they could not be read. */
export interface EmbedKeyIndex {
  libraryId: string;
  libraryName: string;
  models: Record<string, number> | null;
}

export interface EmbedKeyOverview {
  builds: EmbedKeyBuild[];
  /** Present when asked for (`models: true`). */
  indexes?: EmbedKeyIndex[];
}

/** One read: the builds on the caller's key and, with `models`, every
 *  library's vectors per model. Throws the route's sentence on a refusal —
 *  and when `models` was asked for and the answer carries no `indexes` (a
 *  route instance on an earlier build, a rewritten body): an answer without
 *  the libraries is never read as "no library affected". */
export async function getEmbedKeyOverview(orgId: string, opts?: { models?: boolean }): Promise<EmbedKeyOverview> {
  const { res, data } = await postEmbed<EmbedKeyOverview>({ orgId, action: "key-overview", models: opts?.models === true });
  if (!res.ok || !data || !Array.isArray(data.builds)) {
    throw new Error(data?.error || `The background builds on your key couldn't be read (HTTP ${res.status}).`);
  }
  if (opts?.models === true && !Array.isArray(data.indexes)) {
    throw new Error("The answer did not list the libraries' meaning indexes");
  }
  return data;
}

/** One authenticated POST to the embed route; the answer as it came. */
async function postEmbed<T>(body: Record<string, unknown>): Promise<{ res: Response; data: (T & { error?: string }) | null }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Not authenticated");
  const res = await fetch("/api/knowledge/embed", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(body),
  });
  return { res, data: (await res.json().catch(() => null)) as (T & { error?: string }) | null };
}

/** GOV-14: Stop a build listed under "Background builds on your key" — only
 *  while its consent still names the caller (`onlyMine`). A row read before
 *  another member's build replaced the consent is refused (409, nothing
 *  stopped), so a controller's Stop there never ends someone else's build;
 *  the library's own panel keeps the plain release. Throws the route's
 *  sentence on a refusal; `released: false` is "nothing was running". */
export async function releaseBuildOnMyKey(orgId: string, libraryId: string): Promise<{ released: boolean }> {
  const { res, data } = await postEmbed<{ released: boolean }>({ orgId, libraryId, action: "release", onlyMine: true });
  if (!res.ok || !data) throw new Error(data?.error || `The background build couldn't be stopped (HTTP ${res.status}).`);
  return data;
}

/** An embeddings setting as the server resolves it: provider and model. */
export interface EmbeddingSetting { provider: EmbeddingProviderId; model: string }

const isProvider = (p: unknown): p is EmbeddingProviderId =>
  EMBEDDING_PROVIDERS.some((x) => x.id === p);

/** The member's embeddings setting in effect now, as embeddingConnectionFrom
 *  resolves it server-side: the saved embeddings provider and model (the
 *  provider's default model when none is saved), else an OpenAI chat key's
 *  default embeddings model, else none. */
export function effectiveEmbeddingSetting(current: {
  provider?: string | null; embeddingProvider?: string | null; embeddingModel?: string | null;
} | null | undefined): EmbeddingSetting | null {
  if (current?.embeddingProvider && isProvider(current.embeddingProvider)) {
    return { provider: current.embeddingProvider, model: current.embeddingModel || defaultEmbeddingModel(current.embeddingProvider) };
  }
  if (current?.provider === "openai") return { provider: "openai", model: defaultEmbeddingModel("openai") };
  return null;
}

/** The setting in effect runs on the member's OpenAI CHAT key — no
 *  embeddings key is saved (embeddingConnectionFrom's fallback). Moving the
 *  chat key to another provider, or removing it, leaves them with none. */
export function onChatKeyEmbeddings(current: Parameters<typeof effectiveEmbeddingSetting>[0]): boolean {
  return !!current && !(current.embeddingProvider && isProvider(current.embeddingProvider)) && current.provider === "openai";
}

/** What `after` would put in an embeddings setting being saved. */
export function savedEmbeddingSetting(provider: string, model: string): EmbeddingSetting | null {
  if (!isProvider(provider)) return null;
  return { provider, model: model.trim() || defaultEmbeddingModel(provider) };
}

type Lib = { libraryId: string; libraryName: string };

export interface EmbeddingSwitchImpact {
  before: EmbeddingSetting;
  after: EmbeddingSetting;
  providerChanged: boolean;
  /** Indexes the old provider built: they answer this member's meaning
   *  search now and stop when the provider changes. */
  stopAnswering: Array<Lib & { model: string }>;
  /** Indexes built with the old model of the same provider: they keep
   *  answering, but a build with the new model cannot add to them. */
  cannotGrow: Array<Lib & { model: string }>;
  /** Background builds on this member's key that hold (model conflict)
   *  until their library is rebuilt with the new model. */
  buildsStop: Array<Lib & { model: string | null; standing: boolean }>;
  /** Libraries whose vectors could not be read. */
  unknown: Lib[];
  /** The overview itself could not be read: the warning is general. */
  unreadable: string | null;
}

/** SEM-1: what switching from `before` to `after` does to the meaning
 *  indexes and the builds on this key. Null when nothing is switched (the
 *  same provider and model, or no embeddings setting before) — saving then
 *  asks nothing. */
export function embeddingSwitchImpact(
  before: EmbeddingSetting | null, after: EmbeddingSetting | null,
  overview: EmbedKeyOverview | null, unreadable: string | null = null,
): EmbeddingSwitchImpact | null {
  if (!before || !after) return null;
  if (before.provider === after.provider && before.model === after.model) return null;
  const impact: EmbeddingSwitchImpact = {
    before, after, providerChanged: before.provider !== after.provider,
    stopAnswering: [], cannotGrow: [], buildsStop: [], unknown: [],
    unreadable: overview ? null : (unreadable ?? "the libraries could not be read"),
  };
  if (!overview) return impact;
  const verdicts = new Map<string, ReturnType<typeof resolveCorpusModel> | null>();
  for (const idx of overview.indexes ?? []) {
    const lib = { libraryId: idx.libraryId, libraryName: idx.libraryName };
    if (!idx.models) { verdicts.set(idx.libraryId, null); impact.unknown.push(lib); continue; }
    const v = resolveCorpusModel(idx.models);
    verdicts.set(idx.libraryId, v);
    // Empty: nothing to lose. Mixed: meaning search is already off for it.
    if (v.state !== "single") continue;
    if (v.provider === before.provider && v.provider !== after.provider) {
      impact.stopAnswering.push({ ...lib, model: v.model });
    } else if (v.provider === after.provider && v.model === before.model && v.model !== after.model) {
      impact.cannotGrow.push({ ...lib, model: v.model });
    }
  }
  for (const b of overview.builds) {
    const v = verdicts.get(b.libraryId);
    if (!v) continue;                       // unread (listed as unknown) or not read at all
    if (v.state === "single" && v.model !== after.model) {
      impact.buildsStop.push({ libraryId: b.libraryId, libraryName: b.libraryName, model: v.model, standing: b.standing });
    } else if (v.state === "mixed") {
      impact.buildsStop.push({ libraryId: b.libraryId, libraryName: b.libraryName, model: null, standing: b.standing });
    }
  }
  return impact;
}

/** Why a member is left with no embeddings setting at all:
 *  - `chatKey`: meaning search ran on their OpenAI CHAT key (no embeddings
 *    key saved), and that chat key moves to another provider or is removed;
 *  - `connectionRemoved`: they remove their chat key while an embeddings key
 *    is saved — the removal deletes their whole connection (DELETE
 *    /api/ai/connection), the embeddings key with it;
 *  - `embeddingsKeyRemoved`: they remove their embeddings key and hold no
 *    OpenAI chat key for meaning search to fall back on. */
export type EmbeddingLossCause = "chatKey" | "connectionRemoved" | "embeddingsKeyRemoved";

/** SEM-1: losing the embeddings setting altogether (`cause`). `after` is
 *  none: every index the old provider built stops answering them, and
 *  every background build on their key ends (the drain releases a consent
 *  whose payer has no embeddings key). */
export interface EmbeddingLossImpact extends Omit<EmbeddingSwitchImpact, "after"> { after: null; cause: EmbeddingLossCause }

export function embeddingLossImpact(
  before: EmbeddingSetting, overview: EmbedKeyOverview | null, unreadable: string | null = null,
  cause: EmbeddingLossCause = "chatKey",
): EmbeddingLossImpact {
  const impact: EmbeddingLossImpact = {
    before, after: null, cause, providerChanged: true,
    stopAnswering: [], cannotGrow: [], buildsStop: [], unknown: [],
    unreadable: overview ? null : (unreadable ?? "the libraries could not be read"),
  };
  if (!overview) return impact;
  const verdicts = new Map<string, ReturnType<typeof resolveCorpusModel> | null>();
  for (const idx of overview.indexes ?? []) {
    const lib = { libraryId: idx.libraryId, libraryName: idx.libraryName };
    if (!idx.models) { verdicts.set(idx.libraryId, null); impact.unknown.push(lib); continue; }
    const v = resolveCorpusModel(idx.models);
    verdicts.set(idx.libraryId, v);
    if (v.state === "single" && v.provider === before.provider) impact.stopAnswering.push({ ...lib, model: v.model });
  }
  for (const b of overview.builds) {
    const v = verdicts.get(b.libraryId);
    impact.buildsStop.push({
      libraryId: b.libraryId, libraryName: b.libraryName, model: v && v.state === "single" ? v.model : null, standing: b.standing,
    });
  }
  return impact;
}

/** A switch to another setting, not a loss of every setting. */
export function isSwitchImpact(i: EmbeddingSwitchImpact | EmbeddingLossImpact): i is EmbeddingSwitchImpact {
  return i.after !== null;
}

/** Nothing to warn about: no index answers or grows on the old setting, no
 *  build on this key holds, and every library was read. */
export function switchImpactIsEmpty(i: EmbeddingSwitchImpact | EmbeddingLossImpact): boolean {
  return !i.unreadable && i.stopAnswering.length === 0 && i.cannotGrow.length === 0
    && i.buildsStop.length === 0 && i.unknown.length === 0;
}

/** The libraries a Rebuild with the new model would bring back, once each. */
export function librariesToRebuild(i: EmbeddingSwitchImpact | EmbeddingLossImpact): Lib[] {
  const seen = new Map<string, Lib>();
  for (const l of [...i.stopAnswering, ...i.cannotGrow, ...i.buildsStop]) {
    if (!seen.has(l.libraryId)) seen.set(l.libraryId, { libraryId: l.libraryId, libraryName: l.libraryName });
  }
  return [...seen.values()];
}

/** What the editor links once the switch is saved: the libraries to
 *  rebuild, then those whose index could not be checked (marked so). Empty
 *  when the overview itself was unreadable — then no library can be named,
 *  and the confirm says to open each library's panel instead of promising
 *  links. */
export function librariesLinkedAfterSwitch(i: EmbeddingSwitchImpact | EmbeddingLossImpact): Array<Lib & { unchecked: boolean }> {
  const definite = librariesToRebuild(i);
  const ids = new Set(definite.map((l) => l.libraryId));
  return [
    ...definite.map((l) => ({ ...l, unchecked: false })),
    ...i.unknown.filter((l) => !ids.has(l.libraryId)).map((l) => ({ libraryId: l.libraryId, libraryName: l.libraryName, unchecked: true })),
  ];
}
