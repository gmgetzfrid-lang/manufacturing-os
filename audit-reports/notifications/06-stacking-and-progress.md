# 06 · Background jobs & the bottom-right corner

**13 findings** — 13 MEDIUM.

Progress and completion messaging: how many things render in that corner, whether they stack, and whether a failure is ever seen.

> Each finding below survived an adversarial verification pass: a second agent read
> the cited code and tried to refute it. Refuted findings were dropped and are not
> recorded. A severity set by that pass overrides the original.


### Already there — reusable substrate

| Thing | Where | Why it matters |
|---|---|---|
| CornerPortal — a working portal abstraction with a documented no-dock fallback | `components/ui/CornerDock.tsx:30-48` | Adding a widget to the shared corner is a two-line change. Priority slots, a visible-count cap, and a drawer-aware offset can all be added inside this one file and every existing consumer inherits them. |
| lib/clientBackup.ts's module-level publish/subscribe job store | `lib/clientBackup.ts:200-250` | Already the right shape for a general background-job registry: state outside React so it survives route changes, subscribeBackup replaying current state to new subscribers, an explicit dismiss guarded by `if (!running)`, and a beforeunload guard. Generalizing this into one lib/jobs.ts would give uploads, ingestion, and the semantic build a single truth for what is running. |
| lib/uploadActivity.ts — foreground/background contention arbitration with a cooldown | `lib/uploadActivity.ts:12-53` | An inFlight counter and onUploadActivity listener already exist and are consumed by KnowledgeIndexIndicator. The same counter is exactly what the missing upload beforeunload guard needs, and it is the natural source for a 'jobs running' badge. |
| Server-side ingestion progress on knowledge_documents (pages_indexed, page_count, status, error) | `lib/knowledge.ts:64, app/api/knowledge/ingest/route.ts:181-183, components/providers/KnowledgeIndexIndicator.tsx:78-84` | AI-ingestion progress and the failure reason are ALREADY durable server state, re-read from the DB on every drain pass. Making ingestion survive a reload and surfacing its failure requires no schema work — the data is there and the empty catch is the only thing throwing it away. |
| KnowledgeIndexIndicator's minimize-to-pill pattern | `components/providers/KnowledgeIndexIndicator.tsx:131-146` | The only correct minimize semantics in the codebase: job keeps running, card collapses to a titled pill showing live percent, one click restores, sticky across drain passes. Lift it into CornerDock as the shared contract so BackupIndicator and multi-file uploads get it for free. |
| Per-job dismiss gating already prevents losing a running job via the X | `components/providers/UploadIndicator.tsx:62, components/providers/KnowledgeIndexIndicator.tsx:161-167, lib/clientBackup.ts:228` | All three indicators refuse to let a user dismiss a RUNNING job. That invariant is the hard part and it holds — the remaining exposure is occlusion, not dismissal. |
| SemanticIndexPanel's pinned buildNote, including a branch for the silent no-op | `components/knowledge/SemanticIndexPanel.tsx:49-50, 90-96` | A worked example of 'toasts vanish, so pin the outcome' that even handles the ended-without-finishing case. It is the right model for a durable job-outcome list attached to the dock. |
| ExecutionView's allSettled batching with a truthful end-of-run report | `app/(protected)/documents/[libraryId]/page.tsx:2482-2547` | Per-file failure names and reasons are already collected (failures, notStarted, landed) and turned into prose. That summary just needs a destination that outlives the modal — feed it into the dock rather than only setError inside the overlay. |


---


<a id="stack-1"></a>

## STACK-1 · A long AI job (semantic index build) has zero corner presence and no unmount cleanup — navigating away hides it while it keeps running

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/knowledge/SemanticIndexPanel.tsx:44-107`, `components/knowledge/SemanticIndexPanel.tsx:194`

**Mechanism.** The build loop is driven from page-scoped React state (`setBuilding`, `setState` progress) with `stopRef` as the only stop channel, reachable solely through the panel's own Stop button. Grepping the file for useEffect|return () yields exactly one effect — `useEffect(() => { void load(); }, [load]);` — with no cleanup. Nothing sets `stopRef.current = true` on unmount and nothing registers with CornerPortal, uploadActivity, or any module-level store. Navigating away removes the progress bar and the Stop button while the awaited buildSemanticIndex loop continues issuing embedding calls on the user's own paid key.

**Failure scenario.** A DocCtrl starts a meaning-index rebuild that costs real money on their API key, then navigates to a drawing. Progress vanishes, Stop vanishes, and the loop keeps spending. The eventual outcome arrives only as a toast (ToastProvider outlives the route), which they may miss entirely.

**Evidence.**

```
components/knowledge/SemanticIndexPanel.tsx:65
  useEffect(() => { void load(); }, [load]);

components/knowledge/SemanticIndexPanel.tsx:76-80
      const final = await buildSemanticIndex(
        orgId, libraryId,
        (p) => setState((s) => ({ ...s, key, status: p, unavailable: null })),
        () => stopRef.current,
      );
