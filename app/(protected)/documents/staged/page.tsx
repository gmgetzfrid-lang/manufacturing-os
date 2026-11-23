"use client";

// /documents/staged - the documents this person staged, from any folder or
// library, in their order, shown straight away: the viewer is the page body,
// with the markup tools in its toolbar and Send and Send to drafting over
// the sheets. A slim list beside it (a row of chips on a phone) jumps
// between the documents and holds the rare things: move up or down, clear
// markups, remove. Markups drawn on a sheet are kept with the staged set.
// The list and the markups are kept on this device (lib/stagedDocs), and
// the page says so.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Eraser, FolderOpen, Loader2, PenLine, PenTool, Send, Trash2, X } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { appConfirm } from "@/components/providers/DialogProvider";
import { PageHero, heroQuiet } from "@/components/ui/PageHero";
import MoreMenu, { type MoreItem } from "@/components/ui/MoreMenu";
import ViewTabs, { DOCUMENT_VIEWS } from "@/components/navigation/ViewTabs";
import { StatusTag } from "@/components/documents/StatusTag";
import SendSheet, { type SendDoc } from "@/components/documents/SendSheet";
import { btnIcon, btnQuiet, btnRow } from "@/components/admin/kit";
import { vPrimary, vQuiet } from "@/components/viewers/viewerChrome";
import { supabase } from "@/lib/supabase";
import { docRecordFromRow, DOC_LIST_COLUMNS } from "@/lib/docRecord";
import { useStagedDocs, hasMarkups, sheetOfRecord, type StagedDoc } from "@/lib/stagedDocs";
import { draftingSheet, issuedFileUrl, markedUpPdf, prepareDraftingRequest } from "@/lib/sendToDrafting";
import type { DocumentRecord } from "@/types/schema";

// The viewer (react-pdf + fabric) loads in the browser only.
const MultiDocViewer = dynamic(() => import("@/components/viewers/MultiDocViewer"), {
  ssr: false,
  loading: () => <Opening />,
});

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One staged document as shown: what was kept when it was staged, brought
 *  up to date from the library when it has been read. */
interface Row {
  staged: StagedDoc;
  rec: DocumentRecord | null | undefined; // undefined: not read yet; null: not found
  number: string;
  sheet: string;
  title: string;
  rev: string;
  status: string | null;
  library: string;
  marked: boolean;
}

/** The sheets' place while they are being read. */
function Opening({ text = "Opening the staged documents…" }: { text?: string }) {
  return (
    <div className="surface-charcoal h-full grid place-items-center">
      <div className="flex flex-col items-center gap-3 text-[var(--color-text-muted)]">
        <Loader2 className="w-8 h-8 animate-spin" />
        <span className="text-[14px]">{text}</span>
      </div>
    </div>
  );
}

