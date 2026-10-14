"use client";

// /assistant — the chat. One conversation model over every source: the
// knowledge libraries (cited answers), the system's own tools (the
// document controller you can talk to), and the internet. Conversations
// on the left, the stream in the middle, a panel on the right for reading.
//
// Deep links: ?thread=<id> reopens a conversation; ?library=<id> scopes
// the rail and the composer to one library; ?scope=tools|internet.

import React, { Suspense } from "react";
import ViewTabs, { INTELLIGENCE_VIEWS } from "@/components/navigation/ViewTabs";
import ChatShell from "@/components/chat/ChatShell";
import { Spinner } from "@/components/ui/Spinner";

export default function AssistantPage() {
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 sm:px-6 pt-3 -mb-2 shrink-0">
        <ViewTabs title="Intelligence" tabs={INTELLIGENCE_VIEWS} />
      </div>
      <div className="flex-1 min-h-0">
        <Suspense fallback={<div className="py-16 text-center"><Spinner /></div>}>
          <ChatShell />
        </Suspense>
      </div>
    </div>
  );
}
