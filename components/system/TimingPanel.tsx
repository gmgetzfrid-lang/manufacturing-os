"use client";

// The timing view, opened with ?timing=1 (and kept for the tab until
// ?timing=0 or Hide timing): a small panel listing each data request on
// the screen now (the table or route, its time and its rows) and how long
// the screen took to show its content, so real numbers from a real
// network can be read off a screenshot. It never shows addresses with
// their queries, ids, tokens, keys or anyone's data: only table and route
// names, times and row counts (lib/requestLog).

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { onTimedRequest, timedRequests, timingOff, whatOf, type TimedRequest } from "@/lib/requestLog";
import { btnQuiet } from "@/components/admin/kit";

const ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The screen shows its content: no loading bars or busy regions (in
 *  view only, or anywhere on the page), and words in the page. */
function contentShown(inViewOnly: boolean): boolean {
  const seen = (e: Element) => {
    if (e.getClientRects().length === 0) return false;
    if (!inViewOnly) return true;
    const r = e.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  };
  for (const e of document.querySelectorAll(".ui-skeleton")) if (seen(e)) return false;
  for (const e of document.querySelectorAll('[aria-busy="true"]')) if (seen(e)) return false;
  const root = document.querySelector("main") ?? document.body;
  return (root.textContent ?? "").trim().length > 0;
}

// The app's own routes (/api/...) go through the browser's fetch, not the
// database client: time those too while the view is open. Only the path,
// with ids folded away, is kept.
const apiLog: TimedRequest[] = [];
const apiListeners = new Set<() => void>();
let apiSeq = 1_000_000;
let patched = false;
function patchFetch() {
  if (patched || typeof window === "undefined") return;
  patched = true;
  const real = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let path = "";
    try { const u = new URL(url, window.location.origin); if (u.origin === window.location.origin) path = u.pathname; } catch { /* not ours */ }
    if (!path.startsWith("/api/")) return real(input, init);
    const e: TimedRequest = { id: ++apiSeq, at: performance.now(), ms: null, what: whatOf(path), method: (init?.method ?? "GET").toUpperCase(), rows: null, status: null };
    apiLog.push(e);
    if (apiLog.length > 200) apiLog.shift();
    apiListeners.forEach((f) => f());
    return real(input, init).then((res) => {
      e.ms = Math.round(performance.now() - e.at); e.status = res.status;
      apiListeners.forEach((f) => f());
      return res;
    }, (err: unknown) => {
      e.ms = Math.round(performance.now() - e.at); e.status = 0;
      apiListeners.forEach((f) => f());
      throw err;
    });
  };
}

// This module loads only in the browser, only with the view open.
if (typeof window !== "undefined") patchFetch();

let version = 0;
const subscribe = (fn: () => void) => {
  const bump = () => { version++; fn(); };
  apiListeners.add(bump);
  const off = onTimedRequest(bump);
  return () => { apiListeners.delete(bump); off(); };
};
const snapshot = () => version;

