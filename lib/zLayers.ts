// lib/zLayers.ts — every overlay layer number in one module.
//
// notifications Round G, N7 CORNER (STACK-10, TAX-14). The app stacks its
// overlays on a scale of bands that grew one class at a time. Two things went
// wrong on that scale: the corner dock sat at z-300, the same band as the
// title-block wizard that starts a bulk upload (and below the photo uploader
// at 510 and the cover-image modal at 400), so the modal that starts an
// upload painted over the cards reporting it; and nothing said which number
// meant what, so the next overlay picked one by eye.
//
// The rule now:
//   - `Z_SCALE` lists every z-index value the app's classes and styles use.
//     `lib/__tests__/cornerDock.test.ts` scans app/, components/, hooks/ and
//     lib/ and fails on a value that is not listed here, so a new layer is a
//     decision made in this file, not a number picked in a component.
//   - The named layers in `Z` are the ones whose ORDER matters to the corner
//     contract. Their values are the values those overlays already had — this
//     module renumbers nothing except the dock, which moves to a band of its
//     own strictly above every modal, backdrop and dialog (750) and below the
//     pointer-following hover preview (800) and the print-only cover (9999),
//     as it was before.
//   - A component that reads its layer from here uses `style={{ zIndex }}`,
//     because Tailwind cannot generate a class from a runtime number.

export const Z = {
  /** Page chrome floating over content: the "Back to graph" chip. Below
   *  every drawer, sheet and modal backdrop (it used to be `z-40`). */
  pageChip: 40,
  /** The projects schedule's undo toasts (bottom-centre). Above drawers and
   *  the notification center, below the upload modals (was `z-[280]`). */
  undoToast: 280,
  /** The title-block wizard that starts a bulk upload — MetadataStagingModal
   *  (was `z-[300]`). */
  metadataStagingModal: 300,
  /** The folder / library cover customiser, which uploads a cover image —
   *  CustomizeNodeModal (was `z-[400]`). */
  customizeNodeModal: 400,
  /** The asset photo uploader — AssetPhotoUploader (was `z-[510]`). */
  assetPhotoUploader: 510,
  /** The app's confirm / alert / prompt host (DialogProvider). The highest
   *  modal band. */
  dialog: 700,
  /** The corner dock (toasts, uploads, indexing, backup). Strictly above
   *  every modal/backdrop/dialog band, so the cards reporting an upload stay
   *  readable over the modal that started it (STACK-10). */
  dock: 750,
  /** The document hover preview follows the pointer and stays above the
   *  dock, as it was (800 > the old dock's 300). */
  hoverPreview: 800,
  /** Print-only full-page cover. */
  print: 9999,
} as const;

export type ZLayer = keyof typeof Z;

/** Every z-index value in use (Tailwind `z-N` / `z-[N]` classes, inline
 *  `zIndex`), ascending. The inventory of 2026-10-01 plus the dock's band. */
export const Z_SCALE: readonly number[] = [
  0, 5, 10, 20, 30, 40, 50, 55, 60, 70, 80, 85, 90, 91, 95,
  100, 110, 120, 150, 160, 180, 190,
  200, 210, 220, 230, 240, 241, 260, 280,
  300, 310, 320, 400, 500, 510, 520, 600, 700,
  Z.dock, 800, 9999,
];
