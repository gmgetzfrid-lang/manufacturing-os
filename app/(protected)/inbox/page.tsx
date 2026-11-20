"use client";

// /inbox: everything that waits on you, in one place. The header says how
// many things need you and backs it up with counts; then the "Needs you"
// table (the same feed as the bell), suggested next steps, your queue (one
// ruled table: markups, requests, holds, transmittals, reviews, sign-offs,
// acknowledgments, access recertifications, milestones) and what you have
// checked out.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Send, XCircle, RefreshCw, Download } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { loadInbox, type InboxSnapshot } from "@/lib/inbox";
import { useTicketNotifications } from "@/hooks/useTicketNotifications";
import { resolveMarkupRequest } from "@/lib/markupRequests";
import { computeNudges } from "@/lib/nudges";
import { useToast } from "@/components/providers/ToastProvider";
import ViewTabs, { HOME_VIEWS } from "@/components/navigation/ViewTabs";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card as Panel, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import MyDeskPanel from "@/components/cockpit/MyDeskPanel";
import { formatAgo, exportInboxCsv } from "@/components/cockpit/CommandDeck";
import { AttentionFeed, type AttnFilter } from "@/components/cockpit/AttentionFeed";
import GroupedTable, { type Group } from "@/components/cockpit/GroupedTable";
import { buildNeeds, needsFacts } from "@/components/cockpit/needsYou";
import { StatusTag, rowBtn, link, humanDate } from "@/components/cockpit/ui";

