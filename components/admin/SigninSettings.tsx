"use client";

// Admin → Settings → Sign-in. Which email domains must sign in with
// Microsoft (the company's own accounts, with its multi-factor and
// offboarding), and whether anyone else may have a password account. Password
// accounts always follow the same-day rule: a one-time password must be
// replaced the day it's issued or the account is suspended until an admin
// resets it.

import React, { useEffect, useState } from "react";
import { Section, FormRow, sheet, field } from "@/components/admin/kit";
import { bandSeg, bandSegItem } from "@/components/admin/band";
import { said } from "@/components/admin/said";
import { Button, useActionFeedback } from "@/components/ui/Button";
import { appAlert } from "@/components/providers/DialogProvider";
import { DEFAULT_SIGNIN_POLICY, parseDomains, type SigninPolicy } from "@/lib/signinPolicy";
import { loadSigninPolicy, saveSigninPolicy } from "@/lib/signinPolicyClient";

export default function SigninSettings({ orgId, canEdit, suggestDomain }: { orgId: string; canEdit: boolean; suggestDomain?: string | null }) {
  const [policy, setPolicy] = useState<SigninPolicy>(DEFAULT_SIGNIN_POLICY);
  const [savedPolicy, setSavedPolicy] = useState<SigninPolicy>(DEFAULT_SIGNIN_POLICY);
  const [domains, setDomains] = useState("");
  const [loaded, setLoaded] = useState(false);
  const saveFx = useActionFeedback();

  useEffect(() => {
    let alive = true;
    void loadSigninPolicy(orgId).then((p) => { if (!alive) return; setPolicy(p); setSavedPolicy(p); setDomains(p.microsoftDomains.join(", ")); setLoaded(true); }).catch(() => setLoaded(true));
    return () => { alive = false; };
  }, [orgId]);

  const parsed = parseDomains(domains);
  const dirty = parsed.join(",") !== savedPolicy.microsoftDomains.join(",") || policy.allowPasswords !== savedPolicy.allowPasswords;
  const save = async () => {
    const next = { microsoftDomains: parsed, allowPasswords: policy.allowPasswords };
    try {
      await saveFx.run(() => saveSigninPolicy(orgId, next));
      setPolicy(next); setSavedPolicy(next); setDomains(next.microsoftDomains.join(", "));
    } catch (e) {
      await appAlert({ message: said(e, "Couldn't save the sign-in rules."), tone: "danger" });
    }
  };

  return (
    <Section label="Sign-in">
      <div className={`${sheet} divide-y divide-[var(--color-border)]`}>
        <FormRow label="Microsoft only for" htmlFor="ms-domains"
          hint={<>Emails on these domains must sign in with Microsoft; a password sign-in is refused.{suggestDomain && !parsed.includes(suggestDomain) ? <> Yours is <b className="font-medium">{suggestDomain}</b>.</> : null}</>}>
          <input id="ms-domains" className={field} value={domains} disabled={!canEdit || !loaded} spellCheck={false} autoCapitalize="off"
            onChange={(e) => setDomains(e.target.value)} placeholder="kernenergy.com" />
          {parsed.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{parsed.map((d) => <span key={d} className="ui-tag">{d}</span>)}</div>}
        </FormRow>
        <FormRow label="Everyone else" hint="Contractors and vendors without a company Microsoft account.">
          <div role="radiogroup" aria-label="Everyone else" className={bandSeg}>
            {([[true, "Password account allowed"], [false, "Not allowed in"]] as const).map(([v, text]) => (
              <button key={String(v)} type="button" role="radio" aria-checked={policy.allowPasswords === v} disabled={!canEdit || !loaded}
                onClick={() => setPolicy((p) => ({ ...p, allowPasswords: v }))}
                className={bandSegItem(policy.allowPasswords === v)}>
                {text}
              </button>
            ))}
          </div>
          {policy.allowPasswords && (
            <p className="mt-2 text-body text-[var(--color-text-muted)]">They get a one-time password when added. They must set their own the same day, or the account is suspended until an admin resets it.</p>
          )}
        </FormRow>
        {canEdit && (
          <div className="px-4 sm:px-5 py-3 flex items-center justify-end gap-3">
            {dirty && <span className="text-body text-[var(--color-text-muted)]">Not saved yet</span>}
            <Button variant="secondary" {...saveFx.state} doneLabel="Saved" onClick={() => void save()} disabled={!loaded || (!dirty && !saveFx.done)}
              title={!dirty ? "Nothing changed yet" : undefined}>
              Save sign-in rules
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}
