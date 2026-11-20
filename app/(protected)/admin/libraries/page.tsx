"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import Link from "next/link";
import { Plus, Search, Trash2, Library } from "lucide-react";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroPrimary } from "@/components/ui/PageHero";
import { tbl, btnRow, btnIcon, Problem, Pill } from "@/components/admin/kit";
import { bandInput, bandInputIcon, bandSelect, plural } from "@/components/admin/band";
import MoreMenu from "@/components/ui/MoreMenu";
import LibraryWizard, { newLibraryDraftKey } from "./LibraryWizard";
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
  const [loadError, setLoadError] = useState<string | null>(null);
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
        setLoadError(err instanceof Error ? err.message : "Couldn't load libraries.");
      } finally {
        setLoading(false);
      }
    };

    run();
  }, [activeOrgId, reloadTick]);

  const handleSaveLibrary = async (config: Omit<LibraryConfig, "id">) => {
    if (!activeOrgId) {
      await appAlert({ message: "No active org selected. Set an orgId first.", tone: "danger" });
      return;
    }
    if (!uid) {
      await appAlert({ message: "Not authenticated.", tone: "danger" });
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
        await appAlert({ message: "A Library with this name already exists. Please choose a unique name.", tone: "danger" });
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
      const msg = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : "";
      await appAlert({ title: "Couldn't save the library", message: msg || "Check that you have permission to change libraries.", tone: "danger" });
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
      const msg = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : "";
      await appAlert({ title: "Couldn't delete the library", message: msg || "Try again.", tone: "danger" });
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
        <PageHero kicker="Admin · Libraries" overlap={false}
          title={activeRole ? "Admin and Doc Control only." : "Libraries"}
          sub={activeRole ? "Only Admin and Doc Control manage libraries." : "Loading…"} />
      </PageShell>
    );
  }

  if (!activeOrgId) {
    return (
      <PageShell width="work">
        <PageHero kicker="Admin · Libraries" title="No workspace selected." sub="Pick one from your profile." overlap={false} />
      </PageShell>
    );
  }

  if (loading) {
    return (
      <PageShell width="work">
        <PageHero kicker="Admin · Libraries" title="Libraries" overlap={false} />
        <LoadingBlock what="libraries" />
      </PageShell>
    );
  }

  const answer = loadError && libraries.length === 0 ? "Couldn't load libraries."
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
        facts={libraries.length > 0 ? [{ label: "Kept from the AI", value: neverAi.size }] : undefined}
        primary={<button type="button" onClick={openCreate} className={heroPrimary}><Plus className="w-4 h-4" /> New library</button>}
      >
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <Search className={bandInputIcon} />
            <input
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
            <option value="recent">Recent</option>
            <option value="name">Name</option>
          </select>
        </div>
      </PageHero>

      <PageBody>
        {loadError && (
          <Problem retry={() => setReloadTick((n) => n + 1)}>Couldn&apos;t load libraries: {loadError}</Problem>
        )}

        {filteredLibraries.length === 0 ? (
          <div className={`${tbl.wrap} px-5 py-10 text-center text-[var(--color-text-muted)]`}>
            {loadError ? "The libraries didn't load." : searchTerm ? "No libraries match that search." : "Make the first library: drawings, procedures, vendor manuals."}
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
                  <th className={`${tbl.th} w-[1%]`}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {filteredLibraries.map((lib) => {
                  const roles = lib.readAccess === "ALL" || !lib.readAccess ? null : lib.readAccess;
                  return (
                    <tr key={lib.id} className={`${tbl.tr} max-sm:grid max-sm:grid-cols-[1fr_auto]`}>
                      <td className={`${tbl.td} min-w-0`}>
                        <div className="flex items-center gap-3 min-w-0">
                          <span aria-hidden className="ui-icon-tile is-sm"><Library className="w-4 h-4" /></span>
                          <div className="min-w-0">
                            <Link href={`/documents/${lib.id}`} title={`Open ${lib.name}`} className="font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{lib.name}</Link>
                            {lib.description && <div className="text-[14px] text-[var(--color-text-muted)] line-clamp-1 max-w-[60ch]">{lib.description}</div>}
                          </div>
                        </div>
                      </td>
                      <td className={`${tbl.td} max-lg:hidden whitespace-nowrap`}>
                        {lib.type ? <span className="ui-tag capitalize">{String(lib.type).replace(/_/g, " ").toLowerCase()}</span> : null}
                      </td>
                      <td className={`${tbl.td} max-md:hidden`}>
                        {/* Who can read: everyone, or the roles as tags; +N opens the library's settings. */}
                        {!roles ? <Pill tone="brand">Everyone</Pill> : roles.length === 0 ? <Pill tone="warn">Nobody yet</Pill> : (
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

