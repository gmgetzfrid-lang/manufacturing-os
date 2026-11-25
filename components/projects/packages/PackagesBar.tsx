"use client";

// PackagesBar - the project's work order packages at a glance, over the
// scope list: how many are built, approved, printed, how many signed forms
// are back and how many are filed. Its button is the next thing to do for
// all of them at once: set up the kit, build them all from it, print every
// approved one as one print job, file every one whose forms are all back.
// The rest (the kit, a contractor's returns link, the network folder) is
// under its menu.

import React, { useState } from "react";
import { FileStack, FolderOpen, Link2, Package, Printer, Settings2 } from "lucide-react";
import { PDFDocument } from "pdf-lib";
import { Button } from "@/components/ui/Button";
import MoreMenu from "@/components/ui/MoreMenu";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { field as fieldCls, label as labelCls } from "@/components/admin/kit";
import { sayError } from "@/components/projects/sayError";
import { supabase } from "@/lib/supabase";
import { packageGroup, type ScopeWO } from "@/lib/woIntake";
import {
  draftMissing, joinPath, packageStage, sayPackagesChanged, updatePackages,
  type PackageKit, type ProjectPackages,
} from "@/lib/woPackages";
import {
  buildPackagePdf, canWriteToFolder, deleteWorkingCopies, openPdf, projectFolder, withDrawings, writeToFolder,
} from "@/lib/packageOps";

/** The project's equipment groups (one package each), by their key. */
export function packageGroups(items: ScopeWO[]): Map<string, ScopeWO[]> {
  const out = new Map<string, ScopeWO[]>();
  for (const x of items) {
    const g = packageGroup(items, x.wo);
    if (!out.has(g[0].wo)) out.set(g[0].wo, g);
  }
  return out;
}