```

> **Verifier correction.** The consequence framing is slightly overheated — "continues issuing embedding calls on the user's own paid key" is work the user explicitly started, so the harm is loss of visibility and loss of the only Stop control, not runaway spend. Note also that the panel's own `finally` block (:101-104) calls setBuilding(false) and load() on an unmounted component, which is a no-op rather than a crash in React 18. MEDIUM is right.

**Done when.**

- [ ] the semantic build publishes to a module-level store like lib/clientBackup's publish/subscribe and renders a CornerPortal card with progress and Stop
- [ ] or the panel sets stopRef.current = true in a cleanup so the job cannot outlive its only visible control

---

<a id="stack-2"></a>

## STACK-2 · A user-cancelled upload is reported to the corner as a red "Failed", contradicting the code's own stated intent

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/storage.ts:62-64`, `lib/storage.ts:402-409`, `lib/storage.ts:420-430`, `components/providers/UploadIndicator.tsx:57-75`

**Mechanism.** UploadCancelledError's constructor is `super("cancelled")`. Both the multipart catch and the single-PUT catch call `emitUpload({ … status: "error", error: (err as Error).message })` BEFORE the `if (err instanceof UploadCancelledError) throw err;` line whose comment says cancellation must not "read like a failure". UploadIndicator has no cancelled state: status "error" renders a rose AlertCircle, the word "Failed", and `<div className="text-[10px] text-rose-600 …">{u.error}</div>` — literally the word "cancelled" in red under "Failed" — held for 7000ms versus 2500ms for done.

**Failure scenario.** A user presses Stop on a staged batch. Every in-flight file's card turns red and reads "Failed / cancelled" for seven seconds. In a PSM/OSHA context that reads as a document-control failure and prompts an unnecessary re-upload and a support call.

**Evidence.**

```
lib/storage.ts:424-429
  } catch (err) {
    emitUpload({ id, name, percent: 0, status: "error", error: (err as Error).message });
    // Cancellation is the user's own doing — keep it recognisable instead of
    // wrapping it into "Upload cancelled" prose that reads like a failure.
    if (err instanceof UploadCancelledError) throw err;
    throw new Error(`Upload ${(err as Error).message}`);

components/providers/UploadIndicator.tsx:60
              {u.status === "uploading" ? `${Math.round(u.percent)}%` : u.status === "done" ? "Done" : "Failed"}
```

> **Verifier correction.** One overstatement: "Both the multipart catch and the single-PUT catch call emitUpload … BEFORE the `if (err instanceof UploadCancelledError) throw err;` line" is only literally true of the single-PUT catch. The multipart catch (lib/storage.ts:404-407) is `emitUpload({ … status: "error", error: (err as Error).message }); throw err;` — it has no UploadCancelledError branch at all and no such comment. The user-visible outcome is identical for both paths, so the finding's conclusion is unaffected.

**Done when.**

- [ ] UploadActivityStatus gains "cancelled" and both catch sites emit it for UploadCancelledError
- [ ] UploadIndicator renders cancelled in a neutral tone reading "Stopped", auto-clearing on the done timing

---

<a id="stack-3"></a>

## STACK-3 · AI ingestion failure is swallowed by an empty catch — the user is told "caught up", never "failed"

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/providers/KnowledgeIndexIndicator.tsx:97-112`, `app/api/knowledge/ingest/route.ts:179-185`, `lib/knowledge.ts:450-458`, `app/(protected)/knowledge/[id]/page.tsx:1931`

**Mechanism.** The app-shell background driver awaits ingestKnowledgeDocument inside `try { … } catch { /* row is marked errored server-side; move on */ }`. ingestLoop throws real, actionable prose ("Indexing stalled at page N … Turn off 'Index every page with AI vision' …") and the server writes `status:"error", error: message.slice(0,500)` onto the row. The catch discards the Error object entirely — it is not toasted, not stored in DriveState, and DriveState has no field to hold it (`phase: "working" | "done"` only). When the drain pass ends, `setState((s) => s ? { ...s, phase: "done", finished } : null)` flips the card to the success branch. `finished` is only incremented after a successful await, so a failed document contributes nothing. The three indicator files import no toast at all (grep for showToast across them returns zero hits).

**Failure scenario.** A controller uploads a 900-page SHX-export standard into a watched folder. The driver picks it up, the card says "Indexing knowledge in the background". Vision stalls; ingestLoop throws after three no-progress rounds. The card flips to a green CheckCircle2 reading "Knowledge indexing caught up" / "0 documents indexed." The only place the real reason surfaces is app/(protected)/knowledge/[id]/page.tsx:1931 — a page the user has no reason to visit, because the app just told them everything was fine. Later that document silently returns no citations in an OSHA/PSM answer.

**Evidence.**

```
components/providers/KnowledgeIndexIndicator.tsx:106-112
            });
            finished++;
          } catch { /* row is marked errored server-side; move on */ }
        }
        if (alive && sawWork) {
          setState((s) => s ? { ...s, phase: "done", finished } : null);
        }

