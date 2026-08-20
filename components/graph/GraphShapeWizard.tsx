"use client";

// GraphShapeWizard — an admin turns one ANSWER into graph structure,
// with the AI doing the heavy lifting.
//
// Stage 1 (the brain): /api/graph/shape grounds the answer in real entities
// — the controlled documents its citations resolve to, the registry
// equipment its text names — and the admin's own model proposes which pairs
// genuinely relate, each with a relationship label and a reason taken from
// the answer. The model can only pick from entities the server verified
// exist; it cannot invent a node.
//
// Stage 2 (the human): every suggestion is a card — accept it, reject it,
// rewrite its label. A manual builder sits below for connections the model
// missed, drawing from the same verified roster.
//
// Stage 3 (the record): accepted pairs are written as first-class links —
// doc↔doc as curated related-resources carrying the question as evidence,
// doc↔equipment as manual registry links — and appear on the org graph
// immediately. Only Admin / DocCtrl ever see the entry point; the server
// enforces the same.

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  X, Waypoints, Loader2, Sparkles, Check, AlertTriangle, ArrowRight,
  FileText, Wrench, Plus, BrainCircuit, CheckCircle2,
} from "lucide-react";
import { supabase } from "@/lib/supabase";

interface Candidate {
  ref: string;
  type: "document" | "asset";
  id: string;
  label: string;
  title: string | null;
  libraryId?: string;
}

interface Suggestion {
  a: string; b: string; label: string; reason: string;
  confidence: number; aiAssisted: boolean;
}

interface Row extends Suggestion {
  key: string;
  accepted: boolean;
}

