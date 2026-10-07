// PERF-5 harness: stands in for lib/supabase in the bundle — every query
// answers an empty list, so the board renders the harness's own rows.
type Answer = { data: unknown[]; error: null };
const ok: Answer = { data: [], error: null };
type Chain = ((...args: unknown[]) => Chain) & { [key: string]: unknown };
const chain: Chain = new Proxy((() => undefined) as unknown as Chain, {
  get(_target, prop) {
    if (prop === "then") return (resolve: (v: Answer) => void) => resolve(ok);
    return () => chain;
  },
  apply() { return chain; },
});
const channel = { on() { return channel; }, subscribe() { return channel; } };
export const supabase = {
  from: () => chain,
  rpc: async () => ok,
  auth: {
    getSession: async () => ({ data: { session: null } }),
    getUser: async () => ({ data: { user: null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
  channel: () => channel,
  removeChannel() {},
};
export default supabase;
