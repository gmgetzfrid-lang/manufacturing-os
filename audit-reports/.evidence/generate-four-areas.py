#!/usr/bin/env python3
"""Generate four audit areas from the remaining-areas workflow journal."""
import json, difflib, os, re

WF = "/root/.claude/projects/-home-user-manufacturing-os/12cb2d4b-92a9-5f13-b3fe-db344d6251cb/subagents/workflows/wf_ab0ad337-e2f/journal.jsonl"
ROOT = "/home/user/manufacturing-os/audit-reports"

lenses, verds = [], []
for line in open(WF):
    j = json.loads(line)
    if j.get("type") != "result": continue
    r = j.get("result")
    if not isinstance(r, dict): continue
    if "verdicts" in r: verds.append(r["verdicts"])
    elif "lens" in r: lenses.append(r)

def score(batch, lens):
    t = [v["title"] for v in batch]; f = [x["title"] for x in lens.get("findings", [])]
    if not t or not f: return 0
    return sum(max((difflib.SequenceMatcher(None, a, b).ratio() for b in f), default=0) for a in t) / len(t)

used = set()
for L in lenses:
    if L["lens"] == "critic": L["_v"] = None; continue
    best, bs = None, 0
    for i, b in enumerate(verds):
        if i in used: continue
        s = score(b, L)
        if s > bs: bs, best = s, i
    if best is not None and bs > 0.40 and len(verds[best]) == len(L.get("findings", [])):
        used.add(best); L["_v"] = verds[best]
    else: L["_v"] = None

# (match-fragment, area, file, prefix, title, blurb)
SPEC = [
 ("checkout, check-in","document-control","01-checkout.md","DCK","Checkout, check-in & the lock",
  "Whether the lock is a control or a convention."),
 ("revisions, publish","document-control","02-revisions-publish.md","REV","Revisions, publish & supersession",
  "Every path to a published revision, and which ones skip the guard."),
 ("pre-publish review gate","document-control","03-review-gate.md","RG","The review gate & e-signatures",
  "Required signers, invalidation on change, and whether the gate fails open."),
 ("holds and stop-work","document-control","04-holds.md","HLD","Holds & stop-work",
  "Whether a hold blocks every path or only the ones somebody remembered."),
 ("distribution, acknowledgment","document-control","05-distribution.md","DIST","Distribution, acknowledgment & recall",
  "Who was told, who acknowledged, and whether either is provable."),
 ("transmittals and the external","document-control","06-transmittals.md","TRX","Transmittals & the external portal",
  "What leaves the building, and what the recipient can reach."),
 ("doc packs, work packages","document-control","07-packages.md","PKG","Doc packs, work packages & the field bundle",
  "Frozen snapshot or live reference — and what that means when a revision moves."),
 ("retention, legal hold","document-control","08-retention.md","RET","Retention, legal hold, archive & restore",
  "The destructive paths, and what re-checks state before destroying."),
 ("content egress","document-control","09-egress.md","EGR","Content egress",
  "Every way bytes — or the knowledge that they exist — leave the system."),
 ("RLS and persistence across every document-control","document-control","10-rls.md","DRLS","RLS & persistence — table by table",
  "A policy census across the document-control schema."),

 ("the project MODEL","projects-and-cost","01-project-model.md","PM","The project model, membership & lifecycle",
  "The server behaviour beneath the already-audited tabs."),
 ("scheduling: milestones","projects-and-cost","02-scheduling.md","SCHED","Scheduling — dependencies, critical path, import",
  "Read as an algorithm, not as code."),
 ("Quality program","projects-and-cost","03-quality.md","QUAL","The quality program — checklists, turnover, punch",
  "Whether a green item means something a person would sign."),
 ("arithmetic, change-order authority","projects-and-cost","04-cost-and-bids.md","COST","Cost, change orders & bid tabulation",
  "The money. Where a number can be wrong, and where an authoritative figure is AI-derived."),
 ("External intake and the contractor door","projects-and-cost","05-intake-door.md","INTK","External intake & the contractor door",
  "The tokened portal, and whether promoted content enters document control through the guard or around it."),

 ("Org lifecycle, membership and teams","admin-and-org","01-org-lifecycle.md","ORG","Org lifecycle, membership & teams",
  "Signup, invitation, removal, last-admin protection, and what offboarding orphans."),
 ("export, backup, restore","admin-and-org","02-backup-restore.md","BKP","Export, backup, restore & portability",
  "What is in the export set, what is silently absent, and what a restore does to live data."),
 ("the audit log and the admin rails","admin-and-org","03-audit-log.md","ALOG","The audit log & admin rails",
  "What the trail can prove, and whether every admin surface is gated server-side."),
 ("billing, quotas and platform limits","admin-and-org","04-billing.md","BILL","Billing, quotas & platform limits",
  "Including whether a lapsed org loses access to its own regulated records."),

 ("four unauthenticated verify endpoints","public-surfaces","01-verify-endpoints.md","VFY","The public verify endpoints",
  "Unauthenticated. What each returns to someone holding only a scanned code."),
 ("tokenized document share links","public-surfaces","02-share-links.md","SHR","Share links & the short link",
  "Token entropy, expiry, revocation, and whether a share respects a hold."),
 ("the physical bridge","public-surfaces","03-physical-bridge.md","PHYS","The physical bridge — QR, labels, stamps, print",
  "What a printed page asserts, and whether it can be wrong."),
 ("Offline, the service worker","public-surfaces","04-offline-pwa.md","OFF","Offline, the service worker & the field device",
  "The core document-control risk of caching: a superseded drawing served from disk."),

 ("critic","document-control","11-edges-and-invariants.md","XEDGE","Edges, modalities & load-bearing invariants",
  "What twenty-three lenses did not look at — plus what is sound and must not break."),
]

