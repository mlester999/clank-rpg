"use client";

import { memo, useState } from "react";

import { initialOf } from "@/components/nav/AccountControl";
import type { ChatMessageDto } from "@/domain/chat/types";

/**
 * One message. The header is a full-width row — the sender's name on the LEFT (it shortens with an ellipsis, never into the time), the age on the FAR
 * RIGHT — and the text sits under it, wrapping at any width. The body is rendered as TEXT: markup in a message is shown, never interpreted.
 */
export function ChatAvatar({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const frame = "h-9 w-9 shrink-0 rounded-[6px] ring-1 ring-clank-400/40";
  if (url && failed !== url) {
    // A plain <img>: same-origin, versioned and immutable (served by /api/avatars) — the image optimiser adds nothing, and a broken photo falls back to the initial.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" width={36} height={36} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(url)} className={`${frame} block bg-ink-800 object-cover`} />;
  }
  return (
    <span aria-hidden className={`${frame} grid place-items-center bg-clank-600 font-display text-sm text-paper`}>
      {initialOf(name)}
    </span>
  );
}

export interface ChatRowProps {
  message: ChatMessageDto;
  /** "Just now" · "2m ago" … (computed by the list, so a row only re-renders when its label changes). */
  label: string;
  /** The exact date and time, for the tooltip. */
  exact: string;
  mine: boolean;
}

export const ChatMessageRow = memo(function ChatMessageRow({ message: m, label, exact, mine }: ChatRowProps) {
  return (
    <li className={`flex items-start gap-3 px-3 py-2.5 sm:px-4 ${mine ? "bg-clank-500/[0.08] shadow-[inset_3px_0_0_0_rgba(183,121,245,0.75)]" : ""}`} data-testid="chat-message" data-message-id={m.id} data-mine={mine ? "true" : "false"}>
      <ChatAvatar url={m.avatarUrl} name={m.name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3" data-testid="chat-header">
          <span className={`min-w-0 truncate text-sm font-bold ${mine ? "text-clank-200" : "text-paper"}`} title={m.name} data-testid="chat-author">
            {m.name}
          </span>
          <time dateTime={m.at} title={exact} className="shrink-0 text-[0.7rem] font-semibold text-steel-300 tnum" data-testid="chat-time">
            {label}
          </time>
        </div>
        <p className="mt-0.5 text-sm leading-snug whitespace-pre-wrap text-paper/90 [overflow-wrap:anywhere]" data-testid="chat-body">
          {m.body}
        </p>
      </div>
    </li>
  );
});
