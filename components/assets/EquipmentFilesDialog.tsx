"use client";

// EquipmentFilesDialog - push the operating areas into document control:
// the Equipment Files library (or a folder in a library you have), laid out
// unit › equipment type › piece of equipment, linked so each unit's page
// pins its folder and each piece of equipment shows its folder's documents.
// Asked here: its own library or a folder in one, and its name. Shows what
// it makes before making it; run again, it adds only what's new.

import React, { useEffect, useMemo, useState } from "react";
import { Check, FolderTree, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { field as fieldCls } from "@/components/admin/kit";
import { sayError } from "@/components/projects/sayError";
import { supabase } from "@/lib/supabase";
import { planSync, planTree, syncCount, type EquipmentTree, type FolderFact, type TreeAsset, type TreeType, type TreeUnit } from "@/lib/equipmentLibrary";
import { folderFacts, liveTree, loadTree, pushTree, treeInputs, type SyncResult } from "@/lib/equipmentLibraryPush";
import { accessWords, defaultLibraryAccess } from "@/lib/libraryAccess";
import type { AccessControl } from "@/types/schema";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export default function EquipmentFilesDialog({ orgId, uid, email, onClose, onDone }: {
  orgId: string; uid: string; email?: string;
  onClose: () => void; onDone?: (tree: EquipmentTree) => void;
}) {
  // The operating areas as the site encoding and the registry have them.
  const [data, setData] = useState<{ units: TreeUnit[]; types: TreeType[]; assets: TreeAsset[] } | null>(null);
  useEffect(() => { let on = true; void treeInputs(orgId).then((d) => { if (on) setData(d); }, () => { if (on) setData({ units: [], types: [], assets: [] }); }); return () => { on = false; }; }, [orgId]);
  const units = useMemo(() => data?.units ?? [], [data]);
  const types = useMemo(() => data?.types ?? [], [data]);
  const assets = useMemo(() => data?.assets ?? [], [data]);
  const [tree, setTree] = useState<EquipmentTree | null | undefined>(undefined);
  const [libs, setLibs] = useState<Array<{ id: string; name: string; acl: AccessControl | null }>>([]);
  // A new library copies the access of one you have ("" = Admin and Document
  // Control add, everyone sees). Never made with no rules.
  const [accessFrom, setAccessFrom] = useState("");
  const [own, setOwn] = useState(true);
  const [name, setName] = useState("Equipment Files");
  const [libId, setLibId] = useState("");
  const [folderName, setFolderName] = useState("Equipment Files");
  // Every unit in the site codebook gets its folder, with equipment or not.
  const [allUnits, setAllUnits] = useState(true);
  // The folders as they are now (to number, rename and move them).
  const [facts, setFacts] = useState<Map<string, FolderFact> | null>(null);
  const [perEquipment, setPerEquipment] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<SyncResult | null>(null);

  useEffect(() => {
    let on = true;
    void Promise.all([loadTree(orgId).then((t) => (t ? liveTree(t) : null)).catch(() => null), supabase.from("libraries").select("id, name, acl").eq("org_id", orgId).order("name")]).then(([t, l]) => {
      if (!on) return;
      const ls = (l.data ?? []) as Array<{ id: string; name: string; acl: AccessControl | null }>;
      setLibs(ls); setTree(t);
      setAccessFrom(ls.find((x) => /drawing/i.test(x.name) && x.acl?.rules?.length)?.id ?? "");
      if (t?.assets) {
        setAllUnits(t.allUnits ?? true);
        setPerEquipment(t.equipmentFolders ?? true);
        void folderFacts(t).then((f) => { if (on) setFacts(f); }, () => { if (on) setFacts(new Map()); });
        setOwn(!!t.own);
        if (t.own) setName(t.libraryName ?? "Equipment Files"); else setLibId(t.libraryId);
      }
      if (!t?.assets || t.own) setLibId(ls.find((x) => /drawing/i.test(x.name))?.id ?? ls[0]?.id ?? "");
    });
    return () => { on = false; };
  }, [orgId]);

  // Same place as before: only what's new is made.
  const samePlace = !!tree?.assets && (own ? !!tree.own && (tree.libraryName ?? "").toLowerCase() === name.trim().toLowerCase() : !tree.own && tree.libraryId === libId);
  const plan = useMemo(() => planTree({ units, types, assets, existing: samePlace ? tree : null, allUnits, equipmentFolders: perEquipment }), [units, types, assets, tree, samePlace, allUnits, perEquipment]);
  // The same place: what's missing is made, what's named differently (type
  // numbers too) is renamed, re-typed equipment is moved.
  const sync = useMemo(() => samePlace && tree && facts ? planSync({ units, types, assets, tree: { ...tree, allUnits, equipmentFolders: perEquipment }, folders: facts }) : null, [samePlace, tree, facts, units, types, assets, allUnits, perEquipment]);
  const unitsWithEquipment = new Set(assets.map((a) => a.unitCode).filter(Boolean)).size;
  const emptyUnits = Math.max(0, units.filter((u) => !assets.some((a) => a.unitCode === u.code)).length);
  const total = sync ? syncCount(sync) : plan.folders.length;
  // Who sees it and adds to it: the library that's there, or the new one's copy.
  const existingLib = own ? libs.find((l) => l.name.trim().toLowerCase() === name.trim().toLowerCase()) ?? null : libs.find((l) => l.id === libId) ?? null;
  const access = accessWords(existingLib ? existingLib.acl : (libs.find((l) => l.id === accessFrom)?.acl ?? defaultLibraryAccess(orgId).acl));
  const placeWords = own ? (name.trim() || "Equipment Files") : `${libs.find((l) => l.id === libId)?.name ?? "…"} › ${folderName.trim() || "Equipment Files"}`;

  const go = async () => {
    setErr(null); setBusy("Starting");
    try {
      const r = await pushTree({ orgId, uid, email, where: own ? { own: true, name, accessFrom: accessFrom || null } : { own: false, libraryId: libId, folderName }, allUnits, equipmentFolders: perEquipment, onStep: setBusy });
      setDone(r); onDone?.(r.tree);
    } catch (e) { setErr(sayError(e)); } finally { setBusy(null); }
  };

  const root = done ? `/documents/${done.tree.libraryId}${done.tree.collectionId ? `?folderId=${done.tree.collectionId}` : ""}` : "";
  return (
    <Modal onClose={onClose} size="lg" dismissable={!busy} labelledBy="ef-title">
      <div className="px-5 sm:px-6 pt-4 pb-3 border-b border-[var(--color-border)] flex items-start gap-3 shrink-0">
        <div className="flex-1 min-w-0">
          <h2 id="ef-title" className="font-display text-section font-semibold text-[var(--color-text)]">Equipment files library</h2>
          <p className="mt-0.5 text-body text-[var(--color-text-muted)]">Document control laid out like your operating areas, linked to each unit and piece of equipment.</p>
        </div>
        <button type="button" onClick={onClose} disabled={!!busy} aria-label="Close" className="-mr-2 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>
      </div>

      <div className="px-5 sm:px-6 py-4 grid gap-5 overflow-y-auto custom-scrollbar flex-1 min-h-0 content-start">
        {done ? (
          <div className="grid gap-2">
            <p className="text-reading font-semibold text-[var(--color-text)] flex items-center gap-2"><Check aria-hidden className="w-5 h-5 text-[var(--state-released)]" />{done.tree.libraryName ?? "Equipment Files"} is ready.</p>
            <ul className="grid gap-1 text-body text-[var(--color-text)] list-disc pl-5">
              <li>{done.made ? `${plural(done.made, "folder")} made` : "Nothing new to make: every folder was already there"}{done.renamed ? `, ${plural(done.renamed, "folder")} numbered or renamed` : ""}{done.moved ? `, ${plural(done.moved, "equipment folder")} moved to its type` : ""}.</li>
              <li>From now on it keeps itself in step: new units, types and equipment get their folders, and renamed or re-typed equipment has its folder follow.</li>
              <li>{done.pinned ? `${plural(done.pinned, "unit page")} now link${done.pinned === 1 ? "s" : ""} to ${done.pinned === 1 ? "its" : "their"} folder.` : "Each unit's page links to its folder."}</li>
              <li>Each piece of equipment shows the documents in its folder, and files filed to equipment from a work package land there.</li>
              <li>{done.marked ? `${plural(done.marked, "folder")} linked in the graph` : "The folders are linked in the graph"}: every document filed in them is drawn to its unit and equipment.</li>
            </ul>
          </div>
        ) : (
          <>
            <section className="grid gap-2">
              <h3 className="text-body font-semibold text-[var(--color-text)]">Where it goes</h3>
              <div role="radiogroup" aria-label="Its own library or a folder in one" className="grid sm:grid-cols-2 gap-2">
                {[{ v: true, t: "Its own library", d: "Recommended: its own access and review settings, and one place every piece of equipment points at." },
                  { v: false, t: "A folder in a library", d: "Inside a library you already have, like Drawings." }].map((o) => (
                  <button key={String(o.v)} type="button" role="radio" aria-checked={own === o.v} onClick={() => setOwn(o.v)} disabled={!!busy}
                    className={`text-left rounded-lg border p-3 grid gap-0.5 ${own === o.v ? "border-[var(--color-current)] ring-1 ring-[var(--color-current)] bg-[var(--color-surface-2)]" : "border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]"}`}>
                    <span className="flex items-center gap-1.5 text-body font-semibold text-[var(--color-text)]">{own === o.v && <Check aria-hidden className="w-4 h-4 text-[var(--color-current)]" />}{o.t}</span>
                    <span className="text-caption text-[var(--color-text-muted)]">{o.d}</span>
                  </button>
                ))}
              </div>
              {own ? (
                <div>
                  <label htmlFor="ef-name" className="block text-body font-medium text-[var(--color-text)] mb-1.5">Library name</label>
                  <input id="ef-name" value={name} onChange={(e) => setName(e.target.value)} className={fieldCls} disabled={!!busy} />
                  {libs.some((l) => l.name.trim().toLowerCase() === name.trim().toLowerCase()) && !samePlace && <p className="mt-1 text-caption text-[var(--color-text-muted)]">A library with this name exists: the folders go in it (no second library).</p>}
                </div>
              ) : (
                <div className="grid sm:grid-cols-2 gap-2">
                  <div>
                    <label htmlFor="ef-lib" className="block text-body font-medium text-[var(--color-text)] mb-1.5">Library</label>
                    <select id="ef-lib" value={libId} onChange={(e) => setLibId(e.target.value)} className={fieldCls} disabled={!!busy}>
                      {libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="ef-folder" className="block text-body font-medium text-[var(--color-text)] mb-1.5">Folder name</label>
                    <input id="ef-folder" value={folderName} onChange={(e) => setFolderName(e.target.value)} className={fieldCls} disabled={!!busy} />
                  </div>
                </div>
              )}
            </section>

            <section className="grid gap-2">
              <h3 className="text-body font-semibold text-[var(--color-text)]">Who sees it and adds files</h3>
              {own && !existingLib ? (
                <div>
                  <label htmlFor="ef-access" className="block text-body font-medium text-[var(--color-text)] mb-1.5">Access</label>
                  <select id="ef-access" value={accessFrom} onChange={(e) => setAccessFrom(e.target.value)} className={fieldCls} disabled={!!busy}>
                    {libs.filter((l) => l.acl?.rules?.length).map((l) => <option key={l.id} value={l.id}>Same as {l.name}</option>)}
                    <option value="">Admin and Document Control add files; everyone sees them</option>
                  </select>
                </div>
              ) : <p className="text-body text-[var(--color-text-muted)]">As {existingLib?.name ?? "the library"} has it{own ? "" : "; the folders inherit it"}.</p>}
              <p className="text-body text-[var(--color-text)]">{access.view} see{access.view === "Everyone in the workspace" ? "s" : ""} the files. {access.add[0].toUpperCase() + access.add.slice(1)} can add and change them.{existingLib || own ? " Change it any time in Libraries." : ""}</p>
              {access.open && <p className="text-body text-[var(--state-held-text)]">{existingLib?.name ?? "This library"} has no access rules, so every member can add and change its files. Set its access in Libraries first.</p>}
            </section>

            <section className="grid gap-2">
              <h3 className="text-body font-semibold text-[var(--color-text)]">What it makes</h3>
              <label className="flex items-start gap-2.5 min-h-11 cursor-pointer">
                <input type="checkbox" checked={perEquipment} onChange={(e) => setPerEquipment(e.target.checked)} className="w-4 h-4 mt-1" disabled={!!busy} />
                <span className="text-body text-[var(--color-text)]">A folder for each piece of equipment<span className="block text-caption text-[var(--color-text-muted)]">Off: files go in their equipment type&apos;s folder.</span></span>
              </label>
              {emptyUnits > 0 && (
                <label className="flex items-start gap-2.5 min-h-11 cursor-pointer">
                  <input type="checkbox" checked={allUnits} onChange={(e) => setAllUnits(e.target.checked)} className="w-4 h-4 mt-1" disabled={!!busy} />
                  <span className="text-body text-[var(--color-text)]">Also the {plural(emptyUnits, "unit")} with no equipment yet<span className="block text-caption text-[var(--color-text-muted)]">Off: a unit gets its folder when its first equipment is added.</span></span>
                </label>
              )}
              <div className="rounded-lg bg-[var(--color-surface-2)] p-3 grid gap-1">
                <p className="text-body text-[var(--color-text)] flex items-start gap-2"><FolderTree aria-hidden className="w-4 h-4 mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
                  <span>{plan.example ? <><b>{placeWords}</b> › {plan.example.join(" › ")}</> : <b>{placeWords}</b>}</span></p>
                <p className="text-body text-[var(--color-text-muted)] tabular-nums">
                  {!data || (samePlace && !sync) ? "Reading the operating areas…" : total === 0 ? "In step: every folder is there and named as the encoding names it."
                    : [plan.counts.units && `${plural(plan.counts.units, "unit folder")} to make`, plan.counts.types && `${plural(plan.counts.types, "type folder")} to make`, plan.counts.equipment && `${plural(plan.counts.equipment, "equipment folder")} to make`,
                      sync?.rename.length && `${plural(sync.rename.length, "folder")} to number or rename`, sync?.move.length && `${plural(sync.move.length, "equipment folder")} to move to its type`].filter(Boolean).join(", ")}
                  {!samePlace && total > 0 && `. ${plural(allUnits ? units.length : unitsWithEquipment, "unit")}.`}
                </p>
                {tree?.assets && samePlace && tree.pushedAt && <p className="text-caption text-[var(--color-text-muted)]">Made {new Date(tree.pushedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}{tree.pushedBy ? ` by ${tree.pushedBy}` : ""}. Nothing is moved or deleted.</p>}
              </div>
            </section>
            {err && <ErrorNote title={err} />}
            {busy && <p role="status" className="text-body text-[var(--color-text-muted)]">{busy}…</p>}
          </>
        )}
      </div>

      <div className="px-5 sm:px-6 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] rounded-b-xl flex flex-wrap items-center gap-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] shrink-0">
        {done ? (
          <>
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <span className="ml-auto" />
            <a href={root} className="inline-flex items-center justify-center gap-1.5 min-h-10 pointer-coarse:min-h-11 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-body font-semibold hover:bg-[var(--color-accent-hover)]">Open {done.tree.libraryName ?? "the library"}</a>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={!!busy}>Cancel</Button>
            <span className="ml-auto" />
            <Button onClick={() => void go()} loading={!!busy} disabled={tree === undefined || !data || total === 0 || (!own && !libId) || (own && !name.trim())}>
              {samePlace ? `Update ${plural(total, "folder")}` : own ? `Make ${name.trim() || "the library"}` : `Make the folders`}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
