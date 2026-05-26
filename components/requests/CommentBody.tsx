"use client";

// CommentBody — render a comment that may contain @[name](uid) tokens as
// inline mention chips. Plain whitespace + newlines are preserved.

import React from "react";
import { tokenizeMentions } from "@/lib/notifications";
import { AtSign } from "lucide-react";

interface CommentBodyProps {
  text: string;
  currentUserId?: string;
  className?: string;
}

export default function CommentBody({ text, currentUserId, className }: CommentBodyProps) {
  if (!text) return null;
  const tokens = tokenizeMentions(text);
  return (
    <div className={`whitespace-pre-wrap break-words ${className ?? ""}`}>
      {tokens.map((t, idx) => {
        if (t.kind === "mention") {
          const isMe = currentUserId && t.uid === currentUserId;
          return (
            <span
              key={idx}
              className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[12px] font-bold align-baseline mr-0.5 ${
                isMe
                  ? "bg-orange-100 text-orange-700 ring-1 ring-orange-200"
                  : "bg-blue-50 text-blue-700 ring-1 ring-blue-200"
              }`}
              title={`Mentioned: ${t.name}`}
            >
              <AtSign className="w-3 h-3" />
              {t.name}
            </span>
          );
        }
        return <span key={idx}>{t.value}</span>;
      })}
    </div>
  );
}
