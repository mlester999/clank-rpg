"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { fetchChatPage, sendChatMessage } from "./chatApi";
import { ChatConnection } from "./chatConnection";
import { ChatController, type ChatSnapshot } from "./chatController";

function browserController(): ChatController {
  const w = typeof window === "undefined" ? null : window;
  return new ChatController({
    fetchPage: fetchChatPage,
    sendMessage: sendChatMessage,
    connect: (options) => new ChatConnection(options),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    random: Math.random,
    doc: typeof document === "undefined" ? null : document,
    win: w,
  });
}

/**
 * The Arena Chat for a component: the room's snapshot and its controller. The controller lives for as long as the chat section is mounted — it joins
 * the room when the section appears and leaves (socket closed, timers cleared) when it goes. It shares nothing with the Arena's own state: a message
 * arriving re-renders the chat and nothing else.
 */
export function useArenaChat(): { chat: ChatController; snap: ChatSnapshot } {
  const [chat] = useState(browserController);
  const snap = useSyncExternalStore(chat.subscribe, chat.getSnapshot, chat.getServerSnapshot);
  useEffect(() => {
    chat.start();
    return () => chat.stop();
  }, [chat]);
  return { chat, snap };
}
