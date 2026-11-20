"use client";

// useFind - the state of one search box: what was found, which equipment is
// picked (asked when a tag is on several units, picked for you when the
// folder you're in says which), what else is on its documents, the work
// orders for it, the documents the find service ranks (names, tags read off
// the sheets, words inside the pages), and the document being looked at.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  findQuick, findDeep, equipDetail, defaultPick, exactTagMatches, tagKey,
  type QuickFind, type DeepFind, type EquipDetail, type FindEquip, type FindDoc,
} from "@/lib/findEverywhere";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export interface FindState {
  q: string;
  loading: boolean;
  quick: QuickFind | null;
  /** Equipment with exactly the tag typed: two or more means ask. */
  exact: FindEquip[];
  picked: FindEquip | null;
  /** The picked equipment's documents (tagged, drawn on, mentioned in). */
  pickedDocIds: string[];
  /** Picked for you because of the folder you're in. */
  pickedByFolder: boolean;
  pick: (id: string | null) => void;
  /** Pick this equipment as soon as a search finds it (a tap on the map). */
  pickWhenFound: (id: string) => void;
  detail: EquipDetail | null;
  /** Documents, best first: the find service's order, then quick finds. */
  docOrder: string[];
  deepLoading: boolean;
  preview: FindDoc | null;
  setPreview: (id: string | null) => void;
  docs: Record<string, FindDoc>;
  /** The search itself failed (not "nothing found"). */
  failed: boolean;
}

// What a search found, kept for a few minutes per workspace and words: a
// search run again (coming back to it, Back, retyping) answers at once.
const KEEP_MS = 5 * 60_000;
const quickSeen = new Map<string, { at: number; r: QuickFind }>();
const deepSeen = new Map<string, { at: number; r: DeepFind }>();
function seen<T>(m: Map<string, { at: number; r: T }>, k: string): T | null {
  const hit = m.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > KEEP_MS) { m.delete(k); return null; }
  return hit.r;
}
function keep<T>(m: Map<string, { at: number; r: T }>, k: string, r: T) {
  m.set(k, { at: Date.now(), r });
  if (m.size > 60) m.delete(m.keys().next().value as string);
}

/** How long results already on screen wait for the find service to answer
 *  the new words too, so they change once, not twice. */
const HOLD_MS = 700;