SEV = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2}
def fence(e):
    e = (e or "").strip()
    return "" if not e else (e if "```" in e else "```\n" + e + "\n```")
seen = []
def norm(t): return re.sub(r"[^a-z0-9 ]", "", t.lower())[:70]
def dup_of(t):
    n = norm(t)
    for (on, area, fn, fid) in seen:
        if difflib.SequenceMatcher(None, n, on).ratio() > 0.70: return (area, fn, fid)
    return None

manifest = []
for frag, area, fname, prefix, title, blurb in SPEC:
    # exact-name match wins; substring match is the fallback. Without the exact
    # pass, the frag "critic" matches the scheduling lens ("...critical path...")
    # first and the real critic never ships.
    L = next((x for x in lenses if x["lens"].lower() == frag.lower()), None) or \
        next((x for x in lenses if frag.lower() in x["lens"].lower()), None)
    if L is None: print("!! no lens for", frag); continue
    V = L.get("_v"); rows = []
    for i, f in enumerate(L.get("findings", [])):
        v = V[i] if V else None
        if v is not None and not v.get("survives"): continue
        rows.append({**f, "_sev": (v or {}).get("corrected_severity") or f["severity"],
                     "_ver": (v or {}).get("corrected_verification") or f["verification"],
                     "_corr": (v or {}).get("correction")})
    rows.sort(key=lambda r: (SEV.get(r["_sev"], 9), r["title"]))
    manifest.append([area, fname, prefix, title, blurb, rows, L, V])

for m in manifest:
    for n, r in enumerate(m[5], 1):
        r["_dup"] = dup_of(r["title"]); r["_id"] = f"{m[2]}-{n}"
        seen.append((norm(r["title"]), m[0], m[1], r["_id"]))

