"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { SendIcon, TelegramIcon } from "@/components/ui/Icons";
import { CHAT_BODY_MAX } from "@/domain/chat/limits";
import { CHAT_TEXT_MESSAGE, codePoints, normalizeChatBody } from "@/domain/chat/text";
import type { ChatMute, ChatYou } from "@/domain/chat/types";

import type { SendOutcome } from "./chatApi";

/**
 * Who can write, and how:
 *
 *   · still asking who the viewer is → a quiet placeholder (nothing is implied);
 *   · a guest → a clear prompt to sign in with Telegram. There is NO input and NO send button for a guest;
 *   · a muted member → a calm notice (they can read, they cannot write);
 *   · a signed-in member → the message box. Enter sends, Shift+Enter starts a new line, 280 characters, one send at a time: while a message is on its
 *     way the box is read-only and the button is off, and a retry after a failure reuses the message's nonce so it can never be posted twice.
 */

const newNonce = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replaceAll("-", "") : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`);

export function GuestPrompt() {
  return (
    <div className="flex flex-col items-start justify-between gap-3 px-3 py-3 sm:flex-row sm:items-center sm:px-4" data-testid="chat-guest">
      <p className="text-sm font-semibold text-paper">Sign in with Telegram to chat.</p>
      <Link href="/character" className="btn btn-teal btn-sm shrink-0 whitespace-nowrap" data-testid="chat-signin">
        <TelegramIcon size={16} />
        Sign in with Telegram
      </Link>
    </div>
  );
}

export function MutedNotice({ mute }: { mute: ChatMute }) {
  const until = mute.permanent ? null : new Date(mute.until);
  return (
    <p className="px-3 py-3 text-sm text-steel-300 sm:px-4" role="status" data-testid="chat-muted">
      <b className="text-paper">You can read the chat, but you can&apos;t send messages right now.</b>
      {until && !Number.isNaN(until.getTime()) ? ` This lasts until ${until.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.` : ""}
    </p>
  );
}

export function ChatComposer({ you, onSend }: { you: ChatYou; onSend: (body: string, nonce: string) => Promise<SendOutcome> }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coolingUntil, setCoolingUntil] = useState(0);
  const [cooling, setCooling] = useState(false);
  const sendingRef = useRef(false);
  const nonce = useRef<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // the send button wakes up again when the server's "wait a moment" has passed
  useEffect(() => {
    if (coolingUntil <= Date.now()) return;
    const id = setTimeout(() => setCooling(false), coolingUntil - Date.now());
    return () => clearTimeout(id);
  }, [coolingUntil]);

  if (you.muted) return <MutedNotice mute={you.muted} />;

  const count = codePoints(text);
  const over = count > CHAT_BODY_MAX;

  const resize = () => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 104)}px`;
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (sendingRef.current || cooling) return; // a double click, a double Enter: one message
    const checked = normalizeChatBody(text);
    if (!checked.ok) {
      setError(CHAT_TEXT_MESSAGE[checked.reason]);
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setError(null);
    nonce.current ??= newNonce();
    const r = await onSend(checked.body, nonce.current);
    sendingRef.current = false;
    setSending(false);
    if (r.ok) {
      setText("");
      nonce.current = null;
      requestAnimationFrame(() => {
        resize();
        box.current?.focus();
      });
      return;
    }
    setError(r.message);
    // a transient failure keeps the nonce: sending the same text again can never post it twice
    if (!r.transient) nonce.current = null;
    if (r.retryAfterMs) {
      setCoolingUntil(Date.now() + r.retryAfterMs);
      setCooling(true);
    }
    box.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form onSubmit={submit} className="px-3 py-2.5 sm:px-4" data-testid="chat-form" noValidate>
      <div className="flex items-end gap-2">
        <label htmlFor="arena-chat-input" className="sr-only">
          Message the Arena
        </label>
        <textarea
          ref={box}
          id="arena-chat-input"
          rows={1}
          value={text}
          readOnly={sending}
          onChange={(e) => {
            setText(e.target.value);
            nonce.current = null; // a different text is a different message
            if (error) setError(null);
            resize();
          }}
          onKeyDown={onKeyDown}
          placeholder="Message the Arena..."
          enterKeyHint="send"
          autoComplete="off"
          autoCapitalize="sentences"
          spellCheck
          aria-invalid={over || undefined}
          aria-describedby="arena-chat-hint"
          className={`block max-h-[104px] min-h-11 min-w-0 flex-1 resize-none rounded-lg border bg-ink-900 px-3 py-2.5 text-base leading-snug text-paper placeholder:text-steel-400 focus:outline-2 focus:outline-offset-0 focus:outline-clank-300 sm:text-sm ${over ? "border-danger/70" : "border-white/10"} ${sending ? "opacity-70" : ""}`}
          data-testid="chat-input"
        />
        <button type="submit" disabled={sending || cooling || text.trim() === "" || over} aria-label="Send message" className="btn min-h-11 shrink-0 px-3.5 sm:px-4" data-testid="chat-send">
          <SendIcon size={16} />
          <span className="hidden sm:inline">{sending ? "Sending…" : "Send"}</span>
        </button>
      </div>
      <div className="mt-1 flex min-h-5 items-start justify-between gap-3 text-xs" id="arena-chat-hint">
        <p role={error ? "alert" : undefined} className={error ? "text-danger" : "text-steel-400"} data-testid="chat-feedback">
          {error ?? (text === "" ? "Enter to send · Shift+Enter for a new line" : "")}
        </p>
        {count >= CHAT_BODY_MAX - 60 && (
          <span className={`shrink-0 tnum ${over ? "font-bold text-danger" : "text-steel-300"}`} data-testid="chat-count">
            {count}/{CHAT_BODY_MAX}
          </span>
        )}
      </div>
    </form>
  );
}
