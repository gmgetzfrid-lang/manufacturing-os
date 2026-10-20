"use client";

// AssetProvenancePanel — GAP-303 acceptance 1 / GAP-316 (intelligence Round G
// I-32): on the asset hub, ONE view of how this equipment came to be
// believed. How it entered the registry, then every relation to it — the
// controlled documents and the knowledge-library uploads — with who or what
// asserted each (a person's link, a person's equipment tags, the equipment
// sweep reading the drawing's own text, or an AI transcription with its model
// and revision), from which sheet and pages, when; then each decision the
// equipment sweep recorded on a link.
//
// Served by GET /api/assets/provenance, which reads as the viewer (their own
// row-level security, plus the app's document read predicate): a link on a
// document they may not read is not shown and not counted. A read that fails
// is said — never "none".
//
// Closed until asked: opening the hub reads nothing more than it did.

import React, { useCallback, useState } from "react";
import Link from "next/link";
import { History, ChevronDown, ChevronRight, RefreshCw, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { AssetProvenance, ProvLink, ProvTarget } from "@/lib/assetProvenance";

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);
const pagesText = (p: number[]) => (p.length === 0 ? null : `page${p.length === 1 ? "" : "s"} ${p.slice(0, 8).join(", ")}${p.length > 8 ? "…" : ""}`);

function TargetLink({ t }: { t: ProvTarget }) {
  const label = (
    <>
      {t.label}
      {t.kind === "knowledge" && <span className="font-sans font-normal text-[var(--color-text-muted)]"> (knowledge upload)</span>}
      {t.archived && <span className="font-sans font-normal text-[var(--color-text-muted)]"> (archived)</span>}
    </>
  );
  return t.href
    ? <Link href={t.href} className="font-mono font-bold text-[var(--color-text)] hover:underline">{label}</Link>
    : <span className="font-mono font-bold text-[var(--color-text)]">{label}</span>;
}

function StandingBadge({ l }: { l: ProvLink }) {
  if (l.standing === "machine") {
    return (
      <span data-testid="prov-standing" className="text-[10px] font-bold text-violet-700 bg-violet-50 border border-violet-200 px-1.5 py-0.5 rounded shrink-0">
        {l.model ? "AI-read" : "read from drawing"}
      </span>
    );
  }
  if (l.standing === "machine_person_also") {
    return (
      <span data-testid="prov-standing" className="text-[10px] font-bold text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border border-[var(--color-border)] px-1.5 py-0.5 rounded shrink-0">
        tagged · also on drawing
      </span>
    );
  }
  return (
    <span data-testid="prov-standing" className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded shrink-0">
      a person&apos;s link
    </span>
  );
}

