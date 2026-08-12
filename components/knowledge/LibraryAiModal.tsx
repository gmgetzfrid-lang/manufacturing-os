"use client";

// Per-library AI setup (Admin/DocCtrl): standing instructions the model
// follows on every question, and linked reference libraries — the asked
// library GOVERNS, links are consulted as REFERENCE (code books vs site
// standards precedence).

import React, { useEffect, useState } from "react";
import { X, Loader2, Save, Link2, Wand2 } from "lucide-react";
import { useToast } from "@/components/providers/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";
import {
  listKnowledgeLibraries, listLibraryLinks, setLibraryLinks, saveLibraryAiInstructions,
  saveLibraryAiFeatures, listKnowledgeDocuments,
  type KnowledgeLibrary, type KnowledgeDocument,
} from "@/lib/knowledge";

const DECODER_PLACEHOLDER =
  `e.g. "Drawing numbers: first two digits = unit (20 = Crude Unit, 25 = Vacuum Unit). Tag prefixes: X- = Exchanger, V- = Vessel, ZZ- = Sample station. Line numbers read size-service-number-spec."`;

const INSTRUCTIONS_PLACEHOLDER =
  `e.g. "These standards cross-reference each other constantly — chase references instead of stopping at one document. Our site standards supersede code minimums; when a standard defers ('per B31.3'), the code governs. Field crews read these answers: spell out units, never abbreviate equipment tags."`;

