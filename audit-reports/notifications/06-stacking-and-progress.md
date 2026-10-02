# 06 · Background jobs & the bottom-right corner

**14 findings** — 14 MEDIUM. `STACK-14` opened by notifications Round G N7 CORNER, 2026-10-01 — first recorded as a LOW remainder of `STACK-10`'s review fix, then corrected to a MEDIUM regression of that fix. N7's second and third review fixes removed the regression; it stays OPEN (Partial) on its done-when as written, pending ratification of `DEC-44 (N7)` item 4.

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
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/knowledge/SemanticIndexPanel.tsx:44-107`, `components/knowledge/SemanticIndexPanel.tsx:194`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on both halves. Contrast with the sibling KnowledgeIndexIndicator, which does portal into CornerPortal and sets `alive = false` on cleanup — SemanticIndexPanel does neither, so navigating away leaves an in-browser paid loop running with the Stop button unmounted.

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

**Resolution (2026-10-01, notifications Round G).** Reproduced on `b9cdfdc`: `components/knowledge/SemanticIndexPanel.tsx` had one effect (`useEffect(() => { void load(); }, [load])`, :83) and no cleanup; `stopRef` was reachable only from the panel's Stop button. Now an unmount cleanup sets `stopRef.current = true` (and a `leftRef`), so `buildSemanticIndex`'s `shouldStop` turns true and the browser loop stops at its next batch boundary when the panel leaves the page — every committed batch is kept and a build resumes where it stopped. The outcome is said in a 15-second toast that outlives the page ("Meaning-index build stopped when you left the page — N passage(s) left. … build again to resume"); the in-panel Stop keeps its own wording. Test: `lib/__tests__/cornerJobs.test.ts` "STACK-1 — SemanticIndexPanel stops its build when it unmounts" (the real panel, `lib/knowledge` mocked: `shouldStop()` is false while mounted and true after unmount; the toast names the passages left).

**Done-when.**
- dw1 (a module-level store + CornerPortal card) — not taken: the done-when is either/or, and the second branch was taken.
- ✓ dw2: the panel sets `stopRef.current = true` in a cleanup, so the job cannot outlive its only visible control.

**Scope / residual.** The semantic build still runs only while its panel is mounted (the panel already says "Leave this page open and it will finish"); a dock card that would let it run anywhere is not built. The server-side background build (SEM-11) is unchanged. No migration.

---

<a id="stack-2"></a>

## STACK-2 · A user-cancelled upload is reported to the corner as a red "Failed", contradicting the code's own stated intent

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/storage.ts:62-64`, `lib/storage.ts:402-409`, `lib/storage.ts:420-430`, `components/providers/UploadIndicator.tsx:57-75`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and the contradiction is doubly explicit: MetadataStagingModal.tsx:50-52 documents the contract as "`signal` aborts the in-flight transfers when the user presses Stop ... reports UploadCancelledError as 'the user stopped this', not as a failure", and stopUpload (:424-427) is a real user-facing 'Stop upload' button (:768-771). storage.ts never honours that contract on the corner-indicator channel.

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

**Resolution (2026-10-01, notifications Round G).** Reproduced on `b9cdfdc` (`lib/storage.ts` :586-589 / :595-598 / :604-609 emitted `status: "error"` before any `UploadCancelledError` check; the multipart catch had no cancel branch at all); a probe test on the base tree records `['uploading', 'error']` for a Stop. Now `UploadActivityStatus` gains `"cancelled"`, and one helper, `emitUploadEnd(id, name, err)`, emits `cancelled` (no error text) for an `UploadCancelledError` and `error` with the message for anything else, at all three catch sites of `uploadToPath` (multipart, the upload-slot request, the single PUT). What is rethrown is unchanged. `components/providers/UploadIndicator.tsx` renders `cancelled` in a neutral tone — a slate square and "Stopped", no rose text — and clears it on the "Done" timing (`UPLOAD_CLEAR_MS.cancelled = 2500`). Tests: `lib/__tests__/cornerJobs.test.ts` "STACK-2 — lib/storage emits 'cancelled'…" (single PUT, multipart, a real failure still `error` with its reason) and "…UploadIndicator renders a cancelled upload as a neutral 'Stopped'…" (no rose, no "Failed", gone after 2.5s; a failure still reads "Failed" with its reason for 7s).

**Done-when.**
- ✓ `UploadActivityStatus` gains `"cancelled"` and both catch sites (all three) emit it for `UploadCancelledError`.
- ✓ UploadIndicator renders it neutral, reading "Stopped", auto-clearing on the done timing.

**Scope / residual.** None. No migration.

---

<a id="stack-3"></a>

## STACK-3 · AI ingestion failure is swallowed by an empty catch — the user is told "caught up", never "failed"

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/providers/KnowledgeIndexIndicator.tsx:97-112`, `app/api/knowledge/ingest/route.ts:179-185`, `lib/knowledge.ts:450-458`, `app/(protected)/knowledge/[id]/page.tsx:1931`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. The one mitigation the finding already cites is real but out of the way: knowledge/[id]/page.tsx:1931 does show `Indexing failed — {doc.error}` with a resume button, but only on that library's page — a user anywhere else in the app sees a green 'caught up' card that actively asserts the opposite of what happened.

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

**Resolution (2026-10-01, notifications Round G).** Reproduced: Observed in Chromium (Playwright, `/opt/pw-browsers/chromium-1194`) against the real components of `b9cdfdc` and of `fleet/N7-corner`, rendered by a component harness (a vite build of the actual files; only the database, auth, the storage transport and `next/navigation` stubbed — the full page needs Supabase). With one queued document whose batch moved and then stalled, the base card flipped to the emerald check, "Knowledge indexing caught up / 0 documents indexed.", with no link. (Line drift: intelligence I-02b rewrote the loop; the empty catch is :175 on `b9cdfdc`, `catch { /* the reason is on the row (or answered 409); move on */ }`.) Now in `components/providers/KnowledgeIndexIndicator.tsx`:
- `DriveState` carries `failed: FailedDoc[]` (`{ id, name, libraryId, message }`); the queue read selects `library_id`.
- The catch binds the error. It records it unless `ingestFailureOf(e)` says it is not a failure: a park — the engine's 409 for a back-off in force or a vision retry held for a reason (`visionRetryBlocked` / `failureRetryBlocked`; per I-02b "nothing failed now", the reason is on the row) — or another session's claim (lib/knowledge's busy sentence; a test pins the wording). A failed batch (502, the row marked errored), a refused non-PDF, a stall or an unfinished run is recorded with the engine's own words. A failure before any progress now brings the card too; it used to show nothing.
- The finished card renders a rose branch: "N document(s) could not be indexed", each document's name and reason, how many did index, and "Open the library to resume →" to `/knowledge/[libraryId]` (or `/knowledge` when the failures span libraries). The working card says "N could not be indexed so far"; the minimized pill turns rose ("N not indexed"). The green check never shows while `failed.length > 0`.

After the fix the same harness shows the rose card, the reason and the link `/knowledge/lib1`. Tests: `lib/__tests__/cornerJobs.test.ts` "STACK-3 — ingestFailureOf" (park, held retry, busy, failure, stall) and "…the rose 'could not be indexed' branch…" / "a document that failed before any progress is still reported"; the I-02b suite (`lib/__tests__/knowledgeIndexIndicator.test.ts`) still passes — a park and a busy claim show no card.

Review fix: a failure now outlives the drain pass that found it. The first version kept `failed` per pass, and the engine marks a failed row `error`, so no later pass reads it again: the next pass that indexed another document replaced the list with its own empty one and the card went back to the emerald "caught up" while the document was still in error. Failures now live in `failedRef` (a `Map` by document id) that every state the drain writes carries in full. An entry is dropped only when that document later indexes in a drain pass (someone resumed it, or a reset put it back in the queue), or when the person dismisses the finished card with its X; a workspace switch clears it. Tests: `lib/__tests__/cornerJobs.test.ts` "a failure outlives the drain pass that found it…" (pass 1 fails document A; pass 2 indexes document B; the card still names A with its reason, says "1 document indexed." and has no `.text-emerald-600`; a later pass that indexes A turns it green) and "dismissing the finished failure card drops the failures with it…". Both fail on the first version of the file.

**Done-when.**
- ✓ `DriveState` carries a `failed[]` list (docName + message) and the card renders a rose "N document(s) could not be indexed" branch with the per-doc reason and a link to `/knowledge/[libraryId]`.
- ✓ The empty catch binds the error and records it.
- ✓ The done branch never renders a green checkmark when `failed.length > 0`.

**Scope / residual.** The busy test is a match on lib/knowledge's sentence (that file is intelligence I-03's this round); a structured `busy` flag on that throw would be cleaner and is I-03's to add. A failed document that someone resumes from the library page indexes in that page's own loop, which the indicator skips (one driver per document); the card keeps naming it until it is dismissed, because the indicator does not re-read errored rows. That errs toward saying a failure that has since been fixed, never the reverse. No migration.

---

<a id="stack-4"></a>

## STACK-4 · Bottom-center is a second uncoordinated corner: undo toasts and the graph return chip occupy identical coordinates

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/projects/UndoToastHost.tsx:21`, `components/graph/BackToGraphChip.tsx:24`, `app/(protected)/layout.tsx:68`, `components/projects/ExecutionView.tsx:926`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The collision is exactly as described and reachable. Severity is overstated: useUndoableActions.ts:25 `const TIMEOUT_MS = 7000` caps the occlusion at 7s and caps the stack at 3 (line 39 `t.slice(-2)`), and the chip is NOT the only way back — ViewTabs.tsx:110 has a `/graph` nav entry and graph/page.tsx:299-300 states "layout and settings persist per-org already", so reaching /graph by any route restores the same map.

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