export default function InboxPage() {
  const { uid, userEmail, activeRole, activeOrgId } = useRole();
  // Same unified feed the sidebar badge + header bell use, so all three agree.
  const {
    items: attentionItems, count: attentionCount,
    markRead, markAllRead,
  } = useTicketNotifications();
  const { showToast } = useToast();
  const [data, setData] = useState<InboxSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [, setLastLoadedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [attnFilter, setAttnFilter] = useState<AttnFilter>("all");
  const [markingAll, setMarkingAll] = useState(false);
  // Accurate per-filter counts (from the unified feed itself — the hook's
  // ticket-only counters don't include notification rows).
  const attnCounts = useMemo(() => ({
    all: attentionItems.length,
    action: attentionItems.filter((i) => i.actionRequired).length,
    unread: attentionItems.filter((i) => !i.actionRequired).length,
  }), [attentionItems]);

  // Filtered attention feed for the segmented control.
  const filteredAttention = useMemo(() => {
    if (attnFilter === "action") return attentionItems.filter((i) => i.actionRequired);
    if (attnFilter === "unread") return attentionItems.filter((i) => !i.actionRequired);
    return attentionItems;
  }, [attentionItems, attnFilter]);

  const handleMarkAll = useCallback(async () => {
    setMarkingAll(true);
    try {
      await markAllRead();
      showToast({ type: "success", title: "All caught up", message: "Cleared your unread notifications." });
    } catch (e) {
      showToast({ type: "error", title: "Couldn't mark all read", message: (e as Error).message });
    } finally {
      setMarkingAll(false);
    }
  }, [markAllRead, showToast]);

  const refresh = useCallback(async (opts?: { background?: boolean }) => {
    if (!uid || !activeOrgId) return;
    if (opts?.background) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const snap = await loadInbox(activeOrgId, uid, userEmail ?? undefined);
      setData(snap);
      setLastLoadedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [uid, activeOrgId, userEmail]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Keep the cockpit fresh without a manual click: refresh when the tab
  // regains focus/visibility, and on a 60s heartbeat while visible. Background
  // refreshes don't trigger the full-page spinner, so the view never flickers.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") void refresh({ background: true }); };
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    const id = window.setInterval(tick, 60_000);
    return () => {
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
      window.clearInterval(id);
    };
  }, [refresh]);

  // Respond to a markup request right from the cockpit — closes the loop that
  // was previously one-way (the request had no in-app way to be answered).
  const respondToMarkup = async (
    mr: InboxSnapshot["markupRequestsToMe"][number],
    status: "shared" | "declined",
  ) => {
    if (!uid || !activeOrgId || resolvingId) return;
    setResolvingId(mr.id);
    try {
      await resolveMarkupRequest({
        markupRequestId: mr.id,
        status,
        orgId: activeOrgId,
        projectId: mr.projectId ?? undefined,
        actorUserId: uid,
        actorEmail: userEmail ?? undefined,
        actorRole: activeRole ?? undefined,
      });
      showToast({
        type: "success",
        title: status === "shared" ? "Marked as shared" : "Request declined",
        message: status === "shared"
          ? "The requester can see your markups are available."
          : "The requester has been told you declined.",
      });
      await refresh({ background: true });
    } catch (e) {
      showToast({ type: "error", title: "Couldn't update the request", message: (e as Error).message });
    } finally {
      setResolvingId(null);
    }
  };

  const needs = buildNeeds(attentionItems);
  const facts = needsFacts(needs);
  const lead = needs[0];

  if (loading && !data) {
    return (
      <PageShell width="work">
        <PageHero kicker="Home · Inbox" title="Inbox">
          <ViewTabs tabs={HOME_VIEWS} variant="dark" />
        </PageHero>
        <PageBody>
          <Panel><LoadingBlock what="what needs you" rows={6} className="border-0 p-0" /></Panel>
        </PageBody>
      </PageShell>
    );
  }

  const ago = (iso: unknown) => {
    const a = formatAgo(typeof iso === "string" ? iso : undefined);
    return a === "-" ? "–" : a === "now" ? "Just now" : /^\d+[mhd]$/.test(a) ? `${a.replace(/m$/, " min").replace(/h$/, " h").replace(/d$/, " days")} ago` : a;
  };
  const ageTag = (d: number | undefined) => {
    const words = d === 0 ? "Today" : `${d ?? 0} day${d === 1 ? "" : "s"}`;
    return (d ?? 0) >= 14 ? <StatusTag tone="overdue">{words}</StatusTag> : (d ?? 0) >= 7 ? <StatusTag tone="held">{words}</StatusTag> : <>{words}</>;
  };
  const docLink = (href: string, label: string) => (
    <Link href={href} className="font-display font-semibold tabular-nums text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{label}</Link>
  );
  const ticketRows = (list: TicketListItem[]) => list.slice(0, 6).map((t, i) => ({
    key: t.id ?? `t-${i}`,
    item: <Link href={`/requests/${t.id ?? ""}`} className="text-[var(--color-text)] hover:text-[var(--color-accent-text)]"><span className="font-display font-semibold tabular-nums mr-2">{t.ticketId ?? "–"}</span>{t.title ?? "Untitled"}</Link>,
    detail: statusWords(t.status),
    when: ago(t.lastModified),
  }));
  const ticketMore = (n: number) => (n > 6 ? { href: "/requests", label: `See all ${n} in Drafting Requests` } : undefined);

  // Your queue: every bucket with something in it, one ruled table.
  // (What you have checked out is in its own section below, with Release.)
  const groups: Group[] = !data ? [] : [
    {
      key: "markups", title: "Markup requests for you", count: data.markupRequestsToMe.length,
      rows: data.markupRequestsToMe.slice(0, 6).map((mr) => ({
        key: mr.id,
        item: docLink(mr.libraryId ? `/documents/${mr.libraryId}?doc=${mr.documentId}` : "/documents", mr.documentNumber || mr.documentTitle || mr.documentId.slice(0, 8)),
        detail: <>{mr.requestedByName ? `From ${mr.requestedByName}` : ""}{mr.message ? `${mr.requestedByName ? ": " : ""}“${mr.message}”` : ""}</>,
        when: ago(mr.createdAt),
        action: (
          <span className="inline-flex gap-2">
            <button type="button" onClick={() => respondToMarkup(mr, "shared")} disabled={resolvingId === mr.id} className={rowBtn}><Send className="w-3.5 h-3.5" /> Mark shared</button>
            <button type="button" onClick={() => respondToMarkup(mr, "declined")} disabled={resolvingId === mr.id} className={rowBtn}><XCircle className="w-3.5 h-3.5" /> Decline</button>
          </span>
        ),
      })),
    },
    { key: "assigned", title: "Requests assigned to you", count: data.ticketsAssigned.length, rows: ticketRows(data.ticketsAssigned), more: ticketMore(data.ticketsAssigned.length) },
    { key: "unread", title: "Requests with new activity", count: data.ticketsUnread.length, rows: ticketRows(data.ticketsUnread), more: ticketMore(data.ticketsUnread.length) },
    { key: "watching", title: "Requests you watch", count: data.ticketsWatching.length, rows: ticketRows(data.ticketsWatching), more: ticketMore(data.ticketsWatching.length) },
    {
      key: "reviews", title: "Waiting for your review sign-off", count: data.reviewsPendingOnMe.length,
      help: "Drafts in review that need your sign-off before they can publish.",
      rows: data.reviewsPendingOnMe.slice(0, 6).map((r) => ({
        key: r.signoffId, late: (r.__ageDays ?? 0) >= 14,
        item: docLink(`/documents/${r.libraryId}?doc=${r.documentId}`, r.label),
        detail: r.revisionLabel ? `Draft ${r.revisionLabel}` : "Draft",
        when: ageTag(r.__ageDays),
      })),
    },
    {
      key: "cycles", title: "Periodic reviews you owe", count: data.reviewCyclesDueOnMe.length,
      help: "Documents whose scheduled review is due. Open each, check it is still right, and mark it reviewed.",
      rows: [...data.reviewCyclesDueOnMe].sort((a, b) => Number(b.overdue) - Number(a.overdue) || String(a.nextReviewDate ?? "").localeCompare(String(b.nextReviewDate ?? ""))).slice(0, 6).map((r) => ({
        key: r.documentId, late: r.overdue,
        item: docLink(`/documents/${r.libraryId}?doc=${r.documentId}`, r.label),
        detail: "Periodic review",
        when: r.overdue
          ? <StatusTag tone="overdue">Overdue{r.nextReviewDate ? `, due ${humanDate(r.nextReviewDate.slice(0, 10))}` : ""}</StatusTag>
          : <>Due {r.nextReviewDate ? humanDate(r.nextReviewDate.slice(0, 10)) : "now"}</>,
      })),
      more: data.reviewCyclesDueOnMe.length > 6 ? { href: "/register", label: `See all ${data.reviewCyclesDueOnMe.length.toLocaleString()} in the register` } : undefined,
    },
    {
      key: "dist", title: "Confirm you have these revisions", count: data.distributionAcksPendingOnMe.length,
      help: "Someone sent you a revision and needs your confirmation for the record. Open the document and select “I have this revision”.",
      rows: data.distributionAcksPendingOnMe.slice(0, 6).map((a) => ({
        key: a.ackId,
        item: docLink(a.libraryId ? `/documents/${a.libraryId}?doc=${a.documentId}` : "/documents", a.label),
        detail: [a.revLabel ? `Rev ${a.revLabel}` : null, a.requestedByName ? `from ${a.requestedByName}` : null].filter(Boolean).join(", "),
        when: ago(a.requestedAt),
      })),
    },
    {
      key: "acks", title: "Waiting for your acknowledgment", count: data.acknowledgmentsPendingOnMe.length,
      help: "Controlled revisions you must confirm you have read and understood. Open each and sign.",
      rows: data.acknowledgmentsPendingOnMe.slice(0, 6).map((a) => ({
        key: a.rosterId, late: (a.__ageDays ?? 0) >= 14,
        item: docLink(`/documents/${a.libraryId}?doc=${a.documentId}`, a.label),
        detail: a.revisionLabel ? `Rev ${a.revisionLabel}` : "",
        when: ageTag(a.__ageDays),
      })),
    },
    {
      key: "recerts", title: "Access recertification due", count: data.accessRecertsDue.length,
      help: "Check who has access to these libraries and recertify it.",
      rows: data.accessRecertsDue.slice(0, 6).map((r) => ({
        key: r.libraryId, late: r.overdue,
        item: <Link href={`/documents/${r.libraryId}`} className="font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{r.name}</Link>,
        detail: "Access recertification",
        when: r.overdue
          ? <StatusTag tone="overdue">Overdue{r.nextDate ? `, due ${humanDate(r.nextDate.slice(0, 10))}` : ""}</StatusTag>
          : <>Due {r.nextDate ? humanDate(r.nextDate.slice(0, 10)) : "now"}</>,
      })),
    },
    {
      key: "holds", title: "Holds you opened", count: data.myOpenHolds.length,
      rows: data.myOpenHolds.slice(0, 6).map((h, i) => ({
        key: h.id ?? `h-${i}`,
        item: <StatusTag tone="overdue">{h.reason}</StatusTag>,
        detail: h.notes ? `“${h.notes}”` : "",
        when: <>Opened {ago(h.openedAt).toLowerCase()}</>,
      })),
      more: { href: "/admin/holds", label: "Hold queue" },
    },
    {
      key: "transmittals", title: "Transmittals waiting for receipt", count: data.transmittalsAwaitingAck.length,
      help: "Issued to someone who hasn't confirmed receipt yet. Follow up for a clean paper trail.",
      rows: data.transmittalsAwaitingAck.slice(0, 6).map((t) => ({
        key: t.id, late: (t.__ageDays ?? 0) >= 14,
        item: docLink("/transmittals", t.number),
        detail: t.subject || [t.recipientName, t.recipientCompany].filter(Boolean).join(", ") || `${t.documentCount} doc${t.documentCount === 1 ? "" : "s"}`,
        when: ageTag(t.__ageDays),
      })),
      more: { href: "/transmittals", label: "Transmittal register" },
    },
    {
      key: "late-ms", title: "Milestones past their date", count: data.milestonesOverdue.length,
      rows: data.milestonesOverdue.slice(0, 6).map((m, i) => ({
        key: m.id ?? `mo-${i}`, late: true,
        item: m.projectId ? <Link href={`/projects/${m.projectId}?tab=plan`} className="font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{m.name}</Link> : <span className="font-semibold">{m.name}</span>,
        detail: m.__projectName ?? "",
        when: <StatusTag tone="overdue">{m.__overdueDays ?? 0} day{m.__overdueDays === 1 ? "" : "s"} late</StatusTag>,
      })),
    },
    {
      key: "ms", title: "Milestones due this week", count: data.milestonesUpcoming.length,
      rows: data.milestonesUpcoming.slice(0, 8).map((m, i) => {
        const d = m.__dueInDays ?? 0;
        return {
          key: m.id ?? `m-${i}`,
          item: m.projectId ? <Link href={`/projects/${m.projectId}?tab=plan`} className="font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{m.name}</Link> : <span className="font-semibold">{m.name}</span>,
          detail: m.__projectName ?? "",
          when: d <= 2 ? <StatusTag tone="held">{d === 0 ? "Due today" : `In ${d} day${d === 1 ? "" : "s"}`}</StatusTag> : <>In {d} days</>,
        };
      }),
    },
  ];
  const deskCount = groups.reduce((n, g) => n + g.count, 0);
  const nudges = data ? computeNudges(data) : [];
  const answer = attentionCount > 0
    ? `${attentionCount.toLocaleString()} ${attentionCount === 1 ? "thing needs" : "things need"} you.`
    : "Nothing needs you right now.";

  return (
    <PageShell width="work">
      <PageHero
        kicker="Home · Inbox"
        title={answer}
        sub={error
          ? <span role="alert" className="text-[var(--state-overdue)] font-semibold">Your queue didn&apos;t load: {error}</span>
          : lead ? <>First up: {lead.ref ? <span className="font-display font-semibold tabular-nums text-[var(--color-text)]">{lead.ref} </span> : null}<span className="text-[var(--color-text)]">{lead.name}</span>.</> : null}
        facts={[
          { label: "Overdue", value: facts.overdue, tone: facts.overdue > 0 ? "bad" : undefined },
          { label: "Waiting on you", value: facts.yourTurn },
          { label: "Due this week", value: facts.dueSoon, tone: facts.dueSoon > 0 ? "warn" : undefined },
        ]}
        tools={
          <>
            <button type="button" onClick={() => void refresh()} disabled={loading || refreshing} className={heroQuiet} aria-label="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading || refreshing ? "animate-spin" : ""}`} /><span className="max-sm:hidden">{loading || refreshing ? "Refreshing" : "Refresh"}</span>
            </button>
            {!!data && (attentionCount + deskCount) > 0 && (
              <button type="button" onClick={() => exportInboxCsv(data, userEmail ?? undefined)} className={heroQuiet} aria-label="Export" title="Download your queue as a spreadsheet (CSV)">
                <Download className="w-4 h-4" /><span className="max-sm:hidden">Export</span>
              </button>
            )}
          </>
        }
        primary={lead ? <Link href={lead.link} onClick={() => { if (lead.notificationId) void markRead(lead.notificationId); }} className={heroPrimary}>{attentionCount === 1 ? "Open it" : "Open the first one"}</Link> : undefined}
      >
        <ViewTabs tabs={HOME_VIEWS} variant="dark" />
      </PageHero>

      <PageBody>
        <section aria-label="Needs you">
          <h2 className="font-display text-[19px] leading-tight font-semibold text-[var(--color-text)] mb-1">Needs you</h2>
          <AttentionFeed
            items={filteredAttention}
            counts={attnCounts}
            filter={attnFilter}
            onFilter={setAttnFilter}
            onMarkRead={(id) => { void markRead(id); }}
            onMarkAll={handleMarkAll}
            markingAll={markingAll}
          />
        </section>

        {nudges.length > 0 && (
          <Panel label="Suggested next steps" pad={false}>
            <ul className="divide-y divide-[var(--color-border)]">
              {nudges.map((n) => (
                <li key={n.id} className="px-4 py-3 flex items-baseline gap-3 text-[15px] text-[var(--color-text)]">
                  <span aria-hidden className={`w-2 h-2 rounded-full shrink-0 translate-y-[-1px] ${n.severity === "high" ? "bg-[var(--state-overdue)]" : "bg-[var(--state-held)]"}`} />
                  <span className="flex-1 min-w-0">{n.message}</span>
                  {n.actionLabel && n.href && <Link href={n.href} className={`shrink-0 text-[14px] ${link}`}>{n.actionLabel}</Link>}
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {deskCount > 0 && (
          <section aria-label="Your queue">
            <div className="flex items-center gap-2 mb-2.5 min-h-9">
              <h2 className="font-display text-[19px] leading-tight font-semibold text-[var(--color-text)]">Your queue</h2>
              <span className="text-[15px] text-[var(--color-text-muted)] tabular-nums">{deskCount.toLocaleString()}</span>
            </div>
            <GroupedTable groups={groups} label="Your queue" />
          </section>
        )}

        {activeOrgId && uid && (
          <MyDeskPanel orgId={activeOrgId} uid={uid} userEmail={userEmail} />
        )}
      </PageBody>
    </PageShell>
  );
}

interface TicketListItem {
  id?: string;
  ticketId?: string;
  title?: string;
  status?: string;
  lastModified?: unknown;
}

/** "PENDING_IFC" → "Pending IFC". */
function statusWords(status?: string): string {
  if (!status) return "–";
  return status.split("_").map((w, i) => (["IFC", "ENG"].includes(w) ? w : i === 0 ? w.charAt(0) + w.slice(1).toLowerCase() : w.toLowerCase())).join(" ");
}
