"use client";

// useFind - the state of one search box: what was found, which equipment is
// picked (asked when a tag is on several units, picked for you when the
// folder you're in says which), what else is on its documents, the work
// orders for it, the documents the find service ranks (names, tags read off
// the sheets, words inside the pages), and the document being looked at.

import { useEffect, useMemo, useState } from "react";
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
  detail: EquipDetail | null;
  /** Documents, best first: the find service's order, then quick finds. */
  docOrder: string[];
  deepLoading: boolean;
  preview: FindDoc | null;
  setPreview: (id: string | null) => void;
  docs: Record<string, FindDoc>;
}

export function useFind(orgId: string | null, query: string, contextUnit: string | null, opts: { controller?: boolean } = {}): FindState {
  const q = useDebounced(query.trim(), 250);
  const qDeep = useDebounced(query.trim(), 600);
  const [quick, setQuick] = useState<QuickFind | null>(null);
  const [loading, setLoading] = useState(false);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [userPicked, setUserPicked] = useState(false);
  const [detail, setDetail] = useState<EquipDetail | null>(null);
  const [deep, setDeep] = useState<(DeepFind & { q: string }) | null>(null);
  const [deepLoading, setDeepLoading] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);

  // ── Equipment, folders and documents by number: as you type ──────────
  useEffect(() => {
    if (!orgId || q.length < 2) { setQuick(null); setPickedId(null); setUserPicked(false); setPreviewId(null); return; }
    let alive = true;
    setLoading(true);
    findQuick(orgId, q, { controller: opts.controller })
      .then((r) => { if (alive) { setQuick(r); setUserPicked(false); setPreviewId(null); } })
      .catch(() => { if (alive) setQuick({ q, equipment: [], docs: {}, docOrder: [], folders: [] }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [orgId, q, opts.controller]);

  // ── The find service: when typing stops ──────────────────────────────
  useEffect(() => {
    if (!orgId || qDeep.length < 2) { setDeep(null); return; }
    let alive = true;
    setDeepLoading(true);
    findDeep(orgId, qDeep)
      .then((r) => { if (alive) setDeep({ ...r, q: qDeep }); })
      .catch(() => { if (alive) setDeep({ order: [], docs: {}, q: qDeep }); })
      .finally(() => { if (alive) setDeepLoading(false); });
    return () => { alive = false; };
  }, [orgId, qDeep]);

  // ── Which one: the person's pick, else the folder's unit ─────────────
  const exact = useMemo(() => (quick ? exactTagMatches(quick.q, quick.equipment) : []), [quick]);
  useEffect(() => {
    if (!quick || userPicked) return;
    setPickedId(defaultPick(quick.q, quick.equipment, contextUnit));
  }, [quick, contextUnit, userPicked]);
  const picked = quick?.equipment.find((e) => e.id === pickedId) ?? null;
  const pickedByFolder = !!picked && !userPicked && exact.length > 1;

  // Quick and deep finds of the same document become one, with both whys.
  const liveDeep = deep && deep.q === q ? deep : null;
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
    q, loading: loading || q !== query.trim(), quick, exact, picked, pickedDocIds, pickedByFolder,
    pick: (id) => { setUserPicked(true); setPickedId(id); setPreviewId(null); },
    detail, docOrder, deepLoading: deepLoading || qDeep !== query.trim(),
    preview, setPreview: setPreviewId, docs,
  };
}
