# 05 · Discoverability — can someone use this without studying it?

The test applied throughout: **a maintenance planner who has never opened the app
before needs a drawing changed.** Every place they have to already know something
to proceed is a finding.

**7 findings** — 0 CRITICAL, 4 HIGH, 3 MEDIUM.

> See [`../README.md`](../README.md) for the resolution protocol. Code in
> `Remediation` blocks is **illustrative, untested, and not a patch.**

---

## UI-1 · A ticket never says who it is waiting on

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux / adoption
- **Locations:**
  - `app/(protected)/requests/[id]/page.tsx` — a search for `waiting`, `awaiting`, `next step` or `action required` across the whole 2,077-line page returns **zero hits**
  - `lib/ticketAttention.ts:115-128` — `attentionLabel`: *"Needs a drafter assigned"*, *"Needs engineer sign-off"*, *"Issue the IFC package"* — plain English, already written
  - `hooks/useTicketNotifications.ts:265` — its **only** consumer, as the subtitle in the bell feed
  - `app/(protected)/requests/[id]/page.tsx:1488` — what the ticket page shows instead: `{ticket.status.replace(/_/g, ' ')}`
- **Related:** `UI-2`, `FRIC-1`
- **Re-verified:** hardening pass — **SURVIVES**. `attentionLabel` maps status → what the *ticket* needs (`ticketAttention.ts:115-126`) and is rendered as the feed subtitle (`useTicketNotifications.ts:265`). No branch names a person.

**Mechanism.** The plain-English answer to "what is happening to my request?"
exists, is well written, covers every status — and is rendered **only in the
notification bell.** The ticket page itself shows the raw status enum with
underscores swapped for spaces: `PENDING FINAL APPROVAL`.

Nowhere does the page name the person or role the ticket is waiting on.

**Failure scenario.** The planner opens their request. It says `PENDING FINAL
APPROVAL`. They do not know what that means, who has it, whether they need to do
anything, or how long it has been there. **The only way to find out is to ask
someone** — which is the exact behaviour the app exists to replace.

**Chain reaction.** This compounds with `FRIC-1`: not only is nobody told when a
ticket stalls, the person most motivated to chase it cannot tell from the ticket
that it *is* stalled, or who to chase. Rendering `attentionLabel` plus the
current holder is a small change against an existing, tested function.

**Done when.**
1. A ticket states, in plain language, what stage it is at and who it is waiting
   on.
2. It states how long it has been in that state.
3. The requester can tell at a glance whether the ball is in their court.

---

## UI-2 · The workflow map is hidden behind a status pill that does not look clickable

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux
- **Locations:**
  - `components/requests/WorkflowDiagramModal.tsx:27` — a genuinely good artifact: every status with a plain-English blurb (*"Sent to an engineer for sign-off before it can be issued for construction."*)
  - `app/(protected)/requests/[id]/page.tsx:1482-1488` — the **only** trigger: the status pill itself, styled as a rounded badge, with discoverability provided entirely by `title="See where this request is in the workflow"`
  - it is imported by **one file** — the ticket detail page. It is absent from `/requests` and from `/requests/new`.
- **Related:** `UI-1`, `UI-5`
- **Re-verified:** hardening pass — **SURVIVES**. The workflow map opens from a `<button>` styled `rounded-full text-xs font-bold border uppercase tracking-wider` rendering `ticket.status.replace(/_/g,' ')` (`requests/[id]/page.tsx:1482-1488`) — visually a status badge, with only a `title` attribute to suggest otherwise.

**Mechanism.** Somebody built the map that answers "what happens to my request?"
and then attached it to a badge. Status badges are not interactive anywhere else
in the app, so nothing suggests this one is — and the hint is a `title`
attribute, which does not appear on touch devices at all.

**Failure scenario.** A first-time requester submits a request and lands on the
ticket. The explanation of the entire process is one hover away and they will
never find it. They learn the workflow the way they learn everything else: by
asking a colleague.

**The fix is almost entirely free** — the content already exists and is already
good. It needs a visible affordance, and it needs to exist on the request form
(*before* someone commits to a process they cannot see) and on the queue.

**Done when.**
1. The workflow map has a visible, obviously-clickable affordance.
2. It is reachable from the new-request form and the queue, not only from an
   existing ticket.
3. It does not depend on hover.

---

## UI-3 · The attention badge sends Document Control to tickets that offer them nothing

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux / adoption
- **Re-verified:** hardening pass — **SURVIVES**. Same evidence as `FRIC-7` — `ticketAttention.ts:106-108` against `workflow.ts:301-312`. Duplicate within this area; fix once.

