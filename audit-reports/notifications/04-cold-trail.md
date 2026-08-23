# 04 · The cold trail — badge propagation

**13 findings** — 1 CRITICAL · 4 HIGH · 8 MEDIUM.

The central complaint: a badge says something needs attention, and the trail does not continue to it.

> Each finding below survived an adversarial verification pass: a second agent read
> the cited code and tried to refute it. Refuted findings were dropped and are not
> recorded. A severity set by that pass overrides the original.


### Already there — reusable substrate

| Thing | Where | Why it matters |
|---|---|---|
| AttentionItem.section — every item in the feed is already stamped with its sidebar section | `hooks/useTicketNotifications.ts:112-116, set at :262 ('requests') and :289 (sectionForKind(n.kind))` | The scoping data the notification center needs already exists on every row. Adding a section value to AttnFilter and passing the leaf's section through openCenter() makes 'click a 3, see the 3' true with roughly ten lines and no schema change. This is the cheapest first link in the chain. |
| lib/docControlRegister.ts RegisterRow — per-document action state ALREADY carrying libraryId and libraryName | `lib/docControlRegister.ts:20-50 (id, number, title, libraryId, libraryName, ownerUserId, reviewStatus, reviewDaysLeft, ack, ackStatus, distributionAcksOutstanding, review, effectivePending, legalHold, dispositionEligible)` | A per-library and per-document 'needs attention' roll-up can be built from this without touching the notifications table at all — the same way the requests queue derives its dots from ticket state rather than from notification rows. It is already grouped by library at register/page.tsx:51-55 to build the library filter. |
| The /register page — the only surface in the app that renders per-document action pills in a list | `app/(protected)/register/page.tsx:162-164 (EffectivePill, ReviewPill, AckPill per row), components/documents/{AckPill,ReviewPill,EffectivePill,RetentionPill}.tsx` | Four reusable, compact, tested pill components exist and are already used in a table row context. Dropping them into the library document table is a wiring job, not a design job. |
| The requests queue's dual red/blue dot — a working, shipped example of the exact pattern the owner wants | `app/(protected)/requests/page.tsx:1037-1038 (table) and :1137-1144 (cards)` | It establishes the visual vocabulary (red pulsing dot = action required, blue dot = unread) and proves the model works when the marker is derived from resource state rather than from notification rows. Copy it to library cards, folder rows, document rows and project cards. |
| ?doc=<id> deep-link resolution on the library page — navigates to the doc's folder, selects it, opens the inspector, optionally full-screens | `app/(protected)/documents/[libraryId]/page.tsx:1276-1319` | The landing mechanism for a per-item trail already exists and handles the hard case (a document in a folder when you land at the library root). Any drill-down only has to produce the URL; arriving is solved. |
| Producers already resolve the container id at notify time and discard it into a URL string | `lib/holds.ts:234-241 (selects library_id), lib/reviewControl.ts:383, lib/distributionAcks.ts:141, lib/staleCopies.ts:201, components/documents/EditOverlapBanner.tsx:92` | Persisting library_id (column or metadata.libraryId) requires no new query in these producers — the value is already in hand. That single change unlocks a one-query per-library roll-up and eliminates the /search?q=<uuid> dead link. |
| collections.pathIds — every folder already carries its ancestor chain | `components/documents/FolderTree.tsx:92 `const pathIds = Array.isArray(target.pathIds) ? target.pathIds : [];`` | A document's count can be fanned up to every ancestor folder with a single map lookup, so a collapsed parent folder can show its subtree's total. The tree already uses pathIds to auto-expand to the current folder — the same walk badges it. |
| notifications_org_resource_idx on (org_id, resource_type, resource_id, created_at DESC) | `supabase/migrations/20260621_in_app_notifications.sql:34-35` | Resource-scoped notification lookups are already indexed, so a per-document 'do I have unread about this?' check is cheap. A per-container index would need the denormalized library_id from the substrate item above. |
| CheckoutStatusCell — an existing per-row status cell in the document table | `components/documents/CheckoutStatusCell.tsx, rendered at app/(protected)/documents/[libraryId]/page.tsx:4148` | The document table already reserves a column for per-row live state and knows how to render an interactive cell there. An attention marker has a home without a layout change. |


---


<a id="trail-1"></a>

## TRAIL-1 · The trail has exactly one link: the sidebar row. No page below /documents, /projects or any library consumes notification state at all

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/navigation/Sidebar.tsx:124`, `app/(protected)/documents/page.tsx:389-467`, `app/(protected)/documents/[libraryId]/page.tsx:3958-4185`, `components/documents/FolderTree.tsx:150-223`, `components/documents/FolderGrid.tsx`, `components/documents/DocGridView.tsx`, `components/documents/InspectorPanel.tsx:411-430`, `app/(protected)/projects/page.tsx:199-261`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **CRITICAL → MEDIUM** by this pass. The finding's central assertion — 'the trail has exactly one link' and the user 'opens the right one by guessing' — is wrong: badge → Notification Center → row → the exact document is a working chain, and the deep-link handler even resolves the doc's folder. What genuinely survives is narrower: no ambient per-library/per-folder/per-row marker exists while browsing, so attention state is invisible unless you enter through a notification row. That is a MEDIUM wayfinding gap, not a CRITICAL dead end.

**Mechanism.** `useTicketNotifications` is the ONLY producer of attention state, and it is imported by exactly five files: Sidebar.tsx, NotificationCenter.tsx, NotificationBell.tsx, dashboard/widgets.tsx and app/(protected)/inbox/page.tsx. Zero document, library, folder, or project surfaces import it, and none query the notifications table directly. So the badge on the 'Documents' row is the terminal node of the chain — the moment you click it and land on /documents you are looking at UI that has no knowledge that a notification exists. The library grid renders only cover / name / description / 'Public Read'|'Controlled' / 'No Access'. The folder tree renders only chevron / folder icon / name / path / visibility pill. The document table row renders only checkbox / columns / status pill / CheckoutStatusCell / stage button / pencil. The inspector's ALERTS zone is document *state* (open branches, active holds), never 'this is the item that badged you'.

**Failure scenario.** Documents shows a blue '3'. User clicks the row, lands on /documents. Six library cards, all visually identical. They open the right one by guessing; the folder tree shows nine folders, all visually identical; the document table shows 140 rows, all visually identical. There is no per-container or per-item marker anywhere to narrow the search, and no 'show me the 3' affordance on the page. The only way to find the item is to reopen the bell — i.e. the sidebar badge was never a trail head, it was a dead-end duplicate of the bell.

**Evidence.**

Sidebar.tsx:124 `const { sectionCounts } = useTicketNotifications();`

Library card body, documents/page.tsx:445-460 — the complete set of markers a library can show:
```
<div className="mt-4 flex flex-wrap gap-2">
  {lib._isPublicRead ? (<span …><Eye className="w-3 h-3" /> Public Read</span>)
   : (<span …><Lock className="w-3 h-3" /> Controlled</span>)}
  {!lib._canRead && !isController && (<span …><AlertTriangle className="w-3 h-3" /> No Access</span>)}
