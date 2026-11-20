"use client";

// components/assets/MentionsPanel.tsx — the backlinks panel.
//
// This is the Obsidian move, and it's the difference between a registry entry
// and a digital twin. The panel above this one lists documents somebody
// remembered to TAG to this equipment. This one lists every document that
// actually TALKS about it — derived from the indexed text, with the sentence
// attached and a link that lands on the page.
//
// Three rules it holds to:
//
//   * Never show a link without its evidence. An edge you can't interrogate
//     is a claim you have to take on faith.
//   * Say when the engine hasn't run. An empty panel that looks broken is
//     worse than a panel that says "nothing has been indexed yet".
//   * Never dead-end. Every row goes somewhere, on the page it came from.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Quote, ChevronDown, ChevronRight, ExternalLink, Loader2, Link2 } from "lucide-react";
import {
  mentionsForAsset, groupByDocument,
  type MentionedDocument, type MentionEvidence,
} from "@/lib/mentions";

interface Props {
  orgId: string;
  assetId: string;
  tag: string;
}

/** Deep link that opens the passage, not just the document. */
function passageHref(m: MentionEvidence): string | null {
  if (!m.knowledgeDocumentId || !m.libraryId) return null;
  const q = m.matchedText ? `&quote=${encodeURIComponent(m.matchedText)}` : "";
  return `/knowledge/${m.libraryId}?doc=${m.knowledgeDocumentId}&page=${m.page}${q}`;
}

export default function MentionsPanel({ orgId, assetId, tag }: Props) {
  // Keyed result rather than a reset-on-change effect: switching equipment
  // must never show the previous asset's backlinks for a frame, and a stale
  // response that lands late must never overwrite the current one.
  const key = `${orgId}:${assetId}`;
  const [state, setState] = useState<{
    key: string; docs: MentionedDocument[] | null; error: string | null;
  }>({ key: "", docs: null, error: null });

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const mentions = await mentionsForAsset(orgId, assetId);
        if (live) setState({ key, docs: groupByDocument(mentions), error: null });
      } catch (e) {
        // mentionsForAsset already tolerates a missing table (pre-migration)
        // by returning []; anything reaching here is a real failure.
        if (live) {
          setState({ key, docs: null, error: e instanceof Error ? e.message : "Couldn't load mentions." });
        }
      }
    })();
    return () => { live = false; };
  }, [orgId, assetId, key]);

  const ready = state.key === key;
  const docs = ready ? state.docs : null;
  const error = ready ? state.error : null;

  const total = docs?.reduce((n, d) => n + d.totalMentions, 0) ?? 0;

  return (
    <section className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] overflow-hidden">
      <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-[var(--color-border)] flex items-center justify-between gap-2">
        <h2 className="font-display text-[17px] font-semibold text-[var(--color-heading)] inline-flex items-center gap-2.5">
          <span className="ui-icon-tile is-sm" aria-hidden><Link2 className="w-4 h-4" /></span> Mentioned in
        </h2>
        {docs && docs.length > 0 && (
          <span className="flex items-center gap-3 text-[13px] text-[var(--color-text-muted)]">
            <span className="inline-flex items-center gap-1.5"><span className="ui-count">{total}</span> mention{total === 1 ? "" : "s"}</span>
            <span className="inline-flex items-center gap-1.5"><span className="ui-count">{docs.length}</span> document{docs.length === 1 ? "" : "s"}</span>
          </span>
        )}
      </div>

      {docs === null && !error && (
        <div className="p-6 flex items-center justify-center text-[13px] text-[var(--color-text-faint)]">
          <Loader2 className="w-4 h-4 animate-spin mr-2" /> Reading the index…
        </div>
      )}

      {error && (
        <div role="alert" className="p-4 text-[13px] text-[var(--state-overdue)]">Couldn&apos;t load mentions: {error}</div>
      )}

      {docs !== null && docs.length === 0 && !error && (
        <div className="p-6 text-center text-[13px] text-[var(--color-text-faint)] italic">
          Nothing indexed mentions <span className="font-display tabular-nums not-italic">{tag}</span> yet.
          <div className="mt-1 not-italic text-[13px]">
            Only documents approved for indexing are read. An Admin can run the mention
            indexer from the graph page.
          </div>
        </div>
      )}

      {docs && docs.length > 0 && (
        <ul className="divide-y divide-[var(--color-border)]">
          {docs.map((d) => <DocRow key={d.key} doc={d} />)}
        </ul>
      )}
    </section>
  );
}

function DocRow({ doc }: { doc: MentionedDocument }) {
  const [open, setOpen] = useState(false);
  const pageCount = doc.pages.length;
  // The strongest single passage, shown collapsed so the row is useful
  // without a click. A panel you have to expand to learn anything from is a
  // list of filenames with extra steps.
  const lead = doc.pages[0];

  return (
    <li>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left px-4 py-2.5 hover:bg-[var(--color-surface-2)] transition-colors"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-faint)]" />
                : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-faint)]" />}
          <span className="text-[14px] font-semibold text-[var(--color-text)] truncate flex-1">{doc.documentName}</span>
          <span className="ui-count shrink-0" title={`${doc.totalMentions} mentions`}>{doc.totalMentions}×</span>
          <span className="text-[13px] text-[var(--color-text-muted)] shrink-0 tabular-nums">{pageCount} page{pageCount === 1 ? "" : "s"}</span>
        </div>
        {!open && lead && (
          <p className="mt-1 ml-5 text-[13px] text-[var(--color-text-muted)] line-clamp-2 italic">
            <Quote className="inline w-3 h-3 mr-1 -mt-0.5 text-[var(--color-text-faint)]" />
            {lead.snippet}
          </p>
        )}
      </button>

      {open && (
        <ul className="pb-2">
          {doc.pages.map((m) => {
            const href = passageHref(m);
            const body = (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-[var(--color-text-muted)]">
                    Page {m.page}
                  </span>
                  <span className="text-[13px] text-[var(--color-text-faint)]">
                    {m.count}× · matched &ldquo;{m.matchedText}&rdquo;
                  </span>
                  {m.confidence < 0.9 && (
                    <span className="ui-pill is-warn">Unconfirmed</span>
                  )}
                  {href && <ExternalLink className="w-3 h-3 text-[var(--color-text-faint)] ml-auto shrink-0" />}
                </div>
                <p className="mt-0.5 text-[13px] text-[var(--color-text)] italic">{m.snippet}</p>
              </>
            );
            return (
              <li key={`${m.knowledgeDocumentId ?? m.documentId}-${m.page}`} className="px-4">
                {href ? (
                  <Link
                    href={href}
                    className="block ml-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 mt-1.5 hover:border-[var(--color-border)]"
                  >
                    {body}
                  </Link>
                ) : (
                  <div className="ml-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 mt-1.5">
                    {body}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
