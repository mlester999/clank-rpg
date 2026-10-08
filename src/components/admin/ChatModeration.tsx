"use client";

import { useState } from "react";

import { act, Card, fmtDate, Note, Table, useAdminData, type Row } from "./adminUi";

/**
 * ARENA CHAT — moderation. Real controls, no placeholders: hide / restore a message (open rooms learn of it instantly), mute / unmute a member (they can
 * still read), and the log of what moderators did. Everything below goes through /api/admin/chat/* (admin session + same-origin), and every action is
 * written to the audit log by the server. Reasons stay in the admin tools: no public endpoint ever returns one.
 */
interface AdminMessage {
  id: number;
  at: string;
  body: string;
  hidden: boolean;
  memberId: number;
  name: string;
  username: string | null;
  muted: boolean;
}
interface AdminMute {
  id: number;
  memberId: number;
  name: string;
  permanent: boolean;
  until: string | null;
  reason: string | null;
  by: string;
  at: string;
}

export function ChatModeration() {
  const messages = useAdminData<{ messages: AdminMessage[]; hasMore: boolean }>("/api/admin/chat/messages?limit=50");
  const mutes = useAdminData<{ mutes: AdminMute[] }>("/api/admin/chat/mutes");
  const log = useAdminData<{ log: Row[] }>("/api/admin/chat/log?limit=30");
  const [msg, setMsg] = useState("");

  const refresh = async () => {
    await Promise.all([messages.reload(), mutes.reload(), log.reload()]);
  };

  const hide = (m: AdminMessage) => {
    const reason = window.prompt(`Hide ${m.name}'s message? Reason (private, optional):`, "");
    if (reason === null) return;
    return act(`/api/admin/chat/messages/${m.id}/hide`, "POST", { reason: reason.trim() || null }, refresh, setMsg);
  };
  const restore = (m: AdminMessage) => act(`/api/admin/chat/messages/${m.id}/restore`, "POST", {}, refresh, setMsg);
  const mute = (m: AdminMessage) => {
    const answer = window.prompt(`Mute ${m.name} (they can still read). Minutes, or "permanent":`, "60");
    if (answer === null) return;
    const text = answer.trim().toLowerCase();
    const permanent = text === "permanent" || text === "perm";
    const minutes = Number(text);
    if (!permanent && !(Number.isInteger(minutes) && minutes >= 1)) {
      setMsg("Enter a whole number of minutes, or the word permanent.");
      return;
    }
    const reason = window.prompt("Reason (private, optional):", "");
    if (reason === null) return;
    return act("/api/admin/chat/mutes", "POST", { memberId: m.memberId, ...(permanent ? { permanent: true } : { minutes }), reason: reason.trim() || null }, refresh, setMsg);
  };
  const unmute = (memberId: number) => act(`/api/admin/chat/mutes/${memberId}`, "DELETE", undefined, refresh, setMsg);

  const btn = "rounded-md border border-white/10 px-2 py-1 text-xs font-semibold text-paper hover:bg-white/5";
  return (
    <>
      <Note msg={msg} />
      <Card title="Recent messages" actions={<button type="button" className={btn} onClick={() => void refresh()}>Refresh</button>}>
        {messages.error ? (
          <p className="text-danger">{messages.error}</p>
        ) : !messages.data ? (
          <p className="text-steel-300">Loading…</p>
        ) : messages.data.messages.length === 0 ? (
          <p className="text-sm text-steel-400">No messages yet.</p>
        ) : (
          <table className="w-full text-left text-sm" data-testid="admin-chat-messages">
            <thead>
              <tr>{["When", "Member", "Message", "Status", "Actions"].map((h) => <th key={h} className="label px-2 py-1.5">{h}</th>)}</tr>
            </thead>
            <tbody>
              {messages.data.messages.map((m) => (
                <tr key={m.id} className="border-t border-white/5 align-top">
                  <td className="px-2 py-1.5 whitespace-nowrap text-steel-300">{fmtDate(m.at)}</td>
                  <td className="px-2 py-1.5">
                    <span className="font-semibold text-paper">{m.name}</span>
                    <span className="block text-xs text-steel-400">{m.username ? `@${m.username} · ` : ""}id {m.memberId}</span>
                  </td>
                  <td className={`max-w-[28rem] px-2 py-1.5 break-words whitespace-pre-wrap ${m.hidden ? "text-steel-400 line-through" : "text-paper"}`}>{m.body}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{m.hidden ? <span className="text-gold">hidden</span> : "visible"}{m.muted ? <span className="ml-2 text-danger">muted</span> : null}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <span className="flex gap-1.5">
                      {m.hidden ? <button type="button" className={btn} onClick={() => void restore(m)}>Restore</button> : <button type="button" className={btn} onClick={() => void hide(m)}>Hide</button>}
                      <button type="button" className={btn} onClick={() => void mute(m)}>Mute…</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Muted members">
        {mutes.error ? (
          <p className="text-danger">{mutes.error}</p>
        ) : !mutes.data ? (
          <p className="text-steel-300">Loading…</p>
        ) : mutes.data.mutes.length === 0 ? (
          <p className="text-sm text-steel-400">Nobody is muted.</p>
        ) : (
          <table className="w-full text-left text-sm" data-testid="admin-chat-mutes">
            <thead>
              <tr>{["Member", "Until", "Reason (private)", "By", "Actions"].map((h) => <th key={h} className="label px-2 py-1.5">{h}</th>)}</tr>
            </thead>
            <tbody>
              {mutes.data.mutes.map((x) => (
                <tr key={x.id} className="border-t border-white/5">
                  <td className="px-2 py-1.5 text-paper">{x.name} <span className="text-xs text-steel-400">id {x.memberId}</span></td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{x.permanent ? "permanent" : fmtDate(x.until)}</td>
                  <td className="max-w-[20rem] px-2 py-1.5 break-words text-steel-300">{x.reason ?? "–"}</td>
                  <td className="px-2 py-1.5 text-steel-300">{x.by}</td>
                  <td className="px-2 py-1.5"><button type="button" className={btn} onClick={() => void unmute(x.memberId)}>Unmute</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Recent moderation actions">
        {log.error ? <p className="text-danger">{log.error}</p> : !log.data ? <p className="text-steel-300">Loading…</p> : <Table rows={log.data.log} columns={["at", "actor", "action", "target", "detail"]} />}
      </Card>
    </>
  );
}
