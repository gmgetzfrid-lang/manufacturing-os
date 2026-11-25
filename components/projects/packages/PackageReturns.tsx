"use client";

// PackageReturns - where signed package forms come back, with no account:
// opened by the QR on a printed package's cover (that one package) or by a
// contractor's returns link (the project's packages out in the field).
//
// One main action: "Scan a signed form". The phone's camera takes the page;
// each printed form carries a small code, so the scan knows which blank it
// replaces and swaps it in. When the code can't be read, it asks which form
// it is. Pages that aren't one of the forms (extra test charts, photos)
// are added to the package with a name. The drawings line says whether
// every drawing in the package is still the current revision.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Camera, CheckCircle2, CircleAlert, FilePlus2, Search, Upload } from "lucide-react";
import { PageHero, PageBody, Card } from "@/components/ui/PageHero";
import { PublicBar } from "@/components/marketing/PublicChrome";
import { Button } from "@/components/ui/Button";
import { SkeletonText } from "@/components/ui/Skeleton";
import { field as kitField, label as kitLabel } from "@/components/admin/kit";
import DocScanner from "@/components/scan/DocScanner";
import { friendlyError } from "@/lib/friendlyError";
import { tryUpload } from "@/lib/uploadRetry";
import type { ReturnsPackage, ReturnsView } from "@/app/api/package-returns/resolve/route";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function Shell({ kicker, title, sub, children }: { kicker: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-[var(--color-canvas)]">
      <PublicBar />
      <div className="mx-auto w-full max-w-2xl px-2 sm:px-6 pt-6 sm:pt-8 pb-16">
        <PageHero kicker={kicker} title={title} sub={sub} size="md" />
        <PageBody>{children}</PageBody>
      </div>
    </div>
  );
}

/** What the scan or file is for: one of the package's blank forms, or new pages. */
type Target = { itemId: string; title: string } | { itemId: "add"; title: string };

