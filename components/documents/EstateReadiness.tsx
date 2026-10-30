"use client";

// components/documents/EstateReadiness.tsx — "why is nothing linked?"
//
// The map can only connect what the ground holds. This walks the steps in
// order, counts what each one has produced, and names the exact place in
// the product to do the one that is missing. The first step not yet done is
// the one to do next.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Circle, AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { estatePost } from "@/lib/estate/client";
import type { EstateReadiness as Readiness } from "@/lib/estate/readinessServer";

type State = "done" | "partial" | "missing";
interface Step { title: string; state: State; count: string; fix: React.ReactNode; why: string }

function steps(r: Readiness): Step[] {
  const out: Step[] = [];
  out.push({
    title: "Units in the Site Codebook",
    state: r.units > 0 ? "done" : "missing",
    count: `${r.units} unit${r.units === 1 ? "" : "s"}`,
    why: "Every unit link, unit badge and wrong-unit penalty starts here.",
    fix: <>Admin › <Link className="underline font-semibold" href="/admin/codebook">Site codebook</Link> › Units: add each unit with its code (10, 20…) and name (Crude, Vacuum…).</>,
  });
  out.push({
    title: "Drawing-number format",
    state: r.drawingNumberFormat ? "done" : "partial",
    count: r.drawingNumberFormat ? "set" : "not set",
    why: "Lets a number like EP10-1-15 say which unit it belongs to, without a folder name.",
    fix: <>Admin › <Link className="underline font-semibold" href="/admin/codebook">Site codebook</Link> › Drawing numbers: describe the segments (prefix, unit, sheet).</>,
  });
  out.push({
    title: "Equipment in the registry",
    state: r.assets > 0 ? (r.assetsWithUnit > 0 ? "done" : "partial") : "missing",
    count: `${r.assets} item${r.assets === 1 ? "" : "s"}, ${r.assetsWithUnit} with a unit`,
    why: "A tag on a sheet becomes a link only when the registry has that tag. The drawings can build the registry (step 5).",
    fix: <>Operating areas › <Link className="underline font-semibold" href="/admin/assets">Equipment table</Link>: add by hand or let the sweep in step 5 create them from the drawings.</>,
  });
  const readState: State = r.mirrorsLinked === 0 ? "missing" : r.mirrorsWithTags === 0 || r.mirrorsWaiting > 0 ? "partial" : "done";
  out.push({
    title: "P&IDs read from Document Control",
    state: readState,
    count: `${r.mirrorsLinked} read copies linked to documents · ${r.mirrorsWithTags} with equipment tags · ${r.mirrorsWaiting} waiting or in error${r.mirrors > r.mirrorsLinked ? ` · ${r.mirrors - r.mirrorsLinked} uploaded directly (not linked)` : ""}`,
    why: "Tags are read off the sheet by AI once. Copies uploaded straight into Intelligence are not tied to a document, so nothing can link to them. Copies read before tag extraction existed have no tags until rebuilt.",
    fix: (
      <>
        <Link className="underline font-semibold" href="/intelligence">Intelligence</Link> › open (or create) a knowledge library › <b>Sources</b> › add the P&ID folder from Document Control, then <b>Sync</b>. Wait until every document reads &ldquo;ready&rdquo;.
        {r.mirrorsLinked > 0 && r.mirrorsWithTags === 0 && <> Then, in that library, turn on <b>Drawing intelligence</b> (AI settings) and press <b>Rebuild index</b> so the tags are extracted.</>}
      </>
    ),
  });
  out.push({
    title: "Equipment sweep (drawings → registry)",
    state: r.suggestions === 0 ? (r.mirrorsWithTags > 0 ? "missing" : "partial") : r.suggestionsPending > 0 ? "partial" : "done",
    count: `${r.suggestions} drawing${r.suggestions === 1 ? "" : "s"} computed · ${r.suggestionsPending} waiting to apply · ${r.bridgeLibraries} librar${r.bridgeLibraries === 1 ? "y" : "ies"} mapped`,
    why: "Turns the tags read off each sheet into registry items filed under the right unit, and tags the drawing to them.",
    fix: <><Link className="underline font-semibold" href="/documents">Documents</Link> › open the P&ID library › toolbar <b>Equipment</b> › pick the equipment column, tick &ldquo;create assets&rdquo; › <b>Sweep</b> › <b>Apply</b>.</>,
  });
  out.push({
    title: "Resolve links",
    state: r.estateMissing ? "missing" : r.edges.applied > 0 ? "done" : "missing",
    count: r.estateMissing ? "migration 20261020 not applied" : `${r.edges.applied} links in place · ${r.foldersWithUnit} folders and ${r.docsWithUnit} documents to a unit · ${r.docsWithAsset} documents to equipment · ${r.edges.pending} waiting in Review`,
    why: "Reads folder names, drawing numbers and page tags against the codebook and registry, and records every link with its reason. Runs nightly too.",
    fix: <>Press <b>Resolve links</b> above the map after any step above changes something. Then <Link className="underline font-semibold" href="/admin/proposed-links">Intelligence › Review</Link> for the ones it was not sure about.</>,
  });
  out.push({
    title: "Bytes known for read copies",
    state: r.mirrors === 0 ? "partial" : r.mirrorsHashed === 0 ? "missing" : r.mirrorsHashed < r.mirrorsLinked ? "partial" : "done",
    count: `${r.mirrorsHashed} of ${r.mirrors} read copies carry a hash`,
    why: "A copy of a read drawing anywhere else (another folder, the Thor drive) inherits what was read only when the bytes are known.",
    fix: <>Apply migration <code>20261020_one_estate.sql</code> (it backfills hashes from the current versions). New reads carry one automatically.</>,
  });
  return out;
}

