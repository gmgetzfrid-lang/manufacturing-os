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
import { ChevronRight, ExternalLink } from "lucide-react";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { SkeletonRows } from "@/components/ui/Skeleton";
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
    key: string; docs: MentionedDocument[] | null; error: unknown;
  }>({ key: "", docs: null, error: null });
  const [attempt, setAttempt] = useState(0);

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
          setState({ key, docs: null, error: e ?? true });
        }
      }
    })();
    return () => { live = false; };
  }, [orgId, assetId, key, attempt]);

  const ready = state.key === key;
  const docs = ready ? state.docs : null;
  const error = ready ? state.error : null;

  const total = docs?.reduce((n, d) => n + d.totalMentions, 0) ?? 0;

  return (
    <section className="min-w-0">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1 mb-3 min-h-8">
        <h2 className="font-display text-section leading-tight font-semibold text-[var(--color-text)]">Mentioned in</h2>
        {docs && docs.length > 0 && (
          <span className="text-body text-[var(--color-text-muted)] tabular-nums">
            {total} mention{total === 1 ? "" : "s"} in {docs.length} document{docs.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] overflow-hidden">

      {docs === null && !error && <SkeletonRows rows={2} cols={1} sheet={false} what="mentions" />}

      {!!error && <ErrorNote compact className="px-4 py-4" error={error} title="Couldn't load the mentions." onRetry={() => setAttempt((n) => n + 1)} />}

      {docs !== null && docs.length === 0 && !error && (
        <p className="px-4 py-4 text-body text-[var(--color-text-muted)]">
          Nothing indexed mentions <span className="font-display font-semibold tabular-nums text-[var(--color-text)]">{tag}</span> yet. Only documents cleared for indexing are read; an admin runs the mention reader from the graph page.
        </p>
      )}

      {docs && docs.length > 0 && (
        <ul className="divide-y divide-[var(--color-border)]">
          {docs.map((d) => <DocRow key={d.key} doc={d} />)}
        </ul>
      )}
      </div>
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
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left px-4 py-2.5 hover:bg-[var(--color-surface-2)] transition-colors"
      >
        <div className="flex items-center gap-2">
          <ChevronRight aria-hidden className={`ui-chevron w-4 h-4 shrink-0 text-[var(--color-text-muted)] ${open ? "rotate-90" : ""}`} />
          <span className="text-body font-medium text-[var(--color-text)] truncate flex-1">{doc.documentName}</span>
          <span className="text-body text-[var(--color-text-muted)] shrink-0 tabular-nums">{doc.totalMentions} on {pageCount} page{pageCount === 1 ? "" : "s"}</span>
        </div>
        {!open && lead && (
          <p className="mt-1 ml-6 text-body text-[var(--color-text-muted)] line-clamp-2">
            &ldquo;{lead.snippet}&rdquo;
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
                  <span className="text-body font-medium text-[var(--color-text-muted)]">
                    Page {m.page}
                  </span>
                  <span className="text-body text-[var(--color-text-faint)]">
                    {m.count}× · matched &ldquo;{m.matchedText}&rdquo;
                  </span>
                  {m.confidence < 0.9 && (
                    <span className="ui-pill is-muted">Unconfirmed</span>
                  )}
                  {href && <ExternalLink className="w-3 h-3 text-[var(--color-text-faint)] ml-auto shrink-0" />}
                </div>
                <p className="mt-0.5 text-body text-[var(--color-text)]">&ldquo;{m.snippet}&rdquo;</p>
              </>
            );
            return (
              <li key={`${m.knowledgeDocumentId ?? m.documentId}-${m.page}`} className="px-4">
                {href ? (
                  <Link
                    href={href}
                    className="block ml-6 border-l-2 border-[var(--color-border-strong)] pl-3 py-1.5 mt-1.5 hover:border-[var(--color-accent)]"
                  >
                    {body}
                  </Link>
                ) : (
                  <div className="ml-6 border-l-2 border-[var(--color-border)] pl-3 py-1.5 mt-1.5">
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
