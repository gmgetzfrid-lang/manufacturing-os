// projects Round G — J10b UI REMAINDERS: projects-tab A11Y-14. The decision
// controls outside the Quality tab — the intake approvals and link
// controls, the bid table's actions and quote links, the change-order
// decisions, the Costs tab's ledger and entry controls — were 12-19 px boxes.
// They now carry the Quality tab's floor, lifted into ONE shared constant
// (components/projects/decisionTarget.ts): 24 px, 44 px on a coarse pointer,
// set on the control, never by a bare element rule; their clusters are
// spaced 8 px. A census (as a11yProjects.test.ts "A11Y-8 —" does for the
// Quality tab) pins it. Fix pass: the census is INVERTED — every <button> in
// the census files carries the floor unless its click is on an explicit list
// of read-only handlers (disclosure toggles, a dismiss, a read retry, a
// cancel, the PDF opener), so a new write button with any handler name
// fails here. The first pass matched writers by a list of known handler
// names, and a writer named anything else went uncounted. Final review: the
// Documents tab's register (attach, detach) and the Intake tab's
// transition-in panel (adopt, flag to drafting) start writes too, and joined
// the census.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Each `<button …>` opening tag, braces balanced. */
function buttonTags(s: string): string[] {
  const tags: string[] = [];
  for (let at = s.indexOf("<button"); at >= 0; at = s.indexOf("<button", at + 1)) {
    let depth = 0, i = at;
    for (; i < s.length; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}") depth--;
      else if (s[i] === ">" && depth === 0) break;
    }
    tags.push(s.slice(at, i + 1));
  }
  return tags;
}

/** A tag's onClick expression, braces balanced, whitespace collapsed; null
 *  when the tag has none (a submit button — counted as a decision). */
function onClickOf(tag: string): string | null {
  const at = tag.indexOf("onClick={");
  if (at < 0) return null;
  let depth = 0, i = at + "onClick=".length;
  const start = i + 1;
  for (; i < tag.length; i++) {
    if (tag[i] === "{") depth++;
    else if (tag[i] === "}" && --depth === 0) break;
  }
  return tag.slice(start, i).replace(/\s+/g, " ").trim();
}

/** The ONLY clicks that may skip the floor: they write nothing. Each is the
 *  whole handler, anchored — a write appended to one of them is no longer on
 *  the list. Anything not here is a decision control and carries the floor. */
const READ_ONLY: RegExp[] = [
  /^\(\) => set(?:ShowLinks|Open|ShowForm|ShowNewAccount|ShowParties)\(\(v\) => !v\)$/,   // disclosure toggles
  /^\(\) => setOpen\(true\)$/,                                                         // "Create budget line" opens its form
  /^\(\) => \{ setOpen\(false\); setError\(null\); \}$/,                                // …and its cancel
  /^\(\) => setOpenAccount\(isOpen \? null : r\.account\.id\)$/,                         // a ledger line's disclosure
  /^\(\) => setOpen\(expanded \? null : c\.docId\)$/,                                    // a transition-in sheet's disclosure
  /^\(\) => setType\(t\.v\)$/,                                                          // the entry form's type picker
  /^\(\) => setErr\(null\)$/,                                                            // dismiss the banner
  /^\(\) => void refresh\(\)$/,                                                          // a read retry
  /^onCancel$/,                                                                          // a form's cancel
  /^\(ev\) => \{ ev\.stopPropagation\(\); setEditing\(true\); \}$/,                         // the company picker opens
  /^\(\) => \{ setLinking\((?:null|p\.id)\); setLinkPick\([^;]*\); \}$/,                    // the party link picker opens / cancels
  // the bid row's PDF opener (a presigned read) — the whole handler pinned
  /^async \(ev\) => \{ ev\.stopPropagation\(\); setBusy\(true\); try \{ const url = await getFileUrl\(doc\.fileUrl!\); window\.open\(url, "_blank", "noopener,noreferrer"\); \} catch \(e\) \{ setErr\([^;]*\); \} finally \{ setBusy\(false\); \} \}$/,
];
const readOnly = (tag: string) => { const h = onClickOf(tag); return h != null && READ_ONLY.some((re) => re.test(h)); };

