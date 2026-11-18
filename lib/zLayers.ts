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
//     decision made in this file, not a number picked in a component. (Until
//     notifications N13 the module listed the numbers without owning them;
//     since N13 every call site reads it — below.)
//   - The named layers in `Z` include the ones whose ORDER matters to the
//     corner contract. Their values are the values those overlays already had — this
//     module renumbers nothing except the dock, which has two bands. At rest
//     (`Z.dock`, 290) it sits where it always did: over the page, its drawers
//     and the undo toasts, and under every overlay from the 300 band up — so
//     no modal, drawer or dialog gets a card over its own buttons. While a
//     modal that starts an upload is open (`useDockRaise`), it rises to
//     `Z.dockRaised` (750): strictly above every modal, backdrop and dialog,
//     and below the pointer-following hover preview (800) and the print-only
//     cover (9999), as it was before.
//   - A component that reads its layer from here uses `style={{ zIndex }}`
//     (`Z`), or the layer's class (`ZC`), because Tailwind cannot generate a
//     class from a runtime number: every class Tailwind must emit is written
//     out whole, once, in `ZC` below, where Tailwind's source scan finds it.
//
// notifications N13 LAYERS SWEEP (TAX-14 done-when 4, STACK-14): the module
// now OWNS every layer number. Every z-index in app/, components/, hooks/
// and lib/ reads it — `Z.<layer>` for a style or a prop, `ZC.<layer>` for a
// class — and `lib/__tests__/zLayersOwnership.test.ts` refuses a z literal
// anywhere else (a class, an inline style, a `zIndex` prop), and a
// stylesheet's `z-index:` unless `STYLESHEET_LAYERS` names it. Nothing was
// renumbered: each layer keeps the number its call sites had (the sweep moved
// where the number comes from, not the number — DEC-85 item 4). A layer that
// several unrelated overlays happen to share is ONE band here, named for what
// sits in it; a new overlay picks the band it must sit in, or a new band is
// decided here.

export const Z = {
  // ── In-box stacking: within a positioned parent, never across the page ──
  /** Behind its box's content: the page backgrounds (`-z-10`). */
  underlay: -10,
  /** The flow layer, made explicit: a gradient behind a hero, an iframe
   *  under the overlay that marks it up. */
  base: 0,
  /** A hair above its siblings: a dashboard tile's drag ghost, a card
   *  menu's click-catcher. */
  lift: 5,
  /** Above its siblings in its own box: sticky table heads, a card's corner
   *  control, a graph's floating panels, a timeline's node dot. */
  raised: 10,
  /** Above `raised` in the same box: a sticky head over a sticky column, a
   *  widget's handles, the viewer's loading and error covers. */
  raisedHigher: 20,
  /** The top of a box's own stack: the top bar, the staging tray, an inline
   *  dropdown. */
  raisedTop: 30,

  // ── The page tier: over the page, under every drawer ──
  /** Page chrome floating over content: the "Back to graph" chip. Below
   *  every drawer, sheet and modal backdrop (it used to be `z-40`). */
  pageChip: 40,
  /** The same band for the page's own floating controls: an in-page
   *  menu's click-catcher, the viewers' floating toolbars, the bulk bar. */
  pageFloat: 40,
  /** Page-level dropdowns and popovers, the viewers' top bars, and the
   *  older pages' own full-screen modals (`z-50`). */
  pagePopover: 50,

  // ── Drawers and the modals opened from them ──
  /** The inspector drawer's backdrop. */
  inspectorBackdrop: 55,
  /** The right drawers (inspector, history backdrop), the phone sidebar's
   *  backdrop, and the modals that sit with them. */
  drawer: 60,
  /** The history drawer's panel, the phone sidebar fly-out, the column
   *  manager. */
  drawerPanel: 70,
  /** A modal opened from a drawer (move). */
  drawerModal: 80,
  /** The multi-document viewer and the library's lasso box. */
  viewerOverlay: 85,
  /** The library page's modals, the metadata editor, the permission drawer,
   *  the bell's dropdown. */
  libraryModal: 90,
  /** The document context menu (just over `libraryModal`). */
  contextMenu: 91,
  /** A library modal opened over another. */
  libraryModalOver: 95,
  /** The general modal band: request, checkout and set modals, the
   *  full-screen viewer, the update prompt. */
  modal: 100,
  /** A dialog over the full-screen viewer. */
  viewerDialog: 110,
  /** A modal over the general band: the multi-viewer's dialog, the project
   *  editor, the library command palette. */
  modalRaised: 120,
  /** The packages modal and the task detail panel. */
  taskPanel: 150,
  /** The schedule calendar's overflow and sub-popovers. */
  calendarPopover: 160,
  /** The modify-document router. */
  lifecycleRouter: 180,
  /** The schedule tab's menu click-catcher. */
  scheduleMenuCatcher: 190,
  /** The workflow modal band: lifecycle wizards, rev-up, import and admin
   *  modals, the archive viewers, the redline editor. */
  workflowModal: 200,
  /** A confirmation over a workflow modal (supersede, archive, revert, the
   *  engineer picker). */
  confirmOverModal: 210,
  /** The revision compare modal. */
  compareModal: 220,
  /** The version history dialog. */
  versionDialog: 230,
  /** The notification center's backdrop (at rest). */
  centerBackdrop: 240,
  /** The notification center's panel (at rest). */
  centerPanel: 241,
  /** The schedule's move preview sheet. */
  previewSheet: 260,
  /** The projects schedule's undo toasts (bottom-centre). Above drawers and
   *  the notification center, below the upload modals (was `z-[280]`). */
  undoToast: 280,
  /** The corner dock at rest (toasts, uploads, indexing, backup). Above the
   *  page, its drawers (60 / 70), the notification center (241) and the undo
   *  toasts (280); below every overlay from the 300 band up. That is where
   *  the old dock sat: `z-[300]` first in `<main>`, so every 300-band overlay
   *  after it, and every one above 300, painted over it (STACK-10's review:
   *  above them, a card covered an undeclared overlay's Save). */
  dock: 290,

  // ── The overlay tier: above the resting dock ──
  /** The title-block wizard that starts a bulk upload — MetadataStagingModal
   *  (was `z-[300]`). */
  metadataStagingModal: 300,
  /** The 300 band's other overlays: the share, bulk-edit, collection and
   *  workflow-diagram modals, the menus' click-catchers, the help tooltip. */
  overlay: 300,
  /** A popover over a 300-band click-catcher; a modal nested in one. */
  overlayPopover: 310,
  /** The library order modal. */
  overlayNested: 320,
  /** The folder / library cover customiser, which uploads a cover image —
   *  CustomizeNodeModal (was `z-[400]`). */
  customizeNodeModal: 400,
  /** The shared `Modal`'s default layer, and the overlays that sit with it:
   *  the asset editor drawer, the CSV imports, the view selector. */
  sharedModal: 400,
  /** The asset modals: the record modal, the photo carousel, the file
   *  reference, the signature ceremony. */
  assetModal: 500,
  /** The asset photo uploader — AssetPhotoUploader (was `z-[510]`). */
  assetPhotoUploader: 510,
  /** The document policy modals (review, acknowledgment, retention,
   *  recertification), the link picker, publish-new-document. */
  policyModal: 520,
  /** The global command palette. */
  commandPalette: 600,
  /** The app's confirm / alert / prompt host (DialogProvider), and the
   *  asset pickers that sit with it. The highest modal band. */
  dialog: 700,
  /** The corner dock while a modal that starts an upload is open
   *  (`useDockRaise`). Strictly above every modal/backdrop/dialog band, so
   *  the cards reporting an upload stay readable over the modal that started
   *  it (STACK-10); that modal declares its action row (`useDockAvoid`) and
   *  the dock keeps clear of it. */
  dockRaised: 750,
  /** The document hover preview follows the pointer and stays above the
   *  dock, as it was (800 > the old dock's 300). */
  hoverPreview: 800,
  /** Print-only full-page cover. */
  print: 9999,
} as const;

