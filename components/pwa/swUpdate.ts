// components/pwa/swUpdate.ts — "a newer build exists": the shared state and
// the one reload path, in a leaf module (TAX-15, notifications Round G N3).
//
// Two files read it, and neither imports the other statically:
//
//   * components/pwa/ServiceWorkerManager.tsx registers the worker, reports a
//     waiting one here (`reportWaitingWorker`) and, on a page without the
//     protected shell, renders the update prompt.
//   * components/system/UpdatePill.tsx is the one component that says it —
//     fed by its own build-id poll and by the waiting worker read here — and
//     its tap goes through `loadLatestBuild`.
//
// It imports nothing, so it can never put either of them in the other's
// chunk, and nothing here can fail to load on its own.

/** The one wording for "a newer build exists" (TAX-15). It used to be two:
 *  "This tab is running an old version — tap to load the update" (the build
 *  pill) and "Update available — tap to refresh" (the service worker's
 *  button). */
export const UPDATE_PROMPT_TEXT = "A newer version of the app is available — tap to load it";

/** The prompt's place (top-centre) and look — UpdatePill's, and the same on
 *  ServiceWorkerManager's fallback button. */
export const UPDATE_PROMPT_WRAP_CLASS = "fixed top-3 left-1/2 -translate-x-1/2 z-[100] animate-pop";
export const UPDATE_PROMPT_BUTTON_CLASS = "inline-flex items-center gap-2 rounded-full border-2 border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/95 px-4 py-2 text-xs font-black text-amber-900 dark:text-amber-200 shadow-xl hover:bg-amber-100 dark:hover:bg-amber-900 transition-colors";

/** How long the update button waits for the new worker to take control
 *  before reloading anyway (OFF-4). */
export const UPDATE_RELOAD_FALLBACK_MS = 3000;

export type UpdateEnv = {
  serviceWorker: { addEventListener: (type: "controllerchange", listener: () => void) => void } | null;
  reload: () => void;
  setTimeout: (cb: () => void, ms: number) => unknown;
};

/** OFF-4: tell the waiting worker to take over and reload once it controls
 *  the page — or after UPDATE_RELOAD_FALLBACK_MS regardless, so a worker that
 *  already activated (another tab tapped first) or never answers still leaves
 *  the user on the new build. Reloads exactly once. */
export function applyServiceWorkerUpdate(waiting: { postMessage: (message: unknown) => void } | null, env: UpdateEnv): void {
  let done = false;
  const reload = () => {
    if (done) return;
    done = true;
    env.reload();
  };
  if (!waiting || !env.serviceWorker) {
    reload();
    return;
  }
  env.serviceWorker.addEventListener("controllerchange", reload);
  env.setTimeout(reload, UPDATE_RELOAD_FALLBACK_MS);
  try {
    waiting.postMessage("SKIP_WAITING");
  } catch {
    reload();
  }
}

/** The update prompt's tap (components/system/UpdatePill.tsx). Every deploy
 *  now leaves a waiting worker (OFF-4: no install-time takeover; OFF-11: sw.js
 *  changes per build), and a plain reload keeps the old worker in control, so
 *  the prompt asks the registration for its waiting worker and activates it —
 *  otherwise the prompt reappeared right after the user updated. No
 *  registration, no waiting worker or a failed lookup: reload. */
export async function loadLatestBuild(
  env: UpdateEnv & { getRegistration: (() => Promise<{ waiting: { postMessage: (message: unknown) => void } | null } | undefined>) | null },
): Promise<void> {
  let waiting: { postMessage: (message: unknown) => void } | null = null;
  try {
    waiting = (await env.getRegistration?.())?.waiting ?? null;
  } catch {
    waiting = null;
  }
  applyServiceWorkerUpdate(waiting, env);
}

/** `loadLatestBuild` against this tab's own service worker and location. */
export function loadLatestBuildInThisTab(): Promise<void> {
  const sw = typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : null;
  return loadLatestBuild({
    serviceWorker: sw,
    getRegistration: sw ? () => sw.getRegistration() : null,
    reload: () => window.location.reload(),
    setTimeout: (cb, ms) => window.setTimeout(cb, ms),
  });
}

// ── The waiting-worker signal ──────────────────────────────────────────────
// Module level: the worker is registered once per tab (ServiceWorkerManager),
// and the update prompt reads the answer wherever it is mounted.
let workerWaiting = false;
const workerListeners = new Set<() => void>();

/** Subscribe to "a new worker is installed and waiting". */
export function subscribeWaitingWorker(cb: () => void): () => void {
  workerListeners.add(cb);
  return () => { workerListeners.delete(cb); };
}

/** Whether a new worker is installed and waiting (a newer build exists). */
export function waitingWorkerSnapshot(): boolean {
  return workerWaiting;
}

/** ServiceWorkerManager's report: a new worker is installed and waiting. */
export function reportWaitingWorker(): void {
  if (workerWaiting) return;
  workerWaiting = true;
  for (const l of workerListeners) {
    try { l(); } catch { /* a bad listener must not break the others */ }
  }
}

/** Test seam: forget the waiting-worker signal (jsdom tests share the module). */
export function __resetWaitingWorkerForTests(): void {
  workerWaiting = false;
  for (const l of workerListeners) {
    try { l(); } catch { /* ignore */ }
  }
}

// ── The protected shell's prompt ───────────────────────────────────────────
// The shell mounts UpdatePill (it polls and owns the prompt); any other
// instance — ServiceWorkerManager's on a page without the shell — stands down
// while one is mounted: one prompt at a time.
let shellInstances = 0;
const shellListeners = new Set<() => void>();
function emitShell() {
  for (const l of shellListeners) {
    try { l(); } catch { /* ignore */ }
  }
}

/** The shell's UpdatePill registers while mounted; returns the release. */
export function registerUpdatePromptShell(): () => void {
  shellInstances++;
  emitShell();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    shellInstances--;
    emitShell();
  };
}

export function subscribeUpdatePromptShell(cb: () => void): () => void {
  shellListeners.add(cb);
  return () => { shellListeners.delete(cb); };
}

/** Whether the protected shell's prompt is mounted. */
export function updatePromptShellMounted(): boolean {
  return shellInstances > 0;
}
