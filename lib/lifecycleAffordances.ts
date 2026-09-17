// lib/lifecycleAffordances.ts
//
// OWN-19: the Inspector's "Manage & lifecycle" gates as ONE pure function, so
// the affordance model is testable behaviourally rather than by grepping JSX.
// Each gate names the authority the mutator and the database enforce for it:
//
//   canPublishEff  rev-up / revert / supersede / archive / split / merge /
//                  renumber — publish authority (controller, per-library
//                  publish grant, or the document's effective owner):
//                  authorizePublish + enforce_document_publish_guard.
//   canLifecycle   the lifecycle router + Supersede + Archive buttons. Same
//                  population as canPublishEff, spelled with the controller
//                  tier first so a reader sees the tiers.
//   canMove        Move — a controller act (/api/documents/move refuses
//                  everyone else).
//   canManage      Permissions drawer, owner reassignment, review policy —
//                  controller or effective owner (DEL-1 / DEC-6).
//   sectionOpen    the section renders when any of its acts is available.

export interface LifecycleAuthorityInput {
  /** Holds Admin or DocCtrl in the role COLLECTION (OWN-3). */
  isController: boolean;
  /** The document's effective owner (document → folder → library → team). */
  isOwner: boolean;
  /** Per-library publish authority from the host (controller or granted). */
  canPublish: boolean;
}

export interface LifecycleAffordances {
  canManage: boolean;
  canPublishEff: boolean;
  canLifecycle: boolean;
  canMove: boolean;
  sectionOpen: boolean;
}

export function lifecycleAffordances(a: LifecycleAuthorityInput): LifecycleAffordances {
  const canManage = a.isController || a.isOwner;
  const canPublishEff = a.canPublish || a.isOwner;
  const canLifecycle = a.isController || canPublishEff;
  return {
    canManage,
    canPublishEff,
    canLifecycle,
    canMove: a.isController,
    sectionOpen: canManage || canLifecycle,
  };
}
