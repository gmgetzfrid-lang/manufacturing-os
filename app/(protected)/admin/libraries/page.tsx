"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import Link from "next/link";
import { Plus, Search, Trash2 } from "lucide-react";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroPrimary } from "@/components/ui/PageHero";
import { tbl, btnRow, btnIcon, link, shortDate, StatusTag } from "@/components/admin/kit";
import { said } from "@/components/admin/said";
import { bandInput, bandInputIcon, bandSelect, plural } from "@/components/admin/band";
import MoreMenu from "@/components/ui/MoreMenu";
import LibraryWizard, { newLibraryDraftKey, newLibraryNameDraftKey } from "./LibraryWizard";
import { clearDraft } from "@/hooks/useDraft";
import DeleteSafetyModal from "./DeleteSafetyModal";
import LibraryAiSwitch from "@/components/documents/LibraryAiSwitch";
import { LibraryConfig } from "@/types/schema";
import { appAlert } from "@/components/providers/DialogProvider";

export default function LibraryAdminPage() {
  const router = useRouter();
  const { activeRole, activeOrgId, uid } = useRole();
  const canManageAi = activeRole === "Admin" || activeRole === "DocCtrl";

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [libraries, setLibraries] = useState<LibraryConfig[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingLib, setEditingLib] = useState<LibraryConfig | null>(null);

  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [neverAi, setNeverAi] = useState<Set<string>>(new Set());
  const [libraryToDelete, setLibraryToDelete] = useState<LibraryConfig | null>(null);

  const [searchTerm, setSearchTerm] = useState("");
  const [sortOrder, setSortOrder] = useState<"name" | "recent">("recent");

  const isController = activeRole === "Admin" || activeRole === "DocCtrl";

  // Guard
  useEffect(() => {
    if (activeRole && !isController) router.push("/dashboard");
  }, [activeRole, isController, router]);

  // Fetch org-scoped libraries
  useEffect(() => {
    const run = async () => {
      if (!activeOrgId) {
        setLibraries([]);
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        const { data, error } = await supabase
          .from("libraries")
          .select("*")
          .eq("org_id", activeOrgId)
          .order("created_at", { ascending: false });
        if (error) throw error;
        const libs = (data || []).map(r => ({
          id: r.id, orgId: r.org_id, name: r.name, type: r.type,
          description: r.description, createdAt: r.created_at, createdBy: r.created_by,
          updatedAt: r.updated_at, updatedBy: r.updated_by,
          customColumns: r.custom_columns ?? [],
          writeAccess: r.write_access ?? [], adminAccess: r.admin_access ?? [],
          readAccess: r.read_access ?? "ALL", visibleTo: r.visible_to ?? [],
          folderSecurity: r.folder_security, defaultNewVisibility: r.default_new_visibility,
          defaultNewAcl: r.default_new_acl, acl: r.acl,
        } as LibraryConfig));
        setLibraries(libs);
        setLoadError(null);
        setNeverAi(new Set(((data || []) as Array<{ id: string; ai_excluded?: boolean }>).filter((r) => r.ai_excluded).map((r) => r.id)));
      } catch (err) {
        console.error("Error fetching libraries:", err);
        setLibraries([]);
        setLoadError(err);
      } finally {
        setLoading(false);
      }
    };

    run();
  }, [activeOrgId, reloadTick]);

  const handleSaveLibrary = async (config: Omit<LibraryConfig, "id">) => {
    if (!activeOrgId) {
      await appAlert({ message: "Pick a workspace first, from your profile.", tone: "danger" });
      return;
    }
    if (!uid) {
      await appAlert({ message: "Your sign-in has expired. Sign in again, then try again.", tone: "danger" });
      return;
    }

    setSaving(true);
    try {
      // Duplicate name guard within org
      const exists = libraries.find(
        (l) =>
          (l.name || "").toLowerCase().trim() === (config.name || "").toLowerCase().trim() &&
          l.id !== editingLib?.id
      );
      if (exists) {
        await appAlert({ message: "A library with this name already exists. Pick another name.", tone: "danger" });
        setSaving(false);
        return;
      }

      const now = new Date().toISOString();
      const dbConfig = {
        name: config.name, type: config.type, description: config.description,
        custom_columns: config.customColumns ?? [],
        write_access: config.writeAccess ?? [], admin_access: config.adminAccess ?? [],
        read_access: config.readAccess ?? "ALL", visible_to: config.visibleTo ?? [],
        folder_security: config.folderSecurity, default_new_visibility: config.defaultNewVisibility,
        default_new_acl: config.defaultNewAcl ?? null, acl: config.acl ?? null,
      };

      if (editingLib) {
        const { error } = await supabase
          .from("libraries")
          .update({ ...dbConfig, updated_at: now, updated_by: uid })
          .eq("id", editingLib.id!);
        if (error) throw error;

        setLibraries((prev) =>
          prev.map((l) => l.id === editingLib.id ? ({ ...l, ...config, orgId: l.orgId ?? activeOrgId } as LibraryConfig) : l)
        );
      } else {
        const { data: newLib, error } = await supabase
          .from("libraries")
          .insert({ ...dbConfig, org_id: activeOrgId, created_at: now, created_by: uid, updated_at: now, updated_by: uid })
          .select("id")
          .single();
        if (error || !newLib) throw error ?? new Error("Failed to create library");

        setLibraries((prev) => [{ id: newLib.id, ...config, orgId: activeOrgId } as LibraryConfig, ...prev]);
        clearDraft(newLibraryDraftKey(activeOrgId));
        clearDraft(newLibraryNameDraftKey(activeOrgId));
        setIsModalOpen(false);
        setEditingLib(null);
        // Straight into the new library.
        router.push(`/documents/${newLib.id}`);
        return;
      }

      setIsModalOpen(false);
      setEditingLib(null);
    } catch (err) {
      console.error("Failed to save library", err);
      await appAlert({ title: "Couldn't save the library", message: said(err), tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  const initiateDelete = (lib: LibraryConfig) => {
    setLibraryToDelete(lib);
    setIsDeleteModalOpen(true);
  };

  const confirmDelete = async () => {
    if (!libraryToDelete) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from("libraries").delete().eq("id", libraryToDelete.id!);
      if (error) throw error;
      setLibraries((prev) => prev.filter((l) => l.id !== libraryToDelete.id));
      setIsDeleteModalOpen(false);
      setLibraryToDelete(null);
    } catch (e) {
      console.error(e);
      await appAlert({ title: "Couldn't delete the library", message: said(e), tone: "danger" });
    } finally {
      setDeleting(false);
    }
  };

  const openCreate = () => {
    setEditingLib(null);
    setIsModalOpen(true);
  };

  const openEdit = (lib: LibraryConfig) => {
    setEditingLib(lib);
    setIsModalOpen(true);
  };

  const filteredLibraries = useMemo(() => {
    const filtered = libraries.filter((l) => {
      const hay = `${l.name || ""} ${l.description || ""}`.toLowerCase();
      return hay.includes(searchTerm.toLowerCase());
    });

    if (sortOrder === "name") {
      filtered.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    }

    return filtered;
  }, [libraries, searchTerm, sortOrder]);

  if (!isController) {
    return (
      <PageShell width="work">
        <PageHero kicker="Admin · Libraries"
          title={activeRole ? "Admin and Doc Control only." : "Libraries"}
          sub={activeRole ? "Only Admin and Doc Control manage libraries." : undefined} />
      </PageShell>
    );
  }

  if (!activeOrgId) {
    return (
      <PageShell width="work">
        <PageHero kicker="Admin · Libraries" title="No workspace picked." sub="Pick one from your profile." />
      </PageShell>
    );
  }

  if (loading) {
    return (
      <PageShell width="work">
        <PageHero kicker="Admin · Libraries" title="Libraries" />
        <PageBody><SkeletonRows rows={4} cols={3} what="libraries" /></PageBody>
      </PageShell>
    );
  }

  const answer = loadError != null && libraries.length === 0 ? "Couldn't load the libraries."
    : libraries.length === 0 ? "No libraries yet."
    : `${plural(libraries.length, "library", "libraries")}.`;

  return (
    <PageShell width="work">
      {/* MODALS */}
      {/* Mounted only while open, so each open starts fresh (and its draft comes back). */}
      {isModalOpen && (
        <LibraryWizard
          orgId={activeOrgId}
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          onSave={handleSaveLibrary}
          isLoading={saving}
          initialData={editingLib}
        />
      )}

      {libraryToDelete && (
        <DeleteSafetyModal
          isOpen={isDeleteModalOpen}
          onClose={() => setIsDeleteModalOpen(false)}
          onConfirm={confirmDelete}
          libraryName={libraryToDelete.name}
          isLoading={deleting}
        />
      )}

      <PageHero
        kicker="Admin · Libraries"
        title={answer}
        sub="Each library sets its own folders, numbering and review steps."
        factsHero="none"
        facts={neverAi.size > 0 ? [{ label: "Kept from the AI", value: neverAi.size }] : undefined}
        primary={<button type="button" onClick={openCreate} className={heroPrimary}><Plus className="w-4 h-4" /> New library</button>}
      >
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <Search className={bandInputIcon} />
            <input
              type="search"
              enterKeyHint="search"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              aria-label="Search libraries"
              placeholder="Find a library by name or description"
              className={bandInput}
            />
          </div>
          <select
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as "name" | "recent")}
            aria-label="Sort"
            className={bandSelect}
          >
            <option value="recent">Newest first</option>
            <option value="name">Name, A to Z</option>
          </select>
          {searchTerm && filteredLibraries.length > 0 && (
            <p className="text-body text-[var(--color-text-muted)] tabular-nums whitespace-nowrap">
              {filteredLibraries.length} of {libraries.length}{" "}
              <button type="button" onClick={() => setSearchTerm("")} className={`ui-hit ${link} font-medium`}>Clear</button>
            </p>
          )}
        </div>
      </PageHero>

      <PageBody>
        {loadError != null ? (
          <ErrorNote error={loadError} title="Couldn't load the libraries." onRetry={() => setReloadTick((n) => n + 1)} />
        ) : filteredLibraries.length === 0 ? (
          <div className={`${tbl.wrap} px-5 py-8 text-center`}>
            {searchTerm ? (
              <p className="text-reading text-[var(--color-text)]">No library matches &ldquo;{searchTerm}&rdquo;. <button type="button" onClick={() => setSearchTerm("")} className={link}>Clear</button></p>
            ) : (
              <>
                <p className="text-reading text-[var(--color-text)]">Drawings, procedures and vendor manuals each live in a library.</p>
                <button type="button" onClick={openCreate} className={`${link} mt-1.5 font-medium`}>Make the first library</button>
              </>
            )}
          </div>
        ) : (
          <div className={tbl.wrap}>
            <table className={tbl.table}>
              <thead className={`${tbl.thead} max-sm:hidden`}>
                <tr>
                  <th className={tbl.th}>Library</th>
                  <th className={`${tbl.th} max-lg:hidden`}>Kind</th>
                  <th className={`${tbl.th} max-md:hidden`}>Who can read</th>
                  <th className={`${tbl.th} max-md:hidden`}>AI reading</th>
                  <th className={`${tbl.th} max-xl:hidden`}>Changed</th>
                  <th className={`${tbl.th} w-[1%]`}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {filteredLibraries.map((lib) => {
                  const roles = lib.readAccess === "ALL" || !lib.readAccess ? null : lib.readAccess;
                  return (
                    <tr key={lib.id} className={`${tbl.tr} max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto]`}>
                      <td className={`${tbl.td} min-w-0`}>
                        <div className="min-w-0">
                          <Link href={`/documents/${lib.id}`} title={`Open ${lib.name}`} className="font-medium text-[var(--color-text)] hover:text-[var(--color-accent-text)] hover:underline underline-offset-2">{lib.name}</Link>
                          {lib.description && <div className="text-body text-[var(--color-text-muted)] line-clamp-1 max-w-[60ch]">{lib.description}</div>}
                          <div className="md:hidden mt-0.5 text-body text-[var(--color-text-muted)]">
                            {[lib.type ? String(lib.type).replace(/_/g, " ") : null, !roles ? "Everyone can read" : roles.length === 0 ? "Nobody can read yet" : `Read: ${roles.join(", ")}`, neverAi.has(lib.id!) ? "Kept from the AI" : null].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                      </td>
                      <td className={`${tbl.td} max-lg:hidden whitespace-nowrap`}>
                        {lib.type ? <span className="text-[var(--color-text-muted)]">{String(lib.type).replace(/_/g, " ")}</span> : null}
                      </td>
                      <td className={`${tbl.td} max-md:hidden`}>
                        {/* Who can read: everyone, or the roles as tags; +N opens the library's settings. */}
                        {!roles ? <span className="text-[var(--color-text)]">Everyone</span> : roles.length === 0 ? <StatusTag tone="warn">Nobody yet</StatusTag> : (
                          <div className="flex flex-wrap items-center gap-1 max-w-[260px]">
                            {roles.slice(0, 3).map((ro) => <span key={ro} className="ui-tag">{ro}</span>)}
                            {roles.length > 3 && (
                              <button type="button" onClick={() => openEdit(lib)} title={`${roles.join(", ")}: change who can read`} className="ui-tag is-more">+{roles.length - 3}</button>
                            )}
                          </div>
                        )}
                      </td>
                      <td className={`${tbl.td} max-md:hidden`}>
                        {activeOrgId && (
                          <LibraryAiSwitch compact orgId={activeOrgId} libraryId={lib.id!} libraryName={lib.name} excluded={neverAi.has(lib.id!)} canChange={canManageAi}
                            onChanged={(x) => setNeverAi((s) => { const n = new Set(s); if (x) n.add(lib.id!); else n.delete(lib.id!); return n; })} />
                        )}
                      </td>
                      <td className={`${tbl.td} max-xl:hidden whitespace-nowrap text-[var(--color-text-muted)]`}>{shortDate(lib.updatedAt as string | undefined) || shortDate(lib.createdAt as string | undefined)}</td>
                      {/* Repeated on every row, so quiet: Edit, and Delete folded into More. */}
                      <td className={`${tbl.td} text-right`}>
                        <div className="flex items-center justify-end gap-1.5">
                          <button type="button" onClick={() => openEdit(lib)} className={btnRow}>Edit</button>
                          <MoreMenu iconOnly label={`More for ${lib.name}`} triggerClass={btnIcon} items={[
                            { icon: <Trash2 className="w-4 h-4" />, label: "Delete library", tone: "bad", onClick: () => initiateDelete(lib) },
                          ]} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </PageBody>
    </PageShell>
  );
}