export default function GraphShapeWizard({
  orgId, userId, userName, question, answer, citedKnowledgeDocIds, onClose,
}: {
  orgId: string;
  userId: string;
  userName?: string;
  question: string;
  answer: string;
  citedKnowledgeDocIds: string[];
  onClose: () => void;
}) {
  const [stage, setStage] = useState<"thinking" | "review" | "applying" | "done">("thinking");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [written, setWritten] = useState(0);
  const [manual, setManual] = useState<{ a: string; b: string; label: string }>({ a: "", b: "", label: "" });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch("/api/graph/shape", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session?.access_token ?? ""}`,
          },
          body: JSON.stringify({ orgId, question, answer, citedKnowledgeDocIds }),
          signal: AbortSignal.timeout(55_000),
        });
        const json = await res.json();
        if (!alive) return;
        if (!res.ok) { setError(json.error ?? "The analysis failed."); setStage("review"); return; }
        setCandidates(json.candidates ?? []);
        setNote(json.note ?? null);
        setRows(((json.suggestions ?? []) as Suggestion[]).map((s, i) => ({
          ...s, key: `s${i}`, accepted: s.confidence >= 0.5,
        })));
        setStage("review");
      } catch {
        if (alive) { setError("The analysis timed out — you can still connect manually below."); setStage("review"); }
      }
    })();
    return () => { alive = false; };
  }, [orgId, question, answer, citedKnowledgeDocIds]);

  const byRef = useMemo(() => new Map(candidates.map((c) => [c.ref, c])), [candidates]);

  const addManual = () => {
    const ca = byRef.get(manual.a), cb = byRef.get(manual.b);
    if (!ca || !cb || ca.ref === cb.ref) return;
    if (ca.type === "asset" && cb.type === "asset") {
      setError("Equipment connects through documents — pick at least one document.");
      return;
    }
    setError(null);
    setRows((prev) => [...prev, {
      key: `m${prev.length}`, a: ca.ref, b: cb.ref,
      label: manual.label.trim() || "Related (linked from an answer)",
      reason: "Added manually while shaping this answer.",
      confidence: 1, aiAssisted: false, accepted: true,
    }]);
    setManual({ a: "", b: "", label: "" });
  };

  const apply = async () => {
    const accepted = rows.filter((r) => r.accepted);
    if (accepted.length === 0) return;
    setStage("applying"); setError(null);
    let ok = 0;
    const evidenceDetail = (r: Row) =>
      `${r.reason} — from the question: “${question.slice(0, 160)}”`;
    for (const r of accepted) {
      const ca = byRef.get(r.a), cb = byRef.get(r.b);
      if (!ca || !cb) continue;
      try {
        if (ca.type === "document" && cb.type === "document") {
          const { error: e } = await supabase.from("document_related_resources").insert({
            org_id: orgId,
            document_id: ca.id,
            target_document_id: cb.id,
            kind: "document",
            label: r.label.slice(0, 120),
            origin: "user",
            proposer: "answer",
            evidence: { summary: r.label, detail: evidenceDetail(r), rule: "Shaped from an answer" },
            created_by: userId,
            created_by_name: userName ?? null,
            sort_order: 0,
          });
          if (e && e.code !== "23505") throw new Error(e.message);
        } else {
          const doc = ca.type === "document" ? ca : cb;
          const asset = ca.type === "asset" ? ca : cb;
          const { error: e } = await supabase.from("document_assets").insert({
            org_id: orgId, document_id: doc.id, asset_id: asset.id,
            tag_text: asset.label, source: "manual",
          });
          if (e && e.code !== "23505") throw new Error(e.message);
        }
        ok += 1;
      } catch (e) {
        setError(`Some links failed: ${(e as Error).message}`);
      }
    }
    setWritten(ok);
    setStage("done");
  };

  const chip = (ref: string) => {
    const c = byRef.get(ref);
    if (!c) return null;
    const Icon = c.type === "document" ? FileText : Wrench;
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[var(--color-surface-2)] text-[11px] font-black text-[var(--color-text)] max-w-[11rem]"
        title={c.title ?? c.label}>
        <Icon className={`w-3 h-3 shrink-0 ${c.type === "document" ? "text-blue-600" : "text-emerald-600"}`} />
        <span className="truncate">{c.label}</span>
      </span>
    );
  };

  const acceptedCount = rows.filter((r) => r.accepted).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-xl max-h-[92vh] flex flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}>
        <div className="h-1.5 bg-gradient-to-r from-violet-500 via-fuchsia-500 to-violet-500 motion-safe:animate-[shimmer_6s_linear_infinite]" style={{ backgroundSize: "200% 100%" }} />
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)] shrink-0">
          <Waypoints className="w-4 h-4 text-violet-600" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-[var(--color-text)]">Shape the graph from this answer</div>
            <div className="text-[11px] text-[var(--color-text-muted)] truncate">{question || "This answer"}</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
          {stage === "thinking" && (
            <div className="py-10 flex flex-col items-center gap-3 text-center">
              <span className="relative inline-flex">
                <BrainCircuit className="w-8 h-8 text-violet-600" />
                <span className="absolute -inset-2 rounded-full border-2 border-violet-400/40 motion-safe:animate-ping" style={{ animationDuration: "1.8s" }} />
              </span>
              <div className="text-sm font-black text-[var(--color-text)]">Reading the answer&hellip;</div>
              <div className="text-[11px] text-[var(--color-text-muted)] max-w-sm">
                Grounding it in your controlled documents and equipment registry, then asking your
                model which of them this answer actually ties together.
              </div>
            </div>
          )}

          {stage !== "thinking" && (
            <>
              {error && (
                <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-[11px] text-rose-700 dark:text-rose-300">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
                </div>
              )}
              {note && (
                <div className="text-[11px] text-[var(--color-text-muted)] bg-[var(--color-surface-2)]/60 rounded-lg px-3 py-2">{note}</div>
              )}

              {stage === "done" ? (
                <div className="py-8 flex flex-col items-center gap-3 text-center">
                  <CheckCircle2 className="w-9 h-9 text-emerald-600" style={{ animation: "pop 0.3s var(--ease-fluid) both" }} />
                  <div className="text-sm font-black text-[var(--color-text)]">
                    {written} connection{written === 1 ? "" : "s"} written to the graph
                  </div>
                  <div className="text-[11px] text-[var(--color-text-muted)] max-w-sm">
                    Each carries this question as its evidence. They appear in the documents&apos;
                    Related panels and on the org graph now.
                  </div>
                  <Link href="/graph"
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-black text-white bg-violet-600 hover:bg-violet-500">
                    <Waypoints className="w-3.5 h-3.5" /> See it on the graph
                  </Link>
                </div>
              ) : (
                <>
                  {rows.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
                        Proposed attributions · accept, reject, or rewrite
                      </div>
                      {rows.map((r, i) => (
                        <div key={r.key}
                          style={{ animation: "rise 0.35s var(--ease-fluid) both", animationDelay: `${Math.min(i, 8) * 50}ms` }}
                          className={`rounded-xl border px-3 py-2.5 transition-colors ${r.accepted
                            ? "border-violet-300 dark:border-violet-800 bg-violet-50/50 dark:bg-violet-950/20"
                            : "border-[var(--color-border)] opacity-60"}`}>
                          <div className="flex items-start gap-2.5">
                            <button type="button"
                              onClick={() => setRows((prev) => prev.map((x) => x.key === r.key ? { ...x, accepted: !x.accepted } : x))}
                              className={`mt-0.5 shrink-0 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${r.accepted
                                ? "bg-violet-600 border-violet-600 text-white"
                                : "border-[var(--color-border-strong)] text-transparent"}`}
                              aria-label={r.accepted ? "Reject this connection" : "Accept this connection"}>
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <div className="flex-1 min-w-0 space-y-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                {chip(r.a)}
                                <ArrowRight className="w-3 h-3 text-[var(--color-text-faint)] shrink-0" />
                                {chip(r.b)}
                                {r.aiAssisted && (
                                  <span className="inline-flex items-center gap-0.5 text-[9px] font-black uppercase tracking-wide text-violet-600">
                                    <Sparkles className="w-2.5 h-2.5" /> AI
                                  </span>
                                )}
                              </div>
                              <input
                                value={r.label}
                                onChange={(e) => setRows((prev) => prev.map((x) => x.key === r.key ? { ...x, label: e.target.value } : x))}
                                className="w-full px-2 py-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-xs font-bold text-[var(--color-text)]"
                                maxLength={120}
                              />
                              <div className="text-[11px] text-[var(--color-text-muted)] leading-snug">{r.reason}</div>
                              {/* Confidence, as a quiet meter — never a bare number. */}
                              <div className="h-1 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                                <div className="h-full bg-violet-500/70" style={{ width: `${Math.round(r.confidence * 100)}%` }} />
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {candidates.length >= 2 && (
                    <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] p-3 space-y-2">
                      <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
                        Connect manually — same verified entities
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <select value={manual.a} onChange={(e) => setManual((m) => ({ ...m, a: e.target.value }))}
                          className="flex-1 min-w-[8rem] px-2 py-1.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-xs">
                          <option value="">From…</option>
                          {candidates.map((c) => <option key={c.ref} value={c.ref}>{c.type === "document" ? "📄" : "⚙"} {c.label}</option>)}
                        </select>
                        <ArrowRight className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
                        <select value={manual.b} onChange={(e) => setManual((m) => ({ ...m, b: e.target.value }))}
                          className="flex-1 min-w-[8rem] px-2 py-1.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-xs">
                          <option value="">To…</option>
                          {candidates.filter((c) => c.ref !== manual.a).map((c) => <option key={c.ref} value={c.ref}>{c.type === "document" ? "📄" : "⚙"} {c.label}</option>)}
                        </select>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <input value={manual.label} onChange={(e) => setManual((m) => ({ ...m, label: e.target.value }))}
                          placeholder="What is the relationship? (optional)"
                          className="flex-1 px-2 py-1.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-xs" />
                        <button type="button" onClick={addManual} disabled={!manual.a || !manual.b}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-black text-violet-700 border border-violet-300 dark:border-violet-800 hover:bg-violet-50 dark:hover:bg-violet-950/40 disabled:opacity-40">
                          <Plus className="w-3.5 h-3.5" /> Add
                        </button>
                      </div>
                    </div>
                  )}

                  {rows.length === 0 && candidates.length < 2 && (
                    <div className="text-[11px] text-[var(--color-text-muted)] text-center py-6">
                      Nothing here can shape the graph — this answer doesn&apos;t ground to known
                      documents or equipment.
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {stage === "review" && rows.length > 0 && (
          <div className="px-4 py-3 border-t border-[var(--color-border)] flex items-center justify-between gap-2 shrink-0">
            <span className="text-[11px] text-[var(--color-text-muted)]">
              {acceptedCount} of {rows.length} selected
            </span>
            <button onClick={() => void apply()} disabled={acceptedCount === 0}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-black text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-50">
              <Waypoints className="w-3.5 h-3.5" /> Write {acceptedCount} connection{acceptedCount === 1 ? "" : "s"}
            </button>
          </div>
        )}
        {stage === "applying" && (
          <div className="px-4 py-3 border-t border-[var(--color-border)] flex items-center gap-2 text-[11px] text-[var(--color-text-muted)] shrink-0">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Writing links&hellip;
          </div>
        )}
      </div>
    </div>
  );
}
