"use client";

// Admin → Settings → Sign-in. Which email domains must sign in with
// Microsoft (the company's own accounts, with its multi-factor and
// offboarding), and whether anyone else may have a password account. Password
// accounts always follow the same-day rule: a one-time password must be
// replaced the day it's issued or the account is suspended until an admin
// resets it.

import React, { useEffect, useState } from "react";
import { ShieldCheck, Loader2, Check } from "lucide-react";
import { Section, FormRow, sheet, field, btnPrimary } from "@/components/admin/kit";
import { appAlert } from "@/components/providers/DialogProvider";
import { DEFAULT_SIGNIN_POLICY, parseDomains, type SigninPolicy } from "@/lib/signinPolicy";
import { loadSigninPolicy, saveSigninPolicy } from "@/lib/signinPolicyClient";

export default function SigninSettings({ orgId, canEdit, suggestDomain }: { orgId: string; canEdit: boolean; suggestDomain?: string | null }) {
  const [policy, setPolicy] = useState<SigninPolicy>(DEFAULT_SIGNIN_POLICY);
  const [domains, setDomains] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadSigninPolicy(orgId).then((p) => { if (!alive) return; setPolicy(p); setDomains(p.microsoftDomains.join(", ")); setLoaded(true); }).catch(() => setLoaded(true));
    return () => { alive = false; };
  }, [orgId]);

  const parsed = parseDomains(domains);
  const save = async () => {
    setSaving(true); setSaved(false);
    try {
      const next = { microsoftDomains: parsed, allowPasswords: policy.allowPasswords };
      await saveSigninPolicy(orgId, next);
      setPolicy(next); setDomains(next.microsoftDomains.join(", ")); setSaved(true);
    } catch (e) {
      await appAlert({ message: `Couldn't save the sign-in rules: ${e instanceof Error ? e.message : String(e)}`, tone: "danger" });
    } finally { setSaving(false); }
  };

  return (
    <Section label="Sign-in" icon={ShieldCheck}>
      <div className={`${sheet} divide-y divide-[var(--color-border)]`}>
        <FormRow label="Microsoft only for" htmlFor="ms-domains"
          hint={<>Emails on these domains must sign in with Microsoft; a password sign-in is refused.{suggestDomain && !parsed.includes(suggestDomain) ? <> Yours is <b className="font-semibold">{suggestDomain}</b>.</> : null}</>}>
          <input id="ms-domains" className={field} value={domains} disabled={!canEdit || !loaded}
            onChange={(e) => { setDomains(e.target.value); setSaved(false); }} placeholder="kernenergy.com" />
          {parsed.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{parsed.map((d) => <span key={d} className="ui-tag">{d}</span>)}</div>}
        </FormRow>
        <FormRow label="Everyone else" hint="Contractors and vendors without a company Microsoft account.">
          <div role="radiogroup" aria-label="Everyone else" className="inline-flex rounded-md border border-[var(--color-border-strong)] overflow-hidden text-[14px] font-semibold">
            {([[true, "Password account allowed"], [false, "Not allowed in"]] as const).map(([v, text]) => (
              <button key={String(v)} type="button" role="radio" aria-checked={policy.allowPasswords === v} disabled={!canEdit || !loaded}
                onClick={() => { setPolicy((p) => ({ ...p, allowPasswords: v })); setSaved(false); }}
                className={`h-10 px-3.5 ${policy.allowPasswords === v ? "bg-[var(--color-main)] text-white" : "bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
                {text}
              </button>
            ))}
          </div>
          {policy.allowPasswords && (
            <p className="mt-2 text-[13px] text-[var(--color-text-muted)]">They get a one-time password when added. They must set their own the same day, or the account is suspended until an admin resets it.</p>
          )}
        </FormRow>
        {canEdit && (
          <div className="px-4 sm:px-5 py-3 flex items-center justify-end gap-3">
            {saved && <span className="inline-flex items-center gap-1 text-[14px] text-[var(--state-released)]"><Check className="w-4 h-4" /> Saved</span>}
            <button type="button" onClick={() => void save()} disabled={saving || !loaded} className={btnPrimary}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Save sign-in rules
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}