export default function AssetProvenancePanel({ orgId, assetId, tag }: { orgId: string; assetId: string; tag: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [story, setStory] = useState<AssetProvenance | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`/api/assets/provenance?orgId=${encodeURIComponent(orgId)}&assetId=${encodeURIComponent(assetId)}`, {
        headers: { Authorization: `Bearer ${session?.access_token ?? ""}` },
      });
      const json = await res.json().catch(() => ({})) as Partial<AssetProvenance> & { error?: string };
      if (!res.ok) {
        setStory(null);
        setError(json.error ?? `The story could not be read (HTTP ${res.status}).`);
      } else {
        setStory(json as AssetProvenance);
      }
    } catch (e) {
      setStory(null);
      setError(`The story could not be read: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [orgId, assetId]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !story && !loading) void load();
  };

  const d = story?.discovery;

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden mb-5" data-testid="asset-provenance">
      <div className="px-4 py-3 flex items-center gap-2">
        <button type="button" onClick={toggle} aria-expanded={open}
          className="flex-1 inline-flex items-center gap-2 text-left text-sm font-black text-[var(--color-text)]">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          <History className="w-4 h-4 text-violet-500" /> How we came to believe this
        </button>
        {open && (
          <button type="button" onClick={() => void load()} disabled={loading} aria-label="Read again"
            className="p-1 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)] disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        )}
      </div>

      {open && (
        <div className="border-t border-[var(--color-border)] px-4 py-3 space-y-3 text-xs">
          {loading && !story && (
            <div className="flex items-center gap-2 text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading the records&hellip;</div>
          )}
          {error && (
            <div role="alert" data-testid="prov-error" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800">{error}</div>
          )}
          {story && (
            <>
              {story.notes.length > 0 && (
                <div role="alert" data-testid="prov-notes" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 space-y-1">
                  {story.notes.map((n, i) => <div key={i}>{n}</div>)}
                </div>
              )}

              <section>
                <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1">How it entered the registry</div>
                <div data-testid="prov-discovery" className="text-[var(--color-text)]">
                  {d?.kind === "person" && <>Registered by a person.</>}
                  {d?.kind === "not_recorded" && <>How {tag} entered the registry is not recorded.</>}
                  {d?.kind === "sweep" && (
                    <>
                      Created by the equipment sweep{d.automatic ? " (applied automatically)" : ""}, read off{" "}
                      {d.source ? <TargetLink t={d.source} /> : d.door === "knowledge" ? "a knowledge-library upload" : "a drawing"}
                      {d.sourceHidden ? " — the source is not one you can open" : ""}
                      {d.sheets.length > 0 ? ` (${d.sheets.map((s) => `${s.label}${s.aiRead ? " (AI-read, unconfirmed)" : ""}`).join("; ")})` : pagesText(d.pages) ? ` (${pagesText(d.pages)})` : ""}
                      {d.revision ? `, Rev ${d.revision}` : ""}.
                      {d.confirmedByPerson ? " A person has since confirmed it as real equipment." : " Not yet confirmed by a person."}
                    </>
                  )}
                </div>
              </section>

              <section>
                <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                  Links you can read ({story.links.length})
                </div>
                {story.links.length === 0 ? (
                  <div className="text-[var(--color-text-faint)] italic" data-testid="prov-no-links">
                    {story.notes.length > 0 ? "No link could be shown — see above." : "No document or upload you can read links this equipment."}
                  </div>
                ) : (
                  <ul className="space-y-1.5" data-testid="prov-links">
                    {story.links.map((l) => (
                      <li key={l.key} data-testid="prov-link" className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <TargetLink t={l.target} />
                          <StandingBadge l={l} />
                          {l.sheet && (
                            <span className="text-[10px] font-bold font-mono bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded">
                              {l.sheet}{l.sheetMark ? ` (${l.sheetMark})` : ""}
                            </span>
                          )}
                          {l.vanished && <span className="text-[10px] font-bold text-amber-800">not on current rev</span>}
                          {l.superseded && !l.vanished && <span className="text-[10px] font-bold text-[var(--color-text-muted)]">earlier rev</span>}
                          {day(l.at) && <span className="ml-auto text-[10px] text-[var(--color-text-faint)]">{day(l.at)}</span>}
                        </div>
                        <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                          {l.assertedBy}
                          {[pagesText(l.pages), l.revision ? `Rev ${l.revision}` : null].filter(Boolean).length > 0
                            ? ` · ${[pagesText(l.pages), l.revision ? `Rev ${l.revision}` : null].filter(Boolean).join(", ")}` : ""}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {!story.knowledgeRelationInstalled && (
                  <div className="mt-1 text-[10px] text-[var(--color-text-faint)]" data-testid="prov-knowledge-not-installed">
                    Links to knowledge-library uploads are not recorded on this workspace&apos;s database yet.
                  </div>
                )}
              </section>

              <section>
                <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                  Decisions recorded ({story.decisions.length})
                </div>
                {story.decisions.length === 0 ? (
                  <div className="text-[var(--color-text-faint)] italic">No recorded equipment-sweep decision about {tag} on anything you can read.</div>
                ) : (
                  <ul className="space-y-1" data-testid="prov-decisions">
                    {story.decisions.map((x) => (
                      <li key={x.key} data-testid="prov-decision" className="flex flex-wrap items-center gap-1.5">
                        <span className="font-bold text-[var(--color-text)]">{x.words}</span>
                        <span className="text-[var(--color-text-muted)]">on</span>
                        <TargetLink t={x.target} />
                        <span className="text-[var(--color-text-muted)]">· by {x.actor}{x.detail ? ` · ${x.detail}` : ""}</span>
                        {day(x.at) && <span className="ml-auto text-[10px] text-[var(--color-text-faint)]">{day(x.at)}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </div>
  );
}