const CENSUS: Array<{ file: string; min: number; must: string[] }> = [
  {
    file: "components/projects/IntakePanel.tsx",
    min: 9,
    must: ["void approve(p)", "void reject(p)", "void revoke(l)", "void reissue(l)", "void createLink()"],
  },
  {
    file: "components/projects/cost/QuotesPanel.tsx",
    min: 16,
    must: ["void typeTotal(doc)", "void decline(doc)", "void decline(d)", "void onPost(accountId)", "onClick={onClick}", "message: `Void ", "void revoke(l)"],
  },
  {
    file: "components/projects/cost/ChangeOrdersPanel.tsx",
    min: 4,
    must: ['void decide(co, "approved"', 'void decide(co, "rejected")', "void unwind(co)"],
  },
  {
    file: "components/projects/CostsTab.tsx",
    min: 9,
    must: ['void repair(d, "repost")', 'void repairCo(c, "reverse")', "message: `Void this ", "void link(p)", "void add()"],
  },
  {
    file: "components/projects/ProjectDocumentsCard.tsx",
    min: 3,
    must: ["setAttachOpen((v) => !v)", "void attach(r)", "void detach(r)"],
  },
  {
    file: "components/projects/TransitionInPanel.tsx",
    min: 3,
    must: ["void adoptAllClean()", "void adoptOne(c)", "onFlagCollision(c, impact)"],
  },
];

