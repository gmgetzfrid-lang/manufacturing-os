"use client";

// hooks/useThorSearch.ts — THOR results, page by page, a step ahead.
//
// One search = one key (query + filters). Pages of PAGE rows come from the
// thor_search RPC; the page after the one being read is fetched before it is
// needed, so fast scrolling rarely meets a gap. A new key aborts whatever the
// old one had in flight, and results are only ever shown for the current
// key. Nothing is held but the rows already shown.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildArgs, thorSearch, type ThorFile, type ThorFilters } from "@/lib/thor/client";
import type { ThorQuery } from "@/lib/thor/query";

const PAGE = 100;

export interface ThorSearchState {
  rows: ThorFile[];
  /** Matches, counted up to 10,000 — `capped` when there are more. */
  total: number;
  capped: boolean;
  loading: boolean;
  /** True while the first page of a new search is on its way. */
  searching: boolean;
  error: string | null;
  done: boolean;
  resolvedEquipment: string[] | null;
  tookMs: number | null;
  /** Ask for more (called by the list as its end comes near). */
  more: () => void;
}

interface Result {
  key: string;
  rows: ThorFile[];
  total: number;
  capped: boolean;
  first: boolean; // first page arrived
  loadingMore: boolean;
  error: string | null;
  resolvedEquipment: string[] | null;
  tookMs: number | null;
}

interface Live {
  key: string;
  ctrl: AbortController;
  args: (offset: number, limit: number) => ReturnType<typeof buildArgs>;
  next: number;
  /** Rows the list can still grow to; open-ended while the count is capped. */
  total: number;
  prefetch: Promise<ThorFile[]> | null;
  prefetchAt: number;
  busy: boolean;
}

function prefetchFrom(cur: Live, at: number) {
  cur.prefetchAt = at;
  cur.prefetch = thorSearch(cur.args(at, PAGE), cur.ctrl.signal).then((x) => x.rows);
  cur.prefetch.catch(() => undefined);
}

function filtersOn(f: ThorFilters): boolean {
  return !!(f.types.length || f.kinds.length || f.units.length || f.exts.length || f.equipment.length || f.roles.length
    || f.folder || f.nameContains || f.after || f.before || f.minSize != null || f.maxSize != null);
}

export function useThorSearch(orgId: string | null, q: ThorQuery | null, filters: ThorFilters, enabled: boolean, firstPage = PAGE): ThorSearchState {
  const key = useMemo(() => JSON.stringify({ orgId, terms: q?.terms, tags: q?.tags, units: q?.units, kinds: q?.kinds, types: q?.types, after: q?.after, before: q?.before, min: q?.minSize, max: q?.maxSize, sort: q?.sort, filters, firstPage }), [orgId, q, filters, firstPage]);
  const hasSomething = !!q && !!(q.terms.length || q.tags.length || q.units.length || q.kinds.length || q.types.length || q.after || q.before || q.minSize != null || q.maxSize != null);
  const active = enabled && !!orgId && (hasSomething || filtersOn(filters));

  const [res, setRes] = useState<Result | null>(null);
  const live = useRef<Live | null>(null);

  // A new search: first page, then the second fetched ahead.
  useEffect(() => {
    live.current?.ctrl.abort();
    if (!active) { live.current = null; return; }
    const ctrl = new AbortController();
    const args = (offset: number, limit: number) => buildArgs(orgId!, q, filters, { limit, offset });
    const cur: Live = { key, ctrl, args, next: 0, total: 0, prefetch: null, prefetchAt: -1, busy: false };
    live.current = cur;
    const t0 = performance.now();
    thorSearch(args(0, firstPage), ctrl.signal).then((p) => {
      if (live.current !== cur) return;
      cur.next = p.rows.length; cur.total = p.capped ? Number.MAX_SAFE_INTEGER : p.total;
      setRes({ key, rows: p.rows, total: p.total, capped: p.capped, first: true, loadingMore: false, error: null, resolvedEquipment: p.resolvedEquipment, tookMs: Math.round(performance.now() - t0) });
      if (p.rows.length < cur.total && p.rows.length === firstPage) prefetchFrom(cur, p.rows.length);
    }).catch((e) => {
      if (live.current !== cur || ctrl.signal.aborted) return;
      setRes({ key, rows: [], total: 0, capped: false, first: true, loadingMore: false, error: (e as Error).message, resolvedEquipment: null, tookMs: null });
    });
    return () => ctrl.abort();
  }, [key, active, firstPage, orgId, q, filters]);

  const more = useCallback(() => {
    const cur = live.current;
    if (!cur || cur.busy || cur.next === 0 || cur.next >= cur.total) return;
    cur.busy = true;
    const at = cur.next;
    setRes((r) => (r && r.key === cur.key ? { ...r, loadingMore: true } : r));
    const p = cur.prefetch && cur.prefetchAt === at ? cur.prefetch : thorSearch(cur.args(at, PAGE), cur.ctrl.signal).then((x) => x.rows);
    p.then((got) => {
      if (live.current !== cur) return;
      cur.next = at + got.length;
      // A short page is the end, whatever the (capped) count said.
      if (got.length < PAGE) cur.total = cur.next;
      setRes((r) => (r && r.key === cur.key ? { ...r, rows: [...r.rows, ...got], total: Math.max(r.total, cur.next), capped: r.capped && got.length === PAGE, loadingMore: false } : r));
      // Stay one page ahead.
      if (cur.next < cur.total) prefetchFrom(cur, cur.next); else cur.prefetch = null;
    }).catch((e) => {
      if (live.current === cur && !cur.ctrl.signal.aborted) setRes((r) => (r && r.key === cur.key ? { ...r, error: (e as Error).message, loadingMore: false } : r));
    }).finally(() => { cur.busy = false; });
  }, []);

  // Only the current search's results are ever shown.
  const mine = active && res?.key === key ? res : null;
  const searching = active && !mine;
  return {
    rows: mine?.rows ?? [],
    total: mine?.total ?? 0,
    capped: !!mine?.capped,
    loading: searching || !!mine?.loadingMore,
    searching,
    error: mine?.error ?? null,
    done: !!mine && !mine.capped && mine.rows.length >= mine.total,
    resolvedEquipment: mine?.resolvedEquipment ?? null,
    tookMs: mine?.tookMs ?? null,
    more,
  };
}
