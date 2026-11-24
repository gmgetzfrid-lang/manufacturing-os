"use client";

// CapabilityPolicyEditor: the "Actions" side of the permissions console.
// Content permissions govern WHO SEES WHAT; this governs WHO MAY DO WHAT:
// every drafting-request workflow transition, holds, force-release, and the
// metrics/admin surfaces. Checkbox grid per capability × role token.
//
// Rails: critical capabilities can never lose Admin (validateCapabilityPolicy
// rejects the save), identity rights (a ticket's own requester/drafter/
// assigned engineer) are not configurable by design, and every save writes a
// before/after audit row. Defaults reproduce historical behavior exactly, so
// an untouched policy changes nothing.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Check, AlertTriangle, Lock } from "lucide-react";
import { Section, tbl, btnLink } from "@/components/admin/kit";
import { said } from "@/components/admin/said";
import { Button, useActionFeedback } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { SkeletonRows } from "@/components/ui/Skeleton";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { useRole } from "@/components/providers/RoleContext";
import { appConfirm } from "@/components/providers/DialogProvider";
import {
  CAPABILITY_DEFS, defaultCapabilityPolicy, loadCapabilityPolicy, saveCapabilityPolicy,
  validateCapabilityPolicy, __resetCapabilityPolicyCache,
  type CapabilityId,
} from "@/lib/capabilityPolicy";

const TOKENS = ["*", "Admin", "DocCtrl", "Manager", "Supervisor", "DraftingSupervisor", "Engineer", "Drafter", "Requester", "Viewer", "Contractor", "Auditor"];
const TOKEN_LABEL: Record<string, string> = { "*": "Everyone", DraftingSupervisor: "DraftingSup", Engineer: "Engineer (all tiers)" };

