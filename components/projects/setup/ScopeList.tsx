"use client";

// ScopeList - the project's scope as its work order list says it (Plan tab):
// how many work orders and pieces of equipment, who is still adding scope,
// the work grouped as the list groups it, each line with its tag, what, its
// work order and anything its notes ask for. "Import the list again" reads
// the new version and shows what's new, changed and dropped before anything
// changes; package progress set in the app is kept.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FileSpreadsheet, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { appConfirm } from "@/components/providers/DialogProvider";
import { sayError } from "@/components/projects/sayError";
import { applyScope, byCategory, diffScope, pickSheet, readScope, shared, type ScopeDiff, type ScopeRead } from "@/lib/woIntake";
import { loadScope, readSheets, saveScope, LIST_ACCEPT, type ScopeState } from "@/lib/scopeStore";

const SHOW = 6;
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function ScopeList({ projectId, canManage, noSchedule, actorEmail }: {
  projectId: string; canManage: boolean; noSchedule: boolean; actorEmail?: string;
}) {
  const [scope, setScope] = useState<ScopeState | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<{ file: File; read: ScopeRead; diff: ScopeDiff } | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(() => { loadScope(projectId).then(setScope, () => setScope(null)); }, [projectId]);
  useEffect(() => { load(); }, [load]);

  const take = async (f: File | undefined) => {
    if (!f) return;
    setError(null); setBusy(true);
    try {
      const sheets = (await readSheets(f)).filter((s) => s.rows.length > 0);
      // The same tab as last time when it's there; else the approved one.
      const i = scope ? sheets.findIndex((s) => s.name === scope.source.sheet) : -1;
      const sheet = sheets[i >= 0 ? i : pickSheet(sheets)];
      if (!sheet) throw new Error("That file has no rows in it.");
      const sameLayout = scope && sheet.rows.some((r) => r.join("|") === scope.source.headers.join("|"));
      const read = readScope(sheet, sameLayout ? scope!.source.map : undefined);
      if (!read.items.length) throw new Error("No work order numbers found in it. Check it's the work order list.");
      if (!scope) { await apply(f, read); return; }
      setIncoming({ file: f, read, diff: diffScope(scope.items, read.items) });
    } catch (e) {
      setError(sayError(e));
    } finally { setBusy(false); }
  };

  const apply = async (file: File, read: ScopeRead, diff?: ScopeDiff) => {
    const before = scope?.items ?? [];
    const next: ScopeState = {
      items: applyScope(before, read.items), coming: read.coming,
      source: { file: file.name, sheet: read.sheet, headers: read.headers, map: read.map },
      imports: [...(scope?.imports ?? []), { at: new Date().toISOString(), by: actorEmail, file: file.name, sheet: read.sheet, added: diff?.added.length ?? read.items.length, changed: diff?.changed.length ?? 0, dropped: diff?.dropped.length ?? 0 }],
    };
    await saveScope(projectId, next);
    setScope(next); setIncoming(null);
  };

  const confirmApply = async () => {
    if (!incoming) return;
    const n = incoming.diff.dropped.length;
    if (n && !(await appConfirm({ title: `Drop ${n} work order${n === 1 ? "" : "s"} from the scope?`, message: `${incoming.diff.dropped.map((x) => x.wo).join(", ")} ${n === 1 ? "is" : "are"} not in the new list. Dropping takes ${n === 1 ? "it" : "them"} off the project's scope.`, confirmLabel: `Drop ${n} and apply`, tone: "danger" }))) return;
    setBusy(true); setError(null);
    try { await apply(incoming.file, incoming.read, incoming.diff); } catch (e) { setError(sayError(e)); } finally { setBusy(false); }
  };

  const groups = useMemo(() => (scope ? byCategory(scope.items) : []), [scope]);
  if (scope === undefined) return null;
  const fileInput = <input ref={input} type="file" accept={LIST_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void take(e.target.files?.[0]); e.target.value = ""; }} />;

  if (!scope) {
    if (!canManage || !noSchedule) return null;
    return (
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 grid gap-2 justify-items-start">
        {fileInput}
        <FileSpreadsheet aria-hidden className="w-6 h-6 text-[var(--color-text-muted)]" />
        <h2 className="font-display text-section font-semibold text-[var(--color-text)]">Scope: import the work order list</h2>
        <p className="text-body text-[var(--color-text-muted)] max-w-prose">The Excel list of approved work orders. Used for the scope, a package for each piece of equipment, and later the schedule and the RFQ&apos;s scope counts.</p>
        <Button onClick={() => input.current?.click()} loading={busy}><Upload className="w-4 h-4" /> Import the list</Button>
        {error && <ErrorNote title={error} />}
      </section>
    );
  }

  const equipment = new Set(scope.items.map((x) => x.equipment || x.wo)).size;
  const drafted = scope.items.filter((x) => x.drafted).length;
  const conditional = scope.items.filter((x) => x.conditional).length;
  const many = shared(scope.items).length;
  const last = scope.imports[scope.imports.length - 1];

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden" aria-labelledby="scope-title">
      {fileInput}
      <div className="px-5 pt-4 pb-3 flex flex-wrap items-start gap-x-4 gap-y-2">
        {/* On a phone the button goes under the title, so neither squeezes. */}
        <div className="min-w-0 flex-1 basis-full sm:basis-auto">
          <h2 id="scope-title" className="font-display text-section font-semibold text-[var(--color-text)]">Scope <span className="font-normal text-[var(--color-text-muted)] tabular-nums">· {scope.items.length} work orders</span></h2>
          <p className="text-caption text-[var(--color-text-muted)] break-words">From {scope.source.file}, tab {scope.source.sheet}{last ? `, imported ${when(last.at)}${last.by ? ` by ${last.by}` : ""}` : ""}</p>
        </div>
        {canManage && <Button variant="secondary" onClick={() => input.current?.click()} loading={busy && !incoming}><Upload className="w-4 h-4" /> Import the list again</Button>}
      </div>

      <div className="px-5 pb-4 flex flex-wrap gap-x-7 gap-y-2">
        <Metric label="Equipment" value={String(equipment)} />
        <Metric label="Packages drafted" value={`${drafted} of ${scope.items.length}`} />
        {conditional > 0 && <Metric label="Depend on inspection" value={String(conditional)} />}
        {many > 0 && <Metric label="Pieces with 2+ WOs" value={String(many)} />}
        {scope.coming.length > 0 && <Metric label="Still adding scope" value={String(scope.coming.length)} />}
      </div>

      {error && <div className="px-5 pb-3"><ErrorNote title={error} /></div>}

      {incoming && (
        <div className="mx-5 mb-4 rounded-lg border border-[var(--color-border-strong)] p-4 grid gap-3">
          <div className="text-body font-semibold text-[var(--color-text)]">{incoming.file.name} against the list on the project</div>
          <div className="text-body text-[var(--color-text)]">
            <b>{incoming.diff.added.length}</b> new · <b>{incoming.diff.changed.length}</b> changed · <b>{incoming.diff.dropped.length}</b> dropped · {incoming.diff.same} the same
          </div>
          <DiffList title="New" rows={incoming.diff.added.map((x) => ({ wo: x.wo, text: x.what }))} />
          <DiffList title="Changed" rows={incoming.diff.changed.map((c) => ({ wo: c.after.wo, text: `${c.after.what} (${c.fields.map((f) => (f === "what" ? "description" : f)).join(", ")} changed)` }))} />
          <DiffList title="Dropped" rows={incoming.diff.dropped.map((x) => ({ wo: x.wo, text: x.what }))} tone="warn" />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => setIncoming(null)} disabled={busy}>Cancel</Button>
            <Button onClick={() => void confirmApply()} loading={busy}>Apply the changes</Button>
          </div>
        </div>
      )}

      {scope.coming.length > 0 && (
        <div className="mx-5 mb-4 rounded-md bg-[var(--color-surface-2)] px-3 py-2.5">
          <div className="text-body font-semibold text-[var(--color-text)]">Scope still coming</div>
          <ul className="mt-1 grid gap-0.5 text-body text-[var(--color-text)]">
            {scope.coming.map((c, i) => <li key={i}>{c.what}{c.owner && <span className="text-[var(--color-text-muted)]"> · {c.owner}</span>}</li>)}
          </ul>
        </div>
      )}

      <div className="border-t border-[var(--color-border)]">
        {groups.map((g) => {
          const isOpen = open[g.category] ?? false;
          const rows = isOpen ? g.items : g.items.slice(0, SHOW);
          return (
            <div key={g.category} className="border-b border-[var(--color-border)] last:border-b-0">
              <div className="px-5 py-2 bg-[var(--color-surface-2)] text-body font-semibold text-[var(--color-text)]">
                {g.category} <span className="font-normal text-[var(--color-text-muted)] tabular-nums">· {g.equipment} piece{g.equipment === 1 ? "" : "s"}, {g.items.length} WO{g.items.length === 1 ? "" : "s"}</span>
              </div>
              <ul>
                {rows.map((x) => (
                  <li key={x.wo} className="px-5 py-2.5 border-t border-[var(--color-border)] first:border-t-0 flex flex-wrap sm:flex-nowrap items-start gap-x-4 gap-y-1">
                    <div className="min-w-0 flex-1">
                      <div className="text-body font-medium text-[var(--color-text)] break-words">
                        {x.tag && <span className="ui-id mr-1.5">{x.tag}</span>}{x.equipmentName || x.equipment}
                      </div>
                      <div className="text-body text-[var(--color-text)] break-words">{x.what}</div>
                      {(x.notes || x.conditional) && (
                        <div className={`text-caption break-words ${/need|add .*drawing|missing/i.test(x.notes) ? "text-[var(--state-held-text)] font-medium" : "text-[var(--color-text-muted)]"}`}>
                          {x.conditional ? "Depends on inspection" : ""}{x.conditional && x.notes && !/inspect for clean/i.test(x.notes) ? " · " : ""}{x.notes && !(x.conditional && /inspect for clean/i.test(x.notes)) ? x.notes : ""}
                        </div>
                      )}
                    </div>
                    <div className="sm:text-right shrink-0 text-caption text-[var(--color-text-muted)]">
                      <div className="tabular-nums">WO {x.wo}</div>
                      <div className="inline-flex items-center gap-1.5"><span aria-hidden className={`w-2 h-2 rounded-full ${x.approved ? "bg-[var(--state-released)]" : x.drafted ? "bg-[var(--state-held)]" : "bg-[var(--color-text-faint)]"}`} />{x.approved ? "Package approved" : x.drafted ? "Package drafted" : "No package yet"}</div>
                    </div>
                  </li>
                ))}
              </ul>
              {g.items.length > SHOW && (
                <button type="button" onClick={() => setOpen((o) => ({ ...o, [g.category]: !isOpen }))} aria-expanded={isOpen}
                  className="w-full flex items-center gap-1.5 px-5 min-h-11 text-left text-body font-medium text-[var(--color-accent-text)] hover:bg-[var(--color-surface-2)]">
                  <ChevronDown aria-hidden className={`ui-chevron w-4 h-4 ${isOpen ? "" : "-rotate-90"}`} />{isOpen ? "Show fewer" : `Show all ${g.items.length}`}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><div className="text-caption text-[var(--color-text-muted)]">{label}</div><div className="text-reading font-semibold tabular-nums text-[var(--color-text)]">{value}</div></div>;
}

function DiffList({ title, rows, tone }: { title: string; rows: Array<{ wo: string; text: string }>; tone?: "warn" }) {
  if (!rows.length) return null;
  return (
    <div>
      <div className={`text-body font-semibold ${tone === "warn" ? "text-[var(--state-held-text)]" : "text-[var(--color-text)]"}`}>{title} · {rows.length}</div>
      <ul className="mt-0.5 grid gap-0.5 text-body text-[var(--color-text)] max-h-48 overflow-y-auto">
        {rows.map((r) => <li key={r.wo} className="break-words"><span className="tabular-nums text-[var(--color-text-muted)]">WO {r.wo}</span> {r.text}</li>)}
      </ul>
    </div>
  );
}