export function useFind(orgId: string | null, query: string, contextUnit: string | null, opts: { controller?: boolean } = {}): FindState {
  const q = useDebounced(query.trim(), 250);
  const qDeep = useDebounced(query.trim(), 400);
  // The last answers in (raw), and the pair on screen (shown): the shown
  // results change only when the quick and the deep answers agree on the
  // words, or after a short wait - never shrinking and growing back while
  // you type.
  const [quickRaw, setQuickRaw] = useState<QuickFind | null>(null);
  const [loading, setLoading] = useState(false);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [userPicked, setUserPicked] = useState(false);
  const [detail, setDetail] = useState<EquipDetail | null>(null);
  const [deepRaw, setDeepRaw] = useState<(DeepFind & { q: string }) | null>(null);
  const [deepLoading, setDeepLoading] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [wanted, setWanted] = useState<string | null>(null);
  // A failed search is said as such, never shown as "nothing matches".
  const [quickFailed, setQuickFailed] = useState(false);
  const [deepFailed, setDeepFailed] = useState(false);
  const scope = `${orgId}|${opts.controller ? 1 : 0}`;

  // ── Equipment, folders and documents by number: as you type ──────────
  useEffect(() => {
    if (!orgId || q.length < 2) { setQuickRaw(null); setPickedId(null); setUserPicked(false); setPreviewId(null); setLoading(false); return; }
    const k = `${scope}|${q}`;
    const had = seen(quickSeen, k);
    if (had) { setQuickRaw(had); setQuickFailed(false); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    findQuick(orgId, q, { controller: opts.controller })
      .then((r) => { keep(quickSeen, k, r); if (alive) { setQuickRaw(r); setQuickFailed(false); } })
      .catch(() => { if (alive) { setQuickRaw({ q, equipment: [], docs: {}, docOrder: [], folders: [] }); setQuickFailed(true); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [orgId, q, opts.controller, scope]);

  // ── The find service: when typing stops ──────────────────────────────
  useEffect(() => {
    if (!orgId || qDeep.length < 2) { setDeepRaw(null); setDeepLoading(false); return; }
    const k = `${orgId}|${qDeep}`;
    const had = seen(deepSeen, k);
    if (had) { setDeepRaw({ ...had, q: qDeep }); setDeepFailed(false); setDeepLoading(false); return; }
    let alive = true;
    setDeepLoading(true);
    findDeep(orgId, qDeep)
      .then((r) => { keep(deepSeen, k, r); if (alive) { setDeepRaw({ ...r, q: qDeep }); setDeepFailed(false); } })
      .catch(() => { if (alive) { setDeepRaw({ order: [], docs: {}, q: qDeep }); setDeepFailed(true); } })
      .finally(() => { if (alive) setDeepLoading(false); });
    return () => { alive = false; };
  }, [orgId, qDeep]);

  // ── What is on screen ────────────────────────────────────────────────
  const [shown, setShown] = useState<{ quick: QuickFind | null; deep: (DeepFind & { q: string }) | null }>({ quick: null, deep: null });
  const shownRef = useRef(shown);
  useEffect(() => { shownRef.current = shown; }, [shown]);
  useEffect(() => {
    if (!quickRaw) { setShown({ quick: null, deep: null }); return; }
    const deepFor = deepRaw && deepRaw.q === quickRaw.q ? deepRaw : null;
    const on = shownRef.current;
    // Nothing on screen yet, the deep answer is in, or these are the same
    // words: show now.
    if (deepFor || !on.quick || on.quick.q === quickRaw.q) { setShown({ quick: quickRaw, deep: deepFor ?? (on.deep && on.deep.q === quickRaw.q ? on.deep : null) }); return; }
    const t = window.setTimeout(() => setShown({ quick: quickRaw, deep: null }), HOLD_MS);
    return () => window.clearTimeout(t);
  }, [quickRaw, deepRaw]);
  const quick = shown.quick;
  const liveDeep = shown.deep;

  // New words on screen: what was picked for the old ones is dropped.
  const shownQ = quick?.q ?? "";
  useEffect(() => { setUserPicked(false); setPreviewId(null); }, [shownQ]);

  // ── Which one: the person's pick, else the folder's unit ─────────────
  const exact = useMemo(() => (quick ? exactTagMatches(quick.q, quick.equipment) : []), [quick]);
  useEffect(() => {
    if (!quick) return;
    if (wanted && quick.equipment.some((e) => e.id === wanted)) {
      setUserPicked(true); setPickedId(wanted); setWanted(null); setPreviewId(null);
      return;
    }
    if (userPicked) return;
    setPickedId(defaultPick(quick.q, quick.equipment, contextUnit));
  }, [quick, contextUnit, userPicked, wanted]);
  const picked = quick?.equipment.find((e) => e.id === pickedId) ?? null;
  const pickedByFolder = !!picked && !userPicked && exact.length > 1;

  // Quick and deep finds of the same document become one, with both whys.
  const docs = useMemo(() => {
    const out: Record<string, FindDoc> = { ...(liveDeep?.docs ?? {}) };
    for (const [id, d] of Object.entries(quick?.docs ?? {})) out[id] = out[id] ? { ...out[id], ...d, rels: out[id].rels, hit: out[id].hit } : d;
    return out;
  }, [quick, liveDeep]);

  const pickedDocIds = useMemo(() => {
    if (!picked) return [];
    const node = `asset:${picked.id}`;
    const more = (liveDeep?.order ?? []).filter((id) => docs[id]?.rels?.some((r) => r.node === node));
    const label = (id: string) => docs[id]?.number || docs[id]?.title || docs[id]?.name || "~";
    return [...new Set([...picked.docIds, ...more])].sort((a, b) => label(a).localeCompare(label(b), undefined, { numeric: true }));
  }, [picked, liveDeep, docs]);

  const docOrder = useMemo(() => {
    const out = [...(liveDeep?.order ?? [])];
    for (const id of quick?.docOrder ?? []) if (!out.includes(id)) out.push(id);
    return out;
  }, [quick, liveDeep]);

  // ── The picked equipment: what else is on its documents, work orders ─
  useEffect(() => {
    if (!orgId || !picked) { setDetail(null); return; }
    let alive = true;
    setDetail(null);
    const k = tagKey(picked.tag);
    const unique = (quick?.equipment ?? []).filter((e) => tagKey(e.tag) === k).length === 1;
    equipDetail(orgId, { ...picked, docIds: pickedDocIds }, unique)
      .then((d) => { if (alive) setDetail(d); })
      .catch(() => { if (alive) setDetail({ onSheet: {}, workOrders: [] }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, picked?.id, pickedDocIds.length]);

  // The first document of the picked equipment is shown without a tap.
  useEffect(() => {
    if (picked && !previewId && pickedDocIds.length) setPreviewId(pickedDocIds[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked?.id, pickedDocIds.length]);

  const preview = previewId ? docs[previewId] ?? null : null;

  return {
    q, loading: loading || q !== query.trim() || (q.length >= 2 && shownQ !== q), quick, exact, picked, pickedDocIds, pickedByFolder,
    pick: (id) => { setUserPicked(true); setPickedId(id); setPreviewId(null); },
    pickWhenFound: (id) => setWanted(id),
    detail, docOrder, deepLoading: deepLoading || qDeep !== query.trim() || (qDeep.length >= 2 && liveDeep?.q !== qDeep && !deepFailed),
    preview, setPreview: setPreviewId, docs,
    failed: q.length >= 2 && (quickFailed || deepFailed),
  };
}
