"use client";

import { useEffect, useRef, useState } from "react";

import { HeroPortrait } from "@/components/hero/HeroPortrait";
import { lookFor } from "@/components/hero/look";
import { api, friendly } from "@/lib/api";
import type { ClassVisual, LeaderboardRow } from "@/lib/dto";

export interface LoginInfo {
  telegramBot: string | null;
  devLogin: boolean;
}

declare global {
  interface Window {
    clankTelegramAuth?: (user: Record<string, string | number>) => void;
  }
}

/**
 * Sign in with Telegram. Telegram proves your immutable numeric id; the server verifies the
 * signature (we never trust a username). Without a connected bot we say so plainly — and in local
 * development only, offer a one-click demo-hero login.
 */
export function SignInPanel({ login, onSignedIn }: { login: LoginInfo; onSignedIn: () => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [demo, setDemo] = useState<LeaderboardRow[]>([]);
  const [classes, setClasses] = useState<Record<string, ClassVisual>>({});

  useEffect(() => {
    if (!login.telegramBot || !holder.current) return;
    window.clankTelegramAuth = async (user) => {
      setError(null);
      const res = await api("/api/auth/telegram", { method: "POST", json: user });
      if (res.ok) onSignedIn();
      else setError(friendly(res.error));
    };
    const el = holder.current;
    el.innerHTML = "";
    const s = document.createElement("script");
    s.src = "https://telegram.org/js/telegram-widget.js?22";
    s.async = true;
    s.setAttribute("data-telegram-login", login.telegramBot);
    s.setAttribute("data-size", "large");
    s.setAttribute("data-radius", "8");
    s.setAttribute("data-onauth", "clankTelegramAuth(user)");
    s.setAttribute("data-request-access", "write");
    el.appendChild(s);
    return () => {
      delete window.clankTelegramAuth;
    };
  }, [login.telegramBot, onSignedIn]);

  useEffect(() => {
    if (!login.devLogin) return;
    void api<{ rows: LeaderboardRow[]; classes: Record<string, ClassVisual> }>("/api/leaderboard?board=POWER&limit=6").then((r) => {
      if (!r.ok) return;
      setDemo(r.data.rows.filter((x) => x.isDemo));
      setClasses(r.data.classes);
    });
  }, [login.devLogin]);

  return (
    <div className="plate plate-clank p-5 sm:p-6">
      <h2 className="font-display text-lg text-clank-300">Sign in with Telegram</h2>
      <p className="mt-1 max-w-xl text-sm text-steel-300">
        If you&apos;ve been active in the official Clank.trade Telegram, a hero may already be waiting for you. Signing in proves you&apos;re the same Telegram member — we never rely on usernames. You are not signed in yet.
      </p>
      <div className="mt-4">
        {login.telegramBot ? (
          <div ref={holder} className="min-h-[44px]" data-testid="telegram-login-widget" />
        ) : (
          <p className="rounded-md border border-white/10 bg-white/5 p-3 text-sm text-steel-300">
            Sign in with Telegram isn&apos;t available on this site yet — it opens as soon as the Telegram bot is linked. Your hero is still fighting in the arena meanwhile; nothing is lost by waiting.
          </p>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      </div>

      {login.devLogin && (
        <div className="mt-5 border-t border-white/10 pt-4">
          <p className="label !text-violet">Local preview only</p>
          <p className="mt-1 text-xs text-steel-300">Sign in as a demo hero to try claiming, gear and tactics. This option does not exist in production.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {demo.map((d) => (
              <button
                key={d.characterId}
                type="button"
                className="btn btn-ghost btn-sm !normal-case"
                onClick={async () => {
                  const r = await api("/api/auth/dev", { method: "POST", json: { characterId: d.characterId } });
                  if (r.ok) onSignedIn();
                  else setError(friendly(r.error));
                }}
              >
                <HeroPortrait look={lookFor(d.appearance, classes[d.classId])} size={22} className="rounded" />
                {d.name}
              </button>
            ))}
            {demo.length === 0 && <span className="text-xs text-steel-400">No demo heroes found. Run: pnpm db:seed:demo</span>}
          </div>
        </div>
      )}
    </div>
  );
}
