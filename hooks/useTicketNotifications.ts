import { useState, useEffect, useMemo, useCallback } from 'react';
import { 
  collection, 
  query, 
  where, 
  onSnapshot, 
  or,
  and
} from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { useRole } from '@/components/providers/RoleContext';
import { Ticket, TicketStatus } from '@/types/schema';

export function useTicketNotifications() {
  const { activeRole, activeOrgId } = useRole();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);

  // --------------------------------------------------------------------
  // HELPER: ACTION REQUIRED CHECKER (Mirrors logic in DraftingPortal)
  // --------------------------------------------------------------------
  const isActionRequired = useCallback((ticket: Ticket) => {
     const currentUser = auth.currentUser;
     const uid = currentUser?.uid;
     if (!uid) return false;

     // 1. IDENTITY-BASED CHECKS (Overrides Role)
     
     // Am I the Drafter?
     if (ticket.assignedDrafterId === uid) {
        if (['DRAFTING', 'REVISION_REQ', 'PENDING_IFC'].includes(ticket.status)) return true;
     }

     // Am I the Requester?
     if (ticket.requesterId === uid) {
        if (['PENDING_REVIEW', 'FINAL_DRAFT'].includes(ticket.status)) return true;
     }

     // 2. ROLE-BASED CHECKS
     
     // Management Logic
     if (['Admin', 'Manager', 'Supervisor'].includes(activeRole)) {
        if (ticket.status === 'PENDING_ASSIGNMENT') return true; 
        if (ticket.status === 'PENDING_ENG_INITIAL') return true; 
        if (ticket.status === 'PENDING_REVIEW') return true; 
        if (ticket.status === 'PENDING_FINAL_APPROVAL') return true; 
     }

     // Engineer Logic
     if (activeRole.includes('Engineer')) {
        if (['PENDING_ENG_INITIAL', 'PENDING_ENG_TEAM', 'PENDING_REVIEW'].includes(ticket.status)) return true;
     }

     // Doc Ctrl Logic
     if (activeRole === 'DocCtrl') {
        if (['FINAL_DRAFT', 'PENDING_IFC'].includes(ticket.status)) return true;
     }

     return false;
  }, [activeRole]);

  useEffect(() => {
    const currentUser = auth.currentUser;
    if (!currentUser || !activeOrgId) {
      setTickets([]);
      setLoading(false);
      return;
    }

    const ticketsRef = collection(db, 'tickets');
    let q;

    try {
        // Optimized Queries for Notifications
        if (['Admin', 'Manager', 'Supervisor', 'DocCtrl'].includes(activeRole) || activeRole.includes('Engineer')) {
            // Managers see all open tickets in the org
            q = query(
                ticketsRef,
                where('orgId', '==', activeOrgId),
                where('status', '!=', 'CLOSED')
            );
            
            const unsubscribe = onSnapshot(q, (snapshot) => {
                const fetchedTickets: Ticket[] = [];
                snapshot.forEach((doc) => {
                    fetchedTickets.push({ id: doc.id, ...doc.data() } as Ticket);
                });
                setTickets(fetchedTickets);
                setLoading(false);
            }, (err) => {
                console.error("Notification Sync Error:", err);
                setLoading(false);
            });
            return () => unsubscribe();
        } 
        else if (activeRole === 'Drafter') {
            // Split Query Strategy for Drafters
            const assignedMap = new Map<string, Ticket>();
            const poolMap = new Map<string, Ticket>();

            const updateState = () => {
                const merged = [...Array.from(assignedMap.values()), ...Array.from(poolMap.values())];
                const unique = Array.from(new Map(merged.map(item => [item.id, item])).values());
                setTickets(unique);
                setLoading(false);
            };

            const qAssigned = query(ticketsRef, where('orgId', '==', activeOrgId), where('assignedDrafterId', '==', currentUser.uid));
            const unsub1 = onSnapshot(qAssigned, (snap) => {
                assignedMap.clear();
                snap.forEach(doc => assignedMap.set(doc.id, { id: doc.id, ...doc.data() } as Ticket));
                updateState();
            });

            const qPool = query(ticketsRef, where('orgId', '==', activeOrgId), where('status', '==', 'PENDING_ASSIGNMENT'));
            const unsub2 = onSnapshot(qPool, (snap) => {
                poolMap.clear();
                snap.forEach(doc => poolMap.set(doc.id, { id: doc.id, ...doc.data() } as Ticket));
                updateState();
            });

            return () => { unsub1(); unsub2(); };
        }
        else {
            q = query(
                ticketsRef,
                where('orgId', '==', activeOrgId),
                where('requesterId', '==', currentUser.uid),
                where('status', '!=', 'CLOSED')
            );
            
            const unsubscribe = onSnapshot(q, (snapshot) => {
                const fetchedTickets: Ticket[] = [];
                snapshot.forEach((doc) => {
                    fetchedTickets.push({ id: doc.id, ...doc.data() } as Ticket);
                });
                setTickets(fetchedTickets);
                setLoading(false);
            }, (err) => {
                console.error("Notification Sync Error:", err);
                setLoading(false);
            });
            return () => unsubscribe();
        }
    } catch (e) {
        console.error("Query setup failed", e);
        setLoading(false);
    }

  }, [activeRole, activeOrgId]);

  const metrics = useMemo(() => {
      const currentUser = auth.currentUser;
      const uid = currentUser?.uid || '';

      const actionRequiredCount = tickets.filter(t => isActionRequired(t)).length;
      
      const unreadCount = tickets.filter(t => 
        t.unreadBy?.includes(uid) && !isActionRequired(t) // Prioritize action over unread
      ).length;

      return {
          actionRequiredCount,
          unreadCount,
          totalNotifications: actionRequiredCount + unreadCount
      };
  }, [tickets, isActionRequired]);

  return { ...metrics, loading };
}
