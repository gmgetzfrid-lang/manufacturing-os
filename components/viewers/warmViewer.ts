// The full-size viewer's code (pdf.js, the markup tools) fetched before it
// is asked for, so opening a drawing does not wait on a download. Called
// when a document is picked or pointed at; once per session, when the
// browser is idle, so it never holds up what is being drawn right now.

let warm: Promise<unknown> | null = null;

export function warmViewer() {
  if (typeof window === "undefined" || warm) return;
  warm = new Promise<void>((resolve) => {
    const go = () => resolve();
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(go, { timeout: 1500 }); else window.setTimeout(go, 200);
  }).then(() => import("@/components/viewers/FullScreenViewer")).catch(() => { warm = null; });
}
