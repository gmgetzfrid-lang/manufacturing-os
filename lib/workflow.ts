import { Role, RequestType, TicketStatus, Ticket } from "@/types/schema";

export interface WorkflowAction {
  label: string;
  action: string;
  variant: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link' | 'success' | 'warning';
  requiresFile?: boolean;
  requiresComment?: boolean;
  requiresEngineerPick?: boolean;   // UI Guard: open the engineer-picker modal first
  description?: string;
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
  getInitialStatus: (type: RequestType, requesterRole: Role): TicketStatus => {
    const isEngineer = isEngineerRole(requesterRole);

    if (type === 'INSPECTION' || type === 'RFI') {
      return 'PENDING_ASSIGNMENT';
    }
    if (isEngineer) {
      return 'PENDING_ASSIGNMENT';
    }
    return 'PENDING_ENG_INITIAL';
  },

  // State Machine: Returns valid buttons/actions for the current User and Ticket state
  getActions: (ticket: Ticket, userRole: Role, userId?: string): WorkflowAction[] => {
    const actions: WorkflowAction[] = [];

    const isEng = isEngineerRole(userRole);
    const isManagement = isManagementRole(userRole);
    const isAdmin = userRole === 'Admin';

    const isRequesterIdentity = !!userId && ticket.requesterId === userId;
    const isDrafterIdentity = !!userId && ticket.assignedDrafterId === userId;
    const isAssignedEngineerIdentity = !!userId && ticket.assignedEngineerId === userId;

    const canActAsRequester = isRequesterIdentity || userRole === 'Requester';
    const canActAsDrafter = isDrafterIdentity || userRole === 'Drafter';

    // Does the original requester's role require an engineer in the loop?
    const needsEngineerApproval = requiresEngineerApproval(ticket.requesterRole);

    switch (ticket.status) {
      // --- INITIAL REVIEW STAGE ---
      case 'NEW':
      case 'PENDING_ENG_INITIAL':
        if (isManagement || isEng) {
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
            : isEng || isManagement;
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
        if (isManagement) {
          actions.push({
            label: 'Assign Drafter',
            action: 'assign',
            variant: 'default',
            description: 'Select a drafter to begin work.'
          });
        }
        if (userRole === 'Drafter') {
          actions.push({
            label: 'Pick Up Ticket',
            action: 'self_assign',
            variant: 'outline'
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

          if (ticket.requestType === 'RFI') {
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
              description: 'Accepts the draft. Drafter will be notified to issue IFC.'
            });
          }
          actions.push({
            label: 'Request Revision',
            action: 'request_revision',
            variant: 'warning',
            requiresComment: true
          });
        } else if (isEng || isManagement) {
          // Engineers (any) and management can co-review and approve directly.
          actions.push({
            label: 'Approve (Issue for Construction)',
            action: 'approve_draft_ifc',
            variant: 'success',
            description: 'Accepts the draft. Drafter will be notified to issue IFC.'
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
            : isEng || isManagement;
          if (canActHere) {
            actions.push({
              label: 'Approve as Engineer (Issue for Construction)',
              action: 'engineer_approve_final',
              variant: 'success',
              description: 'Engineering sign-off complete. Drafter will be notified to issue IFC.'
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
         if (canActAsRequester || isEng || isManagement) {
             actions.push({ label: 'Acknowledge & Close', action: 'close_ticket', variant: 'success' });
             actions.push({ label: 'Reject Final (Re-Open)', action: 'reject_final', variant: 'destructive', requiresComment: true });
         }
         break;
    }

    // GLOBAL OVERRIDES
    if (isManagement && ticket.status !== 'CLOSED') {
       const hasClose = actions.some(a => a.action === 'close_ticket');
       if (!hasClose) {
         actions.push({ label: 'Force Close (Admin)', action: 'close_ticket', variant: 'ghost' });
       }
    }

    // Admin reassignment of the engineer reviewer — useful when the assigned
    // engineer is OOO and the work is blocked.
    if (isAdmin && ticket.status === 'PENDING_FINAL_APPROVAL' && ticket.assignedEngineerId) {
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
