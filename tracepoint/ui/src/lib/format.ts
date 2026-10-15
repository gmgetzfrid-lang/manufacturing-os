export function bytes(n: number): string {
  if (n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export function dateFromSecs(s: number): string {
  if (!s) return "—";
  return new Date(s * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function when(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d ago`;
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fullDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export const n = (x: number) => x.toLocaleString();

export const CAT_VAR: Record<string, string> = {
  "Inspection / MI": "--cat-inspection",
  Drawings: "--cat-drawings",
  "P&ID": "--cat-pid",
  Datasheets: "--cat-datasheets",
  "Code Documents": "--cat-code",
  Calculations: "--cat-calc",
  "Service Reports": "--cat-service",
  "Procedures & Manuals": "--cat-procedures",
  "Certificates & MTRs": "--cat-certs",
  Photos: "--cat-photos",
  Email: "--cat-email",
  General: "--cat-general",
};
export const catColor = (c: string) => `var(${CAT_VAR[c] ?? "--cat-general"})`;

export function initials(name: string, email: string): string {
  const src = name.trim() || email.split("@")[0];
  const parts = src.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}
