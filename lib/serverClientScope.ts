// lib/serverClientScope.ts
//
// SERVER-ONLY. A request-scoped binding of the shared `supabase` client
// (projects Round G, J1 — INTK-2 / DEC-56). lib/postPublish.ts,
// lib/notify/dispatch.ts and lib/intents.ts are written against the shared
// client; a route with no browser session (the external intake door) needs
// them to run as the service role. A module-wide swap
// (__setServerSupabaseClient) would also rebind every OTHER request the
// same instance is serving meanwhile — grouped routes and in-instance
// concurrency share a module. AsyncLocalStorage scopes the binding to the
// async context `fn` runs in: the promises it starts (and the
// fire-and-forget work they spawn) see the bound client; nothing else does.
//
// Never import this from a client component — node:async_hooks does not
// exist in the browser.

import { AsyncLocalStorage } from "node:async_hooks";
import { __registerScopedServerClient } from "@/lib/supabase";

const scope = new AsyncLocalStorage<unknown>();
__registerScopedServerClient(() => scope.getStore());

/** Run `fn` with the shared client resolving to `client` — for this async
 *  context only. */
export function runWithServerClient<T>(client: unknown, fn: () => Promise<T>): Promise<T> {
  return scope.run(client, fn);
}