export default function PackagesBar({
  orgId, projectId, projectName, workspace, logoUrl, tz, uid, actorEmail, canManage, items, kit, all, onOpenKit, onMarkScope,
}: {
  orgId: string; projectId: string; projectName: string; workspace: string; logoUrl?: string | null; tz?: string;
  uid: string | null; actorEmail?: string; canManage: boolean;
  items: ScopeWO[]; kit: PackageKit; all: ProjectPackages;
  onOpenKit: () => void;
  onMarkScope: (wos: string[], what: "drafted" | "approved") => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [panel, setPanel] = useState<null | "link" | "folder">(null);
  const [company, setCompany] = useState("");
  const [folder, setFolder] = useState(all.folder ?? "");

  const groups = packageGroups(items);
  const keys = [...groups.keys()];
  const pkgs = keys.map((k) => all.packages[k]).filter(Boolean);
  const stages = pkgs.map((p) => packageStage(p));
  const missing = keys.filter((k) => !all.packages[k]);
  const approvedOnly = pkgs.filter((p) => p.status === "approved");
  const complete = pkgs.filter((p) => p.status === "issued" && packageStage(p).forms > 0 && packageStage(p).signed === packageStage(p).forms);
  const forms = stages.reduce((n, s) => n + s.forms, 0);
  const signed = stages.reduce((n, s) => n + s.signed, 0);
  const filed = pkgs.filter((p) => p.status === "filed").length;
  const printed = pkgs.filter((p) => p.status === "issued").length;
  const approved = pkgs.filter((p) => p.status !== "draft").length;

  const buildAll = async () => {
    setBusy("Building the packages"); setError(null); setNote(null);
    try {
      const made = await draftMissing(orgId, projectId, groups, kit);
      await onMarkScope(made, "drafted");
      sayPackagesChanged(projectId);
      setNote(`${missing.length} package${missing.length === 1 ? "" : "s"} built from the kit. Open each to add drawings or photos, then approve.`);
    } catch (e) { setError(sayError(e)); } finally { setBusy(null); }
  };

  // Every approved package as one print job.
  const printApproved = async () => {
    setBusy("Putting the packages together"); setError(null); setNote(null);
    try {
      const merged = await PDFDocument.create();
      const done: Array<{ key: string; drawings: Awaited<ReturnType<typeof buildPackagePdf>>["drawings"] }> = [];
      const problems: string[] = [];
      for (const [i, p] of approvedOnly.entries()) {
        setBusy(`Putting together ${i + 1} of ${approvedOnly.length}`);
        const b = await buildPackagePdf({ orgId, projectId, projectName, workspace, logoUrl, pkg: p, kit, tz, who: { email: actorEmail }, withQr: true, signed: false });
        const src = await PDFDocument.load(b.pdf);
        for (const pg of await merged.copyPages(src, src.getPageIndices())) merged.addPage(pg);
        done.push({ key: p.key, drawings: b.drawings });
        problems.push(...b.problems.map((x) => `${p.wos[0] ? `WO ${p.wos[0]}` : p.equipment}: ${x}`));
      }
      openPdf(await merged.save());
      const at = new Date().toISOString();
      await updatePackages(orgId, projectId, (all2) => {
        const next = { ...all2.packages };
        for (const d of done) { const cur = next[d.key]; if (cur && cur.status === "approved") next[d.key] = { ...cur, status: "issued", issuedAt: at, issuedBy: actorEmail, items: withDrawings(cur.items, d.drawings), updatedAt: at }; }
        return { ...all2, packages: next };
      });
      sayPackagesChanged(projectId);
      setNote(`${done.length} package${done.length === 1 ? "" : "s"} printed as one file.`);
      if (problems.length) setError(`Left out: ${problems.join("; ")}`);
    } catch (e) { setError(sayError(e)); } finally { setBusy(null); }
  };

  // Every package with all its forms back, filed in one go.
  const fileComplete = async () => {
    const path = (all.folder ?? "").trim();
    if (!path) { setPanel("folder"); setError("Set the network folder first: the app keeps each file's path in it."); return; }
    if (!canWriteToFolder()) { setError("This browser can't write into a folder. Open each package and file it (it downloads to save there). Chrome and Edge can do them all at once."); return; }
    setError(null); setNote(null);
    const dir = await projectFolder(projectId);
    if (!dir) { setError("No folder picked."); return; }
    setBusy("Filing");
    let ok = 0, deleted = 0;
    const problems: string[] = [];
    try {
      for (const [i, p] of complete.entries()) {
        setBusy(`Filing ${i + 1} of ${complete.length}`);
        try {
          const b = await buildPackagePdf({ orgId, projectId, projectName, workspace, logoUrl, pkg: p, kit, tz, who: { email: actorEmail }, withQr: false, signed: true });
          await writeToFolder(dir, b.fileName, b.pdf);
          const at = new Date().toISOString();
          await updatePackages(orgId, projectId, (a) => ({ ...a, packages: { ...a.packages, [p.key]: { ...a.packages[p.key], status: "filed", filed: { path: joinPath(path, b.fileName), at, by: actorEmail ?? "", pages: b.pages, bytes: b.pdf.byteLength, how: "folder" }, updatedAt: at } } }));
          const r = await deleteWorkingCopies(p);
          deleted += r.deleted;
          if (!r.failed) await updatePackages(orgId, projectId, (a) => ({ ...a, packages: { ...a.packages, [p.key]: { ...a.packages[p.key], purgedAt: new Date().toISOString() } } }));
          ok++;
        } catch (e) { problems.push(`${p.wos[0] ? `WO ${p.wos[0]}` : p.equipment}: ${sayError(e)}`); }
      }
      sayPackagesChanged(projectId);
      setNote(`${ok} filed to ${path}.${deleted ? ` ${deleted} working copies deleted.` : ""}`);
      if (problems.length) setError(problems.join("; "));
    } finally { setBusy(null); }
  };

  const makeLink = async () => {
    const name = company.trim();
    if (!name) { setError("Whose link is it? Type the contractor's name."); return; }
    setBusy("Making the link"); setError(null);
    try {
      const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "").slice(0, 40);
      const { error: e } = await supabase.from("project_intake_links").insert({ org_id: orgId, project_id: projectId, token, company_name: name, purpose: "package-returns", allow_auto_supersede: false, created_by: uid });
      if (e) throw e;
      const url = `${window.location.origin}/submit/${token}`;
      let copied = false;
      try { await navigator.clipboard.writeText(url); copied = true; } catch { /* shown below */ }
      setNote(copied ? `Link for ${name} copied. They pick the work order and send signed forms; no login. Turn it off from the Intake tab.` : `Link for ${name}: ${url}`);
      setCompany(""); setPanel(null);
    } catch (e) { setError(sayError(e)); } finally { setBusy(null); }
  };
  const saveFolder = async () => {
    setBusy("Saving the folder"); setError(null);
    try { await updatePackages(orgId, projectId, (a) => ({ ...a, folder: folder.trim() })); sayPackagesChanged(projectId); setPanel(null); }
    catch (e) { setError(sayError(e)); } finally { setBusy(null); }
  };

  const noKit = !kit.forms.length && !kit.cover && !pkgs.length;
  const next = !canManage ? null
    : noKit ? { label: "Set up the package kit", icon: Settings2, run: async () => onOpenKit() }
    : missing.length ? { label: `Build ${missing.length === keys.length ? "all " : ""}${missing.length} package${missing.length === 1 ? "" : "s"}`, icon: Package, run: buildAll }
    : approvedOnly.length ? { label: `Print ${approvedOnly.length} approved`, icon: Printer, run: printApproved }
    : complete.length ? { label: `File ${complete.length} with every form back`, icon: FolderOpen, run: fileComplete }
    : null;

  return (
    <section aria-label="Work order packages" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 sm:px-4 grid gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <FileStack aria-hidden className="w-5 h-5 text-[var(--color-text-muted)]" />
        <div className="min-w-0 flex-1">
          <div className="text-reading font-semibold text-[var(--color-text)]">Work order packages</div>
          <div className="text-body text-[var(--color-text-muted)] tabular-nums">
            {pkgs.length ? <>{pkgs.length} of {keys.length} built · {approved} approved · {printed + filed} printed{forms ? ` · ${signed} of ${forms} forms back` : ""}{filed ? ` · ${filed} filed` : ""}</> : noKit ? "Set up the kit once: every project's packages build from it." : `${keys.length} to build from the kit`}
          </div>
        </div>
        {busy && <span role="status" className="text-body text-[var(--color-text-muted)]">{busy}…</span>}
        {next && <Button variant="secondary" onClick={() => void next.run()} loading={!!busy} disabled={!!busy}><next.icon className="w-4 h-4" /> {next.label}</Button>}
        {canManage && (
          <MoreMenu label="Packages: more" items={[
            { icon: <Settings2 aria-hidden className="w-4 h-4" />, label: "Package kit", onClick: onOpenKit },
            { icon: <Link2 aria-hidden className="w-4 h-4" />, label: "Returns link for a contractor", onClick: () => { setPanel("link"); setError(null); } },
            { icon: <FolderOpen aria-hidden className="w-4 h-4" />, label: all.folder ? "Network folder" : "Set the network folder", onClick: () => { setFolder(all.folder ?? ""); setPanel("folder"); setError(null); } },
          ]} iconOnly triggerClass="w-10 h-10 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]" />
        )}
      </div>
      {error && <ErrorNote title={error} />}
      {note && <p role="status" className="text-body text-[var(--color-text)]">{note}</p>}

      {panel === "link" && (
        <form onSubmit={(e) => { e.preventDefault(); void makeLink(); }} className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <div>
            <label htmlFor="pb-company" className={labelCls}>Contractor</label>
            <input id="pb-company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="e.g. Ancon" className={fieldCls} autoFocus />
          </div>
          <Button type="submit" variant="secondary" loading={busy === "Making the link"}>Make and copy the link</Button>
          <Button type="button" variant="ghost" onClick={() => setPanel(null)}>Cancel</Button>
          <p className="sm:col-span-3 text-caption text-[var(--color-text-muted)]">Their office picks the work order and sends the signed forms, no login. They see only the packages out in the field: nothing else on the project.</p>
        </form>
      )}
      {panel === "folder" && (
        <form onSubmit={(e) => { e.preventDefault(); void saveFolder(); }} className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <div>
            <label htmlFor="pb-netfolder" className={labelCls}>Network folder for filed packages</label>
            <input id="pb-netfolder" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="e.g. \\kern-fs01\TAR\2027 Crude\Packages" className={fieldCls} spellCheck={false} autoFocus />
          </div>
          <Button type="submit" variant="secondary" loading={busy === "Saving the folder"}>Save</Button>
          <Button type="button" variant="ghost" onClick={() => setPanel(null)}>Cancel</Button>
          <p className="sm:col-span-3 text-caption text-[var(--color-text-muted)]">Filed packages are saved there; the app keeps only each file&apos;s path and deletes its working copies.</p>
        </form>
      )}
    </section>
  );
}