export default function StagedPage() {
  const router = useRouter();
  const { activeOrgId, uid, userEmail, activeRole } = useRole();
  const staged = useStagedDocs(activeOrgId, uid);

  // Each staged document read fresh from the library (current rev, status,
  // file), so the list never shows a rev that has since moved on.
  const [known, setKnown] = useState<Map<string, DocumentRecord | null>>(() => new Map());
  const [libNames, setLibNames] = useState<Map<string, string>>(() => new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const toRead = staged.docs.map((d) => d.id).filter((id) => !known.has(id)).sort().join(",");
  useEffect(() => {
    if (!toRead) return;
    let live = true;
    void (async () => {
      const ids = toRead.split(",");
      try {
        const byId = new Map<string, DocumentRecord>();
        for (let i = 0; i < ids.length; i += 100) {
          const { data, error } = await supabase.from("documents").select(DOC_LIST_COLUMNS).in("id", ids.slice(i, i + 100));
          if (error) throw new Error(error.message);
          for (const r of data ?? []) { const rec = docRecordFromRow(r as unknown as Record<string, unknown>); if (rec.id) byId.set(rec.id, rec); }
        }
        const libIds = [...new Set(ids.map((id) => byId.get(id)?.libraryId).filter((x): x is string => !!x))];
        const names = new Map<string, string>();
        if (libIds.length) {
          const { data } = await supabase.from("libraries").select("id, name").in("id", libIds);
          for (const l of (data ?? []) as Array<{ id: string; name: string | null }>) if (l.name) names.set(l.id, l.name);
        }
        if (!live) return;
        setKnown((prev) => { const n = new Map(prev); for (const id of ids) n.set(id, byId.get(id) ?? null); return n; });
        setLibNames((prev) => new Map([...prev, ...names]));
        setLoadError(null);
      } catch (e) {
        if (live) setLoadError((e as Error).message || "unknown error");
      }
    })();
    return () => { live = false; };
  }, [toRead, retry]);

  const rows: Row[] = useMemo(() => staged.docs.map((s) => {
    const rec = known.get(s.id);
    return {
      staged: s, rec,
      number: rec?.documentNumber || s.documentNumber || "",
      sheet: (rec ? sheetOfRecord(rec as { sheetNumber?: number | null; metadata?: Record<string, unknown> | null }) : undefined) ?? s.sheet ?? "",
      title: rec?.title || rec?.name || s.title || s.name || "",
      rev: rec?.rev || s.rev || "",
      status: rec === null ? null : rec?.status || s.status || null,
      library: libNames.get(rec?.libraryId || s.libraryId) || s.libraryName || "",
      marked: hasMarkups(staged.markups[s.id]),
    };
  }), [staged.docs, staged.markups, known, libNames]);

  // The documents that can be opened and sent: read, and still there. Not
  // built from `rows`: a markup drawn in the viewer must not hand the viewer
  // a new list (it would read every file again).
  const records = useMemo(() => staged.docs.map((s) => known.get(s.id)).filter((d): d is DocumentRecord => !!d), [staged.docs, known]);
  const reading = rows.some((r) => r.rec === undefined) && !loadError;
  const n = staged.count;
  const markedCount = staged.markedUpIds.length;

  // ── Which document is in view, and going to one from the list ──
  const [activeId, setActiveId] = useState<string | null>(null);
  const [jump, setJump] = useState<{ id: string; seq: number } | null>(null);
  const show = (r: Row) => {
    setActiveId(r.staged.id);
    if (r.rec) setJump((j) => ({ id: r.staged.id, seq: (j?.seq ?? 0) + 1 }));
  };
  const onActiveDocChange = useCallback((id: string) => setActiveId(id), []);
  const shownId = activeId && rows.some((r) => r.staged.id === activeId) ? activeId : rows.find((r) => r.rec)?.staged.id ?? rows[0]?.staged.id ?? null;
  // The one in view stays in sight in the list (sideways on a phone, up and
  // down beside the sheets), without moving the page.
  const chipsRef = useRef<HTMLOListElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const chips = chipsRef.current, on = chips?.querySelector<HTMLElement>("[data-on]");
    if (chips && on && (on.offsetLeft < chips.scrollLeft || on.offsetLeft + on.offsetWidth > chips.scrollLeft + chips.clientWidth)) {
      chips.scrollTo({ left: Math.max(0, on.offsetLeft - 12), behavior: "smooth" });
    }
    const list = listRef.current, item = list?.querySelector<HTMLElement>("[data-on]");
    if (list && item && (item.offsetTop < list.scrollTop || item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight)) {
      list.scrollTo({ top: Math.max(0, item.offsetTop - 8), behavior: "smooth" });
    }
  }, [shownId]);

  // The viewer opens again when the documents change (one moved, removed or
  // added, or markups cleared from the list), at the one that was in view.
  const [fresh, setFresh] = useState(0);
  const viewerKey = `${records.map((d) => d.id).join(",")}#${fresh}`;
  const [opened, setOpened] = useState<{ key: string; start?: string }>({ key: "" });
  if (opened.key !== viewerKey) setOpened({ key: viewerKey, start: activeId ?? undefined });

  // ── Send (link, email, text, QR code) ──
  const [sending, setSending] = useState(false);
  const sendDocs: SendDoc[] = useMemo(() => records.map((d) => ({
    id: d.id!, documentNumber: d.documentNumber || null, title: d.title || d.name || null, rev: d.rev || null, libraryId: d.libraryId,
  })), [records]);
  const { markups } = staged;
  const markedUp = useCallback(async (docId: string): Promise<Blob | null> => {
    const pages = markups[docId];
    const rec = known.get(docId);
    if (!rec || !hasMarkups(pages)) return null;
    const url = await issuedFileUrl({ id: docId, currentVersionId: rec.currentVersionId });
    return url ? markedUpPdf(url, pages) : null;
  }, [markups, known]);

  // ── Send to drafting: one new request with every staged sheet ──
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const sendToDrafting = async () => {
    if (drafting || records.length === 0) return;
    setDrafting(true);
    setDraftError(null);
    try {
      const sheets = await Promise.all(records.map((d) => draftingSheet(d, markups[d.id!])));
      const { href } = await prepareDraftingRequest(sheets);
      if (!href) {
        setDraftError("None of the staged files could be read, so no request was started.");
        setDrafting(false);
        return;
      }
      router.push(href);
    } catch (e) {
      setDraftError(`The sheets could not be prepared: ${(e as Error).message || "unknown error"}`);
      setDrafting(false);
    }
  };

  // ── The list's rare things ──
  const clearAll = async () => {
    const ok = await appConfirm({
      title: `Clear all ${plural(n, "staged document")}?`,
      message: markedCount === 0 ? "The documents stay where they are filed."
        : `Your markups on ${markedCount === n ? (n === 1 ? "it" : "all of them") : `${markedCount} of them`} are cleared too. The documents stay where they are filed.`,
      confirmLabel: "Clear all",
      tone: "danger",
    });
    if (ok) staged.clear();
  };
  const nameOf = (r: Row) => r.number || r.title || "this document";
  const clearMarkups = async (r: Row) => {
    const ok = await appConfirm({ message: `Clear your markups on ${nameOf(r)}?`, confirmLabel: "Clear markups", tone: "danger" });
    if (!ok) return;
    setActiveId(r.staged.id);
    if (staged.clearMarkups(r.staged.id)) setFresh((f) => f + 1);
  };
  const remove = (r: Row) => {
    // Removing the one in view: the next one comes into view (else the one before).
    if (r.staged.id === shownId) {
      const i = rows.indexOf(r);
      const next = rows.slice(i + 1).find((x) => x.rec) ?? rows.slice(0, i).reverse().find((x) => x.rec);
      setActiveId(next?.staged.id ?? null);
    }
    staged.remove(r.staged.id);
  };
  const move = (r: Row, dir: -1 | 1) => { setActiveId(shownId); staged.move(r.staged.id, dir); };
  const libHref = (r: Row) => `/documents/${r.rec?.libraryId || r.staged.libraryId}?doc=${r.staged.id}`;
  const menuFor = (r: Row, i: number): MoreItem[] => [
    ...(i > 0 ? [{ icon: <ArrowUp className="w-4 h-4" />, label: "Move up", onClick: () => move(r, -1) }] : []),
    ...(i < n - 1 ? [{ icon: <ArrowDown className="w-4 h-4" />, label: "Move down", onClick: () => move(r, 1) }] : []),
    ...(r.marked ? [{ icon: <Eraser className="w-4 h-4" />, label: "Clear markups", onClick: () => clearMarkups(r) }] : []),
    ...(r.rec ? [{ icon: <FolderOpen className="w-4 h-4" />, label: r.library ? `Open in ${r.library}` : "Open in its library", onClick: () => router.push(libHref(r)) }] : []),
    { icon: <X className="w-4 h-4" />, label: "Remove from Staged", tone: "bad", line: true, onClick: () => remove(r) },
  ];

  // ── The page's actions, in the toolbar over the sheets ──
  const ready = records.length > 0;
  const actions = (
    <>
      <button type="button" onClick={() => void sendToDrafting()} disabled={drafting || !ready} className={`${vQuiet} !h-10 max-sm:!h-11 !text-[14px]`}
        title="Start one new drafting request with every staged sheet attached: marked-up sheets with your markups drawn in, the rest as issued">
        {drafting ? <Loader2 className="w-4 h-4 animate-spin" /> : <PenTool className="w-4 h-4" />}
        <span className="truncate">{drafting ? `Preparing ${plural(records.length, "sheet")}…` : "Send to drafting"}</span>
      </button>
      <button type="button" onClick={() => setSending(true)} disabled={!ready} className={`${vPrimary} max-sm:!h-11`} data-staged-send
        title="Send them: a link someone outside can open, or the workspace link, by copy, email, text or QR code">
        <Send className="w-4 h-4" /> Send
      </button>
    </>
  );

  const kept = (
    <>
      {reading && <span className="inline-flex items-center gap-1.5 mr-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading the latest revisions…</span>}
      Kept on this device until you clear it.
    </>
  );

  const messages = [
    staged.error ? { text: staged.error, off: staged.dismissError } : null,
    loadError ? { text: `The staged documents could not be read: ${loadError}`, off: () => setRetry((t) => t + 1), retry: true } : null,
    draftError ? { text: draftError, off: () => setDraftError(null) } : null,
  ].filter((m): m is { text: string; off: () => void; retry?: boolean } => !!m);

  // ── Nothing staged ──
  if (n === 0) {
    return (
      <div className="mx-auto w-full px-4 sm:px-6 lg:px-8 py-6 pb-20">
        <PageHero kicker="Document control" size="md" title="Nothing staged."
          sub="Tap Stage on any document, or select several and tap Stage.">
          <ViewTabs tabs={DOCUMENT_VIEWS} />
        </PageHero>
        <div className="mt-2"><Link href="/documents" className={btnQuiet}>Go to Documents</Link></div>
      </div>
    );
  }

  const allMissing = !reading && !loadError && records.length === 0;

  return (
    <div className="h-full min-h-[560px] flex flex-col mx-auto w-full px-4 sm:px-6 lg:px-8 pt-6 pb-4 max-sm:pb-0">
      <PageHero kicker="Document control" size="md" className="!pb-5" title={`${plural(n, "document")} staged.`}
        tools={(
          <MoreMenu triggerClass={heroQuiet} items={[
            { icon: <Trash2 className="w-4 h-4" />, label: "Clear all", tone: "bad", onClick: clearAll },
          ]} />
        )}
      >
        <ViewTabs tabs={DOCUMENT_VIEWS} />
      </PageHero>

      {messages.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {messages.map((m) => (
            <div key={m.text} role="alert" className="flex items-start gap-2 text-[14px] font-semibold text-[var(--state-overdue)]">
              <span className="flex-1 min-w-0">{m.text}</span>
              {m.retry
                ? <button type="button" onClick={m.off} className={btnRow}>Try again</button>
                : <button type="button" onClick={m.off} className={btnIcon} aria-label="Dismiss"><X className="w-4 h-4" /></button>}
            </div>
          ))}
        </div>
      )}

      {/* The documents: the list to go between them, and the sheets. On a
          phone the sheets go edge to edge, under a row of chips. */}
      <section aria-label="Staged documents" data-staged-view
        className="flex-1 min-h-0 flex flex-col md:flex-row rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden max-sm:-mx-4 max-sm:rounded-none max-sm:border-x-0 max-sm:border-b-0">

        {/* Desktop: a slim column, in order. */}
        <aside className="max-md:hidden w-[264px] shrink-0 border-r border-[var(--color-border)] flex flex-col min-h-0" aria-label="The staged documents, in order">
          <ol ref={listRef} className="relative flex-1 min-h-0 overflow-y-auto p-2 space-y-1" data-staged-list>
            {rows.map((r, i) => {
              const on = r.staged.id === shownId;
              return (
                <li key={r.staged.id} data-staged-item data-on={on ? "" : undefined}
                  className={`relative flex items-start gap-1 rounded-md transition-colors ${on ? "bg-[var(--color-surface-2)] ring-1 ring-[var(--color-border-strong)]" : "hover:bg-[var(--color-surface-2)]"}`}>
                  {on && <span aria-hidden className="absolute left-0 inset-y-2 w-[3px] rounded-full bg-[var(--color-main)]" />}
                  <button type="button" onClick={() => show(r)} aria-current={on ? "true" : undefined}
                    title={r.rec === null ? "Not found. It may have been deleted, or you may no longer have access." : `Show ${nameOf(r)}`}
                    className="min-w-0 flex-1 flex items-start gap-2.5 text-left pl-3 pr-1 py-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)]">
                    <span className={`mt-0.5 w-6 h-6 shrink-0 rounded-full grid place-items-center text-[12px] font-bold tabular-nums ${on ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border)]"}`}>{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className={`block font-display text-[16px] leading-tight font-semibold tabular-nums truncate ${r.rec === null ? "text-[var(--color-text-muted)]" : "text-[var(--color-text)]"}`}>{r.number || "No number"}</span>
                      {r.title && r.title !== r.number && <span className="block text-[13px] leading-snug text-[var(--color-text)] truncate">{r.title}</span>}
                      {(r.sheet || r.rev) && (
                        <span className="mt-0.5 block text-[13px] leading-snug text-[var(--color-text-muted)] tabular-nums truncate">
                          {[r.sheet ? `Sheet ${r.sheet}` : null, r.rev ? `Rev ${r.rev}` : null].filter(Boolean).join(" · ")}
                        </span>
                      )}
                      <span className="mt-1.5 flex items-center gap-x-2 gap-y-1 flex-wrap">
                        {r.rec === null
                          ? <span className="text-[13px] font-semibold text-[var(--state-overdue)]">Not found</span>
                          : r.status ? <StatusTag status={r.status} /> : null}
                        {r.library && <span className="min-w-0 truncate text-[13px] text-[var(--color-text-muted)]">{r.library}</span>}
                      </span>
                      {r.rec === null && <span className="mt-1 block text-[13px] leading-snug text-[var(--color-text-muted)]">It may have been deleted, or you may no longer have access.</span>}
                      {r.marked && <span className="mt-1.5 flex items-center gap-1 text-[13px] font-semibold text-[var(--color-text)]"><PenLine className="w-3.5 h-3.5" /> Marked up</span>}
                    </span>
                  </button>
                  <div className="shrink-0 pt-1.5 pr-1">
                    <MoreMenu iconOnly label={`More for ${nameOf(r)}`} items={menuFor(r, i)}
                      triggerClass={`${btnIcon} !w-9 !h-9`} />
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="shrink-0 px-3 py-2.5 border-t border-[var(--color-border)] text-[13px] text-[var(--color-text-muted)]">{kept}</p>
        </aside>

        {/* Phone and narrow screens: a row of chips over the sheets. */}
        <div className="md:hidden shrink-0 border-b border-[var(--color-border)]">
          <ol ref={chipsRef} className="relative flex items-center gap-2 px-3 py-2 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-staged-chips>
            {rows.map((r, i) => {
              const on = r.staged.id === shownId;
              return (
                <li key={r.staged.id} data-staged-chip data-on={on ? "" : undefined}
                  className={`shrink-0 flex items-center h-11 rounded-full border transition-colors ${on ? "bg-[var(--color-text)] border-[var(--color-text)] text-[var(--color-surface)]" : "bg-[var(--color-surface)] border-[var(--color-border-strong)] text-[var(--color-text)]"}`}>
                  <button type="button" onClick={() => show(r)} aria-current={on ? "true" : undefined}
                    className={`h-full flex items-center gap-2 pl-3.5 ${on ? "pr-1" : "pr-3.5"} rounded-full text-[14px] whitespace-nowrap`}>
                    <span className={`tabular-nums text-[13px] font-semibold ${on ? "opacity-70" : "text-[var(--color-text-muted)]"}`}>{i + 1}</span>
                    <span className="font-semibold tabular-nums">{r.number || "No number"}</span>
                    {r.sheet && <span className={`text-[13px] ${on ? "opacity-80" : "text-[var(--color-text-muted)]"}`}>Sheet {r.sheet}</span>}
                    {r.rec === null && <span className={`text-[13px] font-semibold ${on ? "" : "text-[var(--state-overdue)]"}`}>Not found</span>}
                    {r.marked && <PenLine className="w-3.5 h-3.5" aria-label="Marked up" />}
                  </button>
                  {on && (
                    <MoreMenu iconOnly label={`More for ${nameOf(r)}`} items={menuFor(r, i)}
                      triggerClass="w-10 h-10 mr-0.5 grid place-items-center rounded-full text-[var(--color-surface)] hover:bg-white/15" />
                  )}
                </li>
              );
            })}
          </ol>
          <p className="px-4 pb-2 -mt-0.5 text-[13px] text-[var(--color-text-muted)]">{kept}</p>
        </div>

        {/* The sheets, large, with the tools and the actions over them. */}
        <div className="relative flex-1 min-h-0 min-w-0">
          {ready ? (
            <MultiDocViewer
              key={viewerKey}
              embedded
              docs={records}
              setName="Staged"
              startDocId={opened.start}
              jumpTo={jump}
              onActiveDocChange={onActiveDocChange}
              actions={actions}
              initialMarkups={staged.markups}
              onMarkupsChange={(id, pages) => { staged.setMarkups(id, pages); }}
              currentUserId={uid ?? undefined}
              currentUserEmail={userEmail ?? undefined}
              orgId={activeOrgId ?? undefined}
              userRole={activeRole}
            />
          ) : allMissing ? (
            <div className="surface-charcoal h-full grid place-items-center p-6">
              <p className="max-w-md text-center text-[15px] text-[var(--color-text)]">
                {n === 1 ? "The staged document could not be found." : "None of the staged documents could be found."} {n === 1 ? "It may have been deleted, or you may no longer have access. Remove it from the list." : "They may have been deleted, or you may no longer have access. Remove them from the list."}
              </p>
            </div>
          ) : loadError ? (
            <div className="surface-charcoal h-full grid place-items-center p-6">
              <button type="button" onClick={() => setRetry((t) => t + 1)} className={vQuiet}>Try again</button>
            </div>
          ) : (
            <Opening />
          )}
        </div>
      </section>

      {sending && activeOrgId && (
        <SendSheet orgId={activeOrgId} docs={sendDocs} markedUp={markedUp} markedUpIds={staged.markedUpIds} onClose={() => setSending(false)} />
      )}
    </div>
  );
}
