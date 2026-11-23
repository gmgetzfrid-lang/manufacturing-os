"use client";

// /documents/staged - the documents this person staged, from any folder or
// library, in their order. From here: view them side by side and mark them
// up (the markups are kept), send them (a link, email, text or QR code), or
// send them all to drafting as one new request. The list and the markups are
// kept on this device (lib/stagedDocs), and the page says so.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Eye, Loader2, PenTool, Send, Trash2, X, Eraser } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { appConfirm } from "@/components/providers/DialogProvider";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import MoreMenu from "@/components/ui/MoreMenu";
import ViewTabs, { DOCUMENT_VIEWS } from "@/components/navigation/ViewTabs";
import { StatusTag } from "@/components/documents/StatusTag";
import SendSheet, { type SendDoc } from "@/components/documents/SendSheet";
import { btnIcon, btnQuiet, btnRow, tbl } from "@/components/admin/kit";
import { supabase } from "@/lib/supabase";
import { docRecordFromRow, DOC_LIST_COLUMNS } from "@/lib/docRecord";
import { useStagedDocs, hasMarkups, sheetOfRecord, type StagedDoc } from "@/lib/stagedDocs";
import { draftingSheet, issuedFileUrl, markedUpPdf, prepareDraftingRequest } from "@/lib/sendToDrafting";
import type { DocumentRecord } from "@/types/schema";