> **Recorded in full as `FRIC-7`.** Repeated here because it is the clearest
> single answer to "is there a weird UI where people don't know where to look":
> the app actively points document controllers at work that does not exist.

`lib/ticketAttention.ts:106-108` marks every ticket at `FINAL_DRAFT` and
`PENDING_IFC` as requiring a DocCtrl's action. `WorkflowEngine.getActions` offers
a DocCtrl nothing at either state, because `ticket.direct_approve` defaults to
`["Engineer"]` and `ticket.manage` to `["Admin","Manager","Supervisor"]`. The
result on screen is `app/(protected)/requests/[id]/page.tsx:1605`:
**"View Only - No Actions Available."**

The badge never clears, because it is computed from role + status rather than
from `getActions`. **A user who learns to ignore their badge has lost the one
channel real work arrives through.**

**Done when.** See `FRIC-7`.

---

## UI-4 · "View Only — No Actions Available" explains nothing

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux
- **Locations:**
  - `app/(protected)/requests/[id]/page.tsx:1604-1605` — the empty-actions branch
- **Related:** `UI-1`, `UI-3`, `FRIC-7`
- **Re-verified:** hardening pass — **SURVIVES**. `availableActions.length === 0 ? (…)` (`requests/[id]/page.tsx:1604-1605`) renders one static panel for every reason a person might have no actions — wrong role, wrong state, not their ticket — and distinguishes none of them.

**Mechanism.** When `getActions` returns nothing, the page renders a grey italic
chip. It does not say **why** there is nothing — whether the user lacks
authority, whether it is simply not their turn, or whether the ticket is waiting
on someone else — and it does not say **who** to contact.

Those three cases are completely different from the user's point of view and are
rendered identically.

**Failure scenario.** A drafter whose headline role resolved to `DocCtrl` or
`Engineer-2` (`WF-7`) opens **their own assigned ticket** and sees "View Only". It
is their work. The message tells them nothing about why they cannot proceed.

**The information needed is already in scope** at the render site: the ticket's
status, the current holder, and the user's own role. The empty state should say
*"Waiting on <person> to <action>"* or *"You don't have <capability> on this
library — <controller> can grant it."*

**Done when.** The empty state distinguishes "not your turn" from "not
permitted", and names who to talk to in each case.

---

## UI-5 · Submitting an incomplete request does nothing at all

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux / adoption
- **Locations:**
  - `app/(protected)/requests/new/page.tsx:201` — `if (!title || !description || !unit) return;` — a bare return: **no message, no field highlight, no scroll-to-error, no focus move**
  - contrast `app/(protected)/requests/new/page.tsx:272-280` — custom required fields **do** get a blocking `appAlert` naming the field
- **Related:** `FRIC-3`, `DCW-7`
- **Re-verified:** hardening pass — **SURVIVES**, and the contrast inside the same function is the evidence. `if (!title || !description || !unit) return;` (`requests/new/page.tsx:201`) is a bare return with no feedback, while the custom-field validation seventy lines later does `await appAlert(...)` on the same class of failure (`:279-280`).

**Mechanism.** The three core required fields fail silently; the org-configured
custom fields fail loudly. The **more** important validation is the quieter one.

`unit` is the field most likely to be missed — it sits between Title and the
description, and when the org has not configured a unit list it is a free-text
box with no obvious constraint.

**Failure scenario.** The planner fills in Title and Detailed Scope, attaches
their markup, presses **Submit Request**, and the page does nothing. No error, no
spinner, no movement. They press it again. Still nothing. **At this point a
reasonable person concludes the app is broken and phones drafting** — with their
markup still unsaved (`LEAK-5`).

**This is a strong candidate for the single highest-friction moment in the
product**, because it happens at first contact, to the least experienced user,
with no recovery path and no explanation.

**Done when.**
1. A blocked submit names the missing field and moves focus to it.
2. Required fields are marked before submit, not only after.
3. The button reflects whether the form is submittable.

---

## UI-6 · The queue opens on the whole org, not on what needs you

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux
- **Re-verified:** hardening pass — **SURVIVES**. `myActionItems` is computed at `app/(protected)/requests/page.tsx:329` but the initial `filters` state opens on `status: 'ALL'` across the org (same file, `:180-187`). Duplicate of `FRIC-9` within this area; fix once.

> **Recorded in full as `FRIC-9`.**

`app/(protected)/requests/page.tsx:329` computes `myActionItems` via
`isActionRequired` and renders it as a header statistic. The list beneath still
opens on the full org queue, default sort, 25 per page. The selector exists, its
result is already on screen, and the list does not use it.

