import { Role, RequestType, TicketStatus, Ticket } from "@/types/schema";

export interface WorkflowAction {
  label: string;
  action: string;
  variant: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link' | 'success' | 'warning';
  requiresFile?: boolean;    // UI Guard: Disable button if no file uploaded in this stage
  requiresComment?: boolean; // UI Guard: Force modal/input before proceeding
  description?: string;      // Tooltip/Helper text for the user
}

export const WorkflowEngine = {
  // Logic: Determines the starting status based on Request Type and Requester Role
  getInitialStatus: (type: RequestType, requesterRole: Role): TicketStatus => {
    const isEngineer = requesterRole.includes('Engineer');
    
    // Path 1: Simple flows (Inspection/RFI) go straight to Assignment
    if (type === 'INSPECTION' || type === 'RFI') {
      return 'PENDING_ASSIGNMENT';
    }
    
    // Path 2: Engineers bypass Initial Review
    if (isEngineer) {
      return 'PENDING_ASSIGNMENT'; 
    } 
    
    // Path 3: Standard Requests (ISO/MOC/AsBuilt) go to Initial Review
    return 'PENDING_ENG_INITIAL'; 
  },

  // State Machine: Returns valid buttons/actions for the current User and Ticket state
  getActions: (ticket: Ticket, userRole: Role, userId?: string): WorkflowAction[] => {
    const actions: WorkflowAction[] = [];
    
    // Role Checks
    const isEng = userRole.includes('Engineer');
    const isSuper = userRole === 'Supervisor';
    const isManager = userRole === 'Manager';
    const isAdmin = userRole === 'Admin';
    // const isDrafter = userRole === 'Drafter'; // Old Role Check
    // const isRequester = userRole === 'Requester'; // Old Role Check
    
    // IDENTITY CHECKS (Stronger than Role)
    const isRequesterIdentity = userId && ticket.requesterId === userId;
    const isDrafterIdentity = userId && ticket.assignedDrafterId === userId;

    // Derived Permissions (Role OR Identity)
    const canActAsRequester = isRequesterIdentity || userRole === 'Requester'; // Fallback to role if ID missing
    const canActAsDrafter = isDrafterIdentity || userRole === 'Drafter';

    // Management Tier (Can override/assign/force close)
    const isManagement = isAdmin || isManager || isSuper;

    switch (ticket.status) {
      // --- INITIAL REVIEW STAGE (Gatekeeping) ---
      // This is where Requesters wait for approval. 
      // Supervisors/Admins approve here to move it to the Assignment Queue.
      case 'NEW':
      case 'PENDING_ENG_INITIAL':
        if (isManagement || isEng) {
           actions.push({ 
             label: 'Approve Request (To Assignment)', 
             action: 'approve_initial', 
             variant: 'success',
             description: 'Accepts the request and moves it to the assignment queue.'
           });
           
           // Optional: Flag for specific engineering review if needed before assignment
           actions.push({
             label: 'Flag for Engineering Review',
             action: 'request_eng_review',
             variant: 'secondary',
             requiresComment: true,
             description: 'Route to Engineering Team before assigning a drafter.'
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
      // If a Supervisor flagged it for Engineering, it lands here.
      case 'PENDING_ENG_TEAM':
        if (isEng || isManagement) {
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
        break;

      // --- ASSIGNMENT STAGE ---
      // The "Pool" where tickets wait for a Drafter.
      case 'PENDING_ASSIGNMENT':
        if (isManagement) {
          actions.push({ 
            label: 'Assign Drafter', 
            action: 'assign', 
            variant: 'default',
            description: 'Select a drafter to begin work.'
          });
        }
        // Self-Assignment for Drafters (Optional, if your workflow allows pulling work)
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
          // SAVE PROGRESS: Uploads without moving status
          actions.push({
            label: 'Save Progress (Stage Files)',
            action: 'save_progress',
            variant: 'outline',
            description: 'Upload files but keep ticket in Drafting.'
          });

          // SUBMIT: Moves to Review
          // Only show if at least one Draft file has been uploaded
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

      // --- REVIEW STAGE (Requester/Engineer reviews the Draft) ---
      case 'PENDING_REVIEW':
        // Engineers, Requesters, or Management can review
        if (isEng || canActAsRequester || isManagement) {
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

      // --- IFC STAGE (Drafter Finalizes) ---
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
               requiresFile: true // Must include stamped PDF
             });
        }
        break;

      // --- FINAL APPROVAL / CLOSURE ---
      case 'FINAL_DRAFT':
      case 'PENDING_FINAL_APPROVAL':
         if (canActAsRequester || isEng || isManagement) {
             actions.push({ label: 'Acknowledge & Close', action: 'close_ticket', variant: 'success' });
             actions.push({ label: 'Reject Final (Re-Open)', action: 'reject_final', variant: 'destructive', requiresComment: true });
         }
         break;
    }
    
    // GLOBAL OVERRIDES
    // Management can always Force Close to clean up stale tickets
    if (isManagement && ticket.status !== 'CLOSED') {
       // We add this as a secondary option if not already present
       const hasClose = actions.some(a => a.action === 'close_ticket');
       if (!hasClose) {
         actions.push({ label: 'Force Close (Admin)', action: 'close_ticket', variant: 'ghost' });
       }
    }

    return actions;
  }
};