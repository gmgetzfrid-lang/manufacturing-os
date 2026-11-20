// lib/badge.ts
// A count badge never grows past three characters, so its shape holds.
export function badgeText(n: number): string {
  return n > 99 ? "99+" : String(Math.max(0, Math.floor(n)));
}