export default function PackageReturns({ code, token }: { code?: string; token?: string }) {
  const q = code ? `c=${encodeURIComponent(code)}` : `t=${encodeURIComponent(token ?? "")}`;
  const [view, setView] = useState<ReturnsView | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const [scanning, setScanning] = useState<Target | "auto" | null>(null);
  const [pending, setPending] = useState<{ pdf: Uint8Array; pages: number } | null>(null);
  const [addTitle, setAddTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/package-returns/resolve?${q}`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as (ReturnsView & { error?: string }) | null;
      if (!res.ok || !body || body.error) { setProblem(body?.error ?? "This page couldn't be opened just now."); setState("error"); return; }
      setView(body); setState("ok");
      if (body.scope === "package" && body.packages[0]) setOpen(body.packages[0].key);
    } catch { setProblem("This page couldn't be opened just now. Check the signal and try again."); setState("error"); }
  }, [q]);
  useEffect(() => { void refresh(); }, [refresh]);

  const pkg: ReturnsPackage | null = view?.packages.find((p) => p.key === open) ?? null;
  const shown = useMemo(() => {
    const t = find.trim().toLowerCase();
    const list = view?.packages ?? [];
    return t ? list.filter((p) => `${p.wos.join(" ")} ${p.equipment} ${p.description}`.toLowerCase().includes(t)) : list;
  }, [view, find]);

  const send = async (target: Target, file: File) => {
    if (!pkg) return;
    setBusy(true); setMsg(null);
    try {
      const form = new FormData();
      if (code) form.set("c", code); else form.set("t", token ?? "");
      form.set("key", pkg.key);
      form.set("itemId", target.itemId);
      if (target.itemId === "add") form.set("title", target.title);
      form.set("file", file);
      const message = await tryUpload(file.name, async () => {
        const res = await fetch("/api/package-returns/upload", { method: "POST", body: form });
        const b = (await res.json().catch(() => null)) as { ok?: boolean; message?: string; error?: string } | null;
        if (!res.ok || !b?.ok) throw new Error(b?.error || `It didn't go through (HTTP ${res.status}).`);
        return b.message;
      });
      setMsg({ tone: "ok", text: message ?? "Sent." });
      setPending(null); setAddTitle("");
      await refresh();
    } catch (e) {
      setMsg({ tone: "err", text: `${friendlyError(e)} The scan is kept: tap Send again.` });
    } finally { setBusy(false); }
  };
  const pdfFile = (pdf: Uint8Array, name: string) => new File([pdf as BlobPart], `${name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "scan"}.pdf`, { type: "application/pdf" });

  // A scan is back: its code says which form it is; else ask.
  const scanned = (out: { pdf: Uint8Array; pages: number; qr: string | null }) => {
    const t = scanning;
    setScanning(null);
    if (!pkg) return;
    if (t && t !== "auto") { void send(t, pdfFile(out.pdf, t.title)); return; }
    const m = out.qr ? /^pkgform:(.+):(it_[a-z0-9]+)$/.exec(out.qr) : null;
    const form = m && m[1] === pkg.key ? pkg.forms.find((f) => f.id === m[2]) : null;
    if (form) { void send({ itemId: form.id, title: form.title }, pdfFile(out.pdf, form.title)); return; }
    if (m && m[1] !== pkg.key) { setMsg({ tone: "err", text: `That form belongs to another package (WO ${m[1]}). Open that package and scan it there.` }); return; }
    setPending(out);
  };

  if (state === "loading") return <Shell kicker="Package returns" title="Opening the package."><Card><SkeletonText lines={4} /></Card></Shell>;
  if (state === "error" || !view) {
    return (
      <Shell kicker="Package returns" title="Couldn't open it.">
        <Card>
          <p className="text-reading text-[var(--color-text)]">{problem}</p>
          <Button variant="secondary" className="mt-3" onClick={() => { setState("loading"); void refresh(); }}>Try again</Button>
        </Card>
      </Shell>
    );
  }

  // ── The project's packages: pick one ──
  if (!pkg) {
    return (
      <Shell kicker={`${view.orgName ?? ""}${view.orgName ? " · " : ""}${view.projectName}`} title="Return signed forms" sub={`For ${view.company}. Pick the work order.`}>
        <Card>
          <label htmlFor="pr-find" className={kitLabel}>Find a work order</label>
          <div className="relative">
            <Search aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
            <input id="pr-find" value={find} onChange={(e) => setFind(e.target.value)} placeholder="WO number or equipment, e.g. E-101" className={`${kitField} pl-9`} inputMode="search" autoComplete="off" />
          </div>
          <ul className="mt-3 grid gap-1.5">
            {shown.map((p) => {
              const done = p.forms.filter((f) => f.signed).length;
              return (
                <li key={p.key}>
                  <button type="button" onClick={() => { setOpen(p.key); setMsg(null); }} className="w-full text-left flex items-center gap-3 min-h-14 px-3 py-2 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
                    <span className="min-w-0 flex-1">
                      <span className="block text-reading font-semibold text-[var(--color-text)] truncate">{p.wos.length ? `WO ${p.wos.join(", ")}` : p.equipment}</span>
                      <span className="block text-body text-[var(--color-text-muted)] truncate">{p.equipment}</span>
                    </span>
                    <span className="shrink-0 text-body tabular-nums text-[var(--color-text-muted)]">{done} of {p.forms.length} back</span>
                  </button>
                </li>
              );
            })}
            {!shown.length && <li className="text-body text-[var(--color-text-muted)]">{view.packages.length ? "No package matches that." : "No packages are out for returns yet."}</li>}
          </ul>
        </Card>
      </Shell>
    );
  }

  // ── One package ──
  const stale = pkg.drawings.filter((d) => !d.current);
  const blanks = pkg.forms.filter((f) => !f.signed).length;
  return (
    <Shell kicker={`${view.projectName}${view.scope === "project" ? ` · ${view.company}` : ""}`}
      title={pkg.wos.length ? `WO ${pkg.wos.join(", ")}` : pkg.equipment}
      sub={pkg.wos.length ? pkg.equipment : pkg.description}>
      {view.scope === "project" && <button type="button" onClick={() => { setOpen(null); setMsg(null); }} className="mb-3 text-body font-medium text-[var(--color-accent-text)] hover:underline min-h-11">All work orders</button>}

      {pkg.drawings.length > 0 && (
        <Card>
          {stale.length ? (
            <div role="alert" className="flex items-start gap-2 text-reading">
              <span aria-hidden className="mt-2 w-2 h-2 rounded-full bg-[var(--state-overdue)] shrink-0" />
              <p className="text-[var(--color-text)]"><b>{stale.length} drawing{stale.length === 1 ? " has" : "s have"} a newer revision.</b> {stale.map((d) => `${d.title}: now rev ${d.currentRev ?? "?"} (printed rev ${d.rev ?? "?"})`).join("; ")}. Get the new print before working from it.</p>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-reading text-[var(--color-text)]"><CheckCircle2 aria-hidden className="w-5 h-5 text-[var(--state-released)]" /> All {pkg.drawings.length} drawing{pkg.drawings.length === 1 ? " is" : "s are"} the current revision.</p>
          )}
        </Card>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="text-section font-semibold text-[var(--color-text)] flex-1 min-w-0">Signed forms <span className="text-body font-normal text-[var(--color-text-muted)] tabular-nums">{pkg.forms.length - blanks} of {pkg.forms.length} back</span></h2>
          <Button onClick={() => { setMsg(null); setScanning("auto"); }} disabled={busy}><Camera className="w-4 h-4" /> Scan a signed form</Button>
        </div>
        <p className="mt-1 text-body text-[var(--color-text-muted)]">Lay the form flat in good light. It goes in place of its blank.</p>
        {msg && (msg.tone === "ok"
          ? <p role="status" className="mt-3 flex items-start gap-1.5 text-body text-[var(--color-text)]"><CheckCircle2 aria-hidden className="w-4 h-4 mt-0.5 shrink-0 text-[var(--state-released)]" />{msg.text}</p>
          : <p role="alert" className="mt-3 flex items-start gap-1.5 text-body font-medium text-[var(--state-overdue-text)]"><CircleAlert aria-hidden className="w-4 h-4 mt-0.5 shrink-0" />{msg.text}</p>)}

        {/* A scan whose code couldn't be read: which form is it? */}
        {pending && (
          <div className="mt-3 rounded-lg border border-[var(--color-border-strong)] p-3">
            <p className="text-reading font-semibold text-[var(--color-text)]">Which form is this? ({pending.pages} page{pending.pages === 1 ? "" : "s"})</p>
            <div className="mt-2 grid gap-1.5">
              {pkg.forms.map((f) => (
                <Button key={f.id} variant="secondary" disabled={busy} className="justify-start" onClick={() => void send({ itemId: f.id, title: f.title }, pdfFile(pending.pdf, f.title))}>
                  {f.title}{f.signed ? " (replace the one sent)" : ""}
                </Button>
              ))}
            </div>
            <div className="mt-3">
              <label htmlFor="pr-add" className={kitLabel}>Or add it as new pages, named</label>
              <div className="flex gap-2">
                <input id="pr-add" value={addTitle} onChange={(e) => setAddTitle(e.target.value)} placeholder="e.g. Hydro test chart" className={kitField} />
                <Button variant="secondary" disabled={busy || !addTitle.trim()} onClick={() => void send({ itemId: "add", title: addTitle.trim() }, pdfFile(pending.pdf, addTitle))}>Add</Button>
              </div>
            </div>
            <button type="button" onClick={() => setPending(null)} className="mt-2 min-h-11 text-body text-[var(--color-text-muted)] hover:underline">Throw this scan away</button>
          </div>
        )}

        <ul className="mt-4 grid gap-1">
          {pkg.forms.map((f) => (
            <li key={f.id} className="flex items-center gap-3 min-h-12 py-1">
              <span aria-hidden className={`w-2 h-2 rounded-full shrink-0 ${f.signed ? "bg-[var(--state-released)]" : "bg-[var(--color-text-faint)]"}`} />
              <span className="min-w-0 flex-1">
                <span className="block text-reading text-[var(--color-text)] truncate">{f.title}</span>
                <span className="block text-caption text-[var(--color-text-muted)]">{f.signed ? `Signed copy in, ${when(f.signed.at)}` : "Blank"}</span>
              </span>
              <button type="button" disabled={busy} onClick={() => { setMsg(null); setScanning({ itemId: f.id, title: f.title }); }} aria-label={`Scan ${f.title}`}
                className="shrink-0 inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 px-3 rounded-lg border border-[var(--color-border-strong)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                <Camera aria-hidden className="w-4 h-4" /> {f.signed ? "Rescan" : "Scan"}
              </button>
              <label className="shrink-0 inline-flex items-center justify-center w-10 h-10 pointer-coarse:w-11 pointer-coarse:h-11 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] cursor-pointer" title={`Upload ${f.title} as a file`} aria-label={`Upload ${f.title} as a file`}>
                <Upload aria-hidden className="w-4 h-4" />
                <input type="file" accept="application/pdf,image/jpeg,image/png" className="sr-only" disabled={busy} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void send({ itemId: f.id, title: f.title }, file); }} />
              </label>
            </li>
          ))}
          {!pkg.forms.length && <li className="text-body text-[var(--color-text-muted)]">This package has no forms to return.</li>}
        </ul>
      </Card>

      <Card>
        <h2 className="text-reading font-semibold text-[var(--color-text)]">Other pages</h2>
        <p className="mt-0.5 text-body text-[var(--color-text-muted)]">A chart, a photo, anything else that belongs with this package.</p>
        {pkg.added.length > 0 && (
          <ul className="mt-2 grid gap-0.5">{pkg.added.map((a) => <li key={a.id} className="text-body text-[var(--color-text)]">{a.title}{a.at ? <span className="text-[var(--color-text-muted)]"> · {when(a.at)}</span> : null}</li>)}</ul>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => { setMsg(null); setPending(null); setScanning({ itemId: "add", title: "" }); }}><FilePlus2 className="w-4 h-4" /> Scan pages to add</Button>
          <label className="inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 px-3 rounded-lg border border-[var(--color-border-strong)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] cursor-pointer">
            <Upload aria-hidden className="w-4 h-4" /> Upload a file
            <input type="file" accept="application/pdf,image/jpeg,image/png" className="sr-only" disabled={busy} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void send({ itemId: "add", title: file.name.replace(/\.[a-z0-9]+$/i, "") }, file); }} />
          </label>
        </div>
      </Card>

      {scanning && (
        <DocScanner open title={scanning === "auto" ? "Scan a signed form" : scanning.itemId === "add" ? "Scan pages to add" : `Scan the signed ${scanning.title}`}
          mode={scanning !== "auto" && scanning.itemId === "add" ? "color" : "bw"}
          onClose={() => setScanning(null)}
          onDone={(out) => {
            // Pages to add: named after the scan.
            if (scanning !== "auto" && scanning.itemId === "add") { setScanning(null); setPending(out); return; }
            scanned(out);
          }} />
      )}
    </Shell>
  );
}
