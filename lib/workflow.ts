import { Role, RequestType, TicketStatus, Ticket } from "@/types/schema";
import { policyAllows, type CapabilityPolicy } from "@/lib/capabilityPolicy";

export interface WorkflowAction {
  label: string;
  action: string;
  variant: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link' | 'success' | 'warning';
  requiresFile?: boolean;
  requiresComment?: boolean;
  requiresEngineerPick?: boolean;   // UI Guard: open the engineer-picker modal first
  description?: string;
  /** GAP-2/DEC-12: set when separation-of-duties blocks this action for THIS
   *  actor. The action renders DISABLED with this explanation (a missing
   *  button is indistinguishable from a bug), and the server route refuses
   *  it with the same message. */
  disabledReason?: string;
}

/** Optional evaluation context for getActions (WF-7, GAP-2, WF-15).
 *  Everything is optional and absent values reproduce prior behavior, so
 *  existing callers stay correct while the route and the ticket page pass
 *  the full picture. */
export interface WorkflowContext {
  /** WF-7: the member's FULL additive role collection. Authority must be
   *  identical whether a role is the headline or an additive one. */
  userRoles?: Role[];
  /** GAP-2/DEC-12: the org's active member count. The independence
   *  predicates enforce at >= 3; below that the single-person loop is
   *  legitimate (a two-person shop has nobody else to route to). */
  activeMemberCount?: number;
  /** WF-15: request types allowed to close from DRAFTING without review —
   *  a property of the CONFIGURED type, not a hardcoded string. Defaults to
   *  ['RFI'] (the historical behavior). */
  closeWithoutReviewTypes?: string[];
}

/** DEC-12 threshold: independence appears exactly when it becomes possible
 *  to honour. */
export function separationOfDutiesActive(activeMemberCount?: number): boolean {
  return (activeMemberCount ?? 0) >= 3;
}

// ─── ROLE HELPERS ────────────────────────────────────────────────────────
// Centralised so the workflow + UI don't disagree on what counts as
// "qualified to approve engineering work."

export function isEngineerRole(role?: Role | string): boolean {
  return !!role && role.includes("Engineer");
}

export function isManagementRole(role?: Role | string): boolean {
  return role === "Admin" || role === "Manager" || role === "Supervisor";
}

export function isDocCtrlRole(role?: Role | string): boolean {
  return role === "DocCtrl";
}

/**
 * Returns true when a requester with this role MUST route their PENDING_REVIEW
 * approval through an engineer. Engineers and Management approve directly;
 * DocCtrl is included with management for IFC sign-off purposes. Drafter is
 * borderline — exclude here since drafters approving their own work as
 * requester is a separate antipattern.
 */
export function requiresEngineerApproval(requesterRole?: Role | string): boolean {
  if (!requesterRole) return true;
  if (isEngineerRole(requesterRole)) return false;
  if (isManagementRole(requesterRole)) return false;
  if (isDocCtrlRole(requesterRole)) return false;
  return true;
}

