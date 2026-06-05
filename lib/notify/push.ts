// lib/notify/push.ts
//
// Browser push delivery. Phase 5 fills this in (service worker + web-push +
// VAPID keys + a push_subscriptions table). For now it is a deliberate,
// fully fail-safe no-op so the dispatcher can list "push" as a channel today
// with zero risk.
//
// CONTRACT (must hold even after Phase 5):
//   • never throws into the caller
//   • never blocks the in-app or email channels
//   • absence of VAPID env / push_subscriptions is a silent no-op
// This is what "include push but don't let it break anything" means in code.

export interface PushPayload {
  orgId: string;
  userIds: string[];
  title: string;
  body?: string;
  link?: string;
}

export async function sendPushSafe(payload: PushPayload): Promise<void> {
  // Intentionally a no-op until Phase 5. `void` marks the param as used so the
  // signature is stable for callers (and linters stay quiet).
  void payload;
  return;
}