describe("A11Y-14 — decision controls outside the Quality tab carry the 24 / 44 px floor", () => {
  it("one shared constant, imported by the Quality tab and by every surface below", () => {
    const shared = src("components/projects/decisionTarget.ts");
    expect(shared).toContain('export const DECISION_TARGET = "min-h-6 min-w-6 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:px-3";');
    for (const f of ["components/projects/QualityTab.tsx", ...CENSUS.map((c) => c.file)]) {
      const s = src(f);
      expect(s, f).toContain('import { DECISION_TARGET } from "@/components/projects/decisionTarget";');
      expect(s, f).not.toMatch(/const DECISION_TARGET =/);
    }
    // no bare element rule in the shared stylesheet
    expect(src("app/globals.css")).not.toMatch(/@media \(pointer: coarse\)\s*\{\s*button\b/);
  });

  for (const { file, min, must } of CENSUS) {
    it(`${file}: every button carries the floor unless its click is on the read-only list (counted)`, () => {
      const deciders = buttonTags(src(file)).filter((t) => !readOnly(t));
      const bare = deciders.filter((t) => !t.includes("${DECISION_TARGET}"));
      expect(bare).toEqual([]);
      expect(deciders.length).toBeGreaterThanOrEqual(min);
      for (const label of must) expect(deciders.some((t) => t.includes(label)), label).toBe(true);
    });
  }

  it("the read-only list carries no dead entry: each matches a button in the census files", () => {
    const handlers = CENSUS.flatMap(({ file }) => buttonTags(src(file)).map(onClickOf)).filter((h): h is string => h != null);
    for (const re of READ_ONLY) expect(handlers.some((h) => re.test(h)), String(re)).toBe(true);
  });

  it("the census is inverted: a new write button under ANY handler name, with no floor, is caught", () => {
    const added = `<button onClick={() => void archive(doc)} className="px-1 py-0.5 text-[10px]">Archive</button>`;
    const tags = buttonTags(added);
    expect(tags).toHaveLength(1);
    expect(readOnly(tags[0])).toBe(false);
    expect(tags[0].includes("${DECISION_TARGET}")).toBe(false);
    // a write appended to a read-only toggle leaves the list too
    expect(readOnly(`<button onClick={() => { setOpen(false); setError(null); void archive(doc); }} className="x">`)).toBe(false);
    expect(readOnly(`<button onClick={() => setShowLinks((v) => !v)} className="x">`)).toBe(true);
    // a button with no onClick (a form's submit) is a decision
    expect(readOnly(`<button type="submit" className="x">`)).toBe(false);
  });

  it("decision clusters are spaced 8 px (gap-2 / ml-2), never 4-6 px", () => {
    const intake = src("components/projects/IntakePanel.tsx");
    const approve = intake.slice(intake.lastIndexOf("<span", intake.indexOf("void approve(p)")), intake.indexOf("void approve(p)"));
    expect(approve).toContain('className="ml-auto flex items-center gap-2"');
    const revoke = intake.slice(intake.lastIndexOf('<span className="ml-auto', intake.indexOf("void revoke(l)")), intake.indexOf("void revoke(l)"));
    expect(revoke).toContain('className="ml-auto flex items-center gap-2"');
    const co = src("components/projects/cost/ChangeOrdersPanel.tsx");
    const decide = co.slice(co.lastIndexOf("<span", co.indexOf('void decide(co, "approved"')), co.indexOf('void decide(co, "approved"'));
    expect(decide).toContain('className="ml-auto inline-flex items-center gap-2"');
    const costs = src("components/projects/CostsTab.tsx");
    expect((costs.match(/<span className="inline-flex items-center gap-2 ml-auto">/g) ?? []).length).toBe(2);
    const quotes = src("components/projects/cost/QuotesPanel.tsx");
    expect((quotes.match(/\$\{DECISION_TARGET\} ml-2 inline-flex/g) ?? []).length).toBe(2);   // correct total, Decline beside Award
    expect(quotes).toContain('<span className="inline-flex items-center gap-2">\n      <select value={accountId}');
    const tin = src("components/projects/TransitionInPanel.tsx");
    const bulk = tin.slice(tin.lastIndexOf("<div", tin.indexOf("void adoptAllClean()")), tin.indexOf("void adoptAllClean()"));
    expect(bulk).toContain('className="flex items-center gap-2 flex-wrap rounded-xl');
    const sheet = tin.slice(tin.lastIndexOf("<div", tin.indexOf("void adoptOne(c)")), tin.indexOf("void adoptOne(c)"));
    expect(sheet).toContain('<div className="flex items-center gap-2 flex-wrap">');
    expect(tin.slice(tin.indexOf("void adoptOne(c)"), tin.indexOf("onFlagCollision(c, impact)"))).not.toContain("<div");   // Adopt and Flag to drafting share that cluster
  });
});

// projects Round G J14 — projects-tab A11Y-15. The write buttons outside
// A11Y-14's surfaces — the project page's Members tab (add, save a
// responsibility, make owner, remove), StatusControl's status menu and its
// reason confirm, ProgressControl's quick-percent buttons, the stale-checkout
// release and EditProjectModal's Save — carry the same floor, under the
// same INVERTED census: every <button> in these files (the project page:
// its MembersTab only — the rest of that page is A11Y-16's) carries
// DECISION_TARGET unless its whole click is on this list of read-only
// handlers (a menu opener, a Back, a dismiss, a close, the edit form's own
// field controls).
const READ_ONLY_15: RegExp[] = [
  /^\(e\) => \{ e\.stopPropagation\(\); if \(disabled\) \{ onDisabledClick\?\.\(\); return; \} openMenu\(\); \}$/,   // StatusControl's chip opens its menu
  /^\(\) => setPctStep\(false\)$/,                                                                                    // …Back from the percent step
  /^\(\) => setReasonFor\(null\)$/,                                                                                   // …Back from the reason step
  /^\(e\) => \{ e\.stopPropagation\(\); openMenu\(\); \}$/,                                                           // ProgressControl's chip opens its slider
  /^dismissForToday$/,                                                                                                // the stale-checkout banner's dismiss (local only)
  /^close$/,                                                                                                          // the edit modal's close / cancel
  /^\(\) => setVisibility\(v\)$/,                                                                                     // …its visibility field
  /^\(\) => setGoals\(goals\.filter\(\(_, j\) => j !== i\)\)$/,                                                         // …remove a goal from the form
  /^addGoal$/,                                                                                                        // …add a goal to the form
  /^\(\) => setSowDoc\(null\)$/,                                                                                      // …clear the Summary of Work field
  /^\(\) => \{ setSowDoc\(d\); setSowQuery\(""\); \}$/,                                                                 // …pick the Summary of Work
  /^\(\) => setEditingResp\(\(p\) => \(\{ \.\.\.p, \[m\.userId\]: m\.responsibility \?\? "" \}\)\)$/,                    // the Members tab opens a responsibility's editor
];
const readOnly15 = (tag: string) => { const h = onClickOf(tag); return h != null && READ_ONLY_15.some((re) => re.test(h)); };
/** The project page's MembersTab, from its declaration to the next top-level function. */
const membersTab = () => {
  const page = src("app/(protected)/projects/[id]/page.tsx");
  const at = page.indexOf("function MembersTab(");
  return page.slice(at, page.indexOf("\nfunction ", at + 1));
};
const CENSUS_15: Array<{ file: string; text: () => string; min: number; must: string[] }> = [
  { file: "app/(protected)/projects/[id]/page.tsx (MembersTab)", text: membersTab, min: 4, must: ["onClick={addByEmail}", "void saveResp(m)", "void makeOwner(m)", "await removeMember("] },
  { file: "components/projects/StatusControl.tsx", text: () => src("components/projects/StatusControl.tsx"), min: 2, must: ["onPick(reasonFor, reason.trim() || undefined)", "choose(s)"] },
  { file: "components/projects/ProgressControl.tsx", text: () => src("components/projects/ProgressControl.tsx"), min: 1, must: ["commit(q)"] },
  { file: "components/projects/StaleCheckoutBanner.tsx", text: () => src("components/projects/StaleCheckoutBanner.tsx"), min: 1, must: ["void release(r)"] },
  { file: "components/projects/EditProjectModal.tsx", text: () => src("components/projects/EditProjectModal.tsx"), min: 1, must: ["void save()"] },
];

describe("A11Y-15 (J14) — the remaining Projects write buttons carry the 24 / 44 px floor", () => {
  it("each file imports the one shared constant and declares none of its own", () => {
    for (const f of ["app/(protected)/projects/[id]/page.tsx", ...CENSUS_15.slice(1).map((c) => c.file)]) {
      const s = src(f);
      expect(s, f).toContain('import { DECISION_TARGET } from "@/components/projects/decisionTarget";');
      expect(s, f).not.toMatch(/const DECISION_TARGET =/);
    }
  });

  for (const { file, text, min, must } of CENSUS_15) {
    it(`${file}: every button carries the floor unless its click is on the read-only list (counted)`, () => {
      const deciders = buttonTags(text()).filter((t) => !readOnly15(t));
      const bare = deciders.filter((t) => !t.includes("${DECISION_TARGET}"));
      expect(bare).toEqual([]);
      expect(deciders.length).toBeGreaterThanOrEqual(min);
      for (const label of must) expect(deciders.some((t) => t.includes(label)), label).toBe(true);
    });
  }

  it("the read-only list carries no dead entry, and a write added to one of its handlers leaves it", () => {
    const handlers = CENSUS_15.flatMap(({ text }) => buttonTags(text()).map(onClickOf)).filter((h): h is string => h != null);
    for (const re of READ_ONLY_15) expect(handlers.some((h) => re.test(h)), String(re)).toBe(true);
    expect(readOnly15(`<button onClick={() => setPctStep(false)} className="x">`)).toBe(true);
    expect(readOnly15(`<button onClick={() => { setPctStep(false); void onSetProgress(50); }} className="x">`)).toBe(false);
    expect(readOnly15(`<button onClick={() => void makeOwner(m)} className="x">`)).toBe(false);
  });

  it("decision clusters are spaced 8 px: the member row's actions, the responsibility save, the status reason confirm and the quick-percent row", () => {
    const members = membersTab();
    expect(members).toContain('<div className="flex items-center gap-2 shrink-0">\n                  {canReceiveOwnership && (');
    expect(members).toContain('<div className="mt-1 flex items-center gap-2">\n                        <input autoFocus value={respDraft}');
    expect(src("components/projects/StatusControl.tsx")).toContain('<div className="flex items-center justify-end gap-2 mt-2">');
    // the 224 px popover holds four 44 px targets a row on a coarse pointer; the fifth wraps
    expect(src("components/projects/ProgressControl.tsx")).toContain('<div className="mt-2 flex flex-wrap items-center gap-2">');
  });

  it("every handler, label and disabled state is unchanged — only the class strings moved", () => {
    const members = membersTab();
    expect(members).toContain("<button onClick={addByEmail} disabled={busy || !addEmail.trim()}");
    expect(members).toContain("<button onClick={() => void saveResp(m)}");
    expect(members).toContain('<button onClick={() => void makeOwner(m)} title="Transfer ownership to this member"');
    expect(members).toContain('title="Remove from project"');
    expect(src("components/projects/StaleCheckoutBanner.tsx")).toContain("disabled={releasingId === r.id}");
    expect(src("components/projects/ProgressControl.tsx")).toContain("disabled={disabled || busy}\n            onClick={() => commit(q)}");
    expect(src("components/projects/EditProjectModal.tsx")).toContain("<button onClick={() => void save()} disabled={busy}");
  });
});