export default function TimingPanel() {
  const pathname = usePathname() ?? "/";
  const v = useSyncExternalStore(subscribe, snapshot, () => 0);
  // When the screen was asked for: the last press or key just before the
  // address changed (a click, Sign in), else the change itself; the first
  // screen counts from the page load.
  const lastAction = useRef(0);
  useEffect(() => {
    const mark = () => { lastAction.current = performance.now(); };
    window.addEventListener("pointerdown", mark, true);
    window.addEventListener("keydown", mark, true);
    window.addEventListener("submit", mark, true);
    return () => {
      window.removeEventListener("pointerdown", mark, true);
      window.removeEventListener("keydown", mark, true);
      window.removeEventListener("submit", mark, true);
    };
  }, []);
  // firstMs: the first screenful shown (nothing loading in view);
  // shownMs: everything on the page loaded.
  const [screen, setScreen] = useState<{ path: string; t0: number; firstMs: number | null; shownMs: number | null }>({ path: pathname, t0: 0, firstMs: null, shownMs: null });
  const first = useRef(true);
  useEffect(() => {
    const now = performance.now();
    const t0 = first.current ? 0 : (now - lastAction.current < 5000 ? lastAction.current : now);
    first.current = false;
    let alive = true;
    let raf = 0;
    let firstMs: number | null = null;
    const started = performance.now();
    const tick = () => {
      if (!alive) return;
      const now = Math.round(performance.now() - t0);
      if (firstMs === null && contentShown(true)) { firstMs = now; setScreen({ path: pathname, t0, firstMs, shownMs: null }); }
      if (firstMs !== null && contentShown(false)) { setScreen({ path: pathname, t0, firstMs, shownMs: now }); return; }
      if (performance.now() - started > 30_000) return;
      raf = requestAnimationFrame(tick);
    };
    // Set in a callback (not during the effect body), then watch for content.
    raf = requestAnimationFrame(() => { setScreen({ path: pathname, t0, firstMs: null, shownMs: null }); tick(); });
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [pathname]);

  const rows = useMemo(() => {
    void v;
    return [...timedRequests(), ...apiLog]
      .filter((r) => r.at >= screen.t0 - 1)
      .sort((a, b) => a.at - b.at);
  }, [v, screen.t0]);
  const [open, setOpen] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [copied, setCopied] = useState(false);
  if (hidden) return null;

  const route = screen.path.replace(ID, ":id");
  const own = rows.filter((r) => !r.shared);
  const slowest = own.reduce((m, r) => Math.max(m, r.ms ?? 0), 0);
  const waiting = own.filter((r) => r.ms === null).length;
  const shownWords = screen.firstMs === null ? "Content: still loading"
    : `First content in ${screen.firstMs} ms, ${screen.shownMs === null ? "the rest still loading" : `all loaded in ${screen.shownMs} ms`}`;
  const summary = [
    `Screen ${route}`,
    shownWords,
    `${own.length} requests${rows.length > own.length ? `, ${rows.length - own.length} answered by one already on its way` : ""}, slowest ${slowest} ms`,
    ...rows.map((r) => `+${Math.round(r.at - screen.t0)} ms  ${r.what}${r.method !== "GET" ? ` (${r.method})` : ""}  ${r.ms === null ? "waiting" : `${r.ms} ms`}${r.rows !== null ? `  ${r.rows} rows` : ""}${r.count != null ? `  count ${r.count}` : ""}${r.shared ? "  shared" : ""}${r.status && r.status >= 400 ? `  status ${r.status}` : ""}`),
  ].join("\n");

  return (
    <section aria-label="Timing" className="fixed z-[200] left-4 bottom-4 w-[min(380px,calc(100vw-32px))] max-h-[60vh] flex flex-col rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] ui-float">
      <div className="px-3 pt-2.5 pb-2 border-b border-[var(--color-border)]">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-body font-semibold truncate">Timing <span className="font-normal text-[var(--color-text-muted)]">{route}</span></h2>
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-body font-medium text-[var(--color-accent-text)] hover:underline min-h-8 pointer-coarse:min-h-11 shrink-0">
            {open ? "Fold" : "Open"}
          </button>
        </div>
        <p className="text-body tabular-nums">
          {screen.firstMs === null ? "Content: still loading" : <>First content in <b>{screen.firstMs} ms</b>{screen.shownMs === null ? ", the rest still loading" : <>, all loaded in <b>{screen.shownMs} ms</b></>}</>}
        </p>
        <p className="text-caption text-[var(--color-text-muted)] tabular-nums">
          {own.length} {own.length === 1 ? "request" : "requests"}
          {rows.length > own.length ? `, ${rows.length - own.length} shared` : ""}
          {waiting ? `, ${waiting} waiting` : ""}, slowest {slowest} ms
        </p>
      </div>
      {open && (
        <>
          <ol className="flex-1 min-h-0 overflow-y-auto px-3 py-1.5 text-caption tabular-nums">
            {rows.length === 0 && <li className="py-1 text-[var(--color-text-muted)]">No data requests on this screen yet.</li>}
            {rows.slice(-80).map((r) => (
              <li key={r.id} className="py-0.5 flex items-baseline gap-2">
                <span className="w-12 shrink-0 text-right text-[var(--color-text-muted)]">+{Math.round(r.at - screen.t0)}</span>
                <span className="flex-1 min-w-0 truncate">{r.what}{r.method !== "GET" && r.method !== "HEAD" ? ` (${r.method})` : ""}{r.shared ? " · shared" : ""}{r.status && r.status >= 400 ? ` · ${r.status}` : ""}</span>
                <span className="w-14 shrink-0 text-right">{r.ms === null ? "…" : `${r.ms} ms`}</span>
                <span className="w-16 shrink-0 text-right text-[var(--color-text-muted)]">{r.count != null ? `count ${r.count}` : r.rows === null ? "" : `${r.rows} ${r.rows === 1 ? "row" : "rows"}`}</span>
              </li>
            ))}
          </ol>
          <div className="px-3 py-2 border-t border-[var(--color-border)] flex gap-2">
            <button type="button" className={btnQuiet} onClick={() => {
              void navigator.clipboard?.writeText(summary).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined);
            }}>{copied ? "Copied the timings" : "Copy timings"}</button>
            <button type="button" className={btnQuiet} onClick={() => { timingOff(); setHidden(true); }}>Hide timing</button>
          </div>
        </>
      )}
    </section>
  );
}
