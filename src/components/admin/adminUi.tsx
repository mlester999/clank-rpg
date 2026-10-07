"use client";

import type { ReactNode } from "react";

import { api, friendly } from "@/lib/api";
import { useRemote } from "@/lib/useRemote";

export type Row = Record<string, unknown>;

/** A timestamp as the admin's local time. Accepts ISO strings AND epoch milliseconds (several admin payloads carry numbers). */
export const fmtDate = (v: unknown) => {
  if (!v) return "–";
  const d = new Date(typeof v === "number" ? v : String(v));
  return Number.isNaN(d.getTime()) ? "–" : d.toLocaleString();
};

export function useAdminData<T>(path: string) {
  const { data, error, reload } = useRemote<T>(() => api<T>(path), path);
  return { data, error: error ? friendly(error.error) : null, reload: async () => reload() };
}

export async function act(path: string, method: string, json?: unknown, reload?: () => void | Promise<void>, setMsg?: (m: string) => void) {
  const r = await api(path, { method, ...(json !== undefined ? { json } : {}) });
  setMsg?.(r.ok ? "Done." : `Failed: ${r.error}`);
  if (r.ok) await reload?.();
  return r;
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="plate mb-4 p-4">
      <div className="flex items-center justify-between gap-3">{title ? <h2 className="label">{title}</h2> : <span />}{actions}</div>
      <div className="mt-3 overflow-x-auto">{children}</div>
    </section>
  );
}

export function Table({ rows, columns }: { rows: Row[]; columns: string[] }) {
  if (rows.length === 0) return <p className="text-sm text-steel-400">Nothing here.</p>;
  return (
    <table className="w-full text-left text-sm">
      <thead><tr>{columns.map((c) => <th key={c} className="label whitespace-nowrap px-2 py-1.5">{c.replaceAll("_", " ")}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-white/5">
            {columns.map((c) => {
              const v = r[c];
              return <td key={c} className="max-w-[18rem] truncate px-2 py-1.5 text-paper" title={typeof v === "object" ? JSON.stringify(v) : String(v ?? "")}>{typeof v === "boolean" ? (v ? "yes" : "no") : /_at$|^created|^updated/.test(c) ? fmtDate(v) : typeof v === "object" && v !== null ? JSON.stringify(v).slice(0, 80) : String(v ?? "–")}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Note({ msg }: { msg: string }) {
  return msg ? <p role="status" className="mb-3 text-sm text-clank-300">{msg}</p> : null;
}