app/api/knowledge/ingest/route.ts:179-184
  } catch (e) {
    const message = (e as Error).message;
    await supabaseAdmin.from("knowledge_documents")
      .update({ status: "error", error: message.slice(0, 500) })
      .eq("id", doc.id as string);
    return bad(`Indexing failed: ${message}`, 502);
```

> **Verifier correction.** Severity CRITICAL is overstated because the error is NOT lost — it is persisted and surfaced on a second render site the finding cites but does not credit. app/(protected)/knowledge/[id]/page.tsx:1931 renders `{doc.status === "error" && <span className="text-rose-700 …" title={doc.error ?? undefined}>Indexing failed — {doc.error?.slice(0, 80)}</span>}` and that line is OUTSIDE any isController guard, so every user who opens the library sees it; :1938 adds a controller-only Resume button. Separately app/api/cron/maintenance/route.ts:257 calls `drainKnowledgeIngestQueue`, so the same queue is retried server-side without anyone watching. One more nuance the finding misses in the app's favor: with all documents failing, `finished` is 0 and the done branch renders "0 documents indexed." at :198 — self-contradictory next to "caught up", but not a clean false success. The real defect is scoped to "the background driver's card never reports failure and offers no route to the row that did", which is MEDIUM.

**Done when.**

- [ ] DriveState carries a failed[] list (docName + message) and the card renders a rose "N document(s) could not be indexed" branch with the per-doc reason and a link to /knowledge/[libraryId]
- [ ] the empty `catch {}` at KnowledgeIndexIndicator.tsx:108 binds the error and records it instead of discarding it
- [ ] the done branch never renders a green checkmark when failed.length > 0

---

<a id="stack-4"></a>

## STACK-4 · Bottom-center is a second uncoordinated corner: undo toasts and the graph return chip occupy identical coordinates

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/projects/UndoToastHost.tsx:21`, `components/graph/BackToGraphChip.tsx:24`, `app/(protected)/layout.tsx:68`, `components/projects/ExecutionView.tsx:926`

**Mechanism.** UndoToastHost is `fixed bottom-4 left-1/2 -translate-x-1/2 z-[280]` and is mounted only inside ExecutionView (two differently-shaped greps — bare identifier UndoToastHost and useUndoableActions — return exactly one mount, ExecutionView.tsx:926); it never goes through CornerPortal. BackToGraphChip is mounted globally at layout.tsx:68 and renders `fixed bottom-4 left-1/2 -translate-x-1/2 z-40` whenever the URL carries `from=graph`. Identical anchor, identical translate; z-280 wins. Neither is aware of the other, and neither is aware of the dock.

**Failure scenario.** A user opens a project from the org graph (URL keeps ?from=graph), performs an undoable action in the execution view, and the undo toast lands exactly on top of the "Back to graph" chip. That chip is the only affordance preserving their saved graph layout, and it is hidden for the toast's lifetime — which is also the window in which they must click Undo.

**Evidence.**

```
components/projects/UndoToastHost.tsx:21
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[280] flex flex-col items-center gap-2 pointer-events-none">

components/graph/BackToGraphChip.tsx:24
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-violet-600 hover:bg-violet-500 text-white text-[11px] font-black shadow-xl transition-colors"
```

> **Verifier correction.** Real but narrow: the collision needs a project opened from the graph AND a transient undo toast on the Schedule tab, and both surfaces are short-lived (UndoToastHost returns null with zero toasts, :19). Treat it as evidence for the architectural point — bottom-center is a second, uncoordinated corner outside the dock's contract — rather than as a frequently-hit bug.

**Done when.**

- [ ] a single bottom-center dock exists (mirroring CornerDock) that both UndoToastHost and BackToGraphChip portal into, or the chip is relocated
- [ ] overlap is verified with ?from=graph on a project execution page

---

<a id="stack-5"></a>

## STACK-5 · CornerPortal renders its own duplicate fixed corner for the first frame of every appearance

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `components/ui/CornerDock.tsx:32-48`

**Mechanism.** `target` starts null and is only set from `setTimeout(…, 0)` inside an effect, so on the first committed paint after mount CornerPortal renders the fallback `<div className="fixed bottom-4 right-4 z-[300] flex flex-col items-end gap-2 pointer-events-none">{children}</div>` — pixel-identical coordinates to the dock. Because UploadIndicator and KnowledgeIndexIndicator return null while idle, their CornerPortal remounts on every appearance, not just once at boot. The fallback is documented as a public-page degradation, but it fires on protected pages too.

**Failure scenario.** An upload starts while the indexing card is already docked. For at least one frame the upload card renders in its own corner box directly on top of the indexing card — exactly the overlap CornerDock's header comment says it was built to eliminate — then snaps into the stack. On a loaded plant laptop this reads as a flicker or jump every time a job starts.

**Evidence.**

```
components/ui/CornerDock.tsx:40-46
  if (!target) {
    return (
      <div className="fixed bottom-4 right-4 z-[300] flex flex-col items-end gap-2 pointer-events-none">
        {children}
      </div>
    );
  }
```

> **Verifier correction.** Verification downgraded to SUSPECTED because the stated consequence is not observable from the repo and, as written, is close to harmless: for one frame the widget renders at coordinates where the dock is otherwise empty, so there is nothing to duplicate against and nobody has run the app to see a flicker. The version of this that matters is the one I raise under finding 7 — ToastProvider mounts outside ProtectedContent (layout.tsx:141) while RoleContext.tsx:47 starts `loading` true, so `#corner-dock` (layout.tsx:62) is likely absent when its `setTimeout(…, 0)` fires, and with `[]` deps (:39) the effect never retries, leaving toasts on the fallback corner permanently. That would be a genuine duplicate corner, not a one-frame artifact — but it depends on auth-resolution timing I cannot confirm by reading. Fix the missing retry (observe the dock, or re-resolve when children appear) and both variants close.

**Done when.**

- [ ] target resolves synchronously via useLayoutEffect, or the fallback renders nothing on the first frame and appears only after a tick confirms no dock exists
- [ ] the fallback is offset or hidden when a dock is present

---

<a id="stack-6"></a>

## STACK-6 · Dismissal of the indexing card is silently undone by the next queued document, and no dismissal survives reload

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/providers/KnowledgeIndexIndicator.tsx:50-55`, `components/providers/KnowledgeIndexIndicator.tsx:88-92`, `components/providers/UploadIndicator.tsx:39-44`, `lib/clientBackup.ts:227-229`

**Mechanism.** `hidden` is reset by `setHidden(false)` inside the per-document body of the drain loop, so every document the driver picks up re-expands a card the user closed. `minimized` is correctly sticky within the session, but both are plain useState with no localStorage write (grep for localStorage in the file returns nothing, though the codebase uses it elsewhere, e.g. app/layout.tsx:61 for density), so a reload restores the full card. Positively, neither indicator lets you dismiss a RUNNING job: the X only renders when `!working` (KnowledgeIndexIndicator.tsx:161-167), UploadIndicator's X only when `u.status !== "uploading"`, and dismissBackup is guarded by `if (!running)`. So a still-running job cannot be permanently lost through the dismiss buttons — it is lost through occlusion instead (see the modal and drawer findings).

**Failure scenario.** A user with a 12-document queue closes the "caught up" card. Ninety seconds later the driver starts document 2 and `setHidden(false)` re-opens a 330px card over their work. Repeat eleven times. The user learns Dismiss does not work and stops attending to the corner — which is precisely what makes the occlusion findings dangerous.

**Evidence.**

```
components/providers/KnowledgeIndexIndicator.tsx:88-92
          attempted.add(next.id);
          sawWork = true;
          setHidden(false);
          setState({
            phase: "working", docName: next.name, indexed: 0, total: null,

components/providers/KnowledgeIndexIndicator.tsx:52-55
  // Sticky across drain passes — new work must NOT re-expand a card the
  // user deliberately tucked away.
  const [minimized, setMinimized] = useState(false);
```

> **Verifier correction.** No factual correction — but note this is arguably a deliberate trade-off rather than a bug: the reset is what makes NEW work visible after a user dismissed a completed "caught up" card, and the file's own comment at :52-54 shows the author reasoned about exactly this distinction and chose to make `minimized` sticky while leaving `hidden` resettable. The defensible defect is the asymmetry plus the lack of any persistence across reload, which is MEDIUM, not a correctness failure.

**Done when.**

- [ ] `setHidden(false)` no longer fires for a queue the user already dismissed — new work reopens as the minimized pill at most
- [ ] minimized/hidden persist to localStorage keyed by org, cleared on sign-out alongside the intel-status- keys in RoleContext.tsx:272-277

---

<a id="stack-7"></a>

## STACK-7 · On a phone the corner stack is near-full-width and lands on top of the library's bottom action tray

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/providers/ToastProvider.tsx:63`, `components/providers/UploadIndicator.tsx:51`, `components/providers/KnowledgeIndexIndicator.tsx:150`, `components/documents/StagingTray.tsx:20`, `components/ui/CornerDock.tsx:25`

**Mechanism.** The dock clamps only itself (`max-w-[calc(100vw-2rem)]`); its children carry fixed widths — toasts `w-80` (320px), upload cards `w-72` (288px), the index card `w-[330px] max-w-[calc(100vw-2.5rem)]` (the only one with a mobile clamp). On a 360px viewport a toast is ~89% of the width, and `items-end` on a column flex container does not shrink a fixed-width child, so on narrower devices a 320px toast overflows leftward out of a 288px dock. There is no `sm:`/`md:` breakpoint anywhere in CornerDock or in the toast/upload card classes. Separately, StagingTray is `fixed bottom-0 left-0 right-0 z-30` — a full-width dark bar on the documents library page — and the dock at bottom-4 z-300 sits directly on top of it.

**Failure scenario.** A supervisor on a phone in the plant opens a library with a Reference Stack active. The staging tray's right-hand controls (Clear / Open) are covered by an upload card, and any toast blankets almost the whole bottom of the screen while the page's own bottom bar is unreachable underneath.

**Evidence.**

```
components/providers/ToastProvider.tsx:63
              pointer-events-auto w-80 p-4 rounded-xl shadow-lg border animate-in slide-in-from-right-full fade-in duration-300

components/providers/UploadIndicator.tsx:51
      <div className="flex flex-col gap-2 w-72 pointer-events-auto">

components/documents/StagingTray.tsx:20
    <div className="fixed bottom-0 left-0 right-0 z-30 flex flex-col items-center pointer-events-none">
```

> **Verifier correction.** One arithmetic claim is wrong and should not be repeated: "on narrower devices a 320px toast overflows leftward out of a 288px dock." The dock has no fixed width — it is a shrink-to-fit fixed flex column capped at `max-w-[calc(100vw-2rem)]`, so it sizes to its widest child. On a 360px viewport the cap is 328px and a `w-80` (320px) toast fits inside it with no overflow; overflow only begins at viewports ≤336px (e.g. a 320px iPhone SE). The surviving claims are that a toast is ~89% of a 360px viewport, that no breakpoint exists anywhere in the corner stack, and the StagingTray overlap.

**Done when.**

- [ ] cards use `w-[min(20rem,calc(100vw-2rem))]` or equivalent so they clamp on small screens
- [ ] the dock lifts above any page-declared bottom bar (a CSS var the tray sets, consumed as the dock's bottom offset)
- [ ] on mobile the dock collapses to a single summary pill that expands on tap

---

<a id="stack-8"></a>

## STACK-8 · The backup — the longest-running job in the app — is not in the dock at all, and it covers the offline/update pills

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/providers/BackupIndicator.tsx:27`, `components/pwa/ServiceWorkerManager.tsx:73`, `components/ui/CornerDock.tsx:3-13`, `lib/clientBackup.ts:224`

**Mechanism.** CornerDock's header comment claims "ONE bottom-right corner for every floating surface", but BackupIndicator never imports CornerPortal (grep for CornerPortal across app/components/lib/hooks returns only CornerDock, KnowledgeIndexIndicator, UploadIndicator and ToastProvider). It pins itself `fixed bottom-5 left-5 z-[300] w-[340px]`. ServiceWorkerManager pins `fixed bottom-4 left-4 z-[200]` for the offline pill and the update-available button. Same corner, backup wins on z-index and is 340px wide over pills that start 4px from the left — the pills are fully occluded. BackupIndicator also has no minimize, and its only in-flight control is `<button onClick={cancelBackup}>Cancel</button>` with no confirmation; cancelBackup just sets a flag with no undo.

**Failure scenario.** An admin starts a multi-gigabyte full backup and the plant network drops. The amber "Offline — showing cached data" pill renders at bottom-left z-200 and is completely hidden behind the 340px backup card at z-300, so the user watches file fetches fail into `progress.errors` with no idea the network is the cause. Separately, one stray click on the unconfirmed "Cancel" ends a 40-minute run.

**Evidence.**

```
components/providers/BackupIndicator.tsx:27
    <div className="fixed bottom-5 left-5 z-[300] w-[340px] max-w-[calc(100vw-2.5rem)] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl p-3.5 animate-in slide-in-from-bottom-4">

components/pwa/ServiceWorkerManager.tsx:73
    <div className="fixed bottom-4 left-4 z-[200] flex flex-col gap-2 pointer-events-none">

components/providers/BackupIndicator.tsx:65
            <button onClick={cancelBackup} className="font-black text-rose-600 hover:underline">Cancel</button>
```

> **Verifier correction.** "The pills are fully occluded" is overstated. The 340px-wide card sits at bottom-5 (20px) while the pills sit at bottom-4 (16px) and are only ~30px tall, so a ~4px sliver of the pill survives beneath the card — occluded in practice, but not the total erasure claimed. The collision is also conditional on co-occurrence: BackupIndicator returns null unless a backup is live (`if (!p) return null`, :21) and the pills render only when `offline` or `updateReady`. HIGH → MEDIUM.

**Done when.**

- [ ] BackupIndicator renders through CornerPortal like the other two, or ServiceWorkerManager's pills move out of the bottom-left
- [ ] BackupIndicator gains a minimize pill matching KnowledgeIndexIndicator's pattern
- [ ] Cancel is behind an appConfirm

---

<a id="stack-9"></a>

## STACK-9 · The dock has no ordering rule and no cap — stack order is "whoever last became visible", and toasts are unbounded

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/ui/CornerDock.tsx:32-48`, `components/providers/ToastProvider.tsx:40-49`, `components/providers/ToastProvider.tsx:57-59`, `components/providers/UploadIndicator.tsx:46`

**Mechanism.** CornerPortal resolves the dock via `setTimeout(…, 0)` then `createPortal(children, target)`, which appends to the dock element. Grepping ToastProvider/UploadIndicator/CornerDock for slice|sort|MAX|limit yields exactly one hit — UploadIndicator's internal `.sort((a,b) => a._t - b._t)`. There is no cap on `toasts` (showToast unconditionally does `setToasts(prev => [...prev, …])`) and no cap on upload cards. Dock order is therefore portal-append order: ToastProvider's portal mounts at app start and never unmounts (it renders its wrapper even with zero toasts, which also contributes a phantom `gap-2` 8px), while UploadIndicator and KnowledgeIndexIndicator return null when idle and so re-append at the END of the dock every time they transition from hidden to visible. Nothing expresses priority: a 5-second informational toast and a 40-minute indexing job are peers.

**Failure scenario.** A 40-file bulk upload puts 40 cards (each ~56px plus an 8px gap) in the dock at once — roughly 2,500px of column, far taller than any viewport, with no scroll container and no "+37 more". The dock grows upward from bottom-4, so the oldest cards render off the top of the screen. Separately, dismissing the last upload card unmounts the portal, so the next upload's cards appear on the opposite side of the index card from where they were a minute ago.

**Evidence.**

```
components/ui/CornerDock.tsx:36-39
  useEffect(() => {
    const t = setTimeout(() => setTarget(document.getElementById(DOCK_ID)), 0);
    return () => clearTimeout(t);
  }, []);

components/providers/ToastProvider.tsx:42
    setToasts((prev) => [...prev, { id, type, title, message, duration }]);
```

> **Verifier correction.** The ToastProvider half of the mechanism is probably worse than described, and the phantom-gap sub-claim is likely moot. ToastProvider is mounted OUTSIDE ProtectedContent (layout.tsx:141), while CornerDock renders inside it at :62 — and ProtectedContent returns the "Authenticating..." screen (:35-42) while RoleContext.tsx:47 `const [loading, setLoading] = useState(true);` is still true. So when ToastProvider's CornerPortal effect fires its `setTimeout(…, 0)`, the `#corner-dock` element is very likely not yet in the DOM; the effect has `[]` deps (CornerDock.tsx:39) and never retries, so `target` stays null and toasts render in the fallback corner permanently rather than stacking in the dock at all. That is SUSPECTED (it depends on auth-resolution timing I cannot observe without running the app), but if it holds, toasts OVERLAP the upload/index cards instead of stacking with them, and the claimed 8px phantom gap from the always-rendered empty toast wrapper never reaches the dock. The no-cap and no-priority findings stand as CONFIRMED regardless.

**Done when.**

- [ ] CornerDock accepts an explicit slot/priority per portal (persistent jobs pinned nearest the corner, transient toasts above) rather than relying on append order
- [ ] the dock caps visible children (e.g. 3–4) and collapses the rest into a "+N more" expander with max-height and overflow-y-auto
- [ ] a 40-file upload is verified not to exceed the viewport

---

<a id="stack-10"></a>

## STACK-10 · The modal that starts a bulk upload paints over the dock that reports it

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/layout.tsx:59-72`, `components/ui/CornerDock.tsx:25`, `components/documents/MetadataStagingModal.tsx:461`, `app/(protected)/documents/[libraryId]/page.tsx:2537-2547`, `components/assets/AssetPhotoUploader.tsx:140`, `components/documents/CustomizeNodeModal.tsx:98`

**Mechanism.** CornerDock is `fixed … z-[300]` and is rendered at layout.tsx:62, i.e. BEFORE `<SubscriptionGate>{children}</SubscriptionGate>` at line 67. Both are fixed children of the same non-stacking `<main className="flex-1 overflow-auto relative">` (position:relative with z-index:auto creates no stacking context), so they compete in the root stacking context and equal z-index is broken by DOM order — the page's modal, rendered later, wins. MetadataStagingModal is exactly z-[300] with a `bg-slate-900/60 backdrop-blur-sm` full-screen overlay, and the library page only closes it on total success: `setShowStagingModal(false)` sits in the else branch after every file is attempted; on any failure the code comments "Keep the staging modal open so the failures are still in hand." Other upload-starting surfaces sit strictly above z-300: AssetPhotoUploader z-[510], CustomizeNodeModal z-[400], both calling uploadToPath directly.

**Failure scenario.** A DocCtrl stages 40 drawings in the title-block wizard and hits commit. For the whole run, every UploadIndicator card the dock is stacking (filename, live percent, per-file "Failed" with reason) renders underneath a blurred slate overlay. If any file fails the modal never closes, so the corner stays covered — and the per-file `error` text at UploadIndicator.tsx:73-75 is never seen. On the photo uploader (z-510) there is no in-modal progress substitute at all.

**Evidence.**

```
app/(protected)/layout.tsx:62-67
            <CornerDock />
            <UploadIndicator />
            <BackupIndicator />
            <KnowledgeIndexIndicator />
            <GlobalCommandPalette />
            <SubscriptionGate>{children}</SubscriptionGate>

components/ui/CornerDock.tsx:25
      className="fixed bottom-4 right-4 z-[300] flex flex-col items-end gap-2 pointer-events-none max-w-[calc(100vw-2rem)]"

components/documents/MetadataStagingModal.tsx:461
    <div className="fixed inset-0 z-[300] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto">

app/(protected)/documents/[libraryId]/page.tsx:2543-2547
        // Keep the staging modal open so the failures are still in hand.
        setError(`Uploaded ${landed} of ${resolved.length}. ${notes.join(" ")}`);
      } else {
        setShowStagingModal(false);
```

> **Verifier correction.** Two corrections. (1) Line numbers drift: the quoted library-page block is at app/(protected)/documents/[libraryId]/page.tsx:2527 (`// Keep the staging modal open so the failures are still in hand.`) and :2530 (`setShowStagingModal(false);`), not 2543-2547. The text is verbatim; the anchors are ~16 lines off. (2) HIGH is overstated because the modal is not a feedback blackout. MetadataStagingModal.tsx:776-778 renders `{submitting ? <Loader2 … animate-spin /> : <CheckCircle2 …/>}{submitting ? "Uploading…" : "Upload All"}`, :764-769 renders a Stop button during submit, and :472-476 keeps the X live ("Never disabled. An upload the user can't get out of is worse than one they cancelled."). The overlay is also `bg-slate-900/60` — translucent — so the dock is dimmed and blurred, not erased. What is genuinely lost is per-file progress/filenames and every dock control's clickability (the full-screen overlay eats pointer events).

**Done when.**

- [ ] a documented z-index scale exists with the dock strictly above every modal/backdrop layer (e.g. dock z-900, modals ≤800), or the dock is portaled to document.body and given the top band
- [ ] MetadataStagingModal, AssetPhotoUploader (z-510) and CustomizeNodeModal (z-400) are all verified to render below the dock while an upload is in flight
- [ ] a manual pass confirms upload cards remain readable with each of those modals open

---

<a id="stack-11"></a>

## STACK-11 · Three full-height right-edge drawers own the bottom-right corner; the dock floats on top of all of them with no offset

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/documents/InspectorDrawer.tsx:42`, `components/documents/HistoryDrawer.tsx:161`, `components/notifications/NotificationCenter.tsx:102`, `components/ui/CornerDock.tsx:25`

**Mechanism.** InspectorDrawer (`fixed top-0 right-0 bottom-0 z-[60] w-[640px]`), HistoryDrawer (`fixed inset-y-0 right-0 w-[600px] … z-[70]`) and NotificationCenter (`fixed top-0 right-0 bottom-0 z-[241] w-[480px]`) each occupy the full right edge including the bottom-right corner. The dock is z-[300] at bottom-4/right-4 with children of w-72/w-80/w-[330px] — geometrically entirely inside every one of those footprints, and above all three on z. Nothing in CornerDock reads drawer state or shifts left when one is open.

**Failure scenario.** An engineer opens the Inspector on a controlled drawing (the primary document-control workspace) and a colleague's realtime notification toast fires. The 320px toast lands squarely over the bottom-right of the drawer — the region holding its action controls — and stays 5s. Worse, if an upload or index card is docked it sits there indefinitely, permanently masking that part of the drawer until the job ends. Opening the bell drawer (NotificationCenter) has the same problem, which is exactly where a user goes when the corner is noisy.

**Evidence.**

```
components/documents/InspectorDrawer.tsx:42
        className={`fixed top-0 right-0 bottom-0 z-[60] w-[640px] max-w-[92vw] lg:w-[720px] bg-[var(--color-surface)] shadow-2xl border-l border-slate-200/80 flex flex-col transition-transform duration-500 ${

components/notifications/NotificationCenter.tsx:102
        className={`fixed top-0 right-0 bottom-0 z-[241] w-[480px] max-w-[94vw] bg-[var(--color-surface)] border-l border-[var(--color-border)] shadow-2xl flex flex-col transition-transform duration-500 ${
```

> **Verifier correction.** HIGH is overstated: the finding asserts geometry but demonstrates no blocked control. I checked what actually sits in the overlapped region. InspectorDrawer has no footer at all — :68 is `<div className="flex-1 overflow-y-auto p-4 custom-scrollbar">{children}</div>` — so the dock obscures scrolling content, not affordances. NotificationCenter's only bottom-anchored control is the footer `<Link href="/inbox">Open the full inbox cockpit</Link>`, which is `inline-flex` and therefore LEFT-aligned inside a 480px right-anchored panel, i.e. outside the dock's x-range (right-4 to roughly right-334 for a w-[330px] card). Also, the dock itself is `pointer-events-none` (CornerDock.tsx:25) and its widgets return null when idle, so nothing is intercepted unless a card is actually up. Real layout gap, MEDIUM.

**Done when.**

- [ ] a shared "right rail occupied" signal (context or CSS var) shifts the dock left by the open drawer's width, or the dock docks to the drawer's left edge
- [ ] open-drawer plus active-upload is manually verified to leave both readable

---

<a id="stack-12"></a>

## STACK-12 · Toasts are the only channel for many job outcomes and self-destruct in 5 seconds with no history

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/providers/ToastProvider.tsx:40-49`, `components/knowledge/SemanticIndexPanel.tsx:81-102`, `components/providers/NotificationListener.tsx:64-69`

**Mechanism.** showToast defaults `duration = 5000` and `setTimeout(() => removeToast(id), duration)`. Nothing persists a dismissed or expired toast — no store, no bell row written, no replay. The same 5s ephemeral channel carries background-job outcomes (semantic index build errors, upload failures raised by callers) AND person-to-person realtime alerts from NotificationListener, styled identically, which is also why the alert-vs-notification vocabulary reads as arbitrary. SemanticIndexPanel is the one place that noticed and worked around it locally with `buildNote` ("The last build's outcome, pinned under the bar — toasts vanish") — a fix that exists on that one panel only and only while the user stays on it.

**Failure scenario.** A knowledge index build fails while the user is in another browser tab. The 15s error toast fires and expires. They return to an empty corner and a bell with no row. The failure has left no trace anywhere in the UI.

**Evidence.**

```
components/providers/ToastProvider.tsx:44-48
    if (duration > 0) {
      setTimeout(() => {
        removeToast(id);
      }, duration);
    }

components/knowledge/SemanticIndexPanel.tsx:49-50
  /** The last build's outcome, pinned under the bar — toasts vanish. */
  const [buildNote, setBuildNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
```

> **Verifier correction.** Minor: "self-destruct in 5 seconds" is the default, not universal. SemanticIndexPanel passes `duration: 15000` for the error and warning outcomes (:82, :95), and callers can pass `duration: 0` to disable expiry entirely (:44 guards on `duration > 0`). The substantive claim — nothing persists an expired or dismissed toast, and job outcomes share a channel with person-to-person alerts — is confirmed.

**Done when.**

- [ ] job-outcome messages (error/warning) never auto-dismiss, or are written to a persistent activity list reachable from the dock
- [ ] transient person-to-person alerts are visually distinct from background-job messages in the corner

---

<a id="stack-13"></a>

## STACK-13 · Upload progress lives only in tab memory: a reload kills the transfer, leaves no record, and no beforeunload guards it

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/storage.ts:28-40`, `lib/storage.ts:378-431`, `components/providers/UploadIndicator.tsx:19-37`, `lib/clientBackup.ts:211-214`, `components/system/UpdatePill.tsx:41-43`

**Mechanism.** Upload lifecycle is a module-level `Set<UploadListener>` fed by emitUpload from uploadToPath's XHR/multipart path. Nothing is written server-side until the file completes and the `documents` row is inserted. UploadIndicator holds it in `useState<Record<string, Tracked>>`. A reload drops the XHR, the listener set, and the component state — there is no row, no queue entry, no audit event. A beforeunload guard exists for exactly one job: grep for beforeunload across app/components/lib/hooks returns only lib/clientBackup.ts and app/(protected)/plot-plans/[id]/page.tsx. Uploads have none. (In-app navigation IS survived — module-level listeners plus a layout-mounted indicator — so this is reload-specific.)

**Failure scenario.** A user is 80% through a 300MB multipart DWG upload and hits Cmd-R, or taps UpdatePill's "This tab is running an old version — tap to load the update" which calls window.location.reload(). The transfer dies with zero warning and zero trace; the corner is empty on the next paint. They believe the file landed because nothing said otherwise.

**Evidence.**

```
lib/storage.ts:29-30
const uploadListeners = new Set<UploadListener>();
let uploadSeq = 0;

lib/clientBackup.ts:211-214
const warnUnload = (e: BeforeUnloadEvent) => {
  e.preventDefault();
  e.returnValue = "A backup is still running — leaving this tab will stop it.";
};
```

> **Verifier correction.** Two corrections. (1) components/system/UpdatePill.tsx:41-43 is listed under Locations but plays no part in the mechanism — that file is the top-center stale-version pill (`fixed top-3 left-1/2 … z-[100]`, :40), unrelated to uploads. (2) HIGH → MEDIUM: the loss is bounded, not total. app/(protected)/documents/[libraryId]/page.tsx inserts each document row inside the per-file loop, so files that already completed are durable; what a reload destroys is the in-flight transfer plus the queue of not-yet-started files. That plus the inconsistency (backup warns, uploads do not) is the real defect.

**Done when.**

- [ ] a beforeunload guard is registered while lib/uploadActivity's inFlight > 0 (the counter already exists)
- [ ] UpdatePill's reload is suppressed or warned while isUploading() is true

---
