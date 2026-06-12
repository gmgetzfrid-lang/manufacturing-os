// lib/askEngine.ts
//
// The cockpit's "ask" half: deterministic intent parsing over a small,
// closed question domain, executed against the live engines that
// already exist (checkouts, holds, collision analysis, global search).
// No AI, no egress — every answer IS real rows, with links to the
// surface that owns them.
//
// parseAsk() is pure (unit-tested); runAsk() does the data access.

import { supabase } from "@/lib/supabase";
import { listAllActiveCheckouts } from "@/lib/projects";
import { analyzeCheckoutCoordination } from "@/lib/consolidation";
import { listActiveHoldsForOrg, getHoldMetrics } from "@/lib/holds";
import { globalSearch } from "@/lib/globalSearch";
import type { DailyBrief } from "@/lib/notes";

export type AskIntent =
  | { kind: "who-has"; subject: string }
  | { kind: "blocked" }
  | { kind: "overdue" }
  | { kind: "collisions" }
  | { kind: "find"; subject: string };

export interface AskLine {
  text: string;
  href?: string;
  strong?: boolean;
}

export interface AskAnswer {
  title: string;
  lines: AskLine[];
  /** Where to go for the full picture. */
  more?: { label: string; href: string };
}

// ─── Intent parsing (pure) ──────────────────────────────────────

