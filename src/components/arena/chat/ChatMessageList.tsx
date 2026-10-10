"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { CHAT_KEEP_MAX } from "@/domain/chat/limits";
import { exactTime, relativeTime } from "@/domain/chat/relativeTime";
import type { ChatMessageDto } from "@/domain/chat/types";

import { ChatMessageRow } from "./ChatMessageRow";
import { isFollowing, nearTop, newMessagesLabel, onMessagesChanged, restoredTop, shouldGlide, unseenCount } from "./scrollRules";

/** A clock that ticks every `ms` (only while the tab is visible), so "2m ago" keeps up without refetching anything. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "hidden") setNow(Date.now());
    };
    const id = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [ms]);
  return now;
}

export interface ChatListProps {
  messages: readonly ChatMessageDto[];
  mineKey: string | null;
  hasMore: boolean;
  loadingOlder: boolean;
  olderFailed: boolean;
  onLoadOlder: () => void;
  onTrim: () => void;
  /** Changes whenever the viewer's own message is accepted: the list follows it to the bottom. */
  ownTick: number;
}

/**
 * The scrolling history.
 *
 *   · at the bottom → it FOLLOWS: new messages scroll into view;
 *   · scrolled up → it STAYS PUT and shows a "New messages" button with a count; clicking it goes to the newest;
 *   · older messages loaded at the top keep the viewer's place (the scroll position is corrected by exactly the height that was added);
 *   · it scrolls its OWN box only (never scrollIntoView, which would drag the whole page along);
 *   · the viewer's own message always takes them to the bottom.
 */
export function ChatMessageList({ messages, mineKey, hasMore, loadingOlder, olderFailed, onLoadOlder, onTrim, ownTick }: ChatListProps) {
  const box = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const rendered = useRef<{ first: number | null; last: number | null }>({ first: null, last: null });
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const ownSeen = useRef(ownTick);
  /** The newest message id the viewer has been shown (at the bottom). Messages beyond it are "new". */
  const [seenUpTo, setSeenUpTo] = useState<number | null>(null);
  const now = useNow(30_000);

  const lastId = messages.length > 0 ? (messages[messages.length - 1] as ChatMessageDto).id : null;
  const unseen = useMemo(() => unseenCount(messages.map((m) => m.id), seenUpTo), [messages, seenUpTo]);

  const lastIdRef = useRef<number | null>(lastId);
  useEffect(() => {
    lastIdRef.current = lastId;
  }, [lastId]);
  const toBottom = useCallback((smooth = false) => {
    const el = box.current;
    if (!el) return;
    following.current = true;
    // a short hop glides; a long way (more than a few screens of history) jumps — a smooth scroll over thousands of pixels is slow and nobody wants to watch it
    if (smooth && shouldGlide(el) && typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
    setSeenUpTo(lastIdRef.current);
  }, []);

  // runs after the DOM has the new rows, before the browser paints them: no flash at the old scroll position
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const first = messages.length > 0 ? (messages[0] as ChatMessageDto).id : null;
    const was = rendered.current;
    const change = onMessagesChanged({ first, last: lastId, was, anchored: anchor.current !== null, following: following.current });
    if (change === "restore" && anchor.current) {
      // older history was added above: keep what the viewer was looking at where it was
      el.scrollTop = restoredTop(anchor.current, el.scrollHeight);
      anchor.current = null;
    } else if (change === "to-bottom") {
      el.scrollTop = el.scrollHeight;
      if (lastId !== null && was.last !== lastId) setSeenUpTo(lastId); // (trimmed away while following: nothing new to count)
    }
    rendered.current = { first, last: lastId };
  }, [messages, lastId]);

  // the viewer's own message: always to the bottom
  useLayoutEffect(() => {
    if (ownTick === ownSeen.current) return;
    ownSeen.current = ownTick;
    toBottom();
  }, [ownTick, toBottom]);

  // a room that has grown past its budget lets go of its oldest messages — but only while the viewer is at the bottom, so nobody's place is lost
  const total = messages.length;
  useEffect(() => {
    if (total > CHAT_KEEP_MAX && following.current) onTrim();
  }, [total, onTrim]);

  const onScroll = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const atBottom = isFollowing(el);
    following.current = atBottom;
    if (atBottom) setSeenUpTo(lastIdRef.current);
    if (nearTop(el.scrollTop) && hasMore && !loadingOlder && !olderFailed) {
      anchor.current = { height: el.scrollHeight, top: el.scrollTop };
      onLoadOlder();
    }
  }, [hasMore, loadingOlder, olderFailed, onLoadOlder]);

  const loadOlderByButton = () => {
    const el = box.current;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    onLoadOlder();
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={box}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Arena Chat messages"
        tabIndex={0}
        className="h-full overflow-x-hidden overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-clank-300"
        data-testid="chat-scroll"
      >
        {(hasMore || loadingOlder) && (
          <div className="flex justify-center px-3 py-1">
            {loadingOlder ? (
              <span className="text-xs text-steel-300" role="status">Loading earlier messages…</span>
            ) : (
              <button type="button" onClick={loadOlderByButton} className="rounded-md px-3 py-1 text-xs font-bold text-clank-300 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-clank-300" data-testid="chat-older">
                {olderFailed ? "Couldn't load — try again" : "Load earlier messages"}
              </button>
            )}
          </div>
        )}
        <ul className="divide-y divide-white/[0.04]" data-testid="chat-messages">
          {messages.map((m) => {
            const at = Date.parse(m.at);
            return <ChatMessageRow key={m.id} message={m} label={relativeTime(at, now)} exact={exactTime(at)} mine={mineKey !== null && m.senderKey === mineKey} />;
          })}
        </ul>
      </div>
      {unseen > 0 && (
        <button
          type="button"
          onClick={() => toBottom(true)}
          className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full border border-clank-300/60 bg-clank-700 px-3 py-1 text-[0.7rem] font-bold text-paper shadow-[0_6px_18px_rgba(0,0,0,.5)] hover:bg-clank-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-clank-300"
          data-testid="chat-new-messages"
        >
          {newMessagesLabel(unseen)}
        </button>
      )}
    </div>
  );
}