export type ZLayer = keyof typeof Z;

/** Each layer's Tailwind class, written out whole so Tailwind's source scan
 *  emits it (a class built from a number at runtime would never be
 *  generated). `lib/__tests__/zLayersOwnership.test.ts` pins every entry to
 *  its `Z` number — `z-N` on Tailwind's own scale (0–50), `z-[N]` above it,
 *  `-z-N` below zero — and checks the compiled stylesheet carries each one. */
export const ZC = {
  underlay: "-z-10",
  base: "z-0",
  lift: "z-[5]",
  raised: "z-10",
  raisedHigher: "z-20",
  raisedTop: "z-30",
  pageFloat: "z-40",
  pagePopover: "z-50",
  inspectorBackdrop: "z-[55]",
  drawer: "z-[60]",
  drawerPanel: "z-[70]",
  drawerModal: "z-[80]",
  viewerOverlay: "z-[85]",
  libraryModal: "z-[90]",
  contextMenu: "z-[91]",
  libraryModalOver: "z-[95]",
  modal: "z-[100]",
  viewerDialog: "z-[110]",
  modalRaised: "z-[120]",
  taskPanel: "z-[150]",
  calendarPopover: "z-[160]",
  lifecycleRouter: "z-[180]",
  scheduleMenuCatcher: "z-[190]",
  workflowModal: "z-[200]",
  confirmOverModal: "z-[210]",
  compareModal: "z-[220]",
  versionDialog: "z-[230]",
  centerBackdrop: "z-[240]",
  centerPanel: "z-[241]",
  previewSheet: "z-[260]",
  overlay: "z-[300]",
  overlayPopover: "z-[310]",
  overlayNested: "z-[320]",
  sharedModal: "z-[400]",
  assetModal: "z-[500]",
  policyModal: "z-[520]",
  commandPalette: "z-[600]",
  dialog: "z-[700]",
  hoverPreview: "z-[800]",
  print: "z-[9999]",
} as const satisfies Partial<Record<ZLayer, string>>;

/** A stylesheet cannot import this module, so a `z-index:` in one is named
 *  here and pinned to its layer by the ownership test: app/globals.css's
 *  print rule lifts every `fixed inset-0` overlay to the print layer. */
export const STYLESHEET_LAYERS: Readonly<Record<string, readonly ZLayer[]>> = {
  "app/globals.css": ["print"],
};

/** Every z-index value in use, ascending — derived from `Z`, so a layer is
 *  decided by naming it there. */
export const Z_SCALE: readonly number[] = [...new Set<number>(Object.values(Z))].sort((a, b) => a - b);
