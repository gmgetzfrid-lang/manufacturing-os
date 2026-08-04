"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { Settings } from "lucide-react";
import LibraryWizard from "./LibraryWizard";
import DeleteSafetyModal from "./DeleteSafetyModal";
import { LibraryConfig } from "@/types/schema";
import { appAlert } from "@/components/providers/DialogProvider";

export default function LibraryAdminPage() {
  const router = useRouter();
  const { activeRole, activeOrgId, uid } = useRole();

  const [loading, setLoading] = useState(true);
  const [libraries, setLibraries] = useState<LibraryConfig[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingLib, setEditingLib] = useState<LibraryConfig | null>(null);

  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
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
      } catch (err) {
        console.error("Error fetching libraries:", err);
        setLibraries([]);
      } finally {
        setLoading(false);
      }
    };

    run();
  }, [activeOrgId]);

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
      }

      setIsModalOpen(false);
      setEditingLib(null);
    } catch (err) {
      console.error("Failed to save library", err);
      await appAlert({ message: "Error saving library. Please check your permissions.", tone: "danger" });
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
      await appAlert({ message: "Failed to delete library.", tone: "danger" });
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

  if (!isController) return null;

  if (!activeOrgId) {
    return (
      <div className="p-8">
        <div className="max-w-3xl mx-auto bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-slate-900 rounded-xl shadow-lg shadow-slate-900/20">
              <Settings className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-black text-[var(--color-text)]">Library Administration</h1>
              <p className="text-sm text-[var(--color-text-muted)] mt-1">
                No active org selected. Set a default orgId in your user profile or in the app flow.
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
        <div className="max-w-3xl mx-auto text-[var(--color-text-muted)]">Loading libraries...</div>
      </div>
    );
  }

  return (
    <div className="p-8 pb-20">
      {/* MODALS */}
      <LibraryWizard
        orgId={activeOrgId}
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSave={handleSaveLibrary}
        isLoading={saving}
        initialData={editingLib}
      />

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
        <div className="flex flex-col md:flex-row justify-between items-end mb-10 gap-4">
          <div>
            <div className="flex items-center space-x-3 mb-2">
              <div className="p-3 bg-slate-900 rounded-xl shadow-lg shadow-slate-900/20">
                <Settings className="w-6 h-6 text-white" />
              </div>
              <h1 className="text-3xl font-black text-[var(--color-text)] tracking-tight">Library Administration</h1>
            </div>
            <p className="text-[var(--color-text-muted)] font-medium max-w-xl text-sm leading-relaxed">
              Configure document repositories, define dynamic metadata schemas, and control role-based access per org.
            </p>
            <p className="text-[11px] text-[var(--color-text-faint)] mt-2 font-mono">
              orgId: <span className="text-[var(--color-text-muted)]">{activeOrgId}</span>
            </p>
          </div>

          <div className="flex items-center gap-3 w-full md:w-auto">
            <input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search libraries..."
              className="w-full md:w-72 px-4 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10"
            />
            <select
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as "name" | "recent")}
              className="px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm"
            >
              <option value="recent">Recent</option>
              <option value="name">Name</option>
            </select>
            <button
              onClick={openCreate}
              className="px-4 py-2 rounded-xl bg-slate-900 text-white font-bold shadow hover:bg-slate-800"
            >
              New Library
            </button>
          </div>
        </div>

        {/* LIST */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredLibraries.map((lib) => (
            <div
              key={lib.id}
              className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5 shadow-sm hover:shadow-md transition"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-lg font-black text-[var(--color-text)] truncate">{lib.name}</div>
                  <div className="text-sm text-[var(--color-text-muted)] mt-1 line-clamp-2">{lib.description}</div>
                  <div className="text-[11px] text-[var(--color-text-faint)] mt-3 font-mono truncate">
                    libraryId: {lib.id}
                  </div>
                </div>

                <div className="flex flex-col gap-2 shrink-0">
                  <button
                    onClick={() => router.push(`/documents/${lib.id}`)}
                    className="px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-sm font-bold"
                  >
                    Open
                  </button>
                  <button
                    onClick={() => openEdit(lib)}
                    className="px-3 py-2 rounded-xl bg-slate-900 text-white hover:bg-slate-800 text-sm font-bold"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => initiateDelete(lib)}
                    className="px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-red-700 hover:bg-red-100 text-sm font-bold"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}

          {filteredLibraries.length === 0 && (
            <div className="col-span-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-10 text-center text-[var(--color-text-muted)]">
              No libraries found for this org.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