export function parseAsk(qRaw: string): AskIntent {
  const q = qRaw.trim().replace(/\?+\s*$/, "").trim();

  const who = q.match(/^who(?:'?s| is| has)?\s+(?:got\s+|holding\s+|checked\s+out\s+|locked\s+)?(.+)$/i);
  if (who) {
    const subject = who[1].replace(/^(got|has|holding|checked\s+out)\s+/i, "").replace(/\s+checked\s+out$/i, "").trim();
    return { kind: "who-has", subject };
  }
  if (/\b(blocked|blockers?|holds?)\b/i.test(q)) return { kind: "blocked" };
  if (/\b(overdue|late)\b/i.test(q)) return { kind: "overdue" };
  if (/\b(collisions?|overlaps?|conflicts?)\b/i.test(q)) return { kind: "collisions" };

  const find = q.match(/^(?:find|search(?:\s+for)?|where(?:'?s| is)?|show(?:\s+me)?|look\s*up|lookup)\s+(.+)$/i);
  if (find) return { kind: "find", subject: find[1].trim() };

  return { kind: "find", subject: q };
}

// ─── Execution ──────────────────────────────────────────────────

export interface AskContext {
  orgId: string;
  /** The already-loaded daily brief, so "what's overdue" answers
   *  without a refetch. */
  brief?: DailyBrief | null;
}

function fmtSince(ts: Date | number | string | null | undefined): string {
  if (ts === null || ts === undefined) return "—";
  try {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

export async function runAsk(ctx: AskContext, intent: AskIntent): Promise<AskAnswer> {
  switch (intent.kind) {
    case "who-has": return whoHas(ctx.orgId, intent.subject);
    case "blocked": return blocked(ctx.orgId);
    case "overdue": return overdue(ctx);
    case "collisions": return collisions(ctx.orgId);
    case "find": return find(ctx.orgId, intent.subject);
  }
}

async function whoHas(orgId: string, subject: string): Promise<AskAnswer> {
  const sessions = await listAllActiveCheckouts(orgId);
  if (sessions.length === 0) {
    return {
      title: "Nobody has anything checked out right now",
      lines: [],
      more: { label: "Open checkouts", href: "/checkouts" },
    };
  }

  // Resolve doc titles for the active sessions in one query.
  const docIds = Array.from(new Set(sessions.map((s) => s.documentId).filter(Boolean)));
  const titleById = new Map<string, string>();
  try {
    const { data } = await supabase.from("documents").select("id, title").in("id", docIds);
    for (const row of (data as Array<{ id: string; title: string }>) ?? []) titleById.set(row.id, row.title);
  } catch { /* titles stay blank */ }

  const s = subject.trim().toLowerCase();
  let matchedDocIds: Set<string> | null = null;
  if (s) {
    matchedDocIds = new Set(
      Array.from(titleById.entries())
        .filter(([, title]) => title.toLowerCase().includes(s))
        .map(([id]) => id),
    );
    // Also match via equipment-tag links (document_assets.tag_text).
    try {
      const { data } = await supabase
        .from("document_assets")
        .select("document_id, tag_text")
        .in("document_id", docIds)
        .ilike("tag_text", `%${subject.trim()}%`);
      for (const row of (data as Array<{ document_id: string }>) ?? []) matchedDocIds.add(row.document_id);
    } catch { /* tag matching unavailable */ }
  }

  const hits = sessions.filter((sess) =>
    !matchedDocIds
      ? true
      : matchedDocIds.has(sess.documentId) || (sess.userName ?? "").toLowerCase().includes(s),
  );

  if (hits.length === 0) {
    return {
      title: `No active checkouts match “${subject}”`,
      lines: [{ text: `${sessions.length} active checkout${sessions.length === 1 ? "" : "s"} total — none touch that.` }],
      more: { label: "See all checkouts", href: "/checkouts" },
    };
  }

  return {
    title: s
      ? `${hits.length} active checkout${hits.length === 1 ? "" : "s"} touching “${subject}”`
      : `${hits.length} active checkout${hits.length === 1 ? "" : "s"}`,
    lines: hits.slice(0, 6).map((sess) => ({
      text: `${sess.userName ?? "Someone"} — ${titleById.get(sess.documentId) ?? "a document"} · since ${fmtSince(sess.startedAt)}`,
      href: "/checkouts",
    })),
    more: { label: "Open checkouts", href: "/checkouts" },
  };
}

async function blocked(orgId: string): Promise<AskAnswer> {
  const [holds, metrics] = await Promise.all([
    listActiveHoldsForOrg(orgId, { limit: 6 }),
    getHoldMetrics(orgId).catch(() => null),
  ]);
  if (holds.length === 0) {
    return { title: "Nothing is blocked right now", lines: [], more: { label: "Holds", href: "/admin/holds" } };
  }
  return {
    title: `${metrics?.activeCount ?? holds.length} active hold${(metrics?.activeCount ?? holds.length) === 1 ? "" : "s"}${metrics && metrics.longestActiveDays > 0 ? ` — oldest ${metrics.longestActiveDays}d` : ""}`,
    lines: holds.map((h) => ({
      text: `${h.reason}${h.openedByName ? ` — opened by ${h.openedByName}` : ""} · since ${fmtSince(h.openedAt)}`,
      href: "/admin/holds",
    })),
    more: { label: "All holds", href: "/admin/holds" },
  };
}

async function overdue(ctx: AskContext): Promise<AskAnswer> {
  const brief = ctx.brief;
  if (!brief) {
    return { title: "Your brief is still loading — try again in a second", lines: [] };
  }
  if (brief.totals.overdue === 0) {
    return { title: "Nothing overdue. Savor it.", lines: [] };
  }
  return {
    title: `${brief.totals.overdue} overdue task${brief.totals.overdue === 1 ? "" : "s"}`,
    lines: brief.overdue.slice(0, 6).map(({ task }) => ({
      text: `${task.dueText ? task.body.replace(task.dueText, "").replace(/\s{2,}/g, " ").trim() : task.body}${task.dueAt ? ` — due ${task.dueAt}` : ""}`,
    })),
  };
}

async function collisions(orgId: string): Promise<AskAnswer> {
  const sessions = await listAllActiveCheckouts(orgId);
  const analysis = await analyzeCheckoutCoordination({ activeCheckouts: sessions });
  if (analysis.overlaps.length === 0) {
    return {
      title: `No scope collisions — compared ${analysis.comparableDocuments} scope-linked document${analysis.comparableDocuments === 1 ? "" : "s"} across ${analysis.activeCheckouts} checkout${analysis.activeCheckouts === 1 ? "" : "s"}`,
      lines: [],
      more: { label: "Coordination board", href: "/coordination" },
    };
  }
  return {
    title: `${analysis.overlaps.length} scope collision${analysis.overlaps.length === 1 ? "" : "s"} active`,
    lines: analysis.overlaps.slice(0, 5).map((o) => ({
      text: o.kind === "asset"
        ? `Asset ${o.assetTag} — ${o.checkoutIds.length} checkouts on ${o.documentIds.length} docs`
        : `${o.level === "system" ? "System" : "Unit"} ${o.scopeName} — ${o.checkoutIds.length} checkouts on ${o.documentIds.length} docs`,
      href: "/coordination",
      strong: true,
    })),
    more: { label: "Open Coordination", href: "/coordination" },
  };
}

async function find(orgId: string, subject: string): Promise<AskAnswer> {
  if (!subject.trim()) return { title: "Search what?", lines: [] };
  const hits = await globalSearch({ orgId, query: subject.trim(), perKindLimit: 3 });
  if (hits.length === 0) {
    return {
      title: `Nothing found for “${subject}”`,
      lines: [],
      more: { label: "Open full search", href: `/search?q=${encodeURIComponent(subject.trim())}` },
    };
  }
  return {
    title: `${hits.length} result${hits.length === 1 ? "" : "s"} for “${subject}”`,
    lines: hits.slice(0, 6).map((h) => ({
      text: `${h.kind.toUpperCase()} · ${h.title}${h.subtitle ? ` — ${h.subtitle}` : ""}`,
      href: h.href,
    })),
    more: { label: "Open full search", href: `/search?q=${encodeURIComponent(subject.trim())}` },
  };
}