export default function LibraryAiModal({ library, orgId, open, onClose, onSaved }: {
  library: KnowledgeLibrary;
  orgId: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { showToast } = useToast();
  const [instructions, setInstructions] = useState(library.aiInstructions ?? "");
  const [clarifyFacets, setClarifyFacets] = useState(library.aiFeatures?.clarifyFacets === true);
  const [visionPages, setVisionPages] = useState(library.aiFeatures?.visionPages !== false);
  const [visionAllPages, setVisionAllPages] = useState(library.aiFeatures?.visionAllPages === true);
  const [drawingIntel, setDrawingIntel] = useState(library.aiFeatures?.drawingIntel === true);
  const [decoder, setDecoder] = useState(library.aiFeatures?.decoder ?? "");
  const [legendDocIds, setLegendDocIds] = useState<Set<string>>(
    new Set(library.aiFeatures?.legendDocIds ?? []));
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [allLibraries, setAllLibraries] = useState<KnowledgeLibrary[]>([]);
  const [linked, setLinked] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setInstructions(library.aiInstructions ?? "");
    setClarifyFacets(library.aiFeatures?.clarifyFacets === true);
    setVisionPages(library.aiFeatures?.visionPages !== false);
    setVisionAllPages(library.aiFeatures?.visionAllPages === true);
    setDrawingIntel(library.aiFeatures?.drawingIntel === true);
    setDecoder(library.aiFeatures?.decoder ?? "");
    setLegendDocIds(new Set(library.aiFeatures?.legendDocIds ?? []));
    let cancelled = false;
    Promise.all([
      listKnowledgeLibraries(orgId), listLibraryLinks(library.id), listKnowledgeDocuments(library.id),
    ])
      .then(([libs, links, documents]) => {
        if (cancelled) return;
        setAllLibraries(libs.filter((l) => l.id !== library.id));
        setLinked(new Set(links.map((l) => l.linkedLibraryId)));
        setDocs(documents);
        setLoaded(true);
      })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reseed only when the modal (re)opens
  }, [open, orgId, library.id]);

  if (!open) return null;

  const toggle = (id: string) => {
    setLinked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveLibraryAiInstructions(library.id, instructions);
      await saveLibraryAiFeatures(library.id, {
        clarifyFacets, visionPages, visionAllPages,
        decoder: decoder.trim() || undefined,
        legendDocIds: legendDocIds.size > 0 ? [...legendDocIds].slice(0, 3) : undefined,
      });
      await setLibraryLinks({ orgId, libraryId: library.id, linkedLibraryIds: [...linked] });
      showToast({ type: "success", title: "Library AI setup saved — applies to the next question." });
      onSaved();
      onClose();
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-xl bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-xl mt-10"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
          <div>
            <h2 className="text-base font-black text-[var(--color-text)] flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-orange-600" /> Library AI setup
            </h2>
            <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
              Mold how the AI answers questions asked of <b>{library.name}</b>.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-5">
          <div>
            <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
              Standing instructions
            </div>
            <p className="text-[11px] text-[var(--color-text-muted)] mb-2">
              Injected into every question against this library — write plain-English rules about how
              these documents work and how answers should behave.
            </p>
            <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={6}
              placeholder={INSTRUCTIONS_PLACEHOLDER} className="text-xs" />
          </div>

          <div>
            <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
              Numbering &amp; code decoder
            </div>
            <p className="text-[11px] text-[var(--color-text-muted)] mb-2">
              Teach any numbering scheme these documents use. Unit numbers as
              <code className="font-mono"> 20 = Crude Unit</code> pairs; tag prefixes with a
              trailing dash, <code className="font-mono"> X- = Exchanger</code> — those override
              the built-in category guesses everywhere (tables, census, CSV).
            </p>
            <Textarea value={decoder} onChange={(e) => setDecoder(e.target.value)} rows={4}
              placeholder={DECODER_PLACEHOLDER} className="text-xs" />
          </div>

          <div>
            <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
              Pinned reference documents
            </div>
            <p className="text-[11px] text-[var(--color-text-muted)] mb-2">
              Pick up to 3 documents whose content rides along with <b>every</b> question — a
              P&amp;ID legend, a glossary of terms, an abbreviations key, a notation guide. Like
              keeping the reference page open next to whatever you&apos;re reading.
            </p>
            {docs.length === 0 ? (
              <p className="text-xs text-[var(--color-text-muted)] italic">Upload the reference document into this library first, then pick it here.</p>
            ) : (
              <ul className="space-y-1 max-h-40 overflow-y-auto">
                {docs.map((d) => {
                  const on = legendDocIds.has(d.id);
                  const full = !on && legendDocIds.size >= 3;
                  return (
                    <li key={d.id}>
                      <label className={`flex items-center gap-2.5 rounded-xl border border-[var(--color-border)] px-3 py-1.5 transition-colors ${full ? "opacity-40" : "cursor-pointer hover:bg-[var(--color-surface-2)]"}`}>
                        <input type="checkbox" checked={on} disabled={full}
                          onChange={() => setLegendDocIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(d.id)) next.delete(d.id); else next.add(d.id);
                            return next;
                          })}
                          className="accent-orange-600 w-4 h-4" />
                        <span className="text-xs font-bold text-[var(--color-text)] flex-1 truncate">{d.name}</span>
                        {on && (
                          <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-orange-500/10 border border-orange-300 dark:border-orange-800 text-orange-700 dark:text-orange-400">PINNED</span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div>
            <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
              AI features
            </div>
            <label className="flex items-start gap-2.5 rounded-xl border border-[var(--color-border)] px-3 py-2.5 cursor-pointer hover:bg-[var(--color-surface-2)] transition-colors">
              <input type="checkbox" checked={clarifyFacets} onChange={(e) => setClarifyFacets(e.target.checked)}
                className="accent-orange-600 w-4 h-4 mt-0.5" />
              <span className="min-w-0">
                <span className="block text-xs font-bold text-[var(--color-text)]">Ask before broad answers</span>
                <span className="block text-[11px] text-[var(--color-text-muted)] mt-0.5">
                  When a question&apos;s answer spans several distinct aspects (safety vs fabrication vs
                  design…), the AI asks which you want — select all that apply — instead of burying you
                  in everything at once. Single-aspect questions answer directly, no extra step.
                </span>
              </span>
            </label>
            <label className="mt-1.5 flex items-start gap-2.5 rounded-xl border border-[var(--color-border)] px-3 py-2.5 cursor-pointer hover:bg-[var(--color-surface-2)] transition-colors">
              <input type="checkbox" checked={visionPages} onChange={(e) => setVisionPages(e.target.checked)}
                className="accent-orange-600 w-4 h-4 mt-0.5" />
              <span className="min-w-0">
                <span className="block text-xs font-bold text-[var(--color-text)]">Deep read — see pages as printed (ON by default)</span>
                <span className="block text-[11px] text-[var(--color-text-muted)] mt-0.5">
                  The AI reads the actual page images — complex tables (stress tables, span tables),
                  typeset formulas, figures — exactly as printed, hunts down referenced tables like
                  `Table A-1`, and can fetch additional pages it needs mid-answer. Uncheck only to save
                  tokens on plain-prose libraries.
                </span>
              </span>
            </label>
            <label className="mt-1.5 flex items-start gap-2.5 rounded-xl border border-[var(--color-border)] px-3 py-2.5 cursor-pointer hover:bg-[var(--color-surface-2)] transition-colors">
              <input type="checkbox" checked={visionAllPages} onChange={(e) => setVisionAllPages(e.target.checked)}
                className="accent-orange-600 w-4 h-4 mt-0.5" />
              <span className="min-w-0">
                <span className="block text-xs font-bold text-[var(--color-text)]">
                  Text doesn&apos;t extract from these files — index every page as an image
                </span>
                <span className="block text-[11px] text-[var(--color-text-muted)] mt-0.5">
                  For documents whose PDF text layer is missing or useless: scans, photos of
                  paper, CAD drawings exported with SHX fonts, image-only PDFs. Without this, such
                  a library indexes to almost nothing and looks empty for no visible reason.
                  <b> Leave it OFF for normal PDFs</b> — standards, specs and manuals with real
                  text extract fine, and their tables and figures are already handled (tables
                  index intact, and referenced figures are read from the page image at answer
                  time). Costs a few cents per page on your key. Turn it on, then
                  <b> Rebuild index</b>.
                </span>
              </span>
            </label>
            <label className="mt-1.5 flex items-start gap-2.5 rounded-xl border border-[var(--color-border)] px-3 py-2.5 cursor-pointer hover:bg-[var(--color-surface-2)] transition-colors">
              <input type="checkbox" checked={drawingIntel} onChange={(e) => setDrawingIntel(e.target.checked)}
                className="accent-orange-600 w-4 h-4 mt-0.5" />
              <span className="min-w-0">
                <span className="block text-xs font-bold text-[var(--color-text)]">
                  This is a drawing set — enable Drawing Intelligence
                </span>
                <span className="block text-[11px] text-[var(--color-text-muted)] mt-0.5">
                  Adds the drawing tools to this library&apos;s page: equipment census, off-page
                  reference audit, register export, per-sheet tag index. For P&amp;IDs, isometrics,
                  loop sheets. Leave OFF for standards and manuals — they don&apos;t need drawing
                  tooling just because they mention document numbers.
                </span>
              </span>
            </label>
          </div>

          <div>
            <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1 flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5" /> Linked reference libraries
            </div>
            <p className="text-[11px] text-[var(--color-text-muted)] mb-2">
              Questions asked here also search the linked libraries. <b>{library.name}</b> is
              <b> GOVERNING</b> — its documents supersede reference minimums except where they defer,
              and every answer says which document won.
            </p>
            {!loaded ? (
              <div className="py-4 text-center"><Loader2 className="w-4 h-4 animate-spin inline text-[var(--color-text-muted)]" /></div>
            ) : allLibraries.length === 0 ? (
              <p className="text-xs text-[var(--color-text-muted)] italic">No other libraries yet — create a second library (e.g. Code Books) to link it.</p>
            ) : (
              <ul className="space-y-1.5">
                {allLibraries.map((l) => (
                  <li key={l.id}>
                    <label className="flex items-center gap-2.5 rounded-xl border border-[var(--color-border)] px-3 py-2 cursor-pointer hover:bg-[var(--color-surface-2)] transition-colors">
                      <input type="checkbox" checked={linked.has(l.id)} onChange={() => toggle(l.id)}
                        className="accent-orange-600 w-4 h-4" />
                      <span className="text-xs font-bold text-[var(--color-text)] flex-1">{l.name}</span>
                      {linked.has(l.id) && (
                        <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text-muted)]">REFERENCE</span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save setup
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