**Done when.** See `FRIC-9`.

---

## UI-7 · Raw status enums are the primary vocabulary

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Blast radius:** ux
- **Locations:**
  - `app/(protected)/requests/[id]/page.tsx:1488` — `{ticket.status.replace(/_/g, ' ')}`
  - `lib/ticketAttention.ts:115-128` — plain-English equivalents exist for every status
  - `components/requests/WorkflowDiagramModal.tsx:27` — a second set of plain-English blurbs, also written, also unused outside the modal
- **Related:** `UI-1`, `UI-2`
- **Re-verified:** hardening pass — **SURVIVES**. `ticket.status.replace(/_/g, ' ')` is the primary on-screen vocabulary (`requests/[id]/page.tsx:1488`), while the human phrasing in `attentionLabel` (`ticketAttention.ts:115-124`) is used only as a feed subtitle.

**Mechanism.** `PENDING_ENG_TEAM`, `REVISION_REQ`, `PENDING_IFC` and
`FINAL_DRAFT` are database identifiers. They are shown to end users as the
primary label, on the ticket, in the queue and in filters.

Two separate sets of human-readable equivalents have already been written. Both
live in components that most users never reach.

**Failure scenario.** `FINAL_DRAFT` is the state where the work is **finished**
and awaiting acknowledgment. To a requester, "Final Draft" reads like *not
finished* — the opposite of the truth. `PENDING_IFC` requires knowing that IFC
means Issued For Construction and that the pending party is the drafter, not
them.

**Chain reaction.** Renaming the enum values would ripple through the state
machine, the database and the archive. **Do not do that.** The display layer is
where this belongs — the labels already exist and need routing to the surfaces
users actually see.

**Done when.** A user-facing surface never shows a raw status identifier as the
primary label.

---

## The first-run walkthrough

What a new maintenance planner actually encounters, in order:

| Step | What they hit |
|---|---|
| 1. Find the entry | ✅ Sidebar → **Drafting Requests**, hint *"Drafting & design request portal"*. Clear. |
| 2. Start a request | ✅ Reachable from the queue and from a document viewer with the source pre-linked. |
| 3. Fill the form | ⚠️ Must know a **unit code**, free text when unconfigured (`FRIC-3`) |
| 4. Submit | ❌ **Silently does nothing** if unit is blank (`UI-5`) |
| 5. Understand what happens next | ❌ The map exists, behind a status pill (`UI-2`) |
| 6. Track it | ❌ Raw enum, no holder, no elapsed time (`UI-1`, `UI-7`) |
| 7. Get told it moved | ⚠️ Only if they are requester or drafter (`LEAK-1`) |
| 8. Review the draft | ❌ Asked to judge a CAD deliverable (`FRIC-2`) |
| 9. Pick an engineer | ❌ By email prefix, no routing guidance (`FRIC-4`) |
| 10. Acknowledge and close | ⚠️ No prompt; ticket stays open indefinitely (`FRIC-6`) |

**Steps 1 and 2 are good.** Everything after first contact assumes knowledge the
user does not have, and step 4 fails without saying so.

---

## Verified sound — do not break

1. **`components/requests/WorkflowDiagramModal.tsx`** — an honest, complete,
   plain-English map of the process, per status. **The content is right; only its
   placement is wrong** (`UI-2`). Do not remove it while fixing discoverability.
2. **`attentionLabel`** (`lib/ticketAttention.ts:115-128`) — the correct plain
   phrasing for every state, already written and already used in the bell. `UI-1`
   is about routing it to more surfaces, not rewriting it.
3. **The sidebar entry** — *"Drafting Requests"*, hinted *"Drafting & design
   request portal"*, badged with a live count, and included in the reduced
   navigation set for Viewer/Contractor
   (`components/navigation/Sidebar.tsx:234-249`). A low-permission user can find
   the front door.
4. **The revision-requested banner** (`app/(protected)/requests/[id]/page.tsx:1661`)
   — *"Revision requested — here's what to fix"*, rendered prominently above the
   fold. **This is exactly the pattern `UI-1` wants generalized**: state the
   situation in plain language, at the top, with the required action attached.
5. **The archived-ticket banner** (`:1702`) — *"It's not gone — just archived
   because it's old"*. Anticipates the user's actual worry and answers it in
   their words.
6. **The action bar sits in the header**, above the two-column body — actions are
   the first thing on the page, not buried under the file lists. The layout
   priority is right.
7. **The stat strip's per-role slot counts**
   (`app/(protected)/requests/page.tsx:335-337`) — the queue already knows what
   each role cares about. `UI-6` is about the list not using what the header
   computed.
