// lib/viewTransition.ts: moving between views feels continuous.
//
// Where the browser has the View Transitions API (Chrome, Edge, Safari
// 18+) and the person hasn't asked for reduced motion, a route change or a
// state change runs inside document.startViewTransition: the old view is
// held as a picture while the new one renders, then they cross-fade (the
// CSS is in globals.css: the page content rises a few pixels, the side menu
// and top bar hold still). Anywhere else the change is instant. Nothing
// ever waits on the animation.
//
//   onTransitionClick(e, () => router.push(href))   // a <Link> onClick
//   transitionPush(router, href)                    // code that navigates
//   withViewTransition(() => flushSync(() => setTab(t)))   // a state change

import type { MouseEvent as ReactMouseEvent } from "react";

type StartViewTransition =(update: () => void | Promise<void>) => { finished: Promise<void> };

/** True when the person asked the system for less motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function starter(): StartViewTransition | null {
  if (typeof document === "undefined" || prefersReducedMotion()) return null;
  const d = document as Document & { startViewTransition?: StartViewTransition };
  return typeof d.startViewTransition === "function" ? d.startViewTransition.bind(document) : null;
}

/** True when a change would be animated here. */
export function canViewTransition(): boolean {
  return starter() !== null;
}

/** Run a change inside a view transition when the browser can, else at
 *  once. `update` must change the DOM before it returns (wrap a React
 *  state change in flushSync), or return a promise that settles once it
 *  has. */
export function withViewTransition(update: () => void | Promise<void>): void {
  const start = starter();
  if (!start) { void update(); return; }
  try {
    start(update).finished.catch(() => { /* an interrupted transition is fine */ });
  } catch {
    void update();
  }
}

/** Longest we hold the old picture while the new route renders. Past this
 *  the cross-fade runs anyway and the page finishes in place. */
const ROUTE_WAIT_MS = 350;

/** Navigate inside a view transition. The old view is held until the
 *  address changes (the new route has rendered) or for at most 350 ms. */
export function transitionNavigate(navigate: () => void): void {
  const start = starter();
  if (!start) { navigate(); return; }
  const before = window.location.pathname + window.location.search;
  try {
    start(() => new Promise<void>((resolve) => {
      navigate();
      const t0 = performance.now();
      // Rendering is paused during the update, so poll with timers (not
      // animation frames) for the address to change.
      const tick = () => {
        const now = window.location.pathname + window.location.search;
        if (now !== before || performance.now() - t0 > ROUTE_WAIT_MS) { resolve(); return; }
        window.setTimeout(tick, 16);
      };
      window.setTimeout(tick, 16);
    })).finished.catch(() => { /* fine */ });
  } catch {
    navigate();
  }
}

/** router.push inside a view transition. */
export function transitionPush(router: { push: (href: string) => void }, href: string): void {
  transitionNavigate(() => router.push(href));
}

/** For a link's onClick: an ordinary left click navigates inside a view
 *  transition; a click that opens a new tab or window (Ctrl, Cmd, Shift,
 *  middle button), a download or an outside link is left to the browser. */
export function onTransitionClick(e: ReactMouseEvent<HTMLElement>, navigate: () => void): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.currentTarget as HTMLElement;
  if (a instanceof HTMLAnchorElement && ((a.target && a.target !== "_self") || a.hasAttribute("download"))) return;
  if (!canViewTransition()) return; // the Link navigates as usual
  e.preventDefault();
  transitionNavigate(navigate);
}