</div>
```
FolderTree.tsx:189-193 — the complete set of markers a folder row can show:
```
{visibility !== "normal" && (
  <span className="text-[10px] px-2 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-amber-700">
    {visibility}
  </span>
)}
```
ProjectCard, projects/page.tsx:216-228 — status pill + Private/Public pill only; no attention marker.

**Chain reaction.** Because the rail is the only badge surface, every fix to the counting logic still lands the user on a page that cannot show them anything. Any drill-down feature has to add a marker at three levels (library card, folder row, doc row) plus a way to reach the marker's source.

> **Verifier correction.** One citation is wrong in a way that does not change the conclusion: FolderTree.tsx is NOT the library page's folder tree. `grep -rn 'FolderTree|FolderGrid|DocGridView|FolderRail'` shows FolderTree is imported only by components/documents/MoveModal.tsx:6 and rendered at MoveModal.tsx:44. The live tree/grid on app/(protected)/documents/[libraryId]/page.tsx are FolderRail (line 3441) and FolderGrid (line 3588). I checked both: `grep -rni 'badge|notif|attention|unread|alert'` over FolderRail.tsx, FolderGrid.tsx and DocGridView.tsx returns one hit total — the word 'unreadable' inside a comment at FolderGrid.tsx:165. The conclusion holds for the components actually on screen; the finding just cited the wrong tree component.

**Done when.**

- [ ] /documents library cards render a per-library unread/action count derived from the same feed the sidebar badge uses
- [ ] the folder tree and folder grid render a per-folder rollup for the currently-open library
- [ ] the document list/grid renders a per-row marker for a document the current user has an unread or action-required notification about
- [ ] opening the badged document clears its marker and decrements the ancestors' counts

---

<a id="trail-2"></a>

## TRAIL-2 · 26 of the 48 notification kinds fall through sectionForKind's default to 'other', and no sidebar row badges 'other' or 'scratchpad' — including every PSM compliance action (ack_requested, review_requested, review_due)

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:71-103`, `hooks/useTicketNotifications.ts:124-132`, `components/navigation/Sidebar.tsx:225-250`, `lib/inAppNotifications.ts:10-58`
- **Also surfaced independently as** [`PROD-1`](./01-producer-census.md#prod-1) — two lenses found this separately. Fix once.
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Verified to the number. Worse than stated: there is no Scratchpad nav item anywhere in the sidebar, so sectionCounts.scratchpad is tallied (useTicketNotifications.ts:247-250) and discarded entirely, exactly like 'other'. Severity HIGH stands — ack_requested is the audit-relevant nudge and the nav rail is the primary wayfinding surface, even though the bell total and /inbox's dedicated pending-ack list still surface the item.

**Mechanism.** `sectionForKind` enumerates 22 kinds across requests/scratchpad/documents/projects and returns 'other' for everything else. `NotificationKind` declares 48 kinds. `emptySectionCounts()` allocates buckets for 'scratchpad' and 'other', and the counts are computed — but `sectionCounts` is consumed at only three places in the entire codebase (Sidebar.tsx:229, :231, :235, for documents / projects / requests). There is no Scratchpad nav item (the route app/(protected)/scratchpad/page.tsx exists but workAll contains no entry for it), so 'scratchpad' and 'other' totals are computed and discarded. Kinds that land in 'other' and are actively emitted include: ack_requested (lib/acknowledgments.ts:375, :501, :580), review_requested (lib/reviewControl.ts:226, :569; app/api/intake/upload/route.ts:106; components/documents/CheckInPanel.tsx:402), review_due (lib/reviewCycles.ts:300), effective_now (lib/effectiveDate.ts:84), deletion_requested (lib/ownership.ts:113), owner_assigned (lib/ownership.ts:143), library_doc_added (documents/[libraryId]/page.tsx:2306), library_doc_revised (lib/postPublish.ts:53), project_comment (lib/projects.ts:450).

**Failure scenario.** An issued revision assigns you a read-and-understand acknowledgment (`ack_requested`). The bell counts it. The Documents row badges nothing, the Projects row badges nothing, no row badges anything. In a PSM/OSHA context the single most audit-relevant nudge in the product — 'you must read & acknowledge an issued revision' — is invisible to the navigation rail. Same for 'you're asked to review & sign off an in-review draft' and 'a controlled document is overdue for periodic review'.

**Evidence.**

hooks/useTicketNotifications.ts:100-102:
```
    default:
      return 'other';
  }
```
hooks/useTicketNotifications.ts:124-132 — buckets that nothing reads:
```
return {
  requests: { total: 0, actionRequired: 0 },
  scratchpad: { total: 0, actionRequired: 0 },
  documents: { total: 0, actionRequired: 0 },
  projects: { total: 0, actionRequired: 0 },
  other: { total: 0, actionRequired: 0 },
};
```
lib/inAppNotifications.ts:43 `| "ack_requested"       // you must read & acknowledge an issued revision`
lib/inAppNotifications.ts:47 `| "review_requested"    // you're asked to review & sign off an in-review draft before it publishes`
Grep for `sectionCounts` across the repo returns hits only in Sidebar.tsx (3 badge sites) and the hook itself; grep for `scratchpad` in components/navigation returns only TopBar.tsx:34's title map.

**Chain reaction.** This is why 'the badge doesn't continue down the chain' feels worse than it is: for the highest-stakes document events the chain never even starts. Fixing propagation without fixing the kind map would still leave ack/review silent.

> **Verifier correction.** Two small citation errors, neither load-bearing: the quoted `| "ack_requested"` line is lib/inAppNotifications.ts:42 (not :43) and `| "review_requested"` is :46 (not :47). Also app/(protected)/scratchpad/page.tsx exists but is a redirect stub — its own comment at line 3 reads 'The standalone Scratchpad was removed (2026-08 cleanup)' and it exports ScratchpadRedirect. The scratchpad bucket is therefore dead by deliberate removal; 'other' is the real problem.

**Done when.**

- [ ] sectionForKind maps every document-scoped kind (ack_*, review_*, library_doc_*, effective_now, owner_*, deletion_requested, retention_eligible, legal_hold_*, access_recert_due, revision_published_over_checkout) to 'documents' and project_comment to 'projects'
- [ ] an exhaustiveness check (switch over NotificationKind with a never-typed default) fails the build when a new kind is added without a section
- [ ] either a nav row consumes sectionCounts.other/scratchpad or those buckets are deleted

---

<a id="trail-3"></a>

## TRAIL-3 · Clicking a section badge opens an UNSCOPED notification center — the '3' on Documents shows you all 17 org-wide items

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/navigation/Sidebar.tsx:537-544`, `components/notifications/NotificationCenter.tsx:76-85`, `components/notifications/NotificationCenter.tsx:112-117`, `components/cockpit/AttentionFeed.tsx:22`
- **Also surfaced independently as** [`TAX-1`](./03-taxonomy.md#tax-1) — two lenses found this separately. Fix once.
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed with no mitigating path: nothing anywhere passes an AttentionSection to the center, and its header line is affirmatively false for section badges, which count only their own section. The AttentionFeed group chips are no substitute — they use the independent groupOf() taxonomy (AttentionFeed.tsx:63-74) that per TAX-5 disagrees with sectionForKind, so a user cannot reconstruct the three Documents items by filtering.

**Mechanism.** The sidebar badge's onClick calls `openCenter('action' | 'all')`. `AttnFilter` has only three values — "all" | "action" | "unread" — none of which is a section. CenterPanel re-mounts `useTicketNotifications()` and filters `items` by that filter only; `AttentionItem.section` exists on every item (set at hooks/useTicketNotifications.ts:262 and :289) but the Center never reads it. So the panel that opens from the Documents badge lists request items, project items and 'other' items too, and its subtitle prints `counts.all` — the org-wide total — as the number the badge supposedly counted.

**Failure scenario.** Documents badge reads 3 (three document notifications). User clicks it. Panel header says '17 items — every badge in the app counts these.' Seventeen rows appear, mostly drafting requests. The three document items are somewhere in that list with no visual distinction. The one surface explicitly built to answer 'the badge says 3 and I can't find them' has just widened the haystack.

**Evidence.**

Sidebar.tsx:537-541 (badge handler):
```
<button
  type="button"
  onClick={(e) => { e.preventDefault(); e.stopPropagation(); openCenter(leaf.badgeTone === 'red' ? 'action' : 'all'); }}
  title="See these notifications"
```
Sidebar.tsx:514 (row handler — the other half of the question): `<Link href={leaf.href}` — a plain navigation to /documents, carrying no filter, no notification id, no section param.

NotificationCenter.tsx:76-85:
```
const counts = {
  all: items.length,
  action: items.filter((i) => i.actionRequired).length,
  unread: items.filter((i) => !i.actionRequired).length,
};
const filtered = filter === "action" ? items.filter((i) => i.actionRequired)
  : filter === "unread" ? items.filter((i) => !i.actionRequired) : items;
```
NotificationCenter.tsx:116: `` `${counts.all} item${counts.all === 1 ? "" : "s"} — every badge in the app counts these.` ``
AttentionFeed.tsx:22: `export type AttnFilter = "all" | "action" | "unread";`

Contrast with the file's own docstring, NotificationCenter.tsx:3-9: "NotificationCenter — the answer to 'the badge says 10 and I can't find them.' … click a 10, see the 10."

**Chain reaction.** This is the cheapest place to restore the trail: `AttentionItem.section` is already populated, so adding a section to AttnFilter and passing `leaf` identity through `openCenter` would make the doorway honest without touching any page.

> **Verifier correction.** Severity overstated at CRITICAL. The panel is unscoped, but it is not a dead end: every row in AttentionFeed carries the item's own deep link (built at useTicketNotifications.ts:293-297), so the user can still reach the item — they just have to find it in an org-wide list. This is a scoping defect layered on top of finding 1, not an independent break in the chain. The finding's line citations for where `section` is set (:262 and :289) are each off by one to two lines (actual: :263 and the shorthand in the object literal near :286).

**Done when.**

- [ ] openCenter accepts a section (or a full filter object) and the sidebar badge passes its own section
- [ ] CenterPanel filters items by that section and its header count equals the number printed on the badge that opened it
- [ ] the panel's empty state names the section when a section filter yields nothing

---

<a id="trail-4"></a>

## TRAIL-4 · Nothing marks a document or project notification read when you visit the thing — only /requests/[id] does, so the Documents badge never decays

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/[id]/page.tsx:919-930`, `app/(protected)/documents/[libraryId]/page.tsx:1284-1319`, `lib/inAppNotifications.ts:187-189`, `components/notifications/NotificationBell.tsx:91`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. The narrow claim is true — only /requests/[id] clears notifications by visiting the resource — but 'the Documents badge never decays' and 'User opens each of the four documents via the bell ... the badge still says 4 because reading was never recorded' are false: clicking through from the bell, the Notification Center, the Needs-You widget or /inbox marks that row read before navigating. The real residue is the asymmetry — arriving at a document by any route other than the notification row leaves it unread — which is a MEDIUM inconsistency, not a badge that can only be cleared by 'mark all read'.

**Mechanism.** `markRead` is called from exactly four places: NotificationBell row click, NotificationCenter row click, dashboard widgets row click, and inbox row click. The only page that clears notifications by visiting the resource is the ticket detail page, which explicitly updates `notifications` where `resource_id = ticketId`. The library page's `?doc=` deep-link effect selects the document and opens the inspector — and does not touch the notifications table. So a user who follows a bell link, reads the document, and closes it still carries the badge.

**Failure scenario.** Bell says 4 on Documents. User opens each of the four documents via the bell, reads them, and returns. The badge still says 4 because reading was never recorded. The only way to clear it is 'mark all read' — which nukes items the user has NOT dealt with. The badge therefore trains users to ignore it, which is the terminal state of the cold-trail complaint.

**Evidence.**

requests/[id]/page.tsx:924-929 — the one place a visit clears the row:
```
// (clearing unread_by alone left the notification rows unread).
supabase.from('notifications')
  .update({ read_at: new Date().toISOString() })
  .eq('user_id', uid).eq('resource_id', ticketId).is('read_at', null)
```
documents/[libraryId]/page.tsx:1292-1299 — the equivalent deep-link handler with no such clear:
```
const target = documents.find((d) => d.id === docId);
if (target) {
  deepLinkPending.current = false;
  setSelectedDoc(target);
  if (wantFull && autoFullScreenedDoc.current !== docId) { … }
  return;
}
```
Grep for `markRead|read_at` across components/, app/, hooks/, lib/ (excluding inAppNotifications.ts) returns no hit in any documents/ or projects/ file.

**Chain reaction.** Combines with the next finding: nothing clears document notifications on visit AND nothing reconciles them when the underlying condition resolves, so the Documents count is monotonically increasing until someone hits 'mark all read'.

> **Verifier correction.** One addition that sharpens rather than weakens the finding: there is a fifth read_at writer, app/api/tickets/workflow-action/route.ts:324-329, which supersedes stale unread workflow rows server-side. It is also ticket-only (`.eq("resource_id", ticketId)`), so it reinforces the asymmetry the finding describes.

**Done when.**

- [ ] opening a document via ?doc= marks that document's unread notifications read for the current user
- [ ] opening a project detail page does the same for project_* rows
- [ ] the badge count drops without requiring 'mark all read'

---

<a id="trail-5"></a>

## TRAIL-5 · tally(section, false) hardcodes actionRequired to zero for every notification-sourced item — the Documents and Projects badges are structurally incapable of turning red

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:301`, `hooks/useTicketNotifications.ts:288`, `hooks/useTicketNotifications.ts:272`, `components/navigation/Sidebar.tsx:128-131`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **HIGH → MEDIUM** by this pass. Claim is exactly right: sectionCounts.documents.actionRequired and .projects.actionRequired are literally unreachable, so those rows can only ever badge blue ('unread FYI' per the Sidebar's own contract at line 22). Downgraded to MEDIUM because no information is lost — the count still renders and the badge button (Sidebar.tsx:537-544) opens the Notification Center, whose own counts.action (NotificationCenter.tsx:78) does classify these items correctly; only the tone and the pre-filter are wrong.

**Mechanism.** Two call sites feed the section tallies. The ticket loop calls `tally('requests', actionReq)` with the real flag. The notification loop computes the real flag one line earlier — `actionRequired: actionKinds.has(n.kind)` — then throws it away: `tally(section, false)`. Only tickets ever tally into `requests`, and only notifications ever tally into `documents`/`projects`. Therefore `sectionCounts.documents.actionRequired` and `sectionCounts.projects.actionRequired` are always exactly 0, and `badgeOf` — whose only branch is `s.actionRequired > 0 ? 'red' : 'blue'` — always returns 'blue' for those two rows.

**Failure scenario.** Someone force-releases your checkout on a P&ID you have open (kind `checkout_released`, which IS in `actionKinds` and IS mapped to the documents section). The Documents row badges blue — the tone the Sidebar's own design contract at line 22 defines as 'unread FYI'. A stale-base branch (`branch_open`), an edit overlap (`overlap_advisory`) and a checkout conflict all behave identically. The red/pulse treatment on the rail is reachable only via the Drafting Requests row.

**Evidence.**

hooks/useTicketNotifications.ts:285-301:
```
out.push({
  key: `notif:${n.id}`,
  source: 'notification',
  actionRequired: actionKinds.has(n.kind),
  …
});
tally(section, false);
```
vs the ticket loop at :272 `tally('requests', actionReq);`

Sidebar.tsx:128-131:
```
const badgeOf = useCallback((s: { total: number; actionRequired: number }): { badge?: number; badgeTone?: 'red' | 'blue' } => {
  if (s.total <= 0) return {};
  return { badge: s.total, badgeTone: s.actionRequired > 0 ? 'red' : 'blue' };
}, []);
```
Sidebar.tsx:22 (the contract this violates): `//     Badges: red = action required, blue = unread FYI, absent = clear.`

**Chain reaction.** Also drives the badge's animation: Sidebar.tsx:510 gives `animate-pulse` only to the red tone, so document conflicts never pulse either — which is the exact treatment the owner asks for in complaint 3.

> **Verifier correction.** None — the finding is accurate as written.

**Done when.**

- [ ] tally(section, actionKinds.has(n.kind)) — the computed flag reaches the tally
- [ ] a checkout_conflict / checkout_released / overlap_advisory / branch_open notification turns the Documents badge red
- [ ] a test asserts sectionCounts.documents.actionRequired > 0 for a checkout_conflict row

---

<a id="trail-6"></a>

## TRAIL-6 · A notification row cannot be rolled up to a container: it carries no library_id or collection_id, and resource_id is TEXT while documents.id is uuid

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20260621_in_app_notifications.sql:13-27`, `lib/inAppNotifications.ts:140-155`, `lib/holds.ts:232-251`, `hooks/useTicketNotifications.ts:176`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Factually correct — the row genuinely cannot be rolled up to a library or folder without a second query, and holds.ts:232-241 only fetches library_id to build the link string, never persisting it. Downgraded to LOW: this describes a feature that was never built (container badges) rather than a defect in shipped behavior, and notifications_org_resource_idx (org_id, resource_type, resource_id) makes the extra lookup cheap and indexed.

**Mechanism.** The notifications table stores `resource_type TEXT` + `resource_id TEXT` and a free-form `metadata JSONB`. There is no library_id, collection_id, or project_id column, and no FK. So to answer 'how many unread items are in library X' the client must fetch its unread rows, extract the document ids, and issue a second query `select id, library_id, collection_id from documents where id in (…)` — a join the client currently never performs. Two further frictions: `resource_id` is TEXT so a SQL-side join to `documents.id` (uuid) needs a cast; and `resource_type` is not constrained, so `'document'` vs `'checkout'` vs `'library'` is a convention, not a guarantee. Notably the producer side already HAS the library id at emit time and only uses it to build a link string.

**Failure scenario.** Any attempt to badge a library card or folder row today requires a second round-trip per page load, and the roll-up for FOLDERS is worse: `documents.collection_id` gives the leaf folder but the folder tree needs ancestors, so a folder badge also needs `collections.pathIds` (already present — FolderTree.tsx:92 reads `target.pathIds`) to fan a document's count up its ancestor chain.

**Evidence.**

20260621_in_app_notifications.sql:19-22:
```
  link TEXT,                                   -- e.g. /requests/<id>?focus=comment-<id>
  resource_type TEXT,                          -- ticket | document | project | …
  resource_id TEXT,
  actor_user_id UUID,                          -- who triggered it (null for system)
```
lib/inAppNotifications.ts:147-149 (the client row shape — same gap):
```
  resourceType: string | null;
  resourceId: string | null;
```
lib/holds.ts:234-241 — the producer already reads library_id and throws it away except as a URL fragment:
```
supabase.from("documents").select("document_number, title, name, library_id")
  .eq("id", input.documentId).maybeSingle(),
…
link: doc?.library_id ? `/documents/${doc.library_id}?doc=${input.documentId}` : "/admin/holds",
```

**Chain reaction.** Two viable shapes: (a) denormalize — add `library_id uuid` / `collection_id uuid` columns (or `metadata.libraryId`) at notify time, which every producer can already supply, giving a one-query roll-up; or (b) keep the join and do it once in the hook, which also fixes the /search?q=<uuid> dead link because you would then know the library. Option (a) is cheaper at read time and matches the existing notifications_org_resource_idx.

> **Verifier correction.** Severity overstated at HIGH, for a reason the finding surfaces but does not follow through on. Because most document producers embed the container in the `link` column (`/documents/<libraryId>?doc=<docId>` — holds.ts:248, branches.ts:144, distributionAcks.ts:141, staleCopies.ts:201, postPublish.ts:42 and :57), a per-library rollup is derivable client-side today by parsing `link`, with no schema change and no join. The uuid-vs-TEXT cast friction is real but only bites a SQL-side join nobody is currently writing. This is schema hygiene that makes the right fix uglier, not a defect with an observable failure.

**Done when.**

- [ ] a notification about a document carries its library id (column or metadata) at insert time for every producer that emits resourceType 'document'
- [ ] the attention hook exposes a per-library and per-folder rollup map alongside sectionCounts
- [ ] the folder rollup fans a document's count up collections.pathIds so an ancestor folder shows its subtree's total

---

<a id="trail-7"></a>

## TRAIL-7 · Both feeds are silently truncated — 50 unread notifications and 500 open tickets — so the count is wrong and the OLDEST items are the ones that vanish

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:176`, `lib/inAppNotifications.ts:157-174`, `hooks/useTicketNotifications.ts:31`, `hooks/useTicketNotifications.ts:156`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on both halves: newest-first ordering plus a hard limit means the OLDEST unread rows are the ones dropped, and count/sectionCounts/NotificationCenter counts are all computed from the truncated arrays (countUnread() in inAppNotifications.ts:176 does an exact head-count but no surface in the attention path calls it). No 'showing N of M' affordance exists in NotificationBell.tsx or NotificationCenter.tsx.

**Mechanism.** `listMyNotifications({ onlyUnread: true, limit: 50, orgId })` orders by created_at DESC and caps at 50, so a user with 80 unread rows has their sidebar counts computed from the newest 50 — and the 30 oldest are the ones dropped. Independently, the ticket fetch caps at OPEN_TICKET_CAP = 500 ordered by last_modified DESC, so in a busy org the least-recently-touched (i.e. most overdue) action-required tickets fall out of the Drafting Requests count. Neither truncation is surfaced anywhere in the UI.

**Failure scenario.** A DocCtrl in a large facility has 120 unread notifications. Sidebar totals are computed from 50 of them. An ack_overdue from three weeks ago — the one an auditor will ask about — is arithmetically excluded from every badge, every count, and the notification center, with no 'showing 50 of 120' indicator anywhere.

**Evidence.**

hooks/useTicketNotifications.ts:176: `let n = await listMyNotifications({ onlyUnread: true, limit: 50, orgId: activeOrgId })`
lib/inAppNotifications.ts:160-164:
```
let q = supabase
  .from("notifications")
  .select("*")
  .order("created_at", { ascending: false })
  .limit(opts?.limit ?? 50);
```
hooks/useTicketNotifications.ts:28-31:
```
// Cap open-ticket fetches so the attention feed can't pull an unbounded set
// (and re-pull it on every realtime change). Newest-first, so the most
// recently active tickets — the ones likely to need attention — are kept.
const OPEN_TICKET_CAP = 500;
```
Note `countUnread()` at lib/inAppNotifications.ts:176-185 returns an exact head-count and is not called by the hook.

**Chain reaction.** The comment justifying the ticket cap ('the most recently active tickets — the ones likely to need attention') inverts the actual attention semantics: an untouched PENDING_ASSIGNMENT ticket is stale precisely because nobody acted on it.

> **Verifier correction.** None — the finding is accurate as written.

**Done when.**

- [ ] badge counts come from an exact server-side count (countUnread / a head count) rather than the length of a truncated page
- [ ] the UI shows a 'showing N of M' affordance when a feed is truncated
- [ ] or the caps are raised and paginated so no attention item is silently excluded

---

<a id="trail-8"></a>

## TRAIL-8 · Five independent copies of the attention hook, each with its own realtime channel, each refetching everything on every change

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:143-230`, `components/navigation/Sidebar.tsx:124`, `components/notifications/NotificationBell.tsx:54`, `components/notifications/NotificationCenter.tsx:55`, `components/dashboard/widgets.tsx:669`, `app/(protected)/inbox/page.tsx:38`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and worse than 'five': app/(protected)/layout.tsx mounts Sidebar (line 56) and NotificationCenterProvider (line 145) — whose CenterPanel calls the hook unconditionally even while closed — plus the TopBar bell, so three instances are live on EVERY protected route and five on the dashboard. The write-back at line 207 (markManyRead) does land on the `notifications` table the subscription at line 225 watches, so the self-retrigger described is real.

**Mechanism.** `useTicketNotifications` holds all state locally and subscribes its own channel keyed by `useId()` specifically so instances don't collide. On the dashboard, four instances are mounted at once (Sidebar, Bell, Center provider, widgets). Each runs the full fetchAll: up to 500 tickets + 50 notifications + the reconciliation query. Each subscribes to `postgres_changes` on `tickets` filtered `org_id=eq.<org>` — meaning ANY ticket write anywhere in the org fires four independent full refetches, each of which may issue a `markManyRead` write, which itself fires the notifications subscription, which triggers another four refetches.

**Failure scenario.** On a busy morning, one colleague's ticket comment causes each open tab to re-pull up to 500 ticket rows four times over. If the reconciler finds a stale row it writes read_at, which the notifications subscription observes, causing a second round. Counts flicker while the four instances resolve at different times.

**Evidence.**

hooks/useTicketNotifications.ts:139-141:
```
// Unique per hook instance so multiple consumers (sidebar/bell/inbox) don't
// collide on the same realtime channel name.
const channelId = useId().replace(/[^a-z0-9]/gi, '');
```
hooks/useTicketNotifications.ts:221-227:
```
const channel = supabase
  .channel(`attention-${activeOrgId}-${channelId}`)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets', filter: `org_id=eq.${activeOrgId}` },
    () => { if (alive) void fetchAll(); })
  .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` },
    () => { if (alive) void fetchAll(); })
  .subscribe();
```
The comment treats multiple instances as the intended design rather than the problem.

