"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import Link from "next/link";
import { Plus, Search, Trash2 } from "lucide-react";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary } from "@/components/ui/PageHero";
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
        sub={neverAi.size > 0 ? `${neverAi.size} kept from the AI. Each library sets its own folders, numbering and review steps.` : "Each library sets its own folders, numbering and review steps."}
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
          <Card>
            <p role="alert" className="text-[14px] text-red-700 dark:text-red-400">
              Couldn&apos;t load libraries: {loadError}{" "}
              <button type="button" onClick={() => setReloadTick((n) => n + 1)} className="font-bold underline">Try again</button>
            </p>
          </Card>
        )}

        {/* LIST */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredLibraries.map((lib) => (
            <div
              key={lib.id}
              className="bg-[var(--color-surface)] rounded-2xl p-5 shadow-[var(--shadow-card)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/documents/${lib.id}`} title={`Open ${lib.name} (id ${lib.id})`} className="block text-[15px] font-bold text-[var(--color-text)] truncate hover:underline">{lib.name}</Link>
                  <div className="text-[13px] text-[var(--color-text-muted)] mt-1 line-clamp-2">{lib.description}</div>
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
                    type="button"
                    onClick={() => openEdit(lib)}
                    className="h-9 px-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[var(--color-text)] text-[13px] font-semibold"
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
            <div className="col-span-full bg-[var(--color-surface)] shadow-[var(--shadow-card)] rounded-2xl p-10 text-center text-[14px] text-[var(--color-text-muted)]">
              {loadError ? "The libraries didn't load." : searchTerm ? "No libraries match that search." : "Make the first library: drawings, procedures, vendor manuals."}
            </div>
          )}
        </div>
      </PageBody>
    </PageShell>
  );
}