export const WorkflowEngine = {
  // Logic: Determines the starting status based on Request Type and Requester Role
  getInitialStatus: (_type: RequestType, _requesterRole: Role): TicketStatus => {
    // Every new request lands in the assignment queue — routed to the
    // DraftingSupervisor if one is set, otherwise Admins. Engineering review is
    // an OPTIONAL branch the assigner triggers via "Flag for Engineering
    // Review", never an automatic gate.
    return 'PENDING_ASSIGNMENT';
  },

  // State Machine: Returns valid buttons/actions for the current User and
  // Ticket state. `policy` is the org's capability policy — omitted (client
  // paths that haven't loaded it) it falls back to the shipped defaults,
  // which reproduce the historical hardcoded behavior exactly. The
  // workflow-action API route always passes the org's real policy, so the
  // server is the enforcement point.
  getActions: (ticket: Ticket, userRole: Role, userId?: string, policy?: CapabilityPolicy, ctx?: WorkflowContext): WorkflowAction[] => {
    const actions: WorkflowAction[] = [];

    // Role authority + any live per-person delegation for this user.
    // WF-7: the ADDITIVE collection is threaded through — a member's ticket
    // authority is identical whether a role is their headline or an additive
    // one (the headline is max-rank, so consulting it alone SUBTRACTED
    // authority from multi-role people).
    const roleCollection = ctx?.userRoles && ctx.userRoles.length > 0 ? ctx.userRoles : null;
    const allows = (cap: Parameters<typeof policyAllows>[1]) => policyAllows(policy, cap, userRole, roleCollection, userId);
    const isEng = isEngineerRole(userRole) || (roleCollection ?? []).some((r) => isEngineerRole(r));
    const isManagement = allows('ticket.manage');

    const isRequesterIdentity = !!userId && ticket.requesterId === userId;
    const isDrafterIdentity = !!userId && ticket.assignedDrafterId === userId;
    const isAssignedEngineerIdentity = !!userId && ticket.assignedEngineerId === userId;

    // Identity rights are never policy-configurable: your own ticket stays
    // yours. WF-8: the role CAPABILITIES, by contrast, are ticket-scoped —
    // `ticket.requester_review` substitutes for a requester only where there
    // is no requester to act, and `ticket.draft_work` covers unassigned
    // queue work only. Org-wide blanket substitution (any Requester approving
    // any colleague's ticket; any Drafter replacing another drafter's IFC
    // package) was the single widest hole in the workflow.
    const canActAsRequester = isRequesterIdentity
      || (!ticket.requesterId && allows('ticket.requester_review'));
    const canActAsDrafter = isDrafterIdentity
      || (!ticket.assignedDrafterId && allows('ticket.draft_work'));

    // GAP-2/DEC-12 (+DEC-37): independence is a property of the SLOT — one
    // deliverable's producer cannot be its checker. Active at >= 3 members.
    const sod = separationOfDutiesActive(ctx?.activeMemberCount);
    const producerIsChecker = sod && isDrafterIdentity;
    const SOD_REASON = "Needs a second person: the assigned drafter cannot approve their own deliverable (independent approval, orgs of 3+).";

    // Does the original requester's role require an engineer in the loop?
    const needsEngineerApproval = requiresEngineerApproval(ticket.requesterRole);

    switch (ticket.status) {
      // --- INITIAL REVIEW STAGE ---
      case 'NEW':
      case 'PENDING_ENG_INITIAL':
        if (isManagement || allows('ticket.initial_review')) {
           actions.push({
             label: 'Approve Request (To Assignment)',
             action: 'approve_initial',
             variant: 'success',
             description: 'Accepts the request and moves it to the assignment queue.'
           });

           // Now requires picking a SPECIFIC engineer — was previously broadcast.
           actions.push({
             label: 'Flag for Engineering Review',
             action: 'request_eng_review',
             variant: 'secondary',
             requiresComment: true,
             requiresEngineerPick: true,
             description: 'Route to a specific engineer for scope review before assigning a drafter.'
           });

           actions.push({
             label: 'Reject / Return to Requester',
             action: 'reject',
             variant: 'destructive',
             requiresComment: true
           });
        }
        break;

      // --- ENGINEERING REVIEW (Optional Loop) ---
      // Now scoped to the assigned engineer when one exists. Management
      // can still override (rare emergency case).
      case 'PENDING_ENG_TEAM':
        {
          const canActHere = ticket.assignedEngineerId
            ? isAssignedEngineerIdentity || isManagement
            : allows('ticket.eng_review') || isManagement;
          if (canActHere) {
            actions.push({
              label: 'Engineering Review Complete',
              action: 'approve_team',
              variant: 'success',
              description: 'Engineering has verified the scope. Ready for assignment.'
            });
            actions.push({
              label: 'Return with Questions',
              action: 'reject',
              variant: 'destructive',
              requiresComment: true
            });
          }
        }
        break;

      // --- ASSIGNMENT STAGE ---
      case 'PENDING_ASSIGNMENT':
        // Admins AND DraftingSupervisors run the assignment queue: assign a
        // drafter directly, or branch in an engineer for scope review first.
        if (allows('ticket.assign')) {
          actions.push({
            label: 'Assign Drafter',
            action: 'assign',
            variant: 'default',
            description: 'Select a drafter to begin work.'
          });
          actions.push({
            label: 'Flag for Engineering Review',
            action: 'request_eng_review',
            variant: 'secondary',
            requiresComment: true,
            requiresEngineerPick: true,
            description: 'Optional: route to a specific engineer for scope review before a drafter is assigned.'
          });
        }
        if (allows('ticket.self_assign')) {
          // GAP-2/DEC-12: the assigned drafter may not be the requester in
          // orgs of 3+ — rendered disabled, never hidden.
          const selfIsRequester = sod && isRequesterIdentity;
          actions.push({
            label: 'Pick Up Ticket',
            action: 'self_assign',
            variant: 'outline',
            ...(selfIsRequester ? { disabledReason: "Needs a second person: you can't draft your own request (independent drafting, orgs of 3+)." } : {}),
          });
        }
        break;

      // --- DRAFTING STAGE ---
      case 'DRAFTING':
      case 'REVISION_REQ':
        if (canActAsDrafter) {
          actions.push({
            label: 'Save Progress (Stage Files)',
            action: 'save_progress',
            variant: 'outline',
            description: 'Upload files but keep ticket in Drafting.'
          });

          if (ticket.attachments?.some(a => a.type === 'Draft')) {
            actions.push({
              label: 'Submit Draft for Review',
              action: 'submit_draft',
              variant: 'default',
              requiresFile: true
            });
          }

          // WF-15: close-without-review is a property of the CONFIGURED
          // request type (defaulting to the historical RFI), never a magic
          // string any creator can stamp for a one-click close.
          const closeTypes = ctx?.closeWithoutReviewTypes ?? ['RFI'];
          if (closeTypes.includes(ticket.requestType)) {
            actions.push({
              label: 'Answer & Close RFI',
              action: 'close_rfi',
              variant: 'success',
              requiresComment: true
            });
          }
        }
        break;

      // --- REVIEW STAGE ---
      // This is where the engineer-routing fork lives.
      case 'PENDING_REVIEW':
        if (canActAsRequester) {
          if (needsEngineerApproval && !isEng) {
            // Viewer-tier requesters can't sign off on engineering work.
            // Their "approve" is actually "send for engineer final approval".
            // WF-3: and their "minor correction" must be too — the old
            // unconditional fast path here was a one-click bypass of the
            // entire engineer sign-off gate for every requester tier.
            actions.push({
              label: 'Send for Engineer Final Approval',
              action: 'request_final_engineer_approval',
              variant: 'success',
              requiresEngineerPick: true,
              description: 'Engineering policy: drawings must be signed off by a qualified engineer before IFC. Pick the engineer who will review.'
            });
          } else {
            // Engineer requesters approve directly to IFC.
            actions.push({
              label: 'Approve (Issue for Construction)',
              action: 'approve_draft_ifc',
              variant: 'success',
              description: 'Accepts the draft. Drafter will be notified to issue IFC.',
              ...(producerIsChecker ? { disabledReason: SOD_REASON } : {}),
            });
            // The "fix this typo and it's approved" fast path — for actors
            // who could approve directly anyway (WF-3 done-when 2).
            actions.push({
              label: 'Approve with Minor Correction',
              action: 'approve_minor_correction',
              variant: 'secondary',
              requiresComment: true,
              description: 'Approve as-is except for a small fix (typo, mislabel). Your note goes to the drafter to fold into the issued file — no new review round.',
              ...(producerIsChecker ? { disabledReason: SOD_REASON } : {}),
            });
          }
          actions.push({
            label: 'Request Revision',
            action: 'request_revision',
            variant: 'warning',
            requiresComment: true
          });
        } else if (allows('ticket.direct_approve') || isManagement) {
          // Direct approvers (engineers by default) and management can co-review.
          actions.push({
            label: 'Approve (Issue for Construction)',
            action: 'approve_draft_ifc',
            variant: 'success',
            description: 'Accepts the draft. Drafter will be notified to issue IFC.',
            ...(producerIsChecker ? { disabledReason: SOD_REASON } : {}),
          });
          actions.push({
            label: 'Approve with Minor Correction',
            action: 'approve_minor_correction',
            variant: 'secondary',
            requiresComment: true,
            description: 'Approve as-is except for a small fix (typo, mislabel). Note goes to the drafter — no new review round.',
            ...(producerIsChecker ? { disabledReason: SOD_REASON } : {}),
          });
          actions.push({
            label: 'Request Revision',
            action: 'request_revision',
            variant: 'warning',
            requiresComment: true
          });
        }
        break;

      // --- FINAL ENGINEER APPROVAL ---
      // New stage: viewer-tier requester has sent the draft for engineer
      // sign-off. Only the assigned engineer (or management as a safety
      // override) can move the ticket forward.
      case 'PENDING_FINAL_APPROVAL':
        {
          const canActHere = ticket.assignedEngineerId
            ? isAssignedEngineerIdentity || isManagement
            : allows('ticket.final_approve') || isManagement;
          if (canActHere) {
            actions.push({
              label: 'Approve as Engineer (Issue for Construction)',
              action: 'engineer_approve_final',
              variant: 'success',
              description: 'Engineering sign-off complete. Drafter will be notified to issue IFC.',
              ...(producerIsChecker ? { disabledReason: SOD_REASON } : {}),
            });
            actions.push({
              label: 'Approve with Minor Correction',
              action: 'approve_minor_correction',
              variant: 'success',
              requiresComment: true,
              description: 'Approve as-is except for a small fix (typo, mislabel). Note goes to the drafter — no new review round.',
              ...(producerIsChecker ? { disabledReason: SOD_REASON } : {}),
            });
            actions.push({
              label: 'Request Revision (Send Back to Drafter)',
              action: 'engineer_request_revision',
              variant: 'warning',
              requiresComment: true,
              description: 'Send back to the drafter with revision notes.'
            });
            actions.push({
              label: 'Return to Requester for Clarification',
              action: 'engineer_return_to_requester',
              variant: 'destructive',
              requiresComment: true,
              description: 'Send back to the original requester instead of the drafter.'
            });
          }
        }
        break;

      // --- IFC STAGE ---
      case 'PENDING_IFC':
        if (canActAsDrafter) {
             actions.push({
               label: 'Save Progress',
               action: 'save_progress',
               variant: 'outline'
             });

             actions.push({
               label: 'ISSUE FINAL IFC PACKAGE',
               action: 'submit_final',
               variant: 'default',
               requiresFile: true
             });
        }
        break;

      // --- CLOSURE (acknowledgment by requester) ---
      case 'FINAL_DRAFT':
         if (canActAsRequester || allows('ticket.direct_approve') || isManagement) {
             actions.push({
               label: 'Acknowledge & Close', action: 'close_ticket', variant: 'success',
               ...(producerIsChecker ? { disabledReason: SOD_REASON } : {}),
             });
             actions.push({ label: 'Reject Final (Re-Open)', action: 'reject_final', variant: 'destructive', requiresComment: true });
         }
         break;

      // --- CLOSED (resurrection) ---
      // Closed tickets aren't dead — admin/management or the original requester
      // can reopen one to recover docs, re-run a revision, or restart a stalled
      // workflow without a brand-new ticket. The action routes it back through
      // PENDING_REVIEW so the existing draft/IFC artifacts stay attached.
      case 'CLOSED':
        if (allows('ticket.reopen') || canActAsRequester) {
          actions.push({
            label: 'Reopen Ticket',
            action: 'reopen_ticket',
            variant: 'outline',
            requiresComment: true,
            description: 'Move back to review status. All attachments and history are preserved; the comment you add becomes the reopen reason.',
          });
        }
        break;
    }

    // GLOBAL OVERRIDES
    if (allows('ticket.force_close') && ticket.status !== 'CLOSED') {
       const hasClose = actions.some(a => a.action === 'close_ticket');
       if (!hasClose) {
         actions.push({ label: 'Force Close (Admin)', action: 'close_ticket', variant: 'ghost' });
       }
    }

    // Reassignment of the engineer reviewer — useful when the assigned
    // engineer is OOO and the work is blocked. Default: Admin only.
    if (allows('ticket.reassign_engineer') && ticket.status === 'PENDING_FINAL_APPROVAL' && ticket.assignedEngineerId) {
      actions.push({
        label: 'Reassign Engineer Reviewer',
        action: 'reassign_engineer',
        variant: 'ghost',
        requiresEngineerPick: true,
        description: 'Admin override: pick a different engineer to review.'
      });
    }

    return actions;
  }
};