export default function EstateReadiness({ orgId, onConnect, connecting }: { orgId: string; onConnect?: () => void; connecting?: boolean }) {
  const [r, setR] = useState<Readiness | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [byHand, setByHand] = useState(false);
  useEffect(() => {
    let alive = true;
    estatePost<Readiness>("/api/estate/readiness", { orgId })
      .then((x) => { if (alive) { setR(x); setErr(null); } })
      .catch((e) => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
  }, [orgId, tick]);
  if (err) return <div className="text-xs text-red-700">{err}</div>;
  if (!r) return <div className="text-xs text-[var(--color-text-muted)] inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Checking what the estate has to work with…</div>;
  const list = steps(r);
  const next = list.find((s) => s.state !== "done");
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-black uppercase tracking-wide text-[var(--color-text-muted)]">Is the estate ready to connect?</div>
        <button onClick={() => setTick((t) => t + 1)} className="text-[11px] inline-flex items-center gap-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><RefreshCw className="w-3 h-3" /> recheck</button>
      </div>
      {next
        ? (
          <div className="text-xs space-y-1.5">
            <div><span className="font-bold">Missing:</span> {next.title.toLowerCase()}.</div>
            {onConnect && (
              <button onClick={onConnect} disabled={connecting} className="w-full rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] px-3 py-1.5 text-xs font-bold inline-flex items-center justify-center gap-1.5 disabled:opacity-60">
                {connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} {connecting ? "Connecting…" : "Connect everything - do all of it for me"}
              </button>
            )}
            <button onClick={() => setByHand((v) => !v)} className="text-[11px] text-[var(--color-text-muted)] hover:underline">{byHand ? "Hide the by-hand steps" : "Or see the by-hand steps"}</button>
          </div>
        )
        : <div className="text-xs text-emerald-700 font-semibold">Every step is in place. Search a tag and the unit, equipment, sheets and photos come together.</div>}
      <ol className="space-y-1.5">
        {list.map((s, i) => {
          const I = s.state === "done" ? CheckCircle2 : s.state === "partial" ? AlertCircle : Circle;
          const tone = s.state === "done" ? "text-emerald-600" : s.state === "partial" ? "text-amber-600" : "text-rose-600";
          return (
            <li key={s.title} className="text-xs">
              <div className="flex items-start gap-1.5">
                <I className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${tone}`} />
                <div className="min-w-0">
                  <div><span className="font-bold">{i + 1}. {s.title}</span> <span className="text-[var(--color-text-muted)]">· {s.count}</span></div>
                  {s.state !== "done" && byHand && <div className="text-[11px] text-[var(--color-text-muted)]">{s.why}</div>}
                  {s.state !== "done" && byHand && <div className="text-[11px]">{s.fix}</div>}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