for area, fname, prefix, title, blurb, rows, L, V in manifest:
    os.makedirs(os.path.join(ROOT, area), exist_ok=True)
    counts = {}
    for r in rows: counts[r["_sev"]] = counts.get(r["_sev"], 0) + 1
    hdr = " · ".join(f"{counts[s]} {s}" for s in ["CRITICAL","HIGH","MEDIUM"] if s in counts)
    o = [f"# {fname[:2]} · {title}\n", f"**{len(rows)} findings** — {hdr}.\n", blurb + "\n"]
    if V is None:
        o.append("> ### ⚠ NOT adversarially verified\n>\n"
                 "> The completeness critic ran after the verification stage. **Treat every entry as\n"
                 "> `SUSPECTED` regardless of its stated verification, and reproduce before acting**\n"
                 "> (`DEC-29`).\n>\n"
                 "> **This report spans all four areas audited in this run** — document control,\n"
                 "> projects & cost, admin & org, and the public surfaces. It lives here because\n"
                 "> document control is the largest of them; the other three READMEs link to it.\n")
    else:
        o.append("> Each finding survived an adversarial verification pass: a second agent read the\n"
                 "> cited code and tried to refute it. Refuted findings were dropped. A severity set\n"
                 "> by that pass overrides the original.\n")
    subs = L.get("substrate") or []
    if subs:
        o.append("\n### Already there — substrate and sound invariants\n")
        o.append("| Thing | Where | Why it matters |"); o.append("|---|---|---|")
        for s in subs:
            o.append("| %s | `%s` | %s |" % (s["thing"].replace("|","\\|"),
                     s["location"].replace("|","\\|"), s["why_it_matters"].replace("|","\\|").replace("\n"," ")))
        o.append("")
    o.append("\n---\n")
    for r in rows:
        o.append(f'\n<a id="{r["_id"].lower()}"></a>')
        o.append(f'\n## {r["_id"]} · {r["title"].strip()}\n')
        o.append(f'- **Severity:** {r["_sev"]}'); o.append('- **Status:** OPEN')
        o.append(f'- **Verification:** {r["_ver"]}')
        locs = [re.sub(r"^/home/user/manufacturing-os/","",x) for x in (r.get("locations") or [])]
        if locs: o.append("- **Locations:** " + ", ".join(f"`{x}`" for x in locs))
        if r.get("_dup"):
            a2, f2, fid = r["_dup"]
            rel = f"./{f2}" if a2 == area else f"../{a2}/{f2}"
            o.append(f'- **Also surfaced independently as** [`{fid}`]({rel}#{fid.lower()}) — two lenses found this separately. Fix once.')
        o.append("")
        o.append("**Mechanism.** " + r["mechanism"].strip() + "\n")
        o.append("**Failure scenario.** " + r["failure_scenario"].strip() + "\n")
        ev = fence(r.get("evidence"))
        if ev: o.append("**Evidence.**\n"); o.append(ev + "\n")
        if r.get("chain_reaction"): o.append("**Chain reaction.** " + r["chain_reaction"].strip() + "\n")
        if r.get("_corr"): o.append("> **Verifier correction.** " + r["_corr"].strip() + "\n")
        if r.get("done_when"):
            o.append("**Done when.**\n")
            for d in r["done_when"]: o.append(f"- [ ] {d.strip()}")
            o.append("")
        o.append("---")
    open(os.path.join(ROOT, area, fname), "w").write("\n".join(o) + "\n")

byarea = {}
for area, fname, prefix, title, blurb, rows, L, V in manifest:
    d = byarea.setdefault(area, {"n":0,"sev":{},"files":[]})
    d["n"] += len(rows); d["files"].append((fname, title, len(rows), V is None))
    for r in rows: d["sev"][r["_sev"]] = d["sev"].get(r["_sev"],0)+1
for a,d in byarea.items():
    print("%-20s %3d findings  %s" % (a, d["n"], d["sev"]))
print("TOTAL:", sum(d["n"] for d in byarea.values()))
json.dump({a:{"n":d["n"],"sev":d["sev"],"files":d["files"]} for a,d in byarea.items()},
          open("/tmp/claude-0/-home-user-manufacturing-os/12cb2d4b-92a9-5f13-b3fe-db344d6251cb/scratchpad/areas.json","w"), indent=1)
