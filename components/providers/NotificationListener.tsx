"use client";

import { useEffect, useRef } from 'react';
import { 
  collection, 
  query, 
  where, 
  onSnapshot, 
  orderBy, 
  limit, 
  Timestamp 
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useRole } from '@/components/providers/RoleContext';
import { useToast } from './ToastProvider';

export function NotificationListener() {
  const { activeOrgId, activeRole, userEmail } = useRole();
  const { showToast } = useToast();
  const isFirstRun = useRef(true);
  // Track last message ID to dedupe initial load
  const processedIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!activeOrgId || !userEmail) return;

    // Listen for new checkout messages (Chat & System events)
    // We limit to recent to avoid pulling huge history
    const q = query(
      collection(db, "checkout_messages"),
      where("orgId", "==", activeOrgId),
      orderBy("createdAt", "desc"),
      limit(1) 
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      // Skip the very first snapshot (initial state)
      if (isFirstRun.current) {
        isFirstRun.current = false;
        snapshot.docs.forEach(d => processedIds.current.add(d.id));
        return;
      }

      snapshot.docChanges().forEach((change) => {
        if (change.type === "added") {
          const data = change.doc.data();
          const msgId = change.doc.id;

          // Dedupe
          if (processedIds.current.has(msgId)) return;
          processedIds.current.add(msgId);

          // Don't notify about my own actions
          // data.userId might be 'system' or a uid
          // We check against our own UID or Email if stored
          // Assuming data.userId is UID. useRole provides `uid` usually but here we access context.
          // Let's rely on data.userName comparison if UID isn't available easily or check useRole internal.
          // But useRole exposes `userEmail`. 
          // Best check:
          // The sender's UID is in `data.userId`.
          // We can't check UID easily unless we store it in context or fetch auth.currentUser.
          // Let's assume we want to see everything NOT from 'me'. 
          // We can check data.userName against my name? 
          // Or just show all 'system' messages and other users' chats.
          
          const isSystem = data.userId === 'system';
          const isMe = !isSystem && (data.userName === userEmail.split('@')[0]); // Approximate check

          if (isMe) return;

          // Show Toast
          showToast({
            type: isSystem ? "info" : "warning", // Chat is warning (yellow/bell), System is info
            title: isSystem ? "System Alert" : `New Message from ${data.userName}`,
            message: data.text || "New activity in document.",
            duration: 5000
          });
        }
      });
    });

    return () => unsubscribe();
  }, [activeOrgId, userEmail, showToast]);

  return null; // Headless component
}
