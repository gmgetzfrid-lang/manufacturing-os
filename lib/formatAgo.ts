// The cockpit's compact age ("now", "5m", "3h", "2d", then the date).
// Its own module so the notification center's feed (components/cockpit/
// AttentionFeed.tsx, in the app shell) does not pull the whole Command Deck
// into every route (projects-tab PERF-12, projects-joint J18).
// components/cockpit/CommandDeck.tsx re-exports it unchanged.

export function formatAgo(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return "now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}
