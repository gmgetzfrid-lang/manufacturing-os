"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import Link from "next/link";
import { Settings, Trash2 } from "lucide-react";
import LoadingBlock from "@/components/ui/LoadingBlock";
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
    return <div className="p-8 text-sm text-[var(--color-text-muted)]">{activeRole ? "Only Admin and Doc Control manage libraries." : "Loading…"}</div>;
  }

  if (!activeOrgId) {
    return (
      <div className="p-8">
        <div className="max-w-3xl mx-auto bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-[var(--color-surface-2)] rounded-xl">
              <Settings className="w-6 h-6 text-[var(--color-text)]" />
            </div>
            <div>
              <h1 className="text-xl font-black text-[var(--color-text)]">Library Administration</h1>
              <p className="text-sm text-[var(--color-text-muted)] mt-1">
                No workspace is selected. Pick one from your profile.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-8">
        <LoadingBlock what="libraries" className="max-w-3xl mx-auto" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-8 pb-20">
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

      <div className="max-w-7xl mx-auto">
        {/* HEADER */}
        <div className="flex flex-col lg:flex-row justify-between lg:items-end mb-10 gap-4">
          <div>
            <div className="flex items-center space-x-3 mb-2">
              <div className="p-3 bg-[var(--color-surface-2)] rounded-xl">
                <Settings className="w-6 h-6 text-[var(--color-text)]" />
              </div>
              <h1 className="text-3xl font-black text-[var(--color-text)] tracking-tight">Library Administration</h1>
            </div>
            <p className="text-[var(--color-text-muted)] font-medium max-w-xl text-sm leading-relaxed" title={`Workspace ${activeOrgId}`}>
              {libraries.length} librar{libraries.length === 1 ? "y" : "ies"}
              {neverAi.size > 0 ? ` · ${neverAi.size} kept from the AI` : ""}
            </p>
          </div>

          <div className="flex items-center gap-3 w-full lg:w-auto min-w-0 flex-wrap">
            <input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search libraries…"
              className="w-full lg:w-72 px-4 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)]"
            />
            <select
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as "name" | "recent")}
              className="px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm"
            >
              <option value="recent">Recent</option>
              <option value="name">Name</option>
            </select>
            <button
              onClick={openCreate}
              className="px-4 py-2 rounded-xl bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] font-bold"
            >
              New Library
            </button>
          </div>
        </div>

        {loadError && (
          <p role="alert" className="mb-4 border-l-2 border-red-500 pl-3 py-1 text-sm text-red-700 dark:text-red-400">
            Couldn&apos;t load libraries: {loadError}{" "}
            <button type="button" onClick={() => setReloadTick((n) => n + 1)} className="font-bold underline">Try again</button>
          </p>
        )}

        {/* LIST */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredLibraries.map((lib) => (
            <div
              key={lib.id}
              className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5 shadow-sm hover:shadow-md transition"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/documents/${lib.id}`} title={`Open ${lib.name} (id ${lib.id})`} className="block text-lg font-black text-[var(--color-text)] truncate hover:underline">{lib.name}</Link>
                  <div className="text-sm text-[var(--color-text-muted)] mt-1 line-clamp-2">{lib.description}</div>
                  <div className="mt-3">
                    {activeOrgId && (
                      <LibraryAiSwitch orgId={activeOrgId} libraryId={lib.id!} libraryName={lib.name} excluded={neverAi.has(lib.id!)} canChange={canManageAi}
                        onChanged={(x) => setNeverAi((s) => { const n = new Set(s); if (x) n.add(lib.id!); else n.delete(lib.id!); return n; })} />
                    )}
                  </div>
                </div>

                {/* Repeated on every card, so quiet: Edit, and Delete folded into More. */}
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => openEdit(lib)}
                    className="px-3 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[var(--color-text)] text-sm font-bold"
                  >
                    Edit
                  </button>
                  <MoreMenu iconOnly label={`More for ${lib.name}`} items={[
                    { icon: <Trash2 className="w-4 h-4" />, label: "Delete library", tone: "bad", onClick: () => initiateDelete(lib) },
                  ]} />
                </div>
              </div>
            </div>
          ))}

          {filteredLibraries.length === 0 && (
            <div className="col-span-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-10 text-center text-[var(--color-text-muted)]">
              {loadError ? "The libraries didn't load." : searchTerm ? "No libraries match that search." : "No libraries yet."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