export default function CapabilityPolicyEditor({ canEdit }: { canEdit: boolean }) {
  const { activeOrgId, uid, userEmail } = useRole();
  const [policy, setPolicy] = useState<Record<CapabilityId, string[]> | null>(null);
  const [baseline, setBaseline] = useState<Record<CapabilityId, string[]> | null>(null);
  const [dirty, setDirty] = useState(false);
  const saveFx = useActionFeedback();
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const [loadError, setLoadError] = useState<unknown>(null);
  const load = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      const stored = await loadCapabilityPolicy(activeOrgId);
      const merged = { ...defaultCapabilityPolicy(), ...(stored.caps ?? {}) };
      setPolicy(merged);
      setBaseline(merged);
      setDirty(false);
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
    }
  }, [activeOrgId]);
  // Loads after the first paint (the policy arrives from the network).
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  const areas = useMemo(() => [...new Set(CAPABILITY_DEFS.map((d) => d.area))], []);

  const toggle = (cap: CapabilityId, token: string) => {
    if (!canEdit || !policy) return;
    setPolicy((p) => {
      if (!p) return p;
      const cur = p[cap] ?? [];
      const next = cur.includes(token) ? cur.filter((t) => t !== token) : [...cur, token];
      return { ...p, [cap]: next };
    });
    setDirty(true);
    setMsg(null);
  };

  const save = async () => {
    if (!activeOrgId || !uid || !policy) return;
    const err = validateCapabilityPolicy({ caps: policy });
    if (err) { setMsg({ tone: "err", text: err }); return; }
    // IMPACT PREVIEW — spell out exactly what changes before it takes effect.
    const changes: string[] = [];
    for (const d of CAPABILITY_DEFS) {
      const was = baseline?.[d.id] ?? d.defaultRoles;
      const now = policy[d.id] ?? [];
      const added = now.filter((t) => !was.includes(t));
      const removed = was.filter((t) => !now.includes(t));
      if (added.length || removed.length) {
        changes.push(`${d.label}: ${added.length ? `adds ${added.map((t) => TOKEN_LABEL[t] ?? t).join(", ")}` : ""}${added.length && removed.length ? "; " : ""}${removed.length ? `removes ${removed.map((t) => TOKEN_LABEL[t] ?? t).join(", ")}` : ""}`);
      }
    }
    if (changes.length > 0) {
      const ok = await appConfirm({
        title: "Change who can act?",
        message: `It takes effect right away:\n\n${changes.slice(0, 8).join("\n")}${changes.length > 8 ? `\nAnd ${changes.length - 8} more.` : ""}`,
        confirmLabel: "Save",
      });
      if (!ok) return;
    }
    try {
      await saveFx.run(async () => {
        // Keep any per-person grants: this editor only owns the role grid.
        const stored = await loadCapabilityPolicy(activeOrgId);
        await saveCapabilityPolicy({ orgId: activeOrgId, policy: { caps: policy, grants: stored.grants ?? [] }, actorUserId: uid, actorEmail: userEmail });
      });
      __resetCapabilityPolicyCache();
      setBaseline(policy);
      setDirty(false);
      setMsg({ tone: "ok", text: "Saved. It applies from the next action, and the change is in the audit log." });
    } catch (e) {
      setMsg({ tone: "err", text: said(e, "Couldn't save the action permissions.") });
    }
  };

  const resetDefaults = () => {
    setPolicy(defaultCapabilityPolicy());
    setDirty(true);
    setMsg(null);
  };

  if (!policy) {
    return (
      <Section label="Action permissions">
        {loadError != null
          ? <ErrorNote error={loadError} title="Couldn't load the action permissions." onRetry={() => void load()} />
          : <SkeletonRows rows={5} cols={6} what="action permissions" />}
      </Section>
    );
  }

  return (
    <Section
      label={<>Action permissions <HelpTooltip>Who may do each workflow action. The server checks it on every action, and every save is written to the audit log. A request&apos;s own requester, drafter and assigned engineer always keep their actions on it; that isn&apos;t set here.</HelpTooltip></>}
      action={canEdit ? (
        <div className="flex items-center gap-3">
          {dirty && <span className="text-body text-[var(--color-text-muted)]">Not saved yet</span>}
          <button type="button" onClick={resetDefaults} className={btnLink}>Restore defaults</button>
          <Button {...saveFx.state} doneLabel="Saved" onClick={() => void save()} disabled={!dirty && !saveFx.done}
            title={!dirty ? "Nothing changed yet" : undefined}>
            Save
          </Button>
        </div>
      ) : <span className="text-body text-[var(--color-text-muted)]">Admin and Doc Control can change these</span>}
    >
      {msg && (
        <p role={msg.tone === "ok" ? "status" : "alert"} className={`mb-3 text-body font-medium flex items-start gap-2 ${msg.tone === "ok" ? "text-[var(--color-text)]" : "text-[var(--state-overdue-text)]"}`}>
          {msg.tone === "ok" ? <Check aria-hidden className="w-4 h-4 mt-0.5 shrink-0 text-[var(--state-released)]" /> : <AlertTriangle aria-hidden className="w-4 h-4 mt-0.5 shrink-0" />} {msg.text}
        </p>
      )}
      <div className={`${tbl.wrap} !overflow-x-auto`}>
        <table className="w-full text-body border-collapse tabular-nums">
          <thead className="sticky top-0 z-10">
            <tr className="bg-[var(--color-surface-2)]">
              <th className="sticky left-0 z-10 bg-[var(--color-surface-2)] text-left font-medium text-[var(--color-text-muted)] px-4 h-10 min-w-[240px]">Action</th>
              {TOKENS.map((t) => (
                <th key={t} className="px-2 h-10 font-medium text-[var(--color-text-muted)] whitespace-nowrap">{TOKEN_LABEL[t] ?? t}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {areas.map((area) => (
              <React.Fragment key={area}>
                <tr><th scope="rowgroup" colSpan={TOKENS.length + 1} className="sticky left-0 bg-[var(--color-surface)] text-left px-4 pt-4 pb-1.5 text-reading font-medium text-[var(--color-text)]">{area}</th></tr>
                {CAPABILITY_DEFS.filter((d) => d.area === area).map((d) => (
                  <tr key={d.id} className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
                    <td className="sticky left-0 bg-[var(--color-surface)] px-4 py-2">
                      <span className="text-body font-medium text-[var(--color-text)]">{d.label}</span>
                      {d.critical && <span className="ml-1.5 inline-flex items-center gap-1 text-caption text-[var(--color-text-muted)] align-[1px]" title="Admin always keeps this one"><Lock className="w-3 h-3" aria-hidden /> Admin always</span>}
                      <div className="text-body text-[var(--color-text-muted)] leading-snug max-w-[44ch]">{d.description}</div>
                    </td>
                    {TOKENS.map((t) => {
                      const on = (policy[d.id] ?? []).includes(t);
                      const locked = !canEdit || (d.critical && t === "Admin" && on);
                      return (
                        <td key={t} className="px-2 py-2 text-center">
                          <button
                            type="button"
                            role="checkbox"
                            onClick={() => !locked && toggle(d.id, t)}
                            disabled={locked}
                            title={locked && on && canEdit ? "Admin always keeps this one" : undefined}
                            aria-checked={on}
                            aria-label={`${d.label}: ${TOKEN_LABEL[t] ?? t}`}
                            className={`w-5 h-5 pointer-coarse:w-7 pointer-coarse:h-7 rounded-md border inline-flex items-center justify-center transition-colors ${on ? "border-[var(--color-text)] bg-[var(--color-surface)] text-[var(--color-text)]" : "border-[var(--color-border-control)] bg-[var(--color-surface)] hover:border-[var(--color-text)]"} ${locked ? "opacity-60 cursor-not-allowed" : ""}`}
                          >
                            {on && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-body text-[var(--color-text-muted)]">&ldquo;Engineer&rdquo; covers every tier, Engineer-1 to Engineer-4; the tiers are labels and are checked the same way.</p>
    </Section>
  );
}
