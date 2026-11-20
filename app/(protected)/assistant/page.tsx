"use client";

// /assistant — the chat. One conversation model over every source: the
// knowledge libraries (cited answers), the system's own tools (the
// document controller you can talk to), and the internet. Conversations
// on the left, the stream in the middle, a panel on the right for reading.
//
// Deep links: ?thread=<id> reopens a conversation; ?library=<id> scopes
// the rail and the composer to one library; ?scope=tools|internet.

import React, { Suspense } from "react";
import ChatShell from "@/components/chat/ChatShell";
import LoadingBlock from "@/components/ui/LoadingBlock";

export default function AssistantPage() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 min-h-0">
        <Suspense fallback={<div className="p-6 max-w-3xl mx-auto"><LoadingBlock what="the chat" /></div>}>
          <ChatShell />
        </Suspense>
      </div>
    </div>
  );
}