**Chain reaction.** Any drill-down work (per-library rollups, per-folder rollups) adds more consumers, multiplying this. Hoisting the feed into a single provider is a prerequisite for adding in-page markers without making the fan-out worse.

> **Verifier correction.** Two corrections, one raising and one lowering. (a) The dashboard count is understated: widgets.tsx registers CommandDeckBody (:1342) and AttentionBody (:1377) as separate widgets, each calling the hook (:1223 and :669), so a default dashboard can mount FIVE instances, not four. (b) The write-amplification tail is overstated: markManyRead only fires when staleIds is non-empty, and once those rows are marked read they drop out of the `onlyUnread: true` query, so the notifications-subscription echo is one extra round of refetches, not a self-sustaining loop.

**Done when.**

- [ ] one provider owns the feed and one realtime subscription; useTicketNotifications reads from context
- [ ] adding a new consumer does not add a query or a channel
- [ ] a single ticket write causes one refetch, not one per mounted consumer

---

<a id="trail-9"></a>

## TRAIL-9 · Stale-alert reconciliation covers ONLY ticket workflow rows — hold_opened and hold_released both persist unread, so the Documents badge counts a condition that no longer exists

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:186-210`, `lib/holds.ts:238-241`, `hooks/useTicketNotifications.ts:86-95`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Accurate: hold rows can never be reconciled, and the hook's own header comment (lines 24-25, 'stale workflow alerts ... are reconciled away — so the badge can never disagree with the portal') overstates what the code does. Downgraded to LOW because an unread-until-read inbox row is normal semantics, the count is real unread mail rather than fabricated, and hold_released is itself the resolution notice — the badge is noisy, not false.

**Mechanism.** The reconciler selects only rows that have `resourceId && metadata && typeof metadata.status === 'string' && metadata.action != null`, then compares against the `tickets` table. Document notifications carry no `metadata.status`, so none of them are ever reconciled. lib/holds.ts emits `hold_opened` on open and `hold_released` on release — both map to the 'documents' section (hooks/useTicketNotifications.ts:93-94). A hold that is placed and then released leaves TWO unread rows behind, and the release row is pure FYI with nothing to act on.

**Failure scenario.** A hold is placed on a drawing Monday and released Tuesday. On Wednesday the Documents badge reads 2 for that one document. Clicking it opens the org-wide center where both rows say something about a hold that no longer exists. The badge is not merely cold — it is false: it is pointing at a resolved condition. Same shape for branch_open followed by branch_resolved (both mapped to 'documents'), and checkout_conflict after the conflicting checkout is released.

**Evidence.**

hooks/useTicketNotifications.ts:188-197:
```
const workflowRows = n.filter(
  (r) => r.resourceId
    && r.metadata
    && typeof r.metadata.status === 'string'
    && r.metadata.action != null,
);
if (workflowRows.length > 0) {
  const refIds = Array.from(new Set(workflowRows.map((r) => r.resourceId as string)));
  const { data: liveRows } = await supabase
    .from('tickets').select('id, status').eq('org_id', activeOrgId).in('id', refIds);
```
lib/holds.ts:241: `kind: input.opened ? "hold_opened" : "hold_released",`
hooks/useTicketNotifications.ts:93-95:
```
    case 'hold_opened':
    case 'hold_released':
      return 'documents';
```

**Chain reaction.** The hook's own header comment (lines 23-25) claims 'stale workflow alerts (whose ticket has already moved on) are reconciled away — so the badge can never disagree with the portal.' That guarantee holds only for tickets; the Documents badge has no such guarantee and the comment reads as if it does.

> **Verifier correction.** Severity overstated at HIGH. The residue is an inflated count, not a misleading safety signal: the recipient receives BOTH rows ('HOLD placed on X' and 'Hold released on X'), so nothing tells them a released hold is still active — and either row is clearable from the bell, the Center, or Mark all read. The real cost is badge noise plus extra triage.

**Done when.**

- [ ] a hold_released row supersedes and clears the matching hold_opened row for the same document + user
- [ ] branch_resolved clears the matching branch_open row
- [ ] the reconciler either covers document kinds or the header comment is narrowed to say it only covers tickets

---

<a id="trail-10"></a>

## TRAIL-10 · The Documents badge counts across six different routes but always lands you on one of them

- **Severity:** MEDIUM
- **Status:** REFUTED
- **Verification:** CONFIRMED
- **Locations:** `components/navigation/ViewTabs.tsx:80-87`, `components/navigation/Sidebar.tsx:62-68`, `components/navigation/Sidebar.tsx:229`, `hooks/useTicketNotifications.ts:86-95`
- **Independently verified:** ⛔ **REFUTED** by a second independent adversarial pass — do not work this finding. Kept in place with the reason rather than deleted (`DEC-41`). False as stated — the badge does not land you on /documents at all; preventDefault/stopPropagation cancel the Link and open the Notification Center, which lists the individual item with its own deep link (e.g. /documents/<libraryId>?doc=<id> from holds.ts:249 or a checkout link). Only the row itself navigates to /documents, which is the intended behavior of a nav rail, and the six views are then visible as ViewTabs (DOCUMENT_VIEWS, ViewTabs.tsx:80-87).

**Mechanism.** TOOL_ALIASES derives the Documents tool's route family from DOCUMENT_VIEWS: /documents, /register, /checkouts, /packages, /admin/holds, /transmittals. The section's counted kinds span that family — checkout_conflict/handoff/message/released belong on /checkouts, hold_opened/hold_released on /admin/holds, doc_superseded often on /packages (lib/postPublish.ts:180 links to `/packages?pkg=…`). But `href: '/documents'` sends every click to the library grid, which is the one view that cannot show any of those states.

**Failure scenario.** Your checkout was force-released. The Documents row badges. You click the row and arrive at a grid of library cards — the wrong one of the six views, with no tab highlighted for the view that actually holds your item, and no hint that /checkouts is where to look.

**Evidence.**

ViewTabs.tsx:80-87:
```
export const DOCUMENT_VIEWS: ViewTab[] = [
  { label: "Table", href: "/documents", icon: Table },
  { label: "Register", href: "/register", icon: ClipboardList },
  { label: "Checkouts", href: "/checkouts", icon: Lock },
  { label: "Packages", href: "/packages", icon: Package },
  { label: "Holds", href: "/admin/holds", icon: AlertOctagon },
  { label: "Transmittals", href: "/transmittals", icon: Send },
];
```
Sidebar.tsx:229: `{ label: 'Documents', hint: 'Libraries · board · locks · packages · blocked', href: '/documents', icon: FileStack, tone: 'blue', ...badgeOf(sectionCounts.documents) }`

**Chain reaction.** The ViewTabs strip is already rendered on each of those pages, so a per-view count on the tabs themselves would carry the trail one more link at very low cost — it is the natural second node after the sidebar.

> **Verifier correction.** The claim 'always lands you on one of them' is true of the ROW only. The badge is a separate affordance — SidebarLeaf stops propagation at :539 and opens the Center instead of navigating — and every item in that Center carries its own deep link, including /checkouts, /admin/holds and /packages?pkg=… targets. So the tool-home landing is the row's behaviour, not the badge's, which makes this a design observation about nav altitude rather than a broken path.

**Done when.**

- [ ] ViewTabs renders a per-view count for the views that have attention items
- [ ] or the Documents row navigates to the view holding the majority of its counted items

---

<a id="trail-11"></a>

## TRAIL-11 · The one place the chain DOES continue — the requests queue — proves the pattern and shows it was never applied to documents or projects

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/requests/page.tsx:1027-1039`, `app/(protected)/requests/page.tsx:1128-1144`, `app/(protected)/projects/page.tsx:199-261`, `app/(protected)/documents/page.tsx:389-467`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Verified: the per-row attention dot exists only in the requests portal. Downgraded to LOW — this is the same missing-capability observation as TRAIL-5/TRAIL-6 restated as a UX-consistency complaint, and it describes an unbuilt feature rather than incorrect behavior.

**Mechanism.** The drafting-requests queue recomputes attention per row from the raw ticket (`isActionRequired(ticket)` + `ticket.unreadBy?.includes(uid)`) and renders a red pulsing dot for action and a blue dot for unread — the same visual language as the sidebar badge, and it survives because it never depends on notification rows. That is the complete working example of what the owner is asking for. It exists in exactly one section. The library grid, folder tree, document table and project cards all render nothing equivalent, and the projects list doesn't even import the attention primitives.

**Failure scenario.** A user learns from the Drafting Requests section that a badge means 'go look for the red dot'. They apply the same mental model in Documents and Projects and find no dots at any level, so they conclude the badge is broken rather than that the feature is missing.

**Evidence.**

requests/page.tsx:1027-1039:
```
const isUnread = ticket.unreadBy?.includes(uid || '');
const isActionNeeded = isActionRequired(ticket); // Use Helper
…
{/* DUAL BADGE LOGIC: Show Action OR Unread OR Both if room permits */}
{isActionNeeded && <div className="w-2.5 h-2.5 bg-red-500 rounded-full mr-2 animate-pulse" title="Action Required" />}
{!isActionNeeded && isUnread && <div className="w-2.5 h-2.5 bg-blue-500 rounded-full mr-2" title="New Updates" />}
```
Case-insensitive grep for `badge|notif|attention|unread` in app/(protected)/documents/page.tsx returns zero hits; in app/(protected)/projects/page.tsx the only hit is line 55, a comment about status-tab counts.

**Chain reaction.** Note the requests queue derives its dots from ticket STATE, not from notification rows — so it is immune to the read/reconcile problems above. A document-side equivalent could be derived the same way from lib/docControlRegister.ts's per-document action state rather than from notifications.

> **Verifier correction.** Minor: the grid-mode citation is 1126-1147, not 1128-1144. This finding is descriptive rather than a defect — it documents the working reference implementation — so MEDIUM/CONFIRMED reads more like a design note than a bug report, but every factual claim in it holds.

**Done when.**

- [ ] library cards, folder rows and document rows render the same red-action / blue-unread dot vocabulary
- [ ] project cards render it too
- [ ] the dot's source of truth is documented as either notification-derived or state-derived, consistently across sections

---

<a id="trail-12"></a>

## TRAIL-12 · When a document notification has no link, the fallback deep-links into a search that can never match — searchDocuments never queries by id

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:293-297`, `lib/search.ts:171-235`, `lib/branches.ts:144`, `lib/distributionAcks.ts:141`, `lib/staleCopies.ts:201`, `components/documents/EditOverlapBanner.tsx:92`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The mechanism is real — a document notification with no link deep-links to a uuid query that structurally cannot match. But the headline example is wrong: lib/revisions.ts:124 types `libraryId: string` (required) and line 699 passes it straight to announceBranchOpened, so branch_open ALWAYS has a link. The fallback is only reachable via the nullable-libraryId emitters (staleCopies.ts:186/201, distributionAcks.ts:104/141, EditOverlapBanner.tsx:22/92), hence LOW.

**Mechanism.** Several producers build their link as `input.libraryId ? \`/documents/${libraryId}?doc=${docId}\` : undefined`. When libraryId is absent the row lands with `link = null`, and the hook's fallback for resourceType 'document' is `/search?q=<encodeURIComponent(resourceId)>` — i.e. it puts a raw uuid into the search box. `searchDocuments` filters by org, runs a tsvector match on search_tsv, falls back to ILIKE on document_number/title/name, then augments with equipment-tag lookups. None of those paths ever compares against `documents.id`, so the uuid matches nothing.

**Failure scenario.** A branch is opened on a document whose libraryId wasn't in scope at emit time. The Documents badge increments. The user opens the bell, clicks the row, and lands on /search showing 'no results' for a 36-character uuid — the only pointer to the resource has been converted into a guaranteed miss.

**Evidence.**

hooks/useTicketNotifications.ts:293-297:
```
link: n.link || (n.resourceId
  ? (n.resourceType === 'document' ? `/search?q=${encodeURIComponent(n.resourceId)}`
     : n.resourceType === 'library' ? `/documents/${n.resourceId}`
     : `/requests/${n.resourceId}`)
  : '/inbox'),
```
lib/search.ts:212-214 (the widest fallback in searchDocuments — id is not among the columns):
```
q2 = q2
  .or(`document_number.ilike.${like},title.ilike.${like},name.ilike.${like}`)
  .order("updated_at", { ascending: false, nullsFirst: false });
```
lib/branches.ts:144: ``link: input.libraryId ? `/documents/${input.libraryId}?doc=${input.documentId}` : undefined,``

**Chain reaction.** Fixing finding #5 (carry library_id on the row) removes this fallback entirely: with a library id on the row the hook can always build `/documents/<lib>?doc=<id>`, which the library page's deep-link effect (documents/[libraryId]/page.tsx:1284-1319) already resolves correctly including jumping to the document's folder.

> **Verifier correction.** The finding cites lib/search.ts but /search does not call searchDocuments directly: app/(protected)/search/page.tsx:65 calls globalSearch, which fans out to searchDocuments/searchTickets/searchAssets/searchProjects/searchNotes/searchTransmittals (lib/globalSearch.ts:35-42). I checked the other five — none matches on a document uuid either — so the conclusion is unchanged and slightly stronger. Note also the fallback only fires for rows whose producer omitted libraryId; when it is present the link is a correct /documents/<lib>?doc=<id>.

**Done when.**

- [ ] the document fallback resolves the library id (from the row or a lookup) and builds /documents/<lib>?doc=<id>
- [ ] or searchDocuments accepts a uuid and short-circuits to a direct id lookup
- [ ] no notification link can resolve to a search for a raw uuid

---

<a id="trail-13"></a>

## TRAIL-13 · actionRequiredCount and the notification center's 'Action' tab disagree about what counts as action-required

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `hooks/useTicketNotifications.ts:256`, `hooks/useTicketNotifications.ts:288`, `components/notifications/NotificationCenter.tsx:78`, `components/dashboard/widgets.tsx:1223`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed — one hook call yields two different action counts, and a checkout_conflict/checkout_released/overlap_advisory/branch_open row is counted by the center's 'Action' tab but not by actionRequiredCount, which the Command Deck stat that opens that tab renders.

**Mechanism.** The hook's exported `actionRequiredCount` (`ar`) is incremented only inside the ticket loop. The notification loop sets `actionRequired: actionKinds.has(n.kind)` on the item but never touches `ar`. Consumers that read `actionRequiredCount` (dashboard widgets) therefore exclude conflict-class notifications, while consumers that recompute from `items` (NotificationCenter.tsx:78, inbox/page.tsx:76, widgets.tsx:676) include them.

**Failure scenario.** The dashboard's action stat reads 2 while the center's 'Action' tab, opened from that very stat, lists 4 rows — the two tickets plus a checkout_conflict and a branch_open. Two surfaces documented as sharing one source of truth print different numbers from the same hook call.

**Evidence.**

hooks/useTicketNotifications.ts:252-256 (ticket loop, the only writer of ar):
```
for (const t of tickets) {
  const actionReq = isActionRequired(t, { uid, roles });
  const unread = !!uid && !!t.unreadBy?.includes(uid);
  if (!actionReq && !unread) continue;
  if (actionReq) ar++; else ur++;
```
NotificationCenter.tsx:78: `action: items.filter((i) => i.actionRequired).length,`
widgets.tsx:1223: `const { count: attentionCount, actionRequiredCount } = useTicketNotifications();`

**Chain reaction.** Same root cause as the tally bug (#3): the notification loop computes actionRequired for the item but propagates it to neither the section tally nor the global counter.

> **Verifier correction.** Corroboration rather than correction: inbox/page.tsx:71-72 carries the comment 'Accurate per-filter counts (from the unified feed itself — the hook's ticket-only counters don't include notification rows)', so the divergence is already known at one call site and simply not fixed at the source.

**Done when.**

- [ ] actionRequiredCount is derived from items.filter(i => i.actionRequired) so every consumer agrees
- [ ] or the notification loop increments ar/ur alongside the item push

---
