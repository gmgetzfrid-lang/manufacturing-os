"use client";

// CheckoutHistoryPanel — the sealed record log of past checkouts.
//
// Every closed checkout episode ("Checkout #N") is browsable here: who opened
// it, who participated and why, the full conversation (chat / handoffs /
// system events), and any revisions published while it was open. This is the
// document-control register view: the live thread belongs to the live
// checkout; everything older is read-only history.
//
// Rows that predate the episode model (episode_id NULL) are grouped under a
// single "Earlier activity" bucket so nothing is lost — and nothing bleeds
// into new checkouts.

import React, { useEffect, useState } from "react";
import {
  History, ChevronDown, ChevronRight, Loader2, User, FileText,
  MessageSquare, Shield, AlarmClock, CheckCircle2,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  listEpisodesForDocument,
  type CheckoutEpisode,
} from "@/lib/checkoutEpisodes";
import { listActivity, type ActivityMessage } from "@/lib/activityThread";

interface CheckoutHistoryPanelProps {
  orgId: string;
  documentId: string;
  /** Live episode id — excluded from the history list. */
  activeEpisodeId?: string | null;
}

interface EpisodeSessionRow {
  id: string;
  userName: string | null;
  purpose: string | null;
  note: string | null;
  mode: string | null;
  status: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

interface EpisodeVersionRow {
  id: string;
  revisionLabel: string | null;
  createdByName: string | null;
  createdAt: string | null;
}

interface EpisodeDetail {
  sessions: EpisodeSessionRow[];
  messages: ActivityMessage[];
  versions: EpisodeVersionRow[];
}

const CLOSE_REASON_LABEL: Record<string, { label: string; cls: string }> = {
  checked_in: { label: "Checked in", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  force_released: { label: "Force released", cls: "bg-rose-50 text-rose-700 border-rose-200" },
  expired: { label: "Auto-expired", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  reconciled: { label: "Closed by cleanup", cls: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]" },
};

export default function CheckoutHistoryPanel({ orgId, documentId, activeEpisodeId }: CheckoutHistoryPanelProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [episodes, setEpisodes] = useState<CheckoutEpisode[]>([]);
  const [legacyCount, setLegacyCount] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null); // episode id or "__legacy__"
  const [detail, setDetail] = useState<EpisodeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Load the register lazily — only when the section is opened.
  useEffect(() => {
    if (!open || !documentId) return;
    let alive = true;
    void (async () => {
      setLoading(true);
      try {
        const eps = await listEpisodesForDocument(documentId);
        if (!alive) return;
        setEpisodes(eps.filter((e) => e.status === "closed" && e.id !== activeEpisodeId));

        // Pre-episode rows form the legacy bucket. On pre-migration envs the
        // filtered query errors — treat as "no legacy bucket".
        try {
          const { count } = await supabase
            .from("checkout_messages")
            .select("id", { count: "exact", head: true })
            .eq("document_id", documentId)
            .is("episode_id", null);
          if (alive) setLegacyCount(count ?? 0);
        } catch {
          if (alive) setLegacyCount(0);
        }
      } catch (e) {
        console.warn("[CheckoutHistory] load failed", e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [open, documentId, activeEpisodeId]);

  const expand = async (key: string, episode?: CheckoutEpisode) => {
    if (expandedId === key) { setExpandedId(null); setDetail(null); return; }
    setExpandedId(key);
    setDetail(null);
    setDetailLoading(true);
    try {
      const isLegacy = key === "__legacy__";

      let sessionQuery = supabase
        .from("checkout_sessions")
        .select("id, user_name, purpose, note, mode, status, started_at, ended_at")
        .eq("document_id", documentId)
        .order("started_at", { ascending: true });
      sessionQuery = isLegacy ? sessionQuery.is("episode_id", null) : sessionQuery.eq("episode_id", key);
      const sessionsRes = await sessionQuery;
      const sessions: EpisodeSessionRow[] = ((sessionsRes.data as Array<Record<string, unknown>>) ?? []).map((r) => ({
        id: r.id as string,
        userName: (r.user_name as string | null) ?? null,
        purpose: (r.purpose as string | null) ?? null,
        note: (r.note as string | null) ?? null,
        mode: (r.mode as string | null) ?? null,
        status: (r.status as string | null) ?? null,
        startedAt: (r.started_at as string | null) ?? null,
        endedAt: (r.ended_at as string | null) ?? null,
      }));

      const messages = await listActivity(orgId, documentId, { episodeId: isLegacy ? null : key });

      // Revisions published while the episode was open — the "attachments"
      // of the checkout record.
      let versions: EpisodeVersionRow[] = [];
      if (!isLegacy && episode) {
        let vq = supabase
          .from("document_versions")
          .select("id, revision_label, created_by_name, created_at")
          .eq("record_id", documentId)
          .gte("created_at", episode.openedAt);
        if (episode.closedAt) vq = vq.lte("created_at", episode.closedAt);
        const vRes = await vq.order("created_at", { ascending: true });
        versions = ((vRes.data as Array<Record<string, unknown>>) ?? []).map((r) => ({
          id: r.id as string,
          revisionLabel: (r.revision_label as string | null) ?? null,
          createdByName: (r.created_by_name as string | null) ?? null,
          createdAt: (r.created_at as string | null) ?? null,
        }));
      }

      setDetail({ sessions, messages, versions });
    } catch (e) {
      console.warn("[CheckoutHistory] detail load failed", e);
      setDetail({ sessions: [], messages: [], versions: [] });
    } finally {
      setDetailLoading(false);
    }
  };

  const hasAnything = episodes.length > 0 || legacyCount > 0;

  return (
    <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-5 py-3 flex items-center justify-between hover:bg-[var(--color-surface-2)] transition-colors"
      >
        <span className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider flex items-center gap-2">
          <History className="w-3.5 h-3.5 text-[var(--color-text-faint)]" />
          Checkout History
        </span>
        {open ? <ChevronDown className="w-4 h-4 text-[var(--color-text-faint)]" /> : <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)]" />}
      </button>

      {open && (
        <div className="border-t border-[var(--color-border)]">
          {loading ? (
            <div className="p-4 text-center text-xs text-[var(--color-text-faint)]">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading register…
            </div>
          ) : !hasAnything ? (
            <div className="p-4 text-center text-xs text-[var(--color-text-faint)] italic">
              No previous checkouts on record for this document.
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {episodes.map((ep) => {
                const reason = CLOSE_REASON_LABEL[ep.closeReason ?? ""] ?? CLOSE_REASON_LABEL.checked_in;
                return (
                  <div key={ep.id}>
                    <button
                      onClick={() => void expand(ep.id, ep)}
                      className="w-full px-5 py-2.5 flex items-center gap-3 text-left hover:bg-[var(--color-surface-2)]"
                    >
                      <span className="text-[11px] font-black text-[var(--color-text)] font-mono shrink-0">#{ep.seq}</span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-xs font-bold text-[var(--color-text)] truncate">
                          {ep.openedByName || "Unknown"} · {fmtRange(ep.openedAt, ep.closedAt)}
                        </span>
                      </span>
                      <span className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${reason.cls}`}>
                        {reason.label}
                      </span>
                      {expandedId === ep.id
                        ? <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
                        : <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />}
                    </button>
                    {expandedId === ep.id && (
                      <EpisodeDetailView detail={detail} loading={detailLoading} />
                    )}
                  </div>
                );
              })}

              {legacyCount > 0 && (
                <div>
                  <button
                    onClick={() => void expand("__legacy__")}
                    className="w-full px-5 py-2.5 flex items-center gap-3 text-left hover:bg-[var(--color-surface-2)]"
                  >
                    <AlarmClock className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
                    <span className="flex-1 text-xs font-bold text-[var(--color-text-muted)]">
                      Earlier activity <span className="font-medium text-[var(--color-text-faint)]">(before checkout records, {legacyCount} item{legacyCount === 1 ? "" : "s"})</span>
                    </span>
                    {expandedId === "__legacy__"
                      ? <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
                      : <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />}
                  </button>
                  {expandedId === "__legacy__" && (
                    <EpisodeDetailView detail={detail} loading={detailLoading} />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EpisodeDetailView({ detail, loading }: { detail: EpisodeDetail | null; loading: boolean }) {
  if (loading || !detail) {
    return (
      <div className="px-5 py-3 bg-[var(--color-surface-2)] text-center text-[11px] text-[var(--color-text-faint)] border-t border-[var(--color-border)]">
        <Loader2 className="w-3.5 h-3.5 animate-spin inline mr-2" /> Opening record…
      </div>
    );
  }
  return (
    <div className="px-5 py-3 bg-slate-50/70 border-t border-[var(--color-border)] space-y-3">
      {/* Participants */}
      {detail.sessions.length > 0 && (
        <div>
          <div className="text-[9px] font-black text-[var(--color-text-muted)] uppercase tracking-widest mb-1.5">Participants</div>
          <div className="space-y-1">
            {detail.sessions.map((s) => (
              <div key={s.id} className="flex items-start gap-2 text-[11px]">
                <User className="w-3 h-3 text-[var(--color-text-faint)] mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <span className="font-bold text-[var(--color-text)]">{s.userName || "Unknown"}</span>
                  {s.purpose && <span className="text-violet-700"> · {s.purpose}</span>}
                  {s.note && <span className="text-[var(--color-text-muted)] italic"> — &ldquo;{s.note}&rdquo;</span>}
                  <span className="text-[var(--color-text-faint)]"> · {fmtRange(s.startedAt, s.endedAt)}</span>
                  {s.status === "abandoned" && <span className="text-amber-600 font-bold"> · abandoned</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Revisions published in the window */}
      {detail.versions.length > 0 && (
        <div>
          <div className="text-[9px] font-black text-[var(--color-text-muted)] uppercase tracking-widest mb-1.5">Revisions published</div>
          <div className="space-y-1">
            {detail.versions.map((v) => (
              <div key={v.id} className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
                <FileText className="w-3 h-3 text-emerald-500 shrink-0" />
                <span className="font-bold text-[var(--color-text)]">Rev {v.revisionLabel || "?"}</span>
                <span>by {v.createdByName || "unknown"}</span>
                <span className="text-[var(--color-text-faint)]">{fmtShort(v.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Conversation */}
      <div>
        <div className="text-[9px] font-black text-[var(--color-text-muted)] uppercase tracking-widest mb-1.5 flex items-center gap-1">
          <MessageSquare className="w-3 h-3" /> Conversation ({detail.messages.length})
        </div>
        {detail.messages.length === 0 ? (
          <div className="text-[11px] text-[var(--color-text-faint)] italic">No messages in this checkout.</div>
        ) : (
          <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
            {detail.messages.map((m) => (
              <div key={m.id} className="text-[11px] leading-snug">
                {m.kind === "system" ? (
                  <div className="text-[var(--color-text-faint)] italic flex items-start gap-1.5">
                    <Shield className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>{m.text} <span className="not-italic text-slate-300">· {fmtShort(m.createdAt)}</span></span>
                  </div>
                ) : (
                  <div className="text-[var(--color-text)]">
                    <span className="font-bold">{m.userName || "Unknown"}</span>
                    {m.kind !== "chat" && (
                      <span className="ml-1 text-[9px] font-bold uppercase text-[var(--color-text-faint)]">[{m.kind}]</span>
                    )}
                    <span>: {m.text}</span>
                    <span className="text-slate-300"> · {fmtShort(m.createdAt)}</span>
                    {m.resolvedAt && <CheckCircle2 className="w-3 h-3 text-emerald-500 inline ml-1" />}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function fmtShort(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch { return ""; }
}

function fmtRange(start: string | null, end: string | null): string {
  const s = start ? new Date(start) : null;
  const e = end ? new Date(end) : null;
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (s && e) {
    const sameDay = s.toDateString() === e.toDateString();
    return sameDay ? fmt(s) : `${fmt(s)} – ${fmt(e)}`;
  }
  if (s) return `${fmt(s)} – open`;
  return "—";
}