// The viewer (react-pdf + fabric) loads only when it opens.
const MultiDocViewer = dynamic(() => import("@/components/viewers/MultiDocViewer"), { ssr: false });

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
        const libIds = [...new Set([...byId.values()].map((d) => d.libraryId).filter(Boolean))];
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
  const notFound = rows.filter((r) => r.rec === null).length;
  const reading = rows.some((r) => r.rec === undefined) && !loadError;
  const n = staged.count;
  const libraries = new Set(staged.docs.map((d) => d.libraryId)).size;
  const markedCount = staged.markedUpIds.length;

  // ── Viewing and marking up ──
  const [viewer, setViewer] = useState<{ start?: string } | null>(null);
  const openViewer = (start?: string) => { if (records.length) setViewer({ start }); };

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
  const clearMarkups = async (r: Row) => {
    const ok = await appConfirm({ message: `Clear your markups on ${r.number || r.title || "this document"}?`, confirmLabel: "Clear markups", tone: "danger" });
    if (ok) staged.clearMarkups(r.staged.id);
  };

  const libHref = (r: Row) => `/documents/${r.rec?.libraryId || r.staged.libraryId}?doc=${r.staged.id}`;
  const canOpen = (r: Row) => !!r.rec;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  const answer = n === 0 ? "Nothing staged." : `${plural(n, "document")} staged.`;
  const facts = n > 0 ? [
    { label: "Libraries", value: libraries.toLocaleString() },
    { label: "Marked up", value: markedCount.toLocaleString() },
  ] : undefined;

  const sendPrimary = n > 0 ? (
    <button type="button" onClick={() => setSending(true)} disabled={records.length === 0} className={heroPrimary}
      title="Send them: a link someone outside can open, or the workspace link, by copy, email, text or QR code">
      <Send className="w-4 h-4" /> Send
    </button>
  ) : undefined;

  const orderButtons = (r: Row, i: number, big = false) => (
    <div className="flex items-center gap-1">
      <button type="button" onClick={(e) => { stop(e); staged.move(r.staged.id, -1); }} disabled={i === 0}
        className={`${btnIcon} ${big ? "!w-10 !h-10 border border-[var(--color-border-strong)]" : ""}`} aria-label={`Move ${r.number || "it"} up`} title="Move up">
        <ArrowUp className="w-4 h-4" />
      </button>
      <button type="button" onClick={(e) => { stop(e); staged.move(r.staged.id, 1); }} disabled={i === n - 1}
        className={`${btnIcon} ${big ? "!w-10 !h-10 border border-[var(--color-border-strong)]" : ""}`} aria-label={`Move ${r.number || "it"} down`} title="Move down">
        <ArrowDown className="w-4 h-4" />
      </button>
    </div>
  );
  const statusCell = (r: Row) => r.rec === null
    ? <span className="text-[13px] font-semibold text-[var(--state-overdue)]">Not found</span>
    : r.status ? <StatusTag status={r.status} /> : <span className="text-[var(--color-text-faint)]">-</span>;

  return (
    <PageShell width="work">
      <PageHero
        kicker="Document control"
        title={answer}
        sub={n === 0 ? "Tap Stage on any document, or select several and tap Stage." : undefined}
        facts={facts}
        primary={sendPrimary}
        tools={n > 0 ? (
          <MoreMenu triggerClass={heroQuiet} items={[
            { icon: <Trash2 className="w-4 h-4" />, label: "Clear all", tone: "bad", onClick: clearAll },
          ]} />
        ) : undefined}
      >
        <ViewTabs tabs={DOCUMENT_VIEWS} />
        {n > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => openViewer()} disabled={records.length === 0} className={heroQuiet}
              title="Open them side by side, in this order, with markup tools. Your markups are kept.">
              <Eye className="w-4 h-4" /> View and mark up
            </button>
            <button type="button" onClick={() => void sendToDrafting()} disabled={drafting || records.length === 0} className={heroQuiet}
              title="Start one new drafting request with every staged sheet attached: marked-up sheets with your markups drawn in, the rest as issued">
              {drafting ? <Loader2 className="w-4 h-4 animate-spin" /> : <PenTool className="w-4 h-4" />}
              {drafting ? `Preparing ${plural(records.length, "sheet")}…` : "Send to drafting"}
            </button>
          </div>
        )}
      </PageHero>

      <PageBody>
        {(staged.error || loadError || draftError) && (
          <div className="space-y-1.5 -mb-4">
            {[
              staged.error ? { text: staged.error, off: staged.dismissError } : null,
              loadError ? { text: `The staged documents could not be read: ${loadError}`, off: () => setRetry((t) => t + 1), retry: true } : null,
              draftError ? { text: draftError, off: () => setDraftError(null) } : null,
            ].filter(Boolean).map((m) => (
              <div key={m!.text} role="alert" className="flex items-start gap-2 text-[14px] font-semibold text-[var(--state-overdue)]">
                <span className="flex-1 min-w-0">{m!.text}</span>
                {m!.retry
                  ? <button type="button" onClick={m!.off} className={btnRow}>Try again</button>
                  : <button type="button" onClick={m!.off} className={btnIcon} aria-label="Dismiss"><X className="w-4 h-4" /></button>}
              </div>
            ))}
          </div>
        )}

        {n === 0 ? (
          <Card>
            <p className="text-[15px] text-[var(--color-text)]">Staged documents show here in the order you stage them, from any folder or library. View them side by side, mark them up, and send them by link, QR code or to drafting.</p>
            <div className="mt-3"><Link href="/documents" className={btnQuiet}>Go to Documents</Link></div>
          </Card>
        ) : (
          <section aria-label="Staged documents" data-staged-list>
            {notFound > 0 && (
              <p className="mb-2.5 text-[14px] text-[var(--color-text)]">
                {notFound === 1 ? "1 staged document could not be found. It may have been deleted, or you may no longer have access. Remove it from the list." : `${notFound} staged documents could not be found. They may have been deleted, or you may no longer have access. Remove them from the list.`}
              </p>
            )}

            {/* Desktop: the ruled table. Tap a row to open it in the viewer there. */}
            <div className={`${tbl.wrap} max-md:hidden`}>
              <table className={tbl.table}>
                <thead className={tbl.thead}>
                  <tr>
                    <th className={`${tbl.th} w-12 text-right`}>#</th>
                    <th className={tbl.th}>Doc No.</th>
                    <th className={`${tbl.th} w-full`}>Title</th>
                    <th className={tbl.th}>Rev</th>
                    <th className={tbl.th}>Status</th>
                    <th className={tbl.th}>Library</th>
                    <th className={tbl.th}>Marked up</th>
                    <th className={tbl.th}><span className="sr-only">Order</span></th>
                    <th className={tbl.th}><span className="sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody className={tbl.tbody}>
                  {rows.map((r, i) => (
                    <tr key={r.staged.id} onClick={() => canOpen(r) && openViewer(r.staged.id)}
                      className={`${tbl.tr} ${canOpen(r) ? "cursor-pointer" : ""}`} data-staged-row>
                      <td className={`${tbl.td} text-right tabular-nums text-[var(--color-text-muted)]`}>{i + 1}</td>
                      <td className={`${tbl.td} whitespace-nowrap`}>
                        <Link href={libHref(r)} onClick={stop} title={`Open ${r.number || "it"} in ${r.library || "its library"}`}
                          className="font-display text-[16px] font-semibold tabular-nums text-[var(--color-text)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent-text)] hover:decoration-solid">
                          {r.number || "No number"}
                        </Link>
                        {r.sheet && <div className="text-[13px] text-[var(--color-text-muted)]">Sheet {r.sheet}</div>}
                      </td>
                      <td className={`${tbl.td} max-w-0`}>
                        {canOpen(r) ? (
                          <button type="button" onClick={(e) => { stop(e); openViewer(r.staged.id); }} className="block w-full truncate text-left hover:underline underline-offset-2" title={`View ${r.title || r.number}`}>
                            {r.title || <span className="text-[var(--color-text-faint)]">No title</span>}
                          </button>
                        ) : <div className="truncate text-[var(--color-text-muted)]">{r.title}</div>}
                      </td>
                      <td className={`${tbl.td} font-display text-[16px] font-semibold tabular-nums`}>{r.rev || "-"}</td>
                      <td className={tbl.td}>{statusCell(r)}</td>
                      <td className={`${tbl.td} whitespace-nowrap`}>{r.library || "-"}</td>
                      <td className={`${tbl.td} whitespace-nowrap`}>
                        {r.marked ? (
                          <div className="flex items-center gap-2">
                            <span className="font-semibold">Yes</span>
                            <button type="button" onClick={(e) => { stop(e); void clearMarkups(r); }} className={btnRow}>Clear markups</button>
                          </div>
                        ) : <span className="text-[var(--color-text-muted)]">No</span>}
                      </td>
                      <td className={tbl.td} onClick={stop}>{orderButtons(r, i)}</td>
                      <td className={tbl.td}>
                        <button type="button" onClick={(e) => { stop(e); staged.remove(r.staged.id); }} className={btnRow} aria-label={`Remove ${r.number || r.title} from Staged`}>Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Phone: the same, as cards. Tap a card to open it in the viewer there. */}
            <ul className="md:hidden space-y-2.5">
              {rows.map((r, i) => (
                <li key={r.staged.id} data-staged-card onClick={() => canOpen(r) && openViewer(r.staged.id)}
                  className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5 ${canOpen(r) ? "cursor-pointer active:bg-[var(--color-surface-2)]" : ""}`}>
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 w-7 h-7 shrink-0 rounded-full bg-[var(--color-surface-2)] border border-[var(--color-border)] grid place-items-center text-[13px] font-semibold tabular-nums text-[var(--color-text-muted)]">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <Link href={libHref(r)} onClick={stop}
                          className="font-display text-[18px] leading-tight font-semibold tabular-nums text-[var(--color-text)] underline decoration-dotted underline-offset-2">
                          {r.number || "No number"}
                        </Link>
                        {r.sheet && <span className="text-[14px] text-[var(--color-text-muted)]">Sheet <span className="font-semibold text-[var(--color-text)] tabular-nums">{r.sheet}</span></span>}
                        {r.rev && <span className="text-[14px] text-[var(--color-text-muted)]">Rev <span className="font-semibold text-[var(--color-text)] tabular-nums">{r.rev}</span></span>}
                        {statusCell(r)}
                      </div>
                      {r.title && r.title !== r.number && <div className="mt-0.5 text-[15px] text-[var(--color-text)] line-clamp-2">{r.title}</div>}
                      <div className="mt-0.5 text-[13px] text-[var(--color-text-muted)]">
                        {r.library || "Library not known"}{r.marked ? " · Marked up" : ""}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2 flex-wrap" onClick={stop}>
                    {orderButtons(r, i, true)}
                    <div className="flex-1" />
                    {r.marked && (
                      <button type="button" onClick={() => void clearMarkups(r)} className={`${btnRow} !h-10`}>
                        <Eraser className="w-4 h-4" /> Clear markups
                      </button>
                    )}
                    <button type="button" onClick={() => staged.remove(r.staged.id)} className={`${btnRow} !h-10`} aria-label={`Remove ${r.number || r.title} from Staged`}>Remove</button>
                  </div>
                </li>
              ))}
            </ul>

            <p className="mt-2.5 text-[13px] text-[var(--color-text-muted)]">
              {reading && <span className="inline-flex items-center gap-1.5 mr-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading the latest revisions…</span>}
              Kept on this device until you clear it.
            </p>
          </section>
        )}
      </PageBody>

      {viewer && records.length > 0 && (
        <MultiDocViewer
          docs={records}
          setName="Staged"
          startDocId={viewer.start}
          initialMarkups={staged.markups}
          onMarkupsChange={(id, pages) => { staged.setMarkups(id, pages); }}
          note={staged.error}
          onDismissNote={staged.dismissError}
          onClose={() => setViewer(null)}
          currentUserId={uid ?? undefined}
          currentUserEmail={userEmail ?? undefined}
          orgId={activeOrgId ?? undefined}
          userRole={activeRole}
        />
      )}

      {sending && activeOrgId && (
        <SendSheet orgId={activeOrgId} docs={sendDocs} markedUp={markedUp} markedUpIds={staged.markedUpIds} onClose={() => setSending(false)} />
      )}
    </PageShell>
  );
}
