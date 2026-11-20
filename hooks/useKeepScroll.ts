"use client";

// Keep your place: the app scrolls inside <main>, not the window, so the
// browser can't restore the spot on Back. This saves each page's scroll
// position and puts it back on Back/Forward; a new page opens at the top.
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

const KEY = (path: string) => `scroll:${path}`;
const here = () => (typeof window === "undefined" ? "" : window.location.pathname + window.location.search);

export function useKeepScroll(el: HTMLElement | null) {
  const pathname = usePathname();
  const popped = useRef(0);
  // Which page the scroll belongs to, and whether to listen right now: not
  // while a page swaps in (its height jumps) or while a spot is put back.
  const page = useRef<string>("");
  const listening = useRef(false);

  useEffect(() => {
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      if (!listening.current || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!listening.current || !page.current) return;
        try { sessionStorage.setItem(KEY(page.current), String(Math.round(el.scrollTop))); } catch { /* private mode */ }
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { el.removeEventListener("scroll", onScroll); if (frame) cancelAnimationFrame(frame); };
  }, [el]);

  // Back/Forward is a popstate; a link is not. Stop saving at once: the old
  // page is about to be replaced and its spot must stay as it was.
  useEffect(() => {
    // A stale mark (over a second old) is ignored.
    const onPop = () => { popped.current = Date.now(); listening.current = false; };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]");
      if (!a || (a as HTMLAnchorElement).origin !== window.location.origin) return;
      listening.current = false;
      // Still on the same page a moment later (a new tab, a link to this
      // page): carry on saving.
      const was = page.current;
      window.setTimeout(() => { if (page.current === was) { page.current = here(); listening.current = true; } }, 1500);
    };
    window.addEventListener("popstate", onPop, true);
    document.addEventListener("click", onClick, true);
    return () => { window.removeEventListener("popstate", onPop, true); document.removeEventListener("click", onClick, true); };
  }, []);

  useEffect(() => {
    if (!el) return;
    listening.current = false;
    page.current = here();
    let stop = false;
    let t = 0;
    const cleanups: Array<() => void> = [];
    // Next swaps the page in before the Back event reaches anyone, so decide
    // a moment later whether this was Back/Forward.
    t = window.setTimeout(() => {
      if (stop) return;
      const back = Date.now() - popped.current < 1000;
      popped.current = 0;
      let want = 0;
      if (back) { try { want = Number(sessionStorage.getItem(KEY(page.current)) ?? 0) || 0; } catch { /* private mode */ } }
      if (want <= 0) {
        if (!back) el.scrollTo({ top: 0 });
        listening.current = true;
        return;
      }
      // The page fills in as its data loads: keep trying for a moment, and
      // stop the moment you scroll yourself.
      const quit = () => { stop = true; listening.current = true; };
      el.addEventListener("wheel", quit, { passive: true, once: true });
      el.addEventListener("touchstart", quit, { passive: true, once: true });
      cleanups.push(() => { el.removeEventListener("wheel", quit); el.removeEventListener("touchstart", quit); });
      const started = Date.now();
      const tick = () => {
        if (stop) return;
        el.scrollTo({ top: want });
        if (Math.abs(el.scrollTop - want) < 2 || Date.now() - started > 4000) { listening.current = true; return; }
        requestAnimationFrame(tick);
      };
      tick();
    }, 50);
    // A new page opens at the top straight away.
    if (Date.now() - popped.current >= 1000) el.scrollTo({ top: 0 });
    return () => { stop = true; clearTimeout(t); cleanups.forEach((f) => f()); };
  }, [pathname, el]);
}