**Resolution (2026-10-01, notifications Round G).** Reproduced: Observed in Chromium (Playwright, `/opt/pw-browsers/chromium-1194`) against the real components of `b9cdfdc` and of `fleet/N7-corner`, rendered by a component harness (a vite build of the actual files; only the database, auth, the storage transport and `next/navigation` stubbed — the full page needs Supabase). With the real `UndoToastHost` (ExecutionView's host) and the real `BackToGraphChip` at `/projects/p1?from=graph`, the base undo toast covered the chip (4,373 px² overlap); the chip was not clickable at its centre. Now `components/ui/CornerDock.tsx` adds the bottom-centre dock: `CentreDock` (portaled to `document.body`, mounted once in the protected layout) with two slots — `chip` (fixed, `Z.pageChip` = 40, the chip's old layer) and `toasts` (fixed, `Z.undoToast` = 280, the undo host's old layer) — and `CentrePortal`. `BackToGraphChip` renders into the chip slot; `UndoToastHost` renders into the toasts slot (the edit is local: its outer fixed box became the portal; the A11Y-6 live region and every toast are unchanged). While the chip is present the toasts slot sits 2.5rem higher, so the undo stack stands above the chip instead of on it; both honour `--dock-bottom`.

One dock, two layers, on purpose: a single stacking box would have moved the chip from 40 to 280 — above every modal backdrop between 50 and 260, so a click on it would navigate away from an open modal — or the undo toasts from 280 to 40, under every drawer. Neither surface moves relative to any other overlay (pinned in `lib/__tests__/cornerDock.test.ts`). After: overlap 0; the chip is clickable; the undo toast's top is 702 and the chip's 752. Tests: `lib/__tests__/cornerDock.test.ts` "STACK-4 — one bottom-centre dock…" (both portal in, the slot lifts with the chip, layers 40 / 280, the live region stays mounted, the fallback without a dock).

**Done-when.**
- ✓ A single bottom-centre dock exists (mirroring CornerDock) that both UndoToastHost and BackToGraphChip portal into.
- ✓ Overlap verified with `?from=graph` on a project page: in the harness, with the execution view's real host and the real chip. The full ExecutionView needs Supabase.

**Scope / residual.** None. No migration.

---

<a id="stack-5"></a>

## STACK-5 · CornerPortal renders its own duplicate fixed corner for the first frame of every appearance

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** SUSPECTED
- **Locations:** `components/ui/CornerDock.tsx:32-48`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Accurate: the fallback box carries the identical `fixed bottom-4 right-4 z-[300]` coordinates as the dock (line 25), and because the lookup is deferred into a macrotask the fallback is committed and painted at least once on every mount — and CornerPortal remounts on every appearance (UploadIndicator.tsx:47 `if (list.length === 0) return null`). But the defect is a sub-100ms transient with no state, data or interaction consequence; LOW, not MEDIUM.

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

**Resolution (2026-10-01, notifications Round G).** Observed first, since this was SUSPECTED. Observed in Chromium (Playwright, `/opt/pw-browsers/chromium-1194`) against the real components of `b9cdfdc` and of `fleet/N7-corner`, rendered by a component harness (a vite build of the actual files; only the database, auth, the storage transport and `next/navigation` stubbed — the full page needs Supabase).
- **The variant that matters — CONFIRMED.** `ToastProvider` was rendered above a gate that mounts `CornerDock` 300 ms later, as `ProtectedContent` does after auth. On the base tree the toast was not in `#corner-dock`. It sat in the fallback corner for good (the effect had `[]` deps and never retried), and it covered the upload card completely (13,824 px²).
- **The one-frame variant — also seen.** A MutationObserver caught the re-mounting upload card committed outside the dock on every run. One run's per-frame sampler caught a painted FALLBACK frame.

The fix:
- `CornerPortal` reads the dock's slot elements from a module store (`useSyncExternalStore`). `CornerDock` fills that store through stable ref callbacks, so a portal that mounted before the dock moves into it the moment it appears.
- With no target, the portal renders nothing on its first frame. The fallback appears only after a tick confirms there is no dock (it carries `Z.dock`).

After: the toast is in the dock, the overlap is 0, and nothing is committed outside the dock. Tests: `lib/__tests__/cornerDock.test.ts` "STACK-5 — …" (a provider mounted before the dock lands its toast in it; with the dock mounted no fallback is ever committed; nothing on the first frame without a dock).

**Done-when.**
- ✓ The fallback renders nothing on the first frame and appears only after a tick confirms no dock exists. This is the done-when's second option; the store also re-resolves whenever a dock mounts.
- ✓ The fallback is never shown while a dock is present: the target wins, by construction.

**Scope / residual.** None. No migration.

---

<a id="stack-6"></a>

## STACK-6 · Dismissal of the indexing card is silently undone by the next queued document, and no dismissal survives reload

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/providers/KnowledgeIndexIndicator.tsx:50-55`, `components/providers/KnowledgeIndexIndicator.tsx:88-92`, `components/providers/UploadIndicator.tsx:39-44`, `lib/clientBackup.ts:227-229`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The setHidden(false) reset and the non-persistence across reload are both real. Severity is too high because the finding's own cited lines 50-55 contain the mitigation: `const [minimized, setMinimized] = useState(false)` is explicitly sticky across drain passes ("new work must NOT re-expand a card the user deliberately tucked away"), and the X/Dismiss button only renders in the `phase === "done"` state — so what gets re-shown after dismissal is a *new* card for *new* work, not a resurrection of the dismissed 'caught up' card.

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

**Resolution (2026-10-01, notifications Round G).** Reproduced on `b9cdfdc` (`setHidden(false)` at :164 inside the drain; `hidden` / `minimized` plain state); a probe test on the base tree re-opens "Knowledge indexing caught up" after a dismissal and a remount. Now `setHidden(false)` is gone from the drain, and Dismiss and Minimize persist through `hooks/useDismissed.ts` under `dismissed:<uid>:<orgId>:knowledge-index:dismissed` / `…:minimized`. After a dismissal, new work shows as the minimized pill at most: rose when a pass ends with a failure, nothing when it ends clean. Expanding the pill clears both. `useDismissed` removes every `dismissed:` key on `SIGNED_OUT` through its own one-time auth listener — the same event RoleContext clears the `intel-status-` snapshots on. `components/providers/RoleContext.tsx` belongs to identity / PKG-1 and is not edited. The keys carry the uid as well as the org, so the next account on a shared browser never inherits a dismissal even if a sign-out was missed. Tests: `lib/__tests__/knowledgeIndexIndicator.test.ts` (the I-02b test's last step pinned the old re-open and now pins the pill: "Indexing 40%" while working, nothing after a clean end); `lib/__tests__/cornerJobs.test.ts` "a dismissal persists for this account in this workspace…", "the drain never re-opens the card", and the `useDismissed` suite (sign-out clears, storage that throws, hydration).

**Done-when.**
- ✓ `setHidden(false)` no longer fires: new work reopens as the minimized pill at most.
- ✓ minimized / hidden persist to localStorage keyed by org (and account), cleared on sign-out alongside the intel-status- keys. It is the same event, through the hook's own listener, because RoleContext is another package's file.

**Scope / residual.** None. No migration.

---

<a id="stack-7"></a>

## STACK-7 · On a phone the corner stack is near-full-width and lands on top of the library's bottom action tray

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/providers/ToastProvider.tsx:63`, `components/providers/UploadIndicator.tsx:51`, `components/providers/KnowledgeIndexIndicator.tsx:150`, `components/documents/StagingTray.tsx:20`, `components/ui/CornerDock.tsx:25`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on every count: at 375px viewport a `w-80` toast is 320/375 = 85% of the width, and the dock's z-[300] sits over the tray's z-30 full-width bottom bar whose right-hand Clear/Open controls live exactly under the dock's bottom-right anchor. Only `w-[330px]` on the indexing card has a viewport-relative max-width; the toast and upload cards have none.

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

**Resolution (2026-10-01, notifications Round G).** Reproduced: Observed in Chromium (Playwright, `/opt/pw-browsers/chromium-1194`) against the real components of `b9cdfdc` and of `fleet/N7-corner`, rendered by a component harness (a vite build of the actual files; only the database, auth, the storage transport and `next/navigation` stubbed — the full page needs Supabase). At 360×740 with the real `StagingTray`, the base toast was 320px wide (89% of the viewport), the upload card 288px, and the dock covered all three tray buttons. The fix has three parts.
- **Widths.** Cards clamp to the viewport: toasts `w-[min(20rem,calc(100vw-2rem))]`, upload cards `w-[min(18rem,…)]`, the indexing card `w-[min(330px,…)]`, the backup card `w-[min(340px,…)]`.
- **The tray.** `StagingTray` declares its height in `--dock-bottom` (`useDockBottomInset`: measured, kept current by a ResizeObserver, removed on unmount). Both docks sit above it.
- **Phones.** Below the `sm` breakpoint the dock collapses to one summary pill. It shows the most urgent card's label — an error first, then a running job, then the newest — and the count. A tap expands it (the cap still applies) and "Hide" folds it.
- **Folded cards keep their time (review fix).** The first version stopped every clock while the pill was folded, so on a phone no toast and no finished upload card ever expired: a 2-second "Saved" toast was still a pill after 4 seconds (Chromium, 360×740; on `b9cdfdc` it was gone), above every modal, for the rest of the session. Now the dock tells a widget two numbers (`useDockAllowances`): `shown`, the cards it renders, and `timed`, the cards whose clocks run. Folded, `shown` is 0 and `timed` is what the stack would show — the newest four, as on a desktop — so a toast or a finished upload card expires on its own time and the pill goes with it. Cards past the cap still wait, as they do behind "+N more".
- **The pill says what it shows (review fix).** Its accessible name is its summary and the count ("1 upload failed — 2 updates, show", `pillLabel`), not a bare count. While it is folded no card — and so no error toast's `role="alert"` — is in the page, so the newest summary is mirrored into a visually hidden node in the dock's live region, re-keyed when it changes and `role="alert"` for a failure.

After: no tray button is covered and the pill reads "Uploading 1 file · 2". Expanded, the toast is 320px inside 360 (left 24) and no card is over the tray. After the review fix, the same 360×740 probe shows the 2-second toast and its pill gone at 4 seconds. Tests: `lib/__tests__/cornerDock.test.ts` "STACK-7 — …" (the tray sets and clears the variable; every card clamps; the phone pill, tap and Hide; "on a phone a folded toast still expires on its own time…" — a 2 s toast gone at 2.1 s and a "Done" upload card at 2.6 s; "on a phone the cap still holds the clocks…"; "the pill's accessible name carries what it shows…"). The two clock tests fail on the first version of the widgets.

**Done-when.**
- ✓ Cards use `w-[min(…,calc(100vw-2rem))]`.
- ✓ The dock lifts above a page-declared bottom bar: the tray sets `--dock-bottom` and the dock uses it as its bottom offset.
- ✓ On mobile the dock collapses to a single summary pill that expands on tap.

**Scope / residual.** On a phone a toast is read in the pill (its title is the summary while it is the newest or most urgent), not as a card; that is the pill's design. No migration.

---

<a id="stack-8"></a>

## STACK-8 · The backup — the longest-running job in the app — is not in the dock at all, and it covers the offline/update pills

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/providers/BackupIndicator.tsx:27`, `components/pwa/ServiceWorkerManager.tsx:73`, `components/ui/CornerDock.tsx:3-13`, `lib/clientBackup.ts:224`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. I checked the one thing that could refute this — that ServiceWorkerManager might not be mounted on protected pages — and it is: app/layout.tsx:93 `<ServiceWorkerManager />` in the ROOT layout, which wraps app/(protected)/layout.tsx. A 340px x ~130px card at bottom-5/left-5 z-300 fully covers a pill at bottom-4/left-4 z-200, and BackupIndicator is genuinely outside the dock.

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

**Resolution (2026-10-01, notifications Round G).** Reproduced: Observed in Chromium (Playwright, `/opt/pw-browsers/chromium-1194`) against the real components of `b9cdfdc` and of `fleet/N7-corner`, rendered by a component harness (a vite build of the actual files; only the database, auth, the storage transport and `next/navigation` stubbed — the full page needs Supabase). With a backup running and the browser offline, the base backup card covered the offline pill (8,160 px²); the pill was not on top at its centre, and the card had no minimize. Now `components/providers/BackupIndicator.tsx` renders through `CornerPortal` in the dock's jobs slot, at priority 10, nearest the corner; there is no more `fixed bottom-5 left-5 z-[300]`. It minimizes to a pill that keeps the percent (KnowledgeIndexIndicator's pattern). Cancel goes through `confirmCancelBackup` → `appConfirm` ("Cancel the backup?" — the parts saved stay, the backup will be incomplete and cannot be resumed — "Keep running" / "Cancel backup"), and `cancelBackup` runs only on yes. `components/pwa/ServiceWorkerManager.tsx` (PKG-1's) is not edited, and `lib/clientBackup.ts` (A&O P2's) behaves as before. After: the card is in the dock, the offline pill is on top, the overlap is 0, and the minimize control is present. Tests: `lib/__tests__/cornerJobs.test.ts` "STACK-8 — BackupIndicator" (Cancel asks and cancels only on yes; the card is in the jobs slot, minimizes to "Backup 25%", and the X still dismisses a finished run).

**Done-when.**
- ✓ BackupIndicator renders through CornerPortal like the other two; ServiceWorkerManager is untouched.
- ✓ BackupIndicator gains a minimize pill matching KnowledgeIndexIndicator's pattern.
- ✓ Cancel is behind an appConfirm.

**Scope / residual.** None. No migration.

---

<a id="stack-9"></a>

## STACK-9 · The dock has no ordering rule and no cap — stack order is "whoever last became visible", and toasts are unbounded

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/ui/CornerDock.tsx:32-48`, `components/providers/ToastProvider.tsx:40-49`, `components/providers/ToastProvider.tsx:57-59`, `components/providers/UploadIndicator.tsx:46`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. All three legs hold. Inter-widget order is purely `createPortal` append order (i.e. whichever CornerPortal mounted last), and with `bottom-4` and no `top`/`max-h`, the column grows upward off the top of the viewport with nothing to scroll it. Notably the app already knows how to cap a stack — useUndoableActions.ts:39 `[...t.slice(-2), ...] // keep last 3` — the dock and ToastProvider just don't.

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

**Resolution (2026-10-01, notifications Round G).** Reproduced: Observed in Chromium (Playwright, `/opt/pw-browsers/chromium-1194`) against the real components of `b9cdfdc` and of `fleet/N7-corner`, rendered by a component harness (a vite build of the actual files; only the database, auth, the storage transport and `next/navigation` stubbed — the full page needs Supabase). With 40 uploads, 24 distinct toasts and 10 identical nudges, the base dock's top was at −3,839px and its height 4,623px in an 800px viewport. It held 114 cards, 86 of them entirely above the viewport, could not scroll, and showed 10 nudge cards. The SUSPECTED ToastProvider-outside-ProtectedContent timing is CONFIRMED (see STACK-5). The dock gets a contract in `components/ui/CornerDock.tsx` (decision: `DEC-44 (N7)`):
- **Slots and priority.** Two slots: `jobs` (backup 10, knowledge 20, uploads 30 — `DOCK_PRIORITY`) pinned nearest the corner, and `transient` (toasts) above. Each portal's wrapper carries its priority as CSS `order`, so mount order no longer decides anything.
- **A cap.** `DOCK_VISIBLE_CAP = 4` covers toasts and job cards together. `allocateDock` is pure: jobs first, and one place kept while a message waits. The rest go into one "+N more" card that expands the dock in place and, when messages are among them, also offers "Notifications" (the center) while the dock is at rest (`STACK-10`). Widgets ask `useDockAllowance` how many cards to show; the upload cards show failures first (`pickVisibleUploads`).
- **Scrolling.** The dock is column-reverse with `max-height: calc(100dvh − --dock-bottom)` and `overflow-y-auto`. An expanded column stays anchored at the corner and scrolls upward.

After: the dock's top is at 460, it holds 5 cards (4 plus "+61 more"), none above the viewport, and the nudges coalesce into one "×10" card. Expanded, it is exactly the viewport high (its shadow margin aside), scrollable, and a mouse wheel scrolls it. Tests: `lib/__tests__/cornerDock.test.ts` — the `allocateDock` suite, "40 upload events render at most DOCK_VISIBLE_CAP cards and a '+36 more' expander…", "hidden messages offer the notification center…", "jobs sit nearest the corner…".

*Second review fix (2026-10-01).* Three defects in the cap, found by the N7 review in Chromium:
- **The expansion stuck.** "+N more", once expanded, stayed expanded until the dock was completely empty; a docked indexing card kept it on for hours. In the reviewer's "sticky" probe (expand at 6 toasts, dismiss 3, then 40 uploads) all 40 cards rendered. Now the expansion folds back once the cap holds every card, or once a burst bigger than the cap has arrived since it was opened (`CornerDock`, `expandedFloor`). The same probe, rebuilt against this branch, renders 3 upload cards and "+39 more".
- **A new card cost a visible one its place for a commit.** A widget registers its count in a layout effect, so the render after an arrival asked the store with the old count: n places for n+1 cards. Now a widget's allowance is computed with its live count (`allowanceFor`). This is detailed under `RT-11`.
- **Finished upload cards waited out the batch.** A "Done" or "Stopped" card behind running transfers never started its clear clock, so a 40-file run drained Done cards four at a time for about 25 seconds. Now a "Done" or "Stopped" card clears on its own time from when it finished, as before N7. Only a failure's clock still waits until it is seen (`UploadIndicator`), at rest; while the dock is raised over an upload modal, every failure's clock runs from its event (`STACK-10`, N7 fourth review).

Tests: "an expanded '+N more' folds back once nothing would be hidden…", "a burst bigger than the cap after the expansion folds it back too…", "a new upload never re-mounts the cards already showing…", "a 'Done' or 'Stopped' card behind the cap clears on its own time…". Each was checked to fail against the code before this fix.

**Done-when.**
- ✓ CornerDock takes an explicit slot and priority per portal (persistent jobs pinned nearest the corner, transient toasts above), not append order.
- ✓ The dock caps visible children at 4 and collapses the rest into a "+N more" expander, with a max-height and overflow-y-auto. Since the second review fix, the expander folds back once nothing would be hidden or once a burst bigger than the cap arrives, so the cap is never off "until the dock is empty".
- ✓ A 40-file upload is verified not to exceed the viewport: in Chromium (above) and in jsdom.

**Scope / residual.** None. No migration.

---

<a id="stack-10"></a>

## STACK-10 · The modal that starts a bulk upload paints over the dock that reports it

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/(protected)/layout.tsx:59-72`, `components/ui/CornerDock.tsx:25`, `components/documents/MetadataStagingModal.tsx:461`, `app/(protected)/documents/[libraryId]/page.tsx:2537-2547`, `components/assets/AssetPhotoUploader.tsx:140`, `components/documents/CustomizeNodeModal.tsx:98`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, including the tail of the scenario: MetadataStagingModal.tsx:405-406 documents that "The parent closes the modal on a clean run, but it keeps the modal open when some files failed", and the parent at app/(protected)/documents/[libraryId]/page.tsx:2543 `throw e` is what drives that. MetadataStagingModal does not createPortal (no such import), so the DOM-order tiebreak applies.

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

**Resolution (2026-10-01, notifications Round G).** Reproduced: Observed in Chromium (Playwright, `/opt/pw-browsers/chromium-1194`) against the real components of `b9cdfdc` and of `fleet/N7-corner`, rendered by a component harness (a vite build of the actual files; only the database, auth, the storage transport and `next/navigation` stubbed — the full page needs Supabase). With each of the three real modals open over a failed upload card, `elementFromPoint` at the card's centre hit the modal's overlay on the base tree (`z-[300]`, `z-[510]`, `z-[400]`). The fix (decision: `DEC-44 (N7)`):
- **One layer module.** New `lib/zLayers.ts`: `Z` (pageChip 40, undoToast 280, dock 290, metadataStagingModal 300, customizeNodeModal 400, assetPhotoUploader 510, dialog 700, dockRaised 750, hoverPreview 800, print 9999) and `Z_SCALE`, every z-index value in use (the 2026-10-01 inventory plus the dock's two bands).
- **The dock's bands (second review fix).** The dock is portaled to `document.body`.
  - At rest it is at `Z.dock` = 290. That is the old dock's place: over the page, its drawers, the notification center (241) and the undo toasts (280), and under every overlay from the 300 band up.
  - While one of the three upload-starting modals is open, has started an upload, and the dock shows an upload card, the dock sits at `Z.dockRaised` = 750. That is above every modal, backdrop and dialog band, and below only the pointer-following hover preview (800, as before) and the print cover (9999). Raised, only the upload cards hold places (third review fix, below).
  - The second review fix raised the dock whenever one of the modals was open (`useDockRaise(open)`), with or without an upload. The third review showed the cost: a backup card or a toast was lifted onto the staging grid before any upload (below).
  - The first review fix kept the dock at 750 all the time. A card then covered any undeclared overlay's controls, the asset editor's Save among them (`STACK-14`).
- **The three modals.** `MetadataStagingModal`, `AssetPhotoUploader` and `CustomizeNodeModal` read their layer from `Z` as `style={{ zIndex }}`, with the same values; Tailwind cannot generate a class from a runtime number.
- **The cards never sit on a modal's action row (review fix).** The dock's box ignores the pointer, but its cards, its "+N more" and its phone pill take clicks, and above every modal they landed on the modal's own controls. Chromium, the real `MetadataStagingModal` with 40 staged files, "Upload All" pressed and 6 uploads reported (the reviewer's harness, rebuilt against this branch): `elementFromPoint` at the centre / right / left of the primary button hit it at none of the three points at 1280×800, 1366×768 and 1440×900, and "Stop upload" was partly covered; on phones (360, 390, 414 wide) the summary pill sat on "Upload All". Now a modal declares its action row with `useDockAvoid(ref, open)` (`components/ui/CornerDock.tsx`). The dock measures its own cards, and whenever, while it is raised, they would overlap a declared row where they sit, it sits above the row instead (`dockAvoidOffset`: the lowest card 8px above the row; a row the cards would not touch — a centred dialog's footer left of them, a phone dialog's mid-screen footer — moves nothing; a row with no room above it leaves the dock where it is). The row is re-measured on resize, on any scroll, when it or its panel changes size and when an entrance animation ends. Declared: the footers of `MetadataStagingModal`, `AssetPhotoUploader` and `CustomizeNodeModal`, and the shared `ModalFooter` (`components/ui/Modal.tsx`), so every `appConfirm` / `appAlert` / `appPrompt` too: a dialog opened over a raising modal. `ModalFooter` declares but does not raise. After, the same probe: all three points hit both buttons at 1280×800, 1366×768, 1440×900 and 1920×1080, and at 360×740, 390×844 and 414×896. At 1366×768 the four cards sit at 446–662, above the footer at 670, on top of the modal and in view. At 390×844 the pill sits at 746–776, above the footer at 784. Re-run after the second review fix, against this branch: both buttons are hit at all three points at the same seven sizes. At 1280×800 the four cards are on top of the modal, at 476–692, above the footer at 700.

Inventory of what was replaced: the dock's 300 (dock and fallback; now 290 at rest, the fallback included); BackupIndicator's 300 (it now lives in the dock); UndoToastHost's 280 and BackToGraphChip's 40 (now the centre slots' layers, same values); and the three modals' 300 / 400 / 510 (same values).

What moved, in full: only the dock, and since the third review fix only while an upload-starting modal is open, has started an upload, and the dock reports one. It used to be z-300 and first in `<main>`, so it painted under every overlay at 300 or above (a z-300 overlay later in the document won the tie). At rest, at 290, it still does: there is no tie to break, and nothing else sits between 280 and 300. The first review fix put it at 750 for good, so it painted over every overlay from the 300 band to 700:
- the modals and panels — BulkEditModal, CollectionModal, ShareLinkModal and WorkflowDiagramModal (300), LibraryOrderModal (320), the shared `Modal`'s default (400), CsvImportModal, CreateColumnWizard, AssetCsvImportModal, RelationshipGraph and the admin pages' dialogs (400), FileReferenceModal (500), the policy and review modals and DocumentLinkPicker (520), AreaKnowledgePanel, UnitOpsPanels and the app dialog host (700);
- the dropdowns, menus and tooltips in that band — ThemeMenu, StatusControl and ProgressControl (300 / 310), HelpTooltip, MentionableTextarea's list, ScheduleCalendarTileView and ExecutionGuide (300), ViewSelector and AssetPhotoPopover (400);
- GlobalCommandPalette (600), SignatureCeremony (500) and AssetPhotoCarousel (500).

Now it paints over them only while raised. In that state, the raising modal's full-screen backdrop already covers every overlay beneath it. What can stack above the raising modal is the app dialog host (700, whose `ModalFooter` declares its row) and, if opened there, the command palette (600, top-centre, no bottom-right row). No other overlay's number changed, and no two of them changed order.

After: the upload card is on top under all three modals. Tests: `lib/__tests__/cornerDock.test.ts` "lib/zLayers — the scale":
- every z literal in app/, components/, hooks/ and lib/ is listed in `Z_SCALE`, so a new layer is decided in the module (the scan reads a stylesheet's `z-index:` too, since the review fix);
- raised, the dock is strictly above everything but 800 and 9999; at rest nothing in use or listed lies between the undo toasts (280) and 300 but the dock, and no literal ties with it (fourth review fix: the earlier assertions here could not fail; the new ones fail with a 295 listed and used once);
- the old values and the relative order are pinned;
- the modals read from the module;
- the old fixed corners are gone.

And "STACK-10 — raised, the dock keeps clear of an open modal's action row":
- `dockAvoidOffset`: the laptop footer, the phone sheet, rows it must not move for, the bottom bar as the floor, two rows;
- a raising modal's `ModalFooter` lifts the dock while six upload cards would cover it, and releases it on close;
- a dialog on its own leaves the dock at rest, under it and not lifted;
- a phone sheet's footer stays under the pill;
- the raises and the four declarations are pinned in the source.

"STACK-10 / STACK-14 — at rest the dock is under every overlay; an upload modal raises it" covers the two bands and the rule that a raiser declares its row.

**Third review fix: raised only while it reports the upload.** The N7 third review probed the real `MetadataStagingModal` in Chromium with 40 staged files, the grid scrolled to its end and "Upload All" not pressed. A running backup card or one toast was lifted onto the grid: the last row's "Remove from batch", "Duplicate row" and Status select were hit at 0 of 3 points at 1280×800, 1366×768 and 1440×900 (3 of 3 on `b9cdfdc`). The minimized backup pill still covered Remove at 1280 and 1366. The dock had been raised on open, with no upload at all. Now:
- **The modals raise only once they have started an upload.** `MetadataStagingModal` calls `useDockRaise(isOpen && startedUpload)`, latched when "Upload All" starts a run and cleared by every open. `AssetPhotoUploader` calls `useDockRaise(isOpen && (submitting || pending.some((p) => p.status !== "pending")))`. `CustomizeNodeModal` calls `useDockRaise(open && startedUpload)`, latched when a cover or background upload starts. A scan test refuses `useDockRaise(open)`, `useDockRaise(isOpen)` and `useDockRaise(true)` in any caller.
- **The dock rises only while it reports an upload.** `raisedSnapshot()` (`components/ui/CornerDock.tsx`) requires a registered raise and a `raisable` entry with a card. `UploadIndicator` registers its cards with `useDockAllowances(…, { raisable: true })`. Once the run's cards have cleared (a "Done" 2.5 s after it finished; a failure 7 s after it shows — since the fourth review fix, while raised, 7 s after its event; or on Dismiss), the dock drops back under the modal, even while the modal stays open with the run's failures. An upload started elsewhere does not raise it while the modal has started none.
- **Raised, only the upload cards hold places.** `allocateDock(entries, cap, raised)` gives the places to the `raisable` entries alone. The backup card, the indexing card and toasts wait behind "+N more", as they waited under the modal before; a waiting toast's clock waits too. The person can still expand "+N more"; the expansion's fold-back now reads the capped allocation (`cappedHidden`) rather than the total, so a raised expansion is not folded back while the cap would hide something. On a phone the raised pill names the upload, not a toast waiting behind it.

Chromium (`/opt/pw-browsers/chromium-1194`), the review's probe copied to `scratchpad/n7fix3-harness` and rebuilt against this branch, run unchanged: with a running backup, after minimizing it, and with one toast, the last row's Remove, Duplicate and Status are hit at 3 of 3 points at 1280×800, 1366×768, 1440×900 and 1920×1080, with the dock at 290 and not raised. That matches the review's run on `b9cdfdc`. An upload mode added to the same probe (backup and toast up, then "Upload All" with 6 uploads reported) gave these results:
- **During the run.** The dock is at 750, with the 4 upload cards and "+4 more"; the backup and the toast are not in it. "Uploading…" and "Stop upload" are hit at 3 of 3 points at the four laptop sizes and at 360×740, 390×844 and 414×896. The last row's Remove, Duplicate and Status are hit at 0 of 3 points at 1280 and 1366, and at 1440 only Status at 1 of 3 (residual below); at 1920 all are hit at 3 of 3.
- **After the 6 "Done" cards clear.** The dock is back at 290 with the backup and the toast, and the last row's controls are hit at 3 of 3 points at every laptop size. On the phones the last row's controls are off-screen to the right of the grid's horizontal scroll at every step, so the phone rows say nothing about the dock.

Tests (`lib/__tests__/cornerDock.test.ts`):
- `allocateDock` raised: 6 uploads, a backup, an indexing card and 2 toasts give the uploads all four places, with 6 hidden, 2 of them messages.
- A modal that started an upload raises the dock only while an upload card shows: no card yet, at rest; one card, raised; the card cleared with the modal still open, at rest; a new card, raised; closed, at rest.
- **The review's case, rendered.** The real `MetadataStagingModal` with 40 files, the real `BackupIndicator` running and a toast, before "Upload All":
  - the dock is at `Z.dock`, not raised and not lifted, with both cards in it;
  - the last row's Remove, Duplicate and Status sit in the modal's layer (300), above the dock;
  - minimizing the backup changes nothing, and an upload started elsewhere leaves the dock at rest.

  After "Upload All": the dock is raised with four upload cards and "+4 more", and no backup or toast card. After a failed run, the modal stays open and the failed card reports over it until it clears; then the dock is at rest again with the backup and the toast.
- The photo uploader: a staged photo and a running backup leave the dock under it, and the photo's remove X sits above the dock. "Upload" raises the dock with the upload card only.
- Raised, the "+N more" expansion holds while the cap would hide something.
- On a phone, the raised pill names "Uploading 2 files" over a waiting error toast.

Each was checked to fail with its fix reverted:
- the caller's raise on open;
- `raisedSnapshot` as `raises.size > 0`;
- the raised allocation;
- the fold-back rule on the total;
- the pill's filter.

**Fourth review fix: a failed run clears in one window; raised, no doorway and no rail.** The N7 fourth review probed the real `MetadataStagingModal` in Chromium with 40 files and all 12 transfers failing. A failure's clock started only once it held one of the four places, so the raised dock's failures cleared four at a time, 7 s per batch: the dock stayed at 750 from t = 0 to t = 20 s ("+8 more", then "+4 more"), and the last row's Remove and Status were hit at 0 of 3 points the whole time at 1280×800 and 1366×768. N failures kept the last rows covered for ceil(N/4) × 7 s, 70 s for 40, which is the step after a failed run (remove or retry the failed rows). On `b9cdfdc` every failure cleared 7 s after its event. The same review found the raised dock's "+N more" offering "Notifications" for a waiting toast: the center opened at 241, under the 300 modal (invisible), and its 480px rail moved the cards from x 976–1264 to x 496–784 at 1280×800, over the middle of the grid, until the hidden center was closed. Now:
- **Raised, every failure counts as seen.** `useDockAllowances` also returns `raised`, and `UploadIndicator`'s clock effect starts every failure's clock at once while it is true, placed or not. A whole run's failures clear 7 s after the last one, as on `b9cdfdc`, and the dock drops back under the modal. The raising modal reports the outcome itself ("Uploaded n of m", the failed rows kept). At rest nothing changes: a failure behind the cap keeps its full 7 s for when it shows (`STACK-9`).
- **Raised, no doorway.** The "Notifications" button on "+N more" renders only at rest. Raised, the toasts wait behind "+N more" (still expandable) until the dock is back at rest.
- **Raised, no rail.** `railSnapshot()` returns 0 while the dock is raised. Every right-rail drawer (the inspector 60, history 70, the notification center 241) is under the raising modal's backdrop, so the raised dock stays at the edge whichever way the center was opened. At rest the rail rule is unchanged (`STACK-11`).

Tests (`lib/__tests__/cornerDock.test.ts`, "STACK-10 / STACK-14 — …"):
- "raised, a failed run's cards clear in one 7s window": the real `MetadataStagingModal` with 40 files, "Upload All", 12 transfers failing. Raised with four cards and "+8 more"; still raised at 6.5 s; at 7.5 s no card, the dock at `Z.dock`, and the last row's Remove and Status above it. It fails with the fix reverted (four failure cards are still up at 7.5 s).
- "at rest the cap still holds a failure's clock until it is seen": six failures with a non-raising modal open clear four, then two.
- "raised, the '+N more' offers no 'Notifications' doorway, and an open center's rail does not move the dock onto the modal": six toasts and six uploads under a raising modal with `occupiedRightPx` = 480. Raised: "+8 more", no "Notifications", the dock at the edge. At rest: the dock moves 480px left and the doorway opens the center. Each half fails with its own fix reverted.

**Done-when.**
- ✓ A documented z-index scale exists. The dock is portaled to document.body and given the top band while it reports an upload that one of these modals started: `MetadataStagingModal`, `AssetPhotoUploader` or `CustomizeNodeModal` is open and has started an upload, and an upload card shows. Then the dock is strictly above every modal, backdrop and dialog layer (`Z.dockRaised` = 750), with only the upload cards in its places.
  - Before the modal starts an upload, and once the run's cards have cleared, the dock keeps the old dock's place, under every overlay from 300 up, that modal included. The second review fix raised it whenever the modal was open, and the third review showed a backup card or a toast covering the staging grid's last rows before any upload. The always-on top band of the first review fix covered undeclared overlays' controls with cards that cannot be dismissed (`STACK-14`).
  - This is the reading of "strictly above every modal/backdrop layer" that `DEC-44 (N7)` item 4 records for the integrator to ratify.
- ✓ MetadataStagingModal, AssetPhotoUploader (510) and CustomizeNodeModal (400) are each verified to render below the dock while an upload card shows.
- ✓ Manual pass in Chromium: the failed card's name, "Failed" and its reason read clearly over the blurred staging overlay (harness screenshot); after the review fix the cards read over the wizard while its "Upload All" and "Stop upload" stay reachable at laptop and phone widths.

**Scope / residual.**
- **The scale lists, it does not own.** Only the layers this contract touches read from the module. `Z_SCALE` lists every other number and the scan test refuses an unlisted one, but ~150 call sites keep their own literal class (DEC-31).
- **Over a raising modal, while it reports the upload.** Above the action row, the upload cards and "+N more" cover the right-hand end of a tall upload modal's body. On the wizard at 1280, 1366 and 1440 wide, that is the last rows' Remove, Duplicate and Status (Chromium, above), until the run's cards clear. A running upload card has no Dismiss. A "Done" or "Stopped" card clears 2.5 s after it finished. While the dock is raised, every failure clears 7 s after its event, placed or not (fourth review fix; before it, a failure's clock waited for one of the four places, and N failures kept the cards up for ceil(N/4) × 7 s: 21 s for 12, 70 s for 40). Any finished card also clears on Dismiss. So the cards are gone at most 7 s after the run's last transfer ends. "Stop upload", in the declared row, is always reachable. No backup card, indexing card or toast is lifted: they wait behind "+N more" unless the person expands it. This is the part of `STACK-14`'s class that remains by design.
- **At rest.** A card shown while any other overlay at 300 or above is open sits under it, readable once the overlay closes, as before N7.
- `STACK-14`, the first fix's regression, is removed by the same change. It stays OPEN (Partial) on its done-when as written (see it).
- `components/ui/Modal.tsx` is outside the plan's file list (lines in `ModalFooter`).
- No migration.

---

<a id="stack-11"></a>

## STACK-11 · Three full-height right-edge drawers own the bottom-right corner; the dock floats on top of all of them with no offset

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/documents/InspectorDrawer.tsx:42`, `components/documents/HistoryDrawer.tsx:161`, `components/notifications/NotificationCenter.tsx:102`, `components/ui/CornerDock.tsx:25`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed exactly; there is no bottom offset, right offset, or drawer-aware repositioning anywhere in CornerDock.tsx. Nothing in the drawers raises above 241, so the dock always wins.

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

**Resolution (2026-10-01, notifications Round G).** Reproduced: Observed in Chromium (Playwright, `/opt/pw-browsers/chromium-1194`) against the real components of `b9cdfdc` and of `fleet/N7-corner`, rendered by a component harness (a vite build of the actual files; only the database, auth, the storage transport and `next/navigation` stubbed — the full page needs Supabase). With the real `InspectorDrawer` open (720px wide at a 1280px viewport), the base toast lay entirely over the drawer (17,920 px²) and so did the upload card (13,824). Now:
- **The signal.** `useOccupyRightRail(ref, open)` in `components/ui/CornerDock.tsx`: a drawer declares its measured width while open (ResizeObserver plus resize).
- **The rule.** The dock's right offset is the widest open rail when the viewport leaves `DOCK_MIN_ROOM_PX` (340) beside it. Otherwise it stays 0: at phone width the dock stays at the edge, collapsed to its pill.
- **Who declares it.** `InspectorDrawer` and `HistoryDrawer` call the hook. The notification center (`components/notifications/**`, N2's this round) is passed by the layout instead: `ProtectedContent` reads `isOpen` from `useNotificationCenter` and passes `occupiedRightPx = NOTIFICATION_CENTER_RAIL_PX` (480; a test pins it to `NotificationCenter.tsx`'s `w-[480px]`).

After: the toast lies over the drawer by 0 px², and so does the upload card; the toast sits at x 224–544 and the drawer starts at 560. Tests: `lib/__tests__/cornerDock.test.ts` "STACK-11 — …" (the offset rule, a drawer's width moving the dock and closing it putting it back, the notification center's rail, both drawers declaring it).

**Done-when.**
- ✓ A shared "right rail occupied" signal shifts the dock left by the open drawer's width.
- ✓ Open drawer plus an active upload is verified in Chromium to leave both readable.

**Scope / residual.** The notification center's width is a constant in the dock module, tied to that file's class by a test; the center declaring the rail itself is a one-line call for its owner (N2 / N3). While the dock is raised over an upload modal (`STACK-10`) it ignores every rail: each of these drawers is under that modal's backdrop (N7 fourth review). No migration.

---

<a id="stack-12"></a>

## STACK-12 · Toasts are the only channel for many job outcomes and self-destruct in 5 seconds with no history

- **Severity:** MEDIUM
- **Status:** REFUTED
- **Verification:** CONFIRMED
- **Locations:** `components/providers/ToastProvider.tsx:40-49`, `components/knowledge/SemanticIndexPanel.tsx:81-102`, `components/providers/NotificationListener.tsx:64-69`
- **Independently verified:** ⛔ **REFUTED** by a second independent adversarial pass — do not work this finding. Kept in place with the reason rather than deleted (`DEC-41`). The headline ("toasts are the ONLY channel", "has left no trace anywhere in the UI") is false for all three cited sites — each toast has a durable companion surface. The specific scenario is doubly wrong: the semantic build is client-driven and requires the panel to stay mounted ("Leave this page open and it will finish", line 236), so returning to that tab shows the rose buildNote box. What survives is only the narrow, uncited fact that ToastProvider itself keeps no history.

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
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/storage.ts:28-40`, `lib/storage.ts:378-431`, `components/providers/UploadIndicator.tsx:19-37`, `lib/clientBackup.ts:211-214`, `components/system/UpdatePill.tsx:41-43`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Fully confirmed, and the asymmetry is the sharpest evidence: the backup path deliberately installs `warnUnload` with the message "A backup is still running — leaving this tab will stop it", while the multipart upload path — the one the finding is about — installs nothing. UpdatePill.tsx:41-42 `onClick={() => window.location.reload()}` is a one-tap, unguarded path into that loss.

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

**Resolution (2026-10-01, notifications Round G).** Reproduced on `b9cdfdc`: `beforeunload` appears only in `lib/clientBackup.ts` and `app/(protected)/plot-plans/[id]/page.tsx`; a probe test on the base tree registers no guard for an upload in flight. Now `lib/uploadActivity.ts` registers a `beforeunload` guard (modelled on clientBackup's `warnUnload`) while anything is in flight. Two counters feed it:
- `inFlight`: a batch a page declared with `beginUpload` (the library page).
- `transfers` (new): every `uploadToPath` call holds one through `beginTransfer` / `endTransfer` in `lib/storage.ts`, wherever the upload started.

Only `inFlight` parks indexing, as before. `hasUploadsInFlight()` (no cooldown) and `releaseUploadUnloadGuard()` are exported. `components/system/UpdatePill.tsx` asks before loading the update while an upload is in flight (`confirmReloadDuringUploads` → `appConfirm` "An upload is still running" / "Reload anyway" / "Wait"). On "Reload anyway" it releases the guard, so the browser does not ask a second time. The pill checks `hasUploadsInFlight()` rather than `isUploading()`: the latter adds a 20-second indexing cooldown during which nothing can be lost. Tests: `lib/__tests__/cornerJobs.test.ts` "STACK-13 — …" (the guard installs and drains with both counters; `uploadToPath` holds a transfer for exactly the call; release; UpdatePill asks only while uploading). `lib/__tests__/sw.test.ts` (UpdatePill still goes through `loadLatestBuild`) passes.

**Done-when.**
- ✓ A beforeunload guard is registered while uploadActivity's `inFlight > 0`, and while any transfer is on the wire.
- ✓ UpdatePill's reload is warned while an upload is in flight.

**Sign-out is not held by it (N7 fourth review).** The guard also held RoleContext's SIGNED_OUT redirect (`location.replace("/")`, after a sign-out button, a token that could not be refreshed, or a sign-out in another tab): during any upload the browser asked "Leave site?", and "Stay" left the previous account's screen up in a tab with no session. Before N7 only a running backup could hold that redirect. Now `lib/uploadActivity.ts` subscribes once to `supabase.auth.onAuthStateChange` when it loads in a browser (before RoleContext mounts and adds its listener) and calls `releaseUploadUnloadGuard()` on SIGNED_OUT; the guard re-arms once the in-flight work drains. Test: `lib/__tests__/cornerJobs.test.ts` "sign-out releases it…": the listener is registered at import; with a transfer counted, a cancelable `beforeunload` is prevented, still after TOKEN_REFRESHED, and no longer after SIGNED_OUT (the transfer still counted); drained, a new transfer arms it again. It fails with the release removed.

**Scope / residual.** The service worker's own "Update available — tap to refresh" button (ServiceWorkerManager, PKG-1's) is covered by the beforeunload guard itself, not by a dialog of its own. lib/clientBackup's own guard (a running backup) still holds the sign-out redirect, as before N7; that file is not this package's. No migration.

---

<a id="stack-14"></a>

## STACK-14 · An overlay that does not declare its action row can still have a dock card over its bottom-right corner

- **Severity:** MEDIUM (first recorded as LOW; corrected by N7's second review fix)
- **Status:** OPEN
- **Assigned:** notifications Round G N7 CORNER. Opened 2026-10-01 by N7's first review fix as the DEC-31 remainder of `STACK-10`. The N7 review the same day showed it was a regression that fix introduced, not a remainder. N7's second and third review fixes removed the regression; the done-when as written is not met (Partial below).
- **Verification:** CONFIRMED (Chromium; the N7 review's harness against the branch at `77ae466` and against `b9cdfdc`)
- **Locations:** `components/ui/CornerDock.tsx` at `77ae466` (the dock at `Z.dock` = 750 always; `useDockAvoid` opt-in). `app/(protected)/admin/assets/page.tsx:1971-2268`, the asset editor: a right-anchored z-400 drawer (`ml-auto max-w-xl h-dvh`) with Save / "Create & add photos" at its bottom-right, declaring neither a row nor a rail. `components/providers/UploadIndicator.tsx:113`: a running upload card has no Dismiss and no minimize. About 28 hand-rolled `fixed inset-0` overlays from 300 to 700, and every page that composes `Modal` with its own footer (`app/(protected)/companies/page.tsx`, `companies/[id]/page.tsx`, `projects/[id]/page.tsx`, `components/projects/ProjectWizard.tsx`).
- **Independently verified:** ✓ by the N7 review's adversarial pass. Chromium (`/opt/pw-browsers/chromium-1194`): the real ToastProvider, CornerDock and UploadIndicator, plus a replica of the asset editor carrying its classes.

**Mechanism.** `STACK-10`'s first review fix put the corner dock above every overlay for good (`Z.dock` = 750), and its cards take clicks. It kept clear of an overlay's action row only when the overlay declared it: the three upload-starting modals and the shared `ModalFooter` (whose only users are DialogProvider and plot-plans). Nothing else declared a row. When a toast or a job card showed while such an overlay was open, and its action row reached the dock's lane (the right-most ~360px), the card sat over that row. This record first said the card stays "until it expires or is dismissed". That understates it:
- A running upload card cannot be dismissed or minimized.
- Running knowledge-indexing and backup cards can only be minimized.

So the control stayed blocked for the length of the job. Before `STACK-10` the dock sat under all of these overlays (z-300, first in `<main>`).

**Failure scenario.** An admin opens the asset editor (admin/assets) and clicks "Create & add photos". They start photo uploads, close the uploader and return to the drawer. The running upload card sits exactly on Save at 1280×800, 1440×900 and 1920×1080, and with no Dismiss, Save stays covered until the transfer ends. A realtime notification toast blocks it for 5 seconds on every arrival. A page composing the shared `Modal` (size xl) with its own footer row fared no better: running upload cards fully covered its "Save changes" at 1024×768, and covered 2 of 3 points at 1280×800. On `b9cdfdc` every one of these controls was reachable. (The scenario first recorded here, BulkEditModal at 1280 wide, does not overlap: `max-w-lg` spans 384–896 and the dock's lane starts at about 944.)

**Done when.**

- [ ] Every overlay from the 300 band to 700 whose action row can reach the dock's lane declares it: `useDockAvoid` on its footer, or `ModalFooter`.
- [ ] A scan test refuses a new full-screen overlay at z ≥ 300 that does neither, with an explicit list for overlays that have no action row (a carousel, a palette).

**Partial (2026-10-01, notifications Round G).** Reproduced: the N7 review's Chromium probe (above), base build against branch build. On `77ae466` the editor's Save was covered at all three sample points at each of the three sizes, by one 5-second toast and by one running upload card (0 Dismiss buttons); on `b9cdfdc` it was reachable. The fix makes keeping clear the default. It restores the old layering everywhere and raises the dock only where `STACK-10` needs it (decision: `DEC-44 (N7)` item 4):
- **`lib/zLayers.ts`.** Two bands. `Z.dock` = 290 is the dock at rest: above the drawers (60 / 70), the notification center (241) and the undo toasts (280), and below every overlay from 300 up — the old dock's place. `Z.dockRaised` = 750.
- **`components/ui/CornerDock.tsx`.** `useDockRaise(active)` registers a raise. The dock sits at `Z.dockRaised` (`data-dock-raised`) while a raise is registered and an upload card shows (a `raisable` entry with a card; third review fix), and at `Z.dock` otherwise. Raised, only the upload cards hold places. The action-row avoidance (`useDockAvoid`, `dockAvoidOffset`) applies only while the dock is raised; at rest the dock is under every declared overlay already.
- **The three upload-starting modals.** `MetadataStagingModal`, `AssetPhotoUploader` and `CustomizeNodeModal` raise the dock once they have started an upload, beside their `useDockAvoid`. The second review fix had them raise on open, `useDockRaise(open)`, and the third review showed that lifted a backup card or a toast onto the staging grid's last rows before any upload (`STACK-10`, third review fix). `ModalFooter` keeps declaring its row (a dialog opened over a raising modal) but does not raise.

After, the same harness rebuilt against this branch:
- **The asset editor.** Save is reachable at all three points at 1280×800, 1440×900 and 1920×1080, with a toast showing and with a running upload card.
- **`Modal` with its own footer.** "Save changes" is reachable at 1024×768, 1280×800 and 1366×768.
- **The raising path still holds.** With the real `MetadataStagingModal` (40 files, 6 uploads), "Upload All" / "Uploading…" and "Stop upload" are reachable at all three points at 1280×800, 1366×768, 1440×900 and 1920×1080, and at 360×740, 390×844 and 414×896. Its four cards sit on top of it, in view, above its footer.

Tests: `lib/__tests__/cornerDock.test.ts`.
- "STACK-10 / STACK-14 — at rest the dock is under every overlay; an upload modal raises it":
  - with a running upload card, the asset editor's classes sit above the resting dock, and the probe's classes are pinned to the page source;
  - a modal that started an upload lifts the dock to `Z.dockRaised` only while an upload card shows, and closing it drops the dock back (third review fix: before any card, and once the cards clear, the dock stays at rest);
  - every `useDockRaise` caller also calls `useDockAvoid` and never raises on `open` alone, and the three callers are named;
  - the third review's case, rendered: the staging wizard before "Upload All", with a running backup and a toast, keeps the last row's controls above the dock (`STACK-10`).
- "a dialog on its own (appConfirm's ModalFooter, no upload modal open) leaves the dock at rest, under it — not lifted".
- The z-scale test "at rest the dock is under every overlay from the 300 band up and over everything below it — the old dock's place". Since the N7 fourth review it asserts that nothing in use or listed in `Z_SCALE` lies between the undo toasts (280) and 300 except the dock; the earlier assertions were tautologies and could not fail. Checked to fail with a 295 listed and used once.

The three rendered tests (the asset editor, the raise and drop, the dialog on its own) were checked to fail with the dock forced to 750 for good.

**Done-when.**
- NOT met as written. No overlay from 300 to 700 declares its action row beyond the three upload-starting modals and `ModalFooter`. The change makes the item unnecessary at rest rather than meeting it: at rest the dock is under every overlay from 300 up. The dock rises only over an upload-starting modal that has started an upload, and only while it reports it. Above that modal sit only its own row (declared) and what can stack over it: the app dialogs, which declare theirs through `ModalFooter`.
- NOT met as written. No scan test refuses an undeclared full-screen overlay at z ≥ 300. The scan tests enforce a different rule:
  - a caller of `useDockRaise` must also call `useDockAvoid`, and must never raise on `open` alone;
  - the z-scale test refuses any value, in use or listed, between the undo toasts (280) and 300 other than the dock, so every overlay from 300 up sits above the resting dock (N7 fourth review: as first written this assertion could not fail).

Remaining step: the integrator ratifies `DEC-44 (N7)` item 4 as superseding these two items (the dock rests under every overlay and rises only over an upload-starting modal while it reports that modal's upload), and closes this finding with the residual below. Otherwise a later package adds the declarations and the scan test as written.

**Scope / residual.**
- **A card over an overlay's controls still happens in one place: the raising modal's own body, while the dock reports its upload.** Above the declared action row, the upload cards and "+N more" cover the right end of the body. On the bulk-upload wizard at 1280, 1366 and 1440 wide, that is the last rows' Remove, Duplicate and Status (Chromium; `STACK-10`'s third review fix). It lasts until the run's cards clear: a running card cannot be dismissed, a "Done" or "Stopped" card clears 2.5 s after it finished, and while the dock is raised every failure clears 7 s after its event, so the cards are gone at most 7 s after the run's last transfer ends. Before the N7 fourth review fix a raised failure's clock waited for one of the four places, and N failures kept the cards up for ceil(N/4) × 7 s (21 s for 12 in Chromium; 70 s for 40). No backup card, indexing card or toast is lifted there, and the raised "+N more" offers no doorway to the notification center (it would open under the modal).
- **An undeclared overlay over a raised modal.** While the dock is raised, an overlay opened over the modal that declares no row would sit under the cards. Today only the command palette can be opened there (600, top-centre, no bottom-right row).
- No migration.

---
