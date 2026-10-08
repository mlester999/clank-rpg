"use client";

import { memo, useCallback } from "react";

import { ChatIcon } from "@/components/ui/Icons";
import type { LiveState } from "./chatConnection";
import type { ChatSnapshot } from "./chatController";
import { ChatComposer, GuestPrompt } from "./ChatComposer";
import { ChatMessageList } from "./ChatMessageList";
import { useArenaChat } from "./useArenaChat";

/**
 * ARENA CHAT — the permanent, global community room, directly under the Live Arena. Everybody can read it; only members signed in with Telegram can
 * write. It is a self-contained island: it fetches its own history, holds its own connection and re-renders only for its own messages — the Arena's
 * canvas, clock and audio never wait for it, and it never waits for them.
 */

/** The same height for the loading skeleton and the live list, so the page does not jump when the history arrives. */
const BODY_HEIGHT = "h-[18.5rem] sm:h-[26rem] lg:h-[30rem]";

export function LiveChip({ live, realtime }: { live: LiveState; realtime: boolean }) {
  const [text, tone, title] =
    live === "live"
      ? ["Live", "live", "Connected — new messages appear instantly."]
      : live === "connecting" || live === "paused"
        ? ["Connecting…", "wait", "Joining the live room."]
        : realtime && live === "reconnecting"
          ? ["Reconnecting…", "warn", "The live connection dropped. Your messages are kept; it is rejoining."]
          : ["Updating", "wait", "New messages appear within about 20 seconds."];
  return (
    <span className="chip shrink-0" title={title} role="status" aria-label={`Chat status: ${text}`} data-testid="chat-status" data-live={live} data-tone={tone}>
      <span aria-hidden className={`h-2 w-2 rounded-full ${tone === "live" ? "bg-teal shadow-[0_0_8px_#2ee6c8]" : tone === "warn" ? "animate-pulse bg-gold" : "bg-steel-400"}`} />
      {text}
    </span>
  );
}

function Skeleton() {
  return (
    <div className="space-y-4 px-3 py-4 sm:px-4" aria-hidden data-testid="chat-skeleton">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex animate-pulse gap-3">
          <span className="h-9 w-9 shrink-0 rounded-[6px] bg-white/[0.06]" />
          <div className="flex-1 space-y-2">
            <div className="flex justify-between gap-6">
              <span className="h-3 w-24 rounded bg-white/[0.08]" />
              <span className="h-3 w-10 rounded bg-white/[0.05]" />
            </div>
            <span className="block h-3 rounded bg-white/[0.05]" style={{ width: `${88 - i * 14}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Notice({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-4 py-8 text-center" data-testid="chat-notice">
      <div className="max-w-sm">
        <span aria-hidden className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-clank-600/30 text-clank-300">
          <ChatIcon size={22} />
        </span>
        <h3 className="mt-3 font-display text-sm tracking-[0.12em] text-paper uppercase">{title}</h3>
        <p className="mt-1.5 text-sm text-steel-300">{children}</p>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}

export function ChatBody({ snap, onRetry, onLoadOlder, onTrim }: { snap: ChatSnapshot; onRetry: () => void; onLoadOlder: () => void; onTrim: () => void }) {
  if (snap.phase === "loading") return <Skeleton />;
  if (snap.phase === "error") {
    return (
      <Notice
        title="Couldn't load the chat"
        action={
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry} data-testid="chat-retry">
            Try again
          </button>
        }
      >
        The Arena Chat didn&apos;t answer. The battle goes on — try again in a moment.
      </Notice>
    );
  }
  if (snap.phase === "closed") {
    return (
      <Notice title={snap.closedReason === "NOT_READY" ? "Arena Chat opens soon" : "Arena Chat is resting"}>
        {snap.closedReason === "NOT_READY" ? "The community chat is being set up. Check back shortly." : "The community chat is switched off for now."}
      </Notice>
    );
  }
  if (snap.room.messages.length === 0) {
    return (
      <Notice title="No messages yet">
        {snap.you ? "Say hello to the Arena." : "Be the first to say hello — sign in with Telegram below."}
      </Notice>
    );
  }
  return (
    <ChatMessageList
      messages={snap.room.messages}
      mineKey={snap.you?.senderKey ?? null}
      hasMore={snap.room.hasMore}
      loadingOlder={snap.loadingOlder}
      olderFailed={snap.olderFailed}
      onLoadOlder={onLoadOlder}
      onTrim={onTrim}
      ownTick={snap.ownTick}
    />
  );
}

export const ArenaChat = memo(function ArenaChat() {
  const { chat, snap } = useArenaChat();
  const onSend = useCallback((body: string, nonce: string) => chat.send(body, nonce), [chat]);
  const onRetry = useCallback(() => chat.retry(), [chat]);
  const onLoadOlder = useCallback(() => void chat.loadOlder(), [chat]);
  const onTrim = useCallback(() => chat.trim(), [chat]);

  return (
    <section id="arena-chat" aria-labelledby="arena-chat-title" className="plate plate-clank flex min-w-0 flex-col" style={{ ["--chamfer" as string]: "14px" }} data-testid="arena-chat" data-phase={snap.phase} data-live={snap.live}>
      <header className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-3 sm:px-4">
        <h2 id="arena-chat-title" className="flex min-w-0 items-center gap-2 font-display text-sm tracking-[0.2em] whitespace-nowrap text-clank-300 uppercase sm:text-base">
          <ChatIcon size={18} className="shrink-0" />
          Arena Chat
        </h2>
        {snap.phase === "ready" && <LiveChip live={snap.live} realtime={snap.realtime} />}
      </header>
      <div className={`flex min-h-0 flex-col ${snap.phase === "closed" || snap.phase === "error" ? "min-h-48" : BODY_HEIGHT}`}>
        <ChatBody snap={snap} onRetry={onRetry} onLoadOlder={onLoadOlder} onTrim={onTrim} />
      </div>
      {snap.phase === "ready" && (
        <div className="border-t border-white/10 bg-ink-950/40" data-testid="chat-footer">
          {snap.you ? <ChatComposer key={snap.you.senderKey} you={snap.you} onSend={onSend} /> : <GuestPrompt />}
        </div>
      )}
    </section>
  );
});
