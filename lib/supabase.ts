import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// ─── "Keep me signed in" ──────────────────────────────────────────
// The login screen records the user's choice here before signing in. When the
// box is checked (the default) the session lives in localStorage and survives
// closing the browser — the historical behavior, so every already-signed-in
// user is completely unaffected. When unchecked, the session goes to
// sessionStorage and is cleared when the browser/tab closes.
const REMEMBER_KEY = "manufacturingos.rememberSession";

export function setRememberSession(remember: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(REMEMBER_KEY, remember ? "true" : "false");
  } catch {
    /* storage unavailable (private mode etc.) — fall back to default */
  }
}

function shouldRemember(): boolean {
  if (typeof window === "undefined") return true;
  try {
    // Absent flag → remember (preserves behavior for existing sessions).
    return window.localStorage.getItem(REMEMBER_KEY) !== "false";
  } catch {
    return true;
  }
}

// ─── Silent Microsoft auto sign-in ────────────────────────────────
// Set after a successful Microsoft sign-in so the login page can attempt a
// silent (prompt=none) sign-in on the next visit — giving "open the app and
// you're already in" for users whose Windows/M365 session is still active.
// Cleared on an explicit sign-out so logging out is never undone by auto
// sign-in (a session that merely expired keeps the flag).
const PREFER_MS_KEY = "manufacturingos.preferMicrosoft";

export function setPreferMicrosoft(prefer: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (prefer) window.localStorage.setItem(PREFER_MS_KEY, "true");
    else window.localStorage.removeItem(PREFER_MS_KEY);
  } catch {
    /* ignore */
  }
}

export function prefersMicrosoft(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PREFER_MS_KEY) === "true";
  } catch {
    return false;
  }
}

// Storage adapter that honors the "keep me signed in" choice. Reads check both
// stores so an existing localStorage session is always found; writes land in
// whichever store the user's choice dictates. Every method is a no-op without a
// `window`, so it is safe to construct during SSR.
const hybridAuthStorage = {
  getItem(key: string): string | null {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    if (typeof window === "undefined") return;
    try {
      if (shouldRemember()) {
        window.localStorage.setItem(key, value);
        window.sessionStorage.removeItem(key);
      } else {
        window.sessionStorage.setItem(key, value);
        window.localStorage.removeItem(key);
      }
    } catch {
      /* ignore */
    }
  },
  removeItem(key: string): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(key);
      window.sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

const authOptions = {
  persistSession: true,
  autoRefreshToken: true,
  // Required for the OAuth (Microsoft) redirect to be picked up client-side.
  detectSessionInUrl: true,
  storage: hybridAuthStorage,
};

export const supabase = createClient(url, anon, { auth: authOptions });

// Back-compat: this module used to hand out a lazily-created second client.
// There is now a single shared instance (so there is only ever one auth /
// token-refresh loop, which also keeps the OAuth redirect handling clean).
export function getSupabase() {
  return supabase;
}
